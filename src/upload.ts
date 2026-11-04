/**
 * 上传域：普通上传、文本分享、分片上传（init/put/status/complete/abort）与超时回收。
 * 三者共用同一套配置解析、限流、取件码抢占、multipart 写入与失败回滚。
 */

import type { Context } from 'hono';
import type { ChunkUploadTask, Env } from './types';
import { expireInput, getConfig, resolveExpire } from './config';
import { assertUploadAllowed } from './auth';
import {
  checkRateLimit,
  claimCode,
  cleanupUsedCodes,
  deleteChunkTask,
  getChunkTask,
  getFileByCode,
  insertChunkTask,
  insertFile,
  isCodeTaken,
  releaseCode,
  takeStaleChunkTasks,
  touchChunkTask,
} from './db';
import {
  createMultipartWriter,
  deleteChunkParts,
  getChunkPart,
  listChunkParts,
  putChunkPart,
  removeObject,
} from './storage';
import {
  CHUNK_SIZE,
  MAX_TEXT_BYTES,
  SIZE_LIMIT_SIGNAL,
  UPLOAD_RATE_MAX,
  RATE_WINDOW_MS,
  CHUNK_STALE_MS,
  HttpError,
  fileKey,
  generateCode,
  getClientIp,
  isValidCode,
  sanitizeFilename,
  tooLarge,
} from './utils';

type Ctx = Context<{ Bindings: Env }>;

export interface UploadResult {
  code: string;
  filename: string;
  size: number;
}

export interface TextResult {
  code: string;
  title: string;
  size: number;
}

// ===================== 共用步骤 =====================

async function assertUploadRate(c: Ctx, env: Env): Promise<void> {
  const ip = getClientIp(c.req.raw.headers);
  if (!(await checkRateLimit(env.DB, 'upload_ratelimit', ip, UPLOAD_RATE_MAX, RATE_WINDOW_MS))) {
    throw new HttpError(429, '上传过于频繁，请稍后再试');
  }
}

/**
 * 原子抢占取件码：rawCode 为空时自动生成（最多 20 次）。
 * isCodeTaken 预检双表快速失败；claimCode（INSERT OR IGNORE + changes）为原子门闩，
 * 并发同码仅一个请求成功，失败方不再写 R2/D1。
 */
async function allocateCode(rawCode: string, env: Env): Promise<string> {
  if (rawCode && !isValidCode(rawCode)) throw new HttpError(400, '取件码必须为 4 位数字');

  for (let i = 0; i < 20; i++) {
    const code = rawCode || generateCode();
    if (await isCodeTaken(env.DB, code)) {
      if (rawCode) break;
      continue;
    }
    if (await claimCode(env.DB, code)) return code;
    if (rawCode) break;
  }
  throw new HttpError(rawCode ? 409 : 500, rawCode ? '取件码已被占用' : '无法生成唯一取件码');
}

/** 把请求体流式喂给 R2，失败时回滚对象与取件码 */
async function writeStream(
  env: Env,
  key: string,
  body: ReadableStream | null,
  meta: { contentType: string; filename: string; maxSize: number },
): Promise<number> {
  const reader = (body ?? new ReadableStream()).getReader();
  let writer: Awaited<ReturnType<typeof createMultipartWriter>> | undefined;
  try {
    writer = await createMultipartWriter(env.FILE_STORE, key, meta);
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      await writer.push(value);
    }
    return await writer.finish();
  } catch (e) {
    await writer?.abort();
    await reader.cancel().catch(() => {});
    await removeObject(env.FILE_STORE, key);
    throw e instanceof Error && e.message === SIZE_LIMIT_SIGNAL ? tooLarge(meta.maxSize) : e;
  }
}

// ===================== 普通上传 =====================

export async function uploadFile(c: Ctx, env: Env): Promise<UploadResult> {
  const config = await getConfig(env);
  await assertUploadAllowed(c, config);
  await assertUploadRate(c, env);

  const q = c.req.query();
  const expire = resolveExpire(expireInput(q), config);
  const filename = sanitizeFilename(c.req.header('X-Filename'));
  const mimeType = c.req.header('Content-Type') || 'application/octet-stream';

  // Content-Length 预检：超限直接拒绝，不读 body；缺失时由流式计数兜底
  const contentLength = Number(c.req.header('Content-Length'));
  if (Number.isFinite(contentLength) && contentLength > config.maxSize) throw tooLarge(config.maxSize);

  const code = await allocateCode((q.code ?? '').trim(), env);
  const key = fileKey(code);

  try {
    const size = await writeStream(env, key, c.req.raw.body, {
      contentType: mimeType,
      filename,
      maxSize: config.maxSize,
    });
    await insertFile(env.DB, {
      code,
      filename,
      size,
      mimeType,
      expireAt: expire.expireAt,
      maxDownloads: expire.maxDownloads,
      clientIp: getClientIp(c.req.raw.headers),
    });
    return { code, filename, size };
  } catch (e) {
    await releaseCode(env.DB, code);
    throw e;
  }
}

// ===================== 文本分享 =====================

export async function uploadText(c: Ctx, env: Env): Promise<TextResult> {
  const config = await getConfig(env);
  await assertUploadAllowed(c, config);
  await assertUploadRate(c, env);

  const body = await c.req.parseBody();
  const text = typeof body['text'] === 'string' ? body['text'] : '';
  if (!text.trim()) throw new HttpError(422, '文本内容不能为空');

  const size = new TextEncoder().encode(text).length;
  if (size > MAX_TEXT_BYTES) throw new HttpError(400, '文本过长，最大支持 512KB');

  const expire = resolveExpire(expireInput(body), config);
  const code = await allocateCode(typeof body['code'] === 'string' ? body['code'].trim() : '', env);
  const title = text.replace(/\s+/g, ' ').slice(0, 50) + (text.length > 50 ? '…' : '');

  try {
    await env.FILE_STORE.put(fileKey(code), text, {
      httpMetadata: { contentType: 'text/plain' },
      customMetadata: { filename: title },
    });
    await insertFile(env.DB, {
      code,
      filename: title,
      size,
      mimeType: 'text/plain',
      expireAt: expire.expireAt,
      maxDownloads: expire.maxDownloads,
      isText: 1,
      clientIp: getClientIp(c.req.raw.headers),
    });
    return { code, title, size };
  } catch (e) {
    await releaseCode(env.DB, code);
    throw e;
  }
}

// ===================== 分片上传 =====================

export interface ChunkInitResult {
  upload_id: string;
  code: string;
  chunk_size: number;
  total_chunks: number;
}

export async function chunkInit(c: Ctx, env: Env): Promise<ChunkInitResult> {
  const config = await getConfig(env);
  await assertUploadAllowed(c, config);
  await assertUploadRate(c, env);

  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body) throw new HttpError(422, '请求体不能为空');

  const size = Number(body.size);
  if (!Number.isInteger(size) || size <= 0) throw new HttpError(422, '无效的文件大小');
  if (size > config.maxSize) throw tooLarge(config.maxSize);

  const totalChunks = Math.ceil(size / CHUNK_SIZE);
  if (Number(body.total_chunks) !== totalChunks) {
    throw new HttpError(422, `分片数量应为 ${totalChunks}`);
  }

  const expire = resolveExpire(expireInput(body), config);
  const code = await allocateCode(typeof body.code === 'string' ? body.code.trim() : '', env);
  const uploadId = crypto.randomUUID();
  const now = new Date().toISOString();

  try {
    await insertChunkTask(env.DB, {
      upload_id: uploadId,
      code,
      filename: sanitizeFilename(typeof body.filename === 'string' ? body.filename : undefined),
      size,
      total_chunks: totalChunks,
      mime_type: typeof body.mime_type === 'string' && body.mime_type ? body.mime_type : 'application/octet-stream',
      expire_at: expire.expireAt,
      max_downloads: expire.maxDownloads,
      client_ip: getClientIp(c.req.raw.headers),
      created_at: now,
      updated_at: now,
    });
  } catch (e) {
    await releaseCode(env.DB, code);
    throw e;
  }
  return { upload_id: uploadId, code, chunk_size: CHUNK_SIZE, total_chunks: totalChunks };
}

async function requireChunkTask(env: Env, uploadId: string): Promise<ChunkUploadTask> {
  const task = uploadId ? await getChunkTask(env.DB, uploadId) : null;
  if (!task) throw new HttpError(404, '上传任务不存在或已过期');
  return task;
}

export async function chunkPut(c: Ctx, env: Env): Promise<{ ok: true; index: number }> {
  const uploadId = c.req.param('upload_id') ?? '';
  const index = Number(c.req.param('index'));
  const task = await requireChunkTask(env, uploadId);

  if (!Number.isInteger(index) || index < 0 || index >= task.total_chunks) {
    throw new HttpError(422, '无效的分片序号');
  }

  const data = await c.req.arrayBuffer();
  if (data.byteLength === 0) throw new HttpError(422, '分片内容为空');
  if (data.byteLength > CHUNK_SIZE) throw new HttpError(413, '分片超过 30MB');

  await putChunkPart(env.FILE_STORE, uploadId, index, data);
  await touchChunkTask(env.DB, uploadId);
  return { ok: true, index };
}

export async function chunkStatus(
  c: Ctx,
  env: Env,
): Promise<{ upload_id: string; code: string; total_chunks: number; received: number[] }> {
  const task = await requireChunkTask(env, c.req.param('upload_id') ?? '');
  return {
    upload_id: task.upload_id,
    code: task.code,
    total_chunks: task.total_chunks,
    received: await listChunkParts(env.FILE_STORE, task.upload_id, task.total_chunks),
  };
}

export async function chunkComplete(c: Ctx, env: Env): Promise<UploadResult> {
  const task = await requireChunkTask(env, c.req.param('upload_id') ?? '');
  const config = await getConfig(env);
  const key = fileKey(task.code);
  let writer: Awaited<ReturnType<typeof createMultipartWriter>> | undefined;

  try {
    writer = await createMultipartWriter(env.FILE_STORE, key, {
      contentType: task.mime_type,
      filename: task.filename,
      maxSize: config.maxSize,
    });
    for (let i = 0; i < task.total_chunks; i++) {
      const part = await getChunkPart(env.FILE_STORE, task.upload_id, i);
      if (!part) throw new HttpError(409, `缺少第 ${i + 1} 片，请先上传`);
      const reader = part.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        await writer.push(value);
      }
    }
    const size = await writer.finish();
    if (size !== task.size) throw new HttpError(409, `分片总大小与声明不一致（${size} ≠ ${task.size}）`);

    await insertFile(env.DB, {
      code: task.code,
      filename: task.filename,
      size,
      mimeType: task.mime_type,
      expireAt: task.expire_at,
      maxDownloads: task.max_downloads,
      clientIp: task.client_ip,
    });
  } catch (e) {
    await writer?.abort();
    await removeObject(env.FILE_STORE, key);
    throw e instanceof Error && e.message === SIZE_LIMIT_SIGNAL ? tooLarge(config.maxSize) : e;
  }

  // 成功后再清分片与任务；取件码随文件生命周期保留
  await purgeChunkTask(env, task, false);
  return { code: task.code, filename: task.filename, size: task.size };
}

export async function chunkAbort(c: Ctx, env: Env): Promise<{ ok: true }> {
  const uploadId = c.req.param('upload_id') ?? '';
  const task = await getChunkTask(env.DB, uploadId);
  if (task) await purgeChunkTask(env, task, true);
  return { ok: true };
}

/** 清理分片对象 + 任务记录（可选释放取件码）；abort / 超时 / complete 后共用 */
async function purgeChunkTask(env: Env, task: ChunkUploadTask, release: boolean): Promise<void> {
  await deleteChunkParts(env.FILE_STORE, task.upload_id, task.total_chunks);
  await deleteChunkTask(env.DB, task.upload_id);
  // 已合并但清理失败的任务：码已归属真实文件，不能再释放（否则会与文件抢码）
  if (release && !(await getFileByCode(env.DB, task.code))) await releaseCode(env.DB, task.code);
}

/** scheduled：回收 6h 未活跃的分片任务并释放取件码 */
export async function cleanupStaleChunks(env: Env): Promise<number> {
  const tasks = await takeStaleChunkTasks(env.DB, CHUNK_STALE_MS);
  for (const task of tasks) await purgeChunkTask(env, task, true);
  return tasks.length;
}

/** scheduled：顺手清理无主占用码（删除中途失败的兜底） */
export const cleanupOrphanCodes = (env: Env): Promise<number> => cleanupUsedCodes(env.DB);
