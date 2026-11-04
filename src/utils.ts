/** 纯工具函数、共享常量与 HTTP 错误类型。不依赖 D1/R2。 */

// ===================== 常量 =====================

/** R2 multipart 单块大小；非尾块必须严格等长（R2 约束），内存峰值即此值 */
export const CHUNK_SIZE = 30 * 1024 * 1024;
/** 免费计划单请求体上限 100MB；超过需走分片上传 */
export const PLAIN_UPLOAD_LIMIT = 100 * 1024 * 1024;
export const DEFAULT_MAX_SIZE = 300 * 1024 * 1024;
export const DEFAULT_EXPIRE_DAYS = 7;
export const MAX_TEXT_BYTES = 512 * 1024;

export const RATE_WINDOW_MS = 60_000;
export const UPLOAD_RATE_MAX = 10;
export const LOGIN_RATE_MAX = 5;

/** 分片任务无活动多久后回收（put 会刷新活跃时间） */
export const CHUNK_STALE_MS = 6 * 3_600_000;
/** 孤儿 R2 对象宽限期：上传先写 R2 后写 D1，过早清理会丢数据 */
export const ORPHAN_GRACE_MS = 3_600_000;

export const FILE_PREFIX = 'file:';
export const fileKey = (code: string) => `${FILE_PREFIX}${code}`;
export const chunkKey = (uploadId: string, index: number) => `chunk:${uploadId}:${index}`;
export const chunkPrefix = (uploadId: string) => `chunk:${uploadId}:`;

// ===================== HTTP 错误 =====================

/** 业务错误：路由层统一转为对应状态码 */
export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export const statusOf = (e: unknown, fallback = 500): number =>
  e instanceof HttpError ? e.status : fallback;

export const messageOf = (e: unknown, fallback: string): string =>
  e instanceof Error && e.message ? e.message : fallback;

/** 超限错误统一文案（各处上限不同，避免重复拼接） */
export const tooLarge = (maxSize: number) =>
  new HttpError(413, `文件过大，最大 ${Math.floor(maxSize / 1024 / 1024)}MB`);

/** multipart 写入器超限信号，由调用方转成 tooLarge */
export const SIZE_LIMIT_SIGNAL = 'SIZE_LIMIT_EXCEEDED';

// ===================== 取件码 =====================

/** 生成 4 位纯数字取件码（拒绝采样，无模偏差） */
export function generateCode(): string {
  const bytes = new Uint8Array(1);
  let code = '';
  while (code.length < 4) {
    crypto.getRandomValues(bytes);
    // 拒绝 250-255，使每个数字等概率（250/10 = 25 个取值）
    if (bytes[0] < 250) code += (bytes[0] % 10).toString();
  }
  return code;
}

export const isValidCode = (code: string): boolean => /^\d{4}$/.test(code);

// ===================== 文本 =====================

/** HTML 转义（含单引号），用于所有插入模板的用户数据 */
export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 文件名规范化：解码（容忍非法 URI 编码）→ 去控制字符 → 截断 */
export function sanitizeFilename(raw: string | undefined, fallback = '未命名'): string {
  let name = raw ?? fallback;
  try {
    name = decodeURIComponent(name);
  } catch {
    /* 保留原始值 */
  }
  // 去控制字符与路径分隔符，避免响应头/展示异常
  name = name.replace(/[\u0000-\u001f\u007f/\\]/g, '').trim().slice(0, 200);
  return name || fallback;
}

/** 格式化文件大小 */
export function formatFileSize(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

// ===================== 请求信息 =====================

/** 客户端真实 IP（优先 CF-Connecting-IP，回退代理头） */
export function getClientIp(headers: Headers): string {
  return (
    headers.get('cf-connecting-ip') ??
    headers.get('x-real-ip') ??
    headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    ''
  );
}

/**
 * 站点根 URL。仅接受合法主机名（拒绝 IP 与异常值），防止 Host 头注入造成开放重定向；
 * 不合法时回退到请求 URL 的 origin。
 */
export function getBaseUrl(origin: string, host: string | undefined): string {
  const valid = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9](\.[a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9])*$/;
  if (!host || !valid.test(host)) return origin;
  return `${host.startsWith('localhost') ? 'http' : 'https'}://${host}`;
}

// ===================== 密码 =====================

const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_SALT = new TextEncoder().encode('filecodebox-admin-v1');

/** PBKDF2-SHA256 哈希（固定盐 + 10 万次迭代，抗暴力破解） */
export async function hashPassword(pwd: string): Promise<string> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(pwd),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: PBKDF2_SALT, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    256,
  );
  return Array.from(new Uint8Array(bits))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** 常数时间字符串比较，防时序攻击（workers-types 未声明 timingSafeEqual） */
export function timingSafeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const encoder = new TextEncoder();
  const ab = encoder.encode(a);
  const bb = encoder.encode(b);
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}
