import type { FileRecord, ChunkSession } from './types';

/** 初始化数据库表（幂等，可多次调用） */
export async function initDB(db: D1Database): Promise<void> {
  const stmts = [
    `CREATE TABLE IF NOT EXISTS fc_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE NOT NULL,
      filename TEXT NOT NULL,
      size INTEGER NOT NULL DEFAULT 0,
      mime_type TEXT DEFAULT 'application/octet-stream',
      expire_at TEXT NOT NULL,
      download_count INTEGER DEFAULT 0,
      max_downloads INTEGER DEFAULT -1,
      created_at TEXT NOT NULL,
      ip TEXT DEFAULT ''
    )`,
    'CREATE INDEX IF NOT EXISTS idx_fc_code ON fc_files(code)',
    'CREATE INDEX IF NOT EXISTS idx_fc_expire ON fc_files(expire_at)',
    `CREATE TABLE IF NOT EXISTS fc_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS fc_chunks (
      upload_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      total_chunks INTEGER NOT NULL,
      file_name TEXT NOT NULL,
      file_size INTEGER NOT NULL,
      chunk_size INTEGER NOT NULL,
      mime_type TEXT DEFAULT 'application/octet-stream',
      created_at TEXT NOT NULL,
      PRIMARY KEY (upload_id, chunk_index)
    )`,
    "INSERT OR IGNORE INTO fc_settings(key, value) VALUES('admin_password', 'admin123')",
  ];
  const migrations = [
    'ALTER TABLE fc_files ADD COLUMN is_text INTEGER DEFAULT 0',
    'ALTER TABLE fc_files ADD COLUMN chunk_count INTEGER DEFAULT 0',
  ];
  for (const s of stmts) {
    try { await db.prepare(s).run(); } catch { /* ignore */ }
  }
  for (const m of migrations) {
    try { await db.prepare(m).run(); } catch { /* column already exists — ok */ }
  }
}

// ---- 文件查询 ----

export async function getFileByCode(
  db: D1Database,
  code: string,
): Promise<FileRecord | null> {
  return db
    .prepare("SELECT * FROM fc_files WHERE code = ? AND expire_at > datetime('now')")
    .bind(code)
    .first<FileRecord>();
}

export async function getFileById(
  db: D1Database,
  id: number,
): Promise<FileRecord | null> {
  return db.prepare('SELECT * FROM fc_files WHERE id = ?').bind(id).first<FileRecord>();
}

export async function isCodeTaken(db: D1Database, code: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT id FROM fc_files WHERE code = ? AND expire_at > datetime('now')")
    .bind(code)
    .first();
  return row !== null;
}

// ---- 插入 ----

export async function insertFile(
  db: D1Database,
  file: {
    code: string;
    filename: string;
    size: number;
    mimeType: string;
    expireAt: string;
    maxDownloads: number;
    isText?: number;
    chunkCount?: number;
  },
): Promise<void> {
  await db
    .prepare(
      'INSERT INTO fc_files(code, filename, size, mime_type, expire_at, max_downloads, created_at, is_text, chunk_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(
      file.code,
      file.filename,
      file.size,
      file.mimeType,
      file.expireAt,
      file.maxDownloads,
      new Date().toISOString(),
      file.isText ?? 0,
      file.chunkCount ?? 0,
    )
    .run();
}

// ---- 下载计数 ----

export async function incrementDownload(
  db: D1Database,
  code: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE fc_files SET download_count = download_count + 1
       WHERE code = ? AND (max_downloads < 0 OR download_count < max_downloads)`,
    )
    .bind(code)
    .run();
  return result.meta.changes > 0;
}

// ---- 删除 ----

export async function deleteFileRecord(
  db: D1Database,
  id: number,
): Promise<FileRecord | null> {
  const file = await getFileById(db, id);
  if (file) {
    await db.prepare('DELETE FROM fc_files WHERE id = ?').bind(id).run();
  }
  return file;
}

// ---- 分页 ----

const PAGE_SIZE = 50;

export async function listFiles(
  db: D1Database,
  page: number,
): Promise<{ files: FileRecord[]; total: number }> {
  const offset = (page - 1) * PAGE_SIZE;
  const [rows, countRow] = await Promise.all([
    db
      .prepare('SELECT * FROM fc_files ORDER BY id DESC LIMIT ? OFFSET ?')
      .bind(PAGE_SIZE, offset)
      .all<FileRecord>(),
    db.prepare('SELECT COUNT(*) as count FROM fc_files').first<{ count: number }>(),
  ]);
  return { files: rows.results ?? [], total: countRow?.count ?? 0 };
}

// ---- 过期清理 ----

export async function cleanupExpired(
  db: D1Database,
  bucket: R2Bucket,
): Promise<number> {
  const expired = await db
    .prepare("SELECT * FROM fc_files WHERE expire_at <= datetime('now')")
    .all<FileRecord>();
  const files = expired.results ?? [];
  for (const f of files) {
    if (f.chunk_count > 0) {
      for (let i = 0; i < f.chunk_count; i++) {
        await bucket.delete(`file:${f.code}:${i}`);
      }
    } else {
      await bucket.delete(`file:${f.code}`);
    }
  }
  if (files.length > 0) {
    await db.prepare("DELETE FROM fc_files WHERE expire_at <= datetime('now')").run();
  }
  // 同时清理超过 1 天的废弃分片会话
  await db.prepare("DELETE FROM fc_chunks WHERE created_at <= datetime('now', '-1 day')").run();
  // 清理孤儿分片临时对象（上传中断遗留在 R2 中的 chunk:* 对象）
  const cutoff = Date.now() - 24 * 3600 * 1000;
  const chunkList = await bucket.list({ prefix: 'chunk:' });
  for (const obj of chunkList.objects) {
    if (obj.uploaded.getTime() < cutoff) {
      await bucket.delete(obj.key);
    }
  }
  return files.length;
}

// ---- 分片上传 ----

export async function initChunkSession(
  db: D1Database,
  params: {
    fileName: string;
    fileSize: number;
    chunkSize: number;
    mimeType: string;
  },
): Promise<string> {
  const uploadId = crypto.randomUUID();
  const totalChunks = Math.ceil(params.fileSize / params.chunkSize);
  await db
    .prepare(
      'INSERT INTO fc_chunks(upload_id, chunk_index, total_chunks, file_name, file_size, chunk_size, mime_type, created_at) VALUES (?, -1, ?, ?, ?, ?, ?, ?)',
    )
    .bind(uploadId, totalChunks, params.fileName, params.fileSize, params.chunkSize, params.mimeType, new Date().toISOString())
    .run();
  return uploadId;
}

export async function getChunkSession(
  db: D1Database,
  uploadId: string,
): Promise<ChunkSession | null> {
  return db
    .prepare('SELECT * FROM fc_chunks WHERE upload_id = ? AND chunk_index = -1')
    .bind(uploadId)
    .first<ChunkSession>();
}

export async function saveChunk(
  db: D1Database,
  session: ChunkSession,
  index: number,
): Promise<void> {
  await db
    .prepare(
      'INSERT OR REPLACE INTO fc_chunks(upload_id, chunk_index, total_chunks, file_name, file_size, chunk_size, mime_type, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(session.upload_id, index, session.total_chunks, session.file_name, session.file_size, session.chunk_size, session.mime_type, new Date().toISOString())
    .run();
}

export async function countUploadedChunks(
  db: D1Database,
  uploadId: string,
): Promise<number> {
  const row = await db
    .prepare('SELECT COUNT(*) as count FROM fc_chunks WHERE upload_id = ? AND chunk_index >= 0')
    .bind(uploadId)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

export async function deleteChunkSession(
  db: D1Database,
  uploadId: string,
): Promise<void> {
  await db.prepare('DELETE FROM fc_chunks WHERE upload_id = ?').bind(uploadId).run();
}

// ---- 设置 ----

export async function getSetting(
  db: D1Database,
  key: string,
): Promise<string | null> {
  const row = await db
    .prepare('SELECT value FROM fc_settings WHERE key = ?')
    .bind(key)
    .first<{ value: string }>();
  return row?.value ?? null;
}

export async function setSetting(
  db: D1Database,
  key: string,
  value: string,
): Promise<void> {
  await db
    .prepare('INSERT OR REPLACE INTO fc_settings(key, value) VALUES(?, ?)')
    .bind(key, value)
    .run();
}
