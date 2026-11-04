/** 存储层：仅 R2 操作。 */

import { CHUNK_SIZE, FILE_PREFIX, SIZE_LIMIT_SIGNAL, chunkKey, chunkPrefix } from './utils';

export interface MultipartWriter {
  push(chunk: Uint8Array): Promise<void>;
  /** 收尾并返回实际字节数（0 字节走普通 put） */
  finish(): Promise<number>;
  abort(): Promise<void>;
}

/**
 * R2 multipart 流式写入器（普通上传与分片合并共用）。
 * R2 put 不接受未知长度流，故用 multipart；非尾块必须严格等于 CHUNK_SIZE，
 * 否则 complete 报 10048。内存峰值 = 单块。
 */
export async function createMultipartWriter(
  bucket: R2Bucket,
  key: string,
  opts: { contentType: string; filename: string; maxSize: number },
): Promise<MultipartWriter> {
  const httpMetadata = { contentType: opts.contentType };
  const customMetadata = { filename: opts.filename };
  const mp = await bucket.createMultipartUpload(key, { httpMetadata, customMetadata });

  let size = 0;
  let partNumber = 1;
  let buf = new Uint8Array(CHUNK_SIZE);
  let bufLen = 0;
  let closed = false;
  const parts: R2UploadedPart[] = [];

  async function flush() {
    parts.push(await mp.uploadPart(partNumber++, buf));
    buf = new Uint8Array(CHUNK_SIZE);
    bufLen = 0;
  }

  return {
    async push(chunk) {
      if (closed) throw new Error('writer closed');
      size += chunk.byteLength;
      if (size > opts.maxSize) throw new Error(SIZE_LIMIT_SIGNAL);

      let rest = chunk;
      while (rest.byteLength > 0) {
        const take = Math.min(CHUNK_SIZE - bufLen, rest.byteLength);
        buf.set(rest.subarray(0, take), bufLen);
        bufLen += take;
        if (bufLen === CHUNK_SIZE) await flush();
        rest = rest.subarray(take);
      }
    },

    async finish() {
      closed = true;
      if (size === 0) {
        // multipart 需至少一个 part，空文件直接 put（长度已知）
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

/** 已上传的分片序号（升序） */
export async function listChunkParts(bucket: R2Bucket, uploadId: string, totalChunks: number): Promise<number[]> {
  const listed = await bucket.list({ prefix: chunkPrefix(uploadId) });
  return listed.objects
    .map((o) => Number(o.key.slice(chunkPrefix(uploadId).length)))
    .filter((n) => Number.isInteger(n) && n >= 0 && n < totalChunks)
    .sort((a, b) => a - b);
}

export async function deleteChunkParts(bucket: R2Bucket, uploadId: string, totalChunks: number): Promise<void> {
  const keys = Array.from({ length: totalChunks }, (_, i) => chunkKey(uploadId, i));
  await bucket.delete(keys);
}

export async function removeObject(bucket: R2Bucket, key: string): Promise<void> {
  await bucket.delete(key).catch(() => {});
}

/** 读取某分片对象，缺失返回 null */
export async function getChunkPart(bucket: R2Bucket, uploadId: string, index: number): Promise<R2ObjectBody | null> {
  return bucket.get(chunkKey(uploadId, index));
}

/** 批量删除对象（1000 键/批，R2 单次上限） */
export async function removeObjects(bucket: R2Bucket, keys: string[]): Promise<void> {
  for (let i = 0; i < keys.length; i += 1000) {
    await bucket.delete(keys.slice(i, i + 1000));
  }
}

/** 列出全部 file:* 对象（cursor 翻页，避免只扫首页漏掉字典序靠后的 key） */
export async function listStoredFiles(bucket: R2Bucket): Promise<R2Object[]> {
  const objects: R2Object[] = [];
  let cursor: string | undefined;
  do {
    const listed = await bucket.list({ prefix: FILE_PREFIX, cursor });
    objects.push(...listed.objects);
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  return objects;
}
