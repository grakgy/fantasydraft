import formationsConfig from "../../config/formations.json" with { type: "json" };
import balance from "../../config/balance-config.json" with { type: "json" };
import gameplay from "../../config/gameplay-config.json" with { type: "json" };
import opponentsConfig from "../../config/opponents.json" with { type: "json" };
import opponentRostersConfig from "../../config/opponent-rosters.json" with { type: "json" };
import draftPoolsConfig from "../../config/draft-pools.json" with { type: "json" };
import publicData from "../../data/client/players-public.json" with { type: "json" };
import engineData from "../../data/server/players-engine.json" with { type: "json" };

export { formationsConfig, balance, gameplay, opponentsConfig, opponentRostersConfig, draftPoolsConfig, publicData, engineData };

export const publicPlayers = new Map(publicData.players.map((player) => [String(player.id), player]));
export const enginePlayers = new Map(engineData.players.map((player) => [String(player.id), player]));
export const formations = new Map(formationsConfig.formations.map((formation) => [formation.id, formation]));
export const opponents = new Map(opponentsConfig.opponents.map((club) => [club.id, club]));
export const opponentRosters = new Map(Object.entries(opponentRostersConfig.clubs));
export const tactics = new Map(balance.tactics.map((tactic) => [tactic.id, tactic]));
export const draftPlaystyles = new Map((balance.draftPlaystyles ?? []).map((playstyle) => [playstyle.id, playstyle]));
export const draftPoolAssignments = new Map(Object.entries(draftPoolsConfig.assignments));
export const draftEligiblePlayers = publicData.players.filter((player) => draftPoolAssignments.has(String(player.id)));

export const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
export const round1 = (value) => Math.round(value * 10) / 10;
export const mean = (values) => values.length
  ? values.reduce((sum, value) => sum + value, 0) / values.length
  : 0;
export const shuffle = (items) => {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }
  return copy;
};

export function allRegisteredPositions(player) {
  return [...player.positions.primary, ...player.positions.secondary, ...player.positions.other];
}

export function positionMultiplier(player, position) {
  if (player.positions.primary.includes(position)) return 1;
  if (player.positions.secondary.includes(position)) return 0.95;
  if (player.positions.other.includes(position)) return 0.9;
  return 0;
}

export function normalizePlayerForm(form) {
  const neutral = balance.formState.tiers.find((tier) => tier.value === 0) ?? balance.formState.tiers[0];
  const tier = balance.formState.tiers.find((item) => item.value === Number(form?.value)) ?? neutral;
  const labels = tier.labels ?? ["状态正常"];
  const label = labels.includes(form?.label) ? form.label : labels[0];
  return { value: tier.value, label, abilityModifierPct: tier.abilityModifierPct };
}

export function samplePlayerForm(random = Math.random) {
  let roll = random() * 100;
  let tier = balance.formState.tiers.at(-1);
  for (const candidate of balance.formState.tiers) {
    roll -= Number(candidate.probabilityPct);
    if (roll < 0) {
      tier = candidate;
      break;
    }
  }
  const labels = tier.labels ?? ["状态正常"];
  const label = labels[Math.min(labels.length - 1, Math.floor(random() * labels.length))];
  return { value: tier.value, label, abilityModifierPct: tier.abilityModifierPct };
}

export function playerFormFor(run, playerId) {
  return normalizePlayerForm(run?.playerFormById?.[String(playerId)]);
}

function activeSeasonEffects(run, playerId) {
  const progress = Number(run?.seasonProgress ?? 0);
  return (run?.seasonFlow?.activeEffects ?? []).filter((effect) => (
    String(effect.playerId) === String(playerId)
    && Number(effect.expiresAfterRound) > progress
  ));
}

export function effectivePlayerFormFor(run, playerId) {
  const base = playerFormFor(run, playerId);
  const delta = activeSeasonEffects(run, playerId)
    .reduce((sum, effect) => sum + Number(effect.formDelta ?? 0), 0);
  if (!delta) return base;
  return normalizePlayerForm({ value: clamp(base.value + delta, -3, 3) });
}

export function playerAttributeModifierFor(run, playerId) {
  const modifier = activeSeasonEffects(run, playerId)
    .reduce((sum, effect) => sum + Number(effect.attributeModifierPct ?? 0), 0);
  return clamp(modifier, -25, 25);
}

export function playerAttributeModifiersFor(run, playerId) {
  const effects = activeSeasonEffects(run, playerId);
  const all = clamp(effects.reduce((sum, effect) => sum + Number(effect.attributeModifierPct ?? 0), 0), -25, 25);
  const axes = {};
  for (const effect of effects) {
    for (const [axis, value] of Object.entries(effect.attributeModifiers ?? {})) {
      axes[axis] = clamp(Number(axes[axis] ?? 0) + Number(value), -30, 30);
    }
  }
  return { all, axes };
}

export function publicPlayerDto(player, form = null, playstyleId = null, attributeModifiers = 0) {
  const draftPool = draftPoolAssignments.get(String(player.id));
  const normalizedForm = form ? normalizePlayerForm(form) : null;
  const modifiers = typeof attributeModifiers === "object" && attributeModifiers
    ? { all: Number(attributeModifiers.all ?? 0), axes: attributeModifiers.axes ?? {} }
    : { all: Number(attributeModifiers) || 0, axes: {} };
  const summaryRatings = Object.fromEntries(Object.entries(player.summaryRatings).map(([name, value]) => [
    name,
    round1(clamp(Number(value) * (1 + clamp(modifiers.all + Number(modifiers.axes[name] ?? 0), -30, 30) / 100), 0, 100))
  ]));
  return {
    id: String(player.id),
    type: player.type,
    typeDisplay: player.typeDisplay,
    name: player.name,
    nation: player.nation,
    club: player.club,
    league: player.league,
    age: player.age,
    heightCm: player.heightCm,
    preferredFoot: player.preferredFoot,
    positions: player.positions,
    positionDisplay: player.positionDisplay,
    bestPositionForPricing: player.bestPositionForPricing,
    bestPositionDisplay: player.bestPositionDisplay,
    ratingProfile: player.ratingProfile,
    summaryRatings,
    draftPool,
    draftPoolDisplay: draftPoolsConfig.poolLabels[draftPool],
    ...(playstyleId ? { tacticalFit: publicTacticalFit(playstyleId, player) } : {}),
    ...(normalizedForm ? { form: {
      label: normalizedForm.label,
      tone: normalizedForm.value < 0 ? "down" : normalizedForm.value > 0 ? "up" : "normal"
    } } : {})
  };
}

export function publicPlaystyleDto(playstyle) {
  if (!playstyle) return null;
  return {
    id: playstyle.id,
    name: playstyle.name,
    tagline: playstyle.tagline,
    description: playstyle.description,
    demands: playstyle.demands
  };
}

function weightedAttributeScore(player, attributes) {
  const enginePlayer = enginePlayers.get(String(player.id));
  const fmAttributes = enginePlayer?.fmAttributes ?? {};
  let weightedTotal = 0;
  let totalWeight = 0;
  for (const [attribute, weight] of Object.entries(attributes ?? {})) {
    const value = Number(fmAttributes[attribute]);
    if (!Number.isFinite(value)) continue;
    weightedTotal += value * Number(weight);
    totalWeight += Number(weight);
  }
  return totalWeight ? clamp(weightedTotal / totalWeight * 5, 0, 100) : 50;
}

function tacticalFitLabel(score) {
  if (score >= 82) return { label: "非常适合", tone: "great" };
  if (score >= 72) return { label: "适合", tone: "good" };
  if (score >= 62) return { label: "基本胜任", tone: "normal" };
  return { label: "需要适应", tone: "tradeoff" };
}

function tacticalSignalLabel(score) {
  if (score >= 82) return { level: "出色", tone: "great" };
  if (score >= 72) return { level: "良好", tone: "good" };
  if (score >= 62) return { level: "一般", tone: "normal" };
  return { level: "有待加强", tone: "tradeoff" };
}

export function tacticalFitForPlayer(playstyleId, playerOrId) {
  const playstyle = draftPlaystyles.get(String(playstyleId ?? ""));
  const player = typeof playerOrId === "object" ? playerOrId : publicPlayers.get(String(playerOrId));
  if (!playstyle || !player) return null;
  const isGoalkeeper = allRegisteredPositions(player).includes("GK");
  const signals = isGoalkeeper ? playstyle.goalkeeperSignals : playstyle.fitSignals;
  const signalScores = Object.fromEntries(signals.map((signal) => [signal.label, round1(weightedAttributeScore(player, signal.attributes))]));
  const orderedSignals = Object.entries(signalScores).sort((left, right) => right[1] - left[1]);
  const score = round1(mean(Object.values(signalScores)));
  return {
    score,
    ...tacticalFitLabel(score),
    strongest: orderedSignals[0]?.[0] ?? null,
    weakest: orderedSignals.at(-1)?.[0] ?? null,
    signalScores
  };
}

function publicTacticalFit(playstyleId, player) {
  const fit = tacticalFitForPlayer(playstyleId, player);
  if (!fit) return null;
  return {
    label: fit.label,
    tone: fit.tone,
    strongest: fit.strongest,
    weakest: fit.weakest
  };
}

export function buildAnalysisForRun(run) {
  const playstyle = draftPlaystyles.get(String(run?.playstyleId ?? ""));
  if (!playstyle) return null;
  const starters = run.draftLineup?.starters ?? [];
  const fits = starters.map((starter) => ({
    starter,
    fit: tacticalFitForPlayer(playstyle.id, starter.playerId)
  })).filter((item) => item.fit);
  const signalTotals = new Map();
  const diagnosticFits = fits.filter(({ starter }) => starter.position !== "GK");
  for (const { fit } of (diagnosticFits.length ? diagnosticFits : fits)) {
    for (const [label, score] of Object.entries(fit.signalScores)) {
      const current = signalTotals.get(label) ?? { total: 0, count: 0 };
      current.total += score;
      current.count += 1;
      signalTotals.set(label, current);
    }
  }
  const signals = [...signalTotals.entries()]
    .map(([label, value]) => {
      const score = round1(value.total / value.count);
      return { label, score, ...tacticalSignalLabel(score) };
    })
    .sort((left, right) => right.score - left.score);
  const averageFit = round1(mean(fits.map((item) => item.fit.score)));
  const fitState = tacticalFitLabel(averageFit || 0);
  const warnings = [];
  if (fits.length >= 3 && signals.at(-1)?.score < 72) warnings.push(`${signals.at(-1).label}有待加强`);
  const chemistry = calculateChemistry(starters);
  if (starters.length >= 4 && chemistry.total < starters.length * 0.8) warnings.push("队内默契不足");
  return {
    playstyle: publicPlaystyleDto(playstyle),
    selectedCount: starters.length,
    coreFits: fits.filter((item) => item.fit.score >= 72).length,
    fitLabel: fits.length ? fitState.label : "阵容尚未成形",
    fitTone: fits.length ? fitState.tone : "normal",
    strongestSignal: signals[0]?.label ?? null,
    weakestSignal: signals.at(-1)?.label ?? null,
    signals: signals.map(({ label, level, tone }) => ({ label, level, tone })),
    warnings: warnings.slice(0, 2)
  };
}

export function createVoucherSequence(random = Math.random) {
  const weightedPools = Object.entries(draftPoolsConfig.voucherWeights);
  const totalWeight = weightedPools.reduce((sum, [, weight]) => sum + Number(weight), 0);
  return Array.from({ length: draftPoolsConfig.voucherCount }, () => {
    let roll = random() * totalWeight;
    for (const [pool, weight] of weightedPools) {
      roll -= Number(weight);
      if (roll < 0) return pool;
    }
    return weightedPools.at(-1)[0];
  });
}

export function poolVoucherHistory(run) {
  if (!Array.isArray(run.poolSequence)) return [];
  const revealedCount = Math.min(run.poolSequence.length, run.squadIds.length + (run.currentCandidateIds.length ? 1 : 0));
  return run.poolSequence.slice(0, revealedCount).map((pool, index) => ({
    round: index + 1,
    pool,
    label: draftPoolsConfig.poolLabels[pool]
  }));
}

export function currentVoucher(run) {
  if (!run.currentCandidateIds.length || !Array.isArray(run.poolSequence)) return null;
  const pool = run.poolSequence[run.squadIds.length];
  return { round: run.squadIds.length + 1, pool, label: draftPoolsConfig.poolLabels[pool] };
}

export function voucherSummary(run) {
  const poolIds = Object.keys(draftPoolsConfig.poolLabels);
  const totals = Object.fromEntries(poolIds.map((pool) => [
    pool,
    Array.isArray(run.poolSequence) ? run.poolSequence.filter((item) => item === pool).length : 0
  ]));
  const revealedCount = Math.min(
    run.poolSequence?.length ?? 0,
    run.squadIds.length + (run.currentCandidateIds.length ? 1 : 0)
  );
  const revealed = Object.fromEntries(poolIds.map((pool) => [
    pool,
    Array.isArray(run.poolSequence) ? run.poolSequence.slice(0, revealedCount).filter((item) => item === pool).length : 0
  ]));
  const remaining = Object.fromEntries(poolIds.map((pool) => [pool, totals[pool] - revealed[pool]]));
  return { totals, revealed, remaining, totalRounds: draftPoolsConfig.voucherCount, revealedRounds: revealedCount };
}

export function isLegacyDraftRun(run) {
  return run.draftVersion !== 3
    || !Array.isArray(run.poolSequence)
    || run.poolSequence.length !== draftPoolsConfig.voucherCount;
}

export function assertDraftPoolIntegrity() {
  if (draftEligiblePlayers.length !== draftPoolsConfig.totalPlayers) {
    throw new Error(`Draft pool expected ${draftPoolsConfig.totalPlayers} players, found ${draftEligiblePlayers.length}`);
  }
}

assertDraftPoolIntegrity();

export function calculateChemistry(starters) {
  const players = {};
  let total = 0;
  for (const starter of starters) {
    const player = publicPlayers.get(String(starter.playerId));
    const teammates = starters
      .filter((other) => String(other.playerId) !== String(starter.playerId))
      .map((other) => publicPlayers.get(String(other.playerId)));
    const nation = teammates.some((teammate) => teammate.nation === player.nation) ? 1 : 0;
    const league = teammates.some((teammate) => teammate.league === player.league) ? 1 : 0;
    players[String(starter.playerId)] = {
      nation,
      league,
      points: nation + league,
      bonusPct: nation + league
    };
    total += nation + league;
  }
  return { players, total, maximum: 22 };
}

export function safeRun(run) {
  const formation = formations.get(run.formationId);
  const playstyle = draftPlaystyles.get(String(run.playstyleId ?? ""));
  return {
    runId: run.id,
    status: run.status,
    formationId: run.formationId,
    playstyle: publicPlaystyleDto(playstyle),
    formationSlots: formation.slots.map((position, index) => ({
      slotId: `starter_${index + 1}`,
      position,
      label: formation.slotLabels[index]
    })),
    draftVersion: run.draftVersion ?? null,
    legacyRules: isLegacyDraftRun(run),
    replacedClub: run.replacedClub,
    squad: run.squadIds.map((id) => publicPlayerDto(publicPlayers.get(id), playerFormFor(run, id), run.playstyleId)),
    currentCandidates: run.currentCandidateIds.map((id) => ({
      ...publicPlayerDto(publicPlayers.get(id), playerFormFor(run, id), run.playstyleId),
      compatibleSlotIds: run.currentCandidateSlotIds?.[id] ?? []
    })),
    draftRound: Math.min(11, run.squadIds.length + 1),
    currentVoucher: currentVoucher(run),
    voucherSummary: voucherSummary(run),
    voucherHistory: poolVoucherHistory(run),
    draftLineup: run.draftLineup ?? null,
    lineup: run.lineup ?? null,
    chemistry: run.chemistry ?? null,
    buildAnalysis: buildAnalysisForRun(run),
    seasonSummary: run.season ? {
      rank: run.status === "completed" ? run.season.playerRank : null,
      points: run.status === "completed" ? run.season.playerStanding.points : null,
      wins: run.status === "completed" ? run.season.playerStanding.won : null,
      draws: run.status === "completed" ? run.season.playerStanding.drawn : null,
      losses: run.status === "completed" ? run.season.playerStanding.lost : null,
      progress: Number(run.seasonProgress ?? 0)
    } : null
  };
}

function validateAssignments(run, body, errorFactory, requireFullStartingXi) {
  const formation = formations.get(run.formationId);
  if (requireFullStartingXi && run.squadIds.length !== balance.draft.maxSquadSize) {
    throw errorFactory(400, "阵容必须正好选择11名球员；旧版多人存档请重新开始");
  }
  if (!Array.isArray(body.starters) || body.starters.length > 11) {
    throw errorFactory(400, "阵容位置数据无效");
  }
  if (requireFullStartingXi && body.starters.length !== 11) {
    throw errorFactory(400, "阵容必须正好11人");
  }
  if (!tactics.has(body.tacticId)) throw errorFactory(400, "无效战术");
  if (run.playstyleId && body.tacticId !== run.playstyleId) throw errorFactory(400, "本局球队风格已经锁定");

  const squadSet = new Set(run.squadIds);
  const used = new Set();
  const starterSlotIds = new Set();
  body.starters.forEach((starter) => {
    const index = Number(String(starter.slotId).replace("starter_", "")) - 1;
    const position = formation.slots[index];
    const slotId = `starter_${index + 1}`;
    const playerId = String(starter.playerId);
    const player = publicPlayers.get(playerId);
    if (!position || starter.slotId !== slotId || starter.position !== position || starterSlotIds.has(slotId)) {
      throw errorFactory(400, "阵容位置不匹配阵型或重复");
    }
    if (!squadSet.has(playerId) || !player || used.has(playerId)) {
      throw errorFactory(400, "阵容球员无效或重复");
    }
    if (!allRegisteredPositions(player).includes(position)) {
      throw errorFactory(400, `${player.name}不能出任${formationsConfig.positionLabels[position]}`);
    }
    starterSlotIds.add(slotId);
    used.add(playerId);
  });

  return {
    starters: body.starters.map((item) => ({ ...item, playerId: String(item.playerId) })),
    tacticId: body.tacticId
  };
}

export function validateDraftLineup(run, body, errorFactory) {
  return validateAssignments(run, body, errorFactory, false);
}

export function validateLineup(run, body, errorFactory) {
  return validateAssignments(run, body, errorFactory, true);
}
