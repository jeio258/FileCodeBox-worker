/**
 * 写入域：普通上传、文本分享、分片上传（init/put/status/complete/abort）与超时回收。
 * 三类上传共用：配置 → 门控 → 限流 → 取件码原子抢占 → 失败回滚。
 */

import type { Context } from 'hono';
import type { ChunkTask, Env, RuntimeConfig } from './types';
import { getConfig } from './config';
import { readExpireInput, resolveExpire } from './expire';
import { assertUploadAllowed } from './auth';
import { assertTurnstile } from './turnstile';
import {
  checkRateLimit,
  claimCode,
  cleanupUsedCodes,
  deleteChunkParts,
  deleteChunkTask,
  getChunkTask,
  getFileByCode,
  getStorageUsed,
  insertChunkTask,
  insertFile,
  isCodeReserved,
  isCodeTaken,
  listChunkParts,
  releaseCode,
  saveChunkPart,
  takeStaleChunkTasks,
  touchChunkTask,
} from './db';
import {
  abortMultipartSession,
  completeMultipartSession,
  createMultipartSession,
  getSessionRecord,
  listSessionRecords,
  putObject,
  putSessionRecord,
  removeObject,
  removeSessionRecord,
  uploadMultipartPart,
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
  SESSION_PREFIX,
  isValidCode,
  toInt,
  mbOf,
  sanitizeFilename,
  summarize,
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

/** 全站配额：maxTotalStorage=0 表示不限制 */
async function assertStorageQuota(env: Env, config: RuntimeConfig, incoming: number): Promise<void> {
  if (config.maxTotalStorage <= 0) return;
  const used = await getStorageUsed(env.DB);
  if (used + incoming > config.maxTotalStorage) {
    throw new HttpError(
      507,
      `存储配额不足（已用 ${mbOf(used)}MB / 上限 ${mbOf(config.maxTotalStorage)}MB）`,
    );
  }
}

/** 批量分配连号取件码（多文件上传用），失败回滚已占用 */
export async function allocateCodeRun(env: Env, count: number): Promise<string[]> {
  if (!Number.isInteger(count) || count < 1 || count > 20) {
    throw new HttpError(422, '数量需为 1 到 20 的整数');
  }
  for (let attempt = 0; attempt < 40; attempt++) {
    const start = Math.floor(Math.random() * (10000 - count + 1));
    const codes = Array.from({ length: count }, (_, i) => String(start + i).padStart(4, '0'));
    const claimed: string[] = [];
    let ok = true;
    for (const code of codes) {
      if ((await isCodeTaken(env.DB, code)) || !(await claimCode(env.DB, code))) {
        ok = false;
        break;
      }
      claimed.push(code);
    }
    if (ok) return codes;
    await Promise.all(claimed.map((code) => releaseCode(env.DB, code)));
  }
  throw new HttpError(500, '无法分配足够的连号取件码，请稍后重试');
}

/** 认领批量接口预占的码（已存在于占用表，不再重复抢占） */
async function adoptCode(rawCode: string, env: Env): Promise<string> {
  if (!isValidCode(rawCode)) throw new HttpError(400, '取件码必须为 4 位数字');
  if (!(await isCodeReserved(env.DB, rawCode))) throw new HttpError(409, '取件码未被预占或已失效');
  return rawCode;
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
  if (declared > config.maxSize) throw tooLarge(config.maxSize);

  await assertTurnstile(c, env, config.turnstileEnabled);
  await assertStorageQuota(env, config, declared);

  const requested = (query.code ?? '').trim();
  const code = query.reserved === '1' ? await adoptCode(requested, env) : await allocateCode(requested, env);
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

  const formToken = typeof body['cf-turnstile-response'] === 'string' ? body['cf-turnstile-response'] : undefined;
  await assertTurnstile(c, env, config.turnstileEnabled, formToken);
  await assertStorageQuota(env, config, size);

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
  if (size > config.maxSize) throw tooLarge(config.maxSize);

  const totalChunks = Math.ceil(size / CHUNK_SIZE);
  if (Number(body.total_chunks) !== totalChunks) throw new HttpError(422, `分片数量应为 ${totalChunks}`);

  await assertTurnstile(c, env, config.turnstileEnabled);
  await assertStorageQuota(env, config, size);

  const expire = resolveExpire(readExpireInput(body), config);
  const requested = typeof body.code === 'string' ? body.code.trim() : '';
  const code = body.reserved === true ? await adoptCode(requested, env) : await allocateCode(requested, env);
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
    r2UploadId: null,
  };

  const key = fileKey(code);
  let r2UploadId: string | null = null;
  try {
    r2UploadId = await createMultipartSession(env.FILE_STORE, key, {
      contentType: task.mimeType,
      filename: task.filename,
    });
    // 关键顺序：会话一建好就先在 R2 留登记对象。
    // R2 的 multipart 会话无法被 Worker 枚举，只有登记成普通对象，
    // D1 记录丢了（迁移/重建库/进程被杀）才能靠 list('session:') 找回并 abort。
    await putSessionRecord(env.FILE_STORE, task.uploadId, { r2UploadId, key, code });
    await insertChunkTask(env.DB, { ...task, r2UploadId });
  } catch (e) {
    if (r2UploadId) await abortMultipartSession(env.FILE_STORE, key, r2UploadId).catch(() => {});
    await removeSessionRecord(env.FILE_STORE, task.uploadId).catch(() => {});
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

/** 旧版本建的任务没有 R2 会话句柄，无法续传，按任务不存在处理 */
function requireR2UploadId(task: ChunkTask): string {
  if (!task.r2UploadId) throw new HttpError(404, '上传任务不存在或已过期');
  return task.r2UploadId;
}

const uploadIdOf = (c: Ctx) => (c.req.param('upload_id') ?? '').trim();

export async function chunkPut(c: Ctx, env: Env): Promise<{ ok: true; index: number; }> {
  const task = await requireTask(env, uploadIdOf(c));
  const r2UploadId = requireR2UploadId(task);
  const index = Number(c.req.param('index'));

  if (!Number.isInteger(index) || index < 0 || index >= task.totalChunks) {
    throw new HttpError(422, '无效的分片序号');
  }

  const data = await c.req.arrayBuffer();
  if (data.byteLength === 0) throw new HttpError(422, '分片内容为空');
  if (data.byteLength > CHUNK_SIZE) throw new HttpError(413, `分片超过 ${mbOf(CHUNK_SIZE)}MB`);

  // 同片重传覆盖 etag：R2 只保留最后一次 uploadPart 的结果
  const etag = await uploadMultipartPart(env.FILE_STORE, fileKey(task.code), r2UploadId, index + 1, data);
  await saveChunkPart(env.DB, task.uploadId, index, etag);
  await touchChunkTask(env.DB, task.uploadId);
  return { ok: true, index };
}

export async function chunkStatus(
  c: Ctx,
  env: Env,
): Promise<{ uploadId: string; code: string; totalChunks: number; received: number[]; }> {
  const task = await requireTask(env, uploadIdOf(c));
  const parts = await listChunkParts(env.DB, task.uploadId);
  return {
    uploadId: task.uploadId,
    code: task.code,
    totalChunks: task.totalChunks,
    received: parts.map((p) => p.partIndex).filter((i) => i >= 0 && i < task.totalChunks),
  };
}

export async function chunkComplete(c: Ctx, env: Env): Promise<UploadResult> {
  const task = await requireTask(env, uploadIdOf(c));
  const r2UploadId = requireR2UploadId(task);
  const key = fileKey(task.code);

  const etags = new Map((await listChunkParts(env.DB, task.uploadId)).map((p) => [p.partIndex, p.etag]));
  const parts: R2UploadedPart[] = [];
  for (let i = 0; i < task.totalChunks; i++) {
    const etag = etags.get(i);
    if (!etag) throw new HttpError(409, `缺少第 ${i + 1} 片，请先上传`);
    parts.push({ partNumber: i + 1, etag });
  }

  try {
    const obj = await completeMultipartSession(env.FILE_STORE, key, r2UploadId, parts);
    if (obj.size !== task.size) {
      await removeObject(env.FILE_STORE, key);
      throw new HttpError(409, `分片总大小与声明不一致（${obj.size} ≠ ${task.size}）`);
    }
    await insertFile(env.DB, {
      code: task.code,
      filename: task.filename,
      size: obj.size,
      mimeType: task.mimeType,
      expireAt: task.expireAt,
      maxDownloads: task.maxDownloads,
      clientIp: task.clientIp,
    });

    // 落库已成功：清理失败不影响本次上传结果，仅留待 Cron 兜底
    await removeSessionRecord(env.FILE_STORE, task.uploadId).catch(() => {});
    await dropChunkRecords(env, task).catch((e) =>
      console.error(JSON.stringify({ event: 'chunk_purge_failed', uploadId: task.uploadId, error: String(e) })),
    );
    return { code: task.code, filename: task.filename, size: obj.size };
  } catch (e) {
    // 会话可能已完结（大小不符）或仍开着（complete 失败）：abort 与删除都做一遍，两者均幂等
    await abortMultipartSession(env.FILE_STORE, key, r2UploadId).catch(() => {});
    await removeObject(env.FILE_STORE, key);
    await dropChunkRecords(env, task).catch((err) =>
      console.error(JSON.stringify({ event: 'chunk_purge_failed', uploadId: task.uploadId, error: String(err) })),
    );
    await releaseCodeIfUnused(env, task.code);
    throw e;
  }
}

export async function chunkAbort(c: Ctx, env: Env): Promise<{ ok: true; }> {
  const task = await getChunkTask(env.DB, uploadIdOf(c));
  if (task) {
    await purgeChunkArtifacts(env, task);
    await releaseCodeIfUnused(env, task.code);
  }
  return { ok: true };
}

/** 中断 R2 会话（有句柄才可能）+ 清 D1 分片记录 + 删任务行 */
async function purgeChunkArtifacts(env: Env, task: ChunkTask): Promise<void> {
  if (task.r2UploadId) {
    await abortMultipartSession(env.FILE_STORE, fileKey(task.code), task.r2UploadId).catch((e) =>
      console.error(JSON.stringify({ event: 'chunk_abort_failed', uploadId: task.uploadId, error: String(e) })),
    );
  }
  await removeSessionRecord(env.FILE_STORE, task.uploadId);
  await dropChunkRecords(env, task);
}

/** 只清 D1：分片 etag 与任务行 */
async function dropChunkRecords(env: Env, task: ChunkTask): Promise<void> {
  await deleteChunkParts(env.DB, task.uploadId);
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

/**
 * Cron：回收"R2 有会话、D1 无任务"的孤儿 multipart。
 * 这些是 D1 记录丢失（重建库/迁移/进程被杀）后无法通过任务行找到的会话，
 * 只能靠 R2 里的 session: 登记对象反查；超过宽限期仍未完成的一律 abort。
 */
export async function cleanupOrphanSessions(
  env: Env,
  graceMs = toInt(env.ORPHAN_SESSION_GRACE_MS, CHUNK_STALE_MS),
): Promise<number> {
  const records = await listSessionRecords(env.FILE_STORE);
  if (!records.length) return 0;

  const now = Date.now();
  let aborted = 0;
  for (const obj of records) {
    if (now - obj.uploaded.getTime() < graceMs) continue;

    const uploadId = obj.key.slice(SESSION_PREFIX.length);
    const task = await getChunkTask(env.DB, uploadId).catch(() => null);
    if (task) continue; // 有任务行：交给 cleanupStaleChunks 按 updated_at 处理

    const record = await getSessionRecord(env.FILE_STORE, uploadId);
    if (record?.r2UploadId) {
      await abortMultipartSession(env.FILE_STORE, record.key, record.r2UploadId).catch((e) =>
        console.error(JSON.stringify({ event: 'orphan_session_abort_failed', uploadId, error: String(e) })),
      );
    }
    await removeSessionRecord(env.FILE_STORE, uploadId);
    aborted += 1;
  }
  return aborted;
}

/** Cron：清理无主占用码（删除中途失败的兜底） */
export const cleanupUnusedCodes = (env: Env): Promise<number> => cleanupUsedCodes(env.DB);
