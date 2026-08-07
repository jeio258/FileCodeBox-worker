# FileCodeBox Worker

> 像取快递一样取文件 — Cloudflare Workers 重写版

基于 [FileCodeBox](https://github.com/vastsa/FileCodeBox) 的 Cloudflare Workers 移植版，无需服务器，免费部署在 Cloudflare 边缘网络。

## ✨ 功能

- 📤 **上传文件** — 获取 4 位纯数字取件码，支持大文件分片上传（>25MB）
- 📝 **文本分享** — 粘贴文本即可生成分享链接，页面内直接查看
- 📥 **取件下载** — 输入取件码下载文件或查看文本
- 🔐 **管理面板** — 查看/删除/清理文件，登录速率限制
- ⏰ **自动过期** — 文件到期自动清理，支持 Cron 定时触发
- 🎨 **暖纸墨色设计** — 琥珀色调 + 文学感排版，支持深色模式

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
# 创建 KV 命名空间
wrangler kv namespace create FILE_STORE
# 返回类似: id = "abc123..."  ← 记下来

# 创建 D1 数据库
wrangler d1 create filecodebox-db
# 返回类似: database_id = "def456..."  ← 记下来
```

#### 5. 配置 wrangler.jsonc

将上一步获得的 ID 填入 `wrangler.jsonc`：

```jsonc
{
  "kv_namespaces": [
    { "binding": "FILE_STORE", "id": "你的KV_ID" },
    { "binding": "KV", "id": "你的KV_ID" }
  ],
  "d1_databases": [
    { "binding": "DB", "database_name": "filecodebox-db", "database_id": "你的D1_ID" }
  ],
  "vars": {
    "ADMIN_PASSWORD": "admin123",      // ← 部署后记得修改
    "MAX_FILE_SIZE": "104857600",
    "DEFAULT_EXPIRE_DAYS": "7"
  }
}
```

#### 6. 部署

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
3. 点击保存，首次部署会失败（缺少 KV / D1）—— 这是正常的

#### 3. 绑定资源

部署后进入项目 **Settings** → **Bindings**：

**KV 命名空间绑定：**
| Binding | 命名空间 |
|---------|---------|
| `FILE_STORE` | 新建一个 KV |
| `KV` | 同上（指向同一个 KV） |

**D1 数据库绑定：**
| Binding | 数据库 |
|---------|--------|
| `DB` | 新建一个 D1 数据库（命名为 `filecodebox-db`）|

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

## 🧑‍💻 使用

| 页面 | 路径 | 说明 |
|------|------|------|
| 首页 | `/` | 上传文件 + 文本分享 + 取件码输入 |
| 取件 | `/r/1234` | 文件详情 / 文本查看 + 下载 |
| 管理 | `/admin` | 管理员登录，默认密码 `admin123` |
| Cron 清理 | `/api/cron/cleanup` | 在 Cloudflare Dashboard 中设置 Cron 触发器定期访问 |

### Cron 定时清理（可选）

在 Cloudflare Dashboard → Workers & Pages → 你的项目 → **Settings** → **Cron Triggers** 中添加：

```
*/30 * * * *    # 每 30 分钟清理一次过期文件
```

## ⚙️ 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `ADMIN_PASSWORD` | `admin123` | 管理员密码（首次登录后自动哈希存入 DB） |
| `MAX_FILE_SIZE` | `104857600` | 最大文件大小 (100MB) |
| `DEFAULT_EXPIRE_DAYS` | `7` | 默认过期天数 |

## 📁 项目结构

```
FileCodeBox-worker/
├── src/
│   ├── index.ts               # 主程序 — 路由定义
│   ├── auth.ts                # 认证: 登录/登出/速率限制
│   ├── db.ts                  # 数据库: 增删改查 + 分片上传
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
- **存储**: Cloudflare KV
- **运行时**: Cloudflare Workers
- **语言**: TypeScript

## 📄 许可

MIT License
