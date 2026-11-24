/**
 * Web 路由：页面渲染、浏览器端上传/下载、管理面板与自检接口。
 * 业务逻辑全部来自领域模块，本文件只做参数解析与响应组装。
 */

import type { Hono } from 'hono';
import type { Env, FileFilters } from '../types';
import { getConfig, updateConfig } from '../config';
import { getFileByCode, getFileById, getStorageUsed, initDB, listFiles, takeExpiredFiles } from '../db';
import { assertUploadAllowed, isAdminAuthed, isAdminPasswordConfigured, login, logout } from '../auth';
import { buildDownloadResponse, deleteStoredFile, readThumb, resolveShare, saveThumb } from '../files';
import { allocateCodeRun, chunkAbort, chunkComplete, chunkInit, chunkPut, chunkStatus, uploadFile, uploadText } from '../upload';
import { removeObjects } from '../storage';
import { CHUNK_SIZE, HttpError, PLAIN_UPLOAD_LIMIT, RATE_WINDOW_MS, fileKey, getBaseUrl, getClientIp, isValidCode, toInt } from '../utils';
import { checkRateLimit } from '../db';
import { turnstileConfigured, turnstileSiteKey } from '../turnstile';
import { generateQRCodeGIF } from '../qr';
import { STYLE } from '../templates/style';
import {
  adminLoginPage,
  adminPanel,
  adminSettingsPage,
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
  return c.html(
    homePage({
      chunkThreshold: Math.min(config.maxSize, PLAIN_UPLOAD_LIMIT),
      maxFileSize: config.maxSize,
      defaultExpireDays: config.defaultExpireDays,
      turnstileSiteKey:
        config.turnstileEnabled && turnstileConfigured(c.env) ? turnstileSiteKey(c.env) : '',
    }),
  );
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
      headers: { 'Content-Type': 'image/webp', 'Cache-Control': IMMUTABLE, 'X-Content-Type-Options': 'nosniff' },
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
      const lookup = await resolveShare(c.env, codeOf(c), {
        count: true,
        isHead: isHead(c),
        textOnly: true,
        clientIp: getClientIp(c.req.raw.headers),
      });
      if (lookup.status === 'notFound') return c.text('Not found', 404);
      if (lookup.status === 'maxExceeded') return c.text('Max downloads exceeded', 403);
      return c.text(await lookup.obj.text());
    }),
  );

  app.get(
    '/api/download/:code',
    html(async (c) => {
      const lookup = await resolveShare(c.env, codeOf(c), {
        count: true,
        isHead: isHead(c),
        clientIp: getClientIp(c.req.raw.headers),
      });
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
        // 达查看上限后按下游口径遮蔽标题，避免正文被拒读而标题仍泄露
        filename:
          file.isText && file.maxDownloads >= 0 && file.downloadCount >= file.maxDownloads
            ? '***'
            : file.filename,
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

  // ===================== 批量取件码 / 缩略图 =====================

  app.get(
    '/api/codes/:count',
    json(async (c) => {
      const config = await getConfig(c.env);
      await assertUploadAllowed(c, config);
      // 取件码只有 1 万个，批量接口用更紧的独立配额，避免被用来耗尽码空间
      const ip = getClientIp(c.req.raw.headers);
      if (!(await checkRateLimit(c.env.DB, 'codes_ratelimit', ip, 3, RATE_WINDOW_MS))) {
        throw new HttpError(429, '申请取件码过于频繁，请稍后再试');
      }
      return c.json({ codes: await allocateCodeRun(c.env, toInt(pathParam(c, 'count'), 0)) });
    }),
  );

  app.post(
    '/api/thumb/:code',
    json(async (c) => {
      const data = await c.req.arrayBuffer();
      await saveThumb(c.env, pathParam(c, 'code'), data);
      return c.json({ ok: true });
    }),
  );

  app.get('/api/thumb/:code', async (c) => {
    const obj = await readThumb(c.env, pathParam(c, 'code'));
    if (!obj) return new Response('Not Found', { status: 404 });
    return new Response(obj.body, {
      headers: { 'Content-Type': 'image/webp', 'Cache-Control': IMMUTABLE, 'X-Content-Type-Options': 'nosniff' },
    });
  });

  // ===================== 管理后台 =====================

  app.get('/admin', async (c) => {
    noStore(c);
    if (!(await isAdminAuthed(c, c.env))) return c.html(adminLoginPage());

    const page = Math.max(1, Number(c.req.query('page')) || 1);
    const filters = readFilters(c);
    const { files, total } = await listFiles(c.env.DB, page, PAGE_SIZE, filters);
    const config = await getConfig(c.env);
    const used = await getStorageUsed(c.env.DB).catch(() => 0);
    return c.html(adminPanel(files, total, page, filters, { used, limit: config.maxTotalStorage }));
  });

  app.get('/admin/settings', async (c) => {
    noStore(c);
    if (!(await isAdminAuthed(c, c.env))) return c.html(adminLoginPage());
    const config = await getConfig(c.env);
    const used = await getStorageUsed(c.env.DB).catch(() => 0);
    const saved = c.req.query('saved') === '1';
    return c.html(
      adminSettingsPage(
        { config, used, turnstileReady: turnstileConfigured(c.env), varsMaxSize: toInt(c.env.MAX_FILE_SIZE, config.maxSize) },
        saved,
      ),
    );
  });

  app.post('/admin/settings', async (c) => {
    if (!(await isAdminAuthed(c, c.env))) return c.redirect('/admin');
    const body = await c.req.parseBody();
    const mb = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? Math.round(Number(v) * 1024 * 1024) : undefined);
    const patch: Record<string, unknown> = {
      openUpload: body['openUpload'] === '1',
      turnstileEnabled: body['turnstileEnabled'] === '1',
    };
    const maxSize = mb(body['maxFileSizeMb']);
    const maxTotal = mb(body['maxTotalStorageMb']);
    const days = toInt(body['defaultExpireDays'], 0);
    if (maxSize !== undefined && Number.isFinite(maxSize)) patch.maxFileSize = maxSize;
    if (maxTotal !== undefined && Number.isFinite(maxTotal)) patch.maxTotalStorage = maxTotal;
    if (days > 0) patch.defaultExpireDays = days;
    await updateConfig(c.env, patch);
    return c.redirect('/admin/settings?saved=1');
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
        maxTotalStorage: config.maxTotalStorage,
        turnstileEnabled: config.turnstileEnabled,
        turnstileConfigured: turnstileConfigured(c.env),
        chunkSize: CHUNK_SIZE,
      });
    }),
  );
}
