# FM26 梦幻选秀

当前核心循环为“选择阵型与球队风格 → 11轮随机池券选秀并当场落位 → 逐轮进行38轮英超赛季 → 处理赛季事件与冬窗决定 → 查看排名、逐场评分和赛季总结”。

## 目录
- `data/client/players-public.json`：前端安全原始数据，只含身份、位置和八维概览等公开字段；历史价格池仅用于离线筛选，不进入玩法DTO。
- `data/server/players-engine.json`：服务端权威数据，含完整FM原始属性、能力和价格模型。
- `data/manual/player-position-maintenance.csv`：全部外场球员的位置人工维护表；修改后用脚本同步到运行数据。
- `config/rating-config.json`：八维公式和轴顺序。
- `config/draft-pools.json`：900人运行时白名单、三个选秀池、池券权重和位置覆盖统计。
- `config/balance-config.json`：选秀、阵容、化学、状态、战术和赛季流程。
- `config/opponents.json`：2025/26英超20队聚合模板；每局由玩家随机替代其中一队。
- `config/gameplay-config.json`：球队强度、预期进球、战术、射手/助攻和评分的主要可调参数。
- `docs/TUNING_GUIDE.md`：可手动修改参数的中文说明。
- `docs/API_CONTRACT.md`：服务端权威选秀局、赛季模拟接口和禁止泄露字段。
- `docs/RATING_MODEL.md`：八维计算公式。
- `review/FM26_开发正式底库_v6.xlsx`：当前人工审核底库，不是前端运行数据；v5仅保留作历史版本。
- `web/`：可运行网页游戏；本地使用 Node.js，线上可直接部署到 Cloudflare Workers + Durable Objects。

## 批量修改球员位置

用Excel打开`data/manual/player-position-maintenance.csv`，只修改“最佳位置 / 第二位置 / 其他可用位置”三列，然后在项目根目录运行：

```powershell
node scripts/player-position-maintenance.mjs --apply
node scripts/player-position-maintenance.mjs --check
```

位置脚本会按ID同步服务端CSV、前端公开JSON和服务端引擎JSON，并拒绝非法位置、跨档重复、姓名错配以及误删定价位置。详细说明见`data/manual/README.md`。

## 本地启动
进入 `web` 目录后，在 Windows PowerShell 运行：

```powershell
.\start-local.ps1
```

默认地址为 `http://127.0.0.1:3000`，停止时在启动窗口按 `Ctrl+C`。本地运行记录写入 `web/runtime/`，该目录已排除在 Git 之外；浏览器只保存当前 `runId`。

Cloudflare 部署步骤与架构说明见 [`web/README.md`](web/README.md)。

## 强制原则
1. 首页只选择阵型；每局独立生成11张随机池券，没有预算和身价玩法。
2. 选秀卡展示八维雷达图和8项数值；FM原始单项属性不在玩家可见界面出现。
3. 浏览器端不得加载、打包或请求 `players-engine.json`。
4. 比赛引擎以服务端FM原始属性做事件判定，八维不得替代底层属性。
5. 20队主客场双循环共38轮；玩家均匀随机替代一支英超队，其余19队由AI控制。
6. 阵容只有11名首发，无替补、换人、红黄牌和伤病；赛季开始前只设置一次战术。
7. 当前一局支持刷新恢复；重新游玩必须重新选秀。
