import crypto from "node:crypto";
import { initiateGame, playIteration, startSecondHalf } from "footballsim";
import { setMatchSeed } from "footballsim/lib/common.js";
import {
  balance,
  gameplay,
  enginePlayers,
  publicPlayers,
  formations,
  clamp,
  mean,
  positionMultiplier
} from "./context.mjs";

const PITCH = { width: 680, height: 1050, goalWidth: 90 };
const REGULATION_TICKS = 6000;
const EXTRA_TIME_TICKS = 1800;
const outfieldGroups = gameplay.playerAttributeGroups.outfield;
const goalkeeperGroups = gameplay.playerAttributeGroups.goalkeeper;
const attributeScale = gameplay.playerAttributeGroups.attributePointScale;

const round2 = (value) => Math.round(Number(value) * 100) / 100;
const numeric = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const hashSeed = (seed) => Number.parseInt(crypto.createHash("sha256").update(String(seed)).digest("hex").slice(0, 8), 16) >>> 0;
const keyOf = (team, playerId) => `${team}:${playerId}`;
const otherTeam = (team) => team === "home" ? "away" : "home";
const attribute = (player, name, fallback = 10) => numeric(player.fmAttributes?.[name], fallback);
const attributeRating = (player, names) => mean(names.map((name) => attribute(player, name))) * attributeScale;

function seededRandom(seed) {
  let state = hashSeed(seed);
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

function sampleForm(random) {
  let roll = random() * 100;
  for (const tier of balance.formState.tiers) {
    roll -= numeric(tier.probabilityPct);
    if (roll <= 0) return tier;
  }
  return balance.formState.tiers.at(-1);
}

function formationCoordinates(formation) {
  const rows = new Map();
  formation.slots.forEach((position, index) => {
    let x = 47;
    if (position === "GK") x = 7;
    else if (["LB", "LWB", "CB", "RB", "RWB"].includes(position)) x = 19;
    else if (position === "CDM") x = 29;
    else if (["CM", "LM", "RM"].includes(position)) x = 35;
    else if (position === "CAM") x = 42;
    if (!rows.has(x)) rows.set(x, []);
    rows.get(x).push(index);
  });
  const coordinates = [];
  const rank = (position) => ({ LB: 0, LWB: 0, LM: 0, LW: 0, CB: 1, CDM: 1, CM: 1, CAM: 1, ST: 1, RB: 2, RWB: 2, RM: 2, RW: 2 }[position] ?? 1);
  for (const [x, indexes] of rows) {
    const ordered = [...indexes].sort((left, right) => rank(formation.slots[left]) - rank(formation.slots[right]));
    ordered.forEach((slotIndex, index) => {
      coordinates[slotIndex] = { x, y: ordered.length === 1 ? 50 : 15 + index * (70 / (ordered.length - 1)) };
    });
  }
  return coordinates;
}

function playerProfile(enginePlayer, publicPlayer, position, form, chemistryBonusPct) {
  const goalkeeper = position === "GK";
  const familiarity = positionMultiplier(publicPlayer, position) || 0.85;
  const condition = 1 + (numeric(form.abilityModifierPct) + numeric(chemistryBonusPct)) / 100;
  const profile = goalkeeper ? {
    passing: attributeRating(enginePlayer, goalkeeperGroups.distribution),
    shooting: 8,
    tackling: 18,
    saving: attributeRating(enginePlayer, goalkeeperGroups.keeping),
    agility: attributeRating(enginePlayer, goalkeeperGroups.physical),
    strength: attributeRating(enginePlayer, goalkeeperGroups.physical),
    penalty: attribute(enginePlayer, "点球", 10) * attributeScale,
    jumping: attribute(enginePlayer, "制空", 10) * attributeScale
  } : {
    passing: mean([attributeRating(enginePlayer, outfieldGroups.creation), attribute(enginePlayer, "传球") * attributeScale]),
    shooting: mean([attributeRating(enginePlayer, outfieldGroups.attack), attribute(enginePlayer, "射门") * attributeScale]),
    tackling: mean([attributeRating(enginePlayer, outfieldGroups.defense), attribute(enginePlayer, "抢断") * attributeScale]),
    saving: 8,
    agility: mean([attributeRating(enginePlayer, outfieldGroups.physical), attribute(enginePlayer, "灵活") * attributeScale]),
    strength: attributeRating(enginePlayer, outfieldGroups.physical),
    penalty: attribute(enginePlayer, "点球", attribute(enginePlayer, "射门")) * attributeScale,
    jumping: attribute(enginePlayer, "弹跳", attribute(enginePlayer, "强壮")) * attributeScale
  };
  for (const name of Object.keys(profile)) profile[name] = clamp(profile[name] * familiarity * condition, 5, 99);
  return profile;
}

function prepareTeam(side, teamId, random) {
  const formation = formations.get(side.formationId);
  const coordinates = formationCoordinates(formation);
  const chemistry = side.chemistry?.players ?? {};
  const players = side.lineup.starters.map((starter, index) => {
    const source = enginePlayers.get(String(starter.playerId));
    const publicPlayer = publicPlayers.get(String(starter.playerId));
    const form = sampleForm(random);
    const profile = playerProfile(source, publicPlayer, starter.position, form, chemistry[starter.playerId]?.bonusPct);
    const base = coordinates[index];
    return {
      id: String(starter.playerId),
      name: publicPlayer.name,
      shortName: publicPlayer.name.split(" ").at(-1).slice(0, 12),
      position: starter.position,
      base,
      profile,
      form: form.value,
      engine: {
        _appId: String(starter.playerId),
        name: publicPlayer.name,
        shirtNumber: index + 1,
        position: starter.position,
        rating: String(Math.round(mean(Object.values(profile)))),
        skill: {
          passing: Math.round(profile.passing),
          shooting: Math.round(profile.shooting),
          tackling: Math.round(profile.tackling),
          saving: Math.round(profile.saving),
          agility: Math.round(profile.agility),
          strength: Math.round(profile.strength),
          penalty_taking: Math.round(profile.penalty),
          jumping: Math.round(profile.jumping)
        },
        currentPOS: [Math.round(base.y / 100 * PITCH.width), Math.round(base.x / 100 * PITCH.height)],
        fitness: 100,
        injured: false
      }
    };
  });
  return {
    id: teamId,
    name: side.displayName,
    formationId: side.formationId,
    tacticId: side.lineup.tacticId,
    players,
    engine: {
      name: side.displayName,
      description: side.formationId,
      primaryColour: teamId === "home" ? "#3787ff" : "#f2a62b",
      secondaryColour: "#ffffff",
      awayColour: "#111111",
      rating: Math.round(mean(players.map((player) => mean(Object.values(player.profile))))),
      // footballsim expects GK first and its kick-off logic uses indexes 9/10 as the two furthest attackers.
      // The UI formation keeps its own slot order, so only the engine copy is sorted from goal to attack.
      players: [...players].sort((left, right) => left.base.x - right.base.x || left.base.y - right.base.y).map((player) => player.engine)
    }
  };
}

function enginePlayerEntries(matchDetails) {
  return [
    ...matchDetails.kickOffTeam.players.map((player) => ({ team: "home", player })),
    ...matchDetails.secondTeam.players.map((player) => ({ team: "away", player }))
  ];
}

function appPlayerId(player) {
  return String(player._appId ?? player.playerID);
}

function uiPoint(position) {
  const [engineX, engineY] = position;
  return {
    x: round2(clamp(numeric(engineY) / PITCH.height * 100, 0.5, 99.5)),
    y: round2(clamp(numeric(engineX) / PITCH.width * 100, 1, 99))
  };
}

function ballPoint(matchDetails) {
  return uiPoint(matchDetails.ball.position);
}

function playerPoint(state, team, playerId) {
  const entry = enginePlayerEntries(state.matchDetails).find(({ team: entryTeam, player }) => entryTeam === team && appPlayerId(player) === String(playerId));
  return entry && entry.player.currentPOS[0] !== "NP" ? uiPoint(entry.player.currentPOS) : ballPoint(state.matchDetails);
}

function initialTeamStats() {
  return { possessionWeight: 0, passes: 0, completedPasses: 0, shots: 0, shotsOnTarget: 0, xg: 0, corners: 0, goals: 0, tackles: 0, interceptions: 0, clearances: 0, saves: 0, fouls: 0, offsides: 0 };
}

function initialPlayerStats(player, team) {
  return { playerId: player.id, name: player.name, position: player.position, team, minutes: 90, goals: 0, assists: 0, shots: 0, shotsOnTarget: 0, xg: 0, passes: 0, completedPasses: 0, keyPasses: 0, tackles: 0, interceptions: 0, clearances: 0, saves: 0, fouls: 0, dispossessions: 0 };
}

function engineCounterSnapshot(matchDetails) {
  const players = new Map();
  for (const { team, player } of enginePlayerEntries(matchDetails)) {
    players.set(keyOf(team, appPlayerId(player)), {
      goals: numeric(player.stats.goals),
      shots: numeric(player.stats.shots?.total),
      shotsOnTarget: numeric(player.stats.shots?.on),
      passes: numeric(player.stats.passes?.total),
      completedPasses: numeric(player.stats.passes?.on),
      tackles: numeric(player.stats.tackles?.total),
      tacklesWon: numeric(player.stats.tackles?.on),
      fouls: numeric(player.stats.tackles?.fouls),
      saves: numeric(player.stats.saves)
    });
  }
  return { players };
}

function possessionOwner(matchDetails) {
  if (!matchDetails.ball.withPlayer || matchDetails.ball.Player === "") return null;
  for (const { team, player } of enginePlayerEntries(matchDetails)) {
    if (String(player.playerID) === String(matchDetails.ball.Player)) return { team, playerId: appPlayerId(player), name: player.name };
  }
  return null;
}

function teamPlayer(matchState, team, playerId) {
  return matchState.teams[team].players.find((player) => player.id === String(playerId));
}

function playerByName(matchState, name, preferredTeam = null) {
  const teams = preferredTeam ? [preferredTeam, otherTeam(preferredTeam)] : ["home", "away"];
  for (const team of teams) {
    const player = matchState.teams[team].players.find((item) => item.name === name);
    if (player) return { team, player };
  }
  return null;
}

function statsSnapshot(state) {
  return {
    home: { ...state.stats.home, xg: round2(state.stats.home.xg) },
    away: { ...state.stats.away, xg: round2(state.stats.away.xg) }
  };
}

function addEvent(state, data) {
  const actor = data.actorId ? teamPlayer(state, data.team, data.actorId) : null;
  const target = data.targetId ? teamPlayer(state, data.targetTeam ?? data.team, data.targetId) : null;
  const event = {
    id: `action-${state.events.length + 1}`,
    tick: state.tick,
    minute: Math.max(0, Math.floor(state.minute)),
    half: state.matchDetails.half,
    type: data.type,
    outcome: data.outcome ?? null,
    team: data.team,
    actorId: actor?.id ?? null,
    actorName: actor?.name ?? null,
    targetId: target?.id ?? null,
    targetName: target?.name ?? null,
    xg: round2(data.xg ?? 0),
    location: data.location ?? (actor ? playerPoint(state, data.team, actor.id) : ballPoint(state.matchDetails)),
    ballHeight: round2(numeric(state.matchDetails.ball.position?.[2])),
    method: data.method ?? null,
    targetZone: data.targetZone ?? null,
    text: data.text,
    summary: data.summary ?? data.text,
    notable: Boolean(data.notable),
    score: { home: state.stats.home.goals, away: state.stats.away.goals },
    stats: statsSnapshot(state)
  };
  state.events.push(event);
  return event;
}

function attacksRight(event) {
  return event.team === "home" ? event.half % 2 === 1 : event.half % 2 === 0;
}

function eventArea(event) {
  const point = event.location ?? { x: 50, y: 50 };
  const progress = attacksRight(event) ? point.x : 100 - point.x;
  if (progress >= 84) return "禁区内";
  if (progress >= 68) return "进攻三区";
  if (progress <= 30) return "后场";
  return "中场";
}

function eventFlank(event) {
  const relativeY = attacksRight(event) ? numeric(event.location?.y, 50) : 100 - numeric(event.location?.y, 50);
  if (relativeY <= 30) return "左路";
  if (relativeY >= 70) return "右路";
  return "中路";
}

function eventTarget(event, fallback = "对手") {
  if (!event.targetName) return fallback;
  return event.targetName === event.actorName ? `对方${event.targetName}` : event.targetName;
}

function nearestOpponent(state, team, point, excludedId = null) {
  let closest = null;
  for (const player of state.teams[otherTeam(team)].players) {
    if (player.id === String(excludedId)) continue;
    const current = playerPoint(state, otherTeam(team), player.id);
    const distance = Math.hypot(current.x - point.x, current.y - point.y);
    if (!closest || distance < closest.distance) closest = { ...player, distance };
  }
  return closest;
}

function isDangerousDefensiveAction(state, defendingTeam, point = ballPoint(state.matchDetails)) {
  const attackingTeam = otherTeam(defendingTeam);
  const attackingRight = attackingTeam === "home" ? state.matchDetails.half % 2 === 1 : state.matchDetails.half % 2 === 0;
  return (attackingRight ? point.x : 100 - point.x) >= 68;
}

function resolvePendingPass(state, owner) {
  const pending = state.pendingPass;
  if (!pending || !owner) return;
  if (owner.team === pending.team && owner.playerId === pending.actorId) return;
  const event = pending.event;
  const passerStats = state.playerStats.get(keyOf(pending.team, pending.actorId));
  if (owner.team === pending.team) {
    state.stats[pending.team].completedPasses += 1;
    passerStats.completedPasses += 1;
    event.outcome = "complete";
    event.targetId = owner.playerId;
    event.targetName = owner.name;
  } else {
    event.outcome = "failed";
    state.stats[owner.team].interceptions += 1;
    const defenderStats = state.playerStats.get(keyOf(owner.team, owner.playerId));
    const dispossessed = state.playerStats.get(keyOf(pending.team, pending.actorId));
    if (defenderStats) defenderStats.interceptions += 1;
    if (dispossessed) dispossessed.dispossessions += 1;
    addEvent(state, {
      type: "interception",
      outcome: "won",
      team: owner.team,
      actorId: owner.playerId,
      targetId: pending.actorId,
      targetTeam: pending.team,
      notable: isDangerousDefensiveAction(state, owner.team),
      text: `${owner.name}识破传球线路并完成拦截`
    });
  }
  event.stats = statsSnapshot(state);
  state.pendingPass = null;
}

function shotXg(state, team, player) {
  const engineEntry = enginePlayerEntries(state.matchDetails).find((entry) => entry.team === team && appPlayerId(entry.player) === player.id);
  if (!engineEntry || engineEntry.player.currentPOS[0] === "NP") return 0.08;
  const [x, y] = engineEntry.player.currentPOS;
  const attacksDown = team === "home" ? state.matchDetails.half % 2 === 1 : state.matchDetails.half % 2 === 0;
  const goalY = attacksDown ? PITCH.height : 0;
  const dxMeters = Math.abs(x - PITCH.width / 2) / PITCH.width * 68;
  const dyMeters = Math.abs(goalY - y) / PITCH.height * 105;
  const distance = Math.hypot(dxMeters, dyMeters);
  const centrality = 1 - clamp(dxMeters / 28, 0, 1);
  const quality = (player.profile.shooting - state.teams[otherTeam(team)].players.find((item) => item.position === "GK").profile.saving) / 500;
  return clamp(0.03 + (34 - distance) / 70 + centrality * 0.16 + quality, 0.02, 0.68);
}

function shotTargetZone(state, team) {
  const trajectory = state.matchDetails.ball.ballOverIterations;
  const target = uiPoint(Array.isArray(trajectory) && trajectory.length ? trajectory.at(-1) : state.matchDetails.ball.position);
  const isRight = team === "home" ? state.matchDetails.half % 2 === 1 : state.matchDetails.half % 2 === 0;
  const relativeY = isRight ? target.y : 100 - target.y;
  if (relativeY < 44) return "左侧";
  if (relativeY > 56) return "右侧";
  return "中路";
}

function updatePossession(state) {
  const owner = possessionOwner(state.matchDetails);
  if (owner) state.stats[owner.team].possessionWeight += 1;
  return owner;
}

function resetDisabledEngineFeatures(matchDetails) {
  for (const { player } of enginePlayerEntries(matchDetails)) player.injured = false;
}

function inferPassLog(logs) {
  for (const log of logs) {
    const match = log.match(/(?:ball|through ball) passed by: (.+?) to: (.+)$/);
    if (match) return { passer: match[1], receiver: match[2], through: log.startsWith("through") };
    const cross = log.match(/ball crossed by: (.+)$/);
    if (cross) return { passer: cross[1], receiver: null, cross: true };
  }
  return null;
}

function copyEngineStats(state, after) {
  for (const team of ["home", "away"]) {
    for (const player of state.teams[team].players) {
      const source = after.players.get(keyOf(team, player.id));
      const target = state.playerStats.get(keyOf(team, player.id));
      if (!source || !target) continue;
      target.goals = source.goals;
      target.shots = source.shots;
      target.shotsOnTarget = source.shotsOnTarget;
      target.passes = source.passes;
      target.tackles = source.tacklesWon;
      target.fouls = source.fouls;
      target.saves = source.saves;
    }
  }
}

function processIteration(state, before, previousOwner) {
  const after = engineCounterSnapshot(state.matchDetails);
  const owner = updatePossession(state);
  resolvePendingPass(state, owner);
  const logs = state.matchDetails.iterationLog ?? [];
  const passLog = inferPassLog(logs);

  for (const team of ["home", "away"]) {
    for (const player of state.teams[team].players) {
      const key = keyOf(team, player.id);
      const was = before.players.get(key);
      const now = after.players.get(key);
      if (!was || !now) continue;
      const publicStats = state.playerStats.get(key);

      if (now.passes > was.passes) {
        if (state.pendingPass) {
          state.pendingPass.event.outcome = "failed";
          state.pendingPass = null;
        }
        const receiverMatch = passLog?.receiver ? playerByName(state, passLog.receiver, team) : null;
        state.stats[team].passes += now.passes - was.passes;
        const passEvent = addEvent(state, {
          type: passLog?.cross ? "cross" : passLog?.through ? "through_ball" : "pass",
          outcome: "pending",
          team,
          actorId: player.id,
          targetId: receiverMatch?.team === team ? receiverMatch.player.id : null,
          text: `${player.name}${passLog?.cross ? "起脚传中" : passLog?.through ? "送出直塞" : "尝试传球"}`
        });
        state.pendingPass = { team, actorId: player.id, event: passEvent };
      }

      if (now.shots > was.shots) {
        const xg = shotXg(state, team, player);
        publicStats.xg += xg;
        state.stats[team].shots += now.shots - was.shots;
        state.stats[team].shotsOnTarget += Math.max(0, now.shotsOnTarget - was.shotsOnTarget);
        state.stats[team].xg += xg;
        addEvent(state, {
          type: "shot",
          outcome: now.shotsOnTarget > was.shotsOnTarget ? "on_target" : "off_target",
          team,
          actorId: player.id,
          xg,
          targetZone: shotTargetZone(state, team),
          notable: true,
          text: `${player.name}完成射门${now.shotsOnTarget > was.shotsOnTarget ? "，打在门框范围内" : "，偏出球门"}`
        });
      }

      if (now.saves > was.saves) {
        state.stats[team].saves += now.saves - was.saves;
        addEvent(state, { type: "save", outcome: "saved", team, actorId: player.id, notable: true, text: `${player.name}完成扑救` });
      }

      if (now.tacklesWon > was.tacklesWon) {
        state.stats[team].tackles += now.tacklesWon - was.tacklesWon;
        addEvent(state, { type: "tackle", outcome: "won", team, actorId: player.id, targetId: previousOwner?.team === otherTeam(team) ? previousOwner.playerId : null, targetTeam: otherTeam(team), notable: isDangerousDefensiveAction(state, team), text: `${player.name}完成抢断` });
      }

      if (now.fouls > was.fouls) {
        state.stats[team].fouls += now.fouls - was.fouls;
        addEvent(state, { type: "foul", outcome: "free_kick", team, actorId: player.id, targetId: previousOwner?.team === otherTeam(team) ? previousOwner.playerId : null, targetTeam: otherTeam(team), text: `${player.name}犯规，裁判判罚任意球` });
      }
    }
  }

  for (const team of ["home", "away"]) {
    const engineStats = team === "home" ? state.matchDetails.kickOffTeamStatistics : state.matchDetails.secondTeamStatistics;
    const previousGoals = state.stats[team].goals;
    state.stats[team].goals = numeric(engineStats.goals);
    state.stats[team].corners = numeric(engineStats.corners);
    if (state.stats[team].goals > previousGoals) {
      const scorer = state.teams[team].players.find((player) => after.players.get(keyOf(team, player.id))?.goals > before.players.get(keyOf(team, player.id))?.goals);
      const lastShot = [...state.events].reverse().find((event) => event.team === team && event.type === "shot" && state.tick - event.tick <= 180);
      if (lastShot) lastShot.outcome = "goal";
      const lastPass = [...state.events].reverse().find((event) => event.team === team && ["pass", "through_ball", "cross"].includes(event.type) && event.outcome === "complete" && state.tick - event.tick <= 180);
      if (scorer && lastPass?.targetId === scorer.id && lastPass.actorId !== scorer.id) {
        state.playerStats.get(keyOf(team, lastPass.actorId)).assists += 1;
        lastPass.notable = true;
      }
      addEvent(state, { type: "goal", outcome: "scored", team, actorId: scorer?.id, notable: true, text: `${scorer?.name ?? state.matchDetails.ball.lastTouch.playerName}破门，比分变为${state.stats.home.goals}-${state.stats.away.goals}` });
    }
  }

  if (previousOwner && owner && previousOwner.team !== owner.team) {
    const alreadyDefended = state.events.some((event) => event.tick === state.tick && event.team === owner.team && ["tackle", "save"].includes(event.type));
    if (!alreadyDefended) {
      state.stats[owner.team].interceptions += 1;
      const defenderStats = state.playerStats.get(keyOf(owner.team, owner.playerId));
      defenderStats.interceptions += 1;
      state.playerStats.get(keyOf(previousOwner.team, previousOwner.playerId)).dispossessions += 1;
      addEvent(state, { type: "interception", outcome: "won", team: owner.team, actorId: owner.playerId, targetId: previousOwner.playerId, targetTeam: previousOwner.team, notable: isDangerousDefensiveAction(state, owner.team), text: `${owner.name}截断${previousOwner.name}的传球` });
    }
  }

  const currentCarryKey = owner ? keyOf(owner.team, owner.playerId) : null;
  if (currentCarryKey !== state.carry.key) {
    state.carry = { key: currentCarryKey, point: owner ? ballPoint(state.matchDetails) : null, tick: state.tick };
  } else if (owner && state.carry.point) {
    const point = ballPoint(state.matchDetails);
    if (Math.hypot(point.x - state.carry.point.x, point.y - state.carry.point.y) >= 4 && state.tick - state.carry.tick >= 12) {
      const actor = teamPlayer(state, owner.team, owner.playerId);
      const defender = nearestOpponent(state, owner.team, point);
      const method = actor.profile.agility >= defender.profile.agility + 4 ? "变向" : actor.profile.agility >= 72 ? "假动作" : "速度";
      addEvent(state, { type: "carry", outcome: "advanced", team: owner.team, actorId: owner.playerId, targetId: defender.id, targetTeam: otherTeam(owner.team), method, text: `${owner.name}带球向前推进` });
      state.carry = { key: currentCarryKey, point, tick: state.tick };
    }
  }

  copyEngineStats(state, after);
  return owner;
}

function runTicks(state, count, startMinute, endMinute) {
  let owner = possessionOwner(state.matchDetails);
  for (let index = 1; index <= count; index += 1) {
    const before = engineCounterSnapshot(state.matchDetails);
    state.matchDetails = playIteration(state.matchDetails);
    resetDisabledEngineFeatures(state.matchDetails);
    state.tick += 1;
    state.minute = startMinute + (endMinute - startMinute) * index / count;
    owner = processIteration(state, before, owner);
  }
}

function startNextPeriod(state, minute, type, text) {
  state.matchDetails = startSecondHalf(state.matchDetails);
  resetDisabledEngineFeatures(state.matchDetails);
  state.tick += 1;
  state.minute = minute;
  addEvent(state, { type, outcome: "restart", team: state.matchDetails.half % 2 === 0 ? "away" : "home", notable: true, text });
}

function scoreOf(state, team) {
  return state.stats[team].goals;
}

function penaltyShootout(state, random) {
  let home = 0;
  let away = 0;
  const kicks = [];
  for (let round = 1; round <= 5 || home === away; round += 1) {
    for (const team of ["home", "away"]) {
      const shooters = state.teams[team].players.filter((player) => player.position !== "GK").sort((left, right) => right.profile.penalty - left.profile.penalty);
      const shooter = shooters[(round - 1) % shooters.length];
      const goalkeeper = state.teams[otherTeam(team)].players.find((player) => player.position === "GK");
      const probability = clamp(0.72 + (shooter.profile.penalty - goalkeeper.profile.saving) / 420, 0.55, 0.9);
      const scored = random() < probability;
      if (scored) team === "home" ? home += 1 : away += 1;
      state.tick += 2;
      state.minute = 120;
      addEvent(state, { type: "penalty", outcome: scored ? "goal" : "saved", team, actorId: shooter.id, targetId: goalkeeper.id, targetTeam: otherTeam(team), notable: true, text: scored ? `${shooter.name}罚入点球` : `${goalkeeper.name}扑出${shooter.name}的点球` });
      kicks.push({ team, playerName: shooter.name, scored, homeScore: home, awayScore: away });
    }
    if (round >= 5 && home !== away) break;
    if (round >= 10) break;
  }
  return { home, away, kicks };
}

function buildupEvents(events, index, team) {
  const chain = [];
  const endpoint = events[index];
  let expectedReceiver = endpoint.actorId;
  for (let cursor = index - 1; cursor >= 0 && chain.length < 3; cursor -= 1) {
    const event = events[cursor];
    if (endpoint.tick - event.tick > 240 || ["kickoff", "halftime", "extra_time", "goal", "foul"].includes(event.type)) break;
    if (event.team !== team) {
      if (["pass", "through_ball", "cross", "carry", "shot", "tackle", "interception", "save"].includes(event.type)) break;
      continue;
    }
    if (event.type === "carry" && event.actorId === expectedReceiver) {
      chain.unshift(event);
      continue;
    }
    if (["pass", "through_ball", "cross"].includes(event.type) && event.outcome === "complete" && event.targetId === expectedReceiver) {
      chain.unshift(event);
      expectedReceiver = event.actorId;
      continue;
    }
    if (["pass", "through_ball", "cross", "carry", "shot"].includes(event.type)) break;
  }
  return chain;
}

function buildupPhrase(event) {
  const area = eventArea(event);
  const flank = eventFlank(event);
  if (event.type === "carry") return `${event.actorName}利用${event.method ?? "节奏变化"}${event.targetName ? `摆脱${eventTarget(event)}的跟防` : "甩开防守"}，沿${flank}推进到${area}`;
  if (event.type === "through_ball") return `${event.actorName}在${area}观察到空当，送出穿透防线的直塞${event.targetName ? `找到前插的${event.targetName}` : "打到防线身后"}`;
  if (event.type === "cross") return `${event.actorName}从${flank}${eventArea(event) === "进攻三区" ? "靠近底线的位置" : eventArea(event)}起球传中，皮球送向禁区`;
  return `${event.actorName}在${area}${event.targetName ? `把球交给${event.targetName}` : "完成一次向前传递"}`;
}

function shotPhrase(event) {
  const area = eventArea(event);
  const lastResult = event.outcome === "goal" ? `，皮球从球门${event.targetZone ?? "一侧"}越过门将钻入网窝` : event.outcome === "on_target" ? `，皮球直奔球门${event.targetZone ?? "范围"}` : `，皮球从${event.targetZone ?? "一侧"}偏出立柱`;
  if (area === "禁区内") return `${event.actorName}在禁区内调整后起脚攻门${lastResult}`;
  if (area === "进攻三区") return `${event.actorName}在禁区前沿摆脱出射门角度后抽射${lastResult}`;
  return `${event.actorName}在外围观察到门将站位后突施冷箭${lastResult}`;
}

function enrichCommentary(state) {
  const events = state.events;
  events.forEach((event, index) => {
    const area = eventArea(event);
    const flank = eventFlank(event);
    let summary = event.text;
    let text = event.text;
    if (event.type === "kickoff") {
      summary = "主裁判鸣哨开球";
      text = `${event.actorName ?? state.teams[event.team].name}在中圈将球回做，双方阵型随即展开，比赛正式开始。`;
    } else if (event.type === "pass") {
      summary = event.outcome === "complete" ? `${event.actorName}传球找到${event.targetName}` : `${event.actorName}的传球未能穿过防线`;
      text = event.outcome === "complete"
        ? `${event.actorName}在${area}抬头观察后控制传球力度，将球准确交到${event.targetName}脚下，球队继续组织进攻。`
        : `${event.actorName}在${area}尝试向前输送，防守方提前收紧线路，这脚传递没能找到队友。`;
    } else if (event.type === "through_ball") {
      summary = event.outcome === "complete" ? `${event.actorName}直塞找到${event.targetName}` : `${event.actorName}的直塞被识破`;
      text = event.outcome === "complete"
        ? `${event.actorName}吸引防守后抓住肋部空当，送出穿透防线的直塞，${event.targetName}从防守队员身后前插接到皮球。`
        : `${event.actorName}试图用直塞打穿两线之间的空当，但防线保持了良好间距，皮球没有送到目标区域。`;
    } else if (event.type === "cross") {
      summary = event.outcome === "complete" ? `${event.actorName}从${flank}送出传中` : `${event.actorName}的传中被破坏`;
      text = event.outcome === "complete"
        ? `${event.actorName}沿${flank}推进到${area}后起脚传中，皮球越过第一名防守队员落向禁区${event.targetName ? `，${event.targetName}抢到落点` : "内的抢点区域"}。`
        : `${event.actorName}在${flank}尝试把球传入禁区，防守队员封住传中线路并将这次进攻破坏。`;
    } else if (event.type === "carry") {
      summary = `${event.actorName}${event.method === "速度" ? "加速" : "变向"}推进`;
      text = `${event.actorName}在${flank}拿球后利用${event.method ?? "节奏变化"}${event.targetName ? `摆脱${eventTarget(event)}的跟防` : "甩开防守"}，保持球权推进到${area}，迫使对方防线回撤。`;
    } else if (event.type === "shot") {
      const chain = buildupEvents(events, index, event.team).map(buildupPhrase);
      summary = `${event.actorName}${eventArea(event) === "禁区内" ? "禁区内" : "外围"}攻门${event.outcome === "goal" ? "得分" : event.outcome === "on_target" ? "命中门框" : "偏出"}`;
      text = `${chain.length ? `${chain.join("；")}。` : ""}${shotPhrase(event)}（xG ${Number(event.xg).toFixed(2)}）。`;
    } else if (event.type === "goal") {
      const shot = [...events.slice(0, index)].reverse().find((candidate) => candidate.team === event.team && candidate.type === "shot" && event.tick - candidate.tick <= 180);
      const chain = buildupEvents(events, shot ? events.indexOf(shot) : index, event.team).map(buildupPhrase);
      summary = `${event.actorName}破门，比分${event.score.home}-${event.score.away}`;
      text = `${chain.length ? `${chain.join("；")}。` : ""}${event.actorName}在关键区域完成最后一击，将皮球送入网窝，比分改写为${event.score.home}-${event.score.away}。`;
    } else if (event.type === "save") {
      const shot = [...events.slice(0, index)].reverse().find((candidate) => candidate.team !== event.team && candidate.type === "shot" && event.tick - candidate.tick <= 180);
      summary = `${event.actorName}化解${shot?.actorName ?? "对手"}的射门`;
      text = `${shot?.actorName ?? "进攻球员"}的攻门飞向门框范围，${event.actorName}迅速移动到球路上完成扑救，没有给补射留下轻松机会。`;
    } else if (event.type === "tackle") {
      summary = `${event.actorName}抢断${eventTarget(event, "持球队员")}`;
      text = `${event.actorName}在${area}贴近${eventTarget(event, "持球队员")}，看准对方触球稍大的瞬间伸脚将球干净断下，立即夺回球权。`;
    } else if (event.type === "interception") {
      summary = `${event.actorName}截断${eventTarget(event)}的传球`;
      text = `${event.actorName}提前判断出${eventTarget(event)}的传球意图，在${area}横向移动封住线路并把球截下，进攻方向随即转换。`;
    } else if (event.type === "foul") {
      summary = `${event.actorName}对${eventTarget(event)}犯规`;
      text = `${event.actorName}在${area}的防守动作慢了半拍，阻挡了${eventTarget(event)}的推进，主裁判鸣哨判给进攻方任意球。`;
    } else if (event.type === "halftime") {
      summary = "半场结束，双方交换场地";
      text = `主裁判结束上半场比赛。短暂休息后双方交换场地，并按照各自阵型重新站位准备下半场。`;
    } else if (event.type === "extra_time") {
      summary = event.minute === 90 ? "加时赛开始" : "加时赛交换场地";
      text = event.minute === 90 ? "常规时间未分胜负，双方重新布置阵型后进入加时赛。" : "加时赛上半场结束，双方交换场地后继续比赛。";
    } else if (event.type === "penalty") {
      summary = event.outcome === "goal" ? `${event.actorName}罚入点球` : `${event.targetName}扑出${event.actorName}的点球`;
      text = event.outcome === "goal" ? `${event.actorName}助跑后稳住重心，将点球送入门将难以触及的区域。` : `${event.actorName}主罚点球，${event.targetName}判断对方向并将射门拒之门外。`;
    } else if (event.type === "full_time") {
      summary = `全场结束，比分${event.score.home}-${event.score.away}`;
      text = `主裁判吹响终场哨，双方结束全部比赛时间，最终比分定格在${event.score.home}-${event.score.away}。`;
    }
    event.summary = summary;
    event.text = text;
  });
}

function playbackOrder(state) {
  return enginePlayerEntries(state.matchDetails).map(({ team, player }) => ({ team, id: appPlayerId(player), player: teamPlayer(state, team, appPlayerId(player)) }));
}

function eventHalf(event) {
  if (event?.half) return event.half;
  if (numeric(event?.minute) >= 105) return 4;
  if (numeric(event?.minute) >= 90) return 3;
  return numeric(event?.minute) >= 45 ? 2 : 1;
}

function worldPoint(team, half, relativeX, relativeY) {
  const right = team === "home" ? half % 2 === 1 : half % 2 === 0;
  return right
    ? { x: clamp(relativeX, 2, 98), y: clamp(relativeY, 3, 97) }
    : { x: clamp(100 - relativeX, 2, 98), y: clamp(100 - relativeY, 3, 97) };
}

function relativePoint(team, half, point) {
  const right = team === "home" ? half % 2 === 1 : half % 2 === 0;
  return right ? { x: point.x, y: point.y } : { x: 100 - point.x, y: 100 - point.y };
}

function activityBounds(position) {
  if (position === "GK") return [4, 12];
  if (["LB", "LWB", "CB", "RB", "RWB"].includes(position)) return [12, 58];
  if (["CDM", "CM", "LM", "RM"].includes(position)) return [22, 76];
  if (position === "CAM") return [30, 84];
  return [34, 91];
}

function separatePlayers(points, lockedIndexes) {
  for (let pass = 0; pass < 3; pass += 1) {
    for (let left = 0; left < points.length; left += 1) {
      for (let right = left + 1; right < points.length; right += 1) {
        const a = points[left];
        const b = points[right];
        const minimum = a.team === b.team ? 4.2 : 2.8;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const distance = Math.hypot(dx, dy);
        if (distance >= minimum) continue;
        const direction = distance > 0.1 ? { x: dx / distance, y: dy / distance } : { x: 0, y: left % 2 ? 1 : -1 };
        const amount = (minimum - distance) / (lockedIndexes.has(left) || lockedIndexes.has(right) ? 1 : 2);
        if (!lockedIndexes.has(left)) {
          a.x = clamp(a.x - direction.x * amount, 2, 98);
          a.y = clamp(a.y - direction.y * amount, 3, 97);
        }
        if (!lockedIndexes.has(right)) {
          b.x = clamp(b.x + direction.x * amount, 2, 98);
          b.y = clamp(b.y + direction.y * amount, 3, 97);
        }
      }
    }
  }
}

function tacticalPositions(state, order, half, possessionTeam, ball, overrides = new Map(), press = true) {
  const points = order.map(({ team, player }) => {
    const relativeBall = relativePoint(team, half, ball);
    const [minimum, maximum] = activityBounds(player.position);
    const shift = (relativeBall.x - 50) * (team === possessionTeam ? 0.46 : 0.34);
    let relativeX = clamp(player.base.x + shift, minimum, maximum);
    let relativeY = player.base.y + (relativeBall.y - player.base.y) * (team === possessionTeam ? 0.16 : 0.22);
    if (team !== possessionTeam) relativeY = 50 + (relativeY - 50) * 0.86;
    if (player.position === "GK") {
      relativeX = clamp(6 + (relativeBall.x - 50) * 0.045, 4, 11);
      relativeY = 50 + (relativeBall.y - 50) * 0.2;
    }
    const world = worldPoint(team, half, relativeX, relativeY);
    return { ...world, team, id: player.id };
  });
  const lockedIndexes = new Set();
  for (const [key, point] of overrides) {
    const index = order.findIndex((entry) => keyOf(entry.team, entry.id) === key);
    if (index < 0) continue;
    points[index].x = clamp(point.x, 2, 98);
    points[index].y = clamp(point.y, 3, 97);
    lockedIndexes.add(index);
  }
  if (press && possessionTeam) {
    const defenders = points.map((point, index) => ({ point, index, player: order[index].player }))
      .filter((entry) => entry.point.team !== possessionTeam && entry.player.position !== "GK" && !lockedIndexes.has(entry.index))
      .sort((left, right) => Math.hypot(left.point.x - ball.x, left.point.y - ball.y) - Math.hypot(right.point.x - ball.x, right.point.y - ball.y));
    const targetGoalX = possessionTeam === "home" ? (half % 2 === 1 ? 98 : 2) : (half % 2 === 0 ? 98 : 2);
    const behind = targetGoalX > ball.x ? 1 : -1;
    if (defenders[0]) {
      defenders[0].point.x = clamp(ball.x + behind * 4.3, 3, 97);
      defenders[0].point.y = clamp(ball.y + (defenders[0].point.y >= ball.y ? 2.6 : -2.6), 4, 96);
    }
    if (defenders[1]) {
      defenders[1].point.x = clamp(ball.x + behind * 9, 3, 97);
      defenders[1].point.y = clamp(ball.y + (defenders[1].point.y >= ball.y ? 7 : -7), 4, 96);
    }
  }
  separatePlayers(points, lockedIndexes);
  return points.map((point) => [round2(point.x), round2(point.y)]);
}

function normalizedEventPoint(state, event) {
  const half = eventHalf(event);
  const source = event.location ?? { x: 50, y: 50 };
  const relative = relativePoint(event.team, half, source);
  const actor = event.actorId ? teamPlayer(state, event.team, event.actorId) : null;
  if (actor?.position === "GK") {
    relative.x = clamp(relative.x, 4, 16);
    relative.y = clamp(relative.y, 32, 68);
    return worldPoint(event.team, half, relative.x, relative.y);
  }
  if (event.type === "shot") relative.x = clamp(relative.x, 70, 89);
  else if (event.type === "cross") relative.x = clamp(relative.x, 68, 84);
  else if (event.type === "through_ball") relative.x = clamp(relative.x, 48, 78);
  else relative.x = clamp(relative.x, 24, 84);
  relative.y = clamp(relative.y, 10, 90);
  return worldPoint(event.team, half, relative.x, relative.y);
}

function lerpPoint(left, right, ratio) {
  return { x: round2(interpolateNumber(left.x, right.x, ratio)), y: round2(interpolateNumber(left.y, right.y, ratio)) };
}

function interpolateNumber(left, right, ratio) {
  return left + (right - left) * ratio;
}

function framePointFor(order, positions, team, playerId) {
  const index = order.findIndex((entry) => entry.team === team && entry.id === String(playerId));
  const point = positions[index];
  return point ? { x: point[0], y: point[1] } : null;
}

function highlightSegments(state) {
  const segments = [];
  const covered = new Set();
  state.events.forEach((event, index) => {
    if (!["kickoff", "halftime", "extra_time"].includes(event.type)) return;
    covered.add(index);
    segments.push({ id: `highlight-${segments.length + 1}`, actionIndexes: [index], primaryIndex: index, minute: event.minute, tick: event.tick });
  });
  state.events.forEach((event, index) => {
    if (event.type !== "shot") return;
    const chain = buildupEvents(state.events, index, event.team);
    const actionIndexes = chain.map((item) => state.events.indexOf(item));
    actionIndexes.push(index);
    for (let cursor = index + 1; cursor < state.events.length; cursor += 1) {
      const outcome = state.events[cursor];
      if (outcome.tick - event.tick > 180) break;
      if ((outcome.type === "goal" && outcome.team === event.team) || (outcome.type === "save" && outcome.team !== event.team)) {
        actionIndexes.push(cursor);
        break;
      }
    }
    actionIndexes.forEach((item) => covered.add(item));
    const primaryIndex = actionIndexes.find((item) => state.events[item].type === "goal") ?? index;
    segments.push({ id: `highlight-${segments.length + 1}`, actionIndexes, primaryIndex, minute: state.events[actionIndexes[0]].minute, tick: event.tick });
  });
  state.events.forEach((event, index) => {
    if (covered.has(index) || !event.notable || !["tackle", "interception", "through_ball", "cross"].includes(event.type)) return;
    const previous = state.events[index - 1];
    const actionIndexes = previous && previous.tick <= event.tick && event.tick - previous.tick <= 120 && previous.team !== event.team && ["pass", "through_ball", "cross"].includes(previous.type)
      ? [index - 1, index] : [index];
    actionIndexes.forEach((item) => covered.add(item));
    segments.push({ id: `highlight-${segments.length + 1}`, actionIndexes, primaryIndex: index, minute: state.events[actionIndexes[0]].minute, tick: event.tick });
  });
  state.events.forEach((event, index) => {
    if (event.type !== "penalty") return;
    segments.push({ id: `highlight-${segments.length + 1}`, actionIndexes: [index], primaryIndex: index, minute: event.minute, tick: event.tick });
  });
  return segments.sort((left, right) => left.tick - right.tick);
}

function buildPlayback(state) {
  const order = playbackOrder(state);
  const segments = highlightSegments(state);
  const frames = [];
  const eventFrames = new Map();
  const segmentRanges = new Map();
  let elapsed = 0;
  let currentMinute = 0;
  let currentBall = { x: 50, y: 50 };
  let currentPossession = "home";
  let currentPositions = tacticalPositions(state, order, 1, currentPossession, currentBall, new Map(), false);
  const pushFrame = (data, delay = 0) => {
    elapsed += delay;
    frames.push({ tick: data.tick ?? 0, minute: round2(data.minute ?? currentMinute), half: data.half ?? 1, cut: false, mode: data.mode ?? "highlight", highlightId: data.highlightId ?? null, atMs: elapsed, ball: data.ball ?? currentBall, positions: data.positions ?? currentPositions });
    currentBall = data.ball ?? currentBall;
    currentPositions = data.positions ?? currentPositions;
    currentMinute = data.minute ?? currentMinute;
    return frames.length - 1;
  };
  pushFrame({ minute: 0, half: 1, mode: "highlight", ball: currentBall, positions: currentPositions });

  const animateAction = (event, eventIndex, segment) => {
    const half = eventHalf(event);
    const actorKey = event.actorId ? keyOf(event.team, event.actorId) : null;
    let start = currentBall;
    if (segment.actionIndexes[0] === eventIndex || ["interception", "tackle", "penalty"].includes(event.type)) start = normalizedEventPoint(state, event);
    if (event.type === "penalty") start = { x: event.team === "home" ? 84 : 16, y: 50 };
    const startOverrides = new Map(actorKey ? [[actorKey, start]] : []);
    const startPositions = tacticalPositions(state, order, half, event.team, start, startOverrides);
    pushFrame({ tick: event.tick, minute: event.minute, half, mode: "highlight", highlightId: segment.id, ball: start, positions: startPositions }, 320);

    let end = start;
    let possessionAfter = event.team;
    const targetKey = event.targetId ? keyOf(event.targetTeam ?? event.team, event.targetId) : null;
    const targetShape = tacticalPositions(state, order, half, event.team, start, startOverrides);
    const targetAnchor = targetKey ? framePointFor(order, targetShape, event.targetTeam ?? event.team, event.targetId) : null;
    if (["pass", "through_ball", "cross"].includes(event.type)) {
      end = targetAnchor ?? worldPoint(event.team, half, clamp(relativePoint(event.team, half, start).x + (event.type === "through_ball" ? 14 : 8), 28, 88), event.type === "cross" ? 50 : relativePoint(event.team, half, start).y);
      if (event.type === "through_ball") {
        const relative = relativePoint(event.team, half, end);
        end = worldPoint(event.team, half, clamp(relative.x + 9, 55, 88), relative.y);
      }
      if (event.type === "cross") {
        const relative = relativePoint(event.team, half, end);
        end = worldPoint(event.team, half, clamp(relative.x, 78, 88), clamp(relative.y, 34, 66));
      }
      if (event.outcome === "failed") possessionAfter = otherTeam(event.team);
    } else if (event.type === "carry") {
      const relative = relativePoint(event.team, half, start);
      end = worldPoint(event.team, half, clamp(relative.x + 10, 32, 90), relative.y + (relative.y < 50 ? 3 : -3));
    } else if (event.type === "shot") {
      const right = event.team === "home" ? half % 2 === 1 : half % 2 === 0;
      const targetY = event.targetZone === "左侧" ? (right ? 43 : 57) : event.targetZone === "右侧" ? (right ? 57 : 43) : 50;
      end = { x: right ? 98.5 : 1.5, y: targetY };
      possessionAfter = event.outcome === "goal" ? otherTeam(event.team) : event.team;
    } else if (["interception", "tackle"].includes(event.type)) {
      end = normalizedEventPoint(state, event);
    } else if (event.type === "penalty") {
      const right = event.team === "home";
      end = { x: right ? 98.5 : 1.5, y: event.outcome === "goal" ? 44 : 50 };
    }

    if (["goal", "save"].includes(event.type)) {
      const holdPositions = tacticalPositions(state, order, half, event.type === "goal" ? otherTeam(event.team) : event.team, currentBall, new Map(), false);
      const frameIndex = pushFrame({ tick: event.tick, minute: event.minute, half, mode: "highlight", highlightId: segment.id, ball: currentBall, positions: holdPositions }, 850);
      eventFrames.set(event.id, frameIndex);
      currentPossession = event.type === "goal" ? otherTeam(event.team) : event.team;
      return;
    }

    const middle = lerpPoint(start, end, 0.5);
    const movingOverrides = new Map(startOverrides);
    if (actorKey) movingOverrides.set(actorKey, ["carry", "interception", "tackle"].includes(event.type) ? middle : start);
    if (targetKey && event.outcome === "complete") movingOverrides.set(targetKey, end);
    const middlePositions = tacticalPositions(state, order, half, event.team, middle, movingOverrides);
    pushFrame({ tick: event.tick, minute: event.minute + 0.01, half, mode: "highlight", highlightId: segment.id, ball: middle, positions: middlePositions }, ["shot", "penalty"].includes(event.type) ? 520 : 440);
    const endOverrides = new Map();
    if (["carry", "interception", "tackle"].includes(event.type) && actorKey) endOverrides.set(actorKey, end);
    if (["pass", "through_ball", "cross"].includes(event.type) && event.outcome === "complete" && targetKey) endOverrides.set(targetKey, end);
    const endPositions = tacticalPositions(state, order, half, possessionAfter, end, endOverrides);
    const frameIndex = pushFrame({ tick: event.tick, minute: event.minute + 0.02, half, mode: "highlight", highlightId: segment.id, ball: end, positions: endPositions }, ["shot", "penalty"].includes(event.type) ? 720 : 580);
    eventFrames.set(event.id, frameIndex);
    currentPossession = possessionAfter;
  };

  for (const segment of segments) {
    const firstEvent = state.events[segment.actionIndexes[0]];
    const half = eventHalf(firstEvent);
    const segmentStartBall = normalizedEventPoint(state, firstEvent);
    const segmentStartOverrides = new Map(firstEvent.actorId ? [[keyOf(firstEvent.team, firstEvent.actorId), segmentStartBall]] : []);
    const segmentStartPositions = tacticalPositions(state, order, half, firstEvent.team, segmentStartBall, segmentStartOverrides);
    if (segment.minute > currentMinute + 0.2) {
      pushFrame({ minute: currentMinute, half, mode: "fast_forward", ball: currentBall, positions: currentPositions }, 180);
      pushFrame({ minute: segment.minute, half, mode: "fast_forward", ball: segmentStartBall, positions: segmentStartPositions }, 920);
    }
    const rangeStart = frames.length;
    for (const eventIndex of segment.actionIndexes) animateAction(state.events[eventIndex], eventIndex, segment);
    pushFrame({ minute: state.events[segment.actionIndexes.at(-1)].minute + 0.08, half, mode: "highlight", highlightId: segment.id, ball: currentBall, positions: currentPositions }, 720);
    segmentRanges.set(segment.id, [rangeStart, frames.length - 1]);
  }

  const finalEvent = state.events.at(-1);
  if (finalEvent.minute > currentMinute) {
    const half = eventHalf(finalEvent);
    const endPositions = tacticalPositions(state, order, half, finalEvent.team, { x: 50, y: 50 }, new Map(), false);
    pushFrame({ minute: currentMinute, half, mode: "fast_forward", ball: currentBall, positions: currentPositions }, 180);
    pushFrame({ minute: finalEvent.minute, half, mode: "fast_forward", ball: { x: 50, y: 50 }, positions: endPositions }, 920);
  }
  const finalFrameIndex = pushFrame({ tick: finalEvent.tick, minute: finalEvent.minute, half: eventHalf(finalEvent), mode: "period", ball: currentBall, positions: currentPositions }, 1200);
  eventFrames.set(finalEvent.id, finalFrameIndex);

  const naturalDuration = elapsed || 1;
  const durationMs = clamp(naturalDuration, 120000, 300000);
  const scale = durationMs / naturalDuration;
  frames.forEach((frame) => { frame.atMs = Math.round(frame.atMs * scale); });
  let previousFrameIndex = 0;
  for (const event of state.events) {
    let frameIndex = eventFrames.get(event.id);
    if (frameIndex === undefined) {
      frameIndex = frames.findIndex((frame, index) => index >= previousFrameIndex && frame.minute >= event.minute);
      if (frameIndex < 0) frameIndex = frames.length - 1;
    }
    frameIndex = Math.max(previousFrameIndex, frameIndex);
    previousFrameIndex = frameIndex;
    event.frameIndex = frameIndex;
    event.atMs = frames[frameIndex].atMs;
    event.replayStartFrame = Math.max(0, frameIndex - 2);
    event.replayEndFrame = Math.min(frames.length - 1, frameIndex + 3);
  }
  const momentEventIndexes = segments.map((segment) => {
    const [start, end] = segmentRanges.get(segment.id);
    const event = state.events[segment.primaryIndex];
    event.replayStartFrame = start;
    event.replayEndFrame = end;
    return segment.primaryIndex;
  });
  return { frames, durationMs, momentEventIndexes, playerOrder: order.map(({ team, id }) => ({ team, id })) };
}

function publicTeamStats(stats) {
  const total = stats.home.possessionWeight + stats.away.possessionWeight || 1;
  const result = {};
  for (const team of ["home", "away"]) {
    const { possessionWeight, ...rest } = stats[team];
    result[team] = { ...rest, xg: round2(rest.xg), possession: Math.round(possessionWeight / total * 100), passCompletion: rest.passes ? Math.round(rest.completedPasses / rest.passes * 100) : 0 };
  }
  return result;
}

function finalizeRatings(state, maxMinute) {
  const result = {};
  for (const team of ["home", "away"]) {
    const conceded = state.stats[otherTeam(team)].goals;
    result[team] = state.teams[team].players.map((player) => {
      const stats = state.playerStats.get(keyOf(team, player.id));
      stats.minutes = maxMinute;
      const completedPassValue = stats.completedPasses * 0.006 - Math.max(0, stats.passes - stats.completedPasses) * 0.012;
      const defensiveValue = stats.tackles * 0.08 + stats.interceptions * 0.07 + stats.clearances * 0.035;
      const attackingValue = stats.goals * 0.9 + stats.assists * 0.38 + stats.shotsOnTarget * 0.06 - Math.max(0, stats.shots - stats.shotsOnTarget) * 0.035;
      const goalkeeperValue = player.position === "GK" ? stats.saves * 0.1 - conceded * 0.16 : 0;
      const rating = round2(clamp(6.2 + completedPassValue + defensiveValue + attackingValue + goalkeeperValue - stats.fouls * 0.04 - stats.dispossessions * 0.025, 4, 10));
      return { ...stats, xg: round2(stats.xg), passCompletion: stats.passes ? Math.round(stats.completedPasses / stats.passes * 100) : 0, rating };
    }).sort((left, right) => right.rating - left.rating || left.name.localeCompare(right.name));
  }
  return result;
}

export function simulatePvpMatch(homeSide, awaySide, seed = crypto.randomUUID()) {
  const random = seededRandom(seed);
  setMatchSeed(hashSeed(seed));
  const home = prepareTeam(homeSide, "home", random);
  const away = prepareTeam(awaySide, "away", random);
  const matchDetails = initiateGame(home.engine, away.engine, { pitchWidth: PITCH.width, pitchHeight: PITCH.height, goalWidth: PITCH.goalWidth });
  const state = {
    teams: { home, away },
    matchDetails,
    tick: 0,
    minute: 0,
    stats: { home: initialTeamStats(), away: initialTeamStats() },
    playerStats: new Map(),
    events: [],
    pendingPass: null,
    carry: { key: null, point: null, tick: 0 }
  };
  for (const team of ["home", "away"]) for (const player of state.teams[team].players) state.playerStats.set(keyOf(team, player.id), initialPlayerStats(player, team));

  const kickoffOwner = possessionOwner(state.matchDetails);
  addEvent(state, { type: "kickoff", outcome: "started", team: kickoffOwner?.team ?? "home", actorId: kickoffOwner?.playerId, notable: true, text: `${kickoffOwner?.name ?? home.name}开球，比赛开始` });
  runTicks(state, REGULATION_TICKS, 0, 45);
  startNextPeriod(state, 45, "halftime", "中场休息结束，双方交换场地");
  runTicks(state, REGULATION_TICKS, 45, 90);

  let extraTime = false;
  if (scoreOf(state, "home") === scoreOf(state, "away")) {
    extraTime = true;
    startNextPeriod(state, 90, "extra_time", "加时赛开始，双方再次交换场地");
    runTicks(state, EXTRA_TIME_TICKS, 90, 105);
    startNextPeriod(state, 105, "extra_time", "加时赛下半场开始，双方交换场地");
    runTicks(state, EXTRA_TIME_TICKS, 105, 120);
  }

  const penalties = scoreOf(state, "home") === scoreOf(state, "away") ? penaltyShootout(state, random) : null;
  const winner = penalties ? (penalties.home > penalties.away ? "home" : "away") : scoreOf(state, "home") > scoreOf(state, "away") ? "home" : "away";
  const maxMinute = extraTime ? 120 : 90;
  if (state.pendingPass) {
    state.pendingPass.event.outcome = "failed";
    state.pendingPass = null;
  }
  state.minute = maxMinute;
  addEvent(state, { type: "full_time", outcome: "finished", team: winner, notable: true, text: `全场比赛结束，比分${scoreOf(state, "home")}-${scoreOf(state, "away")}` });
  enrichCommentary(state);
  const { frames, durationMs, momentEventIndexes, playerOrder } = buildPlayback(state);
  const stats = publicTeamStats(state.stats);
  const ratings = finalizeRatings(state, maxMinute);
  const moments = momentEventIndexes.map((eventIndex) => ({ ...state.events[eventIndex], eventIndex })).map((event) => ({ id: event.id, eventIndex: event.eventIndex, minute: event.minute, type: event.type, team: event.team, text: event.text, summary: event.summary, score: event.score, atMs: event.atMs, replayStartFrame: event.replayStartFrame, replayEndFrame: event.replayEndFrame }));
  return {
    version: 4,
    engine: "footballsim-events+tactical-highlights-v1",
    seed,
    durationMs,
    maxMinute,
    extraTime,
    penalties,
    winner,
    playerOrder,
    teams: {
      home: { name: home.name, formationId: home.formationId, tacticId: home.tacticId, players: home.players.map(({ id, name, shortName, position, base }) => ({ id, name, shortName, position, base })) },
      away: { name: away.name, formationId: away.formationId, tacticId: away.tacticId, players: away.players.map(({ id, name, shortName, position, base }) => ({ id, name, shortName, position, base: { x: 100 - base.x, y: 100 - base.y } })) }
    },
    score: { home: scoreOf(state, "home"), away: scoreOf(state, "away") },
    stats,
    ratings,
    frames,
    events: state.events,
    moments,
    highlights: moments
  };
}
