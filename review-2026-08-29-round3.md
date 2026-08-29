# FileCodeBox-worker Code Review（第三轮 · 2026-08-29）

## 审查方式
本次采用**无头浏览器真实测试**（Playwright + Chromium），模拟真实用户操作，验证完整业务流程。

---

## 🧪 无头浏览器测试结果

| 测试项 | 结果 | 说明 |
|--------|------|------|
| 首页加载 | ✅ 200 | 标题、上传表单、文本面板、取件输入框均正常 |
| 文本上传 | ✅ 成功 | 提交后返回取件码 9434 |
| 文本取件查看 | ✅ 成功 | 文本内容正确加载（`textContent` 赋值） |
| 文件上传 | ✅ 成功 | 取件码 9043，XHR 上传 |
| 文件下载 | ✅ 成功 | 下载文件名 `test_headless.txt` 正确 |
| 管理面板 | ✅ 200 | 未登录正确显示登录表单 |
| 不存在取件码 | ✅ 200 | 正确返回取件表单 |

**结论**：所有核心功能在真实浏览器中正常工作。

---

## 🔴 发现并修复的问题

### H1: `parseInt` 返回 NaN 导致 Invalid Date（500 错误）

**位置**: `src/shared.ts` — `uploadFile` 和 `uploadText`

**问题**：`parseInt(c.req.query('expire_days') || '7')` 在非法输入（如 `expire_days=abc`）时返回 `NaN`，随后 `parseExpire(NaN, 'day')` 计算 `new Date(now + NaN * 86400000)` 抛出 `RangeError: Invalid time value`，导致 500 错误。

**验证**：
```bash
# 修复前：expire_days=abc → 500 RangeError
# 修复后：expire_days=abc → 回退默认值，正常上传
{"code":"1111","filename":"test.txt","size":4}
```

**修复**：添加 `Number.isFinite()` 校验，NaN 回退到默认值。

---

### H2: `decodeURIComponent` 非法编码抛出 URIError

**位置**: `src/shared.ts` — `uploadFile`

**问题**：`decodeURIComponent(c.req.header('X-Filename'))` 在非法 URI 编码（如 `%ZZ`）时抛出 `URIError`，导致 500 错误。

**验证**：
```bash
# 修复前：X-Filename: %ZZ%bad → 500 URIError
# 修复后：X-Filename: %ZZ%bad → 回退原始字符串
{"code":"3333","filename":"%ZZ%bad","size":4}
```

**修复**：用 `try/catch` 包裹，失败时保留原始头值。

---

### M1: `/r` 取件页使用 max-age=300 缓存（500 缓存风险）

**位置**: `src/index.ts:121`

**问题**：与首页相同的 CDN 缓存 500 响应问题。`/r` 路由使用 `public, max-age=300`，可能缓存错误响应。

**修复**：改为 `no-store`，与首页、详情页保持一致。

---

## ⚠️ 良性发现（无需修复）

### 1. CSP 阻止 Cloudflare Insights beacon

**现象**：控制台出现 CSP violation 错误，`static.cloudflareinsights.com/beacon.min.js` 被阻止。

**原因**：Cloudflare 边缘自动注入 Web Analytics 脚本，但我们的 CSP `script-src 'self' 'unsafe-inline'` 阻止了它。

**结论**：这是**正确且安全**的行为。CSP 正常工作，阻止了第三方脚本注入。如果用户未启用 Cloudflare Web Analytics，此脚本根本不会出现；如果启用了，分析统计会失效，但不影响核心功能。

---

## ✅ 安全审计复核

| 检查项 | 结论 |
|--------|------|
| XSS 防护 | ✅ 文本内容用 `textContent` 赋值，不执行 HTML |
| 文件名 XSS | ✅ `escapeHtml` 转义 |
| 取件码 XSS | ✅ `escapeHtml` 转义 |
| 非法输入处理 | ✅ 本轮修复（NaN/URIError 回退） |
| 缓存策略 | ✅ 所有动态页面 `no-store`，仅静态资源长缓存 |

---

## 本轮修改汇总

| 文件 | 修改内容 |
|------|----------|
| `src/index.ts` | `/r` 路由改用 `no-store`（防 500 缓存） |
| `src/shared.ts` | `parseInt` NaN 校验（uploadFile + uploadText） |
| `src/shared.ts` | `decodeURIComponent` try/catch 包裹 |

## 测试脚本

`test-headless.mjs` — Playwright 无头浏览器完整流程测试，可重复运行验证。
