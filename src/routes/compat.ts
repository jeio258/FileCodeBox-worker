/**
 * FileCodeBox 兼容 API（v2.1.0），挂载在 /api。
 * 响应统一 `{ code, msg, detail }`；本文件只做路由与格式转换，业务逻辑来自领域模块。
 * 文档: https://fcb-docs.aiuo.net/api/
 */

import { Hono } from 'hono';
import type { Env } from '../types';
import { configToApi, getConfig, updateConfig } from '../config';
import { getDashboardStats, getFileById, listFiles } from '../db';
import { changePassword, isAdminAuthed, login } from '../auth';
import { buildDownloadResponse, deleteStoredFile, resolveShare } from '../files';
import { uploadFile, uploadText } from '../upload';
import { formatFileSize } from '../utils';
import { codeOf, compat, compatFail, compatOk, type Ctx } from '../respond';

const api = new Hono<{ Bindings: Env }>();

/** 兼容带/不带尾斜杠两种写法 */
function register(
  method: 'get' | 'post',
  path: string,
  handler: (c: Ctx) => Response | Promise<Response>,
): void {
  api[method](path, handler);
  api[method](`${path}/`, handler);
}

// ===================== 认证（公开） =====================

api.post('/admin/login', async (c) => {
  const body = await c.req.json<{ password?: string }>().catch(() => null);
  const password = body?.password ?? '';
  if (!password) return compatFail(c, 422, '密码不能为空');

  const result = await login(c, c.env, password);
  if (!result.success) return compatFail(c, result.status, result.error);
  return compatOk(c, { token: result.token, token_type: 'Bearer' });
});

// ===================== 分享 =====================

register(
  'post',
  '/share/text',
  compat(async (c) => compatOk(c, { code: (await uploadText(c, c.env)).code })),
);

register(
  'post',
  '/share/file',
  compat(async (c) => {
    const result = await uploadFile(c, c.env);
    return compatOk(c, { code: result.code, name: result.filename });
  }),
);

/** GET 计入查看次数，POST 仅查询 */
async function selectHandler(c: Ctx, count: boolean): Promise<Response> {
  const lookup = await resolveShare(c.env, codeOf(c), { count, isHead: false });
  if (lookup.status === 'notFound') return compatFail(c, 404, '文件不存在或已过期');
  if (lookup.status === 'maxExceeded') return compatFail(c, 403, '已达最大下载次数');

  const { file, obj } = lookup;
  return compatOk(c, {
    code: file.code,
    name: file.filename,
    size: file.size,
    text: file.isText ? await obj.text() : undefined,
  });
}

register('get', '/share/select', compat((c) => selectHandler(c, true)));
register('post', '/share/select', compat((c) => selectHandler(c, false)));

register(
  'get',
  '/share/download',
  compat(async (c) => {
    const isHead = c.req.method === 'HEAD';
    const lookup = await resolveShare(c.env, codeOf(c), { count: true, isHead });
    if (lookup.status === 'notFound') return compatFail(c, 404, '文件不存在或已过期');
    if (lookup.status === 'maxExceeded') return compatFail(c, 403, '已达最大下载次数');
    return buildDownloadResponse(lookup.file, lookup.obj, isHead);
  }),
);

// ===================== 管理（受保护） =====================

const adminApi = new Hono<{ Bindings: Env }>();

adminApi.use('*', async (c, next) => {
  if (!(await isAdminAuthed(c, c.env))) return compatFail(c, 401, '未授权');
  await next();
});

adminApi.get('/dashboard', async (c) => {
  const s = await getDashboardStats(c.env.DB);
  return compatOk(c, {
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
  return compatOk(c, {
    page,
    size,
    total,
    data: files.map((f) => ({
      id: f.id,
      name: f.filename,
      size: f.size,
      code: f.code,
      download_count: f.downloadCount,
      expire_at: f.expireAt,
      created_at: f.createdAt,
    })),
  });
});

adminApi.delete('/file/delete', async (c) => {
  const id = Number(c.req.query('id'));
  if (!Number.isInteger(id)) return compatFail(c, 422, '缺少文件 ID');

  const file = await getFileById(c.env.DB, id);
  if (!file) return compatFail(c, 404, '文件不存在');
  await deleteStoredFile(c.env, file);
  return compatOk(c, { id });
});

adminApi.get('/config/get', async (c) => compatOk(c, configToApi(await getConfig(c.env))));

adminApi.patch('/config/update', async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body) return compatFail(c, 422, '请求体不能为空');
  return compatOk(c, configToApi(await updateConfig(c.env, body)));
});

adminApi.post(
  '/password',
  compat(async (c) => {
    const body = await c.req.json<{ current_password?: string; new_password?: string }>().catch(() => null);
    if (!body) return compatFail(c, 422, '请求体不能为空');
    await changePassword(c, c.env, body.current_password ?? '', body.new_password ?? '');
    return compatOk(c, { changed: true });
  }),
);

api.route('/admin', adminApi);

export default api;
