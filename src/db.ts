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
  const migrations = [
    'ALTER TABLE fc_files ADD COLUMN is_text INTEGER DEFAULT 0',
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
    .prepare("SELECT * FROM fc_files WHERE code = ? AND datetime(expire_at) > datetime('now')")
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
    .prepare("SELECT id FROM fc_files WHERE code = ? AND datetime(expire_at) > datetime('now')")
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
  },
): Promise<void> {
  await db
    .prepare(
      'INSERT INTO fc_files(code, filename, size, mime_type, expire_at, max_downloads, created_at, is_text) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
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

/** API 用：分页 + 关键词搜索 */
export async function listFilesWithSearch(
  db: D1Database,
  page: number,
  size: number,
  keyword: string,
): Promise<{ files: FileRecord[]; total: number }> {
  const offset = (page - 1) * size;
  const kw = keyword.trim();
  const where = kw ? 'WHERE filename LIKE ?' : '';
  const bindArgs: string[] = kw ? [`%${kw}%`] : [];
  const [rows, countRow] = await Promise.all([
    db
      .prepare(`SELECT * FROM fc_files ${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .bind(...bindArgs, size, offset)
      .all<FileRecord>(),
    db
      .prepare(`SELECT COUNT(*) as count FROM fc_files ${where}`)
      .bind(...bindArgs)
      .first<{ count: number }>(),
  ]);
  return { files: rows.results ?? [], total: countRow?.count ?? 0 };
}

/** 仪表盘统计 */
export async function getDashboardStats(db: D1Database): Promise<{
  totalFiles: number;
  totalSize: number;
  todayCount: number;
  todaySize: number;
  yesterdayCount: number;
  yesterdaySize: number;
}> {
  const [total, today, yesterday] = await Promise.all([
    db
      .prepare('SELECT COUNT(*) as count, COALESCE(SUM(size),0) as size FROM fc_files')
      .first<{ count: number; size: number }>(),
    db
      .prepare("SELECT COUNT(*) as count, COALESCE(SUM(size),0) as size FROM fc_files WHERE date(created_at) = date('now')")
      .first<{ count: number; size: number }>(),
    db
      .prepare("SELECT COUNT(*) as count, COALESCE(SUM(size),0) as size FROM fc_files WHERE date(created_at) = date('now', '-1 day')")
      .first<{ count: number; size: number }>(),
  ]);
  return {
    totalFiles: total?.count ?? 0,
    totalSize: total?.size ?? 0,
    todayCount: today?.count ?? 0,
    todaySize: today?.size ?? 0,
    yesterdayCount: yesterday?.count ?? 0,
    yesterdaySize: yesterday?.size ?? 0,
  };
}

// ---- 过期清理 ----

export async function cleanupExpired(
  db: D1Database,
  bucket: R2Bucket,
): Promise<number> {
  const expired = await db
    .prepare("SELECT * FROM fc_files WHERE datetime(expire_at) <= datetime('now')")
    .all<FileRecord>();
  const files = expired.results ?? [];
  for (const f of files) {
    await bucket.delete(`file:${f.code}`);
  }
  if (files.length > 0) {
    await db.prepare("DELETE FROM fc_files WHERE datetime(expire_at) <= datetime('now')").run();
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

// ---- 登录速率限制（D1 存储） ----

const LOGIN_RATE_WINDOW = 60_000; // 60 秒窗口
const LOGIN_RATE_MAX = 5;          // 窗口内最大尝试次数

/**
 * 检查并记录登录尝试。返回 true 表示允许继续，false 表示已限流。
 */
export async function checkLoginRateLimit(
  db: D1Database,
  ip: string,
): Promise<boolean> {
  const key = `login_ratelimit:${ip}`;
  const now = Date.now();
  const raw = await getSetting(db, key);

  let count = 0;
  let windowStart = now;
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as { count: number; windowStart: number };
      if (now - parsed.windowStart < LOGIN_RATE_WINDOW) {
        count = parsed.count;
        windowStart = parsed.windowStart;
      }
    } catch { /* 损坏则重置 */ }
  }

  if (count >= LOGIN_RATE_MAX) return false;

  await setSetting(db, key, JSON.stringify({ count: count + 1, windowStart }));
  return true;
}
