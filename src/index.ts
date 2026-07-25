/**
 * FileCodeBox — Cloudflare Worker
 * 像取快递一样取文件
 */
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';

import type { Env, FileRecord, FileMeta } from './types';
import { generateCode, hashPassword, formatFileSize, KV_MAX_SIZE } from './utils';
import { initDB, getFileByCode, getFileById, isCodeTaken, insertFile, incrementDownload, deleteFileRecord, listFiles, cleanupExpired, getSetting, setSetting } from './db';
import { adminAuth, handleAdminLogin, handleAdminLogout, checkLoginRateLimit } from './auth';
import { homePage, retrievePage, resultPage, filePage, adminLoginPage, adminPanel } from './templates/pages';
import { layout } from './templates/layout';

const app = new Hono<{ Bindings: Env }>();

// ---- 全局中间件 ----
app.use('*', cors());
app.use('*', async (c, next) => {
  await next();
  c.res.headers.set('Referrer-Policy', 'no-referrer');
});

// 懒初始化数据库（每个请求都确保，因 DDL 使用 IF NOT EXISTS 所以开销极小）
app.use('*', async (c, next) => {
  await initDB(c.env.DB);
  await next();
});

// ---- 首页 ----
app.get('/', (c) => c.html(homePage()));

// ---- 取件入口 ----
app.get('/r', (c) => {
  const code = (c.req.query('code') ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (code) return c.redirect(`/r/${code}`);
  return c.html(retrievePage());
});

// ---- API: 上传 ----
app.post('/api/upload', async (c) => {
  const env = c.env;
  try {
    const body = await c.req.parseBody();
    const file = body['file'] as File | undefined;

    if (!file) {
      return c.html(homePage());
    }

    // 双重文件大小校验：环境变量上限 + KV 单值上限
    const envMax = parseInt(env.MAX_FILE_SIZE || '104857600', 10);
    const effectiveMax = Math.min(envMax, KV_MAX_SIZE);
    if (file.size > effectiveMax) {
      const maxMB = Math.floor(effectiveMax / 1048576);
      return c.html(layout('错误', `<div class="header"><h1>文件过大</h1></div><p style="text-align:center;color:var(--text2)">最大支持 ${maxMB} MB</p><a href="/" class="btn btn-secondary" style="margin-top:16px">返回</a>`));
    }

    // 取件码：用户自定义或自动生成
    let code = (body['code'] as string || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!code || code.length !== 4) {
      code = generateCode();
    }

    // 检查取件码是否已被占用
    if (await isCodeTaken(env.DB, code)) {
      return c.html(layout('错误', `<div class="header"><h1>取件码已被占用</h1></div><a href="/" class="btn btn-secondary" style="margin-top:16px">返回</a>`));
    }

    const maxDownloads = parseInt(body['max_downloads'] as string || '-1', 10);
    const expireDays = parseInt(body['expire_days'] as string || env.DEFAULT_EXPIRE_DAYS || '7', 10);
    const expireAt = new Date(Date.now() + expireDays * 86400000).toISOString();

    // 先写 KV
    const buffer = await file.arrayBuffer();
    const kvKey = `file:${code}`;
    await env.FILE_STORE.put(kvKey, buffer, {
      metadata: { filename: file.name, mimeType: file.type, size: file.size } satisfies FileMeta,
    });

    // 再写 D1（若失败，尽力清理 KV）
    try {
      await insertFile(env.DB, {
        code,
        filename: file.name || '未命名',
        size: file.size,
        mimeType: file.type || 'application/octet-stream',
        expireAt,
        maxDownloads,
      });
    } catch (dbErr) {
      await env.FILE_STORE.delete(kvKey);
      throw dbErr;
    }

    const baseUrl = new URL(c.req.url).origin;
    return c.html(resultPage(code, file.name || '未命名', file.size, baseUrl));
  } catch (e: any) {
    return c.html(layout('错误', `<div class="header"><h1>上传失败</h1></div><p style="text-align:center;color:var(--text2)">${e.message}</p><a href="/" class="btn btn-secondary" style="margin-top:16px">返回</a>`));
  }
});

// ---- API: 下载 ----
app.get('/api/download/:code', async (c) => {
  const env = c.env;
  const code = c.req.param('code').toUpperCase();

  const file = await getFileByCode(env.DB, code);
  if (!file) {
    return c.html(retrievePage(code));
  }

  // 检查下载次数限制（非原子先行检查，减少无谓更新）
  if (file.max_downloads >= 0 && file.download_count >= file.max_downloads) {
    return c.html(layout('错误', '<div class="header"><h1>已达最大下载次数</h1></div><a href="/" class="btn btn-secondary" style="margin-top:16px">返回</a>'));
  }

  // 原子递增下载计数
  const incremented = await incrementDownload(env.DB, code);
  if (!incremented) {
    // 并发情况下已被其他请求占满
    return c.html(layout('错误', '<div class="header"><h1>已达最大下载次数</h1></div><a href="/" class="btn btn-secondary" style="margin-top:16px">返回</a>'));
  }

  const fileData = await env.FILE_STORE.get(`file:${code}`, 'arrayBuffer');
  if (!fileData) {
    return c.html(layout('错误', '<div class="header"><h1>文件不存在</h1></div><a href="/" class="btn btn-secondary" style="margin-top:16px">返回</a>'));
  }

  return new Response(fileData, {
    headers: {
      'Content-Type': file.mime_type || 'application/octet-stream',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
      'Content-Length': String(file.size),
    },
  });
});

// ---- API: 文件信息 ----
app.get('/api/info/:code', async (c) => {
  const code = c.req.param('code').toUpperCase();
  const file = await getFileByCode(c.env.DB, code);
  if (!file) return c.json({ error: 'not found' }, 404);
  return c.json({
    filename: file.filename,
    size: file.size,
    download_count: file.download_count,
    max_downloads: file.max_downloads,
    expire_at: file.expire_at,
  });
});

// ---- 取件详情页 ----
app.get('/r/:code', async (c) => {
  const code = c.req.param('code').toUpperCase();
  const file = await getFileByCode(c.env.DB, code);
  if (!file) return c.html(retrievePage(code));

  const baseUrl = new URL(c.req.url).origin;
  return c.html(filePage(file, baseUrl));
});

// ---- Admin 页面 ----
app.get('/admin', async (c) => {
  const env = c.env;
  if (!(await adminAuth(c, env))) return c.html(adminLoginPage());

  const page = Math.max(1, parseInt(c.req.query('page') || '1', 10));
  const { files, total } = await listFiles(env.DB, page);
  return c.html(adminPanel(files, total, page));
});

// ---- Admin 登录 ----
app.post('/api/admin/login', async (c) => {
  const env = c.env;
  const body = await c.req.parseBody();
  const password = (body['password'] as string) || '';

  // 速率限制
  const ip = c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For') || 'unknown';
  if (!(await checkLoginRateLimit(env.FILE_STORE, ip))) {
    return c.html(adminLoginPage('尝试次数过多，请 1 分钟后再试'));
  }

  const result = await handleAdminLogin(c, env, password);
  if (!result.success) {
    return c.html(adminLoginPage(result.error));
  }

  return c.redirect('/admin');
});

// ---- Admin 登出（改为 POST） ----
app.post('/api/admin/logout', async (c) => {
  handleAdminLogout(c);
  return c.redirect('/');
});

// 保留 GET 兼容（老链接），也调 POST 逻辑
app.get('/api/admin/logout', async (c) => {
  handleAdminLogout(c);
  return c.redirect('/');
});

// ---- Admin 删除文件（改为 POST） ----
app.post('/api/admin/delete/:id', async (c) => {
  const env = c.env;
  if (!(await adminAuth(c, env))) return c.redirect('/admin');

  const id = parseInt(c.req.param('id'), 10);
  if (isNaN(id)) return c.redirect('/admin');

  const file = await deleteFileRecord(env.DB, id);
  if (file) {
    await env.FILE_STORE.delete(`file:${file.code}`);
  }
  return c.redirect('/admin');
});

// ---- Admin 清理过期文件（改为 POST） ----
app.post('/api/admin/cleanup', async (c) => {
  const env = c.env;
  if (!(await adminAuth(c, env))) return c.redirect('/admin');

  const count = await cleanupExpired(env.DB, env.FILE_STORE);
  return c.redirect('/admin');
});

// ---- Cron: 自动清理过期文件 ----
app.get('/api/cron/cleanup', async (c) => {
  const count = await cleanupExpired(c.env.DB, c.env.FILE_STORE);
  return c.json({ cleaned: count });
});

export default app;
