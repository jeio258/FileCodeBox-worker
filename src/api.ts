/**
 * FileCodeBox 兼容 API（v2.1.0，路径挂载在 /api）。
 * 标准响应格式 { code, msg, detail }；业务逻辑全部来自领域模块，本文件只做路由与格式转换。
 * 文档: https://fcb-docs.aiuo.net/api/
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Env } from './types';
import { formatFileSize, messageOf, statusOf } from './utils';
import { getConfig } from './config';
import { getDashboardStats, getFileById, listFiles, setSetting } from './db';
import { adminAuth, handleAdminLogin } from './auth';
import { buildDownloadResponse, deleteStoredFile, lookupFile } from './files';
import { uploadFile, uploadText } from './upload';

type Ctx = Context<{ Bindings: Env }>;

// ===================== 响应助手 =====================

const ok = (c: Ctx, detail: unknown, msg = 'success') => c.json({ code: 200, msg, detail });

/** 业务异常统一转成兼容格式 */
const fail = (c: Ctx, e: unknown, fallbackMsg = '服务器内部错误') =>
  c.json({ code: statusOf(e), msg: messageOf(e, fallbackMsg) }, statusOf(e) as ContentfulStatusCode);

const failWith = (c: Ctx, status: number, msg: string) =>
  c.json({ code: status, msg }, status as ContentfulStatusCode);

/** 兼容带/不带尾斜杠两种写法 */
const register = (method: 'get' | 'post', path: string, handler: (c: Ctx) => Response | Promise<Response>) => {
  api[method](path, handler);
  api[method](`${path}/`, handler);
};

// ===================== 路由 =====================

const api = new Hono<{ Bindings: Env }>();

// ---- 认证（公开） ----
api.post('/admin/login', async (c) => {
  const body = await c.req.json<{ password?: string }>().catch(() => null);
  const password = body?.password ?? '';
  if (!password) return failWith(c, 422, '密码不能为空');

  const result = await handleAdminLogin(c, c.env, password);
  if (!result.success) return failWith(c, 401, result.error);
  return ok(c, { token: result.token, token_type: 'Bearer' });
});

// ---- 分享文本 / 文件（兼容带与不带尾斜杠两种写法） ----
const shareTextHandler = async (c: Ctx) => {
  try {
    const result = await uploadText(c, c.env);
    return ok(c, { code: result.code });
  } catch (e) {
    return fail(c, e);
  }
};
register('post', '/share/text', shareTextHandler);

const shareFileHandler = async (c: Ctx) => {
  try {
    const result = await uploadFile(c, c.env);
    return ok(c, { code: result.code, name: result.filename });
  } catch (e) {
    return fail(c, e);
  }
};
register('post', '/share/file', shareFileHandler);

// ---- 取件信息（GET 计入次数，POST 只查询） ----
async function selectHandler(c: Ctx, count: boolean) {
  const code = (c.req.query('code') ?? c.req.query('key') ?? '').trim();
  try {
    const lookup = await lookupFile(c.env, code, { count, isHead: false });
    if (lookup.status === 'notFound') return failWith(c, 404, '文件不存在或已过期');
    if (lookup.status === 'maxExceeded') return failWith(c, 403, '已达最大下载次数');

    const { file, obj } = lookup;
    return ok(c, {
      code: file.code,
      name: file.filename,
      size: file.size,
      text: file.is_text === 1 ? await obj.text() : undefined,
    });
  } catch (e) {
    return fail(c, e);
  }
}

register('get', '/share/select', (c) => selectHandler(c, true));
register('post', '/share/select', (c) => selectHandler(c, false));

// ---- 下载 ----
const downloadHandler = async (c: Ctx) => {
  const code = (c.req.query('code') ?? c.req.query('key') ?? '').trim();
  try {
    const lookup = await lookupFile(c.env, code, { count: true, isHead: c.req.method === 'HEAD' });
    if (lookup.status === 'notFound') return failWith(c, 404, '文件不存在或已过期');
    if (lookup.status === 'maxExceeded') return failWith(c, 403, '已达最大下载次数');
    return buildDownloadResponse(lookup.file, lookup.obj, c.req.method === 'HEAD');
  } catch (e) {
    return fail(c, e);
  }
};
register('get', '/share/download', downloadHandler);

// ---- 管理（受保护） ----
const adminApi = new Hono<{ Bindings: Env }>();

adminApi.use('*', async (c, next) => {
  if (!(await adminAuth(c, c.env))) return failWith(c, 401, '未授权');
  await next();
});

adminApi.get('/dashboard', async (c) => {
  const s = await getDashboardStats(c.env.DB);
  return ok(c, {
    totalFiles: s.totalFiles,
    storageUsed: formatFileSize(s.totalSize),
    todayCount: s.todayCount,
    todaySize: formatFileSize(s.todaySize),
    yesterdayCount: s.yesterdayCount,
    yesterdaySize: formatFileSize(s.yesterdaySize),
  });
});

adminApi.get('/file/list', async (c) => {
  const page = Math.max(1, Number(c.req.query('page')) || 1);
  const size = Math.min(100, Math.max(1, Number(c.req.query('size')) || 10));
  const { files, total } = await listFiles(c.env.DB, page, size, {
    keyword: c.req.query('keyword') ?? '',
    dateFrom: c.req.query('date_from') ?? '',
    dateTo: c.req.query('date_to') ?? '',
    sort: c.req.query('sort') ?? 'newest',
  });
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
  const id = Number(c.req.query('id'));
  if (!Number.isInteger(id)) return failWith(c, 422, '缺少文件 ID');

  const file = await getFileById(c.env.DB, id);
  if (!file) return failWith(c, 404, '文件不存在');
  await deleteStoredFile(c.env, file);
  return ok(c, { id });
});

async function readConfig(c: Ctx) {
  const config = await getConfig(c.env);
  return {
    openUpload: config.openUpload ? '1' : '0',
    maxFileSize: String(config.maxSize),
    defaultExpireDays: String(config.defaultExpireDays),
  };
}

adminApi.get('/config/get', async (c) => ok(c, await readConfig(c)));

adminApi.patch('/config/update', async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body) return failWith(c, 422, '请求体不能为空');

  const mapping: Record<string, string> = {
    openUpload: 'open_upload',
    maxFileSize: 'max_file_size',
    defaultExpireDays: 'default_expire_days',
  };
  for (const [field, key] of Object.entries(mapping)) {
    if (body[field] !== undefined) await setSetting(c.env.DB, key, String(body[field]));
  }
  return ok(c, await readConfig(c));
});

api.route('/admin', adminApi);

export default api;
