# API_CONTRACT v3.0

浏览器只持有当前 `runId` 和公开DTO。服务器保存选秀池券、已选球员、阵容、战术、赛程与结果；浏览器不得加载 `players-engine.json`，也不能指定池券或声明选秀结果。

## 创建选秀局

`POST /api/runs`

```ts
{ formationId: string }
```

服务器校验阵型，随机选择一个2025/26英超球队槽位供玩家替代，并在内部生成11张随机池券。未来PVP应由同一个房间生成一条池券序列并写入双方选秀局。

## 揭晓池券并获取候选

`POST /api/runs/:runId/draft/candidates`

请求体为空对象：`{}`。

客户端不能提交池类型或指定位置。服务器按当前轮内部池券，从900人白名单的对应池中随机返回最多5人。所有候选至少能填补当前阵型的一个空缺槽位。当前候选未选前再次请求返回409。

响应：

```ts
{
  voucher: { round: number; pool: 'legend'|'star'|'player'; label: string };
  candidates: PublicPlayer[];
}
```

`PublicPlayer`只允许身份、公开位置、八维与 `draftPool` / `draftPoolDisplay`。禁止 `fmAttributes`、`ability`、价格模型、身价和预算字段。

## 选择并落位

`POST /api/runs/:runId/draft/picks`

```ts
{ playerId: string; slotId: string }
```

服务器验证球员属于当前候选、尚未入队、槽位为空且球员登记位置兼容，然后原子写入已选阵容与首发槽位并清空本轮候选。

## 阵容、赛季与恢复

- `PUT /api/runs/:runId/lineup/draft`：保存选秀中的首发位置调整和战术。
- `PUT /api/runs/:runId/lineup`：验证正好11名合法首发后锁定阵容。
- `POST /api/runs/:runId/season/simulate`：生成20队、38轮、380场赛季。
- `POST /api/runs/:runId/season/advance`：逐轮展示下一轮战况。
- `GET /api/runs/:runId`：刷新恢复当前局；不会返回尚未揭晓的后续池券。
- `GET /api/runs/:runId/season`：返回当前轮次、积分榜、比赛与球员统计。
- `DELETE /api/runs/:runId`：删除当前局并重新开始。

旧预算规则存档保留在本地记录中，但标记为 `legacyRules: true`，不能继续出人，玩家需重新开始。
