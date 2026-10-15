/**
 * 分片上传核心逻辑（30MB/片，300MB 封顶）。
 * 协议：init 建任务并抢占取件码 → put 逐片存 R2（chunk:{uploadId}:{index}）→
 * complete 流式拼接为最终对象并写 D1 → abort/超时清理并释放取件码。
 * 拼接复用 shared.createMultipartWriter，内存恒定 ~30MB。
 */
import type { Context } from 'hono';
import type { Env } from './types';
import { getClientIp } from './utils';
import { parseExpire, ensureCodeAvailable, createMultipartWriter } from './shared';
import {
  insertChunkTask,
  getChunkTask,
  deleteChunkTask,
  cleanupChunkTasks,
  insertFile,
  releaseCode,
  checkRateLimit,
} from './db';

const CHUNK_SIZE = 30 * 1024 * 1024; // 30MB，与 createMultipartWriter 分块一致

function chunkKey(uploadId: string, index: number): string {
  return `chunk:${uploadId}:${index}`;
}

/** 从 JSON body 读取过期参数（与 uploadFile 的兼容逻辑一致） */
function parseExpireFromBody(body: any, env: Env): { expireAt: string; maxDownloads: number } {
  const expireValueRaw = String(body?.expire_value ?? body?.expire_days ?? env.DEFAULT_EXPIRE_DAYS ?? '7');
  const expireStyleRaw = String(body?.expire_style ?? 'day');
  const maxDownloadsRaw = String(body?.max_downloads ?? '-1');
  const safeExpireValue = Number.isFinite(parseInt(expireValueRaw)) ? parseInt(expireValueRaw) : parseInt(env.DEFAULT_EXPIRE_DAYS || '7');
  const safeMaxDownloads = Number.isFinite(parseInt(maxDownloadsRaw)) ? parseInt(maxDownloadsRaw) : -1;
  const { expireAt, maxDownloads: parsedMax } = parseExpire(safeExpireValue, expireStyleRaw);
  return { expireAt, maxDownloads: safeMaxDownloads >= 0 ? safeMaxDownloads : parsedMax };
}

// ===================== 接口 =====================

/** 预创建上传任务：校验参数、抢占取件码、落库，返回 uploadId */
export async function chunkInit(c: Context<{ Bindings: Env }>, env: Env): Promise<{
  upload_id: string;
  code: string;
  chunk_size: number;
  total_chunks: number;
}> {
  const ip = getClientIp(c.req.raw.headers);
  if (!(await checkRateLimit(env.DB, 'upload_ratelimit', ip, 10))) {
    throw { status: 429 as const, message: '上传过于频繁，请稍后再试' };
  }

  const body = await c.req.json().catch(() => null);
  if (!body) throw { status: 422 as const, message: '请求体不能为空' };

  const size = Number(body.size);
  const maxSize = parseInt(env.MAX_FILE_SIZE || '314572800');
  if (!Number.isInteger(size) || size <= 0) throw { status: 422 as const, message: '无效的文件大小' };
  if (size > maxSize) throw { status: 413 as const, message: `文件过大，最大 ${Math.floor(maxSize / 1048576)}MB` };

  const expectedChunks = Math.ceil(size / CHUNK_SIZE);
  const totalChunks = Number(body.total_chunks);
  if (!Number.isInteger(totalChunks) || totalChunks !== expectedChunks) {
    throw { status: 422 as const, message: `分片数量应为 ${expectedChunks}` };
  }

  const filename = String(body.filename || '未命名').slice(0, 200);
  const rawCode = typeof body.code === 'string' ? body.code.trim() : '';
  const code = await ensureCodeAvailable(rawCode, env);
  const { expireAt, maxDownloads } = parseExpireFromBody(body, env);

  const uploadId = crypto.randomUUID();
  await insertChunkTask(env.DB, {
    upload_id: uploadId,
    code,
    filename,
    size,
    total_chunks: totalChunks,
    mime_type: String(body.mime_type || 'application/octet-stream'),
    expire_at: expireAt,
    max_downloads: maxDownloads,
    client_ip: ip,
    created_at: new Date().toISOString(),
  });
  return { upload_id: uploadId, code, chunk_size: CHUNK_SIZE, total_chunks: totalChunks };
}

/** 上传单个分片（幂等：同 index 重传覆盖，断点续传友好） */
export async function chunkPut(c: Context<{ Bindings: Env }>, env: Env): Promise<{ ok: true; index: number }> {
  const uploadId = c.req.param('upload_id') ?? '';
  const index = parseInt(c.req.param('index') ?? '');
  const task = await getChunkTask(env.DB, uploadId);
  if (!task) throw { status: 404 as const, message: '上传任务不存在或已过期' };
  if (!Number.isInteger(index) || index < 0 || index >= task.total_chunks) {
    throw { status: 422 as const, message: '无效的分片序号' };
  }

  const body = await c.req.arrayBuffer();
  if (body.byteLength === 0) throw { status: 422 as const, message: '分片内容为空' };
  if (body.byteLength > CHUNK_SIZE) throw { status: 413 as const, message: '分片超过 30MB' };

  await env.FILE_STORE.put(chunkKey(uploadId, index), body, {
    httpMetadata: { contentType: 'application/octet-stream' },
  });
  return { ok: true, index };
}

/** 查询已上传分片（断点续传：跳过已传片） */
export async function chunkStatus(c: Context<{ Bindings: Env }>, env: Env): Promise<{
  upload_id: string;
  code: string;
  total_chunks: number;
  received: number[];
}> {
  const uploadId = c.req.param('upload_id') ?? '';
  const task = await getChunkTask(env.DB, uploadId);
  if (!task) throw { status: 404 as const, message: '上传任务不存在或已过期' };

  const listed = await env.FILE_STORE.list({ prefix: `chunk:${uploadId}:` });
  const received = listed.objects
    .map((o) => parseInt(o.key.split(':')[2]))
    .filter((n) => Number.isInteger(n) && n >= 0 && n < task.total_chunks)
    .sort((a, b) => a - b);
  return { upload_id: uploadId, code: task.code, total_chunks: task.total_chunks, received };
}

/** 完成上传：校验全部分片与总大小，流式拼接为最终对象，写 D1，清理分片与任务 */
export async function chunkComplete(c: Context<{ Bindings: Env }>, env: Env): Promise<{
  code: string;
  filename: string;
  size: number;
}> {
  const uploadId = c.req.param('upload_id') ?? '';
  const task = await getChunkTask(env.DB, uploadId);
  if (!task) throw { status: 404 as const, message: '上传任务不存在或已过期' };

  const key = `file:${task.code}`;
  const writer = await createMultipartWriter(env.FILE_STORE, key, {
    contentType: task.mime_type,
    filename: task.filename,
    maxSize: parseInt(env.MAX_FILE_SIZE || '314572800'),
  });
  try {
    for (let i = 0; i < task.total_chunks; i++) {
      const obj = await env.FILE_STORE.get(chunkKey(uploadId, i));
      if (!obj) throw { status: 409 as const, message: `缺少第 ${i + 1} 片，请先上传` };
      const reader = obj.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        await writer.push(value);
      }
    }
    const size = await writer.finish();
    if (size !== task.size) {
      throw { status: 409 as const, message: `分片总大小与声明不一致（${size} ≠ ${task.size}）` };
    }
    await insertFile(env.DB, {
      code: task.code,
      filename: task.filename,
      size,
      mimeType: task.mime_type,
      expireAt: task.expire_at,
      maxDownloads: task.max_downloads,
      clientIp: task.client_ip,
    });
    // 清理分片与任务（取件码保留占用，随文件生命周期）
    await Promise.all(Array.from({ length: task.total_chunks }, (_, i) => env.FILE_STORE.delete(chunkKey(uploadId, i))));
    await deleteChunkTask(env.DB, uploadId);
    return { code: task.code, filename: task.filename, size };
  } catch (e) {
    await writer.abort().catch(() => {});
    await env.FILE_STORE.delete(key).catch(() => {});
    if (e instanceof Error && e.message === 'SIZE_LIMIT_EXCEEDED') {
      throw { status: 413 as const, message: `文件过大，最大 ${Math.floor(parseInt(env.MAX_FILE_SIZE || '314572800') / 1048576)}MB` };
    }
    throw e;
  }
}

/** 取消上传：清理分片、任务并释放取件码 */
export async function chunkAbort(c: Context<{ Bindings: Env }>, env: Env): Promise<{ ok: true }> {
  const uploadId = c.req.param('upload_id') ?? '';
  const task = await getChunkTask(env.DB, uploadId);
  if (task) {
    await Promise.all(Array.from({ length: task.total_chunks }, (_, i) => env.FILE_STORE.delete(chunkKey(uploadId, i))));
    await deleteChunkTask(env.DB, uploadId);
    await releaseCode(env.DB, task.code);
  }
  return { ok: true };
}

/** scheduled 清理超时未完成的分片上传任务 */
export async function cleanupStaleChunkUploads(env: Env): Promise<number> {
  const tasks = await cleanupChunkTasks(env.DB, 24 * 3600 * 1000);
  for (const t of tasks) {
    await Promise.all(Array.from({ length: t.total_chunks }, (_, i) => env.FILE_STORE.delete(chunkKey(t.upload_id, i))));
    await releaseCode(env.DB, t.code);
  }
  return tasks.length;
}
