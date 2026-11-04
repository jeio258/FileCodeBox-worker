/** 文件读取/删除：解析取件码、计数、构造下载响应。 */

import type { Env, FileRecord } from './types';
import { HttpError, ORPHAN_GRACE_MS, fileKey } from './utils';
import { deleteFileRecord, findActiveCodes, getFileByCode, incrementDownload, stripFilePrefix } from './db';
import { listStoredFiles, removeObject, removeObjects } from './storage';

export type FileLookup =
  | { status: 'ok'; file: FileRecord; obj: R2ObjectBody }
  | { status: 'maxExceeded'; file: FileRecord; obj: R2ObjectBody }
  | { status: 'notFound' };

/**
 * 取件码 → 文件 + R2 对象。count=true 且非 HEAD 时递增下载计数（达上限返回 maxExceeded）。
 * 缺少取件码抛 422，由路由层转换。
 */
export async function lookupFile(
  env: Env,
  code: string,
  opts: { count: boolean; isHead: boolean },
): Promise<FileLookup> {
  if (!code) throw new HttpError(422, '缺少取件码');

  const file = await getFileByCode(env.DB, code);
  if (!file) return { status: 'notFound' };

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
      'Content-Type': file.mime_type || 'application/octet-stream',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
      'Content-Length': String(obj.size),
    },
  });
}

export type TextLookup =
  | { status: 'ok'; file: FileRecord; text: string }
  | { status: 'maxExceeded'; file: FileRecord }
  | { status: 'notFound' };

/** 读取文本分享内容（查看计数与下载计数共用 incrementDownload） */
export async function lookupText(
  env: Env,
  code: string,
  opts: { count: boolean; isHead: boolean },
): Promise<TextLookup> {
  if (!code) throw new HttpError(422, '缺少取件码');

  const file = await getFileByCode(env.DB, code);
  if (!file || file.is_text !== 1) return { status: 'notFound' };

  if (opts.count && !opts.isHead && !(await incrementDownload(env.DB, code))) {
    return { status: 'maxExceeded', file };
  }

  const obj = await env.FILE_STORE.get(fileKey(code));
  if (!obj) return { status: 'notFound' };
  return { status: 'ok', file, text: await obj.text() };
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
  const objects = await listStoredFiles(env.FILE_STORE);
  if (!objects.length) return { scanned: 0, removed: 0 };

  const active = await findActiveCodes(env.DB, objects.map((o) => stripFilePrefix(o.key)));
  const now = Date.now();
  const orphans = objects
    .filter((o) => !active.has(stripFilePrefix(o.key)) && now - o.uploaded.getTime() > ORPHAN_GRACE_MS)
    .map((o) => o.key);

  if (orphans.length) await removeObjects(env.FILE_STORE, orphans);
  return { scanned: objects.length, removed: orphans.length };
}
