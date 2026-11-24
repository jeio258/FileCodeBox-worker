/**
 * 数据层：全部 D1 读写。对外只暴露领域模型（camelCase），
 * 数据库行的 snake_case 形状仅在本文件内出现，避免命名在两套体系间泄漏。
 */

import type {
  ChunkPart,
  ChunkPartRow,
  ChunkTask,
  ChunkTaskRow,
  DashboardStats,
  FileFilters,
  FileRecord,
  FileRow,
  NewFile,
} from './types';

/** 表结构版本：增删表/列时必须 +1；ensureSchema 据此决定是否补建 */
export const SCHEMA_VERSION = 5;
const SCHEMA_KEY = 'schema_version';

// ===================== 行 → 领域模型 =====================

const toFile = (row: FileRow): FileRecord => ({
  id: row.id,
  code: row.code,
  filename: row.filename,
  size: row.size,
  mimeType: row.mime_type,
  expireAt: row.expire_at,
  downloadCount: row.download_count,
  maxDownloads: row.max_downloads,
  createdAt: row.created_at,
  clientIp: row.ip,
  isText: row.is_text === 1,
  hasThumb: row.has_thumb === 1,
});

const toChunkTask = (row: ChunkTaskRow): ChunkTask => ({
  uploadId: row.upload_id,
  code: row.code,
  filename: row.filename,
  size: row.size,
  totalChunks: row.total_chunks,
  mimeType: row.mime_type,
  expireAt: row.expire_at,
  maxDownloads: row.max_downloads,
  clientIp: row.client_ip,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  r2UploadId: row.r2_upload_id,
});

const toChunkPart = (row: ChunkPartRow): ChunkPart => ({ partIndex: row.part_index, etag: row.etag });

// ===================== 建表 =====================

const SCHEMA_STATEMENTS = [
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
    is_text INTEGER DEFAULT 0,
    has_thumb INTEGER DEFAULT 0
  )`,
  'CREATE INDEX IF NOT EXISTS idx_fc_code ON fc_files(code)',
  'CREATE INDEX IF NOT EXISTS idx_fc_expire ON fc_files(expire_at)',
  'CREATE TABLE IF NOT EXISTS fc_used_codes (code TEXT PRIMARY KEY)',
  `CREATE TABLE IF NOT EXISTS fc_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS fc_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS fc_rate_limits (
    key TEXT PRIMARY KEY,
    count INTEGER NOT NULL,
    window_start INTEGER NOT NULL
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
    updated_at TEXT NOT NULL,
    r2_upload_id TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS fc_chunk_parts (
    upload_id TEXT NOT NULL,
    part_index INTEGER NOT NULL,
    etag TEXT NOT NULL,
    PRIMARY KEY (upload_id, part_index)
  )`,
];

/**
 * 初始化/升级表结构（幂等）。由 ensureSchema 与 Cron 调用。
 * 新表通过 CREATE IF NOT EXISTS 建立；老库缺列通过 ALTER 补齐；
 * 旧布局（token 存设置表、限流存设置表 JSON）在此一次性迁移。
 */
export async function initDB(db: D1Database): Promise<void> {
  for (const sql of SCHEMA_STATEMENTS) await db.prepare(sql).run();

  // 列已存在时 SQLite 报 duplicate column，忽略即可
  const migrate = (sql: string) => db.prepare(sql).run().catch(() => {});
  await migrate('ALTER TABLE fc_files ADD COLUMN is_text INTEGER DEFAULT 0');
  await migrate('ALTER TABLE fc_files ADD COLUMN has_thumb INTEGER DEFAULT 0');
  await migrate("ALTER TABLE fc_chunk_uploads ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''");
  await migrate('ALTER TABLE fc_chunk_uploads ADD COLUMN r2_upload_id TEXT');
  await migrate(
    "INSERT OR IGNORE INTO fc_state(key, value) SELECT 'admin_token', value FROM fc_settings WHERE key = 'admin_token'",
  );
  await migrate("DELETE FROM fc_settings WHERE key = 'admin_token'");
  await migrate(
    "INSERT OR IGNORE INTO fc_rate_limits(key, count, window_start) SELECT key, 1, CAST(json_extract(value, '$.windowStart') AS INTEGER) FROM fc_settings WHERE key LIKE '%ratelimit:%'",
  );
  await migrate("DELETE FROM fc_settings WHERE key LIKE 'login_ratelimit:%' OR key LIKE 'upload_ratelimit:%'");

  await db
    .prepare('INSERT OR REPLACE INTO fc_settings(key, value) VALUES(?, ?)')
    .bind(SCHEMA_KEY, String(SCHEMA_VERSION))
    .run();
}

/** 读取库内 schema 版本（表缺失或损坏视为 0，触发重建） */
export async function getSchemaVersion(db: D1Database): Promise<number> {
  try {
    const row = await db
      .prepare('SELECT value FROM fc_settings WHERE key = ?')
      .bind(SCHEMA_KEY)
      .first<{ value: string }>();
    return row ? Number(row.value) || 0 : 0;
  } catch {
    return 0;
  }
}

// ===================== 文件 =====================

export async function getFileByCode(db: D1Database, code: string): Promise<FileRecord | null> {
  const row = await db
    .prepare("SELECT * FROM fc_files WHERE code = ? AND datetime(expire_at) > datetime('now')")
    .bind(code)
    .first<FileRow>();
  return row ? toFile(row) : null;
}

export async function getFileById(db: D1Database, id: number): Promise<FileRecord | null> {
  const row = await db.prepare('SELECT * FROM fc_files WHERE id = ?').bind(id).first<FileRow>();
  return row ? toFile(row) : null;
}

export async function insertFile(db: D1Database, file: NewFile): Promise<void> {
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
      file.isText ? 1 : 0,
    )
    .run();
}

/** 下载计数：已达上限时不递增并返回 false */
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
/** 全站已用存储（以 D1 实际记录求和，避免计数器漂移；缩略图不计入） */
export async function getStorageUsed(db: D1Database): Promise<number> {
  const row = await db.prepare('SELECT COALESCE(SUM(size),0) AS used FROM fc_files').first<{ used: number }>();
  return row?.used ?? 0;
}

/** 标记文件已有缩略图（不可重复设置） */
export async function markFileThumb(db: D1Database, code: string): Promise<boolean> {
  const result = await db
    .prepare('UPDATE fc_files SET has_thumb = 1 WHERE code = ? AND has_thumb = 0')
    .bind(code)
    .run();
  return result.meta.changes > 0;
}

export async function deleteFileRecord(db: D1Database, id: number): Promise<void> {
  const row = await db.prepare('SELECT code FROM fc_files WHERE id = ?').bind(id).first<{ code: string }>();
  if (!row) return;
  await db.prepare('DELETE FROM fc_files WHERE id = ?').bind(id).run();
  await releaseCode(db, row.code);
}

/** 取走已过期文件记录（删除记录 + 释放码），返回用于清理 R2 的对象列表 */
export async function takeExpiredFiles(db: D1Database): Promise<FileRecord[]> {
  const rows = await db
    .prepare("SELECT * FROM fc_files WHERE datetime(expire_at) <= datetime('now')")
    .all<FileRow>();
  const files = (rows.results ?? []).map(toFile);
  if (!files.length) return files;

  await db.prepare("DELETE FROM fc_files WHERE datetime(expire_at) <= datetime('now')").run();
  await Promise.all(files.map((f) => releaseCode(db, f.code)));
  await cleanupUsedCodes(db);
  return files;
}

/** 给定取件码，返回其中仍存在于 D1 的子集（孤儿对象比对用） */
export async function findExistingCodes(db: D1Database, codes: string[]): Promise<Set<string>> {
  const BATCH = 100; // D1 单语句绑定变量上限
  const found = new Set<string>();
  for (let i = 0; i < codes.length; i += BATCH) {
    const batch = codes.slice(i, i + BATCH);
    const placeholders = batch.map(() => '?').join(',');
    const rows = await db
      .prepare(`SELECT code FROM fc_files WHERE code IN (${placeholders})`)
      .bind(...batch)
      .all<{ code: string }>();
    for (const row of rows.results ?? []) found.add(row.code);
  }
  return found;
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

/** 取件码是否已被预占（存在于占用表） */
export async function isCodeReserved(db: D1Database, code: string): Promise<boolean> {
  const row = await db.prepare('SELECT 1 FROM fc_used_codes WHERE code = ?').bind(code).first();
  return row !== null;
}

export async function releaseCode(db: D1Database, code: string): Promise<void> {
  await db.prepare('DELETE FROM fc_used_codes WHERE code = ?').bind(code).run();
}

/** 清理无主占用码（删除中途失败的兜底） */
export async function cleanupUsedCodes(db: D1Database): Promise<number> {
  const result = await db
    .prepare('DELETE FROM fc_used_codes WHERE code NOT IN (SELECT code FROM fc_files)')
    .run();
  return result.meta?.changes ?? 0;
}

// ===================== 列表与统计 =====================

const SORT_SQL: Record<string, string> = {
  newest: 'id DESC',
  oldest: 'id ASC',
  largest: 'size DESC',
  smallest: 'size ASC',
  mostDownloaded: 'download_count DESC',
  leastDownloaded: 'download_count ASC',
};

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
      .all<FileRow>(),
    db.prepare(`SELECT COUNT(*) as count FROM fc_files ${where}`).bind(...args).first<{ count: number }>(),
  ]);
  return { files: (rows.results ?? []).map(toFile), total: countRow?.count ?? 0 };
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

// ===================== 设置（管理员可编辑） =====================

export async function getSettings(db: D1Database, keys: string[]): Promise<Record<string, string>> {
  if (!keys.length) return {};
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

// ===================== 会话状态 =====================

export async function getState(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare('SELECT value FROM fc_state WHERE key = ?').bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

export async function setState(db: D1Database, key: string, value: string): Promise<void> {
  await db.prepare('INSERT OR REPLACE INTO fc_state(key, value) VALUES(?, ?)').bind(key, value).run();
}

// ===================== 分片任务 =====================

export async function insertChunkTask(db: D1Database, t: ChunkTask): Promise<void> {
  await db
    .prepare(
      'INSERT INTO fc_chunk_uploads(upload_id, code, filename, size, total_chunks, mime_type, expire_at, max_downloads, client_ip, created_at, updated_at, r2_upload_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    )
    .bind(
      t.uploadId,
      t.code,
      t.filename,
      t.size,
      t.totalChunks,
      t.mimeType,
      t.expireAt,
      t.maxDownloads,
      t.clientIp,
      t.createdAt,
      t.updatedAt,
      t.r2UploadId,
    )
    .run();
}

export async function getChunkTask(db: D1Database, uploadId: string): Promise<ChunkTask | null> {
  const row = await db
    .prepare('SELECT * FROM fc_chunk_uploads WHERE upload_id = ?')
    .bind(uploadId)
    .first<ChunkTaskRow>();
  return row ? toChunkTask(row) : null;
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

/** 取走并删除超过宽限期未活跃的任务（调用方负责清理 R2 分片与释放码） */
export async function takeStaleChunkTasks(db: D1Database, olderThanMs: number): Promise<ChunkTask[]> {
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  const rows = await db
    .prepare('SELECT * FROM fc_chunk_uploads WHERE datetime(updated_at) <= datetime(?)')
    .bind(cutoff)
    .all<ChunkTaskRow>();
  const tasks = (rows.results ?? []).map(toChunkTask);
  if (!tasks.length) return tasks;

  await db.prepare('DELETE FROM fc_chunk_uploads WHERE datetime(updated_at) <= datetime(?)').bind(cutoff).run();
  return tasks;
}

// ===================== 分片 etag =====================

export async function saveChunkPart(db: D1Database, uploadId: string, partIndex: number, etag: string): Promise<void> {
  await db
    .prepare('INSERT OR REPLACE INTO fc_chunk_parts(upload_id, part_index, etag) VALUES (?,?,?)')
    .bind(uploadId, partIndex, etag)
    .run();
}

/** 已上传分片（part_index 升序） */
export async function listChunkParts(db: D1Database, uploadId: string): Promise<ChunkPart[]> {
  const rows = await db
    .prepare('SELECT upload_id, part_index, etag FROM fc_chunk_parts WHERE upload_id = ? ORDER BY part_index')
    .bind(uploadId)
    .all<ChunkPartRow>();
  return (rows.results ?? []).map(toChunkPart);
}

export async function deleteChunkParts(db: D1Database, uploadId: string): Promise<void> {
  await db.prepare('DELETE FROM fc_chunk_parts WHERE upload_id = ?').bind(uploadId).run();
}

// ===================== 限流 =====================

/**
 * 固定窗口限流：单条 UPSERT 原子完成"窗口重置或计数 +1"，避免 get-then-set 竞态与两次往返。
 * 限流表异常时降级放行（可用性优先），并记录事件。
 */
export async function checkRateLimit(
  db: D1Database,
  bucket: string,
  ip: string,
  max: number,
  windowMs: number,
): Promise<boolean> {
  try {
    const now = Date.now();
    const row = await db
      .prepare(
        `INSERT INTO fc_rate_limits(key, count, window_start) VALUES(?1, 1, ?2)
         ON CONFLICT(key) DO UPDATE SET
           count = CASE WHEN ?2 - window_start >= ?3 THEN 1 ELSE count + 1 END,
           window_start = CASE WHEN ?2 - window_start >= ?3 THEN ?2 ELSE window_start END
         RETURNING count`,
      )
      .bind(`${bucket}:${ip}`, now, windowMs)
      .first<{ count: number }>();
    return (row?.count ?? 1) <= max;
  } catch (e) {
    console.error(JSON.stringify({ event: 'ratelimit_unavailable', error: String(e) }));
    return true;
  }
}

/** 单条 SQL 回收过期窗口 */
export async function cleanupRateLimits(db: D1Database, windowMs: number): Promise<number> {
  const result = await db
    .prepare('DELETE FROM fc_rate_limits WHERE window_start < ?')
    .bind(Date.now() - windowMs)
    .run();
  return result.meta?.changes ?? 0;
}
