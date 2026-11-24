/**
 * Web 路由：页面渲染、浏览器端上传/下载、管理面板与自检接口。
 * 业务逻辑全部来自领域模块，本文件只做参数解析与响应组装。
 */

import type { Hono } from 'hono';
import type { Env, FileFilters } from '../types';
import { getConfig } from '../config';
import { getFileByCode, getFileById, initDB, listFiles, takeExpiredFiles } from '../db';
import { isAdminAuthed, isAdminPasswordConfigured, login, logout } from '../auth';
import { buildDownloadResponse, deleteStoredFile, resolveShare } from '../files';
import { chunkAbort, chunkComplete, chunkInit, chunkPut, chunkStatus, uploadFile, uploadText } from '../upload';
import { removeObjects } from '../storage';
import { CHUNK_SIZE, PLAIN_UPLOAD_LIMIT, fileKey, getBaseUrl, isValidCode } from '../utils';
import { generateQRCodeGIF } from '../qr';
import { STYLE } from '../templates/style';
import {
  adminLoginPage,
  adminPanel,
  errorPage,
  filePage,
  homePage,
  retrievePage,
} from '../templates/pages';
import { html, json, codeOf, isHead, pathParam, type Ctx } from '../respond';

const IMMUTABLE = 'public, max-age=31536000, immutable';
const FILTER_DEFAULTS: FileFilters = { keyword: '', dateFrom: '', dateTo: '', sort: 'newest' };
const PAGE_SIZE = 50;

const baseUrl = (c: Ctx) => getBaseUrl(new URL(c.req.url).origin, c.req.header('host'));
const noStore = (c: Ctx) => c.header('Cache-Control', 'no-store');

/** 首页与兜底共用（分片阈值取配置上限与平台单请求上限的较小值） */
async function home(c: Ctx): Promise<Response> {
  const config = await getConfig(c.env);
  return c.html(homePage({ chunkThreshold: Math.min(config.maxSize, PLAIN_UPLOAD_LIMIT) }));
}

function readFilters(c: Ctx): FileFilters {
  return {
    keyword: (c.req.query('keyword') ?? '').trim(),
    dateFrom: c.req.query('date_from') ?? '',
    dateTo: c.req.query('date_to') ?? '',
    sort: c.req.query('sort') ?? FILTER_DEFAULTS.sort,
  };
}

export function registerWebRoutes(app: Hono<{ Bindings: Env }>): void {
  // ===================== 静态资源 =====================

  app.get('/static/style.css', () =>
    new Response(STYLE, {
      headers: { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': IMMUTABLE },
    }),
  );

  // 背景图本地提供：固定 URL + 长缓存（替代外部随机图源的跳转与超大图）
  app.get('/static/bg.webp', async (c) => {
    const obj = await c.env.FILE_STORE.get('bg.webp');
    if (!obj) return new Response('Not Found', { status: 404 });
    return new Response(obj.body, {
      headers: { 'Content-Type': 'image/webp', 'Cache-Control': IMMUTABLE },
    });
  });

  // ===================== 页面 =====================

  app.get('/', async (c) => {
    noStore(c);
    return home(c);
  });

  app.get('/r', (c) => {
    const code = (c.req.query('code') ?? '').trim();
    if (code) return c.redirect(`/r/${code}`);
    noStore(c);
    return c.html(retrievePage());
  });

  app.get('/r/:code', async (c) => {
    noStore(c);
    const code = pathParam(c, 'code');
    const file = await getFileByCode(c.env.DB, code);
    return c.html(file ? filePage(file, baseUrl(c)) : retrievePage(code));
  });

  // ===================== 上传 =====================

  app.post(
    '/api/upload',
    json(async (c) => c.json(await uploadFile(c, c.env))),
  );

  // 文本上传：成功后 303 到取件页（PRG，避免刷新重复提交）
  app.post(
    '/api/upload/text',
    html(async (c) => {
      const result = await uploadText(c, c.env);
      return c.redirect(`/r/${result.code}`, 303);
    }),
  );

  // 分片接口对外字段保持 snake_case（线上已使用的契约），内部模型为 camelCase
  app.post(
    '/api/upload/chunk/init',
    json(async (c) => {
      const r = await chunkInit(c, c.env);
      return c.json({ upload_id: r.uploadId, code: r.code, chunk_size: r.chunkSize, total_chunks: r.totalChunks });
    }),
  );
  app.put('/api/upload/chunk/:upload_id/:index', json(async (c) => c.json(await chunkPut(c, c.env))));
  app.get(
    '/api/upload/chunk/status/:upload_id',
    json(async (c) => {
      const r = await chunkStatus(c, c.env);
      return c.json({ upload_id: r.uploadId, code: r.code, total_chunks: r.totalChunks, received: r.received });
    }),
  );
  app.post('/api/upload/chunk/complete/:upload_id', json(async (c) => c.json(await chunkComplete(c, c.env))));
  app.post('/api/upload/chunk/abort/:upload_id', json(async (c) => c.json(await chunkAbort(c, c.env))));

  // ===================== 读取 =====================

  app.get(
    '/api/text/:code',
    json(async (c) => {
      const lookup = await resolveShare(c.env, codeOf(c), { count: true, isHead: isHead(c), textOnly: true });
      if (lookup.status === 'notFound') return c.text('Not found', 404);
      if (lookup.status === 'maxExceeded') return c.text('Max downloads exceeded', 403);
      return c.text(await lookup.obj.text());
    }),
  );

  app.get(
    '/api/download/:code',
    html(async (c) => {
      const lookup = await resolveShare(c.env, codeOf(c), { count: true, isHead: isHead(c) });
      if (lookup.status === 'notFound') return c.html(errorPage('文件不存在', '该文件可能已被清理'), 404);
      if (lookup.status === 'maxExceeded') {
        return c.html(errorPage('已达最大下载次数', '该文件的下载次数已用完'), 403);
      }
      return buildDownloadResponse(lookup.file, lookup.obj, isHead(c));
    }),
  );

  app.get(
    '/api/info/:code',
    json(async (c) => {
      const file = await getFileByCode(c.env.DB, codeOf(c));
      if (!file) return c.json({ error: 'not found' }, 404);
      return c.json({
        filename: file.filename,
        size: file.size,
        download_count: file.downloadCount,
        max_downloads: file.maxDownloads,
        expire_at: file.expireAt,
      });
    }),
  );

  app.get('/qrcode/:code', async (c) => {
    const code = pathParam(c, 'code');
    if (!isValidCode(code)) return c.text('Invalid code', 400);
    if (!(await getFileByCode(c.env.DB, code))) return c.text('File not found', 404);

    const gif = generateQRCodeGIF(`${baseUrl(c)}/r/${code}`);
    return new Response(gif as unknown as BodyInit, {
      headers: { 'Content-Type': 'image/gif', 'Cache-Control': IMMUTABLE },
    });
  });

  // ===================== 管理后台 =====================

  app.get('/admin', async (c) => {
    noStore(c);
    if (!(await isAdminAuthed(c, c.env))) return c.html(adminLoginPage());

    const page = Math.max(1, Number(c.req.query('page')) || 1);
    const filters = readFilters(c);
    const { files, total } = await listFiles(c.env.DB, page, PAGE_SIZE, filters);
    return c.html(adminPanel(files, total, page, filters));
  });

  app.post('/admin/login', async (c) => {
    const body = await c.req.parseBody();
    const result = await login(c, c.env, typeof body['password'] === 'string' ? body['password'] : '');
    return result.success
      ? c.redirect('/admin')
      : c.html(adminLoginPage(result.error), result.status);
  });

  // 页面链接用 GET，API 客户端可用 POST
  app.on(['GET', 'POST'], '/admin/logout', async (c) => {
    await logout(c, c.env);
    return c.redirect('/');
  });

  app.post('/admin/delete/:id', async (c) => {
    if (!(await isAdminAuthed(c, c.env))) return c.redirect('/admin');

    const id = Number(c.req.param('id'));
    if (Number.isInteger(id)) {
      const file = await getFileById(c.env.DB, id);
      if (file) await deleteStoredFile(c.env, file);
    }
    return c.redirect('/admin');
  });

  // 手动清理过期文件（与 Cron 的过期处理同一条路径）
  app.post('/admin/cleanup', async (c) => {
    if (!(await isAdminAuthed(c, c.env))) return c.redirect('/admin');
    const expired = await takeExpiredFiles(c.env.DB);
    await removeObjects(c.env.FILE_STORE, expired.map((f) => fileKey(f.code)));
    return c.redirect('/admin');
  });

  // ===================== 自检 =====================

  app.get(
    '/api/init',
    json(async (c) => {
      if (!(await isAdminAuthed(c, c.env))) return c.json({ error: 'unauthorized' }, 401);
      await initDB(c.env.DB);
      return c.json({ ok: true });
    }),
  );

  app.get(
    '/api/status',
    json(async (c) => {
      const config = await getConfig(c.env);
      return c.json({
        ok: true,
        // Secret 与 D1 均无密码时为 false，便于部署后立即发现
        adminPasswordConfigured: await isAdminPasswordConfigured(c.env),
        maxFileSize: config.maxSize,
        defaultExpireDays: config.defaultExpireDays,
        openUpload: config.openUpload,
        chunkSize: CHUNK_SIZE,
      });
    }),
  );
}
