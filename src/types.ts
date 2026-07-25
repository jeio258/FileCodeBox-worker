/** 文件记录类型 */
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
}

/** Cloudflare Worker 环境绑定 */
export interface Env {
  DB: D1Database;
  FILE_STORE: KVNamespace;
  ADMIN_PASSWORD: string;
  MAX_FILE_SIZE: string;
  DEFAULT_EXPIRE_DAYS: string;
}

/** KV 中存储的文件元数据 */
export interface FileMeta {
  filename: string;
  mimeType: string;
  size: number;
}
