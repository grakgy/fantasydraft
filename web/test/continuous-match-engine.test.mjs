import test from "node:test";
import assert from "node:assert/strict";
import {
  simulateContinuousMatch,
  validateContinuousMatch,
  continuousEngineConfig
} from "../lib/continuous-match-engine.mjs";
import {
  formations,
  engineData,
  positionMultiplier,
  calculateChemistry
} from "../lib/context.mjs";

function buildSide(displayName, tacticId = "balanced", offset = 0) {
  const formation = formations.get("4-3-3");
  const available = engineData.players.filter((player) => player.dataQuality?.status === "PASS");
  const used = new Set();
  const starters = formation.slots.map((position, index) => {
    const candidates = available
      .filter((candidate) => !used.has(String(candidate.id)) && positionMultiplier(candidate, position) > 0)
      .sort((left, right) => right.ability * positionMultiplier(right, position) - left.ability * positionMultiplier(left, position));
    const player = candidates[Math.min(offset, candidates.length - 1)] ?? candidates[0];
    assert.ok(player, `missing ${position}`);
    used.add(String(player.id));
    return { slotId: `starter_${index + 1}`, position, playerId: String(player.id) };
  });
  return {
    displayName,
    formationId: formation.id,
    lineup: { starters, tacticId },
    chemistry: calculateChemistry(starters)
  };
}

test("Gate 1连续核心使用固定时间步、唯一状态和同源动作账本", () => {
  const result = simulateContinuousMatch(buildSide("蓝队"), buildSide("橙队", "balanced", 1), "gate-1-authoritative-world");
  assert.equal(result.engine, "authoritative-continuous-core-v1");
  assert.equal(result.configVersion, continuousEngineConfig.version);
  assert.equal(result.durationSeconds, 5400);
  assert.equal(result.teams.home.players.length, 11);
  assert.equal(result.teams.away.players.length, 11);
  assert.ok(result.snapshots.length >= 10000);
  assert.ok(result.actions.length > 100);
  assert.ok(result.actions.some((action) => action.type === "pass"));
  assert.ok(result.actions.some((action) => action.type === "shot"));
  assert.ok(result.actions.some((action) => action.type === "halftime"));
  assert.ok(result.actions.some((action) => action.type === "full_time"));
  assert.deepEqual(result.halftime.directions, { home: -1, away: 1 });
  assert.ok(result.snapshots.every((frame) => frame.players.length === 22));
  assert.ok(result.snapshots.every((frame) => [null, "home", "away"].includes(frame.possessionTeam)));
  assert.ok(result.actions.filter((action) => action.type === "pass").every((action) => action.tickEnd >= action.tickStart));
  assert.ok(result.actions.filter((action) => action.type === "shot").every((action) => action.startPosition && action.endPosition));
  assert.ok(result.actions.filter((action) => action.type === "shot" && action.outcome === "saved").every((action) => {
    const direction = action.team === "home"
      ? (action.period === 1 ? 1 : -1)
      : (action.period === 1 ? -1 : 1);
    const goalX = direction > 0 ? continuousEngineConfig.pitch.length : 0;
    return (action.endPosition.x - goalX) * direction < 0;
  }), "被扑射门必须在越过球门线前与门将接触");
  const homeStriker = result.teams.home.players.find((player) => player.position === "ST");
  const homeHoldingMidfielder = result.teams.home.players.find((player) => player.position === "CDM");
  const strikerDefensiveX = result.snapshots
    .filter((frame) => frame.period === 1 && frame.possessionTeam === "away")
    .map((frame) => frame.players.find((player) => player.team === "home" && player.id === homeStriker.id)?.x)
    .filter(Number.isFinite);
  const holdingMidfielderAttackingX = result.snapshots
    .filter((frame) => frame.period === 1 && frame.possessionTeam === "home")
    .map((frame) => frame.players.find((player) => player.team === "home" && player.id === homeHoldingMidfielder.id)?.x)
    .filter(Number.isFinite);
  const movementIntents = new Set(result.snapshots.flatMap((frame) => frame.players.map((player) => player.intent)));
  for (const intent of ["screen_pivot", "hold_defensive_line", "pivot_support", "overlap_run", "attack_space", "late_box_run", "edge_box_support", "mark_box_threat", "protect_box", "recover_midfield", "counter_outlet", "step_up_support", "tuck_in_rest_defense", "retreat_after_keeper_claim"]) {
    assert.ok(movementIntents.has(intent), `missing tactical movement intent ${intent}`);
  }
  for (const frame of result.snapshots) {
    for (const team of ["home", "away"]) {
      const lateRunners = frame.players.filter((player) => player.team === team && player.intent === "late_box_run");
      assert.ok(lateRunners.length <= continuousEngineConfig.attacking.maximumLateRunners, "同一时刻只能安排有限数量的中场后插上");
    }
    const ballBeyondGoalLine = frame.ball.x < 0 || frame.ball.x > continuousEngineConfig.pitch.length;
    if (ballBeyondGoalLine) {
      assert.equal(frame.ball.state, "dead", "只有已经判定进球的死球可以停在球网内");
      assert.ok(Math.abs(frame.ball.y - continuousEngineConfig.pitch.width / 2) < continuousEngineConfig.pitch.goalWidth / 2, "球网内的球必须从门框范围内越线");
    }
  }
  const boxMarkingSamples = [];
  for (const frame of result.snapshots) {
    const explicitMarkers = frame.players.filter((player) => player.intent === "mark_box_threat" && player.markingTarget);
    assert.equal(new Set(explicitMarkers.map((player) => player.markingTarget)).size, explicitMarkers.length, "禁区威胁必须由不同防守球员分别接管");
    for (const marker of explicitMarkers) {
      const [attackingTeam, attackerId] = marker.markingTarget.split(":");
      const attacker = frame.players.find((player) => player.team === attackingTeam && player.id === attackerId);
      if (!attacker) continue;
      const ownGoalX = marker.team === "home" ? (frame.period === 1 ? 0 : 105) : (frame.period === 1 ? 105 : 0);
      const markerTargetGoalDistance = Math.abs(marker.targetX - ownGoalX);
      const attackerGoalDistance = Math.abs(attacker.x - ownGoalX);
      assert.ok(markerTargetGoalDistance <= attackerGoalDistance + 1.5, "盯防目标点必须优先位于进攻者与球门之间");
      boxMarkingSamples.push({
        awareness: marker.defensiveAwareness,
        gap: Math.hypot(marker.targetX - attacker.x, marker.targetY - attacker.y)
      });
    }
  }
  assert.ok(boxMarkingSamples.length > 20, "必须形成可审计的禁区盯防样本");
  const awarenessLevels = new Set(boxMarkingSamples.map((sample) => sample.awareness));
  assert.ok(awarenessLevels.size > 1, "盯防模型必须保留球员防守意识差异");
  const higherAwarenessMarks = boxMarkingSamples.filter((sample) => sample.awareness >= 0.8);
  const lowerAwarenessMarks = boxMarkingSamples.filter((sample) => sample.awareness < 0.8);
  assert.ok(higherAwarenessMarks.length && lowerAwarenessMarks.length, "必须覆盖不同档次的防守意识");
  const averageGap = (samples) => samples.reduce((sum, sample) => sum + sample.gap, 0) / samples.length;
  assert.ok(averageGap(higherAwarenessMarks) < averageGap(lowerAwarenessMarks), "高盯人、选位和预判球员应保持更紧密的平均盯防距离");
  assert.ok(Math.min(...strikerDefensiveX) < 65, "防守方前锋必须回撤参与防守结构");
  assert.ok(Math.max(...holdingMidfielderAttackingX) - Math.min(...holdingMidfielderAttackingX) > 10, "有球方后腰必须纵向接应而非只做横向平移");
  const footballShape = result.invariantReport.metrics.footballShape;
  assert.ok(footballShape.fullbackAdvanceRate >= 0.03, "进入进攻阶段后边后卫必须提供真实纵深，而不只是挂上套边标签");
  assert.ok(footballShape.restDefenseRate >= 0.72, "进攻方必须保留至少两名中卫/后腰构成防反保护");
  assert.ok(footballShape.counterOutletRate >= 0.62, "低位防守时必须保留反击出口，不能十一人全部缩回禁区");
  assert.ok(footballShape.allOutfieldOwnHalfRate <= 0.38, "防守方不能长期所有非门将球员都处于本方半场");
  const shots = result.actions.filter((action) => action.type === "shot");
  for (const shot of shots) {
    const direction = shot.team === "home" ? (shot.period === 1 ? 1 : -1) : (shot.period === 1 ? -1 : 1);
    const crossedGoalLine = direction > 0
      ? shot.endPosition.x > continuousEngineConfig.pitch.length
      : shot.endPosition.x < 0;
    assert.equal(crossedGoalLine, ["goal", "own_goal"].includes(shot.outcome), "只有进球或乌龙球的终点可以越过球门线");
  }
  const penaltyDepth = continuousEngineConfig.attacking.penaltyBoxEntryDepth;
  const deepRecycleDepth = continuousEngineConfig.attacking.deepRecycleMinimumDepth;
  const boxPasses = result.actions.filter((action) => {
    if (action.type !== "pass" || !action.startPosition || !action.endPosition) return false;
    const direction = action.team === "home" ? (action.period === 1 ? 1 : -1) : (action.period === 1 ? -1 : 1);
    const startDepth = direction > 0 ? action.startPosition.x : continuousEngineConfig.pitch.length - action.startPosition.x;
    return startDepth >= penaltyDepth;
  });
  const aimlessDeepRecycles = boxPasses.filter((action) => {
    const direction = action.team === "home" ? (action.period === 1 ? 1 : -1) : (action.period === 1 ? -1 : 1);
    const endDepth = direction > 0 ? action.endPosition.x : continuousEngineConfig.pitch.length - action.endPosition.x;
    return endDepth < deepRecycleDepth && Math.hypot(action.endPosition.x - action.startPosition.x, action.endPosition.y - action.startPosition.y) > continuousEngineConfig.attacking.maximumPurposefulCutbackLength;
  });
  assert.ok(!boxPasses.length || aimlessDeepRecycles.length / boxPasses.length <= 0.12, "禁区内不应频繁出现跨越很远距离的无意义回传");
  assert.equal(result.invariantReport.passed, true, result.invariantReport.errors.join("; "));
});

test("Gate 1审计器能独立复算传球、射门、进球和运动不变量", () => {
  const result = simulateContinuousMatch(buildSide("主队", "possession"), buildSide("客队", "counter", 2), "gate-1-ledger-audit");
  const report = validateContinuousMatch(result);
  assert.equal(report.passed, true, report.errors.join("; "));
  for (const team of ["home", "away"]) {
    const passes = result.actions.filter((action) => action.team === team && action.type === "pass");
    const shots = result.actions.filter((action) => action.team === team && action.type === "shot");
    assert.equal(result.stats[team].passes, passes.length);
    assert.equal(result.stats[team].completedPasses, passes.filter((action) => action.outcome === "complete").length);
    assert.equal(result.stats[team].shots, shots.length);
    assert.equal(result.score[team], shots.filter((action) => ["goal", "own_goal"].includes(action.outcome)).length);
    assert.ok(shots.every((shot) => {
      const goalX = team === "home"
        ? (shot.period === 1 ? 105 : 0)
        : (shot.period === 1 ? 0 : 105);
      return Math.hypot(shot.startPosition.x - goalX, shot.startPosition.y - 34) <= continuousEngineConfig.decision.absoluteShotDistance + 0.01;
    }));
  }
  assert.equal(result.audit.movementViolations.length, 0);
  assert.equal(result.audit.boundsViolations.length, 0);
  assert.equal(result.audit.possessionViolations.length, 0);
  assert.ok(result.audit.maximumObservedSpeed <= continuousEngineConfig.movement.outfieldAbsoluteMaxSpeed + 0.01);
});

test("Gate 1基础比赛分布不得退化为篮球比分或无意义传球", () => {
  const rows = Array.from({ length: continuousEngineConfig.calibration.minimumSampleMatches }, (_, index) => {
    const result = simulateContinuousMatch(
      buildSide("主队"),
      buildSide("客队", "balanced", 1),
      `gate-1-sanity-${index}`,
      { captureSnapshots: false }
    );
    assert.equal(result.invariantReport.passed, true, result.invariantReport.errors.join("; "));
    return {
      totalGoals: result.score.home + result.score.away,
      totalShots: result.stats.home.shots + result.stats.away.shots,
      totalXg: result.stats.home.xg + result.stats.away.xg,
      totalPasses: result.stats.home.passes + result.stats.away.passes,
      successfulTackles: result.stats.home.tackles + result.stats.away.tackles,
      interceptions: result.stats.home.interceptions + result.stats.away.interceptions,
      offsides: result.stats.home.offsides + result.stats.away.offsides,
      clearances: result.stats.home.clearances + result.stats.away.clearances
    };
  });
  for (const [metric, [minimum, maximum]] of Object.entries(continuousEngineConfig.calibration.sanityBandsPerMatch)) {
    const average = rows.reduce((sum, row) => sum + row[metric], 0) / rows.length;
    assert.ok(average >= minimum && average <= maximum, `${metric} average ${average} outside ${minimum}-${maximum}`);
  }
});
