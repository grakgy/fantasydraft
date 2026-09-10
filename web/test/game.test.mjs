import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createAppServer } from "../server.mjs";
import { aiDifficultyRatingModifier, calculatePlayerTeamRatings, generateSchedule, initializeSeason, simulateSeason, simulateSeasonRound, tacticChanceFactors, playerStyleChanceFactors } from "../lib/engine.mjs";
import {
  simulateContinuousPvpMatch as simulatePvpMatch,
  appendPenaltyShootout,
  penaltyShootoutProbabilities
} from "../lib/continuous-pvp-match.mjs";
import { continuousEngineConfig } from "../lib/continuous-match-engine.mjs";
import {
  formations,
  engineData,
  opponentsConfig,
  opponentRosters,
  balance,
  gameplay,
  draftPoolsConfig,
  draftEligiblePlayers,
  draftPoolAssignments,
  draftPlaystyles,
  createVoucherSequence,
  samplePlayerForm,
  allRegisteredPositions,
  calculateChemistry,
  positionMultiplier,
  tacticalFitForPlayer,
  validateLineup
} from "../lib/context.mjs";

test("20队双循环生成38轮380场且每组主客场各一次", () => {
  const teamIds = opponentsConfig.opponents.map((club) => club.id);
  const schedule = generateSchedule(teamIds);
  assert.equal(schedule.length, 380);
  assert.equal(new Set(schedule.map((fixture) => `${fixture.homeId}>${fixture.awayId}`)).size, 380);
  const appearances = Object.fromEntries(teamIds.map((id) => [id, 0]));
  const homeMatches = Object.fromEntries(teamIds.map((id) => [id, 0]));
  const awayMatches = Object.fromEntries(teamIds.map((id) => [id, 0]));
  for (const fixture of schedule) {
    appearances[fixture.homeId] += 1;
    appearances[fixture.awayId] += 1;
    homeMatches[fixture.homeId] += 1;
    awayMatches[fixture.awayId] += 1;
  }
  assert.deepEqual(new Set(Object.values(appearances)), new Set([38]));
  assert.deepEqual(new Set(Object.values(homeMatches)), new Set([19]));
  assert.deepEqual(new Set(Object.values(awayMatches)), new Set([19]));
  for (const teamId of teamIds) {
    let previousVenue = null;
    let currentStreak = 0;
    let maximumStreak = 0;
    const opponentsByHalf = [new Set(), new Set()];
    for (let round = 1; round <= 38; round += 1) {
      const fixture = schedule.find((item) => item.round === round && [item.homeId, item.awayId].includes(teamId));
      const venue = fixture.homeId === teamId ? "home" : "away";
      const opponentId = fixture.homeId === teamId ? fixture.awayId : fixture.homeId;
      currentStreak = venue === previousVenue ? currentStreak + 1 : 1;
      maximumStreak = Math.max(maximumStreak, currentStreak);
      previousVenue = venue;
      opponentsByHalf[round <= 19 ? 0 : 1].add(opponentId);
    }
    assert.ok(maximumStreak <= 2, `${teamId}连续主客场不能超过2轮`);
    assert.deepEqual(opponentsByHalf.map((set) => set.size), [19, 19]);
  }
});

function buildValidRun() {
  const formation = formations.get("4-3-3");
  const available = engineData.players.filter((player) => player.dataQuality?.status === "PASS");
  const used = new Set();
  const starters = formation.slots.map((position, index) => {
    const player = available
      .filter((candidate) => !used.has(String(candidate.id)) && positionMultiplier(candidate, position) > 0)
      .sort((a, b) => b.ability * positionMultiplier(b, position) - a.ability * positionMultiplier(a, position))[0];
    assert.ok(player, `missing ${position}`);
    used.add(String(player.id));
    return { slotId: `starter_${index + 1}`, position, playerId: String(player.id) };
  });
  const lineup = { starters, tacticId: "balanced" };
  return {
    replacedClub: opponentsConfig.opponents[0],
    squadIds: [...used],
    lineup,
    chemistry: calculateChemistry(starters)
  };
}

test("完整赛季模拟返回20队、380场、玩家38场和11人统计", () => {
  const season = simulateSeason(buildValidRun());
  assert.equal(season.rounds, 38);
  assert.equal(season.leagueMatchCount, 380);
  assert.equal(season.standings.length, 20);
  assert.equal(season.playerFixtures.length, 38);
  assert.equal(season.playerStats.length, 11);
  assert.ok(season.standings.every((row) => row.played === 38));
  assert.equal(season.standings.reduce((sum, row) => sum + row.won, 0), season.standings.reduce((sum, row) => sum + row.lost, 0));
  assert.ok(season.playerStats.every((row) => !Object.hasOwn(row, "fmAttributes")));
  assert.equal(season.roundSnapshots.length, 38);
  assert.ok(season.playerFixtures.some((fixture) => fixture.events.some((event) => event.side === "opponent" && event.playerName)));
  assert.ok(season.playerFixtures.every((fixture) => fixture.events.every((event) => ["goal", "error", "own_goal"].includes(event.type))));
  assert.ok(season.playerFixtures.every((fixture) => fixture.playerRatings.length === 11));
  assert.ok(season.playerStats.every((row) => row.recentRatings.length === 5));
  const matchRatings = season.playerFixtures.flatMap((fixture) => fixture.playerRatings.map((player) => player.rating));
  assert.ok(Math.min(...matchRatings) < 6, "低迷表现必须能够低于6分");
  assert.ok(Math.max(...matchRatings) >= 8, "决定比赛的表现必须能够达到8分");
  assert.ok(season.playerStats.every((row) => !Object.hasOwn(row, "yellowCards") && !Object.hasOwn(row, "redCards") && !Object.hasOwn(row, "injuries")));
});

test("新版赛季初始化时不预生成赛果并且每次只结算一轮", () => {
  const run = buildValidRun();
  const season = initializeSeason(run, { random: () => 0.5 });
  assert.equal(season.version, 2);
  assert.equal(season.playerFixtures.length, 0);
  assert.equal(season.fixtures.length, 0);
  simulateSeasonRound(run, season, { random: () => 0.5 });
  assert.equal(season.roundSnapshots.length, 1);
  assert.equal(season.playerFixtures.length, 1);
  assert.equal(season.fixtures.length, 10);
  assert.ok(season.playerStats.every((player) => player.appearances === 1));
});

test("AI整季状态概率完整且强弱差距配置不硬改积分", () => {
  assert.equal(gameplay.aiTeamSeasonForm.tiers.reduce((sum, tier) => sum + tier.probabilityPct, 0), 100);
  assert.equal(gameplay.aiTeamForm.tiers.reduce((sum, tier) => sum + tier.probabilityPct, 0), 100);
  assert.ok(gameplay.aiTeamStrengthSpread.multiplier > 1);
  assert.equal(Object.hasOwn(gameplay, "minimumLeaguePoints"), false);
});

test("AI基础降难并按整局池券质量补偿差签", () => {
  const standard = { poolSequence: ["legend", "legend", "legend", "legend", "star", "star", "star", "star", "player", "player", "player"] };
  const greenHeavy = { poolSequence: ["legend", "legend", "legend", "star", "star", "star", "star", "player", "player", "player", "player"] };
  const extreme = { poolSequence: Array(11).fill("player") };
  const lucky = { poolSequence: ["legend", "legend", "legend", "legend", "legend", "star", "star", "star", "player", "player", "player"] };

  assert.equal(aiDifficultyRatingModifier(standard), -2.5);
  assert.equal(aiDifficultyRatingModifier(standard, { versusPlayer: true }), -2.5);
  assert.equal(aiDifficultyRatingModifier(greenHeavy, { versusPlayer: true }), -2.9);
  assert.equal(aiDifficultyRatingModifier(extreme, { versusPlayer: true }), -3.7);
  assert.equal(aiDifficultyRatingModifier(lucky, { versusPlayer: true }), -2.5);
  assert.equal(aiDifficultyRatingModifier({ poolSequence: ["player"] }, { versusPlayer: true }), -2.5);
});

test("25/26球队、真实名单和FM八维展示配置一致", () => {
  const ids = new Set(opponentsConfig.opponents.map((club) => club.id));
  assert.equal(ids.size, 20);
  for (const id of ["burnley", "west_ham", "wolves"]) assert.ok(ids.has(id));
  for (const id of ["coventry_city", "hull_city", "ipswich_town"]) assert.equal(ids.has(id), false);
  assert.ok([...ids].every((id) => (opponentRosters.get(id) ?? []).length >= 25));
  assert.deepEqual(balance.draft.candidateCard.outfieldAxisOrder, ["防守", "身体", "速度", "视野", "进攻", "技术", "制空", "精神"]);
  assert.deepEqual(balance.draft.candidateCard.goalkeeperAxisOrder, ["拦截射门", "身体", "速度", "精神", "指挥防守", "意外性", "制空", "大脚开球"]);
});

test("阵容固定为11名有效首发且没有替补字段", () => {
  const validRun = buildValidRun();
  const lineup = validateLineup(
    { formationId: "4-3-3", squadIds: validRun.lineup.starters.map((item) => item.playerId) },
    { starters: validRun.lineup.starters, tacticId: "balanced" },
    (_status, message) => new Error(message)
  );
  assert.equal(lineup.starters.length, 11);
  assert.equal(Object.hasOwn(lineup, "bench"), false);
});

test("选秀池固定900人且随机池券遵循4/4/3权重", () => {
  assert.equal(draftEligiblePlayers.length, 900);
  assert.deepEqual(draftPoolsConfig.stats.counts, { legend: 156, star: 344, player: 400 });
  assert.deepEqual(createVoucherSequence(() => 0), Array(11).fill("legend"));
  assert.deepEqual(createVoucherSequence(() => 4 / 11), Array(11).fill("star"));
  assert.deepEqual(createVoucherSequence(() => 8 / 11), Array(11).fill("player"));
  assert.equal(balance.draft.minSquadSize, 11);
  assert.equal(balance.draft.maxSquadSize, 11);
  assert.equal(balance.draft.optionsPerRound, 5);
});

test("球员状态按8/13/19/20/19/13/8分布且文案均为四字", () => {
  assert.deepEqual(balance.formState.tiers.map((tier) => tier.probabilityPct), [8, 13, 19, 20, 19, 13, 8]);
  assert.deepEqual(balance.formState.tiers.map((tier) => tier.abilityModifierPct), [-9, -6, -3, 0, 3, 6, 9]);
  assert.ok(balance.formState.tiers.every((tier) => tier.labels.length > 0 && tier.labels.every((label) => [...label].length === 4)));
  const rolls = [0, 0.08, 0.21, 0.4, 0.6, 0.79, 0.92];
  assert.deepEqual(rolls.map((roll) => {
    const values = [roll, 0];
    return samplePlayerForm(() => values.shift()).value;
  }), [-3, -2, -1, 0, 1, 2, 3]);
});

test("选秀时锁定的状态按每级3%影响真实比赛能力", () => {
  const run = buildValidRun();
  const forms = (value) => Object.fromEntries(run.squadIds.map((id) => [id, {
    value,
    label: value > 0 ? "状态爆棚" : "状态极差",
    abilityModifierPct: value * 3
  }]));
  const high = calculatePlayerTeamRatings({ ...run, playerFormById: forms(3) });
  const low = calculatePlayerTeamRatings({ ...run, playerFormById: forms(-3) });
  for (const area of ["attack", "midfield", "defense", "goalkeeper"]) {
    assert.ok(high[area] > low[area], `${area}必须受到已锁定状态影响`);
  }
});

test("赛季选择事件会真实影响比赛能力并持续到赛季结束", () => {
  const run = buildValidRun();
  run.playerFormById = Object.fromEntries(run.squadIds.map((id) => [id, { value: 0, label: "状态正常", abilityModifierPct: 0 }]));
  run.seasonProgress = 5;
  const base = calculatePlayerTeamRatings(run);
  const playerId = run.lineup.starters[0].playerId;
  run.seasonFlow = {
    activeEffects: [{ playerId, formDelta: 0, attributeModifierPct: 12, appliedRound: 5, expiresAfterRound: 38 }]
  };
  const affected = calculatePlayerTeamRatings(run);
  assert.ok(Object.keys(base).some((area) => affected[area] > base[area]), "全属性事件必须改变真实阵容能力");
  run.seasonProgress = 37;
  assert.deepEqual(calculatePlayerTeamRatings(run), affected, "事件效果必须持续到赛季最后一轮");
  run.seasonProgress = 38;
  assert.deepEqual(calculatePlayerTeamRatings(run), base, "赛季结束后效果必须失效");
});

test("PVE战术不再直接修改阵容攻防实力", () => {
  const run = buildValidRun();
  const balanced = calculatePlayerTeamRatings({ ...run, lineup: { ...run.lineup, tacticId: "balanced" } });
  const allOutAttack = calculatePlayerTeamRatings({ ...run, lineup: { ...run.lineup, tacticId: "all_out_attack" } });
  assert.deepEqual(allOutAttack, balanced);
  assert.deepEqual(tacticChanceFactors("all_out_attack"), { own: 1.105, opponent: 1.135 });
  assert.notDeepEqual(tacticChanceFactors("possession"), tacticChanceFactors("counter"));
});

test("球队风格契合来自真实属性并进入赛季机会计算", () => {
  assert.equal(draftPlaystyles.size, 4);
  assert.deepEqual([...draftPlaystyles.keys()].sort(), ["counter", "high_press", "possession", "wide"]);
  const player = engineData.players.find((candidate) => candidate.name === "Kylian Mbappé");
  const fits = [...draftPlaystyles.keys()].map((playstyleId) => tacticalFitForPlayer(playstyleId, player));
  assert.ok(fits.every((fit) => fit && fit.score >= 0 && fit.score <= 100));
  assert.ok(new Set(fits.map((fit) => fit.score)).size > 1, "不同风格必须依据真实属性产生不同诊断");
  assert.ok(fits.every((fit) => fit.strongest && fit.weakest));
  const weak = playerStyleChanceFactors({ playstyleId: "wide", lineup: { tacticId: "wide" } }, { styleExecution: { styleId: "wide", score: 55 } }, "balanced");
  const strong = playerStyleChanceFactors({ playstyleId: "wide", lineup: { tacticId: "wide" } }, { styleExecution: { styleId: "wide", score: 85 } }, "balanced");
  assert.ok(strong.own > weak.own, "更适合边路打法的阵容必须创造更多机会");
});

test("连续2D比赛的动作、统计、评分和22人坐标严格对应", () => {
  const valid = buildValidRun();
  const side = { displayName: "测试队", formationId: "4-3-3", lineup: valid.lineup, chemistry: valid.chemistry };
  const match = simulatePvpMatch(side, { ...side, displayName: "对手队" }, "continuous-2d-test");
  assert.equal(match.version, 6);
  assert.match(match.engine, /authoritative-continuous-core/);
  assert.ok(match.events.length >= 20);
  assert.ok(match.durationMs >= 20000 && match.durationMs <= 300000);
  assert.ok(match.frames.length > 50 && match.frames.length <= 1000);
  assert.ok(match.frames.every((frame) => frame.positions.length === 22));
  assert.ok(match.frames.every((frame, index) => Number.isFinite(frame.atMs) && (!index || frame.atMs >= match.frames[index - 1].atMs)));
  assert.ok(match.frames.some((frame) => frame.mode === "fast_forward"));
  assert.ok(match.frames.filter((frame) => frame.mode === "highlight" && frame.cut).every((frame) => frame.half === 3), "只有点球大战每轮重新摆球时允许硬切");
  const kickoffFrames = match.frames.filter((frame) => frame.highlightId === "kickoff-opening");
  assert.ok(kickoffFrames.length >= 4, "开球片段必须包含连续画面");
  assert.ok(kickoffFrames.at(-1).atMs - kickoffFrames[0].atMs >= 1900 && kickoffFrames.at(-1).atMs - kickoffFrames[0].atMs <= 2100);
  assert.ok(Math.hypot(kickoffFrames[0].ball.x - 50, kickoffFrames[0].ball.y - 50) < 1.5, "开球前足球必须位于中圈");
  assert.ok(Math.hypot(kickoffFrames.at(-1).ball.x - kickoffFrames[0].ball.x, kickoffFrames.at(-1).ball.y - kickoffFrames[0].ball.y) > 1, "开球片段必须展示足球离开中圈");
  const kickoff = match.events.find((event) => event.type === "kickoff");
  const openingPass = match.events.find((event) => event.type === "pass");
  assert.equal(openingPass.technique, "kickoff_back_pass", "开球第一脚必须回传，不能由开球队员直接带球");
  assert.ok(kickoff.team === "home" ? kickoffFrames.at(-1).ball.x < 50 : kickoffFrames.at(-1).ball.x > 50, "开球必须把球送回本方半场");
  const defendingSide = kickoff.team === "home" ? "away" : "home";
  const defendingIndexes = match.playerOrder.map((player, index) => player.team === defendingSide ? index : -1).filter((index) => index >= 0);
  assert.ok(defendingIndexes.every((index) => Math.abs(kickoffFrames[0].positions[index][0] - 50) > 7.5), "开球前防守方必须退出中圈，不能立即上抢");
  assert.ok(match.events.every((event) => Number.isInteger(event.frameIndex) && event.frameIndex >= 0 && event.frameIndex < match.frames.length));
  assert.ok(match.events.every((event) => typeof event.text === "string" && event.text.length >= 12 && typeof event.summary === "string"));
  const halftime = match.events.find((event) => event.type === "halftime");
  assert.equal(match.frames[halftime.frameIndex].half, 2);
  assert.equal(match.frames[halftime.frameIndex].mode, "period");
  assert.equal(match.frames[halftime.frameIndex].minute, 45);
  assert.equal(match.frames.at(-1).minute, 90);
  const homeGoalkeeperId = match.teams.home.players.find((player) => player.position === "GK").id;
  const homeGoalkeeperIndex = match.playerOrder.findIndex((player) => player.team === "home" && player.id === homeGoalkeeperId);
  const lastFirstHalfFrame = match.frames.filter((frame) => frame.half === 1).at(-1);
  const firstSecondHalfFrame = match.frames.find((frame) => frame.half === 2);
  assert.ok(lastFirstHalfFrame.positions[homeGoalkeeperIndex][0] < 20);
  assert.ok(firstSecondHalfFrame.positions[homeGoalkeeperIndex][0] > 80);
  const types = new Set(match.events.map((event) => event.type));
  for (const type of ["kickoff", "pass", "shot", "halftime", "full_time"]) assert.ok(types.has(type), `missing ${type}`);
  assert.ok(match.audit.passed, match.audit.errors?.join("; "));
  for (const team of ["home", "away"]) {
    const eventShots = match.events.filter((event) => event.team === team && event.type === "shot").length;
    const eventGoals = match.events.filter((event) => event.team === team && event.type === "shot" && ["goal", "own_goal"].includes(event.outcome)).length;
    assert.ok(match.stats[team].shots >= eventShots);
    assert.equal(match.score[team], eventGoals);
    assert.ok(match.stats[team].completedPasses <= match.stats[team].passes);
    const finalEventStats = match.events.find((event) => event.type === "full_time").stats[team];
    for (const field of ["passes", "completedPasses", "shots", "shotsOnTarget", "tackles", "interceptions", "clearances", "saves", "corners", "fouls", "offsides"]) assert.equal(match.stats[team][field], finalEventStats[field]);
    assert.equal(match.ratings[team].length, 11);
    assert.equal(match.ratings[team].reduce((sum, player) => sum + player.shots, 0), match.stats[team].shots);
    assert.ok(match.ratings[team].every((player) => player.rating >= 4 && player.rating <= 10 && Number.isFinite(player.xg) && Number.isFinite(player.xa)));
    assert.ok(match.ratings[team].reduce((sum, player) => sum + player.xa, 0) <= match.stats[team].xg + 0.12, "球员xA总和不能超过本队由射门产生的xG");
  }
  assert.ok(match.moments.length > 0);
  assert.ok(match.moments.every((moment) => !["tackle", "clearance"].includes(moment.type)), "普通抢断和普通解围不能独立成为精彩镜头");
  const standaloneSetPieces = match.moments.filter((moment) => /角球|任意球/.test(moment.summary));
  assert.ok(standaloneSetPieces.length <= 2, "定位球用于补充镜头类型，不能挤占大部分高质量射门画面");
  assert.ok(standaloneSetPieces.every((moment) => /被解围/.test(moment.summary)), "没有形成射门或明确解围的定位球不能单独成为精彩镜头");
  for (const period of [1, 2]) {
    const periodMoments = match.moments.filter((moment) => period === 1 ? moment.minute < 45 : moment.minute >= 45 && moment.minute < 90);
    assert.ok(periodMoments.length >= 2, `第${period}半场存在射门时必须保留足够的关键画面`);
  }
  for (const moment of match.moments) {
    const segmentEvents = match.events.filter((event) => event.highlightId === moment.id);
    assert.ok(segmentEvents.some((event) => (
      event.type === "shot"
      || event.type === "disallowed_goal"
      || event.type === "penalty"
      || event.type === "penalty_shootout"
      || (event.type === "pass" && ["角球传中", "角球被解围", "任意球传中", "任意球被解围"].some((label) => event.summary.includes(label)))
    )), `精彩镜头${moment.id}缺少明确结果`);
    const firstFrame = match.frames[moment.replayStartFrame];
    const lastFrame = match.frames[moment.replayEndFrame];
    if (firstFrame.half < 3 && lastFrame.tick > firstFrame.tick) {
      const naturalMs = (lastFrame.tick - firstFrame.tick) / continuousEngineConfig.clock.tickRate * 1000;
      const playbackMs = lastFrame.atMs - firstFrame.atMs;
      assert.ok(playbackMs <= naturalMs * 1.02, `精彩镜头${moment.id}不得为了凑总时长强行慢放`);
    }
  }
  assert.equal(Object.hasOwn(match, "summary"), false, "没有阵容对位模型时不得根据赛后统计倒推总结");
  const totalCorners = match.stats.home.corners + match.stats.away.corners;
  if (totalCorners > 0) {
    assert.ok(match.events.some((event) => event.summary.includes("角球")), "发生角球的比赛必须展示至少一个完整角球片段");
  }
});

test("点球大战固定同一球门且命中概率由罚球与门将属性决定", () => {
  const typical = penaltyShootoutProbabilities(75, 75);
  const elite = penaltyShootoutProbabilities(90, 75);
  const weak = penaltyShootoutProbabilities(58, 82);
  assert.ok(typical.goal >= 0.7 && typical.goal <= 0.8);
  assert.ok(elite.goal > typical.goal && weak.goal < typical.goal);
  for (const probabilities of [typical, elite, weak]) {
    assert.ok(Math.abs(probabilities.goal + probabilities.saved + probabilities.missed - 1) < 1e-9);
  }

  const makeTeam = (team) => ({
    players: [
      { id: `${team}-gk`, name: `${team}门将`, position: "GK", penaltyTaking: 20, composure: 72, goalkeeping: 78, reflexes: 80 },
      ...Array.from({ length: 10 }, (_, index) => ({
        id: `${team}-${index}`,
        name: `${team}球员${index}`,
        position: index < 4 ? "ST" : "CM",
        penaltyTaking: 68 + index * 2,
        composure: 70 + index,
        goalkeeping: 10,
        reflexes: 10
      }))
    ]
  });
  const teams = { home: makeTeam("home"), away: makeTeam("away") };
  const basePlayers = Object.entries(teams).flatMap(([team, value]) => value.players.map((player, index) => ({
    ...player,
    team,
    x: team === "home" ? 35 : 70,
    y: 8 + index * 5,
    vx: 0,
    vy: 0,
    targetX: team === "home" ? 35 : 70,
    targetY: 8 + index * 5,
    intent: "full_time",
    markingTarget: null
  })));
  const result = {
    score: { home: 0, away: 0 },
    teams,
    actions: [],
    snapshots: [{ tick: 108000, matchTime: 5400, period: 2, players: basePlayers, ball: { x: 52.5, y: 34 }, phases: { home: "full_time", away: "full_time" } }]
  };
  appendPenaltyShootout(result, "fixed-goal-shootout-test");
  const kicks = result.actions.filter((action) => action.type === "penalty_shootout");
  assert.ok(kicks.length >= 6);
  assert.ok(kicks.every((action) => action.startPosition.x === continuousEngineConfig.pitch.length - 11));
  assert.ok(kicks.every((action) => action.endPosition.x === continuousEngineConfig.pitch.length));
  const shootoutFrames = result.snapshots.filter((frame) => frame.period === 3);
  assert.equal(shootoutFrames.length, kicks.length * 6, "每次点球必须包含摆球、站定、助跑、触球、飞行和结果六阶段");
  assert.ok(shootoutFrames.every((frame) => frame.ball.x >= continuousEngineConfig.pitch.length - 11));
  assert.ok(shootoutFrames.filter((frame) => frame.players.some((player) => player.intent === "penalty_goalkeeper_set"))
    .every((frame) => frame.players.find((player) => player.intent === "penalty_goalkeeper_set").x > continuousEngineConfig.pitch.length - 1));
  for (let index = 0; index < kicks.length; index += 1) {
    const frames = shootoutFrames.slice(index * 6, index * 6 + 6);
    const kick = kicks[index];
    assert.equal(frames[0].discontinuity, "penalty_shootout_setup", "新一轮点球必须重新摆球，不能从上一球倒飞回来");
    assert.ok(frames.slice(0, 4).every((frame) => frame.ball.x === continuousEngineConfig.pitch.length - 11), "助跑和触球前足球必须保持在点球点");
    assert.ok(frames[4].ball.x > continuousEngineConfig.pitch.length - 11, "触球后必须展示独立的飞行阶段");
    const runupX = frames.slice(0, 3).map((frame) => frame.players.find((player) => player.team === kick.team && player.id === kick.actorId).x);
    assert.ok(runupX[2] > runupX[1] && runupX[1] >= runupX[0], "主罚球员必须从球后助跑接近点球点");
  }
});

test("公开API创建、候选、选人、恢复和删除均保持服务端权威", async (context) => {
  const server = createAppServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => server.close());
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  const request = async (pathname, options = {}) => {
    const response = await fetch(`${base}${pathname}`, {
      ...options,
      headers: { "content-type": "application/json", ...(options.headers ?? {}) }
    });
    const payload = response.status === 204 ? null : await response.json();
    assert.ok(response.ok, payload?.error);
    return payload;
  };
  const health = await request("/api/health");
  assert.equal(health.publicPlayers, 1402);
  assert.equal(health.draftPlayers, 900);
  assert.equal(health.opponentTemplates, 20);
  assert.equal(health.engineDataExposed, false);

  const clientConfig = await request("/api/config");
  assert.equal(clientConfig.draftPlaystyles.length, 4);
  assert.equal(JSON.stringify(clientConfig.draftPlaystyles).includes("attributes"), false);

  const run = await request("/api/runs", {
    method: "POST",
    body: JSON.stringify({ formationId: "4-3-3", playstyleId: "counter" })
  });
  assert.match(run.runId, /^[a-f0-9]{32}$/);
  assert.equal(run.status, "drafting");
  assert.equal(run.legacyRules, false);
  assert.equal(run.playstyle.id, "counter");
  assert.equal(run.draftLineup.tacticId, "counter");
  assert.equal(run.buildAnalysis.selectedCount, 0);
  assert.ok(run.replacedClub.id);
  assert.equal(Object.values(run.voucherSummary.totals).reduce((sum, count) => sum + count, 0), 11);
  assert.equal(run.voucherSummary.revealedRounds, 0);
  assert.equal(Object.hasOwn(run, "poolSequence"), false);
  for (const forbidden of ["budgetTier", "budgetM", "remainingBudgetM", "priceMap", "draftPriceM", "pricePool"]) {
    assert.equal(JSON.stringify(run).includes(forbidden), false, `leaked ${forbidden}`);
  }

  const candidateResult = await request(`/api/runs/${run.runId}/draft/candidates`, {
    method: "POST",
    body: JSON.stringify({})
  });
  assert.ok(candidateResult.candidates.length > 0);
  assert.ok(candidateResult.candidates.length <= 5);
  assert.equal(candidateResult.voucherSummary.revealedRounds, 1);
  assert.ok(candidateResult.candidates.every((candidate) => candidate.draftPool === candidateResult.voucher.pool));
  assert.ok(candidateResult.candidates.every((candidate) => candidate.tacticalFit?.label && candidate.tacticalFit?.strongest));
  assert.ok(candidateResult.candidates.every((candidate) => !Object.hasOwn(candidate.tacticalFit, "score") && !Object.hasOwn(candidate.tacticalFit, "signalScores")));
  assert.ok(candidateResult.candidates.every((candidate) => candidate.form?.label && [...candidate.form.label].length === 4));
  assert.ok(candidateResult.candidates.every((candidate) => ["up", "normal", "down"].includes(candidate.form.tone)));
  assert.ok(candidateResult.candidates.every((candidate) => !Object.hasOwn(candidate.form, "value") && !Object.hasOwn(candidate.form, "abilityModifierPct")));
  assert.ok(candidateResult.candidates.every((candidate) => draftPoolAssignments.get(candidate.id) === candidateResult.voucher.pool));
  const candidateJson = JSON.stringify(candidateResult);
  for (const forbidden of ["fmAttributes", "ability", "fmValue", "scarcity", "fmAdjustment", "draftPriceM", "pricePool"]) {
    assert.equal(candidateJson.includes(forbidden), false, `leaked ${forbidden}`);
  }

  const blockedReroll = await fetch(`${base}/api/runs/${run.runId}/draft/candidates`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({})
  });
  assert.equal(blockedReroll.status, 409);
  assert.match((await blockedReroll.json()).error, /不能更换本轮候选/);

  const candidate = candidateResult.candidates[0];
  const slot = run.formationSlots.find((item) => allRegisteredPositions(candidate).includes(item.position));
  assert.ok(slot, "candidate must fit an open formation slot");

  const picked = await request(`/api/runs/${run.runId}/draft/picks`, {
    method: "POST",
    body: JSON.stringify({ playerId: candidate.id, slotId: slot.slotId })
  });
  assert.equal(picked.squad.length, 1);
  assert.equal(picked.draftLineup.starters[0].playerId, candidate.id);
  assert.equal(picked.draftLineup.starters[0].slotId, slot.slotId);
  assert.equal(picked.buildAnalysis.selectedCount, 1);
  assert.equal(picked.buildAnalysis.signals.length, 3);
  assert.ok(picked.buildAnalysis.signals.every((signal) => signal.label && signal.level && !Object.hasOwn(signal, "score")));
  assert.equal(JSON.stringify(picked.buildAnalysis).includes("仍缺"), false);
  const restored = await request(`/api/runs/${run.runId}`);
  assert.equal(restored.squad[0].id, picked.squad[0].id);
  assert.deepEqual(restored.squad[0].form, candidate.form, "球员状态必须在选中和刷新后保持不变");

  await request(`/api/runs/${run.runId}`, { method: "DELETE" });
});

test("PVE逐轮结算在R19进入无概率冬窗且换人不可撤销", async (context) => {
  const server = createAppServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (pathname, options = {}) => {
    const response = await fetch(`${base}${pathname}`, {
      ...options,
      headers: { "content-type": "application/json", ...(options.headers ?? {}) }
    });
    const payload = response.status === 204 ? null : await response.json();
    assert.ok(response.ok, payload?.error);
    return payload;
  };
  const resolvePendingEvent = async (runId, currentSeason) => {
    if (!currentSeason.pendingEvent) return currentSeason;
    assert.equal(currentSeason.pendingEvent.status, "awaiting_choice");
    assert.equal(Object.keys(currentSeason.pendingEvent.player.summaryRatings).length, 8);
    assert.equal(currentSeason.pendingEvent.choices.length, 2);
    assert.ok(currentSeason.pendingEvent.choices.every((choice) => choice.label && choice.description));
    for (const forbidden of ["Chance", "probability", "positiveEffect", "negativeEffect", "magnitude", "attributeModifierPct", "baseSummaryRatings", "remainingRounds"]) {
      assert.equal(JSON.stringify(currentSeason.pendingEvent).includes(forbidden), false, `事件接口暴露了 ${forbidden}`);
    }
    const resolved = await request(`/api/runs/${runId}/season/event/choose`, {
      method: "POST",
      body: JSON.stringify({ choiceId: currentSeason.pendingEvent.choices[0].id })
    });
    assert.equal(resolved.pendingEvent.status, "resolved");
    assert.ok(resolved.pendingEvent.result.summary);
    assert.ok(resolved.pendingEvent.result.effects.length > 0);
    assert.equal(/概率/.test(JSON.stringify(resolved.pendingEvent)), false);
    return request(`/api/runs/${runId}/season/event/acknowledge`, { method: "POST", body: "{}" });
  };

  let run = await request("/api/runs", {
    method: "POST",
    body: JSON.stringify({ formationId: "4-3-3", playstyleId: "counter" })
  });
  for (let round = 0; round < 11; round += 1) {
    const draw = await request(`/api/runs/${run.runId}/draft/candidates`, { method: "POST", body: "{}" });
    const candidate = draw.candidates.find((item) => item.compatibleSlotIds.length);
    run = await request(`/api/runs/${run.runId}/draft/picks`, {
      method: "POST",
      body: JSON.stringify({ playerId: candidate.id, slotId: candidate.compatibleSlotIds[0] })
    });
  }
  run = await request(`/api/runs/${run.runId}/lineup`, {
    method: "PUT",
    body: JSON.stringify({ starters: run.draftLineup.starters, tacticId: "counter" })
  });
  let season = await request(`/api/runs/${run.runId}/season/simulate`, { method: "POST", body: "{}" });
  assert.equal(season.progress, 0);
  assert.equal(season.playerFixtures.length, 0);
  const blockedSkip = await fetch(`${base}/api/runs/${run.runId}/season/skip`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}"
  });
  assert.equal(blockedSkip.status, 409);

  while (season.progress < 19) {
    season = await request(`/api/runs/${run.runId}/season/advance`, { method: "POST", body: "{}" });
    if (season.pendingEvent) {
      season = await resolvePendingEvent(run.runId, season);
    }
  }
  assert.equal(season.winterWindow.status, "open");
  assert.equal(season.winterWindow.options.length, 11);
  assert.ok(season.winterWindow.options.every((option) => option.stats.appearances === 19));
  assert.ok(season.winterWindow.options.every((option) => Object.keys(option.player.summaryRatings).length === 8));
  assert.equal(JSON.stringify(season.winterWindow).includes("probability"), false);
  assert.equal(JSON.stringify(season.winterWindow).includes("candidates"), false);

  const selected = season.winterWindow.options[0];
  const outgoingPlayerId = selected.player.id;
  season = await request(`/api/runs/${run.runId}/season/winter-window`, {
    method: "POST",
    body: JSON.stringify({ participate: true, slotId: selected.slotId })
  });
  const transfer = season.winterWindow.transfer;
  assert.equal(season.winterWindow.status, "transferred");
  assert.equal(transfer.outgoingPlayerId, outgoingPlayerId);
  assert.notEqual(transfer.incomingPlayerId, outgoingPlayerId);
  assert.equal(transfer.acknowledged, false);
  assert.equal(Object.keys(transfer.outgoingPlayer.summaryRatings).length, 8);
  assert.equal(Object.keys(transfer.incomingPlayer.summaryRatings).length, 8);
  assert.equal(season.playerStats.length, 12);
  const blockedSecondTransfer = await fetch(`${base}/api/runs/${run.runId}/season/winter-window`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ participate: false })
  });
  assert.equal(blockedSecondTransfer.status, 409);
  const blockedBeforeReview = await fetch(`${base}/api/runs/${run.runId}/season/advance`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}"
  });
  assert.equal(blockedBeforeReview.status, 409);
  season = await request(`/api/runs/${run.runId}/season/winter-window/acknowledge`, { method: "POST", body: "{}" });
  assert.equal(season.winterWindow.transfer.acknowledged, true);

  while (!season.completed) {
    season = await request(`/api/runs/${run.runId}/season/advance`, { method: "POST", body: "{}" });
    if (season.pendingEvent) {
      season = await resolvePendingEvent(run.runId, season);
    }
  }
  assert.equal(season.progress, 38);
  assert.equal(season.eventHistory.length, 7);
  assert.ok(season.review?.headline);
  assert.ok(season.review?.standout?.rating);
  assert.equal(season.playerStats.find((player) => player.playerId === transfer.outgoingPlayerId).appearances, 19);
  assert.equal(season.playerStats.find((player) => player.playerId === transfer.incomingPlayerId).appearances, 19);
  await request(`/api/runs/${run.runId}`, { method: "DELETE" });
});

test("PVP双方共享池券、独立选秀并且必须共同进入球场", async (context) => {
  const server = createAppServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => server.close());
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  const request = async (pathname, { token, ...options } = {}) => {
    const response = await fetch(`${base}${pathname}`, {
      ...options,
      headers: { "content-type": "application/json", ...(token ? { "x-pvp-token": token } : {}), ...(options.headers ?? {}) }
    });
    const payload = response.status === 204 ? null : await response.json();
    assert.ok(response.ok, payload?.error);
    return payload;
  };

  const created = await request("/api/pvp/rooms", { method: "POST", body: "{}" });
  assert.match(created.room.code, /^[A-Z0-9]{6}$/);
  const joined = await request(`/api/pvp/rooms/${created.room.code}/join`, { method: "POST", body: "{}" });
  const code = created.room.code;
  const players = [
    { token: created.token, side: "host" },
    { token: joined.token, side: "guest" }
  ];
  for (const player of players) {
    player.room = await request(`/api/pvp/rooms/${code}/formation`, { token: player.token, method: "PUT", body: JSON.stringify({ formationId: "4-3-3" }) });
  }

  const voucherPools = { host: [], guest: [] };
  for (let round = 0; round < 11; round += 1) {
    for (const player of players) {
      const candidateResult = await request(`/api/pvp/rooms/${code}/draft/candidates`, { token: player.token, method: "POST", body: "{}" });
      voucherPools[player.side].push(candidateResult.voucher.pool);
      const candidate = candidateResult.candidates.find((item) => item.compatibleSlotIds.length);
      assert.ok(candidate);
      player.room = await request(`/api/pvp/rooms/${code}/draft/picks`, {
        token: player.token,
        method: "POST",
        body: JSON.stringify({ playerId: candidate.id, slotId: candidate.compatibleSlotIds[0] })
      });
    }
  }
  assert.deepEqual(voucherPools.host, voucherPools.guest);

  for (const player of players) {
    const starters = player.room.player.draftLineup.starters;
    assert.equal(starters.length, 11);
    player.room = await request(`/api/pvp/rooms/${code}/ready`, {
      token: player.token,
      method: "POST",
      body: JSON.stringify({ starters, tacticId: "balanced" })
    });
  }
  assert.equal(players[1].room.status, "match_ready");
  assert.ok(players[1].room.match.durationMs >= 20000 && players[1].room.match.durationMs <= 300000);
  assert.ok(players[1].room.match.highlights.length > 0);
  assert.ok(players[1].room.match.teams.home.players.every((player) => player.base.x <= 50));
  assert.ok(players[1].room.match.teams.away.players.every((player) => player.base.x >= 50));
  const hostEntered = await request(`/api/pvp/rooms/${code}/enter-match`, { token: players[0].token, method: "POST", body: "{}" });
  assert.equal(hostEntered.match.playback.startedAt, null);
  const guestEntered = await request(`/api/pvp/rooms/${code}/enter-match`, { token: players[1].token, method: "POST", body: "{}" });
  assert.ok(guestEntered.match.playback.startedAt);
  assert.equal(guestEntered.match.playback.bothEntered, true);
});

test("PVP房主可以加入AI完成本地单人测试", async (context) => {
  const server = createAppServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (pathname, { token, ...options } = {}) => {
    const response = await fetch(`${base}${pathname}`, {
      ...options,
      headers: { "content-type": "application/json", ...(token ? { "x-pvp-token": token } : {}) }
    });
    const payload = await response.json();
    assert.ok(response.ok, payload?.error);
    return payload;
  };

  const created = await request("/api/pvp/rooms", {
    method: "POST",
    body: JSON.stringify({ formationId: "4-3-3" })
  });
  const { token } = created;
  const code = created.room.code;
  assert.equal(created.room.player.formationId, "4-3-3");
  const cpuRoom = await request(`/api/pvp/rooms/${code}/add-cpu`, { token, method: "POST", body: "{}" });
  assert.equal(cpuRoom.opponent.isCpu, true);
  assert.equal(cpuRoom.opponent.displayName, "AI 对手");
  assert.equal(cpuRoom.opponent.draftCount, 11);
  assert.equal(cpuRoom.opponent.ready, true);

  let room = cpuRoom;
  for (let round = 0; round < 11; round += 1) {
    const candidates = await request(`/api/pvp/rooms/${code}/draft/candidates`, { token, method: "POST", body: "{}" });
    const candidate = candidates.candidates.find((item) => item.compatibleSlotIds.length);
    room = await request(`/api/pvp/rooms/${code}/draft/picks`, {
      token,
      method: "POST",
      body: JSON.stringify({ playerId: candidate.id, slotId: candidate.compatibleSlotIds[0] })
    });
  }
  room = await request(`/api/pvp/rooms/${code}/ready`, {
    token,
    method: "POST",
    body: JSON.stringify({ starters: room.player.draftLineup.starters, tacticId: "balanced" })
  });
  assert.ok(room.match);
  const entered = await request(`/api/pvp/rooms/${code}/enter-match`, { token, method: "POST", body: "{}" });
  assert.equal(entered.match.playback.bothEntered, true);
  assert.ok(entered.match.playback.startedAt);
  const rematch = await request(`/api/pvp/rooms/${code}/rematch`, { token, method: "POST", body: "{}" });
  assert.equal(rematch.match, null);
  assert.equal(rematch.player.draftCount, 0);
  assert.equal(rematch.opponent.isCpu, true);
  assert.equal(rematch.opponent.draftCount, 11);
  assert.equal(rematch.opponent.ready, true);
});
