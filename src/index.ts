/**
 * FileCodeBox - Cloudflare Worker 重写版：Web 路由（页面 / 上传 / 下载 / 管理）与 Cron 清理。
 * 兼容 API 见 src/api.ts（挂载在 /api）。
 */
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

import type { Env } from './types';
import { getConfig } from './config';
import { initDB, SCHEMA_VERSION, getSchemaVersion, getFileByCode, getFileById, listFiles, takeExpiredFiles, cleanupRateLimits } from './db';
import { adminAuth, adminPasswordConfigured, handleAdminLogin, handleAdminLogout } from './auth';
import {
  buildDownloadResponse,
  cleanupOrphanObjects,
  deleteStoredFile,
  lookupFile,
  lookupText,
} from './files';
import { chunkAbort, chunkComplete, chunkInit, chunkPut, chunkStatus, cleanupOrphanCodes, cleanupStaleChunks, uploadFile, uploadText } from './upload';
import api from './api';
import {
  CHUNK_SIZE,
  HttpError,
  PLAIN_UPLOAD_LIMIT,
  RATE_WINDOW_MS,
  fileKey,
  getBaseUrl,
  isValidCode,
  messageOf,
  statusOf,
} from './utils';
import { removeObjects } from './storage';
import { generateQRCodeGIF } from './qr';
import { STYLE } from './templates/style';
import { adminLoginPage, adminPanel, errorPage, filePage, homePage, retrievePage } from './templates/pages';

type Ctx = Context<{ Bindings: Env }>;

const app = new Hono<{ Bindings: Env }>();

// ===================== 中间件 =====================

app.use('*', cors({ origin: 'self', allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'] }));
app.use('*', async (c, next) => {
  await next();
  c.res.headers.set('Referrer-Policy', 'no-referrer');
  // CSP：限制资源来源，降低 XSS 影响面
  c.res.headers.set(
    'Content-Security-Policy',
    "default-src 'self'; " +
      // Cloudflare Web Analytics 由边缘自动注入，不放开会被 CSP 拦掉并产生控制台报错
      "script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com; " +
      "connect-src 'self' https://cloudflareinsights.com; " +
      "style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' https://t.alcy.cc https://q1.qlogo.cn https: data:; " +
      "object-src 'none'; " +
      "frame-ancestors 'none';",
  );
});

// ===================== 惰性建表 =====================
// 由库内 schema_version 驱动：缺表或版本落后时补建（新版本新增表/列不会漏）。
// 不能用"探某张老表是否存在"判断——老表存在、新表缺失时会被误判为就绪。
let readyVersion: number | null = null;
async function ensureSchema(db: D1Database): Promise<void> {
  if (readyVersion === SCHEMA_VERSION) return;
  if ((await getSchemaVersion(db)) !== SCHEMA_VERSION) await initDB(db);
  readyVersion = SCHEMA_VERSION;
}

app.use('*', async (c, next) => {
  await ensureSchema(c.env.DB).catch(() => {});
  await next();
});

// ===================== 路由包装：统一异常 → 状态码 =====================

// 只有业务错误（HttpError）可对外暴露；未知异常统一掩码并记录，避免泄露内部实现
const publicError = (e: unknown, fallback: string): string => {
  if (e instanceof HttpError) return e.message;
  console.error(JSON.stringify({ event: 'request_error', error: String(e) }));
  return fallback;
};

const jsonRoute = (fn: (c: Ctx) => Promise<Response>) => async (c: Ctx) => {
  try {
    return await fn(c);
  } catch (e) {
    return c.json({ error: publicError(e, '服务器内部错误') }, statusOf(e) as ContentfulStatusCode);
  }
};

const htmlRoute = (fn: (c: Ctx) => Promise<Response>) => async (c: Ctx) => {
  try {
    return await fn(c);
  } catch (e) {
    return c.html(errorPage(publicError(e, '操作失败'), ''), statusOf(e) as ContentfulStatusCode);
  }
};

const baseUrl = (c: Ctx) => getBaseUrl(new URL(c.req.url).origin, c.req.header('host'));
const param = (c: Ctx, name: string) => (c.req.param(name) ?? '').trim();

// ===================== 静态资源 =====================

// 独立样式表 + immutable 长缓存（避免每次页面内联 ~10KB CSS）
app.get('/static/style.css', () =>
  new Response(STYLE, {
    headers: { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'public, max-age=31536000, immutable' },
  }),
);

// 背景图本地提供：固定 URL + 长缓存（替代外部随机图源的跳转与超大图）
app.get('/static/bg.webp', async (c) => {
  const obj = await c.env.FILE_STORE.get('bg.webp');
  if (!obj) return new Response('Not Found', { status: 404 });
  return new Response(obj.body, {
    headers: { 'Content-Type': 'image/webp', 'Cache-Control': 'public, max-age=31536000, immutable' },
  });
});

// ===================== 页面 =====================

// 首页/取件页均为动态渲染，no-store 避免错误响应被 CDN 缓存
const noStore = (c: Ctx) => c.header('Cache-Control', 'no-store');

app.get('/', async (c) => {
  noStore(c);
  const config = await getConfig(c.env);
  return c.html(homePage({ chunkThreshold: Math.min(config.maxSize, PLAIN_UPLOAD_LIMIT) }));
});

app.get('/r', (c) => {
  const code = (c.req.query('code') ?? '').trim();
  if (code) return c.redirect(`/r/${code}`);
  noStore(c);
  return c.html(retrievePage());
});

app.get('/r/:code', async (c) => {
  noStore(c);
  const code = param(c, 'code');
  const file = await getFileByCode(c.env.DB, code);
  if (!file) return c.html(retrievePage(code));
  return c.html(filePage(file, baseUrl(c)));
});

// ===================== 上传 =====================

app.post('/api/upload', jsonRoute(async (c) => c.json(await uploadFile(c, c.env))));

// 文本上传：成功后 303 到取件页（PRG，避免刷新重复提交）
app.post(
  '/api/upload/text',
  htmlRoute(async (c) => {
    const result = await uploadText(c, c.env);
    return c.redirect(`/r/${result.code}`, 303);
  }),
);

// ---- 分片上传 ----
app.post('/api/upload/chunk/init', jsonRoute(async (c) => c.json(await chunkInit(c, c.env))));
app.put('/api/upload/chunk/:upload_id/:index', jsonRoute(async (c) => c.json(await chunkPut(c, c.env))));
app.get('/api/upload/chunk/status/:upload_id', jsonRoute(async (c) => c.json(await chunkStatus(c, c.env))));
app.post('/api/upload/chunk/complete/:upload_id', jsonRoute(async (c) => c.json(await chunkComplete(c, c.env))));
app.post('/api/upload/chunk/abort/:upload_id', jsonRoute(async (c) => c.json(await chunkAbort(c, c.env))));

// ===================== 读取 =====================

app.get(
  '/api/text/:code',
  jsonRoute(async (c) => {
    const lookup = await lookupText(c.env, param(c, 'code'), {
      count: true,
      isHead: c.req.method === 'HEAD',
    });
    if (lookup.status === 'notFound') return c.text('Not found', 404);
    if (lookup.status === 'maxExceeded') return c.text('Max downloads exceeded', 403);
    return c.text(lookup.text);
  }),
);

app.get(
  '/api/download/:code',
  async (c) => {
    try {
      const lookup = await lookupFile(c.env, param(c, 'code'), { count: true, isHead: c.req.method === 'HEAD' });
      if (lookup.status === 'notFound') return c.html(errorPage('文件不存在', '该文件可能已被清理'), 404);
      if (lookup.status === 'maxExceeded') return c.html(errorPage('已达最大下载次数', '该文件的下载次数已用完'), 403);
      return buildDownloadResponse(lookup.file, lookup.obj, c.req.method === 'HEAD');
    } catch (e) {
      return c.html(errorPage(messageOf(e, '未找到文件'), ''), statusOf(e, 404) as ContentfulStatusCode);
    }
  },
);

app.get(
  '/api/info/:code',
  jsonRoute(async (c) => {
    const file = await getFileByCode(c.env.DB, param(c, 'code'));
    if (!file) return c.json({ error: 'not found' }, 404);
    return c.json({
      filename: file.filename,
      size: file.size,
      download_count: file.download_count,
      max_downloads: file.max_downloads,
      expire_at: file.expire_at,
    });
  }),
);

app.get('/qrcode/:code', async (c) => {
  const code = param(c, 'code');
  if (!isValidCode(code)) return c.text('Invalid code', 400);
  if (!(await getFileByCode(c.env.DB, code))) return c.text('File not found', 404);

  const gif = generateQRCodeGIF(`${baseUrl(c)}/r/${code}`, 200);
  return new Response(gif as unknown as BodyInit, {
    headers: { 'Content-Type': 'image/gif', 'Cache-Control': 'public, max-age=31536000, immutable' },
  });
});

// ===================== 管理后台 =====================

const FILTER_DEFAULTS = { keyword: '', dateFrom: '', dateTo: '', sort: 'newest' };

const readFilters = (c: Ctx) => ({
  keyword: (c.req.query('keyword') ?? '').trim(),
  dateFrom: c.req.query('date_from') ?? '',
  dateTo: c.req.query('date_to') ?? '',
  sort: c.req.query('sort') ?? FILTER_DEFAULTS.sort,
});

app.get('/admin', async (c) => {
  noStore(c);
  if (!(await adminAuth(c, c.env))) return c.html(adminLoginPage());

  const page = Math.max(1, Number(c.req.query('page')) || 1);
  const filters = readFilters(c);
  const { files, total } = await listFiles(c.env.DB, page, 50, filters);
  return c.html(adminPanel(files, total, page, filters));
});

// Web 表单登录（HTML）；JSON 登录见 /api/admin/login
app.post('/admin/login', async (c) => {
  const body = await c.req.parseBody();
  const result = await handleAdminLogin(c, c.env, typeof body['password'] === 'string' ? body['password'] : '');
  return result.success
    ? c.redirect('/admin')
    : c.html(adminLoginPage(result.error), result.status as ContentfulStatusCode);
});

// 登出：页面链接用 GET，API 客户端可用 POST；同时清 DB token
app.on(['GET', 'POST'], '/admin/logout', async (c) => {
  await handleAdminLogout(c, c.env);
  return c.redirect('/');
});

app.post('/admin/delete/:id', async (c) => {
  if (!(await adminAuth(c, c.env))) return c.redirect('/admin');

  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) return c.redirect('/admin');
  const file = await getFileById(c.env.DB, id);
  if (file) await deleteStoredFile(c.env, file);
  return c.redirect('/admin');
});

app.post('/admin/cleanup', async (c) => {
  if (!(await adminAuth(c, c.env))) return c.redirect('/admin');

  const expired = await takeExpiredFiles(c.env.DB);
  await removeObjects(c.env.FILE_STORE, expired.map((f) => fileKey(f.code)));
  return c.redirect('/admin');
});

app.get(
  '/api/init',
  jsonRoute(async (c) => {
    if (!(await adminAuth(c, c.env))) return c.json({ error: 'unauthorized' }, 401);
    await initDB(c.env.DB);
    return c.json({ ok: true });
  }),
);

// ===================== 运行状态（公开，仅暴露非敏感配置与自检结果） =====================

app.get(
  '/api/status',
  jsonRoute(async (c) => {
    const config = await getConfig(c.env);
    return c.json({
      ok: true,
      // 部署后 Secret 被清空时会变 false，便于立即发现
      adminPasswordConfigured: await adminPasswordConfigured(c.env),
      maxFileSize: config.maxSize,
      defaultExpireDays: config.defaultExpireDays,
      openUpload: config.openUpload,
      chunkSize: CHUNK_SIZE,
    });
  }),
);

// ===================== 兼容 API =====================

// 挂载在 /api，路径与 FileCodeBox v2.1.0 文档一致（如 /api/share/file）
app.route('/api', api);
// 未知 API 路径返回 404 JSON，不落入首页兜底
app.all('/api/*', (c) => c.json({ code: 404, msg: 'Not Found' }, 404));

// ===================== 兜底 =====================

app.all('*', async (c) => {
  const config = await getConfig(c.env);
  return c.html(homePage({ chunkThreshold: Math.min(config.maxSize, PLAIN_UPLOAD_LIMIT) }));
});

// ===================== 入口 =====================

export default {
  fetch: app.fetch,

  /** Cron：幂等建表 + 过期/孤儿/限流/分片任务回收 */
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      (async () => {
        try {
          await initDB(env.DB);
          const expired = await takeExpiredFiles(env.DB);
          await removeObjects(env.FILE_STORE, expired.map((f) => fileKey(f.code)));

          const orphans = await cleanupOrphanObjects(env);
          const rateLimits = await cleanupRateLimits(env.DB, RATE_WINDOW_MS);
          const staleChunks = await cleanupStaleChunks(env);
          const orphanCodes = await cleanupOrphanCodes(env);

          console.log(
            JSON.stringify({
              event: 'scheduled_cleanup',
              expiredFiles: expired.length,
              r2Scanned: orphans.scanned,
              r2Removed: orphans.removed,
              rateLimits,
              staleChunks,
              orphanCodes,
            }),
          );
        } catch (e) {
          console.error(JSON.stringify({ event: 'scheduled_cleanup_error', error: String(e) }));
        }
      })(),
    );
  },
};
