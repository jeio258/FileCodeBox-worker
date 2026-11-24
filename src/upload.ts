/**
 * 写入域：普通上传、文本分享、分片上传（init/put/status/complete/abort）与超时回收。
 * 三类上传共用：配置 → 门控 → 限流 → 取件码原子抢占 → 失败回滚。
 */

import type { Context } from 'hono';
import type { ChunkTask, Env, RuntimeConfig } from './types';
import { getConfig } from './config';
import { readExpireInput, resolveExpire } from './expire';
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
  putObject,
  removeObject,
} from './storage';
import {
  CHUNK_SIZE,
  CHUNK_STALE_MS,
  HttpError,
  MAX_TEXT_BYTES,
  RATE_WINDOW_MS,
  UPLOAD_RATE_MAX,
  fileKey,
  generateCode,
  getClientIp,
  isValidCode,
  sanitizeFilename,
  summarize,
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

export interface ChunkInitResult {
  uploadId: string;
  code: string;
  chunkSize: number;
  totalChunks: number;
}

// ===================== 共用步骤 =====================

/** 上传入口共用前置：取配置 → 游客门控 → 限流 */
async function prepareUpload(c: Ctx, env: Env): Promise<RuntimeConfig> {
  const config = await getConfig(env);
  await assertUploadAllowed(c, config);

  const ip = getClientIp(c.req.raw.headers);
  if (!(await checkRateLimit(env.DB, 'upload_ratelimit', ip, UPLOAD_RATE_MAX, RATE_WINDOW_MS))) {
    throw new HttpError(429, '上传过于频繁，请稍后再试');
  }
  return config;
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

// ===================== 普通上传 =====================

export async function uploadFile(c: Ctx, env: Env): Promise<UploadResult> {
  const config = await prepareUpload(c, env);

  const query = c.req.query();
  const expire = resolveExpire(readExpireInput(query), config);
  const filename = sanitizeFilename(c.req.header('X-Filename'));
  const mimeType = c.req.header('Content-Type') || 'application/octet-stream';

  // 零拷贝：请求体直接交给 R2，字节不在 JS 里搬运（避免 Free 计划 CPU 超限）。
  // 因此要求已知长度；缺失时 411 并提示改走分片，绝不退化成整读内存。
  const contentLength = c.req.header('Content-Length');
  const declared = Number(contentLength);
  const knownLength = contentLength !== undefined && Number.isInteger(declared) && declared >= 0;
  if (!knownLength) throw new HttpError(411, '上传必须带 Content-Length（分块传输请改走分片接口）');
  if (declared > config.maxSize) throw new HttpError(413, `文件过大，最大 ${Math.floor(config.maxSize / 1024 / 1024)}MB`);

  const code = await allocateCode((query.code ?? '').trim(), env);
  const key = fileKey(code);
  const clientIp = getClientIp(c.req.raw.headers);

  try {
    const obj = await env.FILE_STORE.put(key, c.req.raw.body, {
      httpMetadata: { contentType: mimeType },
      customMetadata: { filename },
    });
    if (!obj) throw new Error('R2 put failed');
    await insertFile(env.DB, {
      code, filename, size: obj.size, mimeType,
      expireAt: expire.expireAt, maxDownloads: expire.maxDownloads, clientIp,
    });
    return { code, filename, size: obj.size };
  } catch (e) {
    await env.FILE_STORE.delete(key).catch(() => {});
    await releaseCode(env.DB, code);
    throw e;
  }
}

// ===================== 文本分享 =====================

export async function uploadText(c: Ctx, env: Env): Promise<TextResult> {
  const config = await prepareUpload(c, env);

  const body = await c.req.parseBody();
  const text = typeof body['text'] === 'string' ? body['text'] : '';
  if (!text.trim()) throw new HttpError(422, '文本内容不能为空');

  const size = new TextEncoder().encode(text).length;
  if (size > MAX_TEXT_BYTES) throw new HttpError(400, `文本过长，最大支持 ${Math.floor(MAX_TEXT_BYTES / 1024)}KB`);

  const expire = resolveExpire(readExpireInput(body), config);
  const code = await allocateCode(typeof body['code'] === 'string' ? body['code'].trim() : '', env);
  const title = summarize(text);
  const clientIp = getClientIp(c.req.raw.headers);

  try {
    await putObject(env.FILE_STORE, fileKey(code), text, { contentType: 'text/plain', filename: title });
    await insertFile(env.DB, {
      code,
      filename: title,
      size,
      mimeType: 'text/plain',
      expireAt: expire.expireAt,
      maxDownloads: expire.maxDownloads,
      isText: true,
      clientIp,
    });
    return { code, title, size };
  } catch (e) {
    await releaseCode(env.DB, code);
    throw e;
  }
}

// ===================== 分片上传 =====================

export async function chunkInit(c: Ctx, env: Env): Promise<ChunkInitResult> {
  const config = await prepareUpload(c, env);

  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body) throw new HttpError(422, '请求体不能为空');

  const size = Number(body.size);
  if (!Number.isInteger(size) || size <= 0) throw new HttpError(422, '无效的文件大小');
  if (size > config.maxSize) throw new HttpError(413, `文件过大，最大 ${Math.floor(config.maxSize / 1024 / 1024)}MB`);

  const totalChunks = Math.ceil(size / CHUNK_SIZE);
  if (Number(body.total_chunks) !== totalChunks) throw new HttpError(422, `分片数量应为 ${totalChunks}`);

  const expire = resolveExpire(readExpireInput(body), config);
  const code = await allocateCode(typeof body.code === 'string' ? body.code.trim() : '', env);
  const now = new Date().toISOString();
  const task: ChunkTask = {
    uploadId: crypto.randomUUID(),
    code,
    filename: sanitizeFilename(typeof body.filename === 'string' ? body.filename : undefined),
    size,
    totalChunks,
    mimeType: typeof body.mime_type === 'string' && body.mime_type ? body.mime_type : 'application/octet-stream',
    expireAt: expire.expireAt,
    maxDownloads: expire.maxDownloads,
    clientIp: getClientIp(c.req.raw.headers),
    createdAt: now,
    updatedAt: now,
  };

  try {
    await insertChunkTask(env.DB, task);
  } catch (e) {
    await releaseCode(env.DB, code);
    throw e;
  }
  return { uploadId: task.uploadId, code, chunkSize: CHUNK_SIZE, totalChunks };
}

/** 分片任务必须存在，否则 404 */
async function requireTask(env: Env, uploadId: string): Promise<ChunkTask> {
  const task = uploadId ? await getChunkTask(env.DB, uploadId) : null;
  if (!task) throw new HttpError(404, '上传任务不存在或已过期');
  return task;
}

const uploadIdOf = (c: Ctx) => (c.req.param('upload_id') ?? '').trim();

export async function chunkPut(c: Ctx, env: Env): Promise<{ ok: true; index: number; }> {
  const task = await requireTask(env, uploadIdOf(c));
  const index = Number(c.req.param('index'));

  if (!Number.isInteger(index) || index < 0 || index >= task.totalChunks) {
    throw new HttpError(422, '无效的分片序号');
  }

  const data = await c.req.arrayBuffer();
  if (data.byteLength === 0) throw new HttpError(422, '分片内容为空');
  if (data.byteLength > CHUNK_SIZE) throw new HttpError(413, '分片超过 30MB');

  await putChunkPart(env.FILE_STORE, task.uploadId, index, data);
  await touchChunkTask(env.DB, task.uploadId);
  return { ok: true, index };
}

export async function chunkStatus(
  c: Ctx,
  env: Env,
): Promise<{ uploadId: string; code: string; totalChunks: number; received: number[]; }> {
  const task = await requireTask(env, uploadIdOf(c));
  return {
    uploadId: task.uploadId,
    code: task.code,
    totalChunks: task.totalChunks,
    received: await listChunkParts(env.FILE_STORE, task.uploadId, task.totalChunks),
  };
}

export async function chunkComplete(c: Ctx, env: Env): Promise<UploadResult> {
  const task = await requireTask(env, uploadIdOf(c));
  const config = await getConfig(env);
  const key = fileKey(task.code);

  let size: number;
  try {
    const writer = await createMultipartWriter(env.FILE_STORE, key, {
      contentType: task.mimeType,
      filename: task.filename,
      maxSize: config.maxSize,
    });
    try {
      for (let i = 0; i < task.totalChunks; i++) {
        const part = await getChunkPart(env.FILE_STORE, task.uploadId, i);
        if (!part) throw new HttpError(409, `缺少第 ${i + 1} 片，请先上传`);
        const reader = part.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          await writer.push(value);
        }
      }
      size = await writer.finish();
    } catch (e) {
      await writer.abort();
      throw e;
    }

    if (size !== task.size) throw new HttpError(409, `分片总大小与声明不一致（${size} ≠ ${task.size}）`);

    await insertFile(env.DB, {
      code: task.code,
      filename: task.filename,
      size,
      mimeType: task.mimeType,
      expireAt: task.expireAt,
      maxDownloads: task.maxDownloads,
      clientIp: task.clientIp,
    });
  } catch (e) {
    await removeObject(env.FILE_STORE, key);
    throw e;
  }

  // 落库已成功：清理失败不影响本次上传结果，仅留待 Cron 兜底
  await purgeChunkArtifacts(env, task).catch((e) =>
    console.error(JSON.stringify({ event: 'chunk_purge_failed', uploadId: task.uploadId, error: String(e) })),
  );
  return { code: task.code, filename: task.filename, size };
}

export async function chunkAbort(c: Ctx, env: Env): Promise<{ ok: true; }> {
  const task = await getChunkTask(env.DB, uploadIdOf(c));
  if (task) {
    await purgeChunkArtifacts(env, task);
    await releaseCodeIfUnused(env, task.code);
  }
  return { ok: true };
}

/** 删除分片对象 + 任务记录（不碰取件码） */
async function purgeChunkArtifacts(env: Env, task: ChunkTask): Promise<void> {
  await deleteChunkParts(env.FILE_STORE, task.uploadId, task.totalChunks);
  await deleteChunkTask(env.DB, task.uploadId);
}

/** 已合并但任务残留时，码已归属真实文件，不能再释放（否则与文件抢码） */
async function releaseCodeIfUnused(env: Env, code: string): Promise<void> {
  if (!(await getFileByCode(env.DB, code))) await releaseCode(env.DB, code);
}

/** Cron：回收 6h 未活跃的分片任务并释放取件码 */
export async function cleanupStaleChunks(env: Env): Promise<number> {
  const tasks = await takeStaleChunkTasks(env.DB, CHUNK_STALE_MS);
  for (const task of tasks) {
    try {
      await purgeChunkArtifacts(env, task);
      await releaseCodeIfUnused(env, task.code);
    } catch (e) {
      console.error(JSON.stringify({ event: 'stale_chunk_purge_failed', uploadId: task.uploadId, error: String(e) }));
    }
  }
  return tasks.length;
}

/** Cron：清理无主占用码（删除中途失败的兜底） */
export const cleanupUnusedCodes = (env: Env): Promise<number> => cleanupUsedCodes(env.DB);
