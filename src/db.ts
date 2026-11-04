/** 数据层：仅 D1 读写，不涉及 R2 与 HTTP。 */

import type { ChunkUploadTask, FileRecord } from './types';
import { FILE_PREFIX } from './utils';

// ===================== 建表 =====================

/** 初始化数据库表（幂等：scheduled 每次调用都执行，首次部署自动就绪） */
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
      ip TEXT DEFAULT '',
      is_text INTEGER DEFAULT 0
    )`,
    'CREATE INDEX IF NOT EXISTS idx_fc_code ON fc_files(code)',
    'CREATE INDEX IF NOT EXISTS idx_fc_expire ON fc_files(expire_at)',
    'CREATE TABLE IF NOT EXISTS fc_used_codes (code TEXT PRIMARY KEY)',
    `CREATE TABLE IF NOT EXISTS fc_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS fc_chunk_uploads (
      upload_id TEXT PRIMARY KEY,
      code TEXT NOT NULL,
      filename TEXT NOT NULL,
      size INTEGER NOT NULL,
      total_chunks INTEGER NOT NULL,
      mime_type TEXT DEFAULT 'application/octet-stream',
      expire_at TEXT NOT NULL,
      max_downloads INTEGER DEFAULT -1,
      client_ip TEXT DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
  ];
  for (const stmt of stmts) {
    await db.prepare(stmt).run();
  }
  // 旧库补列（列已存在时 sqlite 报 duplicate，忽略即可）
  const migrate = (sql: string) => db.prepare(sql).run().catch(() => {});
  await migrate('ALTER TABLE fc_files ADD COLUMN is_text INTEGER DEFAULT 0');
  await migrate("ALTER TABLE fc_chunk_uploads ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''");
}

// ===================== 文件 =====================

/** 取件码查询（仅未过期文件） */
export async function getFileByCode(db: D1Database, code: string): Promise<FileRecord | null> {
  return db
    .prepare("SELECT * FROM fc_files WHERE code = ? AND datetime(expire_at) > datetime('now')")
    .bind(code)
    .first<FileRecord>();
}

export async function getFileById(db: D1Database, id: number): Promise<FileRecord | null> {
  return db.prepare('SELECT * FROM fc_files WHERE id = ?').bind(id).first<FileRecord>();
}

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
    clientIp?: string;
  },
): Promise<void> {
  await db
    .prepare(
      'INSERT INTO fc_files(code, filename, size, mime_type, expire_at, max_downloads, created_at, ip, is_text) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(
      file.code,
      file.filename,
      file.size,
      file.mimeType,
      file.expireAt,
      file.maxDownloads,
      new Date().toISOString(),
      file.clientIp ?? '',
      file.isText ?? 0,
    )
    .run();
}

/** 下载计数：已达上限时不递增，返回 false */
export async function incrementDownload(db: D1Database, code: string): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE fc_files SET download_count = download_count + 1
       WHERE code = ? AND (max_downloads < 0 OR download_count < max_downloads)`,
    )
    .bind(code)
    .run();
  return result.meta.changes > 0;
}

/** 删除记录并释放取件码 */
export async function deleteFileRecord(db: D1Database, id: number): Promise<void> {
  const file = await getFileById(db, id);
  if (!file) return;
  await db.prepare('DELETE FROM fc_files WHERE id = ?').bind(id).run();
  await releaseCode(db, file.code);
}

// ===================== 取件码占用 =====================

export async function isCodeTaken(db: D1Database, code: string): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 FROM fc_used_codes WHERE code = ?
       UNION ALL
       SELECT 1 FROM fc_files WHERE code = ? AND datetime(expire_at) > datetime('now')
       LIMIT 1`,
    )
    .bind(code, code)
    .first();
  return row !== null;
}

/** 原子抢占：INSERT OR IGNORE + changes，并发同码仅一个成功 */
export async function claimCode(db: D1Database, code: string): Promise<boolean> {
  const result = await db.prepare('INSERT OR IGNORE INTO fc_used_codes(code) VALUES (?)').bind(code).run();
  return result.meta.changes === 1;
}

export async function releaseCode(db: D1Database, code: string): Promise<void> {
  await db.prepare('DELETE FROM fc_used_codes WHERE code = ?').bind(code).run();
}

/** 清理已无对应文件的占用码（删除中途失败的兜底） */
export async function cleanupUsedCodes(db: D1Database): Promise<number> {
  const result = await db
    .prepare('DELETE FROM fc_used_codes WHERE code NOT IN (SELECT code FROM fc_files)')
    .run();
  return result.meta?.changes ?? 0;
}

// ===================== 分页与统计 =====================

const SORT_SQL: Record<string, string> = {
  newest: 'id DESC',
  oldest: 'id ASC',
  largest: 'size DESC',
  smallest: 'size ASC',
  mostDownloaded: 'download_count DESC',
  leastDownloaded: 'download_count ASC',
};

export interface FileFilters {
  keyword: string;
  dateFrom: string;
  dateTo: string;
  sort: string;
}

export async function listFiles(
  db: D1Database,
  page: number,
  size: number,
  filters: FileFilters,
): Promise<{ files: FileRecord[]; total: number }> {
  const conditions: string[] = [];
  const args: (string | number)[] = [];

  if (filters.keyword.trim()) {
    conditions.push('filename LIKE ?');
    args.push(`%${filters.keyword.trim()}%`);
  }
  if (filters.dateFrom) {
    conditions.push('date(created_at) >= ?');
    args.push(filters.dateFrom);
  }
  if (filters.dateTo) {
    conditions.push('date(created_at) <= ?');
    args.push(filters.dateTo);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const orderBy = SORT_SQL[filters.sort] ?? SORT_SQL.newest;

  const [rows, countRow] = await Promise.all([
    db
      .prepare(`SELECT * FROM fc_files ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`)
      .bind(...args, size, (page - 1) * size)
      .all<FileRecord>(),
    db.prepare(`SELECT COUNT(*) as count FROM fc_files ${where}`).bind(...args).first<{ count: number }>(),
  ]);
  return { files: rows.results ?? [], total: countRow?.count ?? 0 };
}

export interface DashboardStats {
  totalFiles: number;
  totalSize: number;
  todayCount: number;
  todaySize: number;
  yesterdayCount: number;
  yesterdaySize: number;
}

export async function getDashboardStats(db: D1Database): Promise<DashboardStats> {
  const query = (where: string) =>
    db
      .prepare(`SELECT COUNT(*) as count, COALESCE(SUM(size),0) as size FROM fc_files ${where}`)
      .first<{ count: number; size: number }>();

  const [total, today, yesterday] = await Promise.all([
    query(''),
    query("WHERE date(created_at) = date('now')"),
    query("WHERE date(created_at) = date('now', '-1 day')"),
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

// ===================== 过期清理 =====================

/** 删除过期记录并释放取件码，返回待删除的 R2 key（由调用方批量删对象） */
export async function takeExpiredFiles(db: D1Database): Promise<FileRecord[]> {
  const rows = await db
    .prepare("SELECT * FROM fc_files WHERE datetime(expire_at) <= datetime('now')")
    .all<FileRecord>();
  const files = rows.results ?? [];
  if (!files.length) return files;

  await db.prepare("DELETE FROM fc_files WHERE datetime(expire_at) <= datetime('now')").run();
  await Promise.all(files.map((f) => releaseCode(db, f.code)));
  await cleanupUsedCodes(db);
  return files;
}

// ===================== 设置 =====================

export async function getSettings(db: D1Database, keys: string[]): Promise<Record<string, string>> {
  const placeholders = keys.map(() => '?').join(',');
  const rows = await db
    .prepare(`SELECT key, value FROM fc_settings WHERE key IN (${placeholders})`)
    .bind(...keys)
    .all<{ key: string; value: string }>();
  const out: Record<string, string> = {};
  for (const row of rows.results ?? []) out[row.key] = row.value;
  return out;
}

export async function getSetting(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare('SELECT value FROM fc_settings WHERE key = ?').bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

export async function setSetting(db: D1Database, key: string, value: string): Promise<void> {
  await db.prepare('INSERT OR REPLACE INTO fc_settings(key, value) VALUES(?, ?)').bind(key, value).run();
}

// ===================== 分片上传任务 =====================

export async function insertChunkTask(db: D1Database, t: ChunkUploadTask): Promise<void> {
  await db
    .prepare(
      'INSERT INTO fc_chunk_uploads(upload_id, code, filename, size, total_chunks, mime_type, expire_at, max_downloads, client_ip, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    )
    .bind(
      t.upload_id,
      t.code,
      t.filename,
      t.size,
      t.total_chunks,
      t.mime_type,
      t.expire_at,
      t.max_downloads,
      t.client_ip,
      t.created_at,
      t.updated_at,
    )
    .run();
}

export async function getChunkTask(db: D1Database, uploadId: string): Promise<ChunkUploadTask | null> {
  return db.prepare('SELECT * FROM fc_chunk_uploads WHERE upload_id = ?').bind(uploadId).first<ChunkUploadTask>();
}

/** 刷活：断点续传中的任务不会被超时回收 */
export async function touchChunkTask(db: D1Database, uploadId: string): Promise<void> {
  await db
    .prepare('UPDATE fc_chunk_uploads SET updated_at = ? WHERE upload_id = ?')
    .bind(new Date().toISOString(), uploadId)
    .run();
}

export async function deleteChunkTask(db: D1Database, uploadId: string): Promise<void> {
  await db.prepare('DELETE FROM fc_chunk_uploads WHERE upload_id = ?').bind(uploadId).run();
}

/** 取出并删除超过宽限期未活跃的任务（调用方负责清理 R2 分片与释放码） */
export async function takeStaleChunkTasks(db: D1Database, olderThanMs: number): Promise<ChunkUploadTask[]> {
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  const rows = await db
    .prepare('SELECT * FROM fc_chunk_uploads WHERE datetime(updated_at) <= datetime(?)')
    .bind(cutoff)
    .all<ChunkUploadTask>();
  const tasks = rows.results ?? [];
  if (!tasks.length) return tasks;

  await db.prepare('DELETE FROM fc_chunk_uploads WHERE datetime(updated_at) <= datetime(?)').bind(cutoff).run();
  return tasks;
}

// ===================== 限流 =====================

/**
 * 滑动窗口限流（登录/上传共用）。无论是否放行都计数，
 * 防止攻击者在窗口重置后获得额外尝试次数。
 */
export async function checkRateLimit(
  db: D1Database,
  keyPrefix: string,
  ip: string,
  max: number,
  windowMs: number,
): Promise<boolean> {
  const key = `${keyPrefix}:${ip}`;
  const now = Date.now();
  const raw = await getSetting(db, key);

  let count = 0;
  let windowStart = now;
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as { count: number; windowStart: number };
      if (now - parsed.windowStart < windowMs) {
        count = parsed.count;
        windowStart = parsed.windowStart;
      }
    } catch {
      /* 损坏则重置窗口 */
    }
  }

  const newCount = count + 1;
  await setSetting(db, key, JSON.stringify({ count: newCount, windowStart }));
  return newCount <= max;
}

/** 回收已过窗口的限流键，防止 fc_settings 随访问 IP 无限增长 */
export async function cleanupRateLimits(db: D1Database, windowMs: number): Promise<number> {
  const rows = await db
    .prepare("SELECT key, value FROM fc_settings WHERE key LIKE 'login_ratelimit:%' OR key LIKE 'upload_ratelimit:%'")
    .all<{ key: string; value: string }>();

  const now = Date.now();
  const stale = (rows.results ?? []).filter((row) => {
    try {
      return now - (JSON.parse(row.value) as { windowStart: number }).windowStart > windowMs;
    } catch {
      return true;
    }
  });
  for (const row of stale) {
    await db.prepare('DELETE FROM fc_settings WHERE key = ?').bind(row.key).run();
  }
  return stale.length;
}

// ===================== 孤儿对象比对 =====================

/** 给定 R2 现存 key，返回其中在 D1 里不存在的取件码集合 */
export async function findActiveCodes(db: D1Database, codes: string[]): Promise<Set<string>> {
  const BATCH = 100; // D1 单语句绑定变量上限
  const active = new Set<string>();
  for (let i = 0; i < codes.length; i += BATCH) {
    const batch = codes.slice(i, i + BATCH);
    const placeholders = batch.map(() => '?').join(',');
    const rows = await db
      .prepare(`SELECT code FROM fc_files WHERE code IN (${placeholders})`)
      .bind(...batch)
      .all<{ code: string }>();
    for (const row of rows.results ?? []) active.add(row.code);
  }
  return active;
}

export const stripFilePrefix = (key: string) => key.slice(FILE_PREFIX.length);
