/**
 * FileCodeBox - Cloudflare Worker 重写版
 * 像取快递一样取文件
 */
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Context } from 'hono';

import type { Env, FileRecord } from './types';

import {
  initDB,
  getFileByCode,
  getFileById,
  deleteFileRecord,
  listFiles,
  cleanupExpired,
  incrementDownload,
} from './db';
import { adminAuth, handleAdminLogin, handleAdminLogout } from './auth';
import api from './api';
import { uploadFile, uploadText, downloadFile } from './shared';
import { STYLE } from './templates/style';
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

app.use('*', cors({ origin: 'self', allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'HEAD'] }));
app.use('*', async (c, next) => {
  await next();
  c.res.headers.set('Referrer-Policy', 'no-referrer');
  // Content-Security-Policy：限制资源加载来源，降低 XSS 影响面
  c.res.headers.set(
    'Content-Security-Policy',
    "default-src 'self'; " +
      "script-src 'self' 'unsafe-inline'; " +
      "style-src 'self' 'unsafe-inline'  " +
      "img-src 'self' https://t.alcy.cc https://q1.qlogo.cn https: data:; " +
      "font-src fonts.gstatic.com; " +
      "object-src 'none'; " +
      "frame-ancestors 'none';",
  );
});

// ===================== 助手函数 =====================

function getBaseUrl(c: Context<{ Bindings: Env }>): string {
  const host = c.req.header('host') || '';
  const proto = host.startsWith('localhost') ? 'http' : 'https';
  return `${proto}://${host}`;
}

// ===================== 缓存助手 =====================

/**
 * Cache API 缓存 GET 响应（Workers 响应默认不被 CDN 缓存，需显式 put）
 * 带查询参数（如 ?t=）的请求直接回源，不写入缓存
 */
async function cached(
  c: Context<{ Bindings: Env }>,
  makeResponse: () => Response | Promise<Response>,
  ttlSeconds: number,
): Promise<Response> {
  if (c.req.method !== 'GET' || c.req.url.includes('?')) {
    return makeResponse();
  }
  const cache = await caches.open('default');
  const cacheKey = new Request(c.req.url);
  const cachedRes = await cache.match(cacheKey);
  if (cachedRes) return cachedRes;

  const res = await makeResponse();
  res.headers.set('Cache-Control', `public, max-age=${ttlSeconds}`);
  c.executionCtx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}

// ===================== 静态资源 =====================

// 样式表独立成文件 + immutable 长缓存，避免每次页面内联 ~10KB CSS
app.get('/static/style.css', (c) =>
  cached(c, () => {
    const res = new Response(STYLE, { headers: { 'Content-Type': 'text/css; charset=utf-8' } });
    res.headers.set('Cache-Control', 'public, max-age=31536000, immutable');
    return res;
  }, 31536000),
);

// 背景图本地提供：固定 URL + 长缓存，替代外部随机图源（每次 301 跳转 + 1.2MB 8K 图）
app.get('/static/bg.webp', (c) =>
  cached(c, async () => {
    const obj = await c.env.FILE_STORE.get('bg.webp');
    if (!obj) return new Response('Not Found', { status: 404 });
    const res = new Response(obj.body, { headers: { 'Content-Type': 'image/webp' } });
    res.headers.set('Cache-Control', 'public, max-age=31536000, immutable');
    return res;
  }, 31536000),
);

// ===================== 页面路由 =====================

// 首页（纯静态，可缓存）
app.get('/', (c) => cached(c, () => c.html(homePage()), 300));

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
  try {
    const result = await uploadFile(c, c.env);
    return c.json(result);
  } catch (e: any) {
    const status = e?.status ?? 500;
    return c.json({ error: e?.message ?? '服务器内部错误' }, status);
  }
});

// ===================== 文本分享 =====================

app.post('/api/upload/text', async (c) => {
  try {
    const result = await uploadText(c, c.env);
    return c.html(resultPage(result.code, result.title, result.textSize, getBaseUrl(c)));
  } catch (e: any) {
    return c.html(errorPage(e?.message ?? '保存失败', '服务器内部错误'));
  }
});

app.get('/api/text/:code', async (c) => {
  const code = c.req.param('code').trim();
  const file = await getFileByCode(c.env.DB, code);
  if (!file || file.is_text !== 1) return c.text('Not found', 404);

  if (c.req.method !== 'HEAD') {
    await incrementDownload(c.env.DB, code);
  }
  const textObj = await c.env.FILE_STORE.get(`file:${code}`);
  return c.text(textObj ? await textObj.text() : '');
});

// ===================== 下载 =====================

app.get('/api/download/:code', async (c) => {
  try {
    const result = await downloadFile(c, c.env);
    if (result.notFound) return c.html(errorPage('文件不存在', '该文件可能已被清理'));
    if (result.maxExceeded) return c.html(errorPage('已达最大下载次数', '该文件的下载次数已用完'));

    const headers: Record<string, string> = {
      'Content-Type': result.file.mime_type || 'application/octet-stream',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(result.file.filename)}`,
      'Content-Length': String(result.obj?.size ?? 0),
    };
    return new Response(result.isHead ? null : result.obj?.body, { headers });
  } catch (e: any) {
    return c.html(errorPage(e?.message ?? '未找到文件', ''));
  }
});

// ===================== 文件信息 API =====================

app.get('/api/info/:code', async (c) => {
  const code = c.req.param('code').trim();
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
  const file = await getFileById(env.DB, id);
  if (!file) return c.redirect('/admin');
  // 先删 R2，再删 DB（finally 保证 DB 清理），避免 R2 删除失败产生孤儿文件
  try {
    await env.FILE_STORE.delete(`file:${file.code}`);
  } finally {
    await deleteFileRecord(env.DB, id);
  }
  return c.redirect('/admin');
});

app.post('/api/admin/cleanup', async (c) => {
  const env = c.env;
  if (!(await adminAuth(c, env))) return c.redirect('/admin');

  await cleanupExpired(env.DB, env.FILE_STORE);
  return c.redirect('/admin');
});

// ===================== 初始化 =====================

app.get('/api/init', async (c) => {
  try {
    await initDB(c.env.DB);
    return c.json({ ok: true });
  } catch (e: any) {
    console.error('init error:', e);
    return c.json({ error: '服务器内部错误' }, 500);
  }
});

// ===================== FileCodeBox 兼容 API =====================
app.route('/', api);

// ===================== 兜底 =====================

app.all('*', (c) => c.html(homePage()));

// ===================== 导出 =====================
// fetch: Hono 处理所有 HTTP 请求
// scheduled: Cloudflare Cron 触发器自动清理过期文件
export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(cleanupExpired(env.DB, env.FILE_STORE));
  },
};
