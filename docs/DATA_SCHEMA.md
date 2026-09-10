# DATA_SCHEMA v6

## 球员数据分层

### 前端安全数据：`data/client/players-public.json`
允许下发身份、国家/俱乐部/联赛、年龄/身高/惯用脚、登记位置、八维概览和运行时选秀池。禁止包含 `fmAttributes`、`ability`、FM身价解析、数据质量、价格模型或预算字段。

### 服务端权威数据：`data/server/players-engine.json`
包含完整 `fmAttributes`、八维预计算值、位置能力和定价模型。仅服务端选秀、预处理和比赛引擎读取。

## 位置唯一性
```ts
type PositionTiers = { primary:string[]; secondary:string[]; other:string[] };
```

三个数组内部及数组之间必须唯一。清洗顺序为：
1. `primary = unique(primary)`；
2. `secondary = unique(secondary) - primary`；
3. `other = unique(other) - primary - secondary`。

`positionDisplay` 必须与代码数组同步；`originalPositions` 保留FM原始文本供审核，不作为运行时位置资格。

## 八维字段
```ts
type OutfieldSummaryRatings = {
  射门:number; 传球:number; 控球:number; 防守:number;
  速度:number; 身体:number; 意识:number; 意志:number;
};
type GoalkeeperSummaryRatings = {
  扑救:number; 一对一:number; 制空:number; 指挥:number;
  出击:number; 出球:number; 身体:number; 精神:number;
};
```

八维范围0—100、保留1位小数，仅供玩家概览。比赛读取服务端FM原始属性。

## 选秀局
```ts
type DraftRun = {
  runId:string;
  status:'drafting'|'lineup'|'season_running'|'season_complete';
  formationId:string;
  draftVersion:3;
  replacedClubId:string;
  selectedPlayerIds:string[];
  poolSequence:Array<'legend'|'star'|'player'>; // 仅服务端保存
};
```

该对象由服务端权威保存。客户端不得自行提交池券、已选集合，也不能读取未揭晓的后续池券。

## 阵容
```ts
type Lineup = {
  starters:Array<{slotId:string; position:string; playerId:string}>;
  tacticId:string;
};
```

阵容固定为11名球员和11个首发槽，没有替补字段。

## 英超赛季
`config/opponents.json` 保存2025/26英超20队聚合模板。每局从中随机选择一个 `replacedClubId`，玩家与其余19队组成20队联赛。

```ts
type StandingsRow = {
  clubId:string; isPlayer:boolean;
  played:number; won:number; drawn:number; lost:number;
  goalsFor:number; goalsAgainst:number; goalDifference:number; points:number;
};

type PlayerSeasonStats = {
  playerId:string; appearances:number; starts:number; minutes:number;
  goals:number; assists:number; averageRating:number;
  goalsConceded?:number; cleanSheets?:number; saves?:number;
};
```

每队38场，全联赛380场。已完成阵容不跨局保存；未结束的一局通过 `runId` 恢复。

## 单位
- 化学、状态、战术：百分比数值。
- FM原始属性：1—20，仅服务端可见。
- 八维概览：0—100，前端可见。
