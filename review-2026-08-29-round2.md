# FileCodeBox-worker Code Review（第二轮 · 2026-08-29）

## 审查重点
复核第一轮修复的正确性，并深入检查遗漏问题。

---

## 🔴 关键发现：uploadFile 修复仍存在 bug（已再次修复）

### 问题回溯
第一轮修复引入了"分两阶段"方案：
- Phase 1: `bodyReader` 读取 body 测量 size
- Phase 2: `r2Reader` 再次 `getReader()` 读取 body 写入 R2

**根本错误**：Cloudflare Workers 中 `Request.body` 是单次消费的 ReadableStream。Phase 1 消费完毕后，Phase 2 的 `getReader()` 会立即返回 `done: true`，导致 R2 写入空内容。

### 最终修复方案（本轮采用）
回到已验证可靠的 `arrayBuffer()` 方案（对应历史提交 `86a8f24`）：

```typescript
const requestBody = await c.req.arrayBuffer();
const size = requestBody.byteLength;
if (size > maxSize) throw { status: 400, message: '文件过大...' };
const bodyBlob = new Blob([requestBody]);
await env.FILE_STORE.put(`file:${code}`, bodyBlob.stream(), { ... });
```

**理由**：
1. `arrayBuffer()` 只消费 body 一次，无流复用问题
2. 内存峰值 = 文件大小（对于 MAX_FILE_SIZE=100MB 上限可接受）
3. 历史验证：`86a8f24` 该方案上传功能正常
4. 之前的"流式优化"是过度设计，引入 bug

---

## ⚠️ 新发现问题

### P1: `getSecretHash` 缓存空密码哈希

**位置**: `src/auth.ts:10-16`

```typescript
let cachedSecretHash: string | null = null;
async function getSecretHash(env: Env): Promise<string> {
  if (!cachedSecretHash) {
    cachedSecretHash = await hashPassword(env.ADMIN_PASSWORD ?? '');
  }
  return cachedSecretHash;
}
```

**问题**：若 `env.ADMIN_PASSWORD` 未配置，会缓存空字符串哈希。后续即使配置了密码，比较仍基于空哈希。

**影响**：低（handleAdminLogin 已先检查 `!env.ADMIN_PASSWORD` 返回错误）

**建议**：缓存前检查密码存在性，或直接移除缓存（PBKDF2 100k 迭代约 100-200ms，对低频登录影响不大）

---

### P2: `parseExpire` 的 `count` 分支逻辑错误（未被使用）

**位置**: `src/shared.ts:30-32`

```typescript
case 'count':
  // expireValue 为用户设置的最大下载次数；expireAt 用默认天数计算
  return { expireAt: new Date(now + expireValue * 86_400_000).toISOString(), maxDownloads: -1 };
```

**问题**：
1. 注释说 `expireValue` 是"最大下载次数"，但代码把它当"天数"计算
2. `maxDownloads` 始终返回 -1，不符合"按次数过期"语义
3. 该分支未被任何调用方使用（`uploadFile`/`uploadText` 都传 `'day'`）

**影响**：无（死代码），但易误导后续维护

---

## ✅ 复核通过项

| 检查项 | 结论 |
|--------|------|
| `arrayBuffer()` 方案正确性 | ✅ 单次消费，无流复用问题 |
| `markCodeUsed` 在 R2 写入前调用 | ✅ 失败时 `releaseCode` 兜底 |
| `deleteFileRecord` try/finally | ✅ R2 先删，DB 在 finally 清理 |
| XSS 转义 | ✅ 所有用户输入经 `escapeHtml` |
| 时序安全比较 | ✅ 手动实现正确 |
| 登录限流 | ✅ 窗口逻辑正确 |
| CSP | ✅ 已清理 Google Fonts 残留 |
| SQL 注入防护 | ✅ 全参数化查询 |

---

## 本轮修改

| 文件 | 修改内容 |
|------|----------|
| `src/shared.ts` | `uploadFile` 改用 `arrayBuffer()` + `Blob` 方案（替代错误的双阶段流） |

## 建议后续处理（低优先级）

1. ~~P1: 调整 `getSecretHash` 缓存逻辑~~ ✅ 已处理（2026-08-29 提交 `f1cda47`）
2. ~~P2: 清理 `parseExpire` 的 `count` 死分支~~ ✅ 已处理（修正为正确语义）
3. favicon 改为 inline SVG 减少外部请求

---

## 第三轮处理记录（2026-08-29）

### P1 修复（`src/auth.ts`）
```typescript
async function getSecretHash(env: Env): Promise<string> {
  // 密码未配置时不缓存，避免缓存空字符串哈希导致后续登录误判
  if (!env.ADMIN_PASSWORD) {
    return await hashPassword('');
  }
  if (!cachedSecretHash) {
    cachedSecretHash = await hashPassword(env.ADMIN_PASSWORD);
  }
  return cachedSecretHash;
}
```

### P2 修复（`src/shared.ts`）
```typescript
case 'count':
  // 按下载次数过期：expireValue 为最大下载次数，过期时间用默认天数兜底
  return { expireAt: new Date(now + 30 * 86_400_000).toISOString(), maxDownloads: expireValue };
```

### M2 评估结论（不改动）
`listFiles`/`listFilesWithSearch` 的 COUNT 查询已用 `Promise.all` 并行化，且：
1. 管理后台仅管理员访问，频率极低
2. 文件定期过期清理，表不会无限增长
3. `id` 为主键，`COUNT(*)` 走主键扫描（较快）

在当前规模下不是瓶颈，遵循"外科手术式修改"原则不改动。
