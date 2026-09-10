import crypto from "node:crypto";
import { clamp } from "./context.mjs";
import { simulateContinuousMatch, continuousEngineConfig } from "./continuous-match-engine.mjs";

const { pitch, clock } = continuousEngineConfig;
const FIELD_INSET_PERCENT = 4;
const GOAL_OUTER_EDGE_PERCENT = 1.7;
const round = (value, places = 2) => {
  const scale = 10 ** places;
  return Math.round(Number(value) * scale) / scale;
};
const otherTeam = (team) => team === "home" ? "away" : "home";

function seededRandom(seed) {
  let state = crypto.createHash("sha256").update(String(seed)).digest().readUInt32LE(0) || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}

function pointToPercent(point) {
  return {
    x: round(clamp(FIELD_INSET_PERCENT + point.x / pitch.length * (100 - FIELD_INSET_PERCENT * 2), GOAL_OUTER_EDGE_PERCENT, 100 - GOAL_OUTER_EDGE_PERCENT), 3),
    y: round(clamp(FIELD_INSET_PERCENT + point.y / pitch.width * (100 - FIELD_INSET_PERCENT * 2), FIELD_INSET_PERCENT, 100 - FIELD_INSET_PERCENT), 3)
  };
}

function actionMinute(action) {
  return Math.min(90, Math.max(0, Math.floor(action.timeEnd / 60)));
}

function zoneName(action) {
  if (!action.startPosition) return "场上";
  const direction = action.team === "home"
    ? (action.period === 1 ? 1 : -1)
    : (action.period === 1 ? -1 : 1);
  const progress = direction > 0 ? action.startPosition.x : pitch.length - action.startPosition.x;
  const flank = action.startPosition.y < 20 ? "左路" : action.startPosition.y > 48 ? "右路" : "中路";
  if (progress >= 88) return `禁区内${flank}`;
  if (progress >= 70) return `进攻三区${flank}`;
  if (progress >= 36) return `中场${flank}`;
  return `后场${flank}`;
}

function resultPhrase(action, actorName, targetName, opponentName) {
  if (action.type === "kickoff") return `${actorName}在中圈开球，比赛正式开始。`;
  if (action.type === "halftime") return "上半场结束，双方交换场地后准备下半场比赛。";
  if (action.type === "full_time") return "主裁判吹响终场哨，比赛全部结束。";
  if (["throw_in", "goal_kick", "corner", "free_kick"].includes(action.type)) {
    const labels = { throw_in: "界外球", goal_kick: "球门球", corner: "角球", free_kick: "任意球" };
    return `${actorName}在${zoneName(action)}主罚${labels[action.type]}，球队重新组织进攻。`;
  }
  if (action.type === "foul") return `${actorName}在${zoneName(action)}对${opponentName}的防守动作慢了半拍，主裁判鸣哨判罚犯规。`;
  if (action.type === "penalty") return `${actorName}站上十二码点，观察门将站位后准备主罚点球。`;
  if (action.type === "disallowed_goal") return `${actorName}把球送入球门，但边裁随即举旗；回看确认接球瞬间越位，进球无效。`;
  if (action.type === "penalty_shootout") {
    const score = action.shootoutScore ? `，点球比分来到${action.shootoutScore.home}-${action.shootoutScore.away}` : "";
    if (action.outcome === "goal") return `${actorName}助跑后主罚命中，皮球越过${opponentName}进入球门${score}。`;
    if (action.outcome === "saved") return `${actorName}主罚点球，${opponentName}判断对方向飞身将球扑出${score}。`;
    return `${actorName}主罚点球偏出门框范围${score}。`;
  }
  if (action.type === "tackle") {
    return `${actorName}在${zoneName(action)}贴近${opponentName}，判断好触球时机完成正面抢断，球权随即转换。`;
  }
  if (action.type === 'clearance') {
    const method = action.technique === 'aerial_clearance'
      ? '判断落点后抢先头球解围'
      : action.technique === 'scramble_clearance'
        ? '在门前混战中抢先把球踢出危险区域'
        : '在压力下把球处理出危险区域';
    return `${actorName}在${zoneName(action)}${method}，防线获得重新落位的时间。`;
  }
  if (action.type === "pass") {
    const method = action.technique === "kickoff_back_pass"
      ? "从中圈将球回做"
      : action.technique === "first_time_pass"
      ? "迎球不停球直接做给队友"
      : action.technique === 'corner_cross'
        ? '从角旗区送出弧线传中'
        : action.technique === 'free_kick_delivery'
          ? '主罚任意球将球吊入禁区'
      : action.technique === "cross"
      ? "从边路起球传中"
      : action.technique === "through_ball"
        ? "抓住防线空当送出直塞"
        : action.technique === "progressive_pass"
      ? "沿防线之间送出向前传递"
      : action.technique === "long_pass"
        ? "观察前场移动后送出长传"
        : action.technique === "back_pass"
          ? "在压力下回传保持球权"
          : "调整身体后送出短传";
    if (action.outcome === "complete") return `${actorName}在${zoneName(action)}${method}，${targetName}移动到接应点并将球控制下来。`;
    if (action.outcome === "intercepted") {
      if (['corner_cross', 'free_kick_delivery'].includes(action.technique)) return `${actorName}${method}，${opponentName}抢在${targetName}之前争到第一落点并把球顶出危险区域。`;
      return `${actorName}在${zoneName(action)}尝试联系${targetName}，但${opponentName}提前封住线路并完成拦截。`;
    }
    if (action.outcome === "offside") return `${actorName}送球寻找前插的${targetName}，接球队员在传球触球瞬间已经越过倒数第二名防守者。`;
    if (['corner_cross', 'free_kick_delivery'].includes(action.technique)) return `${actorName}${method}，但落点控制不够准确，皮球没有找到禁区内的${targetName}。`;
    return `${actorName}在${zoneName(action)}尝试把球交给${targetName}，传球力度或方向出现偏差，球队失去球权。`;
  }
  if (action.type === "shot") {
    const distance = Math.round(Math.hypot(
      action.startPosition.x - (action.team === "home" ? (action.period === 1 ? pitch.length : 0) : (action.period === 1 ? 0 : pitch.length)),
      action.startPosition.y - pitch.width / 2
    ));
    const technique = action.technique === "first_time_shot"
      ? `在${zoneName(action)}迎球直接攻门`
      : action.technique === 'header'
        ? `在${zoneName(action)}抢到落点甩头攻门`
        : action.technique === 'rebound_shot'
          ? `在${zoneName(action)}抢到第二落点补射`
          : action.technique === 'turnover_shot'
            ? `在前场断球后迅速起脚攻门`
      : action.technique === "direct_free_kick"
        ? `在距离球门约${distance}米处直接主罚任意球攻门`
        : action.technique === "penalty_kick"
          ? "从十二码点起脚攻门"
          : action.technique === "long_shot" ? `在距离球门约${distance}米处起脚远射` : `在${zoneName(action)}完成射门`;
    if (action.outcome === "goal") return `${actorName}${technique}，皮球越过门将进入球门！`;
    if (action.outcome === 'own_goal') return `${actorName}${technique}，${opponentName}试图封堵时改变了皮球方向，球滚入自家球门，乌龙球！`;
    if (action.outcome === "saved") {
      if (action.saveType === "caught") return `${actorName}${technique}，${opponentName}判断落点后侧扑并把球稳稳抱住。`;
      if (action.saveType === "parried_corner") return `${actorName}${technique}，${opponentName}飞身将球托出底线，进攻方获得角球。`;
      return `${actorName}${technique}，${opponentName}迅速下地把球扑出，禁区内仍有第二落点。`;
    }
    if (action.outcome === "blocked") return `${actorName}${technique}，${opponentName}及时上前封堵，皮球被挡下。`;
    if (action.outcome === "woodwork") return `${actorName}${technique}，皮球击中门框后弹回场内！`;
    return `${actorName}${technique}，皮球偏出球门范围。`;
  }
  return `${actorName}在${zoneName(action)}完成${action.type}。`;
}

function actionLabel(action) {
  if (action.type === "pass") {
    if (action.technique === "kickoff_back_pass") return "开球回传";
    if (action.technique === 'corner_cross') return action.outcome === 'intercepted' ? '角球被解围' : '角球传中';
    if (action.technique === 'free_kick_delivery') return action.outcome === 'intercepted' ? '任意球被解围' : '任意球传中';
    if (action.outcome === "intercepted") return "传球被拦截";
    if (action.outcome === "offside") return "越位";
    return action.technique === "cross" ? "传中" : action.technique === "through_ball" ? "直塞" : action.technique === "progressive_pass" ? "向前传递" : action.technique === "long_pass" ? "长传" : "传球";
  }
  if (action.type === "shot") return action.outcome === "goal" ? "进球" : action.outcome === 'own_goal' ? '乌龙球' : action.outcome === "saved" ? "射门被扑" : action.outcome === "blocked" ? "射门被封堵" : action.outcome === "woodwork" ? "击中门框" : "射门偏出";
  if (action.type === 'clearance') return '解围';
  if (action.type === "penalty_shootout") return action.outcome === "goal" ? "点球命中" : action.outcome === "saved" ? "点球被扑" : "点球射失";
  return { kickoff: "开球", halftime: "中场休息", full_time: "全场结束", tackle: "抢断", foul: "犯规", corner: "角球", goal_kick: "球门球", throw_in: "界外球", free_kick: "任意球", penalty: "点球", disallowed_goal: "越位进球无效" }[action.type] ?? action.type;
}

function actionNames(result, action) {
  const players = [...result.teams.home.players.map((player) => ({ ...player, team: "home" })), ...result.teams.away.players.map((player) => ({ ...player, team: "away" }))];
  const actor = players.find((player) => player.team === action.team && player.id === action.actorId);
  const target = players.find((player) => player.id === action.targetPlayerId && player.team === action.team);
  const intended = players.find((player) => player.id === action.intendedTargetPlayerId && player.team === action.team);
  const opponent = players.find((player) => player.id === action.opponentId && player.team === otherTeam(action.team));
  return {
    actorName: actor?.name ?? result.teams[action.team]?.name ?? "球员",
    targetName: target?.name ?? intended?.name ?? "队友",
    opponentName: opponent?.name ?? result.teams[otherTeam(action.team)]?.name ?? "防守球员"
  };
}

function commentary(result, action, previousAction = null) {
  const names = actionNames(result, action);
  let text = resultPhrase(action, names.actorName, names.targetName, names.opponentName);
  if (action.type === "shot" && previousAction?.type === "pass" && previousAction.team === action.team && previousAction.outcome === "complete") {
    const previousNames = actionNames(result, previousAction);
    text = `${previousNames.actorName}先在${zoneName(previousAction)}送球找到${names.actorName}，${names.actorName}${text.slice(names.actorName.length)}`;
  } else if (action.type === "tackle") {
    text += "附近队友立即拉开接应，球队可以由守转攻。";
  }
  return { summary: `${names.actorName} · ${actionLabel(action)}`, text };
}

function importance(action) {
  if (action.type === "penalty_shootout") return 120;
  if (action.type === "disallowed_goal") return 98;
  if (action.type === "penalty") return 94;
  if (action.type === "corner") return 44;
  if (action.type === "free_kick") return 38;
  if (action.type === 'pass' && action.technique === 'corner_cross') return 54;
  if (action.type === 'pass' && action.technique === 'free_kick_delivery') return 50;
  if (action.type === "foul" && action.technique === "penalty_foul") return 90;
  if (action.type === "shot") {
    if (action.outcome === "goal" || action.outcome === 'own_goal') return 100 + action.xg * 20;
    if (action.outcome === "saved") return 72 + action.xg * 20;
    if (action.outcome === "blocked") return 48 + action.xg * 20;
    return 35 + action.xg * 30;
  }
  if (action.type === "tackle") return 12;
  if (action.type === 'clearance') return action.technique === 'scramble_clearance' ? 16 : 8;
  if (action.type === "pass" && action.technique === "progressive_pass" && action.outcome === "complete") return 8;
  return 0;
}

function isMeaningfulShot(action) {
  if (action.type !== "shot") return false;
  if (["goal", "own_goal", "woodwork"].includes(action.outcome)) return true;
  if (action.outcome === "saved") return action.xg >= 0.035;
  if (action.outcome === "blocked") return action.xg >= 0.055;
  return action.xg >= 0.075;
}

function isSetPieceDelivery(action) {
  return action.type === "pass"
    && ["corner_cross", "free_kick_delivery"].includes(action.technique);
}

function setPieceHighlightScore(result, entry) {
  const action = entry.action;
  const followUp = result.actions.slice(entry.index + 1).find((candidate) => (
    candidate.tickStart <= action.tickEnd + 12 * clock.tickRate
    && candidate.possessionId === action.possessionId
    && isMeaningfulShot(candidate)
  ));
  return entry.importance
    + (followUp ? 60 : 0)
    + (action.outcome === "complete" ? 18 : action.outcome === "intercepted" ? 10 : 0);
}

function selectHighlightActions(result) {
  const entries = result.actions.map((action, index) => ({ action, index, importance: importance(action) }));
  const isMandatory = (action) => action.type === "penalty_shootout"
    || action.type === "disallowed_goal"
    || action.type === "penalty"
    || (action.type === "shot" && (action.outcome === "goal" || action.outcome === 'own_goal'));
  const chosen = entries.filter(({ action }) => action.period === 3 && action.type === "penalty_shootout");
  for (const period of [1, 2]) {
    const periodCandidates = entries.filter(({ action }) => action.period === period
      && (isMeaningfulShot(action) || ["disallowed_goal", "penalty"].includes(action.type)));
    const mandatory = periodCandidates.filter(({ action }) => isMandatory(action));
    const desiredCount = Math.min(7, Math.max(4, Math.ceil(periodCandidates.length * 0.6)));
    const optional = periodCandidates
      .filter(({ action }) => !isMandatory(action))
      .sort((left, right) => right.importance - left.importance)
      .slice(0, Math.max(0, desiredCount - mandatory.length));
    chosen.push(...mandatory, ...optional);

    // 定位球只有在直接形成射门（会随射门镜头一起展示）或被明确解围时才有观察价值。
    const chosenPossessions = new Set([...mandatory, ...optional].map((entry) => entry.action.possessionId));
    const defensiveSetPiece = entries
      .filter((entry) => entry.action.period === period
        && isSetPieceDelivery(entry.action)
        && entry.action.outcome === "intercepted"
        && !chosenPossessions.has(entry.action.possessionId))
      .sort((left, right) => setPieceHighlightScore(result, right) - setPieceHighlightScore(result, left))[0];
    if (defensiveSetPiece) chosen.push(defensiveSetPiece);
  }
  return [...new Map(chosen.map((entry) => [entry.index, entry])).values()].sort((left, right) => left.action.tickEnd - right.action.tickEnd);
}

function highlightStartTick(result, entry) {
  const action = entry.action;
  const windowStart = action.tickEnd - 12 * clock.tickRate;
  if (action.type === "penalty") {
    const foul = [...result.actions].reverse().find((candidate) => (
      candidate.type === "foul"
      && candidate.technique === "penalty_foul"
      && candidate.tickEnd <= action.tickStart
      && candidate.tickEnd >= action.tickStart - 20 * clock.tickRate
    ));
    if (foul) return Math.max(0, foul.tickStart - clock.tickRate);
  }
  const restart = [...result.actions].reverse().find((candidate) => (
      candidate.tickEnd <= action.tickStart
      && candidate.tickEnd >= windowStart
      && candidate.team === action.team
      && candidate.possessionId === action.possessionId
      && ["corner", "free_kick"].includes(candidate.type)
  ));
  if (restart) return Math.max(0, restart.tickStart - clock.tickRate);
  const buildup = result.actions
    .filter((candidate) => candidate.possessionId === action.possessionId
      && candidate.tickEnd <= action.tickEnd
      && candidate.tickEnd >= windowStart)
    .slice(-4);
  return Math.max(0, (buildup[0]?.tickStart ?? action.tickStart) - clock.tickRate);
}

function highlightSegments(result) {
  const selected = selectHighlightActions(result);
  const segments = [];
  const kickoffIndex = result.actions.findIndex((action) => action.type === "kickoff" && action.period === 1);
  if (kickoffIndex >= 0) {
    const kickoff = result.actions[kickoffIndex];
    const openingPass = result.actions.find((action) => action.period === 1 && action.type === "pass" && action.tickStart >= kickoff.tickEnd);
    const kickoffEndTick = Math.min(5 * clock.tickRate, Math.max(2.25 * clock.tickRate, (openingPass?.tickEnd ?? 2 * clock.tickRate) + Math.round(0.5 * clock.tickRate)));
    segments.push({
      id: "kickoff-opening",
      startTick: 0,
      endTick: kickoffEndTick,
      primary: { action: kickoff, index: kickoffIndex, importance: 100 },
      selectedIndexes: [kickoffIndex],
      fixedPlaybackMs: 2000,
      includeInMoments: false
    });
  }
  for (const entry of selected) {
    const startTick = highlightStartTick(result, entry);
    const endTick = Math.min(result.snapshots.at(-1).tick, entry.action.tickEnd + 3 * clock.tickRate);
    const previous = segments.at(-1);
    if (previous && !previous.fixedPlaybackMs && startTick <= previous.endTick + 4 * clock.tickRate) {
      previous.endTick = Math.max(previous.endTick, endTick);
      if (entry.importance > previous.primary.importance) previous.primary = entry;
      previous.selectedIndexes.push(entry.index);
    } else {
      segments.push({ id: `highlight-${segments.length + 1}`, startTick, endTick, primary: entry, selectedIndexes: [entry.index] });
    }
  }
  return segments;
}

const statsResolverCache = new WeakMap();

function emptyLiveStats() {
  return { possessionWeight: 0, passes: 0, completedPasses: 0, shots: 0, shotsOnTarget: 0, xg: 0, goals: 0, tackles: 0, interceptions: 0, clearances: 0, saves: 0, corners: 0, fouls: 0, offsides: 0 };
}

function lastIndexAtOrBefore(items, tick) {
  let low = 0;
  let high = items.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (items[middle].tick <= tick) {
      found = middle;
      low = middle + 1;
    } else high = middle - 1;
  }
  return found;
}

function createStatsResolver(result) {
  const possession = [];
  let homePossession = 0;
  let awayPossession = 0;
  for (const snapshot of result.snapshots) {
    if (snapshot.possessionTeam === "home") homePossession += 1;
    else if (snapshot.possessionTeam === "away") awayPossession += 1;
    possession.push({ tick: snapshot.tick, home: homePossession, away: awayPossession });
  }
  const cumulative = [];
  const live = { home: emptyLiveStats(), away: emptyLiveStats() };
  for (const action of result.actions) {
    if (action.team) {
      const stats = live[action.team];
      if (action.type === "pass") {
        stats.passes += 1;
        if (action.outcome === "complete") stats.completedPasses += 1;
        if (action.outcome === "intercepted" && action.opponentId) live[otherTeam(action.team)].interceptions += 1;
        if (action.outcome === "offside") stats.offsides += 1;
      } else if (action.type === "shot") {
        stats.shots += 1;
        stats.xg += action.xg;
        if (["goal", "saved"].includes(action.outcome)) stats.shotsOnTarget += 1;
        if (action.outcome === "goal" || action.outcome === 'own_goal') stats.goals += 1;
        if (action.outcome === "saved") live[otherTeam(action.team)].saves += 1;
      } else if (action.type === "tackle" && action.outcome === "won") stats.tackles += 1;
      else if (action.type === 'clearance') stats.clearances += 1;
      else if (action.type === "corner") stats.corners += 1;
      else if (action.type === "foul") stats.fouls += 1;
    }
    cumulative.push({ tick: action.tickEnd, home: { ...live.home }, away: { ...live.away } });
  }
  return (tick) => {
    const actionIndex = lastIndexAtOrBefore(cumulative, tick);
    const possessionIndex = lastIndexAtOrBefore(possession, tick);
    const base = actionIndex >= 0
      ? { home: { ...cumulative[actionIndex].home }, away: { ...cumulative[actionIndex].away } }
      : { home: emptyLiveStats(), away: emptyLiveStats() };
    if (possessionIndex >= 0) {
      base.home.possessionWeight = possession[possessionIndex].home;
      base.away.possessionWeight = possession[possessionIndex].away;
    }
    base.home.xg = round(base.home.xg, 2);
    base.away.xg = round(base.away.xg, 2);
    return base;
  };
}

function statsAtAction(result, tick) {
  if (!statsResolverCache.has(result)) statsResolverCache.set(result, createStatsResolver(result));
  return statsResolverCache.get(result)(tick);
}

function convertSnapshot(snapshot, atMs, mode, highlightId = null, cut = false) {
  const convertedBall = pointToPercent(snapshot.ball);
  return {
    tick: snapshot.tick,
    minute: Math.min(90, round(snapshot.matchTime / 60, 2)),
    half: snapshot.period,
    cut,
    mode,
    highlightId,
    atMs: Math.round(atMs),
    ball: convertedBall,
    positions: snapshot.players.map((player) => {
      const point = pointToPercent(player);
      return [point.x, point.y];
    })
  };
}

function nearestSnapshotIndex(snapshots, tick, fromIndex = 0) {
  let low = fromIndex;
  let high = snapshots.length - 1;
  let found = fromIndex;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (snapshots[middle].tick <= tick) {
      found = middle;
      low = middle + 1;
    } else high = middle - 1;
  }
  return found;
}

function buildPlayback(result) {
  const segments = highlightSegments(result);
  const frames = [];
  const ranges = new Map();
  const tickToFrame = new Map();
  let elapsed = 0;
  let previousSnapshot = result.snapshots[0];
  const fastForwardDuration = 750;
  const halftimePauseDuration = 1200;
  const fullTimePauseDuration = 1600;
  const highlightPlaybackScale = 0.9;
  const firstSecondHalfSnapshot = result.snapshots.find((snapshot) => snapshot.period === 2);
  let halftimeFrameIndex = -1;
  segments.forEach((segment, segmentIndex) => {
    const startIndex = nearestSnapshotIndex(result.snapshots, segment.startTick);
    const endIndex = nearestSnapshotIndex(result.snapshots, segment.endTick, startIndex);
    const segmentSnapshots = result.snapshots.slice(startIndex, endIndex + 1);
    if (!segmentSnapshots.length) return;
    if (segmentIndex > 0) {
      const crossesHalftime = previousSnapshot.period === 1 && segmentSnapshots[0].period === 2 && firstSecondHalfSnapshot;
      frames.push(convertSnapshot(previousSnapshot, elapsed, "fast_forward", null, false));
      elapsed += fastForwardDuration;
      if (crossesHalftime) {
        halftimeFrameIndex = frames.push(convertSnapshot(firstSecondHalfSnapshot, elapsed, "period", null, true)) - 1;
        elapsed += halftimePauseDuration;
        frames.push(convertSnapshot(firstSecondHalfSnapshot, elapsed, "period", null, false));
        frames.push(convertSnapshot(firstSecondHalfSnapshot, elapsed, "fast_forward", null, false));
        elapsed += fastForwardDuration;
      }
      frames.push(convertSnapshot(segmentSnapshots[0], elapsed, "fast_forward", null, true));
    }
    const rangeStart = frames.length;
    const segmentStartTime = segmentSnapshots[0].matchTime;
    const segmentNaturalMs = Math.max(1, (segmentSnapshots.at(-1).matchTime - segmentStartTime) * 1000);
    const segmentScale = segment.fixedPlaybackMs ? segment.fixedPlaybackMs / segmentNaturalMs : highlightPlaybackScale;
    for (const snapshot of segmentSnapshots) {
      const frameAt = elapsed + (snapshot.matchTime - segmentStartTime) * 1000 * segmentScale;
      const frameIndex = frames.push(convertSnapshot(snapshot, frameAt, "highlight", segment.id, snapshot.discontinuity === "penalty_shootout_setup")) - 1;
      tickToFrame.set(snapshot.tick, frameIndex);
    }
    elapsed = frames.at(-1).atMs;
    ranges.set(segment.id, [rangeStart, frames.length - 1]);
    previousSnapshot = segmentSnapshots.at(-1);
  });
  if (!frames.length) frames.push(convertSnapshot(result.snapshots[0], 0, "highlight", "highlight-1", false));
  const fullTimeSnapshot = { ...result.snapshots.at(-1), matchTime: Math.max(clock.halfDuration * 2, result.snapshots.at(-1).matchTime) };
  frames.push(convertSnapshot(previousSnapshot, elapsed, "fast_forward", null, false));
  elapsed += fastForwardDuration;
  frames.push(convertSnapshot(fullTimeSnapshot, elapsed, "fast_forward", null, true));
  elapsed += fullTimePauseDuration;
  frames.push(convertSnapshot(fullTimeSnapshot, elapsed, "period", null, false));
  return { frames, durationMs: Math.round(elapsed), segments, ranges, tickToFrame, halftimeFrameIndex };
}

function scoreAt(result, tick) {
  const score = { home: 0, away: 0 };
  for (const action of result.actions) {
    if (action.tickEnd > tick) break;
    if (action.type === "shot" && (action.outcome === "goal" || action.outcome === 'own_goal')) score[action.team] += 1;
  }
  return score;
}

function displayedEvents(result, playback) {
  const events = [];
  const kickoff = result.actions.find((action) => action.type === "kickoff");
  if (kickoff) {
    const copy = commentary(result, kickoff);
    events.push({
      id: kickoff.id,
      actionId: kickoff.id,
      minute: 0,
      type: "kickoff",
      technique: null,
      outcome: "complete",
      team: kickoff.team,
      actorId: kickoff.actorId,
      targetId: null,
      opponentId: null,
      xg: 0,
      summary: copy.summary,
      text: copy.text,
      score: { home: 0, away: 0 },
      stats: statsAtAction(result, kickoff.tickEnd),
      frameIndex: 0,
      atMs: 0,
      replayStartFrame: 0,
      replayEndFrame: Math.min(playback.frames.length - 1, 1),
      highlightId: null
    });
  }
  for (const segment of playback.segments) {
    const [rangeStart, rangeEnd] = playback.ranges.get(segment.id);
    const actions = result.actions.filter((action) => action.tickEnd >= segment.startTick && action.tickEnd <= segment.endTick && !["kickoff", "halftime", "full_time"].includes(action.type));
    for (const action of actions) {
      const previousAction = result.actions[result.actions.indexOf(action) - 1] ?? null;
      const nearestTick = result.snapshots[nearestSnapshotIndex(result.snapshots, action.tickEnd)].tick;
      let frameIndex = playback.tickToFrame.get(nearestTick);
      if (!Number.isInteger(frameIndex) || frameIndex < rangeStart || frameIndex > rangeEnd) frameIndex = clamp(frameIndex ?? rangeStart, rangeStart, rangeEnd);
      const copy = commentary(result, action, previousAction);
      events.push({
        id: action.id,
        actionId: action.id,
        minute: actionMinute(action),
        type: action.type,
        technique: action.technique,
        outcome: action.outcome,
        team: action.team,
        actorId: action.actorId,
        targetId: action.targetPlayerId,
        opponentId: action.opponentId,
        xg: action.xg,
        shootoutScore: action.shootoutScore,
        summary: copy.summary,
        text: copy.text,
        score: scoreAt(result, action.tickEnd),
        stats: statsAtAction(result, action.tickEnd),
        frameIndex,
        atMs: playback.frames[frameIndex].atMs,
        replayStartFrame: rangeStart,
        replayEndFrame: rangeEnd,
        highlightId: segment.id
      });
    }
  }
  if (playback.halftimeFrameIndex >= 0) {
    const halftimeFrame = playback.halftimeFrameIndex;
    events.push({
      id: "halftime-display",
      actionId: "halftime-display",
      minute: 45,
      type: "halftime",
      technique: null,
      outcome: "complete",
      team: null,
      xg: 0,
      summary: "中场休息 · 双方换边",
      text: "上半场比赛结束，双方交换场地，下半场的进攻方向已经改变。",
      score: scoreAt(result, clock.halfDuration * clock.tickRate),
      stats: statsAtAction(result, clock.halfDuration * clock.tickRate),
      frameIndex: halftimeFrame,
      atMs: playback.frames[halftimeFrame].atMs,
      replayStartFrame: halftimeFrame,
      replayEndFrame: Math.min(playback.frames.length - 1, halftimeFrame + 1),
      highlightId: null
    });
  }
  const finalFrameIndex = playback.frames.length - 1;
  events.push({
    id: "full-time-display",
    actionId: "full-time-display",
    minute: 90,
    type: "full_time",
    technique: null,
    outcome: "complete",
    team: null,
    xg: 0,
    summary: result.penalties ? "点球大战结束" : "全场结束",
    text: result.penalties
      ? `常规时间双方战成${result.score.home}-${result.score.away}，点球大战${result.penalties.home}-${result.penalties.away}，${result.teams[result.penalties.winner].name}获胜。`
      : `全场比赛结束，最终比分${result.score.home}-${result.score.away}。`,
    score: { ...result.score },
    stats: statsAtAction(result, clock.halfDuration * 2 * clock.tickRate),
    frameIndex: finalFrameIndex,
    atMs: playback.frames[finalFrameIndex].atMs,
    replayStartFrame: finalFrameIndex,
    replayEndFrame: finalFrameIndex,
    highlightId: null
  });
  return events.sort((left, right) => left.atMs - right.atMs || left.minute - right.minute);
}

function buildRatings(result) {
  const ratings = { home: [], away: [] };
  const assistMap = new Map();
  const expectedAssistMap = new Map();
  for (const shot of result.actions.filter((action) => action.type === "shot")) {
    const previous = [...result.actions].reverse().find((action) => action.team === shot.team && action.type === "pass" && action.outcome === "complete" && action.possessionId === shot.possessionId && action.tickEnd < shot.tickStart && shot.tickStart - action.tickEnd <= 10 * clock.tickRate && action.targetPlayerId === shot.actorId);
    if (!previous) continue;
    const passerKey = `${shot.team}:${previous.actorId}`;
    expectedAssistMap.set(passerKey, (expectedAssistMap.get(passerKey) ?? 0) + Number(shot.xg ?? 0));
    if (shot.outcome === "goal") assistMap.set(passerKey, (assistMap.get(passerKey) ?? 0) + 1);
  }
  for (const team of ["home", "away"]) {
    const conceded = result.score[otherTeam(team)];
    ratings[team] = result.teams[team].players.map((player) => {
      const playerKey = `${team}:${player.id}`;
      const stats = { ...player.stats, assists: assistMap.get(playerKey) ?? 0 };
      const passValue = stats.completedPasses * 0.002 - Math.max(0, stats.passes - stats.completedPasses) * 0.006;
      const attackValue = stats.goals * 0.82 + stats.assists * 0.42 + stats.shotsOnTarget * 0.05 - Math.max(0, stats.shots - stats.shotsOnTarget) * 0.025;
      const defenseValue = stats.tackles * 0.065 + stats.interceptions * 0.055 + stats.clearances * 0.035 - stats.dispossessions * 0.018 - stats.ownGoals * 0.55;
      const keeperValue = player.position === "GK" ? stats.saves * 0.11 - conceded * 0.08 : 0;
      const disciplineValue = -stats.fouls * 0.025;
      const breakdown = {
        base: 6.5,
        passing: round(passValue, 3),
        attacking: round(attackValue, 3),
        defending: round(defenseValue, 3),
        goalkeeping: round(keeperValue, 3),
        discipline: round(disciplineValue, 3)
      };
      const rating = round(clamp(Object.values(breakdown).reduce((sum, value) => sum + value, 0), 4, 10), 1);
      return {
        playerId: player.id,
        name: player.name,
        position: player.position,
        minutes: 90,
        goals: stats.goals,
        assists: stats.assists,
        shots: stats.shots,
        shotsOnTarget: stats.shotsOnTarget,
        xg: round(stats.xg, 2),
        xa: round(expectedAssistMap.get(playerKey) ?? 0, 2),
        passes: stats.passes,
        completedPasses: stats.completedPasses,
        passCompletion: stats.passes ? Math.round(stats.completedPasses / stats.passes * 100) : 0,
        tackles: stats.tackles,
        interceptions: stats.interceptions,
        clearances: stats.clearances,
        ownGoals: stats.ownGoals,
        saves: stats.saves,
        goalsConceded: player.position === "GK" ? conceded : 0,
        fouls: stats.fouls,
        dispossessions: stats.dispossessions,
        rating,
        ratingBreakdown: breakdown
      };
    }).sort((left, right) => right.rating - left.rating || left.name.localeCompare(right.name));
  }
  return ratings;
}

function publicFinalStats(result) {
  const finalLedgerStats = statsAtAction(result, clock.halfDuration * 2 * clock.tickRate);
  const stats = {};
  for (const team of ["home", "away"]) stats[team] = {
    ...finalLedgerStats[team],
    possession: result.stats[team].possession,
    possessionWeight: result.stats[team].possession,
    passCompletion: finalLedgerStats[team].passes ? Math.round(finalLedgerStats[team].completedPasses / finalLedgerStats[team].passes * 100) : 0,
    fouls: finalLedgerStats[team].fouls
  };
  return stats;
}

export function penaltyShootoutProbabilities(accuracy, keeperQuality) {
  const miss = clamp(0.1 - (accuracy - 70) * 0.002, 0.05, 0.16);
  const saved = clamp(0.145 + (keeperQuality - accuracy) * 0.003, 0.08, 0.24);
  return { goal: 1 - miss - saved, saved, missed: miss };
}

export function appendPenaltyShootout(result, seed) {
  if (result.score.home !== result.score.away) return null;
  const random = seededRandom(`${seed}:penalty-shootout`);
  const score = { home: 0, away: 0 };
  const kicks = { home: 0, away: 0 };
  const takers = {};
  const keepers = {};
  for (const team of ["home", "away"]) {
    takers[team] = result.teams[team].players
      .filter((player) => player.position !== "GK")
      .sort((left, right) => (right.penaltyTaking + right.composure * 0.45) - (left.penaltyTaking + left.composure * 0.45));
    keepers[team] = result.teams[team].players.find((player) => player.position === "GK") ?? result.teams[team].players[0];
  }
  const baseSnapshot = result.snapshots.at(-1);
  let nextTick = baseSnapshot.tick + Math.round(clock.tickRate * 2);
  let finished = false;
  const shootoutGoalX = pitch.length;
  const shootoutAttackDirection = 1;

  const addSnapshot = (tick, attackingTeam, taker, goalkeeper, phase, outcome, targetY, keeperDiveY) => {
    const goalX = shootoutGoalX;
    const spotX = goalX - shootoutAttackDirection * 11;
    const players = baseSnapshot.players.map((player, index) => {
      const activeTaker = player.team === attackingTeam && player.id === taker.id;
      const activeKeeper = player.team === otherTeam(attackingTeam) && player.id === goalkeeper.id;
      let x = pitch.length / 2 + (player.team === "home" ? -4 : 4);
      let y = 9 + (index % 11) * 5;
      let intent = "penalty_shootout_wait";
      if (activeTaker) {
        const runupDistance = ["setup", "ready"].includes(phase) ? 3.3 : phase === "runup" ? 1.15 : 0.2;
        x = spotX - shootoutAttackDirection * runupDistance;
        y = pitch.width / 2;
        intent = ["setup", "ready", "runup"].includes(phase) ? "penalty_runup" : "penalty_strike";
      } else if (activeKeeper) {
        x = goalX - shootoutAttackDirection * 0.45;
        y = phase === "flight"
          ? pitch.width / 2 + (keeperDiveY - pitch.width / 2) * 0.55
          : phase === "outcome" ? keeperDiveY : pitch.width / 2;
        intent = ["flight", "outcome"].includes(phase) ? "goalkeeper_dive" : "penalty_goalkeeper_set";
      }
      return { ...player, x: round(x), y: round(y), vx: 0, vy: 0, targetX: round(x), targetY: round(y), intent, markingTarget: null };
    });
    let ball;
    if (["setup", "ready", "runup"].includes(phase)) ball = { x: spotX, y: pitch.width / 2, z: 0, vx: 0, vy: 0, state: "dead", controllerKey: null };
    else if (phase === "strike") ball = { x: spotX, y: pitch.width / 2, z: 0.18, vx: shootoutAttackDirection * 24, vy: 0, state: "shot", controllerKey: null };
    else if (phase === "flight") ball = { x: spotX + shootoutAttackDirection * 6.2, y: pitch.width / 2 + (targetY - pitch.width / 2) * 0.55, z: 0.22, vx: shootoutAttackDirection * 24, vy: 0, state: "shot", controllerKey: null };
    else if (outcome === "goal") ball = { x: goalX + shootoutAttackDirection * 1.1, y: targetY, z: 0, vx: 0, vy: 0, state: "dead", controllerKey: null };
    else if (outcome === "saved") ball = { x: goalX - shootoutAttackDirection * 0.55, y: keeperDiveY, z: 0, vx: 0, vy: 0, state: "dead", controllerKey: null };
    else ball = { x: goalX - shootoutAttackDirection * 0.2, y: targetY, z: 0, vx: 0, vy: 0, state: "dead", controllerKey: null };
    result.snapshots.push({
      ...baseSnapshot,
      tick,
      matchTime: round(tick / clock.tickRate, 2),
      period: 3,
      discontinuity: phase === "setup" ? "penalty_shootout_setup" : null,
      possessionId: 10000 + kicks.home + kicks.away,
      possessionTeam: phase === "outcome" ? null : attackingTeam,
      phases: { home: "penalty_shootout", away: "penalty_shootout" },
      ball,
      players
    });
  };

  const takeKick = (team, forcedOutcome = null) => {
    const defendingTeam = otherTeam(team);
    const taker = takers[team][kicks[team] % takers[team].length];
    const goalkeeper = keepers[defendingTeam];
    const accuracy = (taker.penaltyTaking + taker.composure) / 2;
    const keeperQuality = (goalkeeper.goalkeeping + goalkeeper.reflexes) / 2;
    const probabilities = penaltyShootoutProbabilities(accuracy, keeperQuality);
    let outcome = forcedOutcome;
    if (!outcome) {
      const outcomeRoll = random();
      outcome = outcomeRoll < probabilities.goal ? "goal" : outcomeRoll < probabilities.goal + probabilities.saved ? "saved" : "missed";
    }
    const targetSide = random() < 0.5 ? -1 : 1;
    const targetY = outcome === "missed"
      ? pitch.width / 2 + targetSide * (pitch.goalWidth / 2 + 0.8 + random() * 1.6)
      : pitch.width / 2 + targetSide * (0.8 + random() * (pitch.goalWidth / 2 - 1));
    const keeperGuessedSide = outcome === "saved" || random() < 0.45 ? targetSide : -targetSide;
    const keeperDiveY = outcome === "saved"
      ? targetY
      : pitch.width / 2 + keeperGuessedSide * (1.8 + random() * 1.2);
    const setupTick = nextTick;
    const readyTick = setupTick + Math.round(clock.tickRate * 0.4);
    const runupTick = setupTick + Math.round(clock.tickRate * 1.0);
    const strikeTick = setupTick + Math.round(clock.tickRate * 1.3);
    const flightTick = setupTick + Math.round(clock.tickRate * 1.55);
    const outcomeTick = setupTick + Math.round(clock.tickRate * 1.85);
    addSnapshot(setupTick, team, taker, goalkeeper, "setup", outcome, targetY, keeperDiveY);
    addSnapshot(readyTick, team, taker, goalkeeper, "ready", outcome, targetY, keeperDiveY);
    addSnapshot(runupTick, team, taker, goalkeeper, "runup", outcome, targetY, keeperDiveY);
    addSnapshot(strikeTick, team, taker, goalkeeper, "strike", outcome, targetY, keeperDiveY);
    addSnapshot(flightTick, team, taker, goalkeeper, "flight", outcome, targetY, keeperDiveY);
    kicks[team] += 1;
    if (outcome === "goal") score[team] += 1;
    addSnapshot(outcomeTick, team, taker, goalkeeper, "outcome", outcome, targetY, keeperDiveY);
    result.actions.push({
      id: `action-${result.actions.length + 1}`,
      possessionId: 10000 + kicks.home + kicks.away,
      tickStart: strikeTick,
      tickEnd: outcomeTick,
      timeStart: round(strikeTick / clock.tickRate, 2),
      timeEnd: round(outcomeTick / clock.tickRate, 2),
      period: 3,
      team,
      actorId: taker.id,
      targetPlayerId: null,
      intendedTargetPlayerId: null,
      opponentId: goalkeeper.id,
      type: "penalty_shootout",
      technique: "penalty_kick",
      outcome,
      startPosition: { x: pitch.length - 11, y: pitch.width / 2 },
      endPosition: { x: pitch.length, y: round(targetY) },
      pressure: 0,
      xg: 0,
      saveType: outcome === "saved" ? "caught" : null,
      shootoutScore: { ...score },
      resultingActionId: null,
      statsDelta: {}
    });
    nextTick = outcomeTick + Math.round(clock.tickRate * 1.2);
  };

  for (let roundIndex = 0; roundIndex < 15 && !finished; roundIndex += 1) {
    takeKick("home", roundIndex === 14 && score.home === score.away ? "goal" : null);
    if (roundIndex < 5 && score.home > score.away + (5 - kicks.away)) break;
    takeKick("away", roundIndex === 14 && score.home === score.away ? "missed" : null);
    if (roundIndex < 5) {
      if (score.home > score.away + (5 - kicks.away) || score.away > score.home + (5 - kicks.home)) finished = true;
    } else if (score.home !== score.away) finished = true;
  }
  const winner = score.home > score.away ? "home" : "away";
  const shootout = { home: score.home, away: score.away, winner };
  result.penalties = shootout;
  return shootout;
}

export function simulateContinuousPvpMatch(homeSide, awaySide, seed = crypto.randomUUID()) {
  const continuous = simulateContinuousMatch(homeSide, awaySide, seed);
  if (!continuous.invariantReport.passed) throw new Error(`Continuous match invariant failure: ${continuous.invariantReport.errors.join("; ")}`);
  const penalties = appendPenaltyShootout(continuous, seed);
  const playback = buildPlayback(continuous);
  const events = displayedEvents(continuous, playback);
  const moments = playback.segments.filter((segment) => segment.includeInMoments !== false).map((segment) => {
    const eventIndex = events.findIndex((event) => event.actionId === segment.primary.action.id);
    const event = events[eventIndex >= 0 ? eventIndex : 0];
    const range = playback.ranges.get(segment.id);
    return {
      id: segment.id,
      eventIndex: Math.max(0, eventIndex),
      minute: event?.minute ?? actionMinute(segment.primary.action),
      type: event?.type ?? segment.primary.action.type,
      team: event?.team ?? segment.primary.action.team,
      text: event?.text ?? "连续比赛画面",
      summary: event?.summary ?? "连续比赛画面",
      score: event?.score ?? scoreAt(continuous, segment.primary.action.tickEnd),
      atMs: playback.frames[range[0]].atMs,
      replayStartFrame: range[0],
      replayEndFrame: range[1]
    };
  });
  const teamView = (team) => ({
    name: continuous.teams[team].name,
    formationId: continuous.teams[team].formationId,
    tacticId: continuous.teams[team].tacticId,
    players: continuous.teams[team].players.map((player) => {
      const first = continuous.snapshots[0].players.find((point) => point.id === player.id && point.team === team);
      const base = pointToPercent(first ?? { x: pitch.length / 2, y: pitch.width / 2 });
      return { id: player.id, name: player.name, shortName: player.name.split(" ").at(-1).slice(0, 14), position: player.position, form: player.form, base };
    })
  });
  const winner = penalties?.winner ?? (continuous.score.home > continuous.score.away ? "home" : "away");
  const stats = publicFinalStats(continuous);
  const ratings = buildRatings(continuous);
  return {
    version: 6,
    engine: "authoritative-continuous-core-v1+set-pieces-and-shootout-v2",
    seed: String(seed),
    durationMs: playback.durationMs,
    maxMinute: 90,
    extraTime: false,
    penalties,
    winner,
    playerOrder: [
      ...continuous.teams.home.players.map((player) => ({ team: "home", id: player.id })),
      ...continuous.teams.away.players.map((player) => ({ team: "away", id: player.id }))
    ],
    teams: { home: teamView("home"), away: teamView("away") },
    score: continuous.score,
    stats,
    ratings,
    frames: playback.frames,
    events,
    moments,
    highlights: moments,
    audit: continuous.invariantReport
  };
}
