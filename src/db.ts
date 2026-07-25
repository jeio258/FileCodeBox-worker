import type { FileRecord } from './types';

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
  ];
  for (const s of stmts) {
    await db.prepare(s).run();
  }
}

// ---- 文件查询 ----

/** 按取件码查询有效文件 */
export async function getFileByCode(
  db: D1Database,
  code: string,
): Promise<FileRecord | null> {
  return db
    .prepare("SELECT * FROM fc_files WHERE code = ? AND expire_at > datetime('now')")
    .bind(code)
    .first<FileRecord>();
}

/** 按 ID 查询文件（不限过期） */
export async function getFileById(
  db: D1Database,
  id: number,
): Promise<FileRecord | null> {
  return db.prepare('SELECT * FROM fc_files WHERE id = ?').bind(id).first<FileRecord>();
}

/** 检查取件码是否已被占用 */
export async function isCodeTaken(
  db: D1Database,
  code: string,
): Promise<boolean> {
  const row = await db
    .prepare("SELECT id FROM fc_files WHERE code = ? AND expire_at > datetime('now')")
    .bind(code)
    .first();
  return row !== null;
}

/** 插入文件记录 */
export async function insertFile(
  db: D1Database,
  file: {
    code: string;
    filename: string;
    size: number;
    mimeType: string;
    expireAt: string;
    maxDownloads: number;
  },
): Promise<void> {
  await db
    .prepare(
      'INSERT INTO fc_files(code, filename, size, mime_type, expire_at, max_downloads, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(
      file.code,
      file.filename,
      file.size,
      file.mimeType,
      file.expireAt,
      file.maxDownloads,
      new Date().toISOString(),
    )
    .run();
}

/** 原子递增下载计数，仅在未达上限时生效。返回 true 表示成功递增 */
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

/** 删除文件记录 */
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
  kv: KVNamespace,
): Promise<number> {
  const expired = await db
    .prepare("SELECT * FROM fc_files WHERE expire_at <= datetime('now')")
    .all<FileRecord>();
  const files = expired.results ?? [];
  for (const f of files) {
    await kv.delete(`file:${f.code}`);
  }
  if (files.length > 0) {
    await db.prepare("DELETE FROM fc_files WHERE expire_at <= datetime('now')").run();
  }
  return files.length;
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
