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
  is_text: number;
  chunk_count: number;
}

/** 分片上传会话 */
export interface ChunkSession {
  upload_id: string;
  chunk_index: number;
  total_chunks: number;
  file_name: string;
  file_size: number;
  chunk_size: number;
  mime_type: string;
  created_at: string;
}

/** Cloudflare Worker 环境绑定 */
export interface Env {
  DB: D1Database;
  FILE_STORE: R2Bucket;
  ADMIN_PASSWORD: string;
  MAX_FILE_SIZE: string;
  DEFAULT_EXPIRE_DAYS: string;
}
