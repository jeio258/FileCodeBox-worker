# FileCodeBox Worker

> 像取快递一样取文件 — Cloudflare Workers 重写版

基于 [FileCodeBox](https://github.com/vastsa/FileCodeBox) 的 Cloudflare Workers 移植版，无需服务器，免费部署在 Cloudflare 边缘网络。

## ✨ 功能

- 📤 **上传文件** — 拖拽/粘贴/多选；获取 4 位纯数字取件码，存入 R2（>100MB 自动分片，上限后台可调，默认 300MB）
- 🧩 **R2 原生分片** — 30MiB/片，3 路并发、单片重试、断点续传（status 跳过已传片）；对外仍是 `upload_id/total_chunks`
- 🔢 **批量连号** — 多文件时服务端分配连号取件码（独立限流 3 次/分）
- 🖼️ **图片缩略图** — 浏览器端生成 webp（≤128KB），取件页预览；每文件一次、删除/过期级联
- 📝 **文本分享** — 粘贴文本即得取件码，页面内直接阅读
- 📥 **取件与下载** — 四格取件码填满自动提交；达上限后标题遮蔽 `***`
- 🔐 **管理面板** — 列表/筛选/排序/删除/清理；统计已用与上限；系统设置页
- ⚙️ **系统设置（存 D1）** — 单文件上限、默认有效期、全站总配额、游客上传、Turnstile；保存即生效，部署不覆盖
- 🚧 **配额与限流** — 全站存储配额（507）、上传 10 次/分、登录 5 次/分、失败查询 5 次/分
- ⏰ **自动过期** — 到期清理 R2（含缩略图）+ D1 + 取件码；Cron 每 30 分钟
- 🎨 **zinc 版式** — 中性配色 + 随机图背景（t.alcy.cc），深色模式
- 🔌 **开放 API** — 兼容 FileCodeBox v2.1.0，免登录游客上传（可关闭）

## 🛡️ 安全特性

经过多轮代码审查加固，具备以下安全能力：

- **XSS 防护** — 所有用户输入经 `escapeHtml()` 转义
- **密码安全** — PBKDF2 10 万次迭代哈希 + 常数时间比较（防时序攻击）
- **登录限流** — 60 秒窗口内最多 5 次尝试（按客户端 IP）
- **取件码安全** — CSPRNG 生成 + 防碰撞检测 + 删除/过期后释放复用
- **SQL 注入防护** — 全部使用参数化查询
- **CSP 安全头** — 限制资源加载来源，降低 XSS 影响面
- **文件删除顺序** — R2 先删、DB 兜底（try/finally），避免孤儿文件

## 📦 部署方式

### 方式一：Wrangler CLI 部署（推荐本地开发）

#### 1. 准备工作

- [Cloudflare 账号](https://dash.cloudflare.com/sign-up)
- [Node.js 18+](https://nodejs.org/)

#### 2. 安装 Wrangler 并登录

```bash
npm install -g wrangler
wrangler login
```

#### 3. 克隆项目 & 安装依赖

```bash
git clone https://github.com/jeio258/FileCodeBox-worker.git
cd FileCodeBox-worker
npm install
```

#### 4. 创建云资源

```bash
# 创建 R2 存储桶
wrangler r2 bucket create filecodebox

# 创建 D1 数据库
wrangler d1 create filecodebox-db
# 返回类似: database_id = "def456..."  ← 记下来
```

#### 5. 配置 wrangler.jsonc

将上一步获得的 D1 ID 填入 `wrangler.jsonc`：

```jsonc
{
  "r2_buckets": [
    { "binding": "FILE_STORE", "bucket_name": "filecodebox" }
  ],
  "d1_databases": [
    { "binding": "DB", "database_name": "filecodebox-db", "database_id": "你的D1_ID" }
  ]
}
```

> 无需配置 `vars`：单文件上限、默认有效期、全站配额、游客上传、Turnstile 都在
> **后台 → 系统设置** 里调整（存 D1，保存即生效，部署不会覆盖）。

#### 6. 设置管理员密码（Secret，不写入配置）

```bash
wrangler secret put ADMIN_PASSWORD
# 输入你的管理员密码
```

#### 7. 部署

```bash
npm run deploy
```

表结构由 Cron（每 30 分钟）幂等初始化，首次部署后无需手动建表；也可用管理员身份访问 `/api/init`。
部署后访问 `/api/status` 确认生效配置与 `adminPasswordConfigured`。

---

### 方式二：Cloudflare Dashboard Git 集成（自动部署）

#### 1. Fork 本项目到自己的 GitHub

#### 2. 在 Cloudflare Dashboard 操作

1. 进入 **Workers & Pages** → **创建** → **Pages** → **连接到 Git**
2. 选择你的仓库，构建设置：
   - **构建命令**：`npm install`
   - **输出目录**：留空
3. 点击保存，首次部署会失败（缺少 R2 / D1 绑定）—— 这是正常的

#### 3. 绑定资源

部署后进入项目 **Settings** → **Bindings**：

**R2 存储桶绑定：**
| Binding | 说明 |
|---------|------|
| `FILE_STORE` | 新建一个 R2 存储桶，命名为 `filecodebox` |

**D1 数据库绑定：**
| Binding | 数据库 |
|---------|--------|
| `DB` | 新建一个 D1 数据库（命名为 `filecodebox-db`）|

**Secret（管理员密码）：**
| Secret | 说明 |
|--------|------|
| `ADMIN_PASSWORD` | 你的管理员密码 |

#### 4. 重新部署

绑定资源后，在 Pages 项目页面点击 **重新部署**（或推送新 commit 自动触发）。

#### 5. 确认状态

部署完成后访问 `https://你的域名/api/status`：`ok: true` 且 `adminPasswordConfigured: true` 即就绪（表结构由 Cron 幂等创建，无需手动初始化）。

---

### 常见问题

#### Build token 过期

```
Failed: The build token selected for this build has been deleted or rolled
```

在 Cloudflare Dashboard → **Workers & Pages** → 你的项目 → **Settings** → **Builds** → 重新生成 Build token 并重试部署。

#### 绑定自定义域名

Pages 项目 → **Custom domains** → 添加你的域名（需 DNS 已托管在 Cloudflare）。

---

## 🔌 API 接口

项目提供两套 API：**Web UI 接口**（页面交互）和 **FileCodeBox 兼容 API**（程序调用）。

### FileCodeBox 兼容 API（v2.1.0）

兼容 [FileCodeBox API v2.1.0](https://fcb-docs.aiuo.net/api/)，统一响应格式 `{ code, msg, detail }`。

#### 分享接口（默认免登录，可配置关闭）

```bash
# 上传文件
curl -X POST "https://你的域名/share/file/?expire_value=1&expire_style=day" \
  -H "X-Filename: example.txt" \
  --data-binary @example.txt

# 分享文本（表单）
curl -X POST "https://你的域名/share/text/" \
  -F "text=要分享的内容" -F "expire_value=1" -F "expire_style=day"

# 获取文件信息
curl "https://你的域名/share/select/?code=1234"

# 下载文件
curl "https://你的域名/share/download?code=1234"
```

**expire_style** 支持：`day` / `hour` / `minute` / `count`（限下载次数）/ `forever`

#### 管理接口（需 Bearer token）

```bash
# 登录获取 token（JSON 响应）
curl -X POST "https://你的域名/admin/login" \
  -H "Content-Type: application/json" \
  -d '{"password":"你的密码"}'
# 返回 { code: 200, msg: "success", detail: { token: "xxx", token_type: "Bearer" } }

# 仪表盘
curl "https://你的域名/admin/dashboard" \
  -H "Authorization: Bearer <token>"

# 文件列表（分页 + 关键词搜索）
curl "https://你的域名/admin/file/list?page=1&size=10&keyword=xxx" \
  -H "Authorization: Bearer <token>"

# 删除文件
curl -X DELETE "https://你的域名/admin/file/delete?id=123" \
  -H "Authorization: Bearer <token>"

# 获取配置
curl "https://你的域名/admin/config/get" \
  -H "Authorization: Bearer <token>"

# 更新配置（PATCH）
curl -X PATCH "https://你的域名/admin/config/update" \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"openUpload":"1","maxFileSize":"314572800","defaultExpireDays":"7"}'
```

---

### Web UI 接口（页面交互）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/` | 首页（上传 + 取件）|
| GET | `/r/:code` | 取件页（文件详情/文本查看）|
| GET | `/api/status` | 运行状态（公开：生效配置 + 密码是否就绪）|
| POST | `/api/upload` | 文件上传（XHR，返回 JSON `{code, filename, size}`）|
| POST | `/api/upload/text` | 文本上传（表单，返回 HTML 结果页）|
| POST | `/api/upload/chunk/init` | 分片上传初始化（JSON）|
| PUT | `/api/upload/chunk/:upload_id/:index` | 上传单个分片（原始字节）|
| GET | `/api/upload/chunk/status/:upload_id` | 已上传分片（断点续传）|
| POST | `/api/upload/chunk/complete/:upload_id` | 合并分片并返回取件码 |
| POST | `/api/upload/chunk/abort/:upload_id` | 取消并释放取件码 |
| GET | `/api/text/:code` | 获取文本内容 |
| GET | `/api/download/:code` | 下载文件（带 Content-Disposition）|
| GET | `/api/info/:code` | 文件信息（JSON）|
| GET | `/admin` | 管理面板（受保护）|
| POST | `/admin/login` | 浏览器登录（表单，302 重定向）|
| GET | `/admin/logout` | 登出并清除会话 |
| POST | `/admin/delete/:id` | 删除文件（表单）|
| POST | `/admin/cleanup` | 手动清理过期文件 |
| GET | `/api/init` | 初始化数据库表（需管理员）|

> **注意**：浏览器登录走 `POST /admin/login`（表单），程序调用走 `POST /api/admin/login`（JSON，返回 Bearer token）；两者共享同一密码与限流。

---

## 🧑‍💻 使用

| 页面 | 路径 | 说明 |
|------|------|------|
| 首页 | `/` | 上传文件 + 文本分享 + 取件码输入 |
| 取件 | `/r/1234` | 文件详情 / 文本查看 + 下载 |
| 管理 | `/admin` | 管理员登录 |

### Cron 定时清理

项目已内置 `scheduled` handler，在 wrangler.jsonc 的 `triggers.crons` 中配置：

```jsonc
"triggers": { "crons": ["*/30 * * * *"] }
```

## ⚙️ 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `ADMIN_PASSWORD` | - | 管理员密码（**Secret**，`wrangler secret put` 设置） |

### 配置优先级（重要）

```
D1 fc_settings（管理端可改，部署不丢）  >  env / wrangler.jsonc（缺值兜底）  >  内置默认
```

- `wrangler deploy` **会以 `wrangler.jsonc` 为唯一来源覆盖普通变量**，控制台手动添加的明文变量会被清除；只有 `wrangler secret put` 的 Secret 不受影响。
- 因此：`ADMIN_PASSWORD` 用 Secret；最大文件大小 / 默认过期天数 / 游客开关用管理端 API（存 D1），部署不会回退。
- 密码兜底：Secret 缺失时使用 D1 中 `admin_password_hash`（`POST /api/admin/password` 写入），避免部署后无法登录。
- 部署后访问 `GET /api/status` 可立即确认 `adminPasswordConfigured` 与生效配置。

## 📁 项目结构

```
FileCodeBox-worker/
├── src/
│   ├── index.ts               # 入口：中间件、惰性建表、路由装配、Cron
│   ├── types.ts               # 领域模型 / DB 行 / Env
│   ├── utils.ts               # 常量、错误类型、文本/哈希/IP/key 等纯函数
│   ├── db.ts                  # D1 数据层（行 ↔ 领域模型映射唯一处）
│   ├── storage.ts             # R2 存储层（multipart 写入器、分片对象）
│   ├── config.ts              # 运行配置（D1 设置 > env > 默认）
│   ├── expire.ts              # 过期策略（字段别名与换算唯一处）
│   ├── auth.ts                # 认证：密码来源、会话、上传门控
│   ├── files.ts               # 读取域：取件解析/下载响应/删除/孤儿清理
│   ├── upload.ts              # 写入域：普通/文本/分片上传与超时回收
│   ├── maintenance.ts         # Cron 编排（唯一维护入口）
│   ├── respond.ts             # 响应层：json/html/compat 三种出口 + 参数提取
│   ├── qr.ts                  # 二维码
│   ├── routes/
│   │   ├── web.ts             # Web 路由（页面/上传/下载/管理/自检）
│   │   └── compat.ts          # FileCodeBox v2.1.0 兼容 API（挂载 /api）
│   └── templates/
│       ├── layout.ts          # HTML 布局
│       ├── style.ts           # 暖纸墨色设计系统 CSS
│       └── pages.ts           # 页面模板
├── scripts/
│   ├── preflight.mjs          # 部署前检查（Secret 是否仍在）
│   ├── smoke.mjs              # 部署后冒烟（打真实域名，7 项）
│   └── browser-test.mjs       # 无头浏览器端到端测试
├── wrangler.jsonc
├── tsconfig.json
└── package.json
```

## 🏗️ 架构设计

- **分层单向依赖**：`utils` → `db`/`storage` → `config`/`expire` → `files`/`upload` → `auth` → `respond` → `routes/*` → `index`。路由只做参数与响应转换，业务逻辑单一实现
- **命名边界**：数据库行为 snake_case（仅 `db.ts` 内），对外一律 camelCase 领域模型；线缆字段维持既有契约
- **配置单一来源**：上限/有效期/配额/开关只存 D1 设置（后台可改），代码内置默认值兜底；不再读取部署变量
- **上传实现**：普通上传零拷贝（请求体直接交给 R2，字节不过 JS，缺 `Content-Length` 返回 411）；>100MB 走 R2 原生 multipart 分片（30MiB/片，etag 存 D1，complete 不再读回重写）
- **响应与错误**：`respond.ts` 统一 json/html/compat 三种出口；业务错误 `HttpError`，未知异常掩码并记录
- **测试**：`npm run smoke <域名>` 打真实地址 7 项；`scripts/browser-test.mjs` 端到端
- **取件码复用机制**：原子抢占（`claimCode`）+ 删除/过期/取消后 `releaseCode` 释放，可循环使用
- **下载计数**：`incrementDownload` 原子更新，避免并发超限；HEAD 不计数
- **过期清理**：Cron 每 30 分钟清理过期文件、孤儿 R2 对象、限流键、超时分片任务

## 🔧 技术栈

- **框架**: [Hono](https://hono.dev/)
- **数据库**: Cloudflare D1 (SQLite)
- **存储**: Cloudflare R2
- **运行时**: Cloudflare Workers
- **语言**: TypeScript（严格模式）

## 📄 许可

MIT License
