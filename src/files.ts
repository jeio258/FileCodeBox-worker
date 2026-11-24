/**
 * 读取域：取件码 → 文件 + R2 对象（文件下载与文本分享共用同一解析），
 * 以及删除、孤儿对象清理。
 */

import type { Env, FileRecord } from './types';
import { HttpError, MAX_THUMB_BYTES, ORPHAN_GRACE_MS, RATE_WINDOW_MS, fileKey, stripFilePrefix, thumbKey } from './utils';
import {
  checkRateLimit,
  deleteFileRecord,
  findExistingCodes,
  getFileByCode,
  incrementDownload,
  markFileThumb,
} from './db';
import { listFileObjects, putThumbObject, readThumbObject, removeObject, removeObjects } from './storage';

export type ShareLookup =
  | { status: 'ok'; file: FileRecord; obj: R2ObjectBody }
  | { status: 'maxExceeded'; file: FileRecord; obj: R2ObjectBody }
  | { status: 'notFound' };

/**
 * 解析取件码。count=true 且非 HEAD 时递增查看/下载计数（达上限返回 maxExceeded）。
 * textOnly=true 时非文本记录视为不存在（文本接口专用）。
 */
export async function resolveShare(
  env: Env,
  code: string,
  opts: { count: boolean; isHead: boolean; textOnly?: boolean; clientIp?: string },
): Promise<ShareLookup> {
  if (!code) throw new HttpError(422, '缺少取件码');

  const file = await getFileByCode(env.DB, code);
  if (!file) {
    // 失败查询按 IP 限流（5 次/分钟），防 4 位码暴力枚举
    if (opts.clientIp && !(await checkRateLimit(env.DB, 'lookup_ratelimit', opts.clientIp, 5, RATE_WINDOW_MS))) {
      throw new HttpError(429, '查询失败次数过多，请稍后再试');
    }
    return { status: 'notFound' };
  }
  if (opts.textOnly && !file.isText) return { status: 'notFound' };

  const obj = await env.FILE_STORE.get(fileKey(code));
  if (!obj) return { status: 'notFound' };

  if (opts.count && !opts.isHead && !(await incrementDownload(env.DB, code))) {
    return { status: 'maxExceeded', file, obj };
  }
  return { status: 'ok', file, obj };
}

/** 下载响应：RFC 5987 文件名 + 实际长度；HEAD 不带 body */
export function buildDownloadResponse(file: FileRecord, obj: R2ObjectBody, isHead: boolean): Response {
  return new Response(isHead ? null : obj.body, {
    headers: {
      'Content-Type': file.mimeType || 'application/octet-stream',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
      'Content-Length': String(obj.size),
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

/** 删除文件：先删 R2（主对象 + 缩略图）再删 D1，避免孤儿 */
export async function deleteStoredFile(env: Env, file: FileRecord): Promise<void> {
  try {
    await removeObjects(env.FILE_STORE, [fileKey(file.code), thumbKey(file.code)]);
  } finally {
    await deleteFileRecord(env.DB, file.id);
  }
}

/** 保存浏览器端生成的缩略图（每文件仅一次，不可覆盖） */
export async function saveThumb(env: Env, code: string, data: ArrayBuffer): Promise<void> {
  if (!code) throw new HttpError(422, '缺少取件码');
  if (data.byteLength === 0) throw new HttpError(422, '缩略图为空');
  if (data.byteLength > MAX_THUMB_BYTES) throw new HttpError(413, '缩略图过大');

  // 只接受真实 WEBP（浏览器端 canvas 输出）：避免任意字节被当作图片长期托管
  const head = new Uint8Array(data.slice(0, 12));
  const isWebp =
    head.length === 12 &&
    String.fromCharCode(head[0], head[1], head[2], head[3]) === 'RIFF' &&
    String.fromCharCode(head[8], head[9], head[10], head[11]) === 'WEBP';
  if (!isWebp) throw new HttpError(415, '缩略图必须是 WEBP');

  const file = await getFileByCode(env.DB, code);
  if (!file) throw new HttpError(404, '文件不存在或已过期');
  if (file.hasThumb) throw new HttpError(409, '缩略图已存在');

  await putThumbObject(env.FILE_STORE, code, data);
  const ok = await markFileThumb(env.DB, code);
  if (!ok) {
    await removeObject(env.FILE_STORE, thumbKey(code));
    throw new HttpError(409, '缩略图已存在');
  }
}

/** 读取缩略图对象（不存在返回 null） */
export async function readThumb(env: Env, code: string): Promise<R2ObjectBody | null> {
  if (!code) return null;
  return readThumbObject(env.FILE_STORE, code);
}

/**
 * 孤儿对象清理：R2 有、D1 无的 file:* 对象。
 * 宽限期内的对象可能是上传中（先写 R2 后写 D1），过早删除会静默丢数据。
 */
export async function cleanupOrphanObjects(env: Env): Promise<{ scanned: number; removed: number }> {
  const objects = await listFileObjects(env.FILE_STORE);
  if (!objects.length) return { scanned: 0, removed: 0 };

  const existing = await findExistingCodes(env.DB, objects.map((o) => stripFilePrefix(o.key)));
  const now = Date.now();
  const orphans = objects
    .filter((o) => !existing.has(stripFilePrefix(o.key)) && now - o.uploaded.getTime() > ORPHAN_GRACE_MS)
    .map((o) => o.key);

  if (orphans.length) await removeObjects(env.FILE_STORE, orphans);
  return { scanned: objects.length, removed: orphans.length };
}
