/**
 * 读取域：取件码 → 文件 + R2 对象（文件下载与文本分享共用同一解析），
 * 以及删除、孤儿对象清理。
 */

import type { Env, FileRecord } from './types';
import { HttpError, ORPHAN_GRACE_MS, RATE_WINDOW_MS, fileKey, stripFilePrefix } from './utils';
import { checkRateLimit, deleteFileRecord, findExistingCodes, getFileByCode, incrementDownload } from './db';
import { listFileObjects, removeObject, removeObjects } from './storage';

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

/** 删除文件：先删 R2 再删 D1（finally 保证记录清理），避免产生孤儿对象 */
export async function deleteStoredFile(env: Env, file: FileRecord): Promise<void> {
  try {
    await removeObject(env.FILE_STORE, fileKey(file.code));
  } finally {
    await deleteFileRecord(env.DB, file.id);
  }
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
