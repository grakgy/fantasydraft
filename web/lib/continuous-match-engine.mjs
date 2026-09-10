import crypto from "node:crypto";
import continuousEngineConfig from "../../config/pvp-engine-config.json" with { type: "json" };
import {
  enginePlayers,
  publicPlayers,
  formations,
  clamp,
  mean,
  positionMultiplier,
  playerFormFor
} from "./context.mjs";

export { continuousEngineConfig };

const {
  pitch,
  clock,
  movement,
  ball: ballConfig,
  decision,
  defending,
  attacking,
  goalkeeping,
  firstTimeActions,
  discipline,
  setPieces,
  footballPrinciples,
  tactics: tacticProfiles,
  audit: auditConfig
} = continuousEngineConfig;
const DT = 1 / clock.tickRate;
const EPSILON = 1e-9;
const OUTFIELD_POSITIONS = new Set(["CB", "LB", "RB", "LWB", "RWB", "CDM", "CM", "CAM", "LM", "RM", "LW", "RW", "ST"]);
const DEFENSIVE_POSITIONS = new Set(["CB", "LB", "RB", "LWB", "RWB"]);
const CENTRAL_DEFENDERS = new Set(["CB"]);
const FULLBACKS = new Set(["LB", "RB", "LWB", "RWB"]);
const MIDFIELD_POSITIONS = new Set(["CDM", "CM", "CAM", "LM", "RM"]);
const FORWARD_POSITIONS = new Set(["LW", "RW", "ST"]);

const round = (value, places = 3) => {
  const scale = 10 ** places;
  return Math.round(Number(value) * scale) / scale;
};

const numeric = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const distance = (left, right) => Math.hypot(left.x - right.x, left.y - right.y);
const magnitude = (vector) => Math.hypot(vector.x, vector.y);
const normalize = (vector) => {
  const length = magnitude(vector);
  return length > EPSILON ? { x: vector.x / length, y: vector.y / length } : { x: 0, y: 0 };
};
const dot = (left, right) => left.x * right.x + left.y * right.y;
const vectorTo = (from, to) => ({ x: to.x - from.x, y: to.y - from.y });
const directionOf = (team, period) => (team === "home" ? 1 : -1) * (period === 1 ? 1 : -1);
const otherTeam = (team) => team === "home" ? "away" : "home";
const keyOf = (team, playerId) => `${team}:${playerId}`;

const moderatedTacticProfiles = Object.fromEntries(Object.entries(tacticProfiles).map(([id, profile]) => {
  const balanced = tacticProfiles.balanced;
  const influence = footballPrinciples.tacticalInfluence;
  return [id, Object.fromEntries(Object.entries(profile).map(([key, value]) => {
    if (!Number.isFinite(value) || !Number.isFinite(balanced[key])) return [key, value];
    const moderated = balanced[key] + (value - balanced[key]) * influence;
    return [key, key === "pressers" ? clamp(Math.round(moderated), 1, 2) : moderated];
  }))];
}));

function tacticFor(world, team) {
  return moderatedTacticProfiles[world.teams[team].tacticId] ?? moderatedTacticProfiles.balanced;
}

function roleBand(position) {
  if (position === "GK") return "goalkeeper";
  if (CENTRAL_DEFENDERS.has(position)) return "centre_back";
  if (FULLBACKS.has(position)) return "fullback";
  if (position === "CDM") return "holding_midfield";
  if (["CM", "LM", "RM"].includes(position)) return "midfield";
  if (position === "CAM") return "attacking_midfield";
  if (["LW", "RW"].includes(position)) return "wing";
  return "striker";
}

function laneSide(player) {
  if (player.anchor.y < pitch.width * 0.38) return -1;
  if (player.anchor.y > pitch.width * 0.62) return 1;
  return 0;
}

function seededRandom(seed) {
  let state = Number.parseInt(crypto.createHash("sha256").update(String(seed)).digest("hex").slice(0, 8), 16) >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

function normalRandom(random) {
  const left = Math.max(random(), 1e-8);
  return Math.sqrt(-2 * Math.log(left)) * Math.cos(2 * Math.PI * random());
}

function attribute(source, name, fallback = 10) {
  return clamp(numeric(source?.fmAttributes?.[name], fallback) * 5, 1, 100);
}

function averageAttribute(source, names, fallback = 10) {
  return mean(names.map((name) => attribute(source, name, fallback)));
}

function roleRow(position) {
  if (position === "GK") return 5.5;
  if (["CB", "LB", "RB"].includes(position)) return 22;
  if (["LWB", "RWB"].includes(position)) return 29;
  if (position === "CDM") return 35;
  if (["CM", "LM", "RM"].includes(position)) return 47;
  if (position === "CAM") return 61;
  if (["LW", "RW"].includes(position)) return 75;
  return 82;
}

function roleLane(position, rowIndex, rowCount) {
  if (["LB", "LWB", "LM", "LW"].includes(position)) return 9.5;
  if (["RB", "RWB", "RM", "RW"].includes(position)) return pitch.width - 9.5;
  if (rowCount <= 1) return pitch.width / 2;
  return 15 + rowIndex * ((pitch.width - 30) / (rowCount - 1));
}

function formationAnchors(formation) {
  const rows = new Map();
  formation.slots.forEach((position, index) => {
    const x = roleRow(position);
    if (!rows.has(x)) rows.set(x, []);
    rows.get(x).push({ index, position });
  });
  const anchors = [];
  for (const [x, entries] of rows) {
    const ordered = [...entries].sort((left, right) => roleLane(left.position, 0, 1) - roleLane(right.position, 0, 1));
    ordered.forEach((entry, rowIndex) => {
      anchors[entry.index] = { x, y: roleLane(entry.position, rowIndex, ordered.length) };
    });
  }
  return anchors;
}

function buildAbilities(source, position, familiarity, form) {
  const goalkeeper = position === "GK";
  const formMultiplier = 1 + Number(form?.abilityModifierPct ?? 0) / 100;
  const scaled = (value) => clamp(value * (0.88 + familiarity * 0.12) * formMultiplier, 1, 100);
  if (goalkeeper) {
    return {
      pace: scaled(averageAttribute(source, ["速度", "爆发力", "灵活"])),
      acceleration: scaled(averageAttribute(source, ["爆发力", "灵活"])),
      passing: scaled(averageAttribute(source, ["传球", "大脚开球", "手抛球"])),
      vision: scaled(averageAttribute(source, ["视野", "决断"])),
      decisions: scaled(averageAttribute(source, ["决断", "预判", "集中"])),
      technique: scaled(averageAttribute(source, ["技术", "停球"])),
      firstTouch: scaled(averageAttribute(source, ["停球", "手控球"])),
      dribbling: scaled(attribute(source, "盘带", 6)),
      finishing: scaled(attribute(source, "射门", 2)),
      longShots: scaled(attribute(source, "远射", 2)),
      crossing: scaled(attribute(source, "传中", 4)),
      tackling: scaled(attribute(source, "抢断", 3)),
      positioning: scaled(averageAttribute(source, ["选位", "指挥防守", "集中"])),
      anticipation: scaled(averageAttribute(source, ["预判", "反应"])),
      composure: scaled(averageAttribute(source, ["镇定", "决断"])),
      strength: scaled(averageAttribute(source, ["强壮", "平衡"])),
      heading: scaled(attribute(source, "头球", 5)),
      jumping: scaled(averageAttribute(source, ["弹跳", "制空"])),
      offBall: scaled(averageAttribute(source, ["无球跑动", "预判", "决断"])),
      stamina: scaled(averageAttribute(source, ["耐力", "工作投入"])),
      handling: scaled(averageAttribute(source, ["手控球", "反应", "镇定"])),
      reflexes: scaled(averageAttribute(source, ["反应", "一对一", "灵活"])),
      penaltyTaking: scaled(attribute(source, "点球", 2)),
      discipline: scaled(averageAttribute(source, ["决断", "集中", "团队合作"])),
      goalkeeping: scaled(averageAttribute(source, ["反应", "手控球", "一对一", "选位", "拦截射门"]))
    };
  }
  return {
    pace: scaled(averageAttribute(source, ["速度", "爆发力"])),
    acceleration: scaled(averageAttribute(source, ["爆发力", "灵活", "平衡"])),
    passing: scaled(averageAttribute(source, ["传球", "技术", "决断"])),
    vision: scaled(averageAttribute(source, ["视野", "预判", "决断"])),
    decisions: scaled(averageAttribute(source, ["决断", "团队合作", "预判"])),
    technique: scaled(averageAttribute(source, ["技术", "停球"])),
    firstTouch: scaled(averageAttribute(source, ["停球", "技术", "镇定"])),
    dribbling: scaled(averageAttribute(source, ["盘带", "技术", "灵活"])),
    finishing: scaled(averageAttribute(source, ["射门", "镇定", "无球跑动"])),
    longShots: scaled(averageAttribute(source, ["远射", "射门", "技术"])),
    crossing: scaled(averageAttribute(source, ["传中", "传球", "技术"])),
    tackling: scaled(averageAttribute(source, ["抢断", "侵略性", "预判"])),
    positioning: scaled(averageAttribute(source, ["选位", "盯人", "集中"])),
    anticipation: scaled(averageAttribute(source, ["预判", "集中", "决断"])),
    composure: scaled(averageAttribute(source, ["镇定", "决断"])),
    strength: scaled(averageAttribute(source, ["强壮", "平衡"])),
    heading: scaled(averageAttribute(source, ["头球", "弹跳", "强壮"])),
    jumping: scaled(averageAttribute(source, ["弹跳", "强壮"])),
    offBall: scaled(averageAttribute(source, ["无球跑动", "预判", "决断"])),
    stamina: scaled(averageAttribute(source, ["耐力", "工作投入"])),
    handling: 1,
    reflexes: scaled(averageAttribute(source, ["反应", "灵活", "预判"])),
    penaltyTaking: scaled(averageAttribute(source, ["点球", "射门", "镇定"])),
    discipline: scaled(averageAttribute(source, ["决断", "集中", "团队合作"])),
    goalkeeping: 1
  };
}

function normalizeTeam(side, teamId) {
  const formation = formations.get(side.formationId);
  if (!formation) throw new Error(`Unknown formation: ${side.formationId}`);
  if (!side.lineup?.starters || side.lineup.starters.length !== 11) throw new Error(`${teamId} must have exactly 11 starters`);
  const anchors = formationAnchors(formation);
  const players = side.lineup.starters.map((starter, index) => {
    const source = enginePlayers.get(String(starter.playerId));
    const publicPlayer = publicPlayers.get(String(starter.playerId));
    if (!source || !publicPlayer) throw new Error(`Unknown player: ${starter.playerId}`);
    const familiarity = positionMultiplier(publicPlayer, starter.position);
    if (!familiarity) throw new Error(`${publicPlayer.name} cannot play ${starter.position}`);
    const form = playerFormFor(side, starter.playerId);
    const abilities = buildAbilities(source, starter.position, familiarity, form);
    const maxSpeed = clamp(
      movement.minimumPlayerMaxSpeed + (movement.maximumPlayerMaxSpeed - movement.minimumPlayerMaxSpeed) * abilities.pace / 100,
      0,
      starter.position === "GK" ? movement.goalkeeperAbsoluteMaxSpeed : movement.outfieldAbsoluteMaxSpeed
    );
    const maxAcceleration = movement.minimumAcceleration
      + (movement.maximumAcceleration - movement.minimumAcceleration) * abilities.acceleration / 100;
    return {
      id: String(starter.playerId),
      key: keyOf(teamId, starter.playerId),
      team: teamId,
      name: publicPlayer.name,
      shortName: publicPlayer.name.split(" ").at(-1).slice(0, 14),
      position: starter.position,
      role: starter.position,
      anchor: anchors[index],
      familiarity,
      form,
      abilities,
      maxSpeed,
      maxAcceleration,
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      facingX: teamId === "home" ? 1 : -1,
      facingY: 0,
      movementIntent: "hold_shape",
      targetX: 0,
      targetY: 0,
      markingTarget: null,
      nextActionAt: 0,
      nextChallengeAt: 0,
      stats: {
        passes: 0,
        completedPasses: 0,
        shots: 0,
        shotsOnTarget: 0,
        xg: 0,
        goals: 0,
        assists: 0,
        tackles: 0,
        interceptions: 0,
        clearances: 0,
        saves: 0,
        fouls: 0,
        ownGoals: 0,
        dispossessions: 0
      }
    };
  });
  return {
    id: teamId,
    name: side.displayName ?? (teamId === "home" ? "主队" : "客队"),
    formationId: side.formationId,
    tacticId: side.lineup.tacticId ?? "balanced",
    nextChallengeAt: 0,
    players,
    stats: {
      possessionTicks: 0,
      passes: 0,
      completedPasses: 0,
      shots: 0,
      shotsOnTarget: 0,
      xg: 0,
      goals: 0,
      tackles: 0,
      interceptions: 0,
      clearances: 0,
      saves: 0,
      offsides: 0,
      corners: 0,
      fouls: 0
    }
  };
}

function worldX(team, period, relativeX) {
  return directionOf(team, period) > 0 ? relativeX : pitch.length - relativeX;
}

function relativeX(team, period, x) {
  return directionOf(team, period) > 0 ? x : pitch.length - x;
}

function attackingGoal(team, period) {
  return { x: directionOf(team, period) > 0 ? pitch.length : 0, y: pitch.width / 2 };
}

function defendingGoal(team, period) {
  return attackingGoal(otherTeam(team), period);
}

function playerByKey(world, playerKey) {
  return world.playerMap.get(playerKey) ?? null;
}

function playerById(world, team, playerId) {
  return world.playerMap.get(keyOf(team, playerId)) ?? null;
}

function teamPlayers(world, team) {
  return world.teams[team].players;
}

function positionForKickoff(player, team, period) {
  const direction = directionOf(team, period);
  let x = worldX(team, period, player.anchor.x);
  x = direction > 0 ? Math.min(x, pitch.length / 2 - 0.8) : Math.max(x, pitch.length / 2 + 0.8);
  return { x, y: player.anchor.y };
}

function recordAction(world, action) {
  const completed = {
    id: `action-${world.actions.length + 1}`,
    possessionId: action.possessionId ?? world.possessionId,
    tickStart: action.tickStart ?? world.tick,
    tickEnd: action.tickEnd ?? world.tick,
    timeStart: round((action.tickStart ?? world.tick) * DT, 2),
    timeEnd: round((action.tickEnd ?? world.tick) * DT, 2),
    period: action.period ?? world.period,
    team: action.team ?? null,
    actorId: action.actorId ?? null,
    targetPlayerId: action.targetPlayerId ?? null,
    intendedTargetPlayerId: action.intendedTargetPlayerId ?? null,
    opponentId: action.opponentId ?? null,
    type: action.type,
    technique: action.technique ?? null,
    outcome: action.outcome ?? null,
    startPosition: action.startPosition ? { x: round(action.startPosition.x), y: round(action.startPosition.y) } : null,
    endPosition: action.endPosition ? { x: round(action.endPosition.x), y: round(action.endPosition.y) } : null,
    pressure: round(action.pressure ?? 0, 2),
    xg: round(action.xg ?? 0, 3),
    saveType: action.saveType ?? null,
    shootoutScore: action.shootoutScore ?? null,
    resultingActionId: action.resultingActionId ?? null,
    statsDelta: action.statsDelta ?? {}
  };
  world.actions.push(completed);
  return completed;
}

function placeKickoff(world, team, reason) {
  for (const side of ["home", "away"]) {
    for (const player of teamPlayers(world, side)) {
      const point = positionForKickoff(player, side, world.period);
      if (side !== team) {
        const ownHalfDirection = directionOf(side, world.period);
        point.x = ownHalfDirection > 0
          ? Math.min(point.x, pitch.length / 2 - 9.3)
          : Math.max(point.x, pitch.length / 2 + 9.3);
      }
      player.x = point.x;
      player.y = point.y;
      player.vx = 0;
      player.vy = 0;
      player.targetX = point.x;
      player.targetY = point.y;
      player.movementIntent = "kickoff_shape";
    }
  }
  const candidates = teamPlayers(world, team).filter((player) => ["ST", "CAM", "CM", "LW", "RW"].includes(player.position));
  const taker = (candidates.length ? candidates : teamPlayers(world, team)).sort((left, right) => right.anchor.x - left.anchor.x)[0];
  taker.x = pitch.length / 2 - directionOf(team, world.period) * 0.2;
  taker.y = pitch.width / 2;
  world.ball = {
    x: pitch.length / 2,
    y: pitch.width / 2,
    z: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    state: "controlled",
    controllerKey: taker.key,
    lastTouchPlayerId: taker.id,
    lastTouchTeamId: team,
    lastTouchType: "kickoff",
    trajectoryId: null
  };
  world.possessionTeam = team;
  world.possessionId += 1;
  world.phaseSince = world.tick;
  world.pendingAction = null;
  world.discontinuity = reason;
  taker.nextActionAt = world.matchTime + 0.35;
  recordAction(world, {
    type: "kickoff",
    outcome: "complete",
    team,
    actorId: taker.id,
    startPosition: { x: pitch.length / 2, y: pitch.width / 2 },
    endPosition: { x: pitch.length / 2, y: pitch.width / 2 }
  });
}

function createWorld(homeSide, awaySide, seed) {
  const home = normalizeTeam(homeSide, "home");
  const away = normalizeTeam(awaySide, "away");
  const players = [...home.players, ...away.players];
  const world = {
    version: 1,
    engine: "authoritative-continuous-core-v1",
    configVersion: continuousEngineConfig.version,
    seed: String(seed),
    random: seededRandom(seed),
    tick: 0,
    matchTime: 0,
    period: 1,
    teams: { home, away },
    players,
    playerMap: new Map(players.map((player) => [player.key, player])),
    ball: null,
    possessionId: 0,
    possessionTeam: null,
    phaseSince: 0,
    phases: { home: "kickoff", away: "kickoff" },
    pendingAction: null,
    goalPause: null,
    restart: null,
    securedGoalkeeper: null,
    reboundWindow: null,
    turnoverWindow: null,
    actions: [],
    snapshots: [],
    captureSnapshots: true,
    halftime: null,
    discontinuity: null,
    audit: {
      movementViolations: [],
      boundsViolations: [],
      possessionViolations: [],
      maximumObservedSpeed: 0,
      maximumObservedStep: 0,
      swarmTicks: 0,
      longestSwarmTicks: 0,
      currentSwarmTicks: 0,
      crowdTicks: { home: 0, away: 0 },
      longestCrowdTicks: { home: 0, away: 0 },
      currentCrowdTicks: { home: 0, away: 0 }
    }
  };
  placeKickoff(world, "home", "initial_setup");
  return world;
}

function phaseFor(world, team) {
  if (world.restart) return world.restart.type;
  const inPossession = world.possessionTeam === team;
  const transition = (world.tick - world.phaseSince) * DT < decision.transitionDuration;
  const ballProgress = relativeX(team, world.period, world.ball.x);
  if (inPossession) {
    if (transition && world.possessionId > 1) return "attacking_transition";
    if (ballProgress < 33) return "build_up";
    if (ballProgress < 70) return "progression";
    return "final_third";
  }
  if (transition && world.possessionTeam) return "defensive_transition";
  const threat = relativeX(team, world.period, world.ball.x);
  if (threat < 34) return "low_block";
  if (threat < 66) return "mid_block";
  return "high_block";
}

function gameStateLineAdjustment(world, team) {
  const minute = world.matchTime / 60;
  if (minute < footballPrinciples.lateGameAdjustmentStartMinute) return 0;
  const scoreDifference = world.teams[team].stats.goals - world.teams[otherTeam(team)].stats.goals;
  if (!scoreDifference) return 0;
  const urgency = clamp((minute - footballPrinciples.lateGameAdjustmentStartMinute) / 20, 0, 1);
  return clamp(
    -Math.sign(scoreDifference) * urgency * Math.min(Math.abs(scoreDifference), 2) * 1.25,
    -footballPrinciples.maximumGameStateLineAdjustment,
    footballPrinciples.maximumGameStateLineAdjustment
  );
}

function movementQuality(player) {
  return mean([player.abilities.offBall, player.abilities.anticipation, player.abilities.decisions, player.abilities.stamina]) / 100;
}

function outletQuality(player) {
  return mean([player.abilities.offBall, player.abilities.anticipation, player.abilities.pace, player.abilities.strength]) / 100;
}

function tacticalAnchor(world, player) {
  const ownsBall = world.possessionTeam === player.team;
  const tactic = tacticFor(world, player.team);
  const phase = world.phases[player.team];
  const band = roleBand(player.position);
  const side = laneSide(player);
  const ballSide = world.ball.y < pitch.width / 2 ? -1 : 1;
  const ballProgress = relativeX(player.team, world.period, world.ball.x);
  let relativeTargetX = player.anchor.x;
  let y = player.anchor.y;
  const gameStateAdjustment = gameStateLineAdjustment(world, player.team);
  if (player.position === "GK") {
    relativeTargetX = clamp(2.2 + ballProgress * 0.09 + Math.max(0, tactic.lineHeight) * 0.12, 2.2, 15);
    y = clamp(pitch.width / 2 + (world.ball.y - pitch.width / 2) * 0.25, pitch.width / 2 - 10, pitch.width / 2 + 10);
  } else if (ownsBall) {
    const attackingLines = footballPrinciples.attackingLines;
    if (band === "centre_back") relativeTargetX = attackingLines.centreBackBase + ballProgress * attackingLines.centreBackProgressFactor + tactic.lineHeight * 0.22;
    else if (band === "fullback") relativeTargetX = attackingLines.fullbackBase + ballProgress * attackingLines.fullbackProgressFactor + tactic.lineHeight * 0.18;
    else if (band === "holding_midfield") relativeTargetX = attackingLines.holdingMidfieldBase + ballProgress * attackingLines.holdingMidfieldProgressFactor + tactic.midfieldAdvance;
    else if (band === "midfield") relativeTargetX = attackingLines.midfieldBase + ballProgress * attackingLines.midfieldProgressFactor + tactic.midfieldAdvance;
    else if (band === "attacking_midfield") relativeTargetX = 51 + ballProgress * 0.28 + tactic.forwardAdvance;
    else if (band === "wing") relativeTargetX = 65 + ballProgress * 0.2 + tactic.forwardAdvance;
    else relativeTargetX = 70 + ballProgress * 0.17 + tactic.forwardAdvance;
    if (phase === "attacking_transition" && ["attacking_midfield", "wing", "striker"].includes(band)) relativeTargetX += tactic.counterRun;
    const width = tactic.attackWidth;
    y = pitch.width / 2 + (player.anchor.y - pitch.width / 2) * width;
    if (band === "fullback") {
      if (side && side === ballSide && ballProgress > 25) {
        relativeTargetX += 3 + tactic.fullbackAdvance * 0.35;
        y = clamp(pitch.width / 2 + side * Math.min(pitch.width * 0.43, Math.abs(y - pitch.width / 2) + 3), 3, pitch.width - 3);
      } else if (side) {
        relativeTargetX += Math.min(2, tactic.fullbackAdvance * 0.2);
        y = pitch.width / 2 + (y - pitch.width / 2) * 0.62;
      }
    } else if (band === "wing") {
      if (side !== ballSide) y = pitch.width / 2 + (y - pitch.width / 2) * 0.72;
    } else if (band === "holding_midfield") {
      y = pitch.width / 2 + (world.ball.y - pitch.width / 2) * 0.16;
    } else if (band === "centre_back") {
      y = pitch.width / 2 + (player.anchor.y - pitch.width / 2) * 0.76 + (world.ball.y - pitch.width / 2) * 0.05;
    } else {
      y += clamp((world.ball.y - pitch.width / 2) * 0.09, -3, 3);
    }
  } else {
    const defendingLines = footballPrinciples.defendingLines;
    const lines = phase === "low_block"
      ? defendingLines.lowBlock
      : phase === "high_block"
        ? defendingLines.highBlock
        : phase === "defensive_transition"
          ? defendingLines.transition
          : defendingLines.midBlock;
    const lineAdjustment = tactic.lineHeight + gameStateAdjustment;
    if (["centre_back", "fullback"].includes(band)) relativeTargetX = lines.defense + lineAdjustment;
    else if (band === "holding_midfield") relativeTargetX = lines.midfield - 6 + lineAdjustment * 0.82;
    else if (["midfield", "attacking_midfield", "wing"].includes(band)) relativeTargetX = lines.midfield + (band === "attacking_midfield" ? 4 : band === "wing" ? 2 : 0) + lineAdjustment * 0.82;
    else relativeTargetX = lines.forward + lineAdjustment * 0.68;
    const width = tactic.defensiveWidth;
    const ballShift = clamp((world.ball.y - pitch.width / 2) * (band === "centre_back" ? 0.08 : band === "fullback" ? 0.12 : 0.17), -6, 6);
    y = pitch.width / 2 + (player.anchor.y - pitch.width / 2) * width + ballShift;
  }
  return {
    x: clamp(worldX(player.team, world.period, clamp(relativeTargetX, 3, 94)), movement.boundaryPadding, pitch.length - movement.boundaryPadding),
    y: clamp(y, 3, pitch.width - 3)
  };
}

function closestPlayers(players, point, predicate = () => true) {
  return players.filter(predicate).sort((left, right) => distance(left, point) - distance(right, point));
}

function defensiveThreat(world, defendingTeam, attacker) {
  const goal = defendingGoal(defendingTeam, world.period);
  const depth = relativeX(defendingTeam, world.period, attacker.x);
  const lateralDistance = Math.abs(attacker.y - goal.y);
  const inPenaltyThreat = depth <= defending.penaltyThreatDepth && lateralDistance <= defending.centralDangerHalfWidth;
  const isController = attacker.key === world.ball.controllerKey;
  const isReceiver = attacker.key === world.pendingAction?.targetKey;
  const score = Math.max(0, defending.threatActivationDepth - depth) * 1.5
    + Math.max(0, defending.centralDangerHalfWidth - lateralDistance) * 0.8
    + (inPenaltyThreat ? 42 : 0)
    + (isController ? 18 : 0)
    + (isReceiver ? 22 : 0)
    + Math.max(0, 14 - distance(attacker, world.ball)) * 0.45;
  return { attacker, depth, lateralDistance, inPenaltyThreat, score };
}

function defensiveAwareness(player) {
  return mean([player.abilities.positioning, player.abilities.anticipation, player.abilities.decisions]) / 100;
}

function buildDefensiveAssignments(world, team, players) {
  const markerPositions = new Set(["CB", "LB", "RB", "LWB", "RWB", "CDM"]);
  const available = players.filter((player) => markerPositions.has(player.position));
  const threats = teamPlayers(world, otherTeam(team))
    .filter((attacker) => attacker.position !== "GK")
    .map((attacker) => defensiveThreat(world, team, attacker))
    .filter((threat) => threat.depth <= defending.threatActivationDepth)
    .sort((left, right) => right.score - left.score);
  const assignments = new Map();
  for (const threat of threats) {
    if (!available.length) break;
    const centralThreat = threat.lateralDistance <= defending.centralDangerHalfWidth;
    const ranked = available.map((marker, index) => {
      const awareness = defensiveAwareness(marker);
      const recognitionDepth = defending.threatActivationDepth * (0.72 + awareness * 0.28);
      if (threat.depth > recognitionDepth) return null;
      const band = roleBand(marker.position);
      const roleCost = centralThreat
        ? band === "centre_back" ? -9 : band === "holding_midfield" ? 2 : band === "fullback" ? 7 : 9
        : band === "fullback" ? -8 : band === "centre_back" ? 4 : 7;
      const goalSidePenalty = relativeX(team, world.period, marker.x) > threat.depth ? 5 : 0;
      return { marker, index, awareness, cost: distance(marker, threat.attacker) * (1.12 - awareness * 0.3) + roleCost * awareness + goalSidePenalty };
    }).filter(Boolean).sort((left, right) => left.cost - right.cost);
    if (!ranked.length) continue;
    const selected = ranked[0];
    assignments.set(selected.marker.key, { ...threat, awareness: selected.awareness });
    available.splice(selected.index, 1);
  }
  return assignments;
}

function defensiveOutletKeys(world, team, players, phase) {
  if (!['low_block', 'defensive_transition', 'mid_block'].includes(phase)) return new Set();
  const candidates = players
    .filter((player) => player.position !== 'GK' && ['ST', 'LW', 'RW', 'CAM', 'LM', 'RM'].includes(player.position))
    .map((player) => ({ player, quality: outletQuality(player) }))
    .sort((left, right) => right.quality - left.quality);
  if (!candidates.length) return new Set();
  const result = new Set([candidates[0].player.key]);
  const tactic = tacticFor(world, team);
  const secondThreshold = footballPrinciples.secondCounterOutletQuality
    - clamp((tactic.counterRun - tacticProfiles.balanced.counterRun) * 0.008, -0.03, 0.03);
  if (phase !== 'low_block' && candidates[1]?.quality >= secondThreshold) result.add(candidates[1].player.key);
  return result;
}

function separateShapeTargets(players) {
  const protectedIntents = new Set([
    'press_ball', 'support_press', 'receive_pass', 'mark_box_threat', 'track_dangerous_run',
    'take_restart', 'attack_corner', 'defend_corner', 'free_kick_wall', 'goalkeeper_dive'
  ]);
  const minimum = footballPrinciples.targetShapeSeparation;
  for (let leftIndex = 0; leftIndex < players.length; leftIndex += 1) {
    const left = players[leftIndex];
    if (left.position === 'GK' || protectedIntents.has(left.movementIntent)) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < players.length; rightIndex += 1) {
      const right = players[rightIndex];
      if (right.position === 'GK' || protectedIntents.has(right.movementIntent)) continue;
      const gap = Math.hypot(left.targetX - right.targetX, left.targetY - right.targetY);
      if (gap >= minimum) continue;
      const side = left.anchor.y <= right.anchor.y ? -1 : 1;
      const correction = (minimum - gap) / 2 + 0.2;
      left.targetY = clamp(left.targetY + side * correction, 3, pitch.width - 3);
      right.targetY = clamp(right.targetY - side * correction, 3, pitch.width - 3);
    }
  }
}

function goalSideMarkPoint(world, team, marker, threat) {
  const ownGoal = defendingGoal(team, world.period);
  const towardGoal = normalize(vectorTo(threat.attacker, ownGoal));
  const baseGap = threat.inPenaltyThreat ? defending.markDistanceInBox : defending.markDistanceOutsideBox;
  const gap = baseGap + (1 - threat.awareness) * 2.4;
  const anticipationSeconds = 0.15 + threat.awareness * 0.45;
  const anticipated = {
    x: threat.attacker.x + threat.attacker.vx * anticipationSeconds,
    y: threat.attacker.y + threat.attacker.vy * anticipationSeconds
  };
  const zonalY = pitch.width / 2 + (marker.anchor.y - pitch.width / 2) * 0.7;
  const rawX = anticipated.x + towardGoal.x * gap;
  const goalSideX = ownGoal.x < pitch.length / 2
    ? Math.min(rawX, threat.attacker.x - 0.15)
    : Math.max(rawX, threat.attacker.x + 0.15);
  return {
    x: clamp(goalSideX, 1, pitch.length - 1),
    y: clamp((anticipated.y + towardGoal.y * gap) * (0.72 + threat.awareness * 0.28) + zonalY * (1 - threat.awareness) * 0.28, 2, pitch.width - 2)
  };
}

function attackingMidfieldAssignments(world, team, players, controller, phase) {
  const assignments = new Map();
  if (!controller || phase !== "final_third") return assignments;
  const controllerDepth = relativeX(team, world.period, controller.x);
  if (controllerDepth < attacking.finalThirdActivationDepth) return assignments;
  const tacticId = world.teams[team].tacticId;
  const candidates = players
    .filter((player) => ["CM", "CAM", "LM", "RM"].includes(player.position) && player.key !== controller.key)
    .map((player) => {
      const movementQuality = mean([
        player.abilities.offBall,
        player.abilities.anticipation,
        player.abilities.decisions,
        player.abilities.stamina
      ]) / 100;
      const suitability = movementQuality * 70
        + player.abilities.finishing * 0.12
        + Math.max(0, 18 - distance(player, controller)) * 0.45;
      return { player, movementQuality, suitability };
    })
    .sort((left, right) => right.suitability - left.suitability);
  if (!candidates.length) return assignments;

  const commitment = {
    park_bus: 0.42,
    counter: 0.68,
    possession: 0.72,
    balanced: 0.78,
    wide: 0.8,
    high_press: 0.9,
    all_out_attack: 1
  }[tacticId] ?? 0.78;
  const runner = candidates[0];
  const attackFromWideArea = Math.abs(world.ball.y - pitch.width / 2) >= 14
    || ["LB", "RB", "LWB", "RWB", "LM", "RM", "LW", "RW"].includes(controller.position);
  if (attackFromWideArea && attacking.maximumLateRunners > 0 && runner.movementQuality * commitment >= 0.48) {
    const ballSide = world.ball.y < pitch.width / 2 ? -1 : 1;
    const preferredY = Math.abs(world.ball.y - pitch.width / 2) > 15
      ? pitch.width / 2 - ballSide * 6
      : clamp(runner.player.anchor.y, pitch.width / 2 - 10, pitch.width / 2 + 10);
    const desiredDepth = attacking.penaltyBoxEntryDepth + runner.movementQuality * 4;
    const desiredPoint = {
      x: worldX(team, world.period, clamp(Math.max(controllerDepth + 4, desiredDepth), attacking.penaltyBoxEntryDepth, 93)),
      y: preferredY
    };
    const occupied = players.filter((player) => player.key !== runner.player.key && distance(player, desiredPoint) < 5.5).length;
    assignments.set(runner.player.key, {
      role: occupied >= 2 ? "edge_box_support" : "late_box_run",
      quality: runner.movementQuality,
      x: occupied >= 2 ? worldX(team, world.period, attacking.boxEdgeSupportDepth) : desiredPoint.x,
      y: occupied >= 2 ? clamp(preferredY + ballSide * 8, 15, pitch.width - 15) : preferredY
    });
  } else {
    assignments.set(runner.player.key, {
      role: "edge_box_support",
      quality: runner.movementQuality,
      x: worldX(team, world.period, attacking.boxEdgeSupportDepth - (1 - runner.movementQuality) * 3),
      y: clamp(pitch.width / 2 + (world.ball.y <= pitch.width / 2 ? 8 : -8), 14, pitch.width - 14)
    });
  }

  const hasLateRunner = [...assignments.values()].some((assignment) => assignment.role === "late_box_run");
  const edgeCandidate = hasLateRunner ? candidates.find((candidate) => !assignments.has(candidate.player.key)) : null;
  if (edgeCandidate) {
    const runnerY = [...assignments.values()][0]?.y ?? world.ball.y;
    assignments.set(edgeCandidate.player.key, {
      role: "edge_box_support",
      quality: edgeCandidate.movementQuality,
      x: worldX(team, world.period, attacking.boxEdgeSupportDepth - (1 - edgeCandidate.movementQuality) * 3),
      y: clamp(pitch.width / 2 + (runnerY <= pitch.width / 2 ? 8 : -8), 14, pitch.width - 14)
    });
  }
  return assignments;
}

function updatePhases(world) {
  world.phases.home = phaseFor(world, "home");
  world.phases.away = phaseFor(world, "away");
}

function updateRestartIntents(world) {
  const restart = world.restart;
  const attackingTeam = restart.team;
  const defendingTeam = otherTeam(attackingTeam);
  for (const player of world.players) {
    const anchor = tacticalAnchor(world, player);
    player.targetX = anchor.x;
    player.targetY = anchor.y;
    player.movementIntent = "restart_shape";
    player.markingTarget = null;
  }
  const taker = playerByKey(world, restart.takerKey);
  if (taker) {
    const runupDistance = restart.type === "penalty" && !restart.runupStarted ? 3.2 : 0;
    taker.targetX = restart.point.x - directionOf(restart.team, world.period) * runupDistance;
    taker.targetY = restart.point.y;
    taker.movementIntent = restart.type === "penalty" && restart.runupStarted ? "penalty_runup" : "take_restart";
  }
  if (restart.type === "penalty") {
    const goal = attackingGoal(attackingTeam, world.period);
    const attackDirection = directionOf(attackingTeam, world.period);
    const goalkeeper = teamPlayers(world, defendingTeam).find((player) => player.position === "GK");
    if (goalkeeper) {
      goalkeeper.targetX = goal.x - attackDirection * 0.35;
      goalkeeper.targetY = goal.y;
      goalkeeper.movementIntent = "penalty_goalkeeper_set";
    }
    const waiting = world.players.filter((player) => player.key !== taker?.key && player.key !== goalkeeper?.key && player.position !== "GK");
    waiting.forEach((player, index) => {
      const row = Math.floor(index / 5);
      const column = index % 5;
      player.targetX = restart.point.x - attackDirection * (10.5 + row * 1.8);
      player.targetY = clamp(pitch.width / 2 + (column - 2) * 4.2, 13, pitch.width - 13);
      player.movementIntent = "wait_outside_penalty_area";
    });
    return;
  }
  if (restart.type === "corner") {
    const goal = attackingGoal(attackingTeam, world.period);
    const attackDirection = directionOf(attackingTeam, world.period);
    const attackers = teamPlayers(world, attackingTeam)
      .filter((player) => player.position !== "GK" && player.key !== taker?.key)
      .sort((left, right) => mean([right.abilities.heading, right.abilities.jumping, right.abilities.offBall, right.abilities.strength])
        - mean([left.abilities.heading, left.abilities.jumping, left.abilities.offBall, left.abilities.strength]));
    const defenders = teamPlayers(world, defendingTeam)
      .filter((player) => player.position !== "GK")
      .sort((left, right) => mean([right.abilities.heading, right.abilities.jumping, right.abilities.positioning, right.abilities.strength])
        - mean([left.abilities.heading, left.abilities.jumping, left.abilities.positioning, left.abilities.strength]));
    const goalkeeper = teamPlayers(world, defendingTeam).find((player) => player.position === 'GK');
    if (goalkeeper) {
      goalkeeper.targetX = goal.x + attackDirection * 0.7;
      goalkeeper.targetY = goal.y;
      goalkeeper.movementIntent = 'defend_corner_goal';
    }
    attackers.slice(0, 5).forEach((player, index) => {
      player.targetX = goal.x - attackDirection * (6 + (index % 2) * 3.5);
      player.targetY = clamp(goal.y + (index - 2) * 3.8, 7, pitch.width - 7);
      player.movementIntent = "attack_corner";
    });
    defenders.slice(0, 6).forEach((player, index) => {
      const threat = attackers[index % Math.max(1, attackers.length)];
      player.targetX = goal.x - attackDirection * (4.5 + (index % 2) * 3.2);
      player.targetY = clamp((threat?.targetY ?? goal.y) + (index % 2 ? 1.1 : -1.1), 6, pitch.width - 6);
      player.movementIntent = "defend_corner";
      player.markingTarget = threat?.key ?? null;
    });
    return;
  }
  if (restart.type === "free_kick") {
    const goal = attackingGoal(attackingTeam, world.period);
    const towardGoal = normalize(vectorTo(restart.point, goal));
    const defenders = closestPlayers(teamPlayers(world, defendingTeam), restart.point, (player) => player.position !== "GK").slice(0, 3);
    const wallCentre = {
      x: restart.point.x + towardGoal.x * 9.15,
      y: restart.point.y + towardGoal.y * 9.15
    };
    defenders.forEach((player, index) => {
      player.targetX = clamp(wallCentre.x - towardGoal.y * (index - 1) * 0.85, 1, pitch.length - 1);
      player.targetY = clamp(wallCentre.y + towardGoal.x * (index - 1) * 0.85, 1, pitch.width - 1);
      player.movementIntent = "free_kick_wall";
    });
  }
}

function setPieceTakerScore(type, player, point) {
  const distanceCost = distance(player, point) * (type === 'corner' ? 0.7 : 0.45);
  const technical = type === 'corner'
    ? mean([player.abilities.crossing, player.abilities.technique, player.abilities.decisions])
    : mean([player.abilities.technique, player.abilities.passing, player.abilities.longShots, player.abilities.composure]);
  return technical - distanceCost - (player.position === 'GK' && type !== 'goal_kick' ? 40 : 0);
}

function restartShapeReady(world, restart, taker) {
  if (!['corner', 'free_kick', 'penalty'].includes(restart.type)) return true;
  const relevant = world.players.filter((player) => player.key !== taker.key && (
    restart.type === 'penalty'
      ? ['wait_outside_penalty_area', 'penalty_goalkeeper_set'].includes(player.movementIntent)
      : ['attack_corner', 'defend_corner', 'defend_corner_goal', 'free_kick_wall'].includes(player.movementIntent)
  ));
  if (!relevant.length) return true;
  const ready = relevant.filter((player) => distance(player, { x: player.targetX, y: player.targetY }) <= 3.2).length;
  return ready / relevant.length >= footballPrinciples.setPieceShapeReadyRatio;
}

function restartDeliveryTarget(world, restart) {
  const candidates = teamPlayers(world, restart.team)
    .filter((player) => player.position !== 'GK' && player.key !== restart.takerKey)
    .map((player) => ({
      player,
      quality: mean([player.abilities.heading, player.abilities.jumping, player.abilities.offBall, player.abilities.anticipation, player.abilities.strength])
    }))
    .sort((left, right) => right.quality - left.quality);
  return candidates[0]?.player ?? null;
}

function startRestartDelivery(world, restart, taker, technique) {
  const target = restartDeliveryTarget(world, restart);
  if (!target) return false;
  const direction = directionOf(restart.team, world.period);
  const goal = attackingGoal(restart.team, world.period);
  const deliveryPoint = technique === 'corner_cross'
    ? {
        x: goal.x - direction * clamp(5.5 + world.random() * 4.5, 5.5, 10),
        y: clamp(goal.y + (world.random() - 0.5) * 12, goal.y - 8, goal.y + 8)
      }
    : { x: target.x, y: target.y };
  const offside = technique === 'corner_cross'
    ? { offside: false, lineX: null, margin: 0 }
    : offsideState(world, restart.team, { ...target, x: deliveryPoint.x, y: deliveryPoint.y }, taker.x);
  startPass(world, taker, {
    target,
    point: deliveryPoint,
    progress: (deliveryPoint.x - taker.x) * direction,
    offside
  }, { technique });
  return true;
}

function updateMovementIntents(world) {
  if (world.restart) return updateRestartIntents(world);
  const controller = playerByKey(world, world.ball.controllerKey);
  const goalkeeperHasSecuredBall = world.securedGoalkeeper
    && world.securedGoalkeeper.untilTick > world.tick
    && controller?.key === world.securedGoalkeeper.playerKey;
  const receivingKey = world.pendingAction?.targetKey ?? null;
  for (const team of ["home", "away"]) {
    const players = teamPlayers(world, team);
    const ownsBall = world.possessionTeam === team;
    const outfield = players.filter((player) => player.position !== "GK");
    const defensiveAssignments = ownsBall ? new Map() : buildDefensiveAssignments(world, team, players);
    const closest = closestPlayers(outfield, world.ball, (player) => !defensiveAssignments.has(player.key));
    const tactic = tacticFor(world, team);
    const phase = world.phases[team];
    const ballDepth = relativeX(team, world.period, world.ball.x);
    const centreBacks = outfield.filter((player) => CENTRAL_DEFENDERS.has(player.position));
    const steppingCentreBackKey = ownsBall && ['progression', 'final_third'].includes(phase)
      ? [...centreBacks].sort((left, right) => Math.abs(left.y - world.ball.y) - Math.abs(right.y - world.ball.y))[0]?.key ?? null
      : null;
    const outletKeys = ownsBall ? new Set() : defensiveOutletKeys(world, team, players, phase);
    const configuredPressers = clamp(Math.round(tactic.pressers + (phase === "defensive_transition" && ["high_press", "all_out_attack"].includes(world.teams[team].tacticId) ? 1 : 0)), 1, 3);
    const pressCount = phase === "low_block" && world.teams[team].tacticId !== "high_press" ? 1 : configuredPressers;
    const midfieldAssignments = ownsBall ? attackingMidfieldAssignments(world, team, players, controller, phase) : new Map();
    for (const player of players) {
      const anchor = tacticalAnchor(world, player);
      player.targetX = anchor.x;
      player.targetY = anchor.y;
      player.movementIntent = "hold_shape";
      player.markingTarget = null;
      if (player.position === "GK") {
        const incomingShot = ["shot", "disallowed_shot"].includes(world.pendingAction?.kind) && world.pendingAction.team !== team
          ? world.pendingAction
          : null;
        if (incomingShot) {
          const reactionQuality = mean([player.abilities.reflexes, player.abilities.anticipation, player.abilities.goalkeeping]) / 100;
          const reactionDelay = goalkeeping.reactionDelayMaximum
            - (goalkeeping.reactionDelayMaximum - goalkeeping.reactionDelayMinimum) * reactionQuality;
          if ((world.tick - incomingShot.tickStart) * DT >= reactionDelay) {
            const ownGoal = defendingGoal(team, world.period);
            player.targetX = ownGoal.x + directionOf(team, world.period) * 0.9;
            player.targetY = clamp(incomingShot.targetPoint.y, ownGoal.y - pitch.goalWidth / 2, ownGoal.y + pitch.goalWidth / 2);
            player.movementIntent = "goalkeeper_dive";
          } else {
            player.movementIntent = "goalkeeper_set";
          }
        }
        continue;
      }
      if (ownsBall) {
        if (controller?.key === player.key) {
          const direction = directionOf(team, world.period);
          const attackingLimit = attackingGoal(team, world.period).x - direction * 6;
          const carryDistance = world.teams[team].tacticId === "counter" ? 12 : world.teams[team].tacticId === "possession" ? 5 : 8;
          player.targetX = direction > 0
            ? clamp(player.x + direction * carryDistance, 2, attackingLimit)
            : clamp(player.x + direction * carryDistance, attackingLimit, pitch.length - 2);
          const centralPull = world.teams[team].tacticId === "wide" && laneSide(player) ? 0.02 : 0.1;
          player.targetY = clamp(player.y + (pitch.width / 2 - player.y) * centralPull, 3, pitch.width - 3);
          player.movementIntent = "carry_ball";
          continue;
        }
        if (receivingKey === player.key) {
          player.targetX = world.pendingAction.targetPoint.x;
          player.targetY = world.pendingAction.targetPoint.y;
          player.movementIntent = "receive_pass";
          continue;
        }
        const midfieldAssignment = midfieldAssignments.get(player.key);
        if (midfieldAssignment) {
          player.targetX = midfieldAssignment.x;
          player.targetY = midfieldAssignment.y;
          player.movementIntent = midfieldAssignment.role;
          continue;
        }
        const supportRank = closestPlayers(outfield.filter((item) => item.key !== controller?.key), controller ?? world.ball).findIndex((item) => item.key === player.key);
        const supportCount = world.teams[team].tacticId === "possession" ? 3 : 2;
        const safeToSupport = !CENTRAL_DEFENDERS.has(player.position) || (phase === "build_up" && supportRank === 0);
        if (supportRank === 0 && safeToSupport) {
          const gap = 6 * tactic.supportDistance;
          player.targetX = clamp((controller?.x ?? world.ball.x) - directionOf(team, world.period) * gap, 2, pitch.length - 2);
          player.targetY = clamp((controller?.y ?? world.ball.y) + (player.y <= world.ball.y ? -7 : 7) * tactic.supportDistance, 3, pitch.width - 3);
          player.movementIntent = "offer_short";
        } else if (supportRank > 0 && supportRank < supportCount && safeToSupport) {
          const forwardGap = (world.teams[team].tacticId === "counter" ? 12 : 8) * tactic.supportDistance;
          player.targetX = clamp((controller?.x ?? world.ball.x) + directionOf(team, world.period) * forwardGap, 2, pitch.length - 2);
          player.targetY = clamp((controller?.y ?? world.ball.y) + (player.y <= world.ball.y ? -10 : 10) * tactic.supportDistance, 3, pitch.width - 3);
          player.movementIntent = "offer_forward";
        } else if (CENTRAL_DEFENDERS.has(player.position)) {
          if (player.key === steppingCentreBackKey && ballDepth >= 45) {
            const stepDepth = clamp(ballDepth - 30, relativeX(team, world.period, anchor.x), footballPrinciples.centreBackStepMaximumDepth);
            player.targetX = worldX(team, world.period, stepDepth);
            player.targetY = clamp(pitch.width / 2 + (world.ball.y - pitch.width / 2) * 0.12, 18, pitch.width - 18);
            player.movementIntent = "step_up_support";
          } else {
            player.movementIntent = "rest_defense";
          }
        } else if (player.position === "CDM") {
          const controllerRelativeX = relativeX(team, world.period, controller?.x ?? world.ball.x);
          player.targetX = worldX(team, world.period, clamp(controllerRelativeX - (world.teams[team].tacticId === "possession" ? 9 : 13), 24, 62));
          player.targetY = pitch.width / 2 + (world.ball.y - pitch.width / 2) * 0.16;
          player.movementIntent = "pivot_support";
        } else if (FULLBACKS.has(player.position)) {
          const side = laneSide(player);
          const ballSide = world.ball.y < pitch.width / 2 ? -1 : 1;
          const quality = movementQuality(player);
          const tacticOverlapAdjustment = clamp((tactic.fullbackAdvance - tacticProfiles.balanced.fullbackAdvance) * 0.004, -0.025, 0.025);
          const desiredDepth = Math.min(
            footballPrinciples.fullbackOverlapMaximumDepth + tacticOverlapAdjustment * 40,
            ballDepth + footballPrinciples.fullbackOverlapDistanceBeyondBall * (0.72 + quality * 0.28)
          );
          const playerDepth = relativeX(team, world.period, player.x);
          const canOverlap = side === ballSide
            && ['progression', 'final_third'].includes(phase)
            && ballDepth >= 42
            && Math.abs(world.ball.y - pitch.width / 2) >= 13
            && playerDepth < desiredDepth - 2
            && quality >= footballPrinciples.fullbackOverlapMinimumQuality - tacticOverlapAdjustment;
          if (canOverlap) {
            player.targetX = worldX(team, world.period, Math.max(relativeX(team, world.period, anchor.x), desiredDepth));
            player.targetY = clamp(pitch.width / 2 + side * (pitch.width / 2 - 4), 3, pitch.width - 3);
            player.movementIntent = "overlap_run";
          } else if (side === ballSide && playerDepth >= ballDepth + 2) {
            player.targetX = worldX(team, world.period, Math.min(playerDepth, footballPrinciples.fullbackOverlapMaximumDepth));
            player.targetY = clamp(pitch.width / 2 + side * (pitch.width / 2 - 5), 4, pitch.width - 4);
            player.movementIntent = 'hold_high_width';
          } else if (side === ballSide) {
            player.targetX = worldX(team, world.period, Math.min(ballDepth - 6, relativeX(team, world.period, anchor.x) + 4));
            player.movementIntent = "support_flank";
          } else {
            player.targetY = pitch.width / 2 + (anchor.y - pitch.width / 2) * 0.58;
            player.movementIntent = "tuck_in_rest_defense";
          }
        } else if (["ST", "LW", "RW", "CAM"].includes(player.position)) {
          const runExtra = phase === "attacking_transition" ? tactic.counterRun * 0.45 : 3;
          player.targetX = clamp(anchor.x + directionOf(team, world.period) * runExtra, 2, pitch.length - 2);
          if (player.position === "ST") player.targetY = clamp(pitch.width / 2 + (pitch.width / 2 - world.ball.y) * 0.18, 12, pitch.width - 12);
          player.movementIntent = "attack_space";
          if (["ST", "LW", "RW"].includes(player.position) && phase === "final_third") {
            const direction = directionOf(team, world.period);
            const defenderXs = teamPlayers(world, otherTeam(team)).map((opponent) => opponent.x).sort((left, right) => direction > 0 ? right - left : left - right);
            const offsideLineDepth = relativeX(team, world.period, defenderXs[1]);
            const timingQuality = mean([player.abilities.offBall, player.abilities.anticipation, player.abilities.decisions]) / 100;
            const mistimedRunChance = 0.002 + (1 - timingQuality) * 0.006;
            const targetDepth = relativeX(team, world.period, player.targetX);
            if (world.random() < mistimedRunChance) {
              player.targetX = worldX(team, world.period, clamp(Math.max(targetDepth, offsideLineDepth + 0.8), 2, pitch.length - 2));
              player.movementIntent = "mistimed_run";
            } else if (targetDepth > offsideLineDepth - 0.35) {
              player.targetX = worldX(team, world.period, clamp(offsideLineDepth - 0.35, 2, pitch.length - 2));
              player.movementIntent = "hold_onside_run";
            }
          }
        } else if (MIDFIELD_POSITIONS.has(player.position)) {
          player.targetY = clamp(anchor.y + (world.ball.y - anchor.y) * 0.22, 7, pitch.width - 7);
          player.movementIntent = "occupy_half_space";
        }
      } else {
        if (goalkeeperHasSecuredBall && controller.team !== team) {
          const band = roleBand(player.position);
          const recoveryDepth = ['centre_back', 'fullback'].includes(band)
            ? 38
            : band === 'holding_midfield'
              ? 47
              : ['midfield', 'attacking_midfield'].includes(band)
                ? 52
                : 62;
          player.targetX = worldX(team, world.period, recoveryDepth);
          player.targetY = clamp(pitch.width / 2 + (player.anchor.y - pitch.width / 2) * 0.78, 6, pitch.width - 6);
          player.movementIntent = 'retreat_after_keeper_claim';
          player.markingTarget = null;
          continue;
        }
        if (outletKeys.has(player.key) && phase !== 'high_block') {
          const quality = outletQuality(player);
          const outletDepth = footballPrinciples.minimumCounterOutletDepth + (quality - 0.5) * 8;
          player.targetX = worldX(team, world.period, clamp(outletDepth, footballPrinciples.minimumCounterOutletDepth, 58));
          player.targetY = clamp(pitch.width / 2 + (player.anchor.y - pitch.width / 2) * 0.52, 12, pitch.width - 12);
          player.movementIntent = "counter_outlet";
          continue;
        }
        const assignedThreat = defensiveAssignments.get(player.key);
        if (assignedThreat) {
          const markPoint = goalSideMarkPoint(world, team, player, assignedThreat);
          player.targetX = markPoint.x;
          player.targetY = markPoint.y;
          player.movementIntent = assignedThreat.inPenaltyThreat ? "mark_box_threat" : "track_dangerous_run";
          player.markingTarget = assignedThreat.attacker.key;
          continue;
        }
        const pressRank = closest.findIndex((item) => item.key === player.key);
        if (pressRank >= 0 && pressRank < pressCount) {
          player.targetX = world.ball.x;
          player.targetY = world.ball.y;
          player.movementIntent = pressRank === 0 ? "press_ball" : "support_press";
          player.markingTarget = controller?.key ?? null;
        } else if (pressRank === pressCount && phase !== "low_block") {
          const ownGoal = defendingGoal(team, world.period);
          const towardGoal = normalize(vectorTo(world.ball, ownGoal));
          player.targetX = clamp(world.ball.x + towardGoal.x * 7, 2, pitch.length - 2);
          player.targetY = clamp(player.anchor.y * 0.62 + (world.ball.y + towardGoal.y * 5) * 0.38, 5, pitch.width - 5);
          player.movementIntent = "cover_press";
        } else if (relativeX(team, world.period, world.ball.x) < defending.emergencyRecoveryDepth && MIDFIELD_POSITIONS.has(player.position)) {
          const awareness = defensiveAwareness(player);
          const recoveryLine = player.position === "CDM"
            ? defending.holdingMidfielderRecoveryLine
            : player.position === "CAM"
              ? defending.attackingMidfielderRecoveryLine
              : defending.centralMidfielderRecoveryLine;
          player.targetX = worldX(team, world.period, recoveryLine + (1 - awareness) * 8);
          player.targetY = clamp(pitch.width / 2 + (player.anchor.y - pitch.width / 2) * (0.35 + (1 - awareness) * 0.25) + (world.ball.y - pitch.width / 2) * (0.1 + awareness * 0.1), 6, pitch.width - 6);
          player.movementIntent = player.position === "CDM" ? "protect_box" : "recover_midfield";
        } else {
          const band = roleBand(player.position);
          const opponents = teamPlayers(world, otherTeam(team)).filter((opponent) => opponent.position !== "GK");
          const relevant = band === "striker"
            ? opponents.filter((opponent) => ["CB", "CDM", "CM"].includes(opponent.position))
            : ["centre_back", "fullback"].includes(band)
              ? opponents.filter((opponent) => ["ST", "LW", "RW", "CAM"].includes(opponent.position))
              : opponents.filter((opponent) => ["CDM", "CM", "CAM", "LM", "RM", "LW", "RW"].includes(opponent.position));
          const orderedMarkers = (relevant.length ? relevant : opponents).sort((left, right) => left.y - right.y);
          const orderedLine = outfield.filter((item) => roleBand(item.position) === band).sort((left, right) => left.anchor.y - right.anchor.y);
          const lineIndex = Math.max(0, orderedLine.findIndex((item) => item.key === player.key));
          const marking = orderedMarkers[lineIndex % Math.max(1, orderedMarkers.length)] ?? null;
          if (band === "striker") {
            player.targetY = clamp(anchor.y * 0.5 + (marking?.y ?? world.ball.y) * 0.5, 10, pitch.width - 10);
            player.movementIntent = "screen_pivot";
          } else if (["centre_back", "fullback"].includes(band)) {
            player.targetY = clamp(anchor.y * 0.58 + (marking?.y ?? anchor.y) * 0.42, 5, pitch.width - 5);
            player.movementIntent = "hold_defensive_line";
          } else {
            const laneDiscipline = 0.78 + defensiveAwareness(player) * 0.08;
            player.targetY = clamp(anchor.y * laneDiscipline + (marking?.y ?? world.ball.y) * (1 - laneDiscipline), 6, pitch.width - 6);
            player.movementIntent = "zonal_mark";
          }
          player.markingTarget = marking?.key ?? null;
        }
      }
    }
    if (!world.restart) separateShapeTargets(players);
  }
}

function separationVector(world, player) {
  let x = 0;
  let y = 0;
  for (const other of world.players) {
    if (other.key === player.key) continue;
    const dx = player.x - other.x;
    const dy = player.y - other.y;
    const desired = other.team === player.team ? 3 : movement.minimumPlayerSeparation;
    const gapSquared = dx * dx + dy * dy;
    if (gapSquared > EPSILON && gapSquared < desired * desired) {
      const gap = Math.sqrt(gapSquared);
      const force = (desired - gap) / desired;
      x += dx / gap * force;
      y += dy / gap * force;
    }
  }
  return { x, y };
}

function movePlayers(world) {
  for (const player of world.players) {
    const previous = { x: player.x, y: player.y };
    const toTarget = { x: player.targetX - player.x, y: player.targetY - player.y };
    const targetDistance = magnitude(toTarget);
    const direction = normalize(toTarget);
    const separation = separationVector(world, player);
    const urgent = ["press_ball", "support_press", "receive_pass", "attack_space", "mistimed_run", "overlap_run", "late_box_run", "goalkeeper_dive", "take_restart", "penalty_runup"].includes(player.movementIntent);
    const defensiveResponse = ["mark_box_threat", "track_dangerous_run", "protect_box", "recover_midfield"].includes(player.movementIntent)
      ? 0.66 + defensiveAwareness(player) * 0.25
      : null;
    const movementEffort = defensiveResponse ?? (urgent ? 0.92 : 0.66);
    const desiredSpeed = Math.min(player.maxSpeed * movementEffort, targetDistance * 1.4);
    const desiredVelocity = {
      x: direction.x * desiredSpeed + separation.x * 2,
      y: direction.y * desiredSpeed + separation.y * 2
    };
    const velocity = { x: player.vx, y: player.vy };
    const desiredChange = { x: desiredVelocity.x - velocity.x, y: desiredVelocity.y - velocity.y };
    const isBraking = dot(velocity, desiredVelocity) < 0 || magnitude(desiredVelocity) < magnitude(velocity);
    const maxChange = (isBraking ? movement.maximumBraking : player.maxAcceleration) * DT;
    const changeLength = magnitude(desiredChange);
    const change = changeLength > maxChange ? {
      x: desiredChange.x / changeLength * maxChange,
      y: desiredChange.y / changeLength * maxChange
    } : desiredChange;
    player.vx += change.x;
    player.vy += change.y;
    const speed = magnitude({ x: player.vx, y: player.vy });
    const ballFactor = world.ball.controllerKey === player.key
      ? movement.controlledBallSpeedMinimumFactor + (movement.controlledBallSpeedMaximumFactor - movement.controlledBallSpeedMinimumFactor) * player.abilities.dribbling / 100
      : 1;
    const allowedSpeed = player.maxSpeed * ballFactor;
    if (speed > allowedSpeed) {
      player.vx = player.vx / speed * allowedSpeed;
      player.vy = player.vy / speed * allowedSpeed;
    }
    player.x = clamp(player.x + player.vx * DT, movement.boundaryPadding, pitch.length - movement.boundaryPadding);
    player.y = clamp(player.y + player.vy * DT, movement.boundaryPadding, pitch.width - movement.boundaryPadding);
    if (magnitude({ x: player.vx, y: player.vy }) > 0.1) {
      const facing = normalize({ x: player.vx, y: player.vy });
      player.facingX = facing.x;
      player.facingY = facing.y;
    }
    const step = distance(previous, player);
    world.audit.maximumObservedStep = Math.max(world.audit.maximumObservedStep, step);
    world.audit.maximumObservedSpeed = Math.max(world.audit.maximumObservedSpeed, step / DT);
    const limit = player.maxSpeed * DT + auditConfig.movementTolerance;
    if (step > limit + EPSILON) world.audit.movementViolations.push({ tick: world.tick, playerId: player.id, step: round(step), limit: round(limit) });
    if (player.x < 0 || player.x > pitch.length || player.y < 0 || player.y > pitch.width) {
      world.audit.boundsViolations.push({ tick: world.tick, playerId: player.id, x: player.x, y: player.y });
    }
  }
  if (world.ball.state === "controlled") {
    const controller = playerByKey(world, world.ball.controllerKey);
    if (!controller) {
      world.audit.possessionViolations.push({ tick: world.tick, reason: "controller_missing" });
      world.ball.state = "loose";
      world.ball.controllerKey = null;
    } else {
      world.ball.x = clamp(controller.x + controller.facingX * 0.55, ballConfig.goalLineSafetyMargin, pitch.length - ballConfig.goalLineSafetyMargin);
      world.ball.y = clamp(controller.y + controller.facingY * 0.55, 0, pitch.width);
      world.ball.z = 0;
      world.ball.vx = controller.vx;
      world.ball.vy = controller.vy;
    }
  }
}

function segmentDistance(point, start, end) {
  const segment = vectorTo(start, end);
  const lengthSquared = segment.x ** 2 + segment.y ** 2;
  if (lengthSquared <= EPSILON) return distance(point, start);
  const t = clamp(((point.x - start.x) * segment.x + (point.y - start.y) * segment.y) / lengthSquared, 0, 1);
  return distance(point, { x: start.x + segment.x * t, y: start.y + segment.y * t });
}

function pressureAt(world, player) {
  const opponents = teamPlayers(world, otherTeam(player.team));
  return clamp(opponents.reduce((sum, opponent) => {
    const gap = distance(player, opponent);
    return sum + (gap < 1.5 ? 0.55 : gap < 3 ? 0.25 : gap < 5 ? 0.08 : 0);
  }, 0), 0, 1);
}

function startClearance(world, defender, technique = 'emergency_clearance') {
  const start = { x: world.ball.x, y: world.ball.y };
  const direction = directionOf(defender.team, world.period);
  const execution = mean([defender.abilities.technique, defender.abilities.passing, defender.abilities.composure]);
  const distanceTarget = 20 + execution * 0.16;
  const targetPoint = {
    x: clamp(start.x + direction * distanceTarget, 0, pitch.length),
    y: clamp(start.y + normalRandom(world.random) * (5 + (100 - execution) * 0.05), 0, pitch.width)
  };
  const speed = clamp(15 + execution * 0.08, 15, 23);
  const duration = Math.max(0.55, distance(start, targetPoint) / speed);
  world.pendingAction = {
    kind: 'clearance',
    team: defender.team,
    actorKey: defender.key,
    tickStart: world.tick,
    arrivalTick: world.tick + Math.ceil(duration / DT),
    targetPoint
  };
  world.ball.state = 'rolling';
  world.ball.controllerKey = null;
  world.ball.vx = (targetPoint.x - start.x) / duration;
  world.ball.vy = (targetPoint.y - start.y) / duration;
  world.ball.vz = 0;
  world.ball.lastTouchPlayerId = defender.id;
  world.ball.lastTouchTeamId = defender.team;
  world.ball.lastTouchType = 'clearance';
  world.possessionTeam = null;
  world.teams[defender.team].stats.clearances += 1;
  defender.stats.clearances += 1;
  recordAction(world, {
    type: 'clearance',
    technique,
    outcome: 'complete',
    team: defender.team,
    actorId: defender.id,
    startPosition: start,
    endPosition: targetPoint,
    pressure: pressureAt(world, defender),
    statsDelta: { clearances: 1 }
  });
}

function shotLaneClarity(world, shooter, goal) {
  const path = vectorTo(shooter, goal);
  const shotDistance = magnitude(path);
  const direction = normalize(path);
  const possibleBlockers = teamPlayers(world, otherTeam(shooter.team)).filter((opponent) => {
    if (opponent.position === "GK") return false;
    const projection = dot(vectorTo(shooter, opponent), direction);
    return projection > 0.5 && projection < shotDistance - 0.5;
  });
  const nearestLane = possibleBlockers.length
    ? Math.min(...possibleBlockers.map((opponent) => segmentDistance(opponent, shooter, goal)))
    : 4;
  return clamp(nearestLane / 3, 0, 1);
}

function offsideState(world, team, target, ballX = world.ball.x) {
  const direction = directionOf(team, world.period);
  const opponentXs = teamPlayers(world, otherTeam(team)).map((player) => player.x).sort((left, right) => direction > 0 ? right - left : left - right);
  const secondLast = opponentXs[1];
  const inOpponentHalf = direction > 0 ? target.x > pitch.length / 2 : target.x < pitch.length / 2;
  const beyondBall = direction > 0 ? target.x > ballX : target.x < ballX;
  const beyondSecondLast = direction > 0 ? target.x > secondLast : target.x < secondLast;
  const margin = Math.max(0, (target.x - secondLast) * direction);
  return { offside: inOpponentHalf && beyondBall && beyondSecondLast, lineX: secondLast, margin };
}

function passOptions(world, passer) {
  const direction = directionOf(passer.team, world.period);
  const opponents = teamPlayers(world, otherTeam(passer.team));
  const tactic = tacticFor(world, passer.team);
  const teamPhase = world.phases[passer.team];
  const passerProgress = relativeX(passer.team, world.period, passer.x);
  const passerInBox = passerProgress >= attacking.penaltyBoxEntryDepth
    && Math.abs(passer.y - pitch.width / 2) <= defending.centralDangerHalfWidth + 3;
  const pressure = pressureAt(world, passer);
  const decisionDiscipline = mean([passer.abilities.decisions, passer.abilities.composure]) / 100;
  return teamPlayers(world, passer.team)
    .filter((target) => target.key !== passer.key)
    .map((target) => {
      const lead = {
        x: clamp(target.x + target.vx * decision.passLeadSeconds, 1, pitch.length - 1),
        y: clamp(target.y + target.vy * decision.passLeadSeconds, 1, pitch.width - 1)
      };
      const length = distance(passer, lead);
      const nearestLane = Math.min(...opponents.map((opponent) => segmentDistance(opponent, passer, lead)));
      const laneSafety = clamp(nearestLane / 5, 0, 1);
      const progress = (lead.x - passer.x) * direction;
      const targetProgress = relativeX(passer.team, world.period, lead.x);
      const offside = offsideState(world, passer.team, {
        ...target,
        x: target.x + target.vx * 0.16
      }, passer.x);
      const positionalValue = ["ST", "CAM", "LW", "RW"].includes(target.position) ? 5 : 0;
      const wideTarget = Math.abs(lead.y - pitch.width / 2) > 20;
      const shortCombination = length <= 16 ? 1 : 0;
      const transitionBonus = teamPhase === "attacking_transition" && progress > 10 ? tactic.counterRun * 0.85 : 0;
      const purposefulCutback = passerInBox
        && progress < -1
        && targetProgress >= attacking.deepRecycleMinimumDepth
        && length <= attacking.maximumPurposefulCutbackLength;
      const deepRecycle = passerInBox
        && progress < -4
        && (targetProgress < attacking.deepRecycleMinimumDepth || length > attacking.maximumPurposefulCutbackLength);
      const boxCombination = passerInBox && targetProgress >= attacking.boxEdgeSupportDepth && length <= 18;
      const offsidePenalty = offside.offside
        ? 8 + passer.abilities.decisions * 0.06 + offside.margin * 5
        : 0;
      const retreatPenalty = deepRecycle
        ? (22 + Math.max(0, -progress - 4) * 1.25 + Math.max(0, length - 18) * 0.55) * (0.55 + decisionDiscipline * 0.45) * (1 - pressure * 0.42)
        : 0;
      const score = laneSafety * 35 * tactic.passSafety + progress * 0.75 * tactic.passDirectness - Math.abs(length - (world.teams[passer.team].tacticId === "possession" ? 13 : 18)) * 0.5 + positionalValue
        + (wideTarget ? tactic.widePassBias : 0) + (world.teams[passer.team].tacticId === "possession" ? shortCombination * 8 : 0) + transitionBonus
        + (purposefulCutback ? 12 : 0) + (boxCombination ? 10 : 0) - retreatPenalty
        + target.abilities.firstTouch * 0.08 + world.random() * 5 - offsidePenalty;
      return { target, point: lead, length, laneSafety, progress, targetProgress, purposefulCutback, deepRecycle, offside, score };
    })
    .filter((option) => option.length >= 3 && option.length <= 45)
    .filter((option) => !option.offside.offside || world.random() < clamp(
      setPieces.offsidePassMinimumChance + (100 - passer.abilities.decisions) / 320,
      setPieces.offsidePassMinimumChance,
      setPieces.offsidePassMaximumChance
    ))
    .sort((left, right) => right.score - left.score);
}

function choosePassOption(world, passer, options) {
  const awareness = mean([passer.abilities.vision, passer.abilities.decisions, passer.abilities.composure]) / 100;
  const choiceWindow = Math.min(options.length, awareness >= 0.78 ? 4 : awareness >= 0.62 ? 3 : 2);
  const visible = options.slice(0, choiceWindow);
  if (visible.length <= 1) return visible[0] ?? null;
  const bestScore = visible[0].score;
  const temperature = 18 - awareness * 6;
  const weighted = visible.map((option) => ({ option, weight: Math.exp((option.score - bestScore) / temperature) }));
  const total = weighted.reduce((sum, item) => sum + item.weight, 0);
  let roll = world.random() * total;
  for (const item of weighted) {
    roll -= item.weight;
    if (roll <= 0) return item.option;
  }
  return weighted.at(-1).option;
}

function startPass(world, passer, option, actionOptions = {}) {
  const start = { x: world.ball.x, y: world.ball.y };
  const deliveryTechnique = actionOptions.technique;
  const passExecution = ['cross', 'corner_cross', 'free_kick_delivery'].includes(deliveryTechnique)
    ? mean([passer.abilities.crossing, passer.abilities.technique, passer.abilities.composure])
    : mean([passer.abilities.passing, passer.abilities.technique, passer.abilities.composure]);
  const errorScale = (100 - passExecution) / 100;
  const pressure = pressureAt(world, passer);
  const targetPoint = {
    x: clamp(option.point.x + normalRandom(world.random) * (0.35 + errorScale * 2.3 + pressure * 1.2), ballConfig.goalLineSafetyMargin, pitch.length - ballConfig.goalLineSafetyMargin),
    y: clamp(option.point.y + normalRandom(world.random) * (0.35 + errorScale * 2.3 + pressure * 1.2), 0, pitch.width)
  };
  const length = distance(start, targetPoint);
  const speed = clamp(ballConfig.minimumPassSpeed + length * 0.32, ballConfig.minimumPassSpeed, ballConfig.maximumPassSpeed);
  const duration = Math.max(0.25, length / speed);
  const passerProgress = relativeX(passer.team, world.period, passer.x);
  const wideDelivery = Math.abs(passer.y - pitch.width / 2) > 20 && passerProgress > 60 && option.progress > 2;
  const technique = actionOptions.technique ?? (wideDelivery && ["ST", "CAM", "LW", "RW"].includes(option.target.position)
    ? "cross"
    : option.progress > 14 && ["ST", "CAM", "LW", "RW"].includes(option.target.position)
      ? "through_ball"
      : length > 30 ? "long_pass" : option.progress > 8 ? "progressive_pass" : option.progress < -5 ? "back_pass" : "short_pass");
  world.pendingAction = {
    kind: "pass",
    possessionId: world.possessionId,
    tickStart: world.tick,
    team: passer.team,
    actorKey: passer.key,
    targetKey: option.target.key,
    targetPoint,
    startPosition: start,
    pressure,
    technique,
    offsideAtKick: option.offside.offside,
    offsideLineX: option.offside.lineX,
    offsideMargin: option.offside.margin,
    interceptionTried: [],
    arrivalTick: world.tick + Math.ceil(duration / DT)
  };
  world.ball.state = "rolling";
  world.ball.controllerKey = null;
  world.ball.vx = (targetPoint.x - start.x) / duration;
  world.ball.vy = (targetPoint.y - start.y) / duration;
  world.ball.vz = 0;
  world.ball.lastTouchPlayerId = passer.id;
  world.ball.lastTouchTeamId = passer.team;
  world.ball.lastTouchType = "pass";
  world.ball.trajectoryId = `trajectory-${world.tick}`;
  world.teams[passer.team].stats.passes += 1;
  passer.stats.passes += 1;
  passer.nextActionAt = world.matchTime + decision.minimumActionDelay / tacticFor(world, passer.team).tempo;
}

function shotXg(world, shooter, shotDistance, pressure, laneClarity = 1) {
  const goal = attackingGoal(shooter.team, world.period);
  const angle = Math.atan2(pitch.goalWidth / 2, Math.max(shotDistance, 1));
  const centrality = 1 - Math.min(Math.abs(shooter.y - goal.y) / (pitch.width / 2), 1);
  const quality = shooter.abilities.finishing / 100;
  const obstructionPenalty = (1 - laneClarity) * 0.9;
  const logit = -0.7 - shotDistance * 0.13 + angle * 1.5 + centrality * 0.45 + quality * 0.55 - pressure * 1.1 - obstructionPenalty;
  return clamp(1 / (1 + Math.exp(-logit)), 0.01, 0.75);
}

function evaluateShotOpportunity(world, shooter, pressure = pressureAt(world, shooter)) {
  const goal = attackingGoal(shooter.team, world.period);
  const ballPosition = { x: world.ball.x, y: world.ball.y };
  const shotDistance = distance(ballPosition, goal);
  const laneClarity = shotLaneClarity(world, shooter, goal);
  const centrality = 1 - Math.min(Math.abs(ballPosition.y - goal.y) / (pitch.width / 2), 1);
  const facing = dot({ x: shooter.facingX, y: shooter.facingY }, normalize(vectorTo(shooter, goal)));
  const routine = shotDistance <= decision.routineShotDistance;
  const exceptional = shotDistance <= decision.absoluteShotDistance && shooter.abilities.longShots >= 78 && pressure < 0.35;
  const xg = shotXg(world, shooter, shotDistance, pressure, laneClarity);
  const executionQuality = mean([shooter.abilities.finishing, shooter.abilities.composure]) / 100;
  const utility = xg * 120 + laneClarity * 12 + executionQuality * 8 + Math.max(0, facing) * 5 - pressure * 18;
  const clearShot = shotDistance <= decision.clearShotDistance
    && pressure <= decision.clearShotMaximumPressure
    && laneClarity >= decision.clearShotMinimumLaneClarity
    && centrality >= decision.clearShotMinimumCentrality
    && facing >= decision.clearShotMinimumFacing;
  return { eligible: routine || exceptional, clearShot, shotDistance, laneClarity, centrality, facing, xg, utility };
}

function startShot(world, shooter, opportunity = null, options = {}) {
  const goal = attackingGoal(shooter.team, world.period);
  const start = { x: world.ball.x, y: world.ball.y };
  const pressure = pressureAt(world, shooter);
  const context = opportunity ?? evaluateShotOpportunity(world, shooter, pressure);
  const { shotDistance } = context;
  const goalkeeper = teamPlayers(world, otherTeam(shooter.team)).find((player) => player.position === "GK");
  const keeperQuality = goalkeeper
    ? mean([goalkeeper.abilities.goalkeeping, goalkeeper.abilities.reflexes, goalkeeper.abilities.positioning])
    : 65;
  const keeperShotStoppingFactor = clamp(1.12 - keeperQuality / 300, 0.78, 1);
  const header = options.technique === 'header';
  const headerExecution = mean([shooter.abilities.heading, shooter.abilities.jumping, shooter.abilities.offBall, shooter.abilities.composure]);
  const xg = options.isPenalty
    ? clamp(0.74 + (shooter.abilities.penaltyTaking - (goalkeeper?.abilities.goalkeeping ?? 70)) / 420, 0.58, 0.9)
    : header
      ? clamp(context.xg * keeperShotStoppingFactor * (0.72 + headerExecution / 250), 0.01, 0.62)
      : clamp(context.xg * keeperShotStoppingFactor, 0.01, 0.75);
  const accuracy = header
    ? headerExecution
    : mean([shooter.abilities.finishing, shooter.abilities.technique, shooter.abilities.composure]);
  const distancePenalty = Math.max(0, shotDistance - 12) * 0.05;
  const goalIntent = world.random() < xg;
  const onTargetChance = clamp(0.34 + accuracy / 210 - pressure * 0.12, 0.32, 0.82);
  const onTarget = goalIntent || world.random() < onTargetChance;
  const woodwork = !onTarget && world.random() < goalkeeping.woodworkChance;
  const rawDeviation = onTarget
    ? normalRandom(world.random) * 1.45
    : normalRandom(world.random) * (2.8 + (100 - accuracy) / 7 + distancePenalty + pressure * 3);
  const postSide = rawDeviation < 0 ? -1 : 1;
  const deviation = onTarget
    ? clamp(rawDeviation, -pitch.goalWidth / 2 + 0.2, pitch.goalWidth / 2 - 0.2)
    : woodwork ? postSide * (pitch.goalWidth / 2 - 0.04) : postSide * Math.max(pitch.goalWidth / 2 + 0.5, Math.abs(rawDeviation));
  const goalTargetPoint = { x: goal.x, y: goal.y + deviation };
  const shotDirection = directionOf(shooter.team, world.period);
  const plannedSave = onTarget && !goalIntent && goalkeeper;
  const targetPoint = plannedSave
    ? { x: goal.x - shotDirection * 1.05, y: goalTargetPoint.y }
    : goalTargetPoint;
  const shotPower = header
    ? mean([shooter.abilities.heading, shooter.abilities.jumping, shooter.abilities.strength])
    : mean([shooter.abilities.finishing, shooter.abilities.strength]);
  const speed = ballConfig.shotSpeedMinimum
    + (ballConfig.shotSpeedMaximum - ballConfig.shotSpeedMinimum) * clamp(shotPower / 100, 0, 1);
  const duration = Math.max(0.2, distance(start, targetPoint) / speed);
  world.pendingAction = {
    kind: "shot",
    possessionId: world.possessionId,
    tickStart: world.tick,
    team: shooter.team,
    actorKey: shooter.key,
    targetKey: null,
    targetPoint,
    goalTargetPoint,
    startPosition: start,
    pressure,
    technique: options.technique ?? (shotDistance > 25 ? "long_shot" : "placed_shot"),
    shotDistance,
    xg,
    goalIntent,
    onTarget,
    woodwork,
    isPenalty: Boolean(options.isPenalty),
    arrivalTick: world.tick + Math.ceil(duration / DT)
  };
  world.ball.state = "shot";
  world.ball.controllerKey = null;
  world.ball.vx = (targetPoint.x - start.x) / duration;
  world.ball.vy = (targetPoint.y - start.y) / duration;
  world.ball.vz = options.isPenalty ? 0.25 : 0.4;
  world.ball.lastTouchPlayerId = shooter.id;
  world.ball.lastTouchTeamId = shooter.team;
  world.ball.lastTouchType = "shot";
  world.ball.trajectoryId = `trajectory-${world.tick}`;
  world.teams[shooter.team].stats.shots += 1;
  world.teams[shooter.team].stats.xg += xg;
  shooter.stats.shots += 1;
  shooter.stats.xg += xg;
  shooter.nextActionAt = world.matchTime + decision.maximumActionDelay;
}

function decideControllerAction(world) {
  const controller = playerByKey(world, world.ball.controllerKey);
  if (!controller || world.matchTime < controller.nextActionAt || world.pendingAction || world.restart) return;
  const pressure = pressureAt(world, controller);
  const ownDepth = relativeX(controller.team, world.period, controller.x);
  if (world.ball.lastTouchType === "kickoff") {
    const kickoffChoice = passOptions(world, controller)
      .filter((option) => option.progress < -0.5)
      .sort((left, right) => {
        const leftRole = ["CM", "CDM", "CB"].includes(left.target.position) ? 1 : 0;
        const rightRole = ["CM", "CDM", "CB"].includes(right.target.position) ? 1 : 0;
        return rightRole - leftRole || Math.abs(left.length - 9) - Math.abs(right.length - 9);
      })[0];
    if (kickoffChoice) {
      startPass(world, controller, kickoffChoice, { technique: "kickoff_back_pass" });
      return;
    }
  }
  const reboundActive = world.reboundWindow && world.reboundWindow.untilTick >= world.tick;
  if (reboundActive) {
    if (controller.team === world.reboundWindow.attackingTeam) {
      const reboundOpportunity = evaluateShotOpportunity(world, controller, pressure);
      const reboundQuality = mean([controller.abilities.anticipation, controller.abilities.offBall, controller.abilities.finishing, controller.abilities.composure]) / 100;
      if (reboundOpportunity.eligible && world.random() < clamp(0.28 + reboundQuality * 0.42 - pressure * 0.12, 0.22, 0.68)) {
        world.reboundWindow = null;
        startShot(world, controller, reboundOpportunity, { technique: 'rebound_shot' });
        return;
      }
    } else if (ownDepth <= 24 && ['CB', 'LB', 'RB', 'LWB', 'RWB', 'CDM'].includes(controller.position)) {
      world.reboundWindow = null;
      startClearance(world, controller, 'scramble_clearance');
      return;
    }
  }
  const turnoverActive = world.turnoverWindow
    && world.turnoverWindow.untilTick >= world.tick
    && world.turnoverWindow.playerKey === controller.key;
  if (turnoverActive) {
    const turnoverOpportunity = evaluateShotOpportunity(world, controller, pressure);
    const turnoverQuality = mean([controller.abilities.anticipation, controller.abilities.decisions, controller.abilities.composure, controller.abilities.finishing]) / 100;
    if (turnoverOpportunity.eligible && world.random() < clamp(0.22 + turnoverQuality * 0.34 - pressure * 0.1, 0.18, 0.54)) {
      world.turnoverWindow = null;
      startShot(world, controller, turnoverOpportunity, { technique: 'turnover_shot' });
      return;
    }
  }
  if (ownDepth <= 18
    && ['CB', 'LB', 'RB', 'LWB', 'RWB', 'CDM'].includes(controller.position)
    && (pressure >= 0.22 || world.reboundWindow)) {
    startClearance(world, controller, 'pressure_clearance');
    return;
  }
  const options = passOptions(world, controller);
  const shotOpportunity = evaluateShotOpportunity(world, controller, pressure);
  const bestPassValue = options[0]?.score ?? 0;
  const decisionQuality = mean([controller.abilities.decisions, controller.abilities.composure]) / 100;
  const valueGap = shotOpportunity.utility - bestPassValue - decision.shotValueMargin;
  const rationalPreference = 1 / (1 + Math.exp(-valueGap / 10));
  const opportunityBase = shotOpportunity.xg * 0.55
    + Math.max(0, decision.clearShotDistance - shotOpportunity.shotDistance) / decision.clearShotDistance * 0.12
    + shotOpportunity.laneClarity * 0.05;
  const judgment = rationalPreference * decisionQuality + 0.35 * (1 - decisionQuality);
  let shotChoiceProbability = clamp(opportunityBase * (0.42 + judgment * 0.82), 0.002, 0.015);
  if (shotOpportunity.clearShot) {
    const clearChanceFloor = 0.15 + decisionQuality * 0.115 + shotOpportunity.xg * 0.2;
    shotChoiceProbability = clamp(Math.max(shotChoiceProbability, clearChanceFloor), 0.15, 0.45);
  }
  const shouldShoot = OUTFIELD_POSITIONS.has(controller.position)
    && shotOpportunity.eligible
    && world.random() < shotChoiceProbability;
  if (shouldShoot) {
    startShot(world, controller, shotOpportunity);
    return;
  }
  const tacticId = world.teams[controller.team].tacticId;
  const passPreference = tacticId === "possession" ? 0.88 : tacticId === "counter" ? 0.68 : tacticId === "all_out_attack" ? 0.7 : 0.74;
  const shouldPass = options.length && (pressure > 0.2 || world.random() < passPreference || controller.position === "GK");
  if (shouldPass) {
    const choice = choosePassOption(world, controller, options);
    if (choice) startPass(world, controller, choice);
    return;
  }
  controller.nextActionAt = world.matchTime + decision.minimumActionDelay
    + world.random() * (decision.maximumActionDelay - decision.minimumActionDelay);
}

function takeControl(world, player, touchType, options = {}) {
  const previousTeam = world.possessionTeam;
  world.ball.state = "controlled";
  world.ball.controllerKey = player.key;
  world.ball.vx = player.vx;
  world.ball.vy = player.vy;
  world.ball.vz = 0;
  world.ball.lastTouchPlayerId = player.id;
  world.ball.lastTouchTeamId = player.team;
  world.ball.lastTouchType = touchType;
  world.ball.trajectoryId = null;
  if (previousTeam !== player.team) {
    world.possessionId += 1;
    world.phaseSince = world.tick;
  }
  world.possessionTeam = player.team;
  const tempo = tacticFor(world, player.team).tempo;
  const attackingDepth = relativeX(player.team, world.period, player.x);
  const quality = mean([player.abilities.firstTouch, player.abilities.decisions, player.abilities.composure]) / 100;
  const minimumDelay = attackingDepth >= 70 ? decision.attackingTouchDelayMinimum : decision.routineTouchDelayMinimum;
  const maximumDelay = attackingDepth >= 70 ? decision.attackingTouchDelayMaximum : decision.routineTouchDelayMaximum;
  const controlDelay = maximumDelay - (maximumDelay - minimumDelay) * quality;
  player.nextActionAt = options.immediate
    ? world.matchTime
    : Math.max(player.nextActionAt, world.matchTime + controlDelay / tempo);
}

function attemptFirstTimeAction(world, receiver, incomingSpeed) {
  if (world.restart || world.pendingAction) return false;
  const techniqueQuality = mean([
    receiver.abilities.firstTouch,
    receiver.abilities.technique,
    receiver.abilities.anticipation,
    receiver.abilities.decisions,
    receiver.abilities.composure
  ]) / 100;
  const speedPenalty = clamp((incomingSpeed - 10) / Math.max(1, firstTimeActions.maximumPassSpeed - 10), 0, 1) * 0.18;
  const pressure = pressureAt(world, receiver);
  const facingGoal = dot({ x: receiver.facingX, y: receiver.facingY }, normalize(vectorTo(receiver, attackingGoal(receiver.team, world.period))));
  const chance = clamp(
    firstTimeActions.minimumChance + techniqueQuality * 0.34 - speedPenalty - pressure * 0.12 + Math.max(0, facingGoal) * 0.05,
    firstTimeActions.minimumChance,
    firstTimeActions.maximumChance
  );
  if (world.random() >= chance) return false;
  takeControl(world, receiver, "first_time_contact", { immediate: true });
  const depth = relativeX(receiver.team, world.period, receiver.x);
  const shotOpportunity = evaluateShotOpportunity(world, receiver, pressure);
  const firstTimeShotChance = depth >= firstTimeActions.shotActivationDepth && shotOpportunity.eligible
    ? clamp(0.008 + receiver.abilities.finishing / 3000 + Math.max(0, shotOpportunity.xg - 0.06) * 0.65 - pressure * 0.1, 0.008, 0.22)
    : 0;
  if (world.random() < firstTimeShotChance) {
    startShot(world, receiver, shotOpportunity, { technique: "first_time_shot" });
    return true;
  }
  const option = choosePassOption(world, receiver, passOptions(world, receiver));
  if (!option) return false;
  startPass(world, receiver, option, { technique: "first_time_pass" });
  return true;
}

function attemptSetPieceFinish(world, receiver, pending) {
  if (!['corner_cross', 'free_kick_delivery'].includes(pending.technique)) return false;
  const depth = relativeX(receiver.team, world.period, receiver.x);
  if (depth < attacking.boxEdgeSupportDepth) return false;
  const opponent = closestPlayers(teamPlayers(world, otherTeam(receiver.team)), receiver, (player) => player.position !== 'GK')[0];
  const attackingAerial = mean([receiver.abilities.heading, receiver.abilities.jumping, receiver.abilities.offBall, receiver.abilities.strength]) / 100;
  const defendingAerial = opponent
    ? mean([opponent.abilities.heading, opponent.abilities.jumping, opponent.abilities.positioning, opponent.abilities.strength]) / 100
    : 0.55;
  const contactChance = clamp(0.34 + (attackingAerial - defendingAerial) * 0.55 + receiver.abilities.anticipation / 500, 0.2, 0.72);
  if (world.random() >= contactChance) return false;
  takeControl(world, receiver, 'aerial_contact', { immediate: true });
  const opportunity = evaluateShotOpportunity(world, receiver, pressureAt(world, receiver));
  if (!opportunity.eligible) return false;
  startShot(world, receiver, opportunity, { technique: 'header' });
  return true;
}

function finishPass(world, receiver, outcome, opponent = null) {
  const pending = world.pendingAction;
  const passer = playerByKey(world, pending.actorKey);
  const incomingSpeed = magnitude({ x: world.ball.vx, y: world.ball.vy });
  if (outcome === "complete") {
    world.teams[pending.team].stats.completedPasses += 1;
    passer.stats.completedPasses += 1;
  } else if (outcome === "intercepted" && opponent) {
    world.teams[opponent.team].stats.interceptions += 1;
    opponent.stats.interceptions += 1;
    passer.stats.dispossessions += 1;
  } else if (outcome === "offside") {
    world.teams[pending.team].stats.offsides += 1;
  }
  recordAction(world, {
    possessionId: pending.possessionId,
    tickStart: pending.tickStart,
    tickEnd: world.tick,
    period: world.period,
    type: "pass",
    technique: pending.technique,
    outcome,
    team: pending.team,
    actorId: passer.id,
    targetPlayerId: outcome === "complete" ? receiver?.id ?? null : playerByKey(world, pending.targetKey)?.id ?? null,
    intendedTargetPlayerId: playerByKey(world, pending.targetKey)?.id ?? null,
    opponentId: opponent?.id ?? null,
    startPosition: pending.startPosition,
    endPosition: { x: world.ball.x, y: world.ball.y },
    pressure: pending.pressure,
    statsDelta: outcome === "complete" ? { passes: 1, completedPasses: 1 } : { passes: 1 }
  });
  world.pendingAction = null;
  if (outcome === "offside") {
    const target = playerByKey(world, pending.targetKey);
    const targetDepth = target ? relativeX(pending.team, world.period, target.x) : 0;
    const canPlayDisallowedGoal = target
      && pending.offsideMargin <= setPieces.marginalOffsideDistance
      && targetDepth >= firstTimeActions.shotActivationDepth
      && world.random() < setPieces.disallowedGoalChance;
    if (canPlayDisallowedGoal) {
      const goal = attackingGoal(pending.team, world.period);
      const duration = Math.max(0.35, distance(world.ball, goal) / ballConfig.shotSpeedMinimum);
      world.pendingAction = {
        kind: "disallowed_shot",
        possessionId: pending.possessionId,
        tickStart: world.tick,
        team: pending.team,
        actorKey: target.key,
        targetPoint: { x: goal.x, y: clamp(target.y, goal.y - pitch.goalWidth / 2 + 0.35, goal.y + pitch.goalWidth / 2 - 0.35) },
        startPosition: { x: world.ball.x, y: world.ball.y },
        technique: "offside_finish",
        restartPoint: { x: world.ball.x, y: world.ball.y },
        arrivalTick: world.tick + Math.ceil(duration / DT)
      };
      world.ball.state = "shot";
      world.ball.controllerKey = null;
      world.ball.vx = (world.pendingAction.targetPoint.x - world.ball.x) / duration;
      world.ball.vy = (world.pendingAction.targetPoint.y - world.ball.y) / duration;
      world.ball.vz = 0.3;
      world.ball.lastTouchPlayerId = target.id;
      world.ball.lastTouchTeamId = target.team;
      world.ball.lastTouchType = "offside_finish";
      world.possessionTeam = pending.team;
      return;
    }
    scheduleRestart(world, "free_kick", otherTeam(pending.team), { x: world.ball.x, y: world.ball.y });
  } else if (receiver) {
    if (outcome === 'intercepted' && ['corner_cross', 'free_kick_delivery'].includes(pending.technique)) {
      startClearance(world, receiver, 'aerial_clearance');
      return;
    }
    if (outcome === 'complete' && attemptSetPieceFinish(world, receiver, pending)) return;
    if (outcome === "complete" && attemptFirstTimeAction(world, receiver, incomingSpeed)) return;
    takeControl(world, receiver, outcome === "intercepted" ? "interception" : "reception");
  } else {
    world.ball.state = "loose";
    world.ball.controllerKey = null;
    world.possessionTeam = null;
  }
}

function resolveDisallowedShotFlight(world) {
  const pending = world.pendingAction;
  const goal = attackingGoal(pending.team, world.period);
  const direction = directionOf(pending.team, world.period);
  const reachedGoalLine = direction > 0 ? world.ball.x >= goal.x : world.ball.x <= goal.x;
  if (world.tick < pending.arrivalTick && !reachedGoalLine) return;
  const actor = playerByKey(world, pending.actorKey);
  world.ball.x = goal.x + direction * ballConfig.goalNetDepth;
  world.ball.y = pending.targetPoint.y;
  world.ball.vx = 0;
  world.ball.vy = 0;
  world.ball.vz = 0;
  recordAction(world, {
    possessionId: pending.possessionId,
    tickStart: pending.tickStart,
    tickEnd: world.tick,
    type: "disallowed_goal",
    technique: pending.technique,
    outcome: "offside",
    team: pending.team,
    actorId: actor?.id ?? null,
    startPosition: pending.startPosition,
    endPosition: { x: world.ball.x, y: world.ball.y }
  });
  world.pendingAction = null;
  world.goalPause = {
    readyTick: world.tick + Math.ceil(1.6 / DT),
    restart: { type: "free_kick", team: otherTeam(pending.team), point: pending.restartPoint }
  };
  world.ball.state = "dead";
  world.ball.controllerKey = null;
  world.possessionTeam = null;
  world.discontinuity = "offside_goal_disallowed";
}

function findInterception(world, pending) {
  const opponents = closestPlayers(teamPlayers(world, otherTeam(pending.team)), world.ball, (player) => player.position !== "GK");
  const opponent = opponents.find((player) => !pending.interceptionTried.includes(player.key));
  if (!opponent || distance(opponent, world.ball) > ballConfig.interceptionRadius) return null;
  pending.interceptionTried.push(opponent.key);
  const reaction = mean([opponent.abilities.anticipation, opponent.abilities.positioning, opponent.abilities.tackling]) / 100;
  const ballSpeed = magnitude({ x: world.ball.vx, y: world.ball.vy });
  const chance = clamp(reaction * 0.34 - ballSpeed / 140, 0.03, 0.33);
  return world.random() < chance ? opponent : null;
}

function resolvePassFlight(world) {
  const pending = world.pendingAction;
  const target = playerByKey(world, pending.targetKey);
  const elapsedTicks = world.tick - pending.tickStart;
  if (elapsedTicks > 2) {
    const interceptor = findInterception(world, pending);
    if (interceptor) return finishPass(world, interceptor, "intercepted", interceptor);
  }
  if (world.tick >= pending.arrivalTick) {
    if (pending.offsideAtKick && target?.team === pending.team) return finishPass(world, null, "offside");
    const receiver = closestPlayers(teamPlayers(world, pending.team), world.ball)[0];
    if (receiver && distance(receiver, world.ball) <= ballConfig.controlRadius * 2.2) return finishPass(world, receiver, "complete");
    const opponent = closestPlayers(teamPlayers(world, otherTeam(pending.team)), world.ball)[0];
    if (opponent && distance(opponent, world.ball) <= ballConfig.controlRadius * 1.8) return finishPass(world, opponent, "intercepted", opponent);
    return finishPass(world, null, "incomplete");
  }
}

function resolveClearanceFlight(world) {
  const pending = world.pendingAction;
  if (!pending || pending.kind !== 'clearance' || world.tick < pending.arrivalTick) return;
  world.pendingAction = null;
  world.ball.state = 'loose';
  world.ball.controllerKey = null;
  world.possessionTeam = null;
}

function scheduleRestart(world, type, team, point) {
  const candidates = type === "penalty"
    ? [...teamPlayers(world, team)].filter((player) => player.position !== "GK").sort((left, right) => right.abilities.penaltyTaking - left.abilities.penaltyTaking)
    : type === 'corner' || type === 'free_kick'
      ? [...teamPlayers(world, team)]
        .filter((player) => player.position !== 'GK')
        .sort((left, right) => setPieceTakerScore(type, right, point) - setPieceTakerScore(type, left, point))
      : closestPlayers(teamPlayers(world, team), point, (player) => type === "goal_kick" ? player.position === "GK" : true);
  const taker = candidates[0] ?? teamPlayers(world, team)[0];
  world.restart = {
    type,
    team,
    point: { x: clamp(point.x, 0, pitch.length), y: clamp(point.y, 0, pitch.width) },
    takerKey: taker.key,
    readyTick: world.tick + Math.ceil(setPieces.restartDelay / DT),
    latestTick: world.tick + Math.ceil((type === 'corner' || type === 'free_kick' ? 12 : 10) / DT),
    runupStarted: false,
    strikeTick: null
  };
  world.ball.state = "dead";
  world.ball.controllerKey = null;
  world.ball.vx = 0;
  world.ball.vy = 0;
  world.ball.vz = 0;
  world.ball.x = world.restart.point.x;
  world.ball.y = world.restart.point.y;
  world.possessionTeam = null;
}

function finishShot(world, outcome, goalkeeper = null) {
  const pending = world.pendingAction;
  const shooter = playerByKey(world, pending.actorKey);
  const defendingTeam = otherTeam(pending.team);
  const goalScored = outcome === 'goal' || outcome === 'own_goal';
  if (goalScored) {
    const goal = attackingGoal(pending.team, world.period);
    world.ball.x = goal.x + directionOf(pending.team, world.period) * ballConfig.goalNetDepth;
    world.ball.y = clamp((pending.goalTargetPoint ?? pending.targetPoint).y, goal.y - pitch.goalWidth / 2 + 0.2, goal.y + pitch.goalWidth / 2 - 0.2);
    world.ball.vx = 0;
    world.ball.vy = 0;
    world.ball.vz = 0;
  }
  if (["goal", "saved"].includes(outcome)) {
    world.teams[pending.team].stats.shotsOnTarget += 1;
    shooter.stats.shotsOnTarget += 1;
  }
  if (goalScored) {
    world.teams[pending.team].stats.goals += 1;
    if (outcome === 'goal') shooter.stats.goals += 1;
    else if (goalkeeper) goalkeeper.stats.ownGoals += 1;
  }
  if (outcome === "saved" && goalkeeper) {
    world.teams[defendingTeam].stats.saves += 1;
    goalkeeper.stats.saves += 1;
  }
  recordAction(world, {
    possessionId: pending.possessionId,
    tickStart: pending.tickStart,
    tickEnd: world.tick,
    period: world.period,
    type: "shot",
    technique: pending.technique,
    outcome,
    team: pending.team,
    actorId: shooter.id,
    opponentId: goalkeeper?.id ?? null,
    startPosition: pending.startPosition,
    endPosition: { x: world.ball.x, y: world.ball.y },
    pressure: pending.pressure,
    xg: pending.xg,
    saveType: pending.saveType,
    statsDelta: {
      shots: 1,
      shotsOnTarget: ["goal", "saved"].includes(outcome) ? 1 : 0,
      goals: goalScored ? 1 : 0,
      xg: round(pending.xg, 3)
    }
  });
  world.pendingAction = null;
  if (goalScored) {
    world.goalPause = {
      team: defendingTeam,
      readyTick: world.tick + Math.ceil(ballConfig.goalPauseSeconds / DT)
    };
    world.ball.state = "dead";
    world.ball.controllerKey = null;
    world.possessionTeam = null;
    world.discontinuity = "goal_scored";
  } else if (outcome === "saved" && goalkeeper) {
    if (pending.saveType === "parried_corner") {
      const towardOwnGoalLine = -directionOf(defendingTeam, world.period);
      world.ball.state = "loose";
      world.ball.controllerKey = null;
      world.ball.vx = towardOwnGoalLine * (5 + world.random() * 2);
      world.ball.vy = (goalkeeper.y <= pitch.width / 2 ? -1 : 1) * (2 + world.random() * 2);
      world.ball.lastTouchPlayerId = goalkeeper.id;
      world.ball.lastTouchTeamId = goalkeeper.team;
      world.ball.lastTouchType = "save_parry";
      world.possessionTeam = null;
    } else if (pending.saveType === "parried") {
      const awayFromGoal = directionOf(defendingTeam, world.period);
      world.ball.state = "loose";
      world.ball.controllerKey = null;
      world.ball.vx = awayFromGoal * (5 + world.random() * 3);
      world.ball.vy = (pending.targetPoint.y <= pitch.width / 2 ? -1 : 1) * (2 + world.random() * 3);
      world.ball.lastTouchPlayerId = goalkeeper.id;
      world.ball.lastTouchTeamId = goalkeeper.team;
      world.ball.lastTouchType = "save_parry";
      world.possessionTeam = null;
      world.reboundWindow = { attackingTeam: pending.team, untilTick: world.tick + Math.ceil(3 / DT) };
    } else {
      takeControl(world, goalkeeper, "save");
      world.securedGoalkeeper = {
        playerKey: goalkeeper.key,
        untilTick: world.tick + Math.ceil(2.2 / DT)
      };
    }
  } else if (outcome === "woodwork") {
    world.ball.state = "loose";
    world.ball.controllerKey = null;
    world.ball.vx = -directionOf(pending.team, world.period) * (5 + world.random() * 4);
    world.ball.vy = (pending.targetPoint.y <= pitch.width / 2 ? 1 : -1) * (2 + world.random() * 3);
    world.possessionTeam = null;
    world.reboundWindow = { attackingTeam: pending.team, untilTick: world.tick + Math.ceil(3 / DT) };
  } else {
    const ownGoal = defendingGoal(defendingTeam, world.period);
    scheduleRestart(world, "goal_kick", defendingTeam, { x: ownGoal.x + directionOf(defendingTeam, world.period) * 5.5, y: pitch.width / 2 });
  }
}

function resolveShotFlight(world) {
  const pending = world.pendingAction;
  const defendingTeam = otherTeam(pending.team);
  const blockers = closestPlayers(teamPlayers(world, defendingTeam), world.ball, (player) => player.position !== "GK");
  const blocker = blockers[0];
  if (!pending.isPenalty && world.tick - pending.tickStart > 1 && blocker && distance(blocker, world.ball) < 0.72) {
    const blockerDepth = relativeX(defendingTeam, world.period, blocker.x);
    const defensiveControl = mean([blocker.abilities.positioning, blocker.abilities.composure, blocker.abilities.technique]) / 100;
    const ownGoalChance = clamp(
      defending.ownGoalBaseChance + (1 - defensiveControl) * 0.009 + pressureAt(world, blocker) * 0.002,
      defending.ownGoalBaseChance,
      defending.ownGoalMaximumChance
    );
    if (blockerDepth <= 13 && world.random() < ownGoalChance) return finishShot(world, 'own_goal', blocker);
    recordAction(world, {
      possessionId: pending.possessionId,
      tickStart: pending.tickStart,
      tickEnd: world.tick,
      type: "shot",
      technique: pending.technique,
      outcome: "blocked",
      team: pending.team,
      actorId: playerByKey(world, pending.actorKey).id,
      opponentId: blocker.id,
      startPosition: pending.startPosition,
      endPosition: { x: world.ball.x, y: world.ball.y },
      pressure: pending.pressure,
      xg: pending.xg,
      statsDelta: { shots: 1, xg: round(pending.xg, 3) }
    });
    world.pendingAction = null;
    const ownGoal = defendingGoal(defendingTeam, world.period);
    const deflectsForCorner = relativeX(defendingTeam, world.period, blocker.x) < 18 && world.random() < 0.28;
    if (deflectsForCorner) return scheduleRestart(world, "corner", pending.team, { x: ownGoal.x, y: world.ball.y < ownGoal.y ? 0 : pitch.width });
    if (blockerDepth <= 20 && world.random() < defending.scrambleAfterBlockChance) {
      world.ball.state = 'loose';
      world.ball.controllerKey = null;
      world.ball.vx = directionOf(defendingTeam, world.period) * (2 + world.random() * 3);
      world.ball.vy = (world.random() - 0.5) * 5;
      world.ball.lastTouchPlayerId = blocker.id;
      world.ball.lastTouchTeamId = blocker.team;
      world.ball.lastTouchType = 'blocked_shot_rebound';
      world.possessionTeam = null;
      world.reboundWindow = { attackingTeam: pending.team, untilTick: world.tick + Math.ceil(3 / DT) };
      return;
    }
    return startClearance(world, blocker, 'blocked_shot_clearance');
  }
  const goal = attackingGoal(pending.team, world.period);
  const shotDirection = directionOf(pending.team, world.period);
  const reachedGoalLine = shotDirection > 0 ? world.ball.x >= goal.x : world.ball.x <= goal.x;
  if (world.tick < pending.arrivalTick && !reachedGoalLine) return;
  if (pending.woodwork) {
    world.ball.x = goal.x - shotDirection * ballConfig.goalLineSafetyMargin;
    world.ball.y = pending.targetPoint.y;
    return finishShot(world, "woodwork");
  }
  if (!pending.onTarget) {
    world.ball.x = goal.x - shotDirection * ballConfig.goalLineSafetyMargin;
    world.ball.y = clamp(pending.targetPoint.y, 0, pitch.width);
    return finishShot(world, "off_target");
  }
  const goalkeeper = teamPlayers(world, defendingTeam).find((player) => player.position === "GK");
  if (!pending.goalIntent) {
    const handling = mean([goalkeeper.abilities.handling, goalkeeper.abilities.composure, goalkeeper.abilities.goalkeeping]) / 100;
    const power = clamp((pending.shotDistance - 8) / 30 + (1 - handling) * 0.35, 0, 1);
    const catchChance = clamp(goalkeeping.catchBaseChance + handling * 0.48 - power * 0.42, 0.12, 0.82);
    const caught = world.random() < catchChance;
    const cornerParry = !caught && world.random() < clamp(goalkeeping.cornerParryBaseChance + power * 0.28, 0.12, 0.55);
    pending.saveType = caught ? "caught" : cornerParry ? "parried_corner" : "parried";
    const contact = {
      x: pending.targetPoint.x,
      y: clamp(pending.targetPoint.y, 1, pitch.width - 1)
    };
    world.ball.x = contact.x;
    world.ball.y = contact.y;
    goalkeeper.x = contact.x;
    goalkeeper.y = contact.y;
    goalkeeper.vx = 0;
    goalkeeper.vy = 0;
    goalkeeper.targetX = contact.x;
    goalkeeper.targetY = contact.y;
    goalkeeper.movementIntent = "goalkeeper_dive";
    return finishShot(world, "saved", goalkeeper);
  }
  return finishShot(world, "goal");
}

function updateGoalPause(world) {
  if (!world.goalPause) return false;
  if (world.tick < world.goalPause.readyTick) return true;
  const kickoffTeam = world.goalPause.team;
  const restart = world.goalPause.restart;
  world.goalPause = null;
  if (restart) {
    scheduleRestart(world, restart.type, restart.team, restart.point);
    world.discontinuity = "offside_restart_setup";
    return false;
  }
  placeKickoff(world, kickoffTeam, "goal_restart_setup");
  return false;
}

function resolveControlledChallenge(world) {
  if (world.ball.state !== "controlled" || world.restart) return;
  if (world.ball.lastTouchType === "kickoff") return;
  const controller = playerByKey(world, world.ball.controllerKey);
  if (!controller) return;
  const defendingTeam = world.teams[otherTeam(controller.team)];
  if (world.matchTime < defendingTeam.nextChallengeAt) return;
  const opponent = closestPlayers(
    teamPlayers(world, otherTeam(controller.team)),
    controller,
    (player) => player.position !== "GK"
      && ["press_ball", "support_press"].includes(player.movementIntent)
      && world.matchTime >= player.nextChallengeAt
  )[0];
  if (!opponent || distance(opponent, controller) > 0.95) return;
  opponent.nextChallengeAt = world.matchTime + 4;
  defendingTeam.nextChallengeAt = world.matchTime + 30;
  const defenderQuality = mean([opponent.abilities.tackling, opponent.abilities.anticipation, opponent.abilities.strength]);
  const attackerQuality = mean([controller.abilities.dribbling, controller.abilities.composure, controller.abilities.strength]);
  const foulChance = clamp(
    discipline.minimumFoulChance
      + Math.max(0, attackerQuality - defenderQuality) / 520
      + (100 - opponent.abilities.discipline) / 700
      + pressureAt(world, controller) * 0.025,
    discipline.minimumFoulChance,
    discipline.maximumFoulChance
  );
  if (world.random() < foulChance) {
    const point = { x: world.ball.x, y: world.ball.y };
    const attackingDepth = relativeX(controller.team, world.period, point.x);
    const inPenaltyArea = attackingDepth >= attacking.penaltyBoxEntryDepth
      && Math.abs(point.y - pitch.width / 2) <= 20.16;
    world.teams[opponent.team].stats.fouls += 1;
    opponent.stats.fouls += 1;
    defendingTeam.nextChallengeAt = world.matchTime + discipline.teamChallengeCooldownAfterFoul;
    recordAction(world, {
      type: "foul",
      technique: inPenaltyArea ? "penalty_foul" : "direct_free_kick_foul",
      outcome: "committed",
      team: opponent.team,
      actorId: opponent.id,
      opponentId: controller.id,
      startPosition: point,
      endPosition: point,
      statsDelta: { fouls: 1 }
    });
    const restartPoint = inPenaltyArea
      ? { x: worldX(controller.team, world.period, pitch.length - setPieces.penaltySpotDistance), y: pitch.width / 2 }
      : point;
    scheduleRestart(world, inPenaltyArea ? "penalty" : "free_kick", controller.team, restartPoint);
    return;
  }
  const successChance = clamp(0.255 + (defenderQuality - attackerQuality) / 240, 0.12, 0.44);
  if (world.random() >= successChance) return;
  const start = { x: controller.x, y: controller.y };
  world.teams[opponent.team].stats.tackles += 1;
  opponent.stats.tackles += 1;
  controller.stats.dispossessions += 1;
  recordAction(world, {
    type: "tackle",
    technique: "standing_tackle",
    outcome: "won",
    team: opponent.team,
    actorId: opponent.id,
    opponentId: controller.id,
    startPosition: start,
    endPosition: { x: world.ball.x, y: world.ball.y },
    pressure: 1,
    statsDelta: { tackles: 1 }
  });
  takeControl(world, opponent, "tackle");
  if (relativeX(opponent.team, world.period, opponent.x) >= 70) {
    world.turnoverWindow = {
      playerKey: opponent.key,
      untilTick: world.tick + Math.ceil(2.4 / DT)
    };
    opponent.nextActionAt = world.matchTime;
  }
}

function updateBallFlight(world) {
  if (!["rolling", "shot", "loose"].includes(world.ball.state)) return;
  world.ball.x += world.ball.vx * DT;
  world.ball.y += world.ball.vy * DT;
  world.ball.z = Math.max(0, world.ball.z + world.ball.vz * DT);
  if (world.pendingAction?.kind === "pass") resolvePassFlight(world);
  else if (world.pendingAction?.kind === "shot") resolveShotFlight(world);
  else if (world.pendingAction?.kind === "disallowed_shot") resolveDisallowedShotFlight(world);
  else if (world.pendingAction?.kind === 'clearance') resolveClearanceFlight(world);
  else if (world.ball.state === "loose") {
    const speed = magnitude({ x: world.ball.vx, y: world.ball.vy });
    const nextSpeed = Math.max(0, speed - ballConfig.friction * DT);
    if (speed > EPSILON) {
      world.ball.vx = world.ball.vx / speed * nextSpeed;
      world.ball.vy = world.ball.vy / speed * nextSpeed;
    }
    const nearest = closestPlayers(world.players, world.ball)[0];
    if (nearest && distance(nearest, world.ball) <= ballConfig.controlRadius) takeControl(world, nearest, "loose_ball_recovery");
  }
  if (!world.pendingAction && world.ball.state !== "controlled" && world.ball.state !== "dead") {
    const outTouch = world.ball.y < 0 || world.ball.y > pitch.width;
    const outGoal = world.ball.x < 0 || world.ball.x > pitch.length;
    if (outTouch) {
      const team = otherTeam(world.ball.lastTouchTeamId);
      scheduleRestart(world, "throw_in", team, { x: clamp(world.ball.x, 0, pitch.length), y: clamp(world.ball.y, 0, pitch.width) });
    } else if (outGoal) {
      const defending = world.ball.x < pitch.length / 2
        ? (directionOf("home", world.period) > 0 ? "home" : "away")
        : (directionOf("home", world.period) > 0 ? "away" : "home");
      const type = world.ball.lastTouchTeamId === defending ? "corner" : "goal_kick";
      scheduleRestart(world, type, type === "corner" ? otherTeam(defending) : defending, {
        x: world.ball.x < 0 ? 0 : pitch.length,
        y: world.ball.y < pitch.width / 2 ? 0 : pitch.width
      });
    }
  }
}

function updateRestart(world) {
  if (!world.restart) return;
  const restart = world.restart;
  const taker = playerByKey(world, restart.takerKey);
  const runupPoint = restart.type === "penalty"
    ? { x: restart.point.x - directionOf(restart.team, world.period) * 3.2, y: restart.point.y }
    : restart.point;
  const ready = world.tick >= restart.readyTick
    && distance(taker, restart.runupStarted ? restart.point : runupPoint) <= 1.6
    && restartShapeReady(world, restart, taker);
  if (restart.type === "penalty") {
    if (!restart.runupStarted) {
      if (!ready && world.tick < restart.latestTick) return;
      if (!ready) {
        taker.x = clamp(runupPoint.x, movement.boundaryPadding, pitch.length - movement.boundaryPadding);
        taker.y = runupPoint.y;
        taker.vx = 0;
        taker.vy = 0;
        world.discontinuity = "penalty_setup";
      }
      restart.runupStarted = true;
      restart.strikeTick = world.tick + Math.ceil(0.9 / DT);
      return;
    }
    if (world.tick < restart.strikeTick) return;
    taker.x = clamp(restart.point.x - directionOf(restart.team, world.period) * 0.25, movement.boundaryPadding, pitch.length - movement.boundaryPadding);
    taker.y = restart.point.y;
    taker.vx = 0;
    taker.vy = 0;
  } else if (!ready && world.tick < restart.latestTick) return;
  if (!ready && restart.type !== "penalty") {
    taker.x = clamp(restart.point.x - directionOf(restart.team, world.period) * 0.4, movement.boundaryPadding, pitch.length - movement.boundaryPadding);
    taker.y = clamp(restart.point.y, movement.boundaryPadding, pitch.width - movement.boundaryPadding);
    taker.vx = 0;
    taker.vy = 0;
    world.discontinuity = "restart_setup";
  }
  world.restart = null;
  world.ball.x = restart.point.x;
  world.ball.y = restart.point.y;
  world.ball.state = "controlled";
  world.ball.controllerKey = taker.key;
  world.ball.lastTouchPlayerId = taker.id;
  world.ball.lastTouchTeamId = restart.team;
  world.ball.lastTouchType = restart.type;
  world.possessionTeam = restart.team;
  world.possessionId += 1;
  world.phaseSince = world.tick;
  taker.nextActionAt = world.matchTime + 0.25;
  recordAction(world, {
    type: restart.type,
    outcome: "complete",
    team: restart.team,
    actorId: taker.id,
    startPosition: restart.point,
    endPosition: restart.point,
    statsDelta: restart.type === "corner" ? { corners: 1 } : {}
  });
  if (restart.type === "corner") world.teams[restart.team].stats.corners += 1;
  if (restart.type === 'corner') {
    takeControl(world, taker, 'corner_setup', { immediate: true });
    startRestartDelivery(world, restart, taker, 'corner_cross');
    return;
  }
  if (restart.type === "penalty") {
    takeControl(world, taker, "penalty_setup", { immediate: true });
    const pressure = 0;
    const opportunity = evaluateShotOpportunity(world, taker, pressure);
    startShot(world, taker, opportunity, { isPenalty: true, technique: "penalty_kick" });
    return;
  }
  if (restart.type === "free_kick") {
    const goal = attackingGoal(restart.team, world.period);
    const shotDistance = distance(restart.point, goal);
    const central = Math.abs(restart.point.y - goal.y) <= 22;
    const freeKickQuality = mean([taker.abilities.technique, taker.abilities.longShots, taker.abilities.composure]) / 100;
    const directChance = clamp(0.08 + freeKickQuality * 0.28 - Math.max(0, shotDistance - 20) * 0.012, 0.04, 0.34);
    if (shotDistance <= setPieces.directFreeKickMaximumDistance && central && world.random() < directChance) {
      takeControl(world, taker, "free_kick_setup", { immediate: true });
      const opportunity = evaluateShotOpportunity(world, taker, 0.12);
      startShot(world, taker, opportunity, { technique: "direct_free_kick" });
      return;
    }
    takeControl(world, taker, 'free_kick_setup', { immediate: true });
    startRestartDelivery(world, restart, taker, 'free_kick_delivery');
  }
}

function auditSwarm(world, sampledTicks = 1) {
  const nearby = world.players.filter((player) => distance(player, world.ball) < auditConfig.swarmRadius && player.position !== "GK").length;
  const penaltyAreaContest = ["home", "away"].some((team) => relativeX(team, world.period, world.ball.x) <= defending.penaltyThreatDepth + 2);
  if (!penaltyAreaContest && nearby > auditConfig.swarmMaximumPlayers) {
    world.audit.swarmTicks += sampledTicks;
    world.audit.currentSwarmTicks += sampledTicks;
    world.audit.longestSwarmTicks = Math.max(world.audit.longestSwarmTicks, world.audit.currentSwarmTicks);
  } else {
    world.audit.currentSwarmTicks = 0;
  }
  for (const team of ["home", "away"]) {
    const players = teamPlayers(world, team).filter((player) => player.position !== "GK");
    const emergencyBoxDefense = world.possessionTeam === otherTeam(team)
      && relativeX(team, world.period, world.ball.x) <= defending.emergencyRecoveryDepth;
    const crowded = !world.restart && !emergencyBoxDefense
      && players.some((player) => {
        const nearby = players.filter((other) => distance(player, other) < auditConfig.sameTeamCrowdRadius);
        if (nearby.length <= auditConfig.sameTeamCrowdMaximumPlayers) return false;
        const converging = nearby.filter((other) => Math.hypot(player.targetX - other.targetX, player.targetY - other.targetY) < auditConfig.sameTeamCrowdRadius);
        return converging.length > auditConfig.sameTeamCrowdMaximumPlayers;
      });
    if (crowded) {
      world.audit.crowdTicks[team] += sampledTicks;
      world.audit.currentCrowdTicks[team] += sampledTicks;
      world.audit.longestCrowdTicks[team] = Math.max(world.audit.longestCrowdTicks[team], world.audit.currentCrowdTicks[team]);
    } else {
      world.audit.currentCrowdTicks[team] = 0;
    }
  }
}

function snapshot(world) {
  if (!world.captureSnapshots) {
    world.discontinuity = null;
    return;
  }
  const interval = Math.max(1, Math.round(clock.tickRate / clock.auditSnapshotRate));
  if (world.tick % interval !== 0 && !world.discontinuity) return;
  world.snapshots.push({
    tick: world.tick,
    matchTime: round(world.matchTime, 2),
    period: world.period,
    discontinuity: world.discontinuity,
    possessionId: world.possessionId,
    possessionTeam: world.possessionTeam,
    phases: { ...world.phases },
    ball: {
      x: round(world.ball.x),
      y: round(world.ball.y),
      z: round(world.ball.z),
      vx: round(world.ball.vx),
      vy: round(world.ball.vy),
      state: world.ball.state,
      controllerKey: world.ball.controllerKey
    },
    players: world.players.map((player) => ({
      id: player.id,
      team: player.team,
      position: player.position,
      x: round(player.x),
      y: round(player.y),
      vx: round(player.vx),
      vy: round(player.vy),
      intent: player.movementIntent,
      markingTarget: player.markingTarget,
      defensiveAwareness: round(defensiveAwareness(player)),
      targetX: round(player.targetX),
      targetY: round(player.targetY)
    }))
  });
  world.discontinuity = null;
}

function advancePeriodIfNeeded(world) {
  if (world.period === 1 && world.matchTime >= clock.halfDuration) {
    if (world.pendingAction?.kind === "pass") finishPass(world, null, "incomplete");
    else if (world.pendingAction?.kind === "shot") finishShot(world, "off_target");
    else if (world.pendingAction?.kind === "disallowed_shot") {
      world.pendingAction.arrivalTick = world.tick;
      resolveDisallowedShotFlight(world);
      world.goalPause = null;
    }
    else if (world.pendingAction?.kind === 'clearance') world.pendingAction = null;
    world.period = 2;
    world.halftime = { tick: world.tick, matchTime: world.matchTime, directions: { home: -1, away: 1 } };
    recordAction(world, { type: "halftime", outcome: "complete", team: null });
    placeKickoff(world, "away", "halftime_setup");
  }
}

function stepWorld(world) {
  if (updateGoalPause(world)) {
    snapshot(world);
    world.tick += 1;
    world.matchTime = world.tick * DT;
    return;
  }
  advancePeriodIfNeeded(world);
  if (world.tick % Math.max(1, Math.round(clock.decisionInterval * clock.tickRate)) === 0 || world.discontinuity) {
    updatePhases(world);
    updateMovementIntents(world);
  }
  updateRestart(world);
  decideControllerAction(world);
  movePlayers(world);
  resolveControlledChallenge(world);
  updateBallFlight(world);
  if (world.ball.state === "controlled" && world.possessionTeam) world.teams[world.possessionTeam].stats.possessionTicks += 1;
  const auditInterval = Math.max(1, Math.round(clock.tickRate / clock.auditSnapshotRate));
  if (world.tick % auditInterval === 0) auditSwarm(world, auditInterval);
  snapshot(world);
  world.tick += 1;
  world.matchTime = world.tick * DT;
}

function publicStats(team, totalPossessionTicks) {
  return {
    possession: totalPossessionTicks ? round(team.stats.possessionTicks / totalPossessionTicks * 100, 1) : 50,
    passes: team.stats.passes,
    completedPasses: team.stats.completedPasses,
    shots: team.stats.shots,
    shotsOnTarget: team.stats.shotsOnTarget,
    xg: round(team.stats.xg, 2),
    goals: team.stats.goals,
    tackles: team.stats.tackles,
    interceptions: team.stats.interceptions,
    clearances: team.stats.clearances,
    saves: team.stats.saves,
    offsides: team.stats.offsides,
    corners: team.stats.corners,
    fouls: team.stats.fouls
  };
}

function publicTeamPlayers(team) {
  return team.players.map((player) => ({
    id: player.id,
    name: player.name,
    position: player.position,
    form: {
      label: player.form.label,
      tone: player.form.value < 0 ? "down" : player.form.value > 0 ? "up" : "normal"
    },
    maxSpeed: round(player.maxSpeed, 2),
    maxAcceleration: round(player.maxAcceleration, 2),
    penaltyTaking: round(player.abilities.penaltyTaking, 1),
    composure: round(player.abilities.composure, 1),
    goalkeeping: round(player.abilities.goalkeeping, 1),
    reflexes: round(player.abilities.reflexes, 1),
    stats: { ...player.stats, xg: round(player.stats.xg, 2) }
  }));
}

function footballShapeMetrics(result) {
  const metrics = {
    attackingSamples: 0,
    fullbackAdvanceSamples: 0,
    restDefenseSamples: 0,
    lowBlockSamples: 0,
    counterOutletSamples: 0,
    allOutfieldOwnHalfSamples: 0,
    goalkeeperClaimRetreatSamples: 0
  };
  for (const frame of result.snapshots) {
    for (const team of ['home', 'away']) {
      const players = frame.players.filter((player) => player.team === team && player.position !== 'GK');
      const depth = (x) => relativeX(team, frame.period, x);
      if (frame.possessionTeam === team && ['progression', 'final_third'].includes(frame.phases[team])) {
        const ballDepth = depth(frame.ball.x);
        if (ballDepth >= 55) {
          metrics.attackingSamples += 1;
          const fullbackAdvanced = players.some((player) => FULLBACKS.has(player.position) && player.intent === 'overlap_run');
          if (fullbackAdvanced) metrics.fullbackAdvanceSamples += 1;
          const restDefenders = players.filter((player) => ['CB', 'CDM'].includes(player.position) && depth(player.x) <= ballDepth - 16);
          if (restDefenders.length >= 2) metrics.restDefenseSamples += 1;
        }
      }
      if (frame.possessionTeam === otherTeam(team) && frame.phases[team] === 'low_block') {
        metrics.lowBlockSamples += 1;
        const hasOutlet = players.some((player) => player.intent === 'counter_outlet'
          && depth(player.x) >= footballPrinciples.minimumCounterOutletDepth - 3);
        if (hasOutlet) metrics.counterOutletSamples += 1;
        if (players.every((player) => depth(player.x) < pitch.length / 2)) metrics.allOutfieldOwnHalfSamples += 1;
      }
      if (players.some((player) => player.intent === 'retreat_after_keeper_claim')) metrics.goalkeeperClaimRetreatSamples += 1;
    }
  }
  return {
    ...metrics,
    fullbackAdvanceRate: metrics.attackingSamples ? round(metrics.fullbackAdvanceSamples / metrics.attackingSamples, 3) : null,
    restDefenseRate: metrics.attackingSamples ? round(metrics.restDefenseSamples / metrics.attackingSamples, 3) : null,
    counterOutletRate: metrics.lowBlockSamples ? round(metrics.counterOutletSamples / metrics.lowBlockSamples, 3) : null,
    allOutfieldOwnHalfRate: metrics.lowBlockSamples ? round(metrics.allOutfieldOwnHalfSamples / metrics.lowBlockSamples, 3) : null
  };
}

export function validateContinuousMatch(result) {
  const errors = [];
  const warnings = [];
  if (result.audit.movementViolations.length) errors.push(`movement violations: ${result.audit.movementViolations.length}`);
  if (result.audit.boundsViolations.length) errors.push(`bounds violations: ${result.audit.boundsViolations.length}`);
  if (result.audit.possessionViolations.length) errors.push(`possession violations: ${result.audit.possessionViolations.length}`);
  if (!result.halftime || result.halftime.directions.home !== -1 || result.halftime.directions.away !== 1) errors.push("halftime direction swap missing");
  for (const team of ["home", "away"]) {
    const passes = result.actions.filter((action) => action.team === team && action.type === "pass");
    const completed = passes.filter((action) => action.outcome === "complete");
    const shots = result.actions.filter((action) => action.team === team && action.type === "shot");
    const goals = shots.filter((action) => action.outcome === "goal" || action.outcome === 'own_goal');
    const clearances = result.actions.filter((action) => action.team === team && action.type === 'clearance');
    if (passes.length !== result.stats[team].passes) errors.push(`${team} pass ledger mismatch: actions=${passes.length}, stats=${result.stats[team].passes}`);
    if (completed.length !== result.stats[team].completedPasses) errors.push(`${team} completed pass ledger mismatch: actions=${completed.length}, stats=${result.stats[team].completedPasses}`);
    if (shots.length !== result.stats[team].shots) errors.push(`${team} shot ledger mismatch: actions=${shots.length}, stats=${result.stats[team].shots}`);
    if (goals.length !== result.score[team]) errors.push(`${team} goal ledger mismatch: actions=${goals.length}, score=${result.score[team]}`);
    if (clearances.length !== result.stats[team].clearances) errors.push(`${team} clearance ledger mismatch: actions=${clearances.length}, stats=${result.stats[team].clearances}`);
    if (shots.some((shot) => shot.startPosition && distance(shot.startPosition, attackingGoal(team, shot.period)) > decision.absoluteShotDistance + 0.01)) {
      errors.push(`${team} contains shot beyond absolute distance`);
    }
    if (result.stats[team].completedPasses > result.stats[team].passes) errors.push(`${team} completed passes exceed attempts`);
    if (result.stats[team].shotsOnTarget > result.stats[team].shots) errors.push(`${team} shots on target exceed shots`);
    const corners = result.actions.filter((action) => action.team === team && action.type === 'corner').length;
    const cornerDeliveries = result.actions.filter((action) => action.team === team && action.type === 'pass' && action.technique === 'corner_cross').length;
    if (corners !== result.stats[team].corners) errors.push(`${team} corner ledger mismatch: actions=${corners}, stats=${result.stats[team].corners}`);
    if (cornerDeliveries < Math.max(0, corners - 1)) errors.push(`${team} corner delivery missing: corners=${corners}, deliveries=${cornerDeliveries}`);
  }
  const longestSwarmSeconds = result.audit.longestSwarmTicks * DT;
  if (longestSwarmSeconds > auditConfig.swarmMaximumDuration) errors.push(`swarm persisted for ${round(longestSwarmSeconds, 2)} seconds`);
  for (const team of ["home", "away"]) {
    const longestCrowdSeconds = result.audit.longestCrowdTicks[team] * DT;
    if (longestCrowdSeconds > auditConfig.sameTeamCrowdMaximumDuration) errors.push(`${team} same-team crowd persisted for ${round(longestCrowdSeconds, 2)} seconds`);
  }
  const totalPossession = result.stats.home.possession + result.stats.away.possession;
  if (Math.abs(totalPossession - 100) > 1) warnings.push(`rounded possession totals ${totalPossession}`);
  const shape = footballShapeMetrics(result);
  // These are distribution-level realism targets, not ledger or movement-corruption failures.
  // Keep enforcing them in the deterministic engine gates without randomly aborting a valid live match.
  if (shape.attackingSamples >= 20 && shape.fullbackAdvanceRate < 0.03) warnings.push(`fullbacks rarely provide meaningful attacking depth: rate=${shape.fullbackAdvanceRate}`);
  if (shape.attackingSamples >= 20 && shape.restDefenseRate < 0.72) warnings.push(`rest-defense structure breaks too often: rate=${shape.restDefenseRate}`);
  if (shape.lowBlockSamples >= 20 && shape.counterOutletRate < 0.62) warnings.push(`defending side abandons counter outlet too often: rate=${shape.counterOutletRate}`);
  if (shape.lowBlockSamples >= 20 && shape.allOutfieldOwnHalfRate > 0.38) warnings.push(`all outfield players collapse into own half too often: rate=${shape.allOutfieldOwnHalfRate}`);
  return {
    passed: errors.length === 0,
    errors,
    warnings,
    metrics: {
      actionCount: result.actions.length,
      snapshotCount: result.snapshots.length,
      maximumObservedSpeed: result.audit.maximumObservedSpeed,
      maximumObservedStep: result.audit.maximumObservedStep,
      longestSwarmSeconds: round(longestSwarmSeconds, 2),
      longestCrowdSeconds: {
        home: round(result.audit.longestCrowdTicks.home * DT, 2),
        away: round(result.audit.longestCrowdTicks.away * DT, 2)
      },
      footballShape: shape
    }
  };
}

export function simulateContinuousMatch(homeSide, awaySide, seed = crypto.randomUUID(), options = {}) {
  const world = createWorld(homeSide, awaySide, seed);
  world.captureSnapshots = options.captureSnapshots !== false;
  const duration = numeric(options.durationSeconds, clock.halfDuration * 2);
  const totalTicks = Math.round(duration * clock.tickRate);
  while (world.tick < totalTicks) stepWorld(world);
  if (world.pendingAction?.kind === "pass") finishPass(world, null, "incomplete");
  else if (world.pendingAction?.kind === "shot") finishShot(world, "off_target");
  else if (world.pendingAction?.kind === "disallowed_shot") {
    world.pendingAction.arrivalTick = world.tick;
    resolveDisallowedShotFlight(world);
  }
  else if (world.pendingAction?.kind === 'clearance') world.pendingAction = null;
  recordAction(world, { type: "full_time", outcome: "complete", team: null });
  const totalPossessionTicks = world.teams.home.stats.possessionTicks + world.teams.away.stats.possessionTicks;
  const result = {
    version: world.version,
    engine: world.engine,
    configVersion: world.configVersion,
    seed: world.seed,
    durationSeconds: duration,
    score: { home: world.teams.home.stats.goals, away: world.teams.away.stats.goals },
    teams: {
      home: { id: "home", name: world.teams.home.name, formationId: world.teams.home.formationId, tacticId: world.teams.home.tacticId, players: publicTeamPlayers(world.teams.home) },
      away: { id: "away", name: world.teams.away.name, formationId: world.teams.away.formationId, tacticId: world.teams.away.tacticId, players: publicTeamPlayers(world.teams.away) }
    },
    stats: {
      home: publicStats(world.teams.home, totalPossessionTicks),
      away: publicStats(world.teams.away, totalPossessionTicks)
    },
    actions: world.actions,
    snapshots: world.snapshots,
    halftime: world.halftime,
    audit: {
      ...world.audit,
      maximumObservedSpeed: round(world.audit.maximumObservedSpeed, 3),
      maximumObservedStep: round(world.audit.maximumObservedStep, 3)
    }
  };
  result.invariantReport = validateContinuousMatch(result);
  return result;
}
