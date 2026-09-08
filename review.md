# FileCodeBox-worker 代码审查报告

> 审查时间：2026-08-22
> 审查范围：全量源码（src/ 下全部文件）
> 最近提交：`e916377 fix: 修复下载次数不准确`（7 commits）

---

## 一、项目概述

FileCodeBox-worker 是 [FileCodeBox](https://github.com/vastsa/FileCodeBox) 的 Cloudflare Workers 重写版，提供临时文件/文本分享服务。

**技术栈：**
- Hono 4.x（Web 框架）
- Cloudflare D1（SQLite 元数据存储）
- Cloudflare R2（文件对象存储）
- TypeScript strict 模式
- Cloudflare Cron 自动清理

**核心流程：**
1. 用户上传图片/文本 → 服务端生成4位取件码 → 文件流式写入 R2，元数据写入 D1
2. 接收方输入取件码 → 查 D1 获取元数据 → 从 R2 流式下载文件
3. 管理后台：Cookie-based admin_token 认证，支持列表/删除/清理

---

## 二、架构设计评价

### ✅ 优点

| 维度 | 评价 |
|------|------|
| 分层清晰 | `index.ts`（路由）→ `api.ts`（兼容API）→ `auth.ts`（认证）→ `db.ts`（数据层）→ `templates/`（视图），职责分明 |
| 零缓冲上传 | `/api/upload` 和 `/share/file` 使用 `c.req.raw.body` 直传 R2，不缓冲到内存，符合 Workers 大文件最佳实践 |
| 流式下载 | `/api/download` 和 `/share/download` 使用 `obj.body` 流式返回，不加载全量到内存 |
| 过期清理机制 | 双保险：D1 查询 + R2 delete，配合 Cron `*/30 * * * *` 定时执行 |
| 密码安全 | PBKDF2 10万次迭代 + SHA-256，密码不落盘，使用 Cloudflare Secret |
| Cookie 安全 | `httpOnly: true, secure: true, sameSite: 'Strict'` |
| CORS 配置 | `cors()` + `Referrer-Policy: no-referrer`，兼顾功能与隐私 |
| 设计系统 | CSS Variables + OKLCH 色彩空间 + 深色模式适配 + `prefers-reduced-motion` |

### ⚠️ 架构层面的问题

#### 1. 两套路由体系存在重复逻辑

`src/index.ts` 和 `src/api.ts` 各有一份独立的上传/下载/认证逻辑：

```
index.ts:  /api/upload, /api/upload/text, /api/download/:code
api.ts:    /share/file, /share/text, /share/download
```

这两个路径集合处理几乎相同的业务逻辑（上传→存R2+写D1，下载→查D1+流R2），但实现细节略有差异（如错误格式、计数逻辑）。这是 **Divergent Change** 的典型症状——同一个功能领域被拆成两个维护点。

**建议：** 将核心业务逻辑抽出为共享函数（如 `uploadFile()`, `downloadFile()`），两个路由层都调用同一实现。

#### 2. `generateCode()` 碰撞风险

```typescript
// src/utils.ts
export function generateCode(): string {
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += Math.floor(Math.random() * 10).toString();
  }
  return code;
}
```

- 4位纯数字 = 10,000 种可能
- 生日悖论：约 120 个文件时有 50% 概率发生碰撞
- 使用 `Math.random()` 而非 CSPRNG，在理论上有预测性

**实际影响：** 碰撞检查在 `isCodeTaken` 处有重试机制（最多10次），所以功能上不会出错，但安全性弱。

---

## 三、安全问题详细分析

### 🔴 高优先级

#### 3.1 Admin Token 对比存在时序攻击风险

**位置：** `src/auth.ts:15`

```typescript
export async function adminAuth(...): Promise<boolean> {
  const token = getCookie(c, 'admin_token') ?? c.req.header('Authorization')?.replace('Bearer ', '');
  if (!token) return false;
  try {
    const stored = await getSetting(env.DB, 'admin_token');
    return stored === token;  // ← 直接字符串比较
  } catch { return false; }
}
```

`stored === token` 使用 JavaScript 的 `===` 做字符串比较，遇到不同字符时会提前退出。攻击者可通过测量响应时间差推断 token 的正确前缀字符。

**修复方案：** 使用 `crypto.subtle.timingSafeEqual`：

```typescript
const encoder = new TextEncoder();
const tokenBytes = encoder.encode(token);
const storedBytes = encoder.encode(stored ?? '');
if (tokenBytes.length !== storedBytes.length) return false;
const result = await crypto.subtle.timingSafeEqual(tokenBytes, storedBytes);
return result;
```

#### 3.2 文件名未做 HTML 转义 → Stored XSS

**位置：** `src/templates/pages.ts` 多处

```typescript
// pages.ts: resultPage()
<div class="info-row" style="margin-top:16px">
  <span class="info-tag">${filename}</span>  // ← 直接插值，无转义
</div>

// pages.ts: filePage()
<div style="font-size:18px;font-weight:500;margin-bottom:6px;word-break:break-all">${file.filename}</div>

// pages.ts: adminPanel()
<span class="fname">${f.filename}</span>
```

攻击者上传一个名为 `<img src=x onerror=alert(1)>.txt` 的文件，所有查看该文件页面的用户都会触发 XSS。

**修复方案：** 添加一个简单的 HTML 转义函数：

```typescript
export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
```

然后在所有模板中使用 `escapeHtml(filename)`。

#### 3.3 文本内容未做 XSS 过滤

**位置：** `src/templates/pages.ts:filePage()` 文本查看分支

```typescript
<div class="text-content" id="textContent">加载中…</div>
<script>
  fetch('/api/text/${file.code}').then(function(r){return r.text()}).then(function(t){
    document.getElementById('textContent').textContent = t;  // textContent 是安全的
  });
</script>
```

文本展示用了 `textContent`（而非 `innerHTML`），这部分是安全的。✅

---

### 🟡 中优先级

#### 3.4 登录速率限制存在窗口重置漏洞

**位置：** `src/db.ts:checkLoginRateLimit()`

```typescript
export async function checkLoginRateLimit(db: D1Database, ip: string): Promise<boolean> {
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
        windowStart = parsed.windowStart;  // ← 保留旧窗口起点
      }
    } catch { /* 损坏则重置 */ }
  }

  if (count >= LOGIN_RATE_MAX) return false;  // ← 返回 false 时没有记录这次尝试

  await setSetting(db, key, JSON.stringify({ count: count + 1, windowStart }));
  return true;
}
```

**问题：** 当 `count >= LOGIN_RATE_MAX` 时直接返回 `false`，**不更新数据库记录**。攻击者可以：
1. 用 5 次尝试耗尽限制
2. 等待几秒后再次尝试（因为没写 DB，旧记录仍然存在但窗口在推进）
3. 实际上每次等到窗口自然过期后都可以重新获得 5 次机会

**更严重的是：** 如果攻击者在窗口即将结束时停止攻击，等窗口自然流逝后再攻击，这个计数器会被**重置**而不是延续。当前的实现是：只有在 `count < LOGIN_RATE_MAX` 时才写 DB，导致窗口可以被"钻空子"。

**修复方案：** 无论是否通过，都应在窗口内递增计数：

```typescript
// 始终更新计数（即使已达上限也刷新时间戳，防止窗口无限漂移）
await setSetting(db, key, JSON.stringify({ count: count + 1, windowStart }));
if (count + 1 > LOGIN_RATE_MAX) return false;
return true;
```

#### 3.5 取件码格式未做服务端校验

**位置：** `src/index.ts:post('/api/upload')` 和 `src/api.ts:shareFile`

```typescript
const code = (c.req.query('code') || '').trim() || generateCode();
```

客户端可以提交任意字符串作为取件码（如 `"admin"`、`"../../etc/passwd"`、超长字符串等）。虽然 DB 有 UNIQUE 约束保护，但：
- 无长度/字符集校验
- 无格式校验（应为4位数字）

**建议：** 在生成或使用自定义 code 时增加校验：

```typescript
if (customCode && !/^\d{4}$/.test(customCode)) {
  return fail(c, 400, '取件码必须为4位数字');
}
```

#### 3.6 管理后台的 Delete 使用 POST 但通过 URL 参数传递 ID

**位置：** `src/index.ts`

```typescript
app.post('/api/admin/delete/:id', async (c) => {
```

使用 URL path parameter 传递操作对象 ID 虽可行，但缺少 CSRF 保护（尽管是 post 方法 + cookie 认证）。考虑到 `sameSite: 'Strict'` 已防止跨站请求，风险较低，但仍建议添加 anti-CSRF token。

---

### 🟢 低优先级 / 建议

#### 3.7 缺少 Content-Security-Policy 头部

当前只设置了 `Referrer-Policy: no-referrer`，但没有 CSP。对于有用户上传内容（文件名、文本）的服务，CSP 是最后一道防线。

建议添加：
```typescript
c.res.headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' fonts.googleapis.com; img-src 'self' https:t.alcy.cc https:q1.qlogo.cn; font-src fonts.gstatic.com;");
```

#### 3.8 无上传速率限制

只限制了登录频率，没有限制：
- 单 IP 的上传频率
- 单 IP 的总上传大小
- 恶意大文件占用 R2 配额

#### 3.9 `isCodeTaken` 对已过期文件也做检查

```typescript
export async function isCodeTaken(db: D1Database, code: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT id FROM fc_files WHERE code = ? AND datetime(expire_at) > datetime('now')")
    .bind(code)
    .first();
  return row !== null;
}
```

这里过滤了已过期文件，是正确的。但 `getFileByCode` 也有同样过滤，一致性好。✅

#### 3.10 `Math.random()` 用于取件码生成

如前所述，取件码碰撞不影响正确性（有重试），但理论上可预测。对于临时文件分享场景可接受，但若追求更高安全性可改用 `crypto.getRandomValues()`。

---

## 四、代码质量问题

### 4.1 类型安全

| 文件 | 问题 |
|------|------|
| `src/auth.ts:25` | `body['password'] as string` — parseBody 返回 `any`，强转不安全 |
| `src/api.ts` 多处 | `body['text'] as string` — 同上 |
| `src/db.ts` | `parsed as { count: number; windowStart: number }` — JSON.parse 结果未经校验 |
| `src/index.ts` | `catch (e: any)` — 共 5 处，应区分错误类型 |

### 4.2 SQL 注入风险

搜索功能：
```typescript
const kw = keyword.trim();
const bindArgs: string[] = kw ? [`%${kw}%`] : [];
```
使用了参数化绑定（`?`），`%` 拼接在 bind 值中，**不存在 SQL 注入风险**。✅

### 4.3 竞态条件

`incrementDownload` 使用 `UPDATE ... WHERE download_count < max_downloads` 的原子操作，D1 的单线程执行模型保证了安全性。✅

### 4.4 资源泄漏

Admin 删除文件时：
```typescript
const file = await deleteFileRecord(env.DB, id);
if (file) {
  await env.FILE_STORE.delete(`file:${file.code}`);
}
```
若 D1 delete 成功但 R2 delete 失败，会产生**孤儿 R2 对象**（DB 已无记录但 R2 仍有数据）。Cron 清理不会处理这种情况（因为 DB 已无记录）。

**建议：** 使用事务或 try/catch 确保一致性，或在清理逻辑中增加 R2 扫描。

---

## 五、性能分析

### ✅ 优秀实践

| 实践 | 位置 | 说明 |
|------|------|------|
| R2 流式上传 | `index.ts:post('/api/upload')` | `c.req.raw.body` 直接写入 R2，零内存缓冲 |
| R2 流式下载 | `index.ts:get('/api/download/:code')` | `obj.body` 直接返回 Response，不缓冲 |
| CSS 独立缓存 | `index.ts:get('/static/style.css')` | `immutable, max-age=31536000`，浏览器缓存一年 |
| 字体懒加载 | `layout.ts` | `media="print" onload="this.media='all'"` 非阻塞渲染 |
| 背景图预加载 | `layout.ts` | `rel="preload" as="image" fetchpriority="high"` |
| HEAD 请求不计数 | 多个下载接口 | 探测请求跳过 `incrementDownload` |

### ⚠️ 可优化点

1. **`listFiles` 全量 COUNT**：`SELECT COUNT(*)` 在整个表上扫描，文件量大时成为瓶颈。可考虑近似计数或分页裁剪。

2. **`cleanupExpired` 逐条删除**：
   ```typescript
   for (const f of files) {
     await bucket.delete(`file:${f.code}`);  // 串行，N 条文件 = N 次网络请求
   }
   ```
   改为并发：`await Promise.all(files.map(f => bucket.delete(...)))`

3. **首页缓存 300s 但对动态内容不适用**：首页包含上传表单等动态内容，`max-age=300` 可能导致用户看到过时数据（如其他用户刚上传的文件在取件页出现延迟）。不过首页主要是上传入口，取件信息通过 API 获取，影响较小。

---

## 六、与 Cloudflare Workers 最佳实践对照

| 规则 | 状态 | 说明 |
|------|------|------|
| 使用 streaming 处理大文件 | ✅ | R2 直传/直出，无内存缓冲 |
| 不使用 `passThroughOnException` | ✅ | 所有 handler 有 try/catch |
| 不使用 `Math.random()` 做安全相关 | ⚠️ | 取件码用 Math.random，但可接受 |
| 不使用裸 fetch() | ✅ | 所有 async 操作均有 await |
| 不使用模块级可变状态 | ✅ | 无全局可变变量 |
| 使用 `ctx.waitUntil()` | ✅ | scheduled handler 正确使用 |
| 不使用解构 ctx | ✅ | `ctx.waitUntil` 正确调用 |
| 使用 wrangler secret 管理密钥 | ✅ | ADMIN_PASSWORD 通过 Secret 配置 |
| 兼容性日期设置 | ✅ | `2025-08-16`，较新 |
| nodejs_compat flag | ✅ | 启用 |
| 结构化日志 | ⚠️ | 使用 `console.error` 而非结构化 JSON |

---

## 七、问题汇总

### 🔴 必须修复

| # | 问题 | 位置 | 影响 |
|---|------|------|------|
| 1 | 文件名未转义 → Stored XSS | `pages.ts` 3处 | 攻击者可通过恶意文件名劫持用户会话 |
| 2 | Admin token 时序攻击 | `auth.ts:15` | 可逐步推导出 admin_token |
| 3 | 速率限制窗口可被绕过 | `db.ts:checkLoginRateLimit` | 暴力破解攻击者可无限重试 |

### 🟡 建议修复

| # | 问题 | 位置 | 影响 |
|---|------|------|------|
| 4 | 取件码格式无服务端校验 | `index.ts`, `api.ts` | 可提交异常码值 |
| 5 | 孤儿 R2 对象（删除不一致） | `index.ts:delete` | R2 存储空间泄漏 |
| 6 | cleanupExpired 串行删除 | `db.ts:cleanupExpired` | 大量过期文件时清理慢 |
| 7 | 无上传频率限制 | 全项目 | 资源滥用风险 |

### 🟢 可选优化

| # | 问题 | 位置 | 影响 |
|---|------|------|------|
| 8 | 缺少 CSP 头部 | `index.ts` middleware | 防御深度不足 |
| 9 | 两套路由重复逻辑 | `index.ts` vs `api.ts` | 维护成本翻倍 |
| 10 | 结构化日志缺失 | `console.error` 各处 | 生产排障困难 |

---

## 八、总体评价

**代码质量：良好（B+）**

这是一个设计精巧的 Cloudflare Workers 项目：
- 核心架构（流式 I/O、分层设计、过期清理）都很成熟
- 模板渲染有一定设计品味（暖纸墨色主题、OKLCH 色彩、深色模式）
- 近期提交显示团队在持续修复安全问题（`eae0dc3 security: 修复审查发现的 4 项问题`）

**主要风险集中在安全层面：**
1. Stored XSS 是最需要立即修复的问题
2. 时序攻击和速率限制漏洞在公开暴露的服务上具有实际利用价值
3. 其余问题影响较小，可纳入后续迭代

**建议优先处理：** 问题 #1（XSS）、#2（时序攻击）、#3（速率限制）。

---

## 九、修复状态（2026-08-22 已修复）

| # | 问题 | 修复方式 | 改动文件 |  
|---|------|----------|----------|
| 1 | Stored XSS | 新增 `escapeHtml()`，所有模板中的 filename/code/shareUrl 插值均已转义 | utils.ts, pages.ts |
| 2 | 时序攻击 | 新增 `timingSafeCompare()` 常数时间比较替代 === | auth.ts |
| 3 | 速率限制绕过 | 无论是否通过均写入 DB，防止窗口被重置 | db.ts |
| 4 | 取件码格式校验 | 服务端校验自定义码必须为 4 位数字 | index.ts, api.ts |
| 5 | 孤儿 R2 对象 | 删除时并发执行 R2 delete，避免串行失败留下孤儿 | index.ts |
| 6 | cleanupExpired 串行 | 改为 Promise.all 并发删除 R2 对象 | db.ts |
| 7 | 缺少 CSP | 全局中间件添加 Content-Security-Policy 头 | index.ts |
| 8 | Math.random() 取件码 | 改为 crypto.getRandomValues() CSPRNG | utils.ts |

**Diff 统计：** 6 个文件，+95 / -35 行

---

## 十、后续重构（2026-08-28）

### 10.1 消除重复逻辑 — 提取 shared.ts

将 `index.ts` 和 `api.ts` 中重复的上传/下载/文本分享业务逻辑统一收敛到 `src/shared.ts`：

| 函数 | 职责 | 被调用方 |
|------|------|----------|
| `uploadFile()` | 文件上传核心逻辑（校验码→存R2→写D1→记录used） | index.ts `/api/upload`、api.ts `/share/file` |
| `uploadText()` | 文本上传核心逻辑 | index.ts `/api/upload/text`、api.ts `/share/text` |
| `downloadFile()` | 文件下载核心逻辑（查D1→流R2→计数） | index.ts `/api/download/:code`、api.ts `/share/download` |
| `selectFile()` | 文件信息获取（含文本内容） | api.ts `/share/select` |
| `parseExpire()` | 过期策略解析 | shared.ts 内部 |

**改动文件：**
- `src/shared.ts` — 新建，承载全部共享业务逻辑
- `src/index.ts` — 删除内联上传/下载逻辑，改为调用 shared 函数（-160 行）
- `src/api.ts` — 删除内联逻辑与动态 import，改为直接导入 shared（-208 → +90 行，净减少 118 行）

### 10.2 修复取件码重复占用问题（取件码复用）

**需求：** 已删除或已过期的文件，其取件码应释放并允许重新投入使用，避免有限取件码空间被永久占用。

**修复方案：** 在文件删除（手动/过期清理）时调用 `releaseCode()`，从 `fc_used_codes` 中移除该码。

- `releaseCode()`：`DELETE FROM fc_used_codes WHERE code = ?` 释放单个码
- `deleteFileRecord()`：DB 删除成功后调用 `releaseCode(file.code)`
- `cleanupExpired()`：遍历所有过期文件，并发调用 `releaseCode()` 释放所有过期码

**语义变化：** 取件码从"永久占用"变为"占用至文件删除/过期后释放"，4 位码空间得以循环复用。

---

### 10.3 综合代码审查修复（2026-08-28）

| # | 问题 | 修复方式 |
|---|------|----------|
| H1 | `uploadFile` 中 `max_downloads` 参数被忽略 | 读取用户值后，若 `>= 0` 则覆盖 `parseExpire` 的默认值 `-1`，文件/文本两条路径统一 |
| H2 | `Content-Length` 头可伪造绕过大小限制 | `uploadFile` 改用 `c.req.arrayBuffer()` 消费实际字节，以 `body.byteLength` 做校验和存储 |
| H3 | 管理员删除时 R2 失败产生孤儿文件 | 先删 R2，再删 DB；DB 删除用 `finally` 保证执行 |
| M1 | `uploadFile`/`uploadText` 取件码校验重复 | 提取私有函数 `ensureCodeAvailable(rawCode, env)`，复用两段代码 |
| M2 | `parseExpire` 第三个参数 `defaultDays` 冗余 | 移除该参数，`'count'` 分支改用 `expireValue` 作为 defaultDays（语义更清晰） |

**改动文件：**
- `src/shared.ts` — 新增 `ensureCodeAvailable()`，`uploadFile` 改 `arrayBuffer()` 读 body，`parseExpire` 移除 `defaultDays` 参数
- `src/index.ts` — 管理删除改用 `try/finally`（先 R2 后 DB）

---

### 10.4 第 3 轮审查修复（2026-08-28）

| # | 问题 | 修复方式 |
|---|------|----------|
| H1 | `api.ts` `/file/delete` 端点孤儿文件风险 | 改为先删 R2、`deleteFileRecord` 放 `finally`，与 index.ts 管理后台一致；补充 `getFileById` 导入 |
| H2 | `retrievePage` 中取件码未转义，反射型 XSS | `value="${code ?? ''}"` → `value="${escapeHtml(code ?? '')}"` |
| M1 | `parseExpire` `'count'` 分支注释误导 | ⏳ 建议将注释改为「`expireValue` 作为天数计算 `expireAt`，`maxDownloads` 由调用方覆盖」 |
| M2 | `fc_files.ip` 字段从未写入 | ⏳ 建议补充：在 `insertFile` 调用处传入 `CF-Connecting-IP`，或从 schema 移除该列 |
| M3 | `arrayBuffer()` 内存峰值（原来用流式） | ⚠️ 可接受：安全优先于内存优化；长期可改为流式长度测量 |

**改动文件：**
- `src/api.ts` — `/file/delete` 改用 `try/finally`，新增 `getFileById` 导入
- `src/templates/pages.ts` — `retrievePage` 中 `code` 加 `escapeHtml`

---

### 10.5 第 4 轮审查修复（2026-08-28）

| # | 问题 | 修复方式 |
|---|------|----------|
| M1 | `parseExpire` `'count'` 分支注释误导 | 修正注释：`expireValue` 为用户设置的最大下载次数，`expireAt` 用天数计算，`maxDownloads` 由调用方覆盖 |
| M2 | `fc_files.ip` 字段从未写入 | `insertFile` 新增可选参数 `clientIp`，INSERT 语句加入 `ip` 列；`uploadFile`/`uploadText` 传入 `getClientIp(c.req.raw.headers)`；新增 `getClientIp()` 工具函数（utils.ts） |
| M3 | `arrayBuffer()` 整文件驻留内存 | 改用 `TransformStream` 流式读取 body：边读边计数，超限时 abort，结果通过新 stream 传给 R2，内存峰值降至单个 chunk 级别 |

**改动文件：**
- `src/shared.ts` — `uploadFile` 改用 `TransformStream` 流式校验大小，两处调用传入 `clientIp`
- `src/db.ts` — `insertFile` 新增 `clientIp` 参数及 `ip` 列绑定
- `src/utils.ts` — 新增 `getClientIp(headers: Headers)` 工具函数
