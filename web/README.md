# FM26 梦幻选秀网页游戏

## 运行

要求 Node.js 22 或更高版本（Wrangler 4 的最低要求）。首次运行会自动安装锁定版本的比赛引擎依赖；以后可直接启动。

在 Windows PowerShell 中运行：

```powershell
.\start-local.ps1
```

也可以先安装依赖，再使用 Node.js 22 或更高版本直接运行：

```bash
pnpm install
pnpm start
```

默认访问 `http://127.0.0.1:3000`；可通过 `PORT` 环境变量修改端口。
停止服务时，在启动服务的窗口按 `Ctrl+C`。

## 数据边界

- 浏览器只访问 `/api/config` 和 `/api/runs/*` 的公开DTO。
- 服务端从 `../data/server/players-engine.json` 读取FM单项属性，静态目录不包含该文件。
- 未结束的选秀局写入 `runtime/runs.json`，浏览器仅在本机保存32位 `runId` 用于刷新恢复。
- 赛季完成后只能删除当前局并重新选秀，不提供阵容收藏或继续挑战。

## 部署到 Cloudflare

线上只需要 Cloudflare，不需要另购服务器或数据库：

- Worker 负责现有 `/api/*` 接口；`public/` 由 Cloudflare 静态资源直接提供。
- 每个 PVE 存档和 PVP 房间分别保存在独立的 Durable Object 中，避免多人同时操作时互相覆盖。
- PVP 房间创建 24 小时后自动清理；PVE 存档继续支持刷新和跨进程恢复。
- `data/server/players-engine.json` 会进入 Worker 服务端代码包，但不会成为浏览器可访问的静态文件。

本地模拟 Cloudflare 环境：

```bash
pnpm install --frozen-lockfile
pnpm cf:dev
```

默认访问 `http://127.0.0.1:8787`。首次从本机发布时执行：

```bash
pnpm exec wrangler login
pnpm cf:deploy
```

如果使用 Cloudflare 的 Git 集成，把项目根目录设为 `web`，部署命令设为 `pnpm cf:deploy`。`wrangler.jsonc` 已包含静态资源、Durable Object 绑定和首次 SQLite 迁移；不要在控制台另建同名绑定。

上传 Git 前无需手动删除本地文件；根目录 `.gitignore` 已排除 `web/runtime/`、`node_modules/`、`.pnpm-store/`、`.wrangler/` 和本地环境变量文件。

## 检查

```bash
pnpm test
pnpm cf:dry-run
```

检查包括20队双循环赛程、完整380场赛季、公开字段防泄漏、事件与冬窗、PVE/PVP流程，以及 Cloudflare Worker 构建。
