/** 存储层：全部 R2 读写。不涉及 D1 与 HTTP。 */

import { FILE_PREFIX, thumbKey } from './utils';

/** 文本等小对象直接写入 */
export async function putObject(
  bucket: R2Bucket,
  key: string,
  body: string,
  meta: { contentType: string; filename: string },
): Promise<void> {
  await bucket.put(key, body, {
    httpMetadata: { contentType: meta.contentType },
    customMetadata: { filename: meta.filename },
  });
}

export async function putThumbObject(bucket: R2Bucket, code: string, data: ArrayBuffer): Promise<void> {
  await bucket.put(thumbKey(code), data, {
    httpMetadata: { contentType: 'image/webp' },
  });
}

export async function readThumbObject(bucket: R2Bucket, code: string): Promise<R2ObjectBody | null> {
  return bucket.get(thumbKey(code));
}

export async function removeObject(bucket: R2Bucket, key: string): Promise<void> {
  await bucket.delete(key).catch(() => {});
}

/** 批量删除（1000 键/批，R2 单次上限） */
export async function removeObjects(bucket: R2Bucket, keys: string[]): Promise<void> {
  for (let i = 0; i < keys.length; i += 1000) {
    await bucket.delete(keys.slice(i, i + 1000));
  }
}

// ===================== R2 原生 multipart（分片上传直通） =====================
// 每片由调用方单独 uploadPart 进同一会话，etag 存 D1；complete 按 etag 收尾，
// 不再把分片读回 JS 重写。partNumber 从 1 起，非尾片长度必须一致（R2 约束）。

export async function createMultipartSession(
  bucket: R2Bucket,
  key: string,
  meta: { contentType: string; filename: string },
): Promise<string> {
  const mp = await bucket.createMultipartUpload(key, {
    httpMetadata: { contentType: meta.contentType },
    customMetadata: { filename: meta.filename },
  });
  return mp.uploadId;
}

/** 上传单片并返回 etag（complete 必须原样回传） */
export async function uploadMultipartPart(
  bucket: R2Bucket,
  key: string,
  uploadId: string,
  partNumber: number,
  data: ArrayBuffer,
): Promise<string> {
  const part = await bucket.resumeMultipartUpload(key, uploadId).uploadPart(partNumber, data);
  return part.etag;
}

export async function completeMultipartSession(
  bucket: R2Bucket,
  key: string,
  uploadId: string,
  parts: R2UploadedPart[],
): Promise<R2Object> {
  return bucket.resumeMultipartUpload(key, uploadId).complete(parts);
}

/** 中断会话；会话已完结/已中断时 R2 会报错，由调用方决定是否忽略 */
export async function abortMultipartSession(
  bucket: R2Bucket,
  key: string,
  uploadId: string,
): Promise<void> {
  await bucket.resumeMultipartUpload(key, uploadId).abort();
}

// ===================== 列举 =====================

/** 列出全部 file:* 对象（cursor 翻页，避免只扫首页漏掉字典序靠后的 key） */
export async function listFileObjects(bucket: R2Bucket): Promise<R2Object[]> {
  const objects: R2Object[] = [];
  let cursor: string | undefined;
  do {
    const listed = await bucket.list({ prefix: FILE_PREFIX, cursor });
    objects.push(...listed.objects);
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  return objects;
}
