# 手动调参指南

修改JSON后必须重启本地服务。JSON不能写注释，最后一项后面不能多逗号；修改前建议先复制备份。

## 比赛参数：`config/gameplay-config.json`

### `teamRatingScale`

玩家与AI都使用相同的0—100球队评级范围。传奇池、球星池和球员池只是选秀来源，不产生额外比赛加成；强弱完全由球员底层数值、位置、化学、状态和战术计算。

### `playerAttributeGroups`

这里列出球队四维实际读取的FM单项属性。外场进攻、创造、防守、身体，以及门将扑救、出球、身体都能直接增删属性名；同组属性当前等权平均。`attributePointScale`默认5，把FM 1—20转换到0—100，通常不要单独提高它来给玩家队加成；如果修改，必须同步重新标定AI四维。

### `teamRatingWeights`

| 区域 | 参数 | 当前占比 | 说明 |
|---|---|---:|---|
| 进攻 | `positionalAttack` / `allCreation` | 0.72 / 0.28 | 前场相关FM进攻属性与全队创造力 |
| 中场 | `positionalCreation` / `allPhysical` | 0.68 / 0.32 | 中场创造力与全队身体 |
| 防守 | `positionalDefense` / `allPhysical` | 0.76 / 0.24 | 后场防守属性与全队身体 |

每组两项建议合计为1。提高某项只改变对应真实属性在球队评级中的占比，不应当用它给玩家队统一加分。

### `expectedGoals`

| 参数 | 作用 |
|---|---|
| `base` | 全联赛基础进球期望；提高会让比分整体变大 |
| `attackVsDefenseDivisor` | 越小，进攻与防守差距对进球影响越大 |
| `midfieldReference/Divisor` | 中场对预期进球的基准与幅度 |
| `goalkeeperReference/Divisor` | 门将对失球的基准与幅度 |
| `homeAdvantage` | 主队额外预期进球 |
| `minimum/maximum` | 单队单场预期进球上下限 |

想让比赛略多进球，可把`base`每次提高0.05测试；想减少大比分，降低`maximum`或提高两个`Divisor`。

### `tacticRatingAdjustments`

每种战术直接调整`attack/midfield/defense`，玩家和使用该战术的AI规则完全相同。例如摆大巴当前为进攻-4、中场-2、防守+5。建议单项保持在-8—+8内，收益必须伴随代价。

### `aiTeamForm`

控制AI每场临场波动。所有`probabilityPct`必须合计100；缩小正负`modifier`会让赛季更稳定，放大会增加爆冷。玩家状态在`balance-config.json`里单独配置。

### `aiTeamStrengthSpread`与`aiTeamSeasonForm`

- `aiTeamStrengthSpread.reference`是不扩张的中轴，`multiplier`只拉开AI球队原始四维的差距，不给任何球队凭空加成；1表示保持原值，当前1.45用于让争冠、保级球队的积分与净胜球通过同一比赛模型自然拉开。
- `aiTeamSeasonForm`每个赛季为每支AI球队抽取一次并保持38轮不变，表示整季超常或低迷发挥；它不会展示给玩家，也不会替代逐场抽取的`aiTeamForm`。
- 两组状态概率都必须分别合计100。赛季状态应明显小于单场状态，避免把真实实力排序完全洗掉。

### `goalContributionWeights`

- `scorerByPosition`越高，该位置越容易取得本队进球；当前ST为1.85、CB为0.10。
- `assisterByPosition`控制助攻分配，前腰和中场更高。
- `assistProbability`是有助攻进球的比例，0.76约等于76%。
- 这些是相对权重，不需要合计为1；同位置球员仍由真实射门、传球、视野等FM属性继续区分。

### `playerMatchRating`

`base`是基础分；进球、助攻、胜平负、状态、零封和失球分别使用同名Bonus/Penalty；`randomRange`控制轻微波动，`minimum/maximum`限制最终评分。

## 选秀：`config/balance-config.json`

- `draft.optionsPerRound`：每轮候选人数，当前10。
- `draft.minSquadSize/maxSquadSize`：当前都必须保持11。
- `price.runRandomMin/Max`：每局价格随机倍数，当前0.8—1.2。
- `config/draft-pools.json`：900人白名单、三池归属、单轮4/4/3池券权重和5名候选数量。
- `formState.tiers`：玩家每场状态与能力百分比，概率必须合计100。
- `chemistry`：同国家/联赛化学和单人上限。

## AI球队：`config/opponents.json`

- `ratings.attack/midfield/defense/goalkeeper`是AI四维，已与玩家FM属性聚合结果统一到同一尺度。
- 当前大致范围为升班/保级队65左右、强队70—75、争冠队75—80；战术与临场状态在此基础上变化。
- `formation`用于球队身份，`tactic`必须对应已有战术ID。
- 具体事件人员来自`config/opponent-rosters.json`；姓名、位置、`weight`影响进球/助攻人员分配，不改变球队四维。

## 当前批量校准（每组300赛季）

- 500m可组成的合理11人：平均第13.1，降级12.3%。
- 当前本地用户11人样本：平均第10.5，降级4.3%。
- 顶配11人：平均第1.0，夺冠98.3%。

这些结果没有选秀池或玩家队隐藏加成。建议每次只改一小项，并批量模拟至少100—300个赛季；单独一个赛季可能只是随机波动。
