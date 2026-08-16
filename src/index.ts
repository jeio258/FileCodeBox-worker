/**
 * FileCodeBox - Cloudflare Worker 重写版
 * 像取快递一样取文件
 */
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Context } from 'hono';

import type { Env, FileRecord } from './types';
import { generateCode } from './utils';
import {
  initDB,
  getFileByCode,
  isCodeTaken,
  insertFile,
  incrementDownload,
  deleteFileRecord,
  listFiles,
  cleanupExpired,
  initChunkSession,
  getChunkSession,
  saveChunk,
  countUploadedChunks,
  deleteChunkSession,
} from './db';
import { adminAuth, handleAdminLogin, handleAdminLogout } from './auth';
import {
  homePage,
  retrievePage,
  resultPage,
  filePage,
  errorPage,
  adminLoginPage,
  adminPanel,
} from './templates/pages';

// ===================== 应用初始化 =====================

const app = new Hono<{ Bindings: Env }>();

app.use('*', cors());
app.use('*', async (c, next) => {
  await next();
  c.res.headers.set('Referrer-Policy', 'no-referrer');
});

// ===================== 助手函数 =====================

function getBaseUrl(c: Context<{ Bindings: Env }>): string {
  const host = c.req.header('host') || '';
  const proto = host.startsWith('localhost') ? 'http' : 'https';
  return `${proto}://${host}`;
}

function expireAt(days: number): string {
  return new Date(Date.now() + days * 86400000).toISOString();
}

// ===================== 页面路由 =====================

// 首页
// 首页（静态，可缓存）
app.get('/', (c) => {
  c.header('Cache-Control', 'public, max-age=300');
  return c.html(homePage());
});

// 取件页（静态，可缓存）
app.get('/r', (c) => {
  const code = (c.req.query('code') || '').trim();
  if (code) return c.redirect(`/r/${code}`);
  c.header('Cache-Control', 'public, max-age=300');
  return c.html(retrievePage());
});

app.get('/r/:code', async (c) => {
  c.header('Cache-Control', 'no-store');
  const code = c.req.param('code').trim();
  const file = await getFileByCode(c.env.DB, code);
  if (!file) return c.html(retrievePage(code));
  return c.html(filePage(file, getBaseUrl(c)));
});

// ===================== 文件上传 =====================

app.post('/api/upload', async (c) => {
  const env = c.env;
  try {
    const body = await c.req.parseBody();
    const file = body['file'] as File | undefined;
    if (!file) return c.html(homePage());

    const maxSize = parseInt(env.MAX_FILE_SIZE || '104857600');
    if (file.size > maxSize) {
      return c.html(errorPage('文件过大', `最大支持 ${Math.floor(maxSize / 1048576)}MB`));
    }

    const code = (body['code'] as string || '').trim() || generateCode();
    const maxDownloads = parseInt(body['max_downloads'] as string || '-1');
    const expireDays = parseInt(body['expire_days'] as string || env.DEFAULT_EXPIRE_DAYS || '7');

    if (await isCodeTaken(env.DB, code)) {
      return c.html(errorPage('取件码已被占用', '请换一个取件码重试'));
    }

    const buffer = await file.arrayBuffer();
    await env.FILE_STORE.put(`file:${code}`, buffer, {
      httpMetadata: { contentType: file.type || 'application/octet-stream' },
      customMetadata: { filename: file.name, size: String(file.size) },
    });

    await insertFile(env.DB, {
      code,
      filename: file.name || '未命名',
      size: file.size,
      mimeType: file.type || 'application/octet-stream',
      expireAt: expireAt(expireDays),
      maxDownloads,
    });

    return c.html(resultPage(code, file.name || '未命名', file.size, getBaseUrl(c)));
  } catch (e: any) {
    return c.html(errorPage('上传失败', e.message));
  }
});

// ===================== 文本分享 =====================

app.post('/api/upload/text', async (c) => {
  const env = c.env;
  try {
    const body = await c.req.parseBody();
    const text = (body['text'] as string || '').trim();
    if (!text) return c.html(errorPage('内容为空', '请输入要分享的文本内容'));

    const textSize = new TextEncoder().encode(text).length;
    const maxTextSize = 512 * 1024; // 512KB
    if (textSize > maxTextSize) {
      return c.html(errorPage('文本过长', '最大支持 512KB'));
    }

    const code = ((body['code'] as string) || '').trim() || generateCode();
    const maxDownloads = parseInt(body['max_downloads'] as string || '-1');
    const expireDays = parseInt(body['expire_days'] as string || env.DEFAULT_EXPIRE_DAYS || '7');

    if (await isCodeTaken(env.DB, code)) {
      return c.html(errorPage('取件码已被占用', '请换一个取件码重试'));
    }

    const title = text.replace(/\s+/g, ' ').slice(0, 50) + (text.length > 50 ? '…' : '');

    await env.FILE_STORE.put(`file:${code}`, text, {
      httpMetadata: { contentType: 'text/plain' },
      customMetadata: { filename: title, size: String(textSize) },
    });

    await insertFile(env.DB, {
      code,
      filename: title,
      size: textSize,
      mimeType: 'text/plain',
      expireAt: expireAt(expireDays),
      maxDownloads,
      isText: 1,
    });

    return c.html(resultPage(code, title, textSize, getBaseUrl(c)));
  } catch (e: any) {
    return c.html(errorPage('保存失败', e.message));
  }
});

app.get('/api/text/:code', async (c) => {
  const code = c.req.param('code').trim();
  const file = await getFileByCode(c.env.DB, code);
  if (!file || file.is_text !== 1) return c.text('Not found', 404);

  await incrementDownload(c.env.DB, code);
  const textObj = await c.env.FILE_STORE.get(`file:${code}`);
  const text = textObj ? await textObj.text() : '';
  return c.text(text);
});

// ===================== 分片上传 =====================

app.post('/api/chunk/init', async (c) => {
  const env = c.env;
  const body = await c.req.parseBody();
  const fileName = (body['file_name'] as string) || '未命名';
  const fileSize = parseInt(body['file_size'] as string || '0');
  const chunkSize = parseInt(body['chunk_size'] as string || '5242880');
  const mimeType = (body['mime_type'] as string) || 'application/octet-stream';

  const maxSize = parseInt(env.MAX_FILE_SIZE || '104857600');
  if (fileSize > maxSize) {
    return c.json({ error: `文件过大，最大 ${Math.floor(maxSize / 1048576)}MB` }, 400);
  }

  const uploadId = await initChunkSession(env.DB, { fileName, fileSize, chunkSize, mimeType });
  const totalChunks = Math.ceil(fileSize / chunkSize);

  return c.json({ upload_id: uploadId, total_chunks: totalChunks, chunk_size: chunkSize });
});

app.post('/api/chunk/upload/:uploadId/:index', async (c) => {
  const env = c.env;
  const uploadId = c.req.param('uploadId');
  const index = parseInt(c.req.param('index'));

  const session = await getChunkSession(env.DB, uploadId);
  if (!session) return c.json({ error: 'Upload session not found' }, 404);

  const body = await c.req.parseBody();
  const chunk = body['chunk'] as File | undefined;
  if (!chunk) return c.json({ error: 'No chunk' }, 400);

  const buffer = await chunk.arrayBuffer();
  await env.FILE_STORE.put(`chunk:${uploadId}:${index}`, buffer);
  await saveChunk(env.DB, session, index);

  return c.json({ ok: true, index });
});

app.post('/api/chunk/complete/:uploadId', async (c) => {
  const env = c.env;
  const uploadId = c.req.param('uploadId');

  const session = await getChunkSession(env.DB, uploadId);
  if (!session) return c.json({ error: 'Upload session not found' }, 404);

  const uploadedCount = await countUploadedChunks(env.DB, uploadId);
  if (uploadedCount < session.total_chunks) {
    return c.json({ error: `Missing chunks: ${uploadedCount}/${session.total_chunks}` }, 400);
  }

  try {
    const body = await c.req.parseBody();
    const code = ((body['code'] as string) || '').trim() || generateCode();
    const maxDownloads = parseInt(body['max_downloads'] as string || '-1');
    const expireDays = parseInt(body['expire_days'] as string || env.DEFAULT_EXPIRE_DAYS || '7');

    if (await isCodeTaken(env.DB, code)) {
      return c.json({ error: '取件码已被占用' }, 409);
    }

    // 将分片从临时存储移动到正式存储
    for (let i = 0; i < session.total_chunks; i++) {
      const chunkObj = await env.FILE_STORE.get(`chunk:${uploadId}:${i}`);
      const chunkData = chunkObj ? await chunkObj.arrayBuffer() : null;
      if (!chunkData) return c.json({ error: `Chunk ${i} data missing` }, 500);
      await env.FILE_STORE.put(`file:${code}:${i}`, chunkData);
    }

    await insertFile(env.DB, {
      code,
      filename: session.file_name,
      size: session.file_size,
      mimeType: session.mime_type,
      expireAt: expireAt(expireDays),
      maxDownloads,
      chunkCount: session.total_chunks,
    });

    // 清理临时分片
    for (let i = 0; i < session.total_chunks; i++) {
      await env.FILE_STORE.delete(`chunk:${uploadId}:${i}`);
    }
    await deleteChunkSession(env.DB, uploadId);

    return c.json({ code, name: session.file_name, size: session.file_size });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// ===================== 下载 =====================

app.get('/api/download/:code', async (c) => {
  const env = c.env;
  const code = c.req.param('code').trim();

  const file = await getFileByCode(env.DB, code);
  if (!file) return c.html(retrievePage(code));

  // 原子检查 + 递增下载次数
  const ok = await incrementDownload(env.DB, code);
  if (!ok) {
    return c.html(errorPage('已达最大下载次数', '该文件的下载次数已用完'));
  }

  const headers: Record<string, string> = {
    'Content-Type': file.mime_type || 'application/octet-stream',
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
    'Content-Length': String(file.size),
  };

  // 分片文件 — 拼接后返回
  if (file.chunk_count > 0) {
    const parts: ArrayBuffer[] = [];
    for (let i = 0; i < file.chunk_count; i++) {
      const chunkObj = await env.FILE_STORE.get(`file:${code}:${i}`);
      const chunkData = chunkObj ? await chunkObj.arrayBuffer() : null;
      if (!chunkData) {
        return c.html(errorPage('文件数据不完整', '请联系管理员'));
      }
      parts.push(chunkData);
    }
    const totalLen = parts.reduce((s, p) => s + p.byteLength, 0);
    const assembled = new Uint8Array(totalLen);
    let off = 0;
    for (const p of parts) {
      assembled.set(new Uint8Array(p), off);
      off += p.byteLength;
    }
    return new Response(assembled.buffer, { headers });
  }

  // 单文件 — 直接返回
  const fileObj = await env.FILE_STORE.get(`file:${code}`);
  const fileData = fileObj ? await fileObj.arrayBuffer() : null;
  if (!fileData) {
    return c.html(errorPage('文件不存在', '该文件可能已被清理'));
  }

  return new Response(fileData, { headers });
});

// ===================== 文件信息 API =====================

app.get('/api/info/:code', async (c) => {
  const code = c.req.param('code').trim();
  const file = await c.env.DB.prepare('SELECT * FROM fc_files WHERE code = ?').bind(code).first<FileRecord>();
  if (!file) return c.json({ error: 'not found' }, 404);
  return c.json({
    filename: file.filename,
    size: file.size,
    download_count: file.download_count,
    max_downloads: file.max_downloads,
    expire_at: file.expire_at,
  });
});

// ===================== 管理后台 =====================

// 管理首页（受保护，使用 /admin 路径）
app.get('/admin', async (c) => {
  c.header('Cache-Control', 'no-store');
  const env = c.env;
  if (!(await adminAuth(c, env))) return c.html(adminLoginPage());

  const page = parseInt(c.req.query('page') || '1');
  const { files, total } = await listFiles(env.DB, page);
  return c.html(adminPanel(files, total, page));
});

// 兼容旧路径 /console
app.get('/console', (c) => c.redirect('/admin'));

app.post('/api/admin/login', async (c) => {
  const env = c.env;
  const body = await c.req.parseBody();
  const password = body['password'] as string;

  const result = await handleAdminLogin(c, env, password);
  if (!result.success) {
    return c.html(adminLoginPage(result.error));
  }
  return c.redirect('/admin');
});

app.get('/api/admin/logout', (c) => {
  handleAdminLogout(c);
  return c.redirect('/');
});

// 兼容旧路径
app.get('/api/console/logout', (c) => c.redirect('/api/admin/logout'));

app.post('/api/admin/delete/:id', async (c) => {
  const env = c.env;
  if (!(await adminAuth(c, env))) return c.redirect('/admin');

  const id = parseInt(c.req.param('id'));
  const file = await deleteFileRecord(env.DB, id);
  if (file) {
    if (file.chunk_count > 0) {
      for (let i = 0; i < file.chunk_count; i++) {
        await env.FILE_STORE.delete(`file:${file.code}:${i}`);
      }
    } else {
      await env.FILE_STORE.delete(`file:${file.code}`);
    }
  }
  return c.redirect('/admin');
});

app.post('/api/admin/cleanup', async (c) => {
  const env = c.env;
  if (!(await adminAuth(c, env))) return c.redirect('/admin');

  await cleanupExpired(env.DB, env.FILE_STORE);
  return c.redirect('/admin');
});

// ===================== Cron 定时清理 =====================

app.get('/api/cron/cleanup', async (c) => {
  const cleaned = await cleanupExpired(c.env.DB, c.env.FILE_STORE);
  return c.json({ cleaned });
});

// ===================== 初始化 =====================

app.get('/api/init', async (c) => {
  try {
    await initDB(c.env.DB);
    return c.json({ ok: true });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// ===================== 兜底 =====================

app.all('*', (c) => c.html(homePage()));

export default app;
