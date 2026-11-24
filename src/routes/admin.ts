/**
 * 管理后台与自检路由：面板、设置、登录/登出、删除、清理、/api/init、/api/status。
 * 表单类操作一律 302 回面板，JSON 类走 respond 的 json 出口。
 */

import type { Hono } from 'hono';
import type { Env, FileFilters } from '../types';
import { getConfig, updateConfig } from '../config';
import { getFileById, getStorageUsed, initDB, listFiles, takeExpiredFiles } from '../db';
import { isAdminAuthed, isAdminPasswordConfigured, login, logout } from '../auth';
import { deleteStoredFile } from '../files';
import { removeObjects } from '../storage';
import { CHUNK_SIZE, fileKey, toInt } from '../utils';
import { turnstileConfigured } from '../turnstile';
import { adminLoginPage, adminPanel, adminSettingsPage } from '../templates/pages';
import { json, type Ctx } from '../respond';

const FILTER_DEFAULTS: FileFilters = { keyword: '', dateFrom: '', dateTo: '', sort: 'newest' };
const PAGE_SIZE = 50;
const noStore = (c: Ctx) => c.header('Cache-Control', 'no-store');

function readFilters(c: Ctx): FileFilters {
  return {
    keyword: (c.req.query('keyword') ?? '').trim(),
    dateFrom: c.req.query('date_from') ?? '',
    dateTo: c.req.query('date_to') ?? '',
    sort: c.req.query('sort') ?? FILTER_DEFAULTS.sort,
  };
}

export function registerAdminRoutes(app: Hono<{ Bindings: Env }>): void {
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
        { config, used, turnstileReady: turnstileConfigured(c.env) },
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
