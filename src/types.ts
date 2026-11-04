/** 领域类型。 */

/** fc_files 行 */
export interface FileRecord {
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
}

/** fc_chunk_uploads 行 */
export interface ChunkUploadTask {
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
}

/** Cloudflare Worker 环境绑定 */
export interface Env {
  DB: D1Database;
  FILE_STORE: R2Bucket;
  /** 未配置时拒绝登录（auth.ts 已防御） */
  ADMIN_PASSWORD?: string;
  MAX_FILE_SIZE?: string;
  DEFAULT_EXPIRE_DAYS?: string;
}

/** env + D1 设置合并后的运行配置 */
export interface RuntimeConfig {
  maxSize: number;
  defaultExpireDays: number;
  openUpload: boolean;
}

/** 过期参数（query / form / JSON 三种来源统一形状） */
export interface ExpireInput {
  expire_value?: string | number | null;
  expire_days?: string | number | null;
  expire_style?: string | null;
  max_downloads?: string | number | null;
}
