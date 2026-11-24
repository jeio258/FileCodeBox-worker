/**
 * 基础设施层：常量、错误类型、纯函数工具。不依赖 D1/R2/Hono。
 */

// ===================== 常量 =====================

/** R2 multipart 单块大小；非尾块必须严格等长（R2 约束），内存峰值即此值 */
export const CHUNK_SIZE = 30 * 1024 * 1024;
/** 免费计划单请求体上限 100MB；超过需走分片上传 */
export const PLAIN_UPLOAD_LIMIT = 100 * 1024 * 1024;
export const DEFAULT_MAX_SIZE = 300 * 1024 * 1024;
export const DEFAULT_EXPIRE_DAYS = 7;
export const MAX_TEXT_BYTES = 512 * 1024;
/** 缩略图上限：浏览器端生成的 webp，不大于 128KB */
export const MAX_THUMB_BYTES = 128 * 1024;
/** 配置项硬上限，防误配 */
export const MAX_CONFIG_SIZE = 1024 * 1024 * 1024;
export const MAX_CONFIG_EXPIRE_DAYS = 3650;

export const RATE_WINDOW_MS = 60_000;

/**
 * 限流策略表：桶名、窗口内上限、超限文案集中在此。
 * 新增受保护动作只在这里加一行，避免桶名与文案散落在各路由。
 */
export const RATE_LIMITS = {
  upload: { bucket: 'upload_ratelimit', max: 10, message: '上传过于频繁，请稍后再试' },
  login: { bucket: 'login_ratelimit', max: 5, message: '尝试次数过多，请稍后再试' },
  /** 失败取件码查询：防 4 位码暴力枚举 */
  lookup: { bucket: 'lookup_ratelimit', max: 5, message: '查询失败次数过多，请稍后再试' },
  /** 批量分配取件码：码只有 1 万个，必须比上传更紧 */
  codes: { bucket: 'codes_ratelimit', max: 3, message: '申请取件码过于频繁，请稍后再试' },
} as const;

export type RateKind = keyof typeof RATE_LIMITS;

/** 对外错误文案的唯一来源，避免同一句话在多个文件里各写一遍 */
export const MESSAGES = {
  codeFormat: '取件码必须为 4 位数字',
  codeTaken: '取件码已被占用',
  codeNotReserved: '取件码未被预占或已失效',
  codeGenerateFailed: '无法生成唯一取件码',
  missingCode: '缺少取件码',
  chunkMissing: '上传任务不存在或已过期',
  chunkIndexInvalid: '无效的分片序号',
  chunkEmpty: '分片内容为空',
  chunkTooLarge: `分片超过 ${Math.floor(CHUNK_SIZE / 1024 / 1024)}MB`,
  chunkPartMissing: (n: number) => `缺少第 ${n} 片，请先上传`,
  chunkSizeMismatch: (got: number, want: number) => `分片总大小与声明不一致（${got} ≠ ${want}）`,
  turnstileRequired: '请先完成人机校验',
  turnstileFailed: '人机校验未通过，请重试',
  uploadDisabled: '游客上传已关闭，请先登录',
  internal: '服务器内部错误',
} as const;

/** 分片任务无活动多久后回收（put 会刷新活跃时间） */
export const CHUNK_STALE_MS = 6 * 3_600_000;
/** 孤儿 R2 对象宽限期：上传先写 R2 后写 D1，过早清理会丢数据 */
export const ORPHAN_GRACE_MS = 3_600_000;

export const ADMIN_TOKEN_KEY = 'admin_token';
export const ADMIN_TOKEN_MAX_AGE = 86_400;
export const ADMIN_MIN_PASSWORD_LEN = 6;

// ===================== R2 key =====================

export const FILE_PREFIX = 'file:';
export const fileKey = (code: string) => `${FILE_PREFIX}${code}`;
export const stripFilePrefix = (key: string) => key.slice(FILE_PREFIX.length);
export const thumbKey = (code: string) => `thumb:${code}`;

/**
 * 分片会话登记对象：`session:{uploadId}` → JSON { r2UploadId, key, code }。
 * R2 的 multipart 会话无法被 Worker 枚举，只有把它登记成一个普通对象，
 * 才能靠 list() 在 D1 记录丢失时仍找回并 abort —— 这是自愈的关键。
 */
export const SESSION_PREFIX = 'session:';
export const sessionKey = (uploadId: string) => `${SESSION_PREFIX}${uploadId}`;

// ===================== 错误 =====================

/** 业务错误：路由层据此决定对外状态码与文案 */
export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export const isHttpError = (e: unknown): e is HttpError => e instanceof HttpError;

export const statusOf = (e: unknown, fallback = 500): number => (isHttpError(e) ? e.status : fallback);

/** 仅业务错误可对外暴露文案；未知异常一律用兜底文案 */
export const publicMessage = (e: unknown, fallback: string): string => {
  if (isHttpError(e)) return e.message;
  console.error(JSON.stringify({ event: 'unexpected_error', error: String(e) }));
  return fallback;
};

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

/** 文件名规范化：解码（容忍非法编码）→ 去控制字符与路径分隔符 → 截断 */
export function sanitizeFilename(raw: string | undefined, fallback = '未命名'): string {
  let name = raw ?? fallback;
  try {
    name = decodeURIComponent(name);
  } catch {
    /* 保留原始值 */
  }
  name = name.replace(/[\u0000-\u001f\u007f/\\]/g, '').trim().slice(0, 200);
  return name || fallback;
}

/** 文本摘要：折叠空白后截断，用作文本分享的展示标题 */
export function summarize(text: string, limit = 50): string {
  const flat = text.replace(/\s+/g, ' ');
  return flat.slice(0, limit) + (flat.length > limit ? '…' : '');
}

/** 格式化文件大小 */
export function formatFileSize(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

/** 字节数 → MB 整数（错误文案用） */
export const mbOf = (bytes: number) => Math.floor(bytes / 1024 / 1024);

/** 超限错误的唯一构造处，避免同一文案散落在各上传路径 */
export const tooLarge = (maxSize: number) =>
  new HttpError(413, `文件过大，最大 ${mbOf(maxSize)}MB`);

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

const HOSTNAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9](\.[a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9])*$/;

/**
 * 站点根 URL。仅接受合法主机名（拒绝 IP 与异常值），防止 Host 头注入造成开放重定向；
 * 不合法时回退到请求 origin。
 */
export function getBaseUrl(origin: string, host: string | undefined): string {
  if (!host || !HOSTNAME_RE.test(host)) return origin;
  return `${host.startsWith('localhost') ? 'http' : 'https'}://${host}`;
}

// ===================== 密码 =====================

const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_SALT = new TextEncoder().encode('filecodebox-admin-v1');

/** PBKDF2-SHA256 哈希（固定盐 + 10 万次迭代，抗暴力破解） */
export async function hashPassword(pwd: string): Promise<string> {
  const keyMaterial = await crypto.subtle.importKey('raw', new TextEncoder().encode(pwd), 'PBKDF2', false, [
    'deriveBits',
  ]);
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

// ===================== 数值解析 =====================

export const toInt = (v: unknown, fallback: number): number => {
  const n = typeof v === 'number' ? v : parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? n : fallback;
};

/** 正整数并夹取上限，非法值回落默认 */
export const toBoundedInt = (v: unknown, fallback: number, max: number): number => {
  const n = toInt(v, fallback);
  if (n < 1) return fallback;
  return Math.min(n, max);
};
