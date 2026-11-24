/** 领域类型：数据库行（snake_case，仅 db.ts 内部使用）与领域模型（camelCase，对外统一）。 */

/** fc_files 行 */
export interface FileRow {
  id: number;
  code: string;
  filename: string;
  size: number;
  mime_type: string;
  expire_at: string;
  download_count: number;
  max_downloads: number;
  created_at: string;
  ip: string;
  is_text: number;
  has_thumb: number;
}

/** fc_chunk_uploads 行 */
export interface ChunkTaskRow {
  upload_id: string;
  code: string;
  filename: string;
  size: number;
  total_chunks: number;
  mime_type: string;
  expire_at: string;
  max_downloads: number;
  client_ip: string;
  created_at: string;
  updated_at: string;
  /** 升级前的任务没有 R2 会话句柄 */
  r2_upload_id: string | null;
}

/** fc_chunk_parts 行 */
export interface ChunkPartRow {
  upload_id: string;
  part_index: number;
  etag: string;
}

/** 文件领域模型 */
export interface FileRecord {
  id: number;
  code: string;
  filename: string;
  size: number;
  mimeType: string;
  expireAt: string;
  downloadCount: number;
  maxDownloads: number;
  createdAt: string;
  clientIp: string;
  isText: boolean;
  hasThumb: boolean;
}

/** 分片上传任务领域模型 */
export interface ChunkTask {
  uploadId: string;
  code: string;
  filename: string;
  size: number;
  totalChunks: number;
  mimeType: string;
  expireAt: string;
  maxDownloads: number;
  clientIp: string;
  createdAt: string;
  updatedAt: string;
  /** R2 multipart 会话 id（init 时创建） */
  r2UploadId: string | null;
}

/** 已上传分片的 etag（partIndex 从 0 起，对应 R2 partNumber = partIndex + 1） */
export interface ChunkPart {
  partIndex: number;
  etag: string;
}

/** 新建文件记录的入参 */
export interface NewFile {
  code: string;
  filename: string;
  size: number;
  mimeType: string;
  expireAt: string;
  maxDownloads: number;
  isText?: boolean;
  clientIp?: string;
}

/** Cloudflare Worker 环境绑定 */
export interface Env {
  DB: D1Database;
  FILE_STORE: R2Bucket;
  /** 未配置时回退 D1 密码哈希，两者皆无则拒绝登录 */
  ADMIN_PASSWORD?: string;
  /** Turnstile 站点键（前端渲染）与密钥（服务端校验），两者都配置才可用 */
  /** 孤儿分片会话宽限期（毫秒，默认 6h）；仅用于运维排查 */
  ORPHAN_SESSION_GRACE_MS?: string;
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET?: string;
}

/** env + D1 设置合并后的运行配置 */
export interface RuntimeConfig {
  maxSize: number;
  defaultExpireDays: number;
  openUpload: boolean;
  /** 全站总占用上限（字节，0 = 不限制） */
  maxTotalStorage: number;
  /** 游客上传是否要求 Turnstile（需同时配置站点/密钥） */
  turnstileEnabled: boolean;
}

/** 过期参数（query / form / JSON 统一形状） */
export interface ExpireInput {
  expireValue?: string | number | null;
  expireDays?: string | number | null;
  expireStyle?: string | null;
  maxDownloads?: string | number | null;
}

/** 文件列表筛选 */
export interface FileFilters {
  keyword: string;
  dateFrom: string;
  dateTo: string;
  sort: string;
}

/** 仪表盘统计 */
export interface DashboardStats {
  totalFiles: number;
  totalSize: number;
  todayCount: number;
  todaySize: number;
  yesterdayCount: number;
  yesterdaySize: number;
}
