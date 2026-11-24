/** 存储层：全部 R2 读写。不涉及 D1 与 HTTP。 */

import {
  CHUNK_SIZE,
  FILE_PREFIX,
  PayloadTooLargeError,
  chunkKey,
  chunkPrefix,
} from './utils';

export interface MultipartWriter {
  push(chunk: Uint8Array): Promise<void>;
  /** 收尾并返回实际字节数（0 字节走普通 put） */
  finish(): Promise<number>;
  abort(): Promise<void>;
}

interface ObjectMeta {
  contentType: string;
  filename: string;
  maxSize: number;
}

/**
 * R2 multipart 流式写入器（普通上传与分片合并共用）。
 * R2 put 不接受未知长度流，故用 multipart；非尾块必须严格等于 CHUNK_SIZE，
 * 否则 complete 报 10048。内存峰值 = 单块。
 */
export async function createMultipartWriter(
  bucket: R2Bucket,
  key: string,
  meta: ObjectMeta,
): Promise<MultipartWriter> {
  const httpMetadata = { contentType: meta.contentType };
  const customMetadata = { filename: meta.filename };
  const mp = await bucket.createMultipartUpload(key, { httpMetadata, customMetadata });

  let size = 0;
  let partNumber = 1;
  let buf = new Uint8Array(CHUNK_SIZE);
  let bufLen = 0;
  let closed = false;
  const parts: R2UploadedPart[] = [];

  async function flushFullPart() {
    parts.push(await mp.uploadPart(partNumber++, buf));
    buf = new Uint8Array(CHUNK_SIZE);
    bufLen = 0;
  }

  return {
    async push(chunk) {
      if (closed) throw new Error('writer closed');
      size += chunk.byteLength;
      if (size > meta.maxSize) throw new PayloadTooLargeError(meta.maxSize);

      let rest = chunk;
      while (rest.byteLength > 0) {
        const take = Math.min(CHUNK_SIZE - bufLen, rest.byteLength);
        buf.set(rest.subarray(0, take), bufLen);
        bufLen += take;
        if (bufLen === CHUNK_SIZE) await flushFullPart();
        rest = rest.subarray(take);
      }
    },

    async finish() {
      closed = true;
      if (size === 0) {
        // multipart 至少需一个 part；空文件直接 put（长度已知）
        await mp.abort();
        await bucket.put(key, new Uint8Array(0), { httpMetadata, customMetadata });
        return 0;
      }
      if (bufLen > 0) parts.push(await mp.uploadPart(partNumber++, buf.subarray(0, bufLen)));
      await mp.complete(parts);
      return size;
    },

    async abort() {
      closed = true;
      await mp.abort().catch(() => {});
    },
  };
}

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

export async function getObject(bucket: R2Bucket, key: string): Promise<R2ObjectBody | null> {
  return bucket.get(key);
}

export async function getObjectText(bucket: R2Bucket, key: string): Promise<string | null> {
  const obj = await bucket.get(key);
  return obj ? obj.text() : null;
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

// ===================== 分片对象 =====================

/** 写入单个分片（同 index 覆盖，幂等） */
export async function putChunkPart(
  bucket: R2Bucket,
  uploadId: string,
  index: number,
  data: ArrayBuffer,
): Promise<void> {
  await bucket.put(chunkKey(uploadId, index), data, {
    httpMetadata: { contentType: 'application/octet-stream' },
  });
}

export async function getChunkPart(
  bucket: R2Bucket,
  uploadId: string,
  index: number,
): Promise<R2ObjectBody | null> {
  return bucket.get(chunkKey(uploadId, index));
}

/** 已上传的分片序号（升序） */
export async function listChunkParts(
  bucket: R2Bucket,
  uploadId: string,
  totalChunks: number,
): Promise<number[]> {
  const prefix = chunkPrefix(uploadId);
  const listed = await bucket.list({ prefix });
  return listed.objects
    .map((o) => Number(o.key.slice(prefix.length)))
    .filter((n) => Number.isInteger(n) && n >= 0 && n < totalChunks)
    .sort((a, b) => a - b);
}

export async function deleteChunkParts(
  bucket: R2Bucket,
  uploadId: string,
  totalChunks: number,
): Promise<void> {
  await removeObjects(
    bucket,
    Array.from({ length: totalChunks }, (_, i) => chunkKey(uploadId, i)),
  );
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
