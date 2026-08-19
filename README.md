# FileCodeBox Worker

> 像取快递一样取文件 — Cloudflare Workers 重写版

基于 [FileCodeBox](https://github.com/vastsa/FileCodeBox) 的 Cloudflare Workers 移植版，无需服务器，免费部署在 Cloudflare 边缘网络。

## ✨ 功能

- 📤 **上传文件** — 获取 4 位纯数字取件码，R2 流式直传（支持大文件）
- 📝 **文本分享** — 粘贴文本即可生成分享链接，页面内直接查看
- 📥 **取件下载** — 输入取件码下载文件或查看文本
- 🔐 **管理面板** — 查看/删除/清理文件，登录速率限制
- ⏰ **自动过期** — 文件到期自动清理（Cron 定时触发）
- 🎨 **暖纸墨色设计** — 琥珀色调 + 文学感排版，支持深色模式
- 🔌 **开放 API** — 兼容 FileCodeBox v2.1.0，免登录游客上传

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
  ],
  "vars": {
    "MAX_FILE_SIZE": "104857600",
    "DEFAULT_EXPIRE_DAYS": "7"
  }
}
```

#### 6. 设置管理员密码（Secret，不写入配置）

```bash
wrangler secret put ADMIN_PASSWORD
# 输入你的管理员密码
```

#### 7. 部署

```bash
npm run deploy
```

首次部署后访问 `/api/init` 初始化数据库表。

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

#### 5. 初始化数据库

部署成功后，访问 `https://你的域名/api/init` 初始化数据库表，返回 `{"ok":true}` 即成功。

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

兼容 [FileCodeBox API v2.1.0](https://fcb-docs.aiuo.net/api/)，统一响应格式 `{ code, msg, detail }`。

### 分享接口（默认免登录）

```bash
# 上传文件（R2 流式直传，元数据走 header/query）
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

### 管理接口（需 Bearer token）

```bash
# 登录获取 token
curl -X POST "https://你的域名/admin/login" \
  -H "Content-Type: application/json" \
  -d '{"password":"你的密码"}'

# 仪表盘
curl "https://你的域名/admin/dashboard" -H "Authorization: Bearer <token>"

# 文件列表
curl "https://你的域名/admin/file/list?page=1&size=10&keyword=xxx" \
  -H "Authorization: Bearer <token>"
```

完整接口：`/admin/login`、`/admin/dashboard`、`/admin/file/list`、`/admin/file/delete`、`/admin/config/get`、`/admin/config/update`、`/share/text/`、`/share/file/`、`/share/select/`、`/share/download`

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
| `MAX_FILE_SIZE` | `104857600` | 最大文件大小 (100MB) |
| `DEFAULT_EXPIRE_DAYS` | `7` | 默认过期天数 |

## 📁 项目结构

```
FileCodeBox-worker/
├── src/
│   ├── index.ts               # 主程序 — 路由定义
│   ├── api.ts                 # FileCodeBox 兼容 API
│   ├── auth.ts                # 认证: 登录/登出/速率限制
│   ├── db.ts                  # 数据库: 增删改查 + 限流
│   ├── types.ts               # 类型定义
│   ├── utils.ts               # 工具: 取件码/哈希/格式化
│   └── templates/
│       ├── layout.ts          # HTML 布局
│       ├── style.ts           # 暖纸墨色设计系统 CSS
│       └── pages.ts           # 页面模板
├── wrangler.jsonc             # Cloudflare 配置
├── tsconfig.json
└── package.json
```

## 🔧 技术栈

- **框架**: [Hono](https://hono.dev/)
- **数据库**: Cloudflare D1 (SQLite)
- **存储**: Cloudflare R2
- **运行时**: Cloudflare Workers
- **语言**: TypeScript

## 📄 许可

MIT License
