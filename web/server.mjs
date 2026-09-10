import http from "node:http";
import crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  formationsConfig,
  formations,
  balance,
  tactics,
  draftPlaystyles,
  opponentsConfig,
  publicData,
  publicPlayers,
  enginePlayers,
  draftPoolsConfig,
  draftPoolAssignments,
  draftEligiblePlayers,
  allRegisteredPositions,
  createVoucherSequence,
  isLegacyDraftRun,
  voucherSummary,
  publicPlayerDto,
  publicPlaystyleDto,
  samplePlayerForm,
  playerFormFor,
  effectivePlayerFormFor,
  playerAttributeModifiersFor,
  safeRun,
  validateDraftLineup,
  validateLineup,
  calculateChemistry,
  shuffle
} from "./lib/context.mjs";
import { initializeSeason, simulateSeasonRound } from "./lib/engine.mjs";
import { createJsonWriteQueue, recoverLegacyTemp } from "./lib/json-store.mjs";
import { simulateContinuousPvpMatch as simulatePvpMatch } from "./lib/continuous-pvp-match.mjs";

const webRoot = import.meta.url
  ? path.resolve(path.dirname(fileURLToPath(import.meta.url)))
  : process.cwd();
const publicDir = path.join(webRoot, "public");
const configuredRuntimeDir = String(process.env.FM26_RUNTIME_DIR ?? "").trim();
const runtimeDir = configuredRuntimeDir
  ? path.resolve(configuredRuntimeDir)
  : process.env.NODE_TEST_CONTEXT
    ? path.join(os.tmpdir(), "fm26-fantasy-draft-tests", String(process.pid))
    : path.join(webRoot, "runtime");
const runsFile = path.join(runtimeDir, "runs.json");
const pvpRoomsFile = path.join(runtimeDir, "pvp-rooms.json");
export const PVP_ROOM_RETENTION_MS = 24 * 60 * 60 * 1000;
const localRuns = new Map();
const localPvpRooms = new Map();
const runtimeContext = new AsyncLocalStorage();

function pvpRoomIsCurrent(room, now = Date.now()) {
  const createdAt = Date.parse(room?.createdAt ?? "");
  return Number.isFinite(createdAt) && now - createdAt <= PVP_ROOM_RETENTION_MS;
}

const enqueueRunsWrite = createJsonWriteQueue(runsFile);
const enqueuePvpRoomsWrite = createJsonWriteQueue(pvpRoomsFile);

const localRuntime = {
  runs: localRuns,
  pvpRooms: localPvpRooms,
  allowForcedIds: false,
  persistRuns: (values) => enqueueRunsWrite(() => ({ version: 1, runs: values })),
  persistPvpRooms: (values) => enqueuePvpRoomsWrite(() => ({ version: 1, rooms: values }))
};

function activeRuntime() {
  return runtimeContext.getStore() ?? localRuntime;
}

function runsStore() {
  return activeRuntime().runs;
}

function pvpRoomsStore() {
  return activeRuntime().pvpRooms;
}

function persistRuns() {
  const runtime = activeRuntime();
  return runtime.persistRuns([...runtime.runs.values()]);
}

function persistPvpRooms() {
  const runtime = activeRuntime();
  for (const [code, room] of runtime.pvpRooms) {
    if (!pvpRoomIsCurrent(room)) runtime.pvpRooms.delete(code);
  }
  return runtime.persistPvpRooms([...runtime.pvpRooms.values()]);
}

export function createRuntimeStore({
  run = null,
  room = null,
  persistRun,
  persistRoom,
  allowForcedIds = false,
  defer = null
} = {}) {
  return {
    runs: new Map(run ? [[run.id, run]] : []),
    pvpRooms: new Map(room ? [[room.code, room]] : []),
    allowForcedIds,
    forcedRunId: null,
    forcedPvpCode: null,
    defer,
    persistRuns: persistRun ?? (async () => {}),
    persistPvpRooms: persistRoom ?? (async () => {})
  };
}

let localRuntimeReady;
function initializeLocalRuntime() {
  localRuntimeReady ??= (async () => {
    await fs.mkdir(runtimeDir, { recursive: true });
    for (const [filePath, validate, label] of [
      [runsFile, (stored) => Array.isArray(stored?.runs), "运行记录"],
      [pvpRoomsFile, (stored) => Array.isArray(stored?.rooms), "PVP房间记录"]
    ]) {
      try {
        const recovery = await recoverLegacyTemp(filePath, validate);
        if (recovery.recovered) console.warn(`${label}已从上次中断的临时文件恢复`);
      } catch (error) {
        console.error(`${label}临时文件恢复失败`, error);
      }
    }
    try {
      const stored = JSON.parse(await fs.readFile(runsFile, "utf8"));
      for (const run of stored.runs ?? []) {
        if (run.status === "simulating" && !run.season) run.status = "ready";
        run.draftLineup ??= { starters: [], tacticId: "balanced" };
        run.currentCandidateSlotIds ??= {};
        run.playerFormById ??= {};
        run.playstyleId ??= null;
        delete run.draftLineup.bench;
        if (run.lineup) delete run.lineup.bench;
        run.seasonProgress ??= run.status === "completed" ? 38 : 0;
        localRuns.set(run.id, run);
      }
    } catch (error) {
      if (error.code !== "ENOENT") console.error("运行记录读取失败", error);
    }
    try {
      const stored = JSON.parse(await fs.readFile(pvpRoomsFile, "utf8"));
      for (const room of stored.rooms ?? []) {
        if (!pvpRoomIsCurrent(room)) continue;
        for (const player of Object.values(room.players ?? {})) if (player) player.playerFormById ??= {};
        localPvpRooms.set(room.code, room);
      }
    } catch (error) {
      if (error.code !== "ENOENT") console.error("PVP房间记录读取失败", error);
    }
  })();
  return localRuntimeReady;
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1_000_000) throw httpError(413, "请求体过大");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw httpError(400, "JSON格式无效");
  }
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  response.end(JSON.stringify(payload));
}

function matchRunPath(pathname, suffix = "") {
  return pathname.match(new RegExp(`^/api/runs/([a-f0-9]{32})${suffix}$`));
}

function matchPvpPath(pathname, suffix = "") {
  return pathname.match(new RegExp(`^/api/pvp/rooms/([A-Z0-9]{6})${suffix}$`));
}

function pvpPlayer(token, { displayName = "玩家", isCpu = false } = {}) {
  return {
    token,
    displayName,
    isCpu,
    joinedAt: new Date().toISOString(),
    formationId: null,
    squadIds: [],
    currentCandidateIds: [],
    currentCandidateSlotIds: {},
    playerFormById: {},
    draftLineup: { starters: [], tacticId: "balanced" },
    lineup: null,
    chemistry: null,
    ready: false,
    enteredMatch: false,
    rematchRequested: false
  };
}

function pvpCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const forcedCode = activeRuntime().allowForcedIds
    ? String(activeRuntime().forcedPvpCode ?? "").trim().toUpperCase()
    : "";
  if (forcedCode) {
    if (!/^[A-Z0-9]{6}$/.test(forcedCode)) throw httpError(400, "PVP房间号无效");
    if (pvpRoomsStore().has(forcedCode)) throw httpError(409, "PVP房间号冲突，请重试");
    return forcedCode;
  }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    let code = "";
    for (let index = 0; index < 6; index += 1) code += alphabet[crypto.randomInt(alphabet.length)];
    if (!pvpRoomsStore().has(code)) return code;
  }
  throw httpError(503, "暂时无法创建房间，请重试");
}

function requirePvpRoom(code) {
  const room = pvpRoomsStore().get(code);
  if (!room) throw httpError(404, "PVP房间不存在");
  return room;
}

function requirePvpSide(room, token) {
  if (!token) throw httpError(401, "缺少PVP身份");
  const side = room.players.host?.token === token
    ? "host"
    : room.players.guest?.token === token ? "guest" : null;
  if (!side) throw httpError(403, "你不是该房间的玩家");
  return { side, player: room.players[side] };
}

function pvpDraftAdapter(room, player) {
  return {
    formationId: player.formationId,
    poolSequence: room.poolSequence,
    squadIds: player.squadIds,
    currentCandidateIds: player.currentCandidateIds,
    currentCandidateSlotIds: player.currentCandidateSlotIds,
    playerFormById: player.playerFormById,
    draftLineup: player.draftLineup
  };
}

function safePvpPlayer(player, room, own) {
  if (!player) return null;
  const formation = player.formationId ? formations.get(player.formationId) : null;
  return {
    joined: true,
    displayName: player.displayName ?? (player.isCpu ? "AI 对手" : "玩家"),
    isCpu: Boolean(player.isCpu),
    formationId: player.formationId,
    formationSlots: formation ? formation.slots.map((position, index) => ({ slotId: `starter_${index + 1}`, position, label: formation.slotLabels[index] })) : [],
    draftCount: player.squadIds.length,
    ready: player.ready,
    enteredMatch: player.enteredMatch,
    rematchRequested: Boolean(player.rematchRequested),
    squad: own ? player.squadIds.map((id) => publicPlayerDto(publicPlayers.get(id), playerFormFor(player, id))) : [],
    currentCandidates: own ? player.currentCandidateIds.map((id) => ({ ...publicPlayerDto(publicPlayers.get(id), playerFormFor(player, id)), compatibleSlotIds: player.currentCandidateSlotIds[id] ?? [] })) : [],
    draftLineup: own ? player.draftLineup : null,
    lineup: own ? player.lineup : null,
    chemistry: own ? player.chemistry : null,
    draftRound: Math.min(11, player.squadIds.length + 1),
    currentVoucher: own && player.currentCandidateIds.length ? {
      round: player.squadIds.length + 1,
      pool: room.poolSequence[player.squadIds.length],
      label: draftPoolsConfig.poolLabels[room.poolSequence[player.squadIds.length]]
    } : null,
    voucherSummary: own ? voucherSummary(pvpDraftAdapter(room, player)) : null
  };
}

function resetPvpPlayer(player) {
  player.squadIds = [];
  player.currentCandidateIds = [];
  player.currentCandidateSlotIds = {};
  player.playerFormById = {};
  player.draftLineup = { starters: [], tacticId: "balanced" };
  player.lineup = null;
  player.chemistry = null;
  player.ready = false;
  player.enteredMatch = false;
  player.rematchRequested = false;
}

function resetPvpRoomForDraft(room) {
  room.poolSequence = createVoucherSequence();
  resetPvpPlayer(room.players.host);
  resetPvpPlayer(room.players.guest);
  room.match = null;
  room.matchStartedAt = null;
  room.status = "drafting";
  if (room.players.guest.isCpu) {
    completeCpuDraft(room, room.players.guest);
  }
}

function aiCandidateScore(player, position, existingIds, form) {
  const ratings = player.summaryRatings ?? {};
  const positionWeights = {
    GK: { "拦截射门": 0.32, "精神": 0.18, "指挥防守": 0.16, "制空": 0.12, "身体": 0.1, "大脚开球": 0.07, "速度": 0.03, "意外性": 0.02 },
    CB: { "防守": 0.38, "身体": 0.22, "制空": 0.18, "精神": 0.14, "速度": 0.08 },
    LB: { "防守": 0.25, "速度": 0.2, "身体": 0.15, "技术": 0.12, "视野": 0.1, "进攻": 0.1, "精神": 0.08 },
    RB: { "防守": 0.25, "速度": 0.2, "身体": 0.15, "技术": 0.12, "视野": 0.1, "进攻": 0.1, "精神": 0.08 },
    LWB: { "速度": 0.22, "身体": 0.16, "进攻": 0.15, "防守": 0.15, "技术": 0.12, "视野": 0.1, "精神": 0.1 },
    RWB: { "速度": 0.22, "身体": 0.16, "进攻": 0.15, "防守": 0.15, "技术": 0.12, "视野": 0.1, "精神": 0.1 },
    CDM: { "防守": 0.25, "精神": 0.18, "身体": 0.16, "视野": 0.15, "技术": 0.12, "制空": 0.08, "速度": 0.06 },
    CM: { "视野": 0.22, "技术": 0.2, "精神": 0.16, "身体": 0.12, "进攻": 0.12, "防守": 0.1, "速度": 0.08 },
    CAM: { "技术": 0.25, "视野": 0.22, "进攻": 0.2, "精神": 0.12, "速度": 0.11, "身体": 0.1 },
    LM: { "速度": 0.22, "技术": 0.2, "进攻": 0.18, "视野": 0.16, "身体": 0.12, "精神": 0.12 },
    RM: { "速度": 0.22, "技术": 0.2, "进攻": 0.18, "视野": 0.16, "身体": 0.12, "精神": 0.12 },
    LW: { "速度": 0.24, "技术": 0.23, "进攻": 0.22, "视野": 0.13, "精神": 0.1, "身体": 0.08 },
    RW: { "速度": 0.24, "技术": 0.23, "进攻": 0.22, "视野": 0.13, "精神": 0.1, "身体": 0.08 },
    ST: { "进攻": 0.32, "速度": 0.17, "身体": 0.16, "制空": 0.13, "技术": 0.1, "精神": 0.08, "视野": 0.04 }
  };
  const weights = positionWeights[position] ?? {};
  const rating = Object.entries(weights).reduce((sum, [name, weight]) => sum + Number(ratings[name] ?? 50) * weight, 0);
  const familiarity = player.positions.primary.includes(position) ? 1 : player.positions.secondary.includes(position) ? 0.95 : 0.9;
  const teammates = existingIds.map((id) => publicPlayers.get(String(id))).filter(Boolean);
  const chemistryPotential = teammates.some((teammate) => teammate.nation === player.nation) ? 0.8 : 0;
  return (rating * familiarity + chemistryPotential) * (1 + Number(form?.abilityModifierPct ?? 0) / 100);
}

function completeCpuDraft(room, cpu) {
  while (cpu.squadIds.length < balance.draft.maxSquadSize) {
    const adapter = pvpDraftAdapter(room, cpu);
    drawDraftCandidates(adapter, null);
    cpu.currentCandidateIds = adapter.currentCandidateIds;
    cpu.currentCandidateSlotIds = adapter.currentCandidateSlotIds;
    const choices = cpu.currentCandidateIds.flatMap((playerId) => {
      const player = publicPlayers.get(playerId);
      return (cpu.currentCandidateSlotIds[playerId] ?? []).map((slotId) => {
        const slot = openFormationSlots(pvpDraftAdapter(room, cpu)).find((item) => item.slotId === slotId);
        return { playerId, slotId, score: aiCandidateScore(player, slot.position, cpu.squadIds, playerFormFor(cpu, playerId)) };
      });
    }).sort((left, right) => right.score - left.score);
    if (!choices.length) throw httpError(409, "AI无法完成当前池券阵容，请重新创建房间");
    const choice = choices[0];
    const pickAdapter = pvpDraftAdapter(room, cpu);
    applyDraftPick(pickAdapter, choice.playerId, choice.slotId);
    cpu.squadIds = pickAdapter.squadIds;
    cpu.draftLineup = pickAdapter.draftLineup;
    cpu.currentCandidateIds = [];
    cpu.currentCandidateSlotIds = {};
  }
  cpu.lineup = { starters: cpu.draftLineup.starters, tacticId: "balanced" };
  cpu.draftLineup = cpu.lineup;
  cpu.chemistry = calculateChemistry(cpu.lineup.starters);
  cpu.ready = true;
  cpu.enteredMatch = true;
}

function pvpRoomView(room, token) {
  const identity = requirePvpSide(room, token);
  const opponentSide = identity.side === "host" ? "guest" : "host";
  const bothEntered = Boolean(room.players.host?.enteredMatch && room.players.guest?.enteredMatch);
  if (room.match && bothEntered && !room.matchStartedAt) {
    room.matchStartedAt = new Date(Date.now() + 1500).toISOString();
    room.status = "playing";
    const pendingPersistence = persistPvpRooms();
    activeRuntime().defer?.(pendingPersistence);
    void pendingPersistence;
  }
  const match = room.match ? {
    ...room.match,
    playback: {
      status: room.matchStartedAt ? "playing" : "waiting_for_both",
      startedAt: room.matchStartedAt,
      bothEntered
    }
  } : null;
  return {
    mode: "pvp",
    code: room.code,
    side: identity.side,
    status: room.status,
    player: safePvpPlayer(identity.player, room, true),
    opponent: safePvpPlayer(room.players[opponentSide], room, false),
    match
  };
}

function requireRun(id) {
  const run = runsStore().get(id);
  if (!run) throw httpError(404, "选秀局不存在或已经重开");
  return run;
}

function openFormationSlots(run) {
  const formation = formations.get(run.formationId);
  const occupied = new Set((run.draftLineup?.starters ?? []).map((starter) => starter.slotId));
  return formation.slots.map((position, index) => ({
    slotId: `starter_${index + 1}`,
    position,
    label: formation.slotLabels[index]
  })).filter((slot) => !occupied.has(slot.slotId));
}

function poolCanFillPositions(players, positions) {
  if (!positions.length) return true;
  const positionOrder = positions
    .map((position, index) => ({ position, index }))
    .sort((left, right) => (
      players.filter((player) => allRegisteredPositions(player).includes(left.position)).length
      - players.filter((player) => allRegisteredPositions(player).includes(right.position)).length
    ));
  const matchedPlayerToPosition = new Map();
  const tryMatch = (positionIndex, seenPlayers) => {
    const position = positionOrder[positionIndex].position;
    for (const player of players) {
      const playerId = String(player.id);
      if (seenPlayers.has(playerId) || !allRegisteredPositions(player).includes(position)) continue;
      seenPlayers.add(playerId);
      const previousPosition = matchedPlayerToPosition.get(playerId);
      if (previousPosition === undefined || tryMatch(previousPosition, seenPlayers)) {
        matchedPlayerToPosition.set(playerId, positionIndex);
        return true;
      }
    }
    return false;
  };
  return positionOrder.every((_, index) => tryMatch(index, new Set()));
}

function remainingDraftIsFeasible(run, assumedPlayerId, assumedSlotId) {
  const remainingSlots = openFormationSlots(run).filter((slot) => slot.slotId !== assumedSlotId);
  const futurePools = run.poolSequence.slice(run.squadIds.length + 1);
  if (remainingSlots.length !== futurePools.length) return false;
  const remainingPoolCounts = Object.fromEntries(Object.keys(draftPoolsConfig.poolLabels).map((pool) => [
    pool,
    futurePools.filter((item) => item === pool).length
  ]));
  const excluded = new Set([...run.squadIds, String(assumedPlayerId)]);
  const availableByPool = Object.fromEntries(Object.keys(draftPoolsConfig.poolLabels).map((pool) => [
    pool,
    draftEligiblePlayers.filter((player) => (
      draftPoolAssignments.get(String(player.id)) === pool && !excluded.has(String(player.id))
    ))
  ]));
  const assignments = Object.fromEntries(Object.keys(draftPoolsConfig.poolLabels).map((pool) => [pool, []]));
  const partialCache = new Map();
  const poolAssignmentWorks = (pool) => {
    const key = `${pool}:${[...assignments[pool]].sort().join(",")}`;
    if (!partialCache.has(key)) {
      partialCache.set(key, poolCanFillPositions(availableByPool[pool], assignments[pool]));
    }
    return partialCache.get(key);
  };
  const orderedSlots = [...remainingSlots].sort((left, right) => {
    const leftOptions = Object.keys(remainingPoolCounts).filter((pool) => (
      availableByPool[pool].some((player) => allRegisteredPositions(player).includes(left.position))
    )).length;
    const rightOptions = Object.keys(remainingPoolCounts).filter((pool) => (
      availableByPool[pool].some((player) => allRegisteredPositions(player).includes(right.position))
    )).length;
    return leftOptions - rightOptions;
  });
  const assignSlot = (index) => {
    if (index >= orderedSlots.length) return true;
    const position = orderedSlots[index].position;
    for (const pool of Object.keys(remainingPoolCounts)) {
      if (remainingPoolCounts[pool] <= 0) continue;
      assignments[pool].push(position);
      remainingPoolCounts[pool] -= 1;
      if (poolAssignmentWorks(pool) && assignSlot(index + 1)) return true;
      remainingPoolCounts[pool] += 1;
      assignments[pool].pop();
    }
    return false;
  };
  return assignSlot(0);
}

function safeSlotsForCandidate(run, player) {
  const positions = new Set(allRegisteredPositions(player));
  return openFormationSlots(run)
    .filter((slot) => positions.has(slot.position))
    .filter((slot) => remainingDraftIsFeasible(run, String(player.id), slot.slotId))
    .map((slot) => slot.slotId);
}

function drawDraftCandidates(run) {
  const pool = run.poolSequence[run.squadIds.length];
  if (!draftPoolsConfig.poolLabels[pool]) throw httpError(409, "本轮池券数据无效，请重新开始");
  const openSlots = openFormationSlots(run);
  const openPositions = new Set(openSlots.map((slot) => slot.position));
  const selected = new Set(run.squadIds);
  const eligible = draftEligiblePlayers.filter((player) => {
    const playerId = String(player.id);
    if (selected.has(playerId) || draftPoolAssignments.get(playerId) !== pool) return false;
    const positions = allRegisteredPositions(player);
    return positions.some((position) => openPositions.has(position));
  });
  if (!eligible.length) throw httpError(409, "本轮池中没有能填补当前空位的球员，请重新开始");
  const safeCandidates = [];
  run.currentCandidateSlotIds = {};
  for (const player of shuffle(eligible)) {
    const safeSlotIds = safeSlotsForCandidate(run, player);
    if (!safeSlotIds.length) continue;
    const playerId = String(player.id);
    safeCandidates.push(playerId);
    run.currentCandidateSlotIds[playerId] = safeSlotIds;
    if (safeCandidates.length >= draftPoolsConfig.candidateCount) break;
  }
  if (!safeCandidates.length) throw httpError(409, "本轮池券无法组成完整11人阵容，请重新开始");
  run.currentCandidateIds = safeCandidates;
  run.playerFormById ??= {};
  for (const playerId of safeCandidates) run.playerFormById[playerId] ??= samplePlayerForm();
  return pool;
}

function applyDraftPick(run, playerId, slotId) {
  if (!run.currentCandidateIds.includes(playerId)) throw httpError(400, "该球员不在当前候选中");
  if (run.squadIds.includes(playerId)) throw httpError(409, "该球员已经入队");
  if (run.squadIds.length >= balance.draft.maxSquadSize) throw httpError(409, "阵容人数已满");
  const slot = openFormationSlots(run).find((item) => item.slotId === slotId);
  const player = publicPlayers.get(playerId);
  if (!slot) throw httpError(400, "请选择一个空缺阵容位置");
  if (!player || !allRegisteredPositions(player).includes(slot.position)) throw httpError(400, "该球员不能胜任所选位置");
  if (!run.currentCandidateSlotIds?.[playerId]?.includes(slotId) || !remainingDraftIsFeasible(run, playerId, slotId)) {
    throw httpError(409, "放入该位置会导致后续池券无法凑齐11人，请选择候选卡列出的其他位置");
  }
  run.squadIds.push(playerId);
  run.draftLineup.starters.push({ slotId: slot.slotId, position: slot.position, playerId });
  run.currentCandidateIds = [];
  run.currentCandidateSlotIds = {};
}

const eventChoice = (id, label, description, positiveChancePct, positiveEffect, negativeEffect, positiveText, negativeText) => ({
  id, label, description, positiveChancePct, positiveEffect, negativeEffect, positiveText, negativeText
});

const seasonEventTemplates = [
  { id: "striker_drought", title: "锋线球荒", description: "这名前锋已经连续五轮没有进球，外界开始质疑他的首发位置。", targetKind: "striker_drought", choices: [
    eventChoice("keep_attacking_box", "继续让他攻击禁区", "保持跑位和射门职责，公开表达对他的信任。", 54, { formDelta: 3, attributeModifiers: { "进攻": 14, "精神": 8 } }, { formDelta: -3, attributeModifiers: { "进攻": -10 } }, "信任让他重新找回了门前感觉。", "持续的进球压力让他的处理更加僵硬。"),
    eventChoice("use_link_forward", "让他更多回撤接应", "减少终结压力，让他先通过串联参与比赛。", 68, { formDelta: 2, attributeModifiers: { "视野": 12, "技术": 10 } }, { formDelta: -2, attributeModifiers: { "进攻": -8 } }, "新的接应职责帮助他重新融入进攻。", "频繁回撤让他离球门越来越远。")
  ] },
  { id: "defensive_slump", title: "防线连续失球", description: "球队已经连续三场丢球，防线的站位和沟通受到质疑。", targetKind: "defensive_slump", scope: "team", choices: [
    eventChoice("defensive_drills", "增加防守合练", "压缩训练中的进攻内容，集中修正防线距离。", 60, { attributeModifiers: { "防守": 9, "精神": 6 } }, { attributeModifiers: { "进攻": -7, "身体": -5 } }, "防线在反复演练后重新建立了默契。", "训练重心失衡让球队的整体节奏更加沉重。"),
    eventChoice("hold_higher_line", "坚持主动前压", "不退回禁区，要求中后场继续向前压缩空间。", 46, { attributeModifiers: { "防守": 12, "速度": 8 } }, { attributeModifiers: { "防守": -12 }, formDelta: -1 }, "全队执行前压更加坚决，防线恢复了侵略性。", "前压时机依旧混乱，队员的信心继续下降。")
  ] },
  { id: "goalkeeper_mistake", title: "门将信任危机", description: "门将近期的失误直接造成了失球，他希望得到教练组的明确态度。", targetKind: "goalkeeper_mistake", choices: [
    eventChoice("back_goalkeeper", "公开继续信任门将", "赛前确认他的首发位置，让他按原有方式处理球。", 55, { formDelta: 3, attributeModifiers: { "拦截射门": 12, "精神": 10 } }, { formDelta: -3 }, "公开支持帮助他摆脱了失误阴影。", "额外关注放大了他的心理负担。"),
    eventChoice("simplify_goalkeeper", "要求以门线防守为先", "缩小出击范围并减少后场短传，先守住禁区。", 70, { formDelta: 2, attributeModifiers: { "拦截射门": 9, "精神": 8 } }, { attributeModifiers: { "大脚开球": -10, "意外性": -8 } }, "更清晰的要求让他的处理恢复稳定。", "过度谨慎让他的出球变得迟疑。")
  ] },
  { id: "losing_run", title: "连败后的训练安排", description: "球队已经遭遇三连败，更衣室对下一阶段训练方式出现分歧。", targetKind: "losing_run", scope: "team", choices: [
    eventChoice("closed_training", "进行封闭训练", "减少外界干扰，集中解决比赛中的反复失误。", 56, { formDelta: 1, attributeModifierPct: 7 }, { formDelta: -1, attributeModifierPct: -6 }, "封闭训练让全队重新统一了比赛思路。", "高压环境让更衣室气氛进一步紧张。"),
    eventChoice("restore_confidence", "安排轻量恢复课", "暂时降低负荷，通过有球训练找回信心。", 68, { formDelta: 2 }, { attributeModifiers: { "身体": -8, "防守": -5 } }, "放松的训练内容让球员重新敢于处理球。", "训练强度下降后，球队在对抗中显得更加迟钝。")
  ] },
  { id: "winning_run", title: "连胜后的松懈", description: "球队取得三连胜，但训练中的专注度已经出现下降。", targetKind: "winning_run", scope: "team", choices: [
    eventChoice("raise_standards", "提高训练要求", "提醒球员连胜不代表问题已经消失。", 58, { attributeModifierPct: 6, formDelta: 1 }, { formDelta: -1, attributeModifiers: { "身体": -6 } }, "训练要求让全队保持了比赛强度。", "突然加码让部分球员产生了抵触。"),
    eventChoice("reward_squad", "给全队放一天假", "让球员短暂离开足球，缓解连续比赛的压力。", 66, { formDelta: 2, attributeModifiers: { "身体": 6 } }, { formDelta: -2 }, "短暂休息让球队以更好的精神状态回归。", "假期延续了队内的松懈情绪。")
  ] },
  { id: "confidence_boost", title: "核心球员提出战术要求", description: "球队近期表现最突出的球员希望战术更多向自己的活动区域倾斜。", targetKind: "core_player", choices: [
    eventChoice("accept_tactical_request", "接受他的战术建议", "让球队在进攻中更频繁地寻找他。", 52, { formDelta: 3, attributeModifiers: { "进攻": 12, "视野": 10 } }, { formDelta: -2, attributeModifiers: { "防守": -8 } }, "更高的战术参与度释放了他的影响力。", "过度集中的球权让他和球队都失去了平衡。"),
    eventChoice("keep_team_plan", "坚持现有比赛计划", "认可他的作用，但不为个人改变整体踢法。", 67, { formDelta: 2, attributeModifiers: { "精神": 8 } }, { formDelta: -3 }, "明确的沟通让他接受了球队安排。", "他的要求没有得到满足，比赛情绪明显受挫。")
  ] },
  { id: "dressing_room_friction", title: "更衣室矛盾", description: "两名缺少场上默契的球员在训练中发生了激烈争执。", targetKind: "low_chemistry_pair", choices: [
    eventChoice("mediate_players", "安排两人单独沟通", "让队长在场，要求双方说明各自的比赛诉求。", 66, { formDelta: 2, attributeModifiers: { "精神": 8 }, includeSecondary: true }, { formDelta: -2, includeSecondary: true }, "面对面的沟通缓和了双方关系。", "谈话没有消除分歧，两人的情绪继续恶化。"),
    eventChoice("fine_both_players", "同时处罚两名球员", "按队规处理训练冲突，不偏向任何一方。", 52, { attributeModifiers: { "精神": 12 }, includeSecondary: true }, { formDelta: -3, includeSecondary: true }, "明确的纪律要求让两人重新专注于比赛。", "处罚让双方都认为自己没有得到公正对待。")
  ] },
  { id: "derby_preparation", title: "关键战备战", description: "下一轮将面对积分榜前列球队，这场比赛可能直接影响排名。", targetKind: "big_match", scope: "team", choices: [
    eventChoice("study_opponent", "进行针对性演练", "围绕对手的主要进攻方式调整训练内容。", 58, { attributeModifiers: { "防守": 8, "精神": 8, "视野": 6 } }, { attributeModifiers: { "进攻": -7, "技术": -5 } }, "针对性准备让球队在关键战前更加从容。", "过多战术信息限制了球员的自然发挥。"),
    eventChoice("keep_routine", "保持日常备战节奏", "不因比赛分量改变训练，让球员按熟悉方式准备。", 67, { formDelta: 1, attributeModifierPct: 5 }, { formDelta: -1, attributeModifierPct: -5 }, "熟悉的备战节奏稳定了全队状态。", "常规训练没能让球队进入关键战强度。")
  ] },
  { id: "winter_arrival", title: "冬窗新援融入", description: "冬窗加盟的球员正在适应新的队友和比赛要求。", targetKind: "winter_arrival", choices: [
    eventChoice("simple_winter_role", "先安排简单职责", "减少复杂要求，让他通过比赛逐步建立默契。", 72, { formDelta: 2, attributeModifiers: { "精神": 8 } }, { attributeModifiers: { "视野": -7, "技术": -5 } }, "清晰的职责帮助新援迅速融入球队。", "过于保守的安排限制了他的特点。"),
    eventChoice("immediate_key_role", "立即承担重要职责", "让他直接进入球队的主要进攻或防守环节。", 46, { formDelta: 3, attributeModifierPct: 12 }, { formDelta: -3, attributeModifierPct: -10 }, "重任激发了新援的比赛欲望。", "适应压力让他在场上显得无所适从。")
  ] },
  { id: "fullback_duty", title: "边后卫攻守职责", description: "教练组需要决定这名边后卫接下来更侧重前插还是防守站位。", targetKind: "fullback", choices: [
    eventChoice("encourage_overlap", "鼓励继续套边前插", "让他大胆越过边锋，为边路进攻提供宽度。", 55, { attributeModifiers: { "进攻": 14, "速度": 10, "身体": 6 } }, { attributeModifiers: { "防守": -12 }, formDelta: -1 }, "持续前插让他成为了边路的重要进攻点。", "频繁前压暴露了他身后的防守空间。"),
    eventChoice("hold_position", "要求优先保护身后", "减少无球前插，把站位和回防放在首位。", 67, { attributeModifiers: { "防守": 13, "精神": 8 } }, { attributeModifiers: { "进攻": -10, "速度": -5 } }, "更稳定的站位提高了他的防守效率。", "严格的站位要求削弱了他的比赛活力。")
  ] },
  { id: "set_piece_focus", title: "定位球主罚权", description: "队内有多名定位球能力突出的球员，教练组需要重新确定主罚顺序。", targetKind: "set_piece_pair", choices: [
    eventChoice("keep_set_piece_taker", "维持现有主罚顺序", "继续由近期状态更好的球员承担主要定位球。", 64, { formDelta: 2, attributeModifiers: { "进攻": 8, "技术": 8 } }, { formDelta: -2, includeSecondary: true }, "清晰的顺位让主罚球员更加自信。", "竞争者对主罚顺位产生了不满。"),
    eventChoice("rotate_set_pieces", "根据比赛轮换主罚", "让两名球员按照距离和角度分担定位球。", 55, { attributeModifiers: { "进攻": 10, "视野": 8 }, includeSecondary: true }, { formDelta: -2, attributeModifiers: { "精神": -6 }, includeSecondary: true }, "分工让两人的定位球特点都得到发挥。", "不固定的顺序让两人在场上出现了犹豫。")
  ] },
  { id: "media_pressure", title: "媒体连续批评", description: "一名球员近期的表现成为媒体批评焦点。", targetKind: "low_rating", choices: [
    eventChoice("shield_from_media", "由主教练公开保护", "把责任留给教练组，要求外界给球员时间。", 70, { formDelta: 2, attributeModifiers: { "精神": 8 } }, { formDelta: -2 }, "主教练的支持让他重新专注于比赛。", "持续关注仍然影响了他的信心。"),
    eventChoice("challenge_player", "要求球员用表现回应", "不回避批评，明确要求他提高比赛水准。", 47, { formDelta: 3, attributeModifierPct: 10 }, { formDelta: -3, attributeModifierPct: -8 }, "直接的要求激发了他的竞争心。", "公开施压让他的比赛负担更重。")
  ] },
  { id: "contract_talk", title: "合同传闻", description: "关于一名球员未来的传闻开始影响他的注意力。", targetKind: "any", choices: [
    eventChoice("talk_privately", "与球员单独沟通", "说明球队态度，让他把注意力放回比赛。", 67, { formDelta: 2, attributeModifiers: { "精神": 7 } }, { formDelta: -2 }, "坦诚沟通消除了他的场外顾虑。", "谈话没有给他想要的确定答案。"),
    eventChoice("leave_to_board", "交由管理层处理", "教练组不参与谈判，只讨论训练和比赛。", 51, { formDelta: 2, attributeModifierPct: 7 }, { formDelta: -3 }, "明确的职责边界让他重新专注。", "迟迟没有回应让他的情绪继续波动。")
  ] },
  { id: "fixture_fatigue", title: "体能负荷", description: "一名主力在训练中显得疲惫，体能团队建议调整安排。", targetKind: "low_stamina", choices: [
    eventChoice("reduce_training_load", "降低个人训练负荷", "减少高强度训练，把重点放在身体恢复。", 72, { formDelta: 2, attributeModifiers: { "身体": 12, "速度": 6 } }, { attributeModifiers: { "技术": -7, "精神": -5 } }, "恢复计划让他的身体重新充满活力。", "脱离合练让他的比赛感觉变得迟钝。"),
    eventChoice("maintain_intensity", "继续参加完整合练", "保持球队整体训练节奏，不做单独安排。", 44, { formDelta: 3, attributeModifierPct: 11 }, { formDelta: -2, attributeModifiers: { "身体": -14, "速度": -8 } }, "连续训练让他保持了极佳的比赛强度。", "疲劳积累开始明显影响他的发挥。")
  ] },
  { id: "homesickness", title: "思乡情绪", description: "长期远离家人让一名外籍球员的情绪持续低落。", targetKind: "foreign_player", choices: [
    eventChoice("grant_home_visit", "批准短暂回家探亲", "让他利用休息日陪伴家人，再返回球队。", 73, { formDelta: 3, attributeModifiers: { "精神": 8 } }, { attributeModifiers: { "身体": -8, "技术": -5 } }, "短暂团聚让他卸下了长期积累的压力。", "往返行程打乱了他的训练节奏。"),
    eventChoice("support_inside_club", "安排队友陪伴", "由同语言队友和工作人员帮助他适应生活。", 61, { formDelta: 2, attributeModifierPct: 8 }, { formDelta: -2 }, "队内支持让他重新找到归属感。", "俱乐部的帮助没有解决他的思乡情绪。")
  ] },
  { id: "relationship_breakup", title: "感情风波", description: "一名球员刚刚结束长期感情关系，训练状态出现明显波动。", targetKind: "any", choices: [
    eventChoice("personal_leave", "给他两天私人假期", "允许他暂时处理生活问题，再回到球队。", 69, { formDelta: 3, attributeModifiers: { "精神": 8 } }, { attributeModifiers: { "身体": -7, "技术": -5 } }, "短暂离队让他整理好了情绪。", "离开训练场后，他更难找回比赛节奏。"),
    eventChoice("keep_training", "让他维持正常训练", "用规律的球队生活帮助他转移注意力。", 52, { formDelta: 2, attributeModifierPct: 9 }, { formDelta: -3, attributeModifiers: { "精神": -10 } }, "训练让他把注意力重新放回足球。", "私人情绪继续干扰着他的比赛判断。")
  ] },
  { id: "training_breakthrough", title: "专项训练突破", description: "训练团队认为一名球员近期出现了可以重点强化的技术环节。", targetKind: "any", choices: [
    eventChoice("specialist_training", "安排专项加练", "围绕他当前的位置增加针对性训练。", 56, { attributeModifierPct: 14 }, { formDelta: -2, attributeModifierPct: -9 }, "专项加练带来了明显进步。", "额外负荷打乱了他的比赛节奏。"),
    eventChoice("keep_training_plan", "维持原训练计划", "保持既定强度，让他按原有节奏备战。", 73, { formDelta: 2, attributeModifierPct: 8 }, { attributeModifierPct: -6 }, "稳定的训练节奏让他渐入佳境。", "原有训练内容没有解决他的问题。")
  ] },
  { id: "captaincy_call", title: "队长出面沟通", description: "一名球员近期情绪不佳，队长提出由自己先和他谈一谈。", targetKind: "low_form", choices: [
    eventChoice("captain_talk", "让队长负责沟通", "由更衣室内部先解决问题，教练组暂不介入。", 66, { formDelta: 3, attributeModifiers: { "精神": 9 } }, { formDelta: -2 }, "队长的沟通让他重新感受到队内支持。", "更衣室谈话没有触及真正的问题。"),
    eventChoice("manager_talk", "由主教练直接谈话", "明确指出问题，同时保证继续给予比赛机会。", 55, { formDelta: 3, attributeModifierPct: 9 }, { formDelta: -3 }, "直接谈话激发了他的比赛回应。", "强硬态度让他更加封闭。")
  ] },
  { id: "tactical_role", title: "调整场上职责", description: "分析团队认为这名球员目前承担的比赛内容可以进一步调整。", targetKind: "any", choices: [
    eventChoice("fix_tactical_role", "明确活动区域", "限制无效跑动，让他集中完成最重要的场上任务。", 65, { attributeModifiers: { "精神": 11, "防守": 8 } }, { attributeModifiers: { "进攻": -9, "技术": -6 } }, "清晰的职责让他的发挥更加稳定。", "严格限制削弱了他的场上判断。"),
    eventChoice("grant_tactical_freedom", "给予更多场上自由", "允许他根据比赛形势自行选择位置和处理方式。", 48, { formDelta: 2, attributeModifiers: { "进攻": 13, "技术": 11, "视野": 9 } }, { formDelta: -2, attributeModifiers: { "防守": -11, "精神": -7 } }, "更高自由度释放了他的创造力。", "模糊的职责让他的发挥失去章法。")
  ] },
  { id: "recovery_method", title: "个人恢复方案", description: "体能团队与球员对恢复方式存在不同看法。", targetKind: "any", choices: [
    eventChoice("individual_recovery", "采用个人恢复计划", "根据身体反馈单独安排训练内容。", 68, { formDelta: 2, attributeModifiers: { "身体": 12, "速度": 8 } }, { attributeModifiers: { "技术": -8, "视野": -5 } }, "针对性恢复改善了他的身体表现。", "脱离合练影响了他的比赛配合。"),
    eventChoice("return_team_training", "尽快恢复全队合练", "优先找回与队友共同训练的比赛节奏。", 50, { formDelta: 3, attributeModifierPct: 11 }, { formDelta: -2, attributeModifiers: { "身体": -13 } }, "完整合练让他迅速找回了状态。", "过早增加负荷影响了他的场上表现。")
  ] },
  { id: "supporter_expectation", title: "球迷期待", description: "球迷近期把很高的期待放在一名球员身上。", targetKind: "high_rating", choices: [
    eventChoice("meet_supporters", "安排球迷见面活动", "让他直接感受看台的支持。", 59, { formDelta: 3, attributeModifiers: { "精神": 8 } }, { formDelta: -3 }, "球迷支持成为了他的额外动力。", "面对更高期待，他在比赛中变得紧张。"),
    eventChoice("limit_off_pitch", "减少场外活动", "让他远离关注，把全部精力留给训练和比赛。", 71, { formDelta: 2, attributeModifierPct: 7 }, { formDelta: -2 }, "安静的备战环境让他保持了专注。", "与外界隔离让他的情绪变得低落。")
  ] },
  { id: "minor_knock", title: "轻微身体不适", description: "一名球员在训练后出现轻微不适，队医建议观察。", targetKind: "any", choices: [
    eventChoice("follow_medical_plan", "接受队医安排", "降低负荷并完成恢复训练。", 76, { formDelta: 2, attributeModifiers: { "身体": 8 } }, { attributeModifiers: { "技术": -6, "速度": -5 } }, "恢复安排稳定了他的身体和心态。", "训练减少后，他暂时失去了比赛感觉。"),
    eventChoice("train_normally", "继续正常训练", "尊重球员感受，让他参加全部合练。", 43, { formDelta: 3, attributeModifierPct: 12 }, { formDelta: -3, attributeModifiers: { "身体": -15, "速度": -10 } }, "完整训练让他证明身体没有问题。", "不适加重，明显影响了他的身体表现。")
  ] },
  { id: "national_team_setback", title: "国家队落选", description: "一名球员没有进入最新一期国家队名单，情绪受到影响。", targetKind: "international_player", choices: [
    eventChoice("use_as_motivation", "要求他用表现争回位置", "把落选变成下一阶段的比赛目标。", 51, { formDelta: 3, attributeModifierPct: 11 }, { formDelta: -3 }, "落选激发了他重新证明自己的决心。", "额外压力让他更加怀疑自己的状态。"),
    eventChoice("reduce_pressure", "让他暂时放下国家队", "要求他只关注俱乐部训练和下一场比赛。", 70, { formDelta: 2, attributeModifiers: { "精神": 8 } }, { formDelta: -2 }, "明确的短期目标让他恢复了专注。", "国家队问题仍然困扰着他。")
  ] },
  { id: "social_media", title: "社交媒体争议", description: "一名球员的场外发言引发争议，讨论开始影响更衣室。", targetKind: "any", choices: [
    eventChoice("private_warning", "进行内部警告", "要求他停止回应，并向队友解释情况。", 69, { formDelta: 1, attributeModifiers: { "精神": 9 } }, { formDelta: -2 }, "内部处理及时结束了争议。", "球员认为自己没有得到支持。"),
    eventChoice("public_apology", "要求公开道歉", "尽快平息外界讨论，维护球队形象。", 53, { formDelta: 2, attributeModifierPct: 8 }, { formDelta: -3, attributeModifiers: { "精神": -9 } }, "公开回应帮助他放下了场外负担。", "持续曝光让争议进一步扩大。")
  ] }
];

function createSeasonFlow() {
  const rounds = [5, 9, 14, 18, 23, 29, 35];
  return {
    winterWindow: { status: "upcoming", transfer: null },
    eventSchedule: rounds.map((round) => ({ round })),
    pendingEvent: null,
    eventHistory: [],
    activeEffects: []
  };
}

function templateForEvent(event) {
  const templateId = event?.templateId ?? String(event?.id ?? "").replace(/^\d+-/, "");
  return seasonEventTemplates.find((template) => template.id === templateId) ?? null;
}

function publicEventChoices(template) {
  return (template?.choices ?? []).map(({ id, label, description }) => ({ id, label, description }));
}

function genericEventResult(event, positive) {
  return positive
    ? "这项决定改善了他的场上表现。"
    : "这项决定让他的场上表现出现下滑。";
}

function normalizeStoredSeasonEvent(event) {
  if (!event) return;
  const template = templateForEvent(event);
  if (template) {
    event.templateId = template.id;
    if (event.status === "awaiting_choice") event.choices = publicEventChoices(template);
  }
  if (["resolved", "acknowledged"].includes(event.status) && event.result) {
    const positive = event.result.positive ?? event.tone === "positive";
    const choice = template?.choices.find((item) => item.id === event.choiceId);
    event.result = {
      positive,
      summary: event.result.summary ?? (choice ? (positive ? choice.positiveText : choice.negativeText) : genericEventResult(event, positive)),
      effects: event.result.effects ?? []
    };
  }
}

function ensureSeasonFlow(run) {
  if (run.season?.version === 2) {
    run.seasonFlow ??= createSeasonFlow();
    run.seasonFlow.activeEffects ??= [];
    run.seasonFlow.eventHistory ??= [];
    for (const effect of run.seasonFlow.activeEffects) effect.expiresAfterRound = run.season.rounds;
    if (run.seasonFlow.pendingEvent && !run.seasonFlow.pendingEvent.status) {
      run.seasonFlow.pendingEvent.status = "resolved";
      run.seasonFlow.pendingEvent.result = {
        positive: run.seasonFlow.pendingEvent.tone === "positive",
        summary: genericEventResult(run.seasonFlow.pendingEvent, run.seasonFlow.pendingEvent.tone === "positive")
      };
    }
    for (const event of run.seasonFlow.eventHistory) {
      if (!event.status) event.status = event.acknowledged ? "acknowledged" : "resolved";
      normalizeStoredSeasonEvent(event);
    }
    normalizeStoredSeasonEvent(run.seasonFlow.pendingEvent);
    const transfer = run.seasonFlow.winterWindow?.transfer;
    if (transfer && transfer.acknowledged === undefined) transfer.acknowledged = true;
  }
  return run.seasonFlow;
}

function starterRows(run) {
  return run.lineup.starters.map((starter) => ({
    starter,
    player: publicPlayers.get(starter.playerId),
    engine: enginePlayers.get(starter.playerId),
    stats: run.season?.playerStatsState?.[starter.playerId] ?? null
  })).filter((row) => row.player);
}

function recentPlayerFixtures(run, count) {
  return (run.season?.playerFixtures ?? []).slice(-count);
}

function eventGoalsForPlayer(fixtures, playerId) {
  return fixtures.reduce((sum, fixture) => sum + fixture.events.filter((event) => event.side === "player" && event.type === "goal" && event.playerId === playerId).length, 0);
}

function setPieceScore(row) {
  const attributes = row.engine?.fmAttributes ?? {};
  return (Number(attributes["任意球"] ?? 0) + Number(attributes["角球"] ?? 0) + Number(attributes["罚点球"] ?? 0)) / 3;
}

function chooseEventRow(run, rows) {
  if (!rows.length) return null;
  const appearances = new Map((run.seasonFlow?.eventHistory ?? []).flatMap((event) => [event.playerId, event.secondaryPlayerId].filter(Boolean)).map((id) => [id, 0]));
  for (const event of run.seasonFlow?.eventHistory ?? []) {
    for (const id of [event.playerId, event.secondaryPlayerId].filter(Boolean)) appearances.set(id, Number(appearances.get(id) ?? 0) + 1);
  }
  const minimum = Math.min(...rows.map((row) => Number(appearances.get(row.starter.playerId) ?? 0)));
  const leastUsed = rows.filter((row) => Number(appearances.get(row.starter.playerId) ?? 0) === minimum);
  return leastUsed[Math.floor(Math.random() * leastUsed.length)];
}

function eventContext(run, template) {
  const rows = starterRows(run);
  const recentThree = recentPlayerFixtures(run, 3);
  const recentFive = recentPlayerFixtures(run, 5);
  let candidates = [];
  let secondary = null;
  let description = template.description;
  switch (template.targetKind) {
    case "striker_drought":
      if (recentFive.length < 5) return null;
      candidates = rows.filter((row) => ["ST", "LW", "RW", "LM", "RM"].includes(row.starter.position) && eventGoalsForPlayer(recentFive, row.starter.playerId) === 0);
      break;
    case "defensive_slump":
      if (recentThree.length < 3 || !recentThree.every((fixture) => fixture.goalsAgainst > 0)) return null;
      candidates = rows.filter((row) => ["GK", "LB", "LWB", "CB", "RB", "RWB", "CDM"].includes(row.starter.position));
      break;
    case "goalkeeper_mistake": {
      const mistakeIds = new Set(recentThree.flatMap((fixture) => fixture.events.filter((event) => ["error", "own_goal"].includes(event.type)).map((event) => event.playerId)));
      candidates = rows.filter((row) => row.starter.position === "GK" && mistakeIds.has(row.starter.playerId));
      break;
    }
    case "losing_run":
      if (recentThree.length < 3 || !recentThree.every((fixture) => fixture.outcome === "loss")) return null;
      candidates = rows;
      break;
    case "winning_run":
      if (recentThree.length < 3 || !recentThree.every((fixture) => fixture.outcome === "win")) return null;
      candidates = rows;
      break;
    case "core_player":
      if ((run.seasonProgress ?? 0) < 8) return null;
      candidates = [...rows].filter((row) => ["CDM", "CM", "CAM", "LM", "RM", "LW", "RW", "ST"].includes(row.starter.position)).sort((left, right) => {
        const leftAverage = left.stats?.ratedAppearances ? left.stats.ratingTotal / left.stats.ratedAppearances : 0;
        const rightAverage = right.stats?.ratedAppearances ? right.stats.ratingTotal / right.stats.ratedAppearances : 0;
        return rightAverage - leftAverage || Number(right.stats?.goals ?? 0) - Number(left.stats?.goals ?? 0);
      }).slice(0, 2);
      break;
    case "low_chemistry_pair": {
      const pairs = [];
      for (let left = 0; left < rows.length; left += 1) {
        for (let right = left + 1; right < rows.length; right += 1) {
          if (rows[left].player.nation !== rows[right].player.nation && rows[left].player.league !== rows[right].player.league) pairs.push([rows[left], rows[right]]);
        }
      }
      if (!pairs.length) return null;
      const pair = pairs[Math.floor(Math.random() * pairs.length)];
      candidates = [pair[0]];
      secondary = pair[1];
      description = `${pair[0].player.name}与${pair[1].player.name}缺少场上默契，两人在训练中发生了激烈争执。`;
      break;
    }
    case "big_match": {
      const nextRound = Number(run.seasonProgress ?? 0) + 1;
      const scheduled = run.season.schedule.find((fixture) => fixture.round === nextRound && [fixture.homeId, fixture.awayId].includes(run.replacedClub.id));
      if (!scheduled) return null;
      const opponentId = scheduled.homeId === run.replacedClub.id ? scheduled.awayId : scheduled.homeId;
      const standing = run.season.standings.find((row) => row.clubId === opponentId);
      const ownRank = run.season.playerStanding?.rank ?? 20;
      const keyMatch = standing?.rank <= 4 || (run.seasonProgress >= 29 && standing?.rank <= 6 && ownRank <= 8);
      if (!keyMatch) return null;
      candidates = rows;
      description = `下一轮将${scheduled.homeId === run.replacedClub.id ? "主场" : "客场"}面对目前排名第${standing.rank}的${standing.name}，比赛结果可能直接影响排名。`;
      break;
    }
    case "winter_arrival": {
      const incomingId = run.seasonFlow?.winterWindow?.transfer?.incomingPlayerId;
      candidates = incomingId ? rows.filter((row) => row.starter.playerId === incomingId) : [];
      break;
    }
    case "fullback":
      candidates = rows.filter((row) => ["LB", "LWB", "RB", "RWB"].includes(row.starter.position));
      break;
    case "set_piece_pair": {
      const specialists = rows.filter((row) => setPieceScore(row) >= 14).sort((left, right) => setPieceScore(right) - setPieceScore(left));
      if (specialists.length < 2) return null;
      candidates = [specialists[0]];
      secondary = specialists[1];
      description = `${specialists[0].player.name}与${specialists[1].player.name}都是队内可靠的定位球手，教练组需要重新确定主罚顺序。`;
      break;
    }
    case "low_rating":
      candidates = rows.filter((row) => (row.stats?.matchRatings?.at(-1)?.rating ?? 7) <= 6 || (row.stats?.ratedAppearances >= 5 && row.stats.ratingTotal / row.stats.ratedAppearances < 6.25));
      break;
    case "high_rating":
      candidates = rows.filter((row) => (row.stats?.matchRatings?.at(-1)?.rating ?? 0) >= 7.5 || (row.stats?.ratedAppearances >= 5 && row.stats.ratingTotal / row.stats.ratedAppearances >= 7));
      break;
    case "low_stamina":
      if ((run.seasonProgress ?? 0) < 9) return null;
      candidates = rows.filter((row) => Number(row.engine?.fmAttributes?.["耐力"] ?? 20) <= 14);
      break;
    case "foreign_player":
      candidates = rows.filter((row) => row.player.nation && row.player.nation !== "英格兰");
      break;
    case "low_form":
      candidates = rows.filter((row) => effectivePlayerFormFor(run, row.starter.playerId).value < 0);
      break;
    case "international_player":
      candidates = rows.filter((row) => row.player.nation);
      break;
    default:
      candidates = rows;
  }
  const target = chooseEventRow(run, candidates);
  if (!target) return null;
  return { target, secondary, description };
}

function activateSeasonEvent(run, round) {
  const flow = ensureSeasonFlow(run);
  const scheduled = flow.eventSchedule.find((item) => item.round === round);
  if (!scheduled || flow.eventHistory.some((event) => event.round === round)) return;
  const used = new Set(flow.eventHistory.map((event) => event.templateId));
  const preferred = scheduled.templateId ? seasonEventTemplates.find((item) => item.id === scheduled.templateId) : null;
  const available = shuffle(seasonEventTemplates.filter((template) => !used.has(template.id)));
  const contexts = (preferred ? [preferred, ...available.filter((template) => template.id !== preferred.id)] : available)
    .map((template) => ({ template, context: eventContext(run, template) }))
    .filter((item) => item.context);
  const contextual = contexts.filter(({ template }) => !["any", "international_player", "foreign_player"].includes(template.targetKind));
  const selected = (contextual.length ? contextual : contexts)[0];
  if (!selected) return;
  const { template, context } = selected;
  const starter = context.target.starter;
  const player = context.target.player;
  const event = {
    id: `${round}-${template.id}`,
    templateId: template.id,
    round,
    title: template.title,
    description: context.description,
    playerId: starter.playerId,
    playerName: player.name,
    position: starter.position,
    scope: template.scope ?? "player",
    secondaryPlayerId: context.secondary?.starter.playerId ?? null,
    secondaryPlayerName: context.secondary?.player.name ?? null,
    status: "awaiting_choice",
    choices: publicEventChoices(template),
    result: null,
    acknowledged: false
  };
  flow.pendingEvent = event;
  flow.eventHistory.push(event);
}

function effectTargets(run, event, template, effect) {
  if (template.scope === "team") return run.lineup.starters.map((starter) => starter.playerId);
  return [event.playerId, ...(effect.includeSecondary && event.secondaryPlayerId ? [event.secondaryPlayerId] : [])];
}

function signed(value) {
  return Number(value) > 0 ? `+${value}` : String(value);
}

function applyEventEffect(run, event, template, effect) {
  const targetIds = effectTargets(run, event, template, effect);
  const before = new Map(targetIds.map((playerId) => [playerId, seasonPlayerView(run, playerId)]));
  for (const playerId of targetIds) {
    run.seasonFlow.activeEffects.push({
      id: `${event.id}-${playerId}-${crypto.randomUUID()}`,
      eventId: event.id,
      playerId,
      formDelta: Number(effect.formDelta ?? 0),
      attributeModifierPct: Number(effect.attributeModifierPct ?? 0),
      attributeModifiers: effect.attributeModifiers ?? {},
      appliedRound: event.round,
      expiresAfterRound: run.season.rounds
    });
  }
  if (template.scope === "team") {
    const lines = [];
    if (effect.formDelta) lines.push(`全队状态 ${signed(effect.formDelta)} 档`);
    if (effect.attributeModifierPct) lines.push(`全队全部属性 ${signed(effect.attributeModifierPct)}%`);
    const axes = Object.entries(effect.attributeModifiers ?? {});
    if (axes.length) lines.push(`全队${axes.map(([axis, value]) => `${axis} ${signed(value)}%`).join("、")}`);
    return lines;
  }
  const lines = [];
  for (const playerId of targetIds) {
    const previous = before.get(playerId);
    const current = seasonPlayerView(run, playerId);
    const changes = [];
    if (previous.form?.label !== current.form?.label) changes.push(`状态：${previous.form?.label ?? "状态正常"} → ${current.form?.label ?? "状态正常"}`);
    if (effect.attributeModifierPct) changes.push(`全部属性 ${signed(effect.attributeModifierPct)}%`);
    for (const axis of Object.keys(effect.attributeModifiers ?? {})) {
      changes.push(`${axis}：${Number(previous.summaryRatings?.[axis] ?? 0).toFixed(1)} → ${Number(current.summaryRatings?.[axis] ?? 0).toFixed(1)}`);
    }
    lines.push(`${current.name}：${changes.join("；")}`);
  }
  return lines;
}

function resolveSeasonEvent(run, choiceId) {
  const flow = ensureSeasonFlow(run);
  const event = flow.pendingEvent;
  if (!event || event.status !== "awaiting_choice") throw httpError(409, "当前事件已经结算");
  const template = templateForEvent(event);
  const choice = template?.choices.find((item) => item.id === choiceId);
  if (!choice) throw httpError(400, "请选择一个处理方案");
  const positive = Math.random() * 100 < choice.positiveChancePct;
  const effect = positive ? choice.positiveEffect : choice.negativeEffect;
  const effectLines = applyEventEffect(run, event, template, effect);
  event.choiceId = choice.id;
  event.choiceLabel = choice.label;
  event.status = "resolved";
  event.tone = positive ? "positive" : "negative";
  event.result = {
    positive,
    summary: positive ? choice.positiveText : choice.negativeText,
    effects: effectLines,
    effectScore: Math.abs(Number(effect.formDelta ?? 0)) * 3
      + Math.abs(Number(effect.attributeModifierPct ?? 0))
      + Object.values(effect.attributeModifiers ?? {}).reduce((sum, value) => sum + Math.abs(Number(value)), 0)
  };
  return event;
}

function statsWithRosterStatus(run) {
  const transfer = run.seasonFlow?.winterWindow?.transfer;
  return (run.season.playerStats ?? []).map((row) => ({
    ...row,
    rosterStatus: row.playerId === transfer?.outgoingPlayerId
      ? "departed"
      : row.playerId === transfer?.incomingPlayerId ? "winterArrival" : "active"
  }));
}

function seasonPlayerView(run, playerId) {
  const player = publicPlayers.get(String(playerId));
  return publicPlayerDto(
    player,
    effectivePlayerFormFor(run, playerId),
    run.playstyleId,
    playerAttributeModifiersFor(run, playerId)
  );
}

function publicSeasonEvent(event, includeChoices = false) {
  if (!event) return null;
  return {
    id: event.id,
    round: event.round,
    title: event.title,
    description: event.description,
    playerId: event.playerId,
    playerName: event.playerName,
    position: event.position,
    scope: event.scope ?? "player",
    secondaryPlayerId: event.secondaryPlayerId ?? null,
    secondaryPlayerName: event.secondaryPlayerName ?? null,
    status: event.status,
    tone: event.tone ?? null,
    ...(includeChoices ? { choices: (event.choices ?? []).map(({ id, label, description }) => ({ id, label, description })) } : {}),
    result: event.result ? {
      positive: event.result.positive,
      summary: event.result.summary,
      effects: event.result.effects ?? []
    } : null
  };
}

function winterWindowView(run) {
  const window = ensureSeasonFlow(run)?.winterWindow;
  if (!window) return null;
  const result = {
    status: window.status,
    transfer: window.transfer ? {
      ...window.transfer,
      outgoingPlayer: seasonPlayerView(run, window.transfer.outgoingPlayerId),
      incomingPlayer: seasonPlayerView(run, window.transfer.incomingPlayerId)
    } : null
  };
  if (window.status !== "open") return result;
  const stats = new Map((run.season.playerStats ?? []).map((row) => [row.playerId, row]));
  result.options = run.lineup.starters.map((starter) => {
    const player = publicPlayers.get(starter.playerId);
    return {
      slotId: starter.slotId,
      position: starter.position,
      positionLabel: formationsConfig.positionLabels[starter.position],
      player: seasonPlayerView(run, starter.playerId),
      stats: stats.get(starter.playerId) ?? null
    };
  });
  return result;
}

function legacySeasonView(run) {
  const progress = Math.max(0, Math.min(38, Number(run.seasonProgress ?? 0)));
  const completed = run.status === "completed" || progress >= 38;
  const snapshot = progress > 0 ? run.season.roundSnapshots?.[progress - 1] : null;
  return {
    completed,
    progress,
    rounds: 38,
    leagueMatchCount: completed ? run.season.leagueMatchCount : progress * 10,
    playerRank: completed ? run.season.playerRank : snapshot?.playerStanding?.rank ?? null,
    playerStanding: completed ? run.season.playerStanding : snapshot?.playerStanding ?? null,
    standings: completed ? run.season.standings : snapshot?.standings ?? [],
    playerFixtures: run.season.playerFixtures.slice(0, progress),
    playerStats: completed ? run.season.playerStats : []
  };
}

function pointsFromFixtures(fixtures) {
  return fixtures.reduce((sum, fixture) => sum + (fixture.outcome === "win" ? 3 : fixture.outcome === "draw" ? 1 : 0), 0);
}

function longestFixtureRun(fixtures, predicate) {
  let longest = 0;
  let current = 0;
  for (const fixture of fixtures) {
    current = predicate(fixture) ? current + 1 : 0;
    longest = Math.max(longest, current);
  }
  return longest;
}

function fixtureDescription(fixture) {
  return fixture ? `R${fixture.round} ${fixture.venue === "home" ? "主场" : "客场"}${fixture.goalsFor}-${fixture.goalsAgainst} ${fixture.opponentName}` : "—";
}

function buildSeasonReview(run) {
  const season = run.season;
  if (!season?.playerFixtures?.length) return null;
  const fixtures = season.playerFixtures;
  const firstHalfFixtures = fixtures.filter((fixture) => fixture.round <= 19);
  const secondHalfFixtures = fixtures.filter((fixture) => fixture.round > 19);
  const firstHalfStanding = season.roundSnapshots?.find((snapshot) => snapshot.round === 19)?.playerStanding ?? null;
  const firstHalfPoints = pointsFromFixtures(firstHalfFixtures);
  const secondHalfPoints = pointsFromFixtures(secondHalfFixtures);
  const stats = season.playerStats ?? [];
  const bestPerformer = [...stats].filter((player) => Number.isFinite(player.averageRating))
    .sort((left, right) => right.averageRating - left.averageRating || right.goals - left.goals || right.assists - left.assists)[0] ?? null;
  const topScorer = [...stats].sort((left, right) => right.goals - left.goals || right.averageRating - left.averageRating)[0] ?? null;
  const topCreator = [...stats].sort((left, right) => right.assists - left.assists || right.averageRating - left.averageRating)[0] ?? null;
  const bestWin = [...fixtures].filter((fixture) => fixture.outcome === "win")
    .sort((left, right) => (right.goalsFor - right.goalsAgainst) - (left.goalsFor - left.goalsAgainst) || right.goalsFor - left.goalsFor)[0] ?? null;
  const worstLoss = [...fixtures].filter((fixture) => fixture.outcome === "loss")
    .sort((left, right) => (right.goalsAgainst - right.goalsFor) - (left.goalsAgainst - left.goalsFor) || right.goalsAgainst - left.goalsAgainst)[0] ?? null;
  const longestWinningRun = longestFixtureRun(fixtures, (fixture) => fixture.outcome === "win");
  const longestUnbeatenRun = longestFixtureRun(fixtures, (fixture) => fixture.outcome !== "loss");
  const finalStanding = season.playerStanding;
  const rankChange = firstHalfStanding ? firstHalfStanding.rank - finalStanding.rank : 0;
  let headline;
  if (finalStanding.rank === 1) headline = `${finalStanding.points}分夺冠，整个赛季取得${finalStanding.won}场胜利`;
  else if (rankChange >= 3) headline = `后半程拿到${secondHalfPoints}分，排名从第${firstHalfStanding.rank}升至第${finalStanding.rank}`;
  else if (rankChange <= -3) headline = `后半程拿到${secondHalfPoints}分，排名从第${firstHalfStanding.rank}降至第${finalStanding.rank}`;
  else if (secondHalfPoints - firstHalfPoints >= 6) headline = `后半程比前半程多拿${secondHalfPoints - firstHalfPoints}分，最终排名第${finalStanding.rank}`;
  else if (firstHalfPoints - secondHalfPoints >= 6) headline = `后半程比前半程少拿${firstHalfPoints - secondHalfPoints}分，最终排名第${finalStanding.rank}`;
  else headline = `第${finalStanding.rank}名收官，38轮取得${finalStanding.won}胜${finalStanding.drawn}平${finalStanding.lost}负`;
  const transfer = run.seasonFlow?.winterWindow?.transfer;
  const outgoing = transfer ? stats.find((player) => player.playerId === transfer.outgoingPlayerId) : null;
  const incoming = transfer ? stats.find((player) => player.playerId === transfer.incomingPlayerId) : null;
  const transferSummary = transfer
    ? `冬窗以${outgoing?.name ?? "原球员"}换入${incoming?.name ?? "新援"}；新援出场${incoming?.appearances ?? 0}次，贡献${incoming?.goals ?? 0}球${incoming?.assists ?? 0}助，场均${incoming?.averageRating?.toFixed(2) ?? "—"}`
    : run.seasonFlow?.winterWindow?.status === "skipped" ? "冬窗选择不进行球员交换" : null;
  const decisiveEvent = [...(run.seasonFlow?.eventHistory ?? [])]
    .filter((event) => event.result?.effects?.length)
    .sort((left, right) => Number(right.result.effectScore ?? 0) - Number(left.result.effectScore ?? 0))[0] ?? null;
  return {
    headline,
    firstHalf: { points: firstHalfPoints, rank: firstHalfStanding?.rank ?? null },
    secondHalf: { points: secondHalfPoints, rank: finalStanding.rank },
    standout: bestPerformer ? {
      name: bestPerformer.name,
      rating: bestPerformer.averageRating,
      goals: bestPerformer.goals,
      assists: bestPerformer.assists,
      involvementPct: finalStanding.goalsFor ? Math.min(100, Math.round((bestPerformer.goals + bestPerformer.assists) / finalStanding.goalsFor * 100)) : 0
    } : null,
    leaders: {
      scorer: topScorer ? `${topScorer.name} · ${topScorer.goals}球` : null,
      creator: topCreator ? `${topCreator.name} · ${topCreator.assists}助攻` : null
    },
    runs: {
      longestWinningRun,
      longestUnbeatenRun,
      bestWin: fixtureDescription(bestWin),
      worstLoss: fixtureDescription(worstLoss)
    },
    decisions: {
      transfer: transferSummary,
      event: decisiveEvent ? `${decisiveEvent.title}：${decisiveEvent.result.effects.join("；")}` : null
    }
  };
}

function seasonView(run) {
  if (run.season?.version !== 2) return legacySeasonView(run);
  const progress = run.season.roundSnapshots.length;
  const completed = run.status === "completed" || progress >= run.season.rounds;
  const flow = ensureSeasonFlow(run);
  return {
    version: 2,
    completed,
    progress,
    rounds: run.season.rounds,
    leagueMatchCount: run.season.leagueMatchCount,
    playerRank: run.season.playerRank,
    playerStanding: run.season.playerStanding,
    standings: run.season.standings,
    playerFixtures: run.season.playerFixtures,
    playerStats: statsWithRosterStatus(run),
    review: completed ? buildSeasonReview(run) : null,
    winterWindow: winterWindowView(run),
    pendingEvent: flow.pendingEvent ? {
      ...publicSeasonEvent(flow.pendingEvent, true),
      player: seasonPlayerView(run, flow.pendingEvent.playerId)
    } : null,
    eventHistory: flow.eventHistory.map(publicSeasonEvent)
  };
}

function applyWinterTransfer(run, slotId) {
  const flow = ensureSeasonFlow(run);
  if (run.seasonProgress !== 19 || flow.winterWindow.status !== "open") {
    throw httpError(409, "当前不在冬季转会窗口");
  }
  const outgoingStarter = run.lineup.starters.find((starter) => starter.slotId === slotId);
  if (!outgoingStarter) throw httpError(400, "请选择一个有效位置");
  const currentSquad = new Set(run.squadIds);
  const eligible = draftEligiblePlayers.filter((player) => (
    !currentSquad.has(String(player.id))
    && allRegisteredPositions(player).includes(outgoingStarter.position)
  ));
  if (!eligible.length) throw httpError(409, "该位置暂时没有可交换球员");
  const incoming = eligible[Math.floor(Math.random() * eligible.length)];
  const outgoingPlayerId = outgoingStarter.playerId;
  const incomingPlayerId = String(incoming.id);
  run.squadIds = run.squadIds.map((playerId) => playerId === outgoingPlayerId ? incomingPlayerId : playerId);
  const replaceStarter = (starter) => starter.slotId === slotId
    ? { ...starter, playerId: incomingPlayerId }
    : starter;
  run.lineup.starters = run.lineup.starters.map(replaceStarter);
  run.draftLineup.starters = run.draftLineup.starters.map(replaceStarter);
  run.playerFormById[incomingPlayerId] = samplePlayerForm();
  run.chemistry = calculateChemistry(run.lineup.starters);
  run.season.playerStatsState[incomingPlayerId] = {
    playerId: incomingPlayerId,
    name: incoming.name,
    bestPosition: formationsConfig.positionLabels[outgoingStarter.position],
    appearances: 0,
    starts: 0,
    minutes: 0,
    goals: 0,
    assists: 0,
    goalsConceded: 0,
    cleanSheets: 0,
    saves: 0,
    errorsLeadingToGoal: 0,
    ownGoals: 0,
    ratingTotal: 0,
    ratedAppearances: 0,
    matchRatings: []
  };
  run.season.playerStats.push({
    playerId: incomingPlayerId,
    name: incoming.name,
    bestPosition: formationsConfig.positionLabels[outgoingStarter.position],
    appearances: 0,
    starts: 0,
    minutes: 0,
    goals: 0,
    assists: 0,
    goalsConceded: 0,
    cleanSheets: 0,
    saves: 0,
    errorsLeadingToGoal: 0,
    ownGoals: 0,
    recentRatings: [],
    averageRating: null
  });
  flow.winterWindow = {
    status: "transferred",
    transfer: {
      slotId,
      position: outgoingStarter.position,
      outgoingPlayerId,
      incomingPlayerId,
      acknowledged: false,
      completedAt: new Date().toISOString()
    }
  };
}

async function handleApi(request, response, url) {
  if (request.method === "GET" && url.pathname === "/api/health") {
    return sendJson(response, 200, {
      ok: true,
      publicPlayers: publicData.players.length,
      draftPlayers: draftEligiblePlayers.length,
      opponentTemplates: opponentsConfig.opponents.length,
      engineDataExposed: false
    });
  }

  if (request.method === "GET" && url.pathname === "/api/config") {
    return sendJson(response, 200, {
      formations: formationsConfig.formations,
      positionLabels: formationsConfig.positionLabels,
      tactics: balance.tactics.map(({ id, name, eventRatePct, riskPct }) => ({
        id,
        name,
        eventRatePct,
        riskPct
      })),
      draftPlaystyles: [...draftPlaystyles.values()].map(publicPlaystyleDto),
      draftPools: Object.entries(draftPoolsConfig.poolLabels).map(([id, name]) => ({
        id,
        name,
        weight: draftPoolsConfig.voucherWeights[id],
        playerCount: draftPoolsConfig.stats.counts[id]
      })),
      draft: {
        minSquadSize: balance.draft.minSquadSize,
        maxSquadSize: balance.draft.maxSquadSize,
        optionsPerRound: balance.draft.optionsPerRound
      },
      radar: balance.draft.candidateCard
    });
  }

  if (request.method === "POST" && url.pathname === "/api/pvp/rooms") {
    const body = await readBody(request);
    const formation = formations.get(String(body.formationId ?? ""));
    const code = pvpCode();
    const token = crypto.randomBytes(16).toString("hex");
    const host = pvpPlayer(token, { displayName: "玩家 1" });
    if (formation) host.formationId = formation.id;
    const room = {
      code,
      createdAt: new Date().toISOString(),
      status: "waiting",
      poolSequence: createVoucherSequence(),
      players: { host, guest: null },
      match: null,
      matchStartedAt: null
    };
    pvpRoomsStore().set(code, room);
    await persistPvpRooms();
    return sendJson(response, 201, { token, room: pvpRoomView(room, token) });
  }

  let pvpMatch = matchPvpPath(url.pathname, "/join");
  if (pvpMatch && request.method === "POST") {
    const room = requirePvpRoom(pvpMatch[1]);
    if (room.players.guest) throw httpError(409, "房间已满");
    const token = crypto.randomBytes(16).toString("hex");
    room.players.guest = pvpPlayer(token, { displayName: "玩家 2" });
    room.status = "drafting";
    await persistPvpRooms();
    return sendJson(response, 200, { token, room: pvpRoomView(room, token) });
  }

  pvpMatch = matchPvpPath(url.pathname, "/add-cpu");
  if (pvpMatch && request.method === "POST") {
    const room = requirePvpRoom(pvpMatch[1]);
    const { side, player } = requirePvpSide(room, request.headers["x-pvp-token"]);
    if (side !== "host") throw httpError(403, "只有房主可以加入AI");
    if (room.players.guest) throw httpError(409, "对手席位已经有人");
    const availableFormations = [...formations.values()];
    const cpu = pvpPlayer(`cpu-${crypto.randomBytes(16).toString("hex")}`, { displayName: "AI 对手", isCpu: true });
    cpu.formationId = player.formationId ?? availableFormations[crypto.randomInt(availableFormations.length)].id;
    room.players.guest = cpu;
    completeCpuDraft(room, cpu);
    room.status = "drafting";
    await persistPvpRooms();
    return sendJson(response, 200, pvpRoomView(room, player.token));
  }

  pvpMatch = matchPvpPath(url.pathname);
  if (pvpMatch && request.method === "GET") {
    const room = requirePvpRoom(pvpMatch[1]);
    return sendJson(response, 200, pvpRoomView(room, request.headers["x-pvp-token"]));
  }

  pvpMatch = matchPvpPath(url.pathname, "/formation");
  if (pvpMatch && request.method === "PUT") {
    const room = requirePvpRoom(pvpMatch[1]);
    const { player } = requirePvpSide(room, request.headers["x-pvp-token"]);
    if (!room.players.guest) throw httpError(409, "等待对手加入");
    if (player.squadIds.length) throw httpError(409, "选秀开始后不能更换阵型");
    const body = await readBody(request);
    const formation = formations.get(String(body.formationId ?? ""));
    if (!formation) throw httpError(400, "阵型无效");
    player.formationId = formation.id;
    room.status = "drafting";
    await persistPvpRooms();
    return sendJson(response, 200, pvpRoomView(room, player.token));
  }

  pvpMatch = matchPvpPath(url.pathname, "/draft/candidates");
  if (pvpMatch && request.method === "POST") {
    const room = requirePvpRoom(pvpMatch[1]);
    const { player } = requirePvpSide(room, request.headers["x-pvp-token"]);
    if (!player.formationId) throw httpError(409, "请先选择阵型");
    if (player.ready || player.squadIds.length >= 11) throw httpError(409, "当前不能继续获取候选");
    if (player.currentCandidateIds.length) throw httpError(409, "必须先从当前候选中选择一名球员");
    const body = await readBody(request);
    if (body.targetPosition) throw httpError(400, "指定位置功能已经取消");
    const adapter = pvpDraftAdapter(room, player);
    const pool = drawDraftCandidates(adapter);
    player.currentCandidateIds = adapter.currentCandidateIds;
    player.currentCandidateSlotIds = adapter.currentCandidateSlotIds;
    await persistPvpRooms();
    return sendJson(response, 200, {
      voucher: { round: player.squadIds.length + 1, pool, label: draftPoolsConfig.poolLabels[pool] },
      candidates: player.currentCandidateIds.map((id) => ({ ...publicPlayerDto(publicPlayers.get(id), playerFormFor(player, id)), compatibleSlotIds: player.currentCandidateSlotIds[id] ?? [] })),
      voucherSummary: voucherSummary(pvpDraftAdapter(room, player))
    });
  }

  pvpMatch = matchPvpPath(url.pathname, "/draft/picks");
  if (pvpMatch && request.method === "POST") {
    const room = requirePvpRoom(pvpMatch[1]);
    const { player } = requirePvpSide(room, request.headers["x-pvp-token"]);
    const body = await readBody(request);
    const adapter = pvpDraftAdapter(room, player);
    applyDraftPick(adapter, String(body.playerId ?? ""), String(body.slotId ?? ""));
    player.squadIds = adapter.squadIds;
    player.draftLineup = adapter.draftLineup;
    player.currentCandidateIds = [];
    player.currentCandidateSlotIds = {};
    await persistPvpRooms();
    return sendJson(response, 200, pvpRoomView(room, player.token));
  }

  pvpMatch = matchPvpPath(url.pathname, "/lineup/draft");
  if (pvpMatch && request.method === "PUT") {
    const room = requirePvpRoom(pvpMatch[1]);
    const { player } = requirePvpSide(room, request.headers["x-pvp-token"]);
    const body = await readBody(request);
    player.draftLineup = validateDraftLineup(pvpDraftAdapter(room, player), body, httpError);
    await persistPvpRooms();
    return sendJson(response, 200, { draftLineup: player.draftLineup, chemistry: calculateChemistry(player.draftLineup.starters) });
  }

  pvpMatch = matchPvpPath(url.pathname, "/ready");
  if (pvpMatch && request.method === "POST") {
    const room = requirePvpRoom(pvpMatch[1]);
    const { player } = requirePvpSide(room, request.headers["x-pvp-token"]);
    const body = await readBody(request);
    player.lineup = validateLineup(pvpDraftAdapter(room, player), body, httpError);
    player.draftLineup = player.lineup;
    player.chemistry = calculateChemistry(player.lineup.starters);
    player.ready = true;
    if (room.players.host?.ready && room.players.guest?.ready && !room.match) {
      room.match = simulatePvpMatch(
        { ...room.players.host, displayName: room.players.host.displayName ?? "房主队" },
        { ...room.players.guest, displayName: room.players.guest.displayName ?? "客队" },
        `${room.code}:${room.createdAt}`
      );
      room.status = "match_ready";
    }
    await persistPvpRooms();
    return sendJson(response, 200, pvpRoomView(room, player.token));
  }

  pvpMatch = matchPvpPath(url.pathname, "/enter-match");
  if (pvpMatch && request.method === "POST") {
    const room = requirePvpRoom(pvpMatch[1]);
    const { player } = requirePvpSide(room, request.headers["x-pvp-token"]);
    if (!room.match) throw httpError(409, "双方阵容尚未准备完成");
    player.enteredMatch = true;
    const opponent = player === room.players.host ? room.players.guest : room.players.host;
    if (opponent?.isCpu) opponent.enteredMatch = true;
    if (room.players.host.enteredMatch && room.players.guest.enteredMatch && !room.matchStartedAt) {
      room.matchStartedAt = new Date(Date.now() + 2200).toISOString();
      room.status = "playing";
    }
    await persistPvpRooms();
    return sendJson(response, 200, pvpRoomView(room, player.token));
  }

  pvpMatch = matchPvpPath(url.pathname, "/rematch");
  if (pvpMatch && request.method === "POST") {
    const room = requirePvpRoom(pvpMatch[1]);
    const { player } = requirePvpSide(room, request.headers["x-pvp-token"]);
    if (!room.match) throw httpError(409, "当前比赛尚未完成");
    player.rematchRequested = true;
    if (room.players.guest?.isCpu || (room.players.host.rematchRequested && room.players.guest.rematchRequested)) {
      resetPvpRoomForDraft(room);
    }
    await persistPvpRooms();
    return sendJson(response, 200, pvpRoomView(room, player.token));
  }

  if (request.method === "POST" && url.pathname === "/api/runs") {
    const body = await readBody(request);
    const formation = formations.get(String(body.formationId ?? ""));
    if (!formation) throw httpError(400, "阵型无效");
    const playstyle = draftPlaystyles.get(String(body.playstyleId ?? ""));
    if (!playstyle) throw httpError(400, "请选择本局球队风格");
    const replaced = opponentsConfig.opponents[Math.floor(Math.random() * opponentsConfig.opponents.length)];
    const forcedId = activeRuntime().allowForcedIds
      ? String(activeRuntime().forcedRunId ?? "").trim().toLowerCase()
      : "";
    if (forcedId && !/^[a-f0-9]{32}$/.test(forcedId)) throw httpError(400, "运行编号无效");
    const id = forcedId || crypto.randomBytes(16).toString("hex");
    if (runsStore().has(id)) throw httpError(409, "运行编号冲突，请重试");
    const run = {
      id,
      createdAt: new Date().toISOString(),
      status: "drafting",
      formationId: formation.id,
      playstyleId: playstyle.id,
      draftVersion: 3,
      poolSequence: createVoucherSequence(),
      replacedClub: {
        id: replaced.id,
        name: replaced.name,
        displayName: replaced.displayName
      },
      squadIds: [],
      currentCandidateIds: [],
      currentCandidateSlotIds: {},
      playerFormById: {},
      draftLineup: { starters: [], tacticId: playstyle.id },
      lineup: null,
      chemistry: null,
      season: null
      ,seasonProgress: 0
    };
    runsStore().set(id, run);
    await persistRuns();
    return sendJson(response, 201, safeRun(run));
  }

  let match = matchRunPath(url.pathname);
  if (match && request.method === "GET") {
    return sendJson(response, 200, safeRun(requireRun(match[1])));
  }
  if (match && request.method === "DELETE") {
    requireRun(match[1]);
    runsStore().delete(match[1]);
    await persistRuns();
    response.writeHead(204);
    return response.end();
  }

  match = matchRunPath(url.pathname, "/draft/candidates");
  if (match && request.method === "POST") {
    const run = requireRun(match[1]);
    if (isLegacyDraftRun(run)) throw httpError(409, "该存档来自旧版预算规则，请重新开始新一局");
    if (run.status !== "drafting" || run.squadIds.length >= balance.draft.maxSquadSize) {
      throw httpError(409, "当前不能继续获取候选");
    }
    if (run.currentCandidateIds.length) {
      throw httpError(409, "必须先从当前候选中选择一名球员，不能更换本轮候选");
    }
    const body = await readBody(request);
    if (body.targetPosition) throw httpError(400, "指定位置功能已经取消");
    const pool = drawDraftCandidates(run);
    await persistRuns();
    return sendJson(response, 200, {
      voucher: {
        round: run.squadIds.length + 1,
        pool,
        label: draftPoolsConfig.poolLabels[pool]
      },
      voucherSummary: voucherSummary(run),
      candidates: run.currentCandidateIds.map((id) => ({
        ...publicPlayerDto(publicPlayers.get(id), playerFormFor(run, id), run.playstyleId),
        compatibleSlotIds: run.currentCandidateSlotIds[id]
      }))
    });
  }

  match = matchRunPath(url.pathname, "/draft/picks");
  if (match && request.method === "POST") {
    const run = requireRun(match[1]);
    if (isLegacyDraftRun(run)) throw httpError(409, "该存档来自旧版预算规则，请重新开始新一局");
    if (run.status !== "drafting") throw httpError(409, "当前不能选人");
    const body = await readBody(request);
    const playerId = String(body.playerId ?? "");
    const slotId = String(body.slotId ?? "");
    applyDraftPick(run, playerId, slotId);
    await persistRuns();
    return sendJson(response, 200, safeRun(run));
  }

  match = matchRunPath(url.pathname, "/lineup");
  if (match && request.method === "PUT") {
    const run = requireRun(match[1]);
    if (run.status !== "drafting") throw httpError(409, "赛季开始后阵容和战术已经锁定");
    const body = await readBody(request);
    run.lineup = validateLineup(run, body, httpError);
    run.draftLineup = run.lineup;
    run.chemistry = calculateChemistry(run.lineup.starters);
    run.status = "ready";
    await persistRuns();
    return sendJson(response, 200, safeRun(run));
  }

  match = matchRunPath(url.pathname, "/lineup/draft");
  if (match && request.method === "PUT") {
    const run = requireRun(match[1]);
    if (run.status !== "drafting") throw httpError(409, "赛季开始后不能修改阵容");
    const body = await readBody(request);
    run.draftLineup = validateDraftLineup(run, body, httpError);
    await persistRuns();
    return sendJson(response, 200, {
      draftLineup: run.draftLineup,
      chemistry: calculateChemistry(run.draftLineup.starters)
    });
  }

  match = matchRunPath(url.pathname, "/season/simulate");
  if (match && request.method === "POST") {
    const run = requireRun(match[1]);
    if (run.status === "completed" || run.status === "simulating") return sendJson(response, 200, seasonView(run));
    if (run.status !== "ready" || !run.lineup) throw httpError(409, "请先提交完整阵容和战术");
    run.status = "simulating";
    try {
      run.season = initializeSeason(run);
      run.seasonFlow = createSeasonFlow();
      run.seasonProgress = 0;
      await persistRuns();
      return sendJson(response, 200, seasonView(run));
    } catch (error) {
      run.status = "ready";
      await persistRuns();
      throw error;
    }
  }

  match = matchRunPath(url.pathname, "/season/advance");
  if (match && request.method === "POST") {
    const run = requireRun(match[1]);
    if (!run.season || !["simulating", "completed"].includes(run.status)) throw httpError(409, "赛季尚未开始");
    if (run.season.version !== 2) {
      run.seasonProgress = Math.min(38, Number(run.seasonProgress ?? 0) + 1);
      if (run.seasonProgress >= 38) run.status = "completed";
      await persistRuns();
      return sendJson(response, 200, seasonView(run));
    }
    const flow = ensureSeasonFlow(run);
    if (flow.pendingEvent) throw httpError(409, "请先查看本轮随机事件");
    if (flow.winterWindow.status === "open") throw httpError(409, "请先完成冬季转会窗口选择");
    if (flow.winterWindow.status === "transferred" && flow.winterWindow.transfer?.acknowledged === false) {
      throw httpError(409, "请先查看冬窗交换结果");
    }
    simulateSeasonRound(run, run.season);
    run.seasonProgress = run.season.roundSnapshots.length;
    if (run.seasonProgress === 19 && flow.winterWindow.status === "upcoming") {
      flow.winterWindow.status = "open";
    } else {
      activateSeasonEvent(run, run.seasonProgress);
    }
    if (run.seasonProgress >= 38) run.status = "completed";
    await persistRuns();
    return sendJson(response, 200, seasonView(run));
  }

  match = matchRunPath(url.pathname, "/season/event/choose");
  if (match && request.method === "POST") {
    const run = requireRun(match[1]);
    if (run.season?.version !== 2 || run.status !== "simulating") throw httpError(409, "当前没有可处理的随机事件");
    const body = await readBody(request);
    resolveSeasonEvent(run, String(body.choiceId ?? ""));
    await persistRuns();
    return sendJson(response, 200, seasonView(run));
  }

  match = matchRunPath(url.pathname, "/season/event/acknowledge");
  if (match && request.method === "POST") {
    const run = requireRun(match[1]);
    if (run.season?.version !== 2 || run.status !== "simulating") throw httpError(409, "当前没有可处理的随机事件");
    const flow = ensureSeasonFlow(run);
    if (!flow.pendingEvent) throw httpError(409, "当前没有可处理的随机事件");
    if (flow.pendingEvent.status !== "resolved") throw httpError(409, "请先选择事件处理方案");
    const stored = flow.eventHistory.find((event) => event.id === flow.pendingEvent.id);
    if (stored) {
      stored.acknowledged = true;
      stored.status = "acknowledged";
    }
    flow.pendingEvent = null;
    await persistRuns();
    return sendJson(response, 200, seasonView(run));
  }

  match = matchRunPath(url.pathname, "/season/winter-window");
  if (match && request.method === "POST") {
    const run = requireRun(match[1]);
    if (run.season?.version !== 2 || run.status !== "simulating") throw httpError(409, "当前不在冬季转会窗口");
    const flow = ensureSeasonFlow(run);
    if (run.seasonProgress !== 19 || flow.winterWindow.status !== "open") throw httpError(409, "冬季转会窗口已经关闭");
    const body = await readBody(request);
    if (body.participate === false) {
      flow.winterWindow = { status: "skipped", transfer: null };
    } else if (body.participate === true) {
      applyWinterTransfer(run, String(body.slotId ?? ""));
    } else {
      throw httpError(400, "请选择是否参加冬季转会窗口");
    }
    await persistRuns();
    return sendJson(response, 200, seasonView(run));
  }

  match = matchRunPath(url.pathname, "/season/winter-window/acknowledge");
  if (match && request.method === "POST") {
    const run = requireRun(match[1]);
    if (run.season?.version !== 2 || run.status !== "simulating") throw httpError(409, "当前没有可确认的冬窗结果");
    const transfer = ensureSeasonFlow(run).winterWindow?.transfer;
    if (!transfer || transfer.acknowledged !== false) throw httpError(409, "当前没有可确认的冬窗结果");
    transfer.acknowledged = true;
    await persistRuns();
    return sendJson(response, 200, seasonView(run));
  }

  match = matchRunPath(url.pathname, "/season/skip");
  if (match && request.method === "POST") {
    const run = requireRun(match[1]);
    if (!run.season || !["simulating", "completed"].includes(run.status)) throw httpError(409, "赛季尚未开始");
    if (run.season.version === 2) throw httpError(409, "新赛季必须逐轮结算");
    run.seasonProgress = 38;
    run.status = "completed";
    await persistRuns();
    return sendJson(response, 200, seasonView(run));
  }

  match = matchRunPath(url.pathname, "/season");
  if (match && request.method === "GET") {
    const run = requireRun(match[1]);
    if (!run.season) throw httpError(409, "赛季尚未完成");
    return sendJson(response, 200, seasonView(run));
  }

  throw httpError(404, "接口不存在");
}

function fetchRequestAdapter(request, body) {
  const headers = Object.fromEntries(
    [...request.headers.entries()].map(([name, value]) => [name.toLowerCase(), value])
  );
  return {
    method: request.method,
    url: new URL(request.url).pathname + new URL(request.url).search,
    headers,
    async *[Symbol.asyncIterator]() {
      if (body.byteLength) yield Buffer.from(body);
    }
  };
}

function fetchResponseAdapter() {
  let status = 200;
  let headers = {};
  let body = null;
  let ended = false;
  return {
    get headersSent() {
      return ended || Object.keys(headers).length > 0;
    },
    writeHead(nextStatus, nextHeaders = {}) {
      status = nextStatus;
      headers = nextHeaders;
    },
    end(nextBody = null) {
      body = nextBody;
      ended = true;
    },
    toResponse() {
      const bodyAllowed = status !== 204 && status !== 304;
      return new Response(bodyAllowed ? body : null, { status, headers });
    }
  };
}

export async function handleApiFetch(request, runtime = createRuntimeStore()) {
  const response = fetchResponseAdapter();
  const body = request.method === "GET" || request.method === "HEAD"
    ? new ArrayBuffer(0)
    : await request.arrayBuffer();
  const adaptedRequest = fetchRequestAdapter(request, body);
  const url = new URL(request.url);
  try {
    await runtimeContext.run(runtime, () => handleApi(adaptedRequest, response, url));
  } catch (error) {
    console.error(error.status ? error.message : error);
    if (!response.headersSent) sendJson(response, error.status ?? 500, {
      error: error.status ? error.message : "服务器内部错误"
    });
    else response.end();
  }
  return response.toResponse();
}

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon"
};

async function handleStatic(response, url) {
  const decoded = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
  const filePath = path.resolve(publicDir, `.${decoded}`);
  if (!filePath.startsWith(publicDir + path.sep)) throw httpError(403, "禁止访问");
  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat?.isFile()) throw httpError(404, "页面不存在");
  response.writeHead(200, {
    "content-type": mimeTypes[path.extname(filePath).toLowerCase()] ?? "application/octet-stream",
    "cache-control": "no-cache",
    "x-content-type-options": "nosniff"
  });
  createReadStream(filePath).pipe(response);
}

export function createAppServer() {
  const ready = initializeLocalRuntime();
  return http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host ?? "localhost"}`);
    try {
      await ready;
      if (url.pathname.startsWith("/api/")) await handleApi(request, response, url);
      else await handleStatic(response, url);
    } catch (error) {
      console.error(error.status ? error.message : error);
      if (!response.headersSent) sendJson(response, error.status ?? 500, {
        error: error.status ? error.message : "服务器内部错误"
      });
      else response.end();
    }
  });
}

const isMain = import.meta.url && process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const port = Number(process.env.PORT ?? 3000);
  createAppServer().listen(port, "127.0.0.1", () => {
    console.log(`FM26 梦幻选秀已启动：http://127.0.0.1:${port}`);
  });
}
