/**
 * FileCodeBox 兼容 API（v2.1.0）
 * 标准响应格式: { code, msg, detail }
 * 文档: https://fcb-docs.aiuo.net/api/
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Env } from './types';
import { generateCode, formatFileSize, isValidCode } from './utils';
import {
  getFileByCode,
  insertFile,
  isCodeTaken,
  incrementDownload,
  deleteFileRecord,
  listFilesWithSearch,
  getDashboardStats,
  getSetting,
  setSetting,
} from './db';
import { adminAuth, handleAdminLogin } from './auth';

type Bindings = { Bindings: Env };

// ===================== 响应助手 =====================

function ok(c: Context<Bindings>, detail: unknown, msg = 'success') {
  return c.json({ code: 200, msg, detail });
}

function fail(c: Context<Bindings>, status: ContentfulStatusCode, msg: string) {
  return c.json({ code: status, msg }, status);
}

// ===================== 上传门控 =====================

/**
 * 游客上传开关（openUpload）。
 * 默认 '1'（免登录游客可上传）；设为 '0' 时需 Bearer token 才能上传。
 */
async function uploadGate(c: Context<Bindings>, next: () => Promise<void>) {
  const openUpload = (await getSetting(c.env.DB, 'open_upload')) ?? '1';
  if (openUpload !== '0') return next();
  if (await adminAuth(c, c.env)) return next();
  return c.json({ code: 401, msg: '游客上传已关闭，请先登录' }, 401);
}

// ===================== 过期策略 =====================

function parseExpire(
  expireValue: number,
  expireStyle: string,
  defaultDays: number,
): { expireAt: string; maxDownloads: number } {
  const now = Date.now();
  switch (expireStyle) {
    case 'hour':
      return { expireAt: new Date(now + expireValue * 3_600_000).toISOString(), maxDownloads: -1 };
    case 'minute':
      return { expireAt: new Date(now + expireValue * 60_000).toISOString(), maxDownloads: -1 };
    case 'count':
      return { expireAt: new Date(now + defaultDays * 86_400_000).toISOString(), maxDownloads: expireValue };
    case 'forever':
      return { expireAt: new Date(now + 100 * 365 * 86_400_000).toISOString(), maxDownloads: -1 };
    case 'day':
    default:
      return { expireAt: new Date(now + expireValue * 86_400_000).toISOString(), maxDownloads: -1 };
  }
}

async function generateUniqueCode(env: Env): Promise<string> {
  for (let i = 0; i < 10; i++) {
    const code = generateCode();
    if (!(await isCodeTaken(env.DB, code))) return code;
  }
  throw new Error('无法生成唯一取件码');
}

// ===================== 路由 =====================

const api = new Hono<Bindings>();

// ---- 认证（公开） ----
api.post('/admin/login', async (c) => {
  const env = c.env;
  const body = await c.req.json().catch(() => null);
  const password = (body?.password as string) || '';
  if (!password) return fail(c, 422, '密码不能为空');

  const result = await handleAdminLogin(c, env, password);
  if (!result.success) return fail(c, 401, result.error);

  return ok(c, { token: result.token, token_type: 'Bearer' });
});

// ---- 分享文本 ----
const shareText = async (c: Context<Bindings>) => {
  const env = c.env;
  try {
    const body = await c.req.parseBody();
    const text = ((body['text'] as string) || '').trim();
    if (!text) return fail(c, 422, '文本内容不能为空');

    const textSize = new TextEncoder().encode(text).length;
    const expireValue = parseInt((body['expire_value'] as string) || '1');
    const expireStyle = (body['expire_style'] as string) || 'day';
    const { expireAt, maxDownloads } = parseExpire(
      expireValue,
      expireStyle,
      parseInt(env.DEFAULT_EXPIRE_DAYS || '7'),
    );

    const code = await generateUniqueCode(env);
    const title = text.replace(/\s+/g, ' ').slice(0, 50);

    await env.FILE_STORE.put(`file:${code}`, text, {
      httpMetadata: { contentType: 'text/plain' },
      customMetadata: { filename: title, size: String(textSize) },
    });
    await insertFile(env.DB, {
      code,
      filename: title,
      size: textSize,
      mimeType: 'text/plain',
      expireAt,
      maxDownloads,
      isText: 1,
    });

    return ok(c, { code });
  } catch (e: any) {
    console.error('shareText error:', e);
    return fail(c, 500, '服务器内部错误');
  }
};
api.post('/share/text/', uploadGate, shareText);
api.post('/share/text', uploadGate, shareText);

// ---- 分享文件 ----
const shareFile = async (c: Context<Bindings>) => {
  const env = c.env;
  try {
    // 元数据走 query/header，文件字节流走 raw body，全程零缓冲（R2 直传，不限 25MB）
    const customCode = (c.req.query('code') || '').trim();
    // 服务端校验自定义取件码格式
    if (customCode && !isValidCode(customCode)) {
      return fail(c, 400, '取件码必须为 4 位数字');
    }
    const code = customCode || (await generateUniqueCode(env));
    if (customCode && (await isCodeTaken(env.DB, code))) {
      return fail(c, 409, '取件码已被占用');
    }

    const expireValue = parseInt(c.req.query('expire_value') || '1');
    const expireStyle = c.req.query('expire_style') || 'day';
    const filename = decodeURIComponent(c.req.header('X-Filename') || '未命名');
    const mimeType = c.req.header('Content-Type') || 'application/octet-stream';
    const size = parseInt(c.req.header('Content-Length') || '0');

    const { expireAt, maxDownloads } = parseExpire(
      expireValue,
      expireStyle,
      parseInt(env.DEFAULT_EXPIRE_DAYS || '7'),
    );

    const maxSize = parseInt(env.MAX_FILE_SIZE || '104857600');
    if (size > maxSize) {
      return fail(c, 400, `文件过大，最大 ${Math.floor(maxSize / 1048576)}MB`);
    }

    // 原始字节流直接写入 R2，不经 parseBody 缓冲
    await env.FILE_STORE.put(`file:${code}`, c.req.raw.body, {
      httpMetadata: { contentType: mimeType },
      customMetadata: { filename, size: String(size) },
    });
    await insertFile(env.DB, {
      code,
      filename,
      size,
      mimeType,
      expireAt,
      maxDownloads,
    });

    return ok(c, { code, name: filename });
  } catch (e: any) {
    console.error('shareFile error:', e);
    return fail(c, 500, '服务器内部错误');
  }
};
api.post('/share/file/', uploadGate, shareFile);
api.post('/share/file', uploadGate, shareFile);

// ---- 获取/选择文件信息 ----
async function selectFile(c: Context<Bindings>, countAsDownload: boolean) {
  const env = c.env;
  const code = (c.req.query('code') || '').trim();
  if (!code) return fail(c, 422, '缺少取件码');

  const file = await getFileByCode(env.DB, code);
  if (!file) return fail(c, 404, '文件不存在或已过期');

  // GET 按文档语义「直接下载文件」计入次数；POST 是选择/探查，不计
  if (countAsDownload) {
    const incremented = await incrementDownload(env.DB, code);
    if (!incremented) return fail(c, 403, '已达最大下载次数');
  }

  let text = '';
  if (file.is_text === 1) {
    const obj = await env.FILE_STORE.get(`file:${code}`);
    text = obj ? await obj.text() : '';
  }

  return ok(c, {
    code: file.code,
    name: file.filename,
    size: file.size,
    text,
  });
}

api.get('/share/select/', (c) => selectFile(c, true));
api.post('/share/select/', (c) => selectFile(c, false));
api.get('/share/select', (c) => selectFile(c, true));
api.post('/share/select', (c) => selectFile(c, false));

// ---- 下载 ----
api.get('/share/download', async (c) => {
  const env = c.env;
  const code = (c.req.query('code') || c.req.query('key') || '').trim();
  if (!code) return fail(c, 422, '缺少下载码');

  const file = await getFileByCode(env.DB, code);
  if (!file) return fail(c, 404, '文件不存在或已过期');

  // HEAD 请求只是元数据探测（检查大小/存在性），不计入下载次数
  const isHead = c.req.method === 'HEAD';
  if (!isHead) {
    const incremented = await incrementDownload(env.DB, code);
    if (!incremented) return fail(c, 403, '已达最大下载次数');
  }

  const obj = await env.FILE_STORE.get(`file:${code}`);
  if (!obj) return fail(c, 404, '文件数据缺失');

  return new Response(isHead ? null : obj.body, {
    headers: {
      'Content-Type': file.mime_type || 'application/octet-stream',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
      'Content-Length': String(obj.size),
    },
  });
});

// ---- 管理（受保护） ----

const adminApi = new Hono<Bindings>();

adminApi.use('*', async (c, next) => {
  if (!(await adminAuth(c, c.env))) {
    return c.json({ code: 401, msg: '未授权' }, 401);
  }
  await next();
});

adminApi.get('/dashboard', async (c) => {
  const stats = await getDashboardStats(c.env.DB);
  return ok(c, {
    totalFiles: stats.totalFiles,
    storageUsed: formatFileSize(stats.totalSize),
    todayCount: stats.todayCount,
    todaySize: formatFileSize(stats.todaySize),
    yesterdayCount: stats.yesterdayCount,
    yesterdaySize: formatFileSize(stats.yesterdaySize),
  });
});

adminApi.get('/file/list', async (c) => {
  const env = c.env;
  const page = Math.max(1, parseInt(c.req.query('page') || '1'));
  const size = Math.min(100, Math.max(1, parseInt(c.req.query('size') || '10')));
  const keyword = c.req.query('keyword') || '';
  const { files, total } = await listFilesWithSearch(env.DB, page, size, keyword);
  return ok(c, {
    page,
    size,
    total,
    data: files.map((f) => ({
      id: f.id,
      name: f.filename,
      size: f.size,
      code: f.code,
      download_count: f.download_count,
      expire_at: f.expire_at,
      created_at: f.created_at,
    })),
  });
});

adminApi.delete('/file/delete', async (c) => {
  const env = c.env;
  const id = parseInt(c.req.query('id') || '');
  if (!id) return fail(c, 422, '缺少文件 ID');

  const file = await deleteFileRecord(env.DB, id);
  if (!file) return fail(c, 404, '文件不存在');
  await env.FILE_STORE.delete(`file:${file.code}`);
  return ok(c, { id });
});

adminApi.get('/config/get', async (c) => {
  const env = c.env;
  return ok(c, {
    openUpload: (await getSetting(env.DB, 'open_upload')) ?? '1',
    maxFileSize: (await getSetting(env.DB, 'max_file_size')) ?? env.MAX_FILE_SIZE,
    defaultExpireDays: (await getSetting(env.DB, 'default_expire_days')) ?? env.DEFAULT_EXPIRE_DAYS,
  });
});

adminApi.patch('/config/update', async (c) => {
  const env = c.env;
  const body = await c.req.json().catch(() => null);
  if (!body) return fail(c, 422, '请求体不能为空');

  if (body.openUpload !== undefined) await setSetting(env.DB, 'open_upload', String(body.openUpload));
  if (body.maxFileSize !== undefined) await setSetting(env.DB, 'max_file_size', String(body.maxFileSize));
  if (body.defaultExpireDays !== undefined) await setSetting(env.DB, 'default_expire_days', String(body.defaultExpireDays));

  return ok(c, {
    openUpload: (await getSetting(env.DB, 'open_upload')) ?? '1',
    maxFileSize: (await getSetting(env.DB, 'max_file_size')) ?? env.MAX_FILE_SIZE,
    defaultExpireDays: (await getSetting(env.DB, 'default_expire_days')) ?? env.DEFAULT_EXPIRE_DAYS,
  });
});

api.route('/admin', adminApi);

export default api;
