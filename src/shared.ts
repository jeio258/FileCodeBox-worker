/**
 * 共享业务逻辑：供 src/index.ts 和 src/api.ts 共同使用，
 * 避免两套路由体系维护同一份上传/下载/过期处理代码。
 */
import type { Context } from 'hono';
import type { Env } from './types';
import type { FileRecord } from './types';
import { isValidCode, generateCode, getClientIp } from './utils';
import {
  getFileByCode,
  isCodeTaken,
  insertFile,
  incrementDownload,
  markCodeUsed,
  releaseCode,
} from './db';

// ===================== 过期策略 =====================

export function parseExpire(
  expireValue: number,
  expireStyle: string,
): { expireAt: string; maxDownloads: number } {
  const now = Date.now();
  switch (expireStyle) {
    case 'hour':
      return { expireAt: new Date(now + expireValue * 3_600_000).toISOString(), maxDownloads: -1 };
    case 'minute':
      return { expireAt: new Date(now + expireValue * 60_000).toISOString(), maxDownloads: -1 };
    case 'count':
      // expireValue 为用户设置的最大下载次数；expireAt 用默认天数计算，maxDownloads 由调用方覆盖
      return { expireAt: new Date(now + expireValue * 86_400_000).toISOString(), maxDownloads: -1 };
    case 'forever':
      return { expireAt: new Date(now + 100 * 365 * 86_400_000).toISOString(), maxDownloads: -1 };
    case 'day':
    default:
      return { expireAt: new Date(now + expireValue * 86_400_000).toISOString(), maxDownloads: -1 };
  }
}

// ===================== 取件码生成 =====================

async function generateUniqueCode(env: Env): Promise<string> {
  for (let i = 0; i < 10; i++) {
    const code = generateCode();
    if (!await isCodeTaken(env.DB, code)) return code;
  }
  throw new Error('无法生成唯一取件码');
}

/**
 * 校验自定义取件码格式，检查占用状态，占位后返回码。
 * rawCode 为空时自动调用 generateUniqueCode 生成。
 */
async function ensureCodeAvailable(
  rawCode: string,
  env: Env,
): Promise<string> {
  const code = rawCode || (await generateUniqueCode(env));
  if (rawCode && !isValidCode(rawCode)) {
    throw { status: 400 as const, message: '取件码必须为 4 位数字' };
  }
  if (await isCodeTaken(env.DB, code)) {
    throw { status: 409 as const, message: '取件码已被占用' };
  }
  await markCodeUsed(env.DB, code);
  return code;
}

// ===================== 文件上传 =====================

/** 共享的文件上传核心逻辑（流式写入 R2，流式计算实际大小） */
export async function uploadFile(c: Context<{ Bindings: Env }>, env: Env): Promise<{
  code: string;
  filename: string;
  size: number;
}> {
  const rawCode = (c.req.query('code') || '').trim();
  const maxDownloads = parseInt(c.req.query('max_downloads') || '-1');
  const expireDays = parseInt(c.req.query('expire_days') || env.DEFAULT_EXPIRE_DAYS || '7');
  const filename = decodeURIComponent(c.req.header('X-Filename') || '未命名');
  const mimeType = c.req.header('Content-Type') || 'application/octet-stream';

  const maxSize = parseInt(env.MAX_FILE_SIZE || '104857600');

  // 流式读取 body 并计数，达到限制时 abort，避免 arrayBuffer() 整文件驻留内存
  let size = 0;
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const reader = (c.req.raw.body as ReadableStream<Uint8Array>).getReader();

  const drainPromise = reader.read().then(async function pump({ done, value }): Promise<void> {
    if (done) return;
    size += value.byteLength;
    if (size > maxSize) { writer.abort(new Error('overflow')); return; }
    return writer.write(value).then(() => reader.read().then(pump));
  });

  try {
    await Promise.all([
      drainPromise,
      readable.pipeTo(writable),
    ]);
  } catch (e) {
    if (e instanceof Error && e.message === 'overflow') {
      throw { status: 400 as const, message: `文件过大，最大 ${Math.floor(maxSize / 1048576)}MB` };
    }
    throw e;
  }

  const code = await ensureCodeAvailable(rawCode, env);

  const { expireAt } = parseExpire(expireDays, 'day');
  // 用户指定的 max_downloads 优先于 parseExpire 的默认值 -1
  const effectiveMaxDownloads = maxDownloads >= 0 ? maxDownloads : -1;

  try {
    await env.FILE_STORE.put(`file:${code}`, readable, {
      httpMetadata: { contentType: mimeType },
      customMetadata: { filename, size: String(size) },
    });
    await insertFile(env.DB, {
      code, filename, size, mimeType, expireAt, maxDownloads: effectiveMaxDownloads, clientIp: getClientIp(c.req.raw.headers),
    });
    return { code, filename, size };
  } catch (e) {
    await releaseCode(env.DB, code);  // 写入失败则释放码
    throw e;
  }
}

// ===================== 文件下载 =====================

export interface DownloadResult {
  file: FileRecord;
  obj: R2ObjectBody | null;
  notFound: boolean;
  maxExceeded: boolean;
  isHead: boolean;
}

export async function downloadFile(
  c: Context<{ Bindings: Env }>,
  env: Env,
): Promise<DownloadResult> {
  const code = (c.req.query('code') || c.req.param('code') || '').trim();
  if (!code) throw { status: 422 as const, message: '缺少取件码' };

  const file = await getFileByCode(env.DB, code);
  if (!file) return { file: null as any, obj: null, notFound: true, maxExceeded: false, isHead: false };

  const obj = await env.FILE_STORE.get(`file:${code}`);
  if (!obj) return { file, obj: null, notFound: true, maxExceeded: false, isHead: false };

  const isHead = c.req.method === 'HEAD';
  if (!isHead) {
    const ok = await incrementDownload(env.DB, code);
    if (!ok) return { file, obj, notFound: false, maxExceeded: true, isHead: false };
  }

  return { file, obj, notFound: false, maxExceeded: false, isHead };
}

// ===================== 文本分享 =====================

/** 共享的文本上传核心逻辑 */
export async function uploadText(
  c: Context<{ Bindings: Env }>,
  env: Env,
): Promise<{ code: string; title: string; textSize: number }> {
  const body = await c.req.parseBody();
  const text = ((body['text'] as string) || '').trim();
  if (!text) throw { status: 422 as const, message: '文本内容不能为空' };

  const textSize = new TextEncoder().encode(text).length;
  if (textSize > 512 * 1024) throw { status: 400 as const, message: '文本过长，最大支持 512KB' };

  const rawCode = ((body['code'] as string) || '').trim();
  const maxDownloads = parseInt((body['max_downloads'] as string) || '-1');
  const expireDays = parseInt((body['expire_days'] as string) || env.DEFAULT_EXPIRE_DAYS || '7');

  const code = await ensureCodeAvailable(rawCode, env);

  const { expireAt } = parseExpire(expireDays, 'day');
  const effectiveMaxDownloads = maxDownloads >= 0 ? maxDownloads : -1;
  const title = text.replace(/\s+/g, ' ').slice(0, 50) + (text.length > 50 ? '…' : '');

  try {
    await env.FILE_STORE.put(`file:${code}`, text, {
      httpMetadata: { contentType: 'text/plain' },
      customMetadata: { filename: title, size: String(textSize) },
    });
    await insertFile(env.DB, {
      code, filename: title, size: textSize, mimeType: 'text/plain', expireAt, maxDownloads: effectiveMaxDownloads, isText: 1, clientIp: getClientIp(c.req.raw.headers),
    });
    return { code, title, textSize };
  } catch (e) {
    await releaseCode(env.DB, code);  // 写入失败则释放码
    throw e;
  }
}

// ===================== 文件信息获取 =====================

export interface SelectResult {
  file: FileRecord | null;
  notFound: boolean;
  maxExceeded: boolean;
  text?: string;
}

export async function selectFile(
  c: Context<{ Bindings: Env }>,
  env: Env,
  countAsDownload: boolean,
): Promise<SelectResult> {
  const code = (c.req.query('code') || '').trim();
  if (!code) throw { status: 422 as const, message: '缺少取件码' };

  const file = await getFileByCode(env.DB, code);
  if (!file) return { file: null, notFound: true, maxExceeded: false };

  if (countAsDownload) {
    const incremented = await incrementDownload(env.DB, code);
    if (!incremented) return { file, notFound: false, maxExceeded: true };
  }

  let text: string | undefined;
  if (file.is_text === 1) {
    const obj = await env.FILE_STORE.get(`file:${code}`);
    text = obj ? await obj.text() : '';
  }

  return { file, notFound: false, maxExceeded: false, text };
}
