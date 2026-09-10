import {
  balance,
  gameplay,
  formationsConfig,
  opponentsConfig,
  opponents,
  opponentRosters,
  publicPlayers,
  enginePlayers,
  tactics,
  clamp,
  mean,
  round1,
  positionMultiplier,
  effectivePlayerFormFor,
  playerAttributeModifiersFor,
  tacticalFitForPlayer
} from "./context.mjs";

export function generateSchedule(teamIds) {
  if (teamIds.length % 2 !== 0) throw new Error("Team count must be even");
  let rotating = [...teamIds];
  const firstHalf = [];
  for (let roundIndex = 0; roundIndex < teamIds.length - 1; roundIndex += 1) {
    for (let index = 0; index < teamIds.length / 2; index += 1) {
      let homeId = rotating[index];
      let awayId = rotating[teamIds.length - 1 - index];
      if ((index === 0 && roundIndex % 2 === 1) || (index > 0 && index % 2 === 1)) {
        [homeId, awayId] = [awayId, homeId];
      }
      firstHalf.push({ round: roundIndex + 1, homeId, awayId });
    }
    rotating = [rotating[0], rotating.at(-1), ...rotating.slice(1, -1)];
  }
  const returnRoundOrder = Array.from(
    { length: teamIds.length - 1 },
    (_, index) => (index + 1) % (teamIds.length - 1) + 1
  );
  return [
    ...firstHalf,
    ...returnRoundOrder.flatMap((sourceRound, index) => firstHalf
      .filter((fixture) => fixture.round === sourceRound)
      .map((fixture) => ({
        round: teamIds.length + index,
        homeId: fixture.awayId,
        awayId: fixture.homeId
      })))
  ];
}

function sampleModifier(config, random) {
  if (!config?.enabled) return 0;
  const roll = random() * 100;
  let cumulative = 0;
  for (const tier of config.tiers) {
    cumulative += tier.probabilityPct;
    if (roll <= cumulative) return Number(tier.modifier);
  }
  return Number(config.tiers.at(-1)?.modifier ?? 0);
}

function sampleAiForm(random) {
  return sampleModifier(gameplay.aiTeamForm, random);
}

function sampleAiSeasonForm(random) {
  return sampleModifier(gameplay.aiTeamSeasonForm, random);
}

export function aiDifficultyRatingModifier(run, { versusPlayer = false } = {}) {
  const config = gameplay.aiDifficulty ?? {};
  const baseModifier = Number(config.baseRatingModifier ?? 0);
  if (!versusPlayer) return baseModifier;

  const compensation = config.voucherCompensation;
  const sequence = run?.poolSequence;
  const expectedCount = Number(compensation?.expectedVoucherCount ?? 0);
  if (!compensation || !Array.isArray(sequence) || sequence.length !== expectedCount) return baseModifier;

  const poolScores = compensation.poolScores ?? {};
  if (sequence.some((pool) => !Object.hasOwn(poolScores, pool))) return baseModifier;
  const voucherScore = sequence.reduce((sum, pool) => sum + Number(poolScores[pool] ?? 0), 0);
  const shortfall = Math.max(0, Number(compensation.baselineScore ?? 0) - voucherScore);
  const additionalReduction = Math.min(
    Number(compensation.maximumAdditionalReduction ?? 0),
    shortfall * Number(compensation.ratingReductionPerPointShortfall ?? 0)
  );
  return baseModifier - additionalReduction;
}

export function tacticChanceFactors(tacticId) {
  const tactic = tactics.get(tacticId) ?? tactics.get("balanced");
  if (tactic?.chanceFactors) {
    return {
      own: clamp(Number(tactic.chanceFactors.own ?? 1), 0.75, 1.25),
      opponent: clamp(Number(tactic.chanceFactors.opponent ?? 1), 0.75, 1.25)
    };
  }
  const influence = Number(gameplay.tacticalChanceInfluence ?? 0.3);
  const ownChance = Number(tactic?.eventRatePct?.own_chance ?? 0);
  const opponentChance = Number(tactic?.eventRatePct?.opponent_chance ?? 0)
    + Number(tactic?.riskPct?.defensive_error ?? 0)
    + Number(tactic?.riskPct?.opponent_counter ?? 0);
  return {
    own: clamp(1 + ownChance * influence / 100, 0.75, 1.25),
    opponent: clamp(1 + opponentChance * influence / 100, 0.75, 1.25)
  };
}

const styleMatchups = {
  high_press: { possession: 0.035, counter: -0.02, park_bus: -0.025 },
  possession: { park_bus: 0.035, high_press: -0.02, counter: -0.025 },
  counter: { high_press: 0.05, all_out_attack: 0.045, park_bus: -0.055 },
  wide: { park_bus: 0.035, high_press: 0.02, counter: -0.02 }
};

export function playerStyleChanceFactors(run, preparedTeam, opponentTacticId) {
  const styleId = preparedTeam?.styleExecution?.styleId ?? run.playstyleId ?? run.lineup?.tacticId ?? "balanced";
  const execution = Number(preparedTeam?.styleExecution?.score ?? 70);
  const fitEffect = clamp((execution - 70) * 0.006, -0.12, 0.12);
  const matchup = Number(styleMatchups[styleId]?.[opponentTacticId] ?? 0);
  const base = tacticChanceFactors(styleId);
  const own = base.own * (1 + fitEffect + matchup);
  let exposure = base.opponent;
  if (styleId === "high_press") exposure *= 1 - fitEffect * 0.55 - matchup * 0.25;
  else if (styleId === "possession") exposure *= 1 - fitEffect * 0.45;
  else if (styleId === "counter") exposure *= 1 - fitEffect * 0.2;
  else if (styleId === "wide") exposure *= 1 - fitEffect * 0.18;
  return { own: clamp(own, 0.82, 1.18), opponent: clamp(exposure, 0.84, 1.18) };
}

function attribute(player, name, fallback = 10) {
  return Number(player.fmAttributes?.[name] ?? fallback);
}

function averageAttributes(player, names) {
  return mean(names.map((name) => attribute(player, name))) * gameplay.playerAttributeGroups.attributePointScale;
}

const profileAxisWeights = {
  attack: { "进攻": 0.45, "技术": 0.2, "速度": 0.15, "精神": 0.12, "制空": 0.08 },
  creation: { "视野": 0.42, "技术": 0.32, "精神": 0.16, "速度": 0.1 },
  defense: { "防守": 0.5, "身体": 0.2, "精神": 0.18, "制空": 0.12 },
  physical: { "身体": 0.42, "速度": 0.32, "精神": 0.16, "制空": 0.1 },
  keeping: { "拦截射门": 0.45, "指挥防守": 0.2, "精神": 0.15, "制空": 0.12, "身体": 0.08 },
  distribution: { "大脚开球": 0.45, "精神": 0.2, "意外性": 0.15, "速度": 0.1, "制空": 0.1 }
};

function profileModifier(attributeModifiers, profile) {
  const weights = profileAxisWeights[profile] ?? {};
  return Number(attributeModifiers?.all ?? 0) + Object.entries(weights)
    .reduce((sum, [axis, weight]) => sum + Number(attributeModifiers?.axes?.[axis] ?? 0) * weight, 0);
}

function eventProfile(player, position, chemistryBonus, formTier, attributeModifiers = {}) {
  const multiplier = positionMultiplier(player, position) || 0.85;
  const baseCondition = formTier.abilityModifierPct + chemistryBonus;
  const condition = (profile) => 1 + (baseCondition + profileModifier(attributeModifiers, profile)) / 100;
  const goalkeeper = position === "GK" || player.bestPositionForPricing === "GK";
  if (goalkeeper) {
    const groups = gameplay.playerAttributeGroups.goalkeeper;
    const keeping = averageAttributes(player, groups.keeping) * condition("keeping");
    const distribution = averageAttributes(player, groups.distribution) * condition("distribution");
    return {
      attack: distribution * 0.35,
      creation: distribution,
      defense: keeping,
      physical: averageAttributes(player, groups.physical) * condition("physical"),
      keeping,
      multiplier,
      condition: condition("keeping")
    };
  }
  const groups = gameplay.playerAttributeGroups.outfield;
  return {
    attack: averageAttributes(player, groups.attack) * multiplier * condition("attack"),
    creation: averageAttributes(player, groups.creation) * multiplier * condition("creation"),
    defense: averageAttributes(player, groups.defense) * multiplier * condition("defense"),
    physical: averageAttributes(player, groups.physical) * multiplier * condition("physical"),
    keeping: 20,
    multiplier,
    condition: condition("physical")
  };
}

const stylePositionWeights = {
  high_press: { GK: 0.55, CB: 1.05, LB: 1.1, RB: 1.1, LWB: 1.15, RWB: 1.15, CDM: 1.2, CM: 1.3, CAM: 1.35, LM: 1.35, RM: 1.35, LW: 1.45, RW: 1.45, ST: 1.5 },
  possession: { GK: 1.05, CB: 1.2, LB: 1.05, RB: 1.05, LWB: 1.05, RWB: 1.05, CDM: 1.35, CM: 1.5, CAM: 1.4, LM: 1.15, RM: 1.15, LW: 1.0, RW: 1.0, ST: 0.9 },
  counter: { GK: 0.85, CB: 0.9, LB: 0.9, RB: 0.9, LWB: 1.05, RWB: 1.05, CDM: 1.1, CM: 1.2, CAM: 1.3, LM: 1.4, RM: 1.4, LW: 1.55, RW: 1.55, ST: 1.55 },
  wide: { GK: 0.55, CB: 0.7, LB: 1.55, RB: 1.55, LWB: 1.65, RWB: 1.65, CDM: 0.75, CM: 0.9, CAM: 0.85, LM: 1.55, RM: 1.55, LW: 1.65, RW: 1.65, ST: 1.3 }
};

function playerStyleExecution(run, participants) {
  const styleId = run.playstyleId ?? run.lineup?.tacticId;
  const weights = stylePositionWeights[styleId] ?? {};
  let total = 0;
  let weightTotal = 0;
  const playerScores = {};
  for (const participant of participants) {
    const weight = Number(weights[participant.position] ?? 1);
    const score = Number(tacticalFitForPlayer(styleId, participant.player)?.score ?? 70);
    playerScores[participant.playerId] = score;
    total += score * weight;
    weightTotal += weight;
  }
  return { styleId, score: weightTotal ? total / weightTotal : 70, playerScores };
}

function preparePlayerTeam(run, stats, random) {
  const participants = [];

  for (const starter of run.lineup.starters) {
    const player = enginePlayers.get(starter.playerId);
    const form = effectivePlayerFormFor(run, starter.playerId);
    const attributeModifiers = playerAttributeModifiersFor(run, starter.playerId);
    const chemistry = run.chemistry.players[starter.playerId]?.bonusPct ?? 0;
    const profile = eventProfile(player, starter.position, chemistry, form, attributeModifiers);
    participants.push({
      player,
      playerId: starter.playerId,
      position: starter.position,
      minutes: 90,
      starter: true,
      profile,
      form
    });
  }

  for (const participant of participants) {
    const row = stats[participant.playerId];
    row.appearances += 1;
    row.starts += 1;
    row.minutes += participant.minutes;
  }

  const weighted = (key) => {
    const totalMinutes = participants.reduce((sum, player) => sum + player.minutes, 0) || 1;
    return participants.reduce((sum, player) => sum + player.profile[key] * player.minutes, 0) / totalMinutes;
  };
  const positional = (positions, key) => {
    const matching = participants.filter((player) => positions.includes(player.position));
    return matching.length ? mean(matching.map((player) => player.profile[key])) : weighted(key);
  };
  const weights = gameplay.teamRatingWeights;
  const rating = (value) => clamp(value, gameplay.teamRatingScale.minimum, gameplay.teamRatingScale.maximum);
  const styleExecution = playerStyleExecution(run, participants);
  return {
    ratings: {
      attack: rating(
        positional(["ST", "LW", "RW", "CAM"], "attack") * weights.attack.positionalAttack
        + weighted("creation") * weights.attack.allCreation
      ),
      midfield: rating(
        positional(["CDM", "CM", "CAM", "LM", "RM"], "creation") * weights.midfield.positionalCreation
        + weighted("physical") * weights.midfield.allPhysical
      ),
      defense: rating(
        positional(["LB", "LWB", "CB", "RB", "RWB", "CDM"], "defense") * weights.defense.positionalDefense
        + weighted("physical") * weights.defense.allPhysical
      ),
      goalkeeper: rating(positional(["GK"], "keeping"))
    },
    participants,
    styleExecution,
    events: []
  };
}

function poisson(lambda, random) {
  const limit = Math.exp(-lambda);
  let product = 1;
  let count = 0;
  do {
    count += 1;
    product *= random();
  } while (product > limit && count < 12);
  return count - 1;
}

function expectedGoals(attack, midfield, opponentDefense, opponentGoalkeeper, home) {
  const config = gameplay.expectedGoals;
  return clamp(
    config.base
      + (attack - opponentDefense) / config.attackVsDefenseDivisor
      + (midfield - config.midfieldReference) / config.midfieldDivisor
      + (config.goalkeeperReference - opponentGoalkeeper) / config.goalkeeperDivisor
      + (home ? config.homeAdvantage : 0),
    config.minimum,
    config.maximum
  );
}

function prepareAiTeam(club, random, seasonForm = 0, difficultyModifier = 0) {
  const form = sampleAiForm(random);
  const minimum = gameplay.teamRatingScale.minimum;
  const maximum = gameplay.teamRatingScale.maximum;
  const reference = Number(gameplay.aiTeamStrengthSpread?.reference ?? 71);
  const multiplier = Number(gameplay.aiTeamStrengthSpread?.multiplier ?? 1);
  const spread = (rating) => reference + (rating - reference) * multiplier;
  return {
    attack: clamp(spread(club.ratings.attack) + form + seasonForm + difficultyModifier, minimum, maximum),
    midfield: clamp(spread(club.ratings.midfield) + form + seasonForm + difficultyModifier, minimum, maximum),
    defense: clamp(spread(club.ratings.defense) + form + seasonForm + difficultyModifier, minimum, maximum),
    goalkeeper: clamp(spread(club.ratings.goalkeeper) + (form + seasonForm) * 0.5 + difficultyModifier, minimum, maximum)
  };
}

export function calculatePlayerTeamRatings(run, { random = () => 0.5 } = {}) {
  const stats = Object.fromEntries(run.squadIds.map((playerId) => [playerId, {
    appearances: 0,
    starts: 0,
    minutes: 0
  }]));
  return preparePlayerTeam(run, stats, random).ratings;
}

function chooseWeighted(items, weight, random) {
  if (!items.length) return null;
  const weighted = items.map((item) => ({ item, value: Math.max(0.1, weight(item)) }));
  let roll = random() * weighted.reduce((sum, entry) => sum + entry.value, 0);
  for (const entry of weighted) {
    roll -= entry.value;
    if (roll <= 0) return entry.item;
  }
  return weighted.at(-1).item;
}

const defensivePositions = new Set(["GK", "LB", "LWB", "CB", "RB", "RWB", "CDM"]);
const widePositions = new Set(["LB", "LWB", "LM", "LW", "RB", "RWB", "RM", "RW"]);
const midfieldPositions = new Set(["CDM", "CM", "CAM", "LM", "RM"]);
const attackingPositions = new Set(["CAM", "LM", "RM", "LW", "RW", "ST"]);

function roleAbility(participant) {
  if (participant.position === "GK") return participant.profile.keeping * 0.78 + participant.profile.creation * 0.12 + participant.profile.physical * 0.1;
  if (["LB", "LWB", "CB", "RB", "RWB"].includes(participant.position)) return participant.profile.defense * 0.58 + participant.profile.physical * 0.22 + participant.profile.creation * 0.2;
  if (participant.position === "CDM") return participant.profile.defense * 0.38 + participant.profile.creation * 0.37 + participant.profile.physical * 0.25;
  if (["CM", "CAM", "LM", "RM"].includes(participant.position)) return participant.profile.creation * 0.48 + participant.profile.attack * 0.22 + participant.profile.defense * 0.12 + participant.profile.physical * 0.18;
  return participant.profile.attack * 0.58 + participant.profile.creation * 0.24 + participant.profile.physical * 0.18;
}

function styleRoleEmphasis(styleId, position) {
  if (styleId === "wide") return widePositions.has(position) || position === "ST" ? 1 : 0.25;
  if (styleId === "counter") return attackingPositions.has(position) || ["CM", "CDM"].includes(position) ? 1 : 0.35;
  if (styleId === "possession") return midfieldPositions.has(position) || ["GK", "CB", "LB", "RB"].includes(position) ? 1 : 0.4;
  if (styleId === "high_press") return position === "GK" ? 0.35 : 1;
  return 0.5;
}

function opponentGoalEvents(clubId, goals, team, stats, random) {
  const roster = opponentRosters.get(clubId) ?? [];
  const events = [];
  const incidents = new Map(team.participants.map((player) => [player.playerId, { errors: 0, ownGoals: 0 }]));
  const outfield = roster.filter((player) => player.position !== "GK");
  const defenders = team.participants.filter((player) => defensivePositions.has(player.position));
  const scorerWeight = (player) => player.weight * ({ FWD: 2.2, MID: 1.25, DEF: 0.35 }[player.position] ?? 1);
  const creatorWeight = (player) => player.weight * ({ FWD: 1.15, MID: 1.6, DEF: 0.55 }[player.position] ?? 1);
  for (let index = 0; index < goals; index += 1) {
    const minute = 3 + Math.floor(random() * 87);
    const culprit = chooseWeighted(defenders, (player) => Math.max(8, 110 - roleAbility(player)), random);
    if (culprit && random() < 0.045) {
      incidents.get(culprit.playerId).ownGoals += 1;
      stats[culprit.playerId].ownGoals = Number(stats[culprit.playerId].ownGoals ?? 0) + 1;
      events.push({
        type: "own_goal",
        side: "opponent",
        minute,
        playerId: culprit.playerId,
        playerName: culprit.player.name,
        description: `${culprit.player.name}处理球失误，将球碰进自家球门`
      });
      continue;
    }
    const scorer = chooseWeighted(outfield, scorerWeight, random);
    const assister = random() < gameplay.opponentEvents.assistProbability
      ? chooseWeighted(outfield.filter((player) => player.name !== scorer?.name), creatorWeight, random)
      : null;
    const error = culprit && random() < 0.12 ? culprit : null;
    if (error) {
      incidents.get(error.playerId).errors += 1;
      stats[error.playerId].errorsLeadingToGoal = Number(stats[error.playerId].errorsLeadingToGoal ?? 0) + 1;
      events.push({
        type: "error",
        side: "opponent",
        minute: Math.max(1, minute - 1),
        playerId: error.playerId,
        playerName: error.player.name,
        description: `${error.player.name}出现低级失误，送给对手机会`
      });
    }
    events.push({
      type: "goal",
      side: "opponent",
      minute,
      playerName: scorer?.name ?? "对手球员",
      assistPlayerName: assister?.name ?? null
    });
  }
  return { events, incidents };
}

function performanceSummary({ rating, contribution, incident, position, saves }) {
  if (incident.ownGoals) return "低级失误并打入乌龙球";
  if (incident.errors) return "失误直接造成失球";
  if (contribution.goals >= 3) return `完成帽子戏法`;
  if (contribution.goals && contribution.assists) return `${contribution.goals}球${contribution.assists}助攻`;
  if (contribution.goals) return `攻入${contribution.goals}球`;
  if (contribution.assists) return `送出${contribution.assists}次助攻`;
  if (position === "GK" && saves >= 5) return `完成${saves}次扑救`;
  if (rating >= 7.5) return "在本职位置发挥出色";
  if (rating <= 5.5) return "本场表现明显低迷";
  return "完成本场比赛任务";
}

function addPlayerMatchStats(team, goalsFor, goalsAgainst, outcome, stats, context, random) {
  const contributionWeights = gameplay.goalContributionWeights;
  const ratingConfig = gameplay.playerMatchRating;
  const scorers = team.participants.filter((player) => player.position !== "GK" && player.minutes > 0);
  const creators = team.participants.filter((player) => player.position !== "GK");
  const contributions = new Map(team.participants.map((player) => [player.playerId, { goals: 0, assists: 0 }]));
  for (let index = 0; index < goalsFor; index += 1) {
    const scorer = chooseWeighted(
      scorers,
      (player) => player.profile.attack * player.minutes / 90 * Number(contributionWeights.scorerByPosition[player.position] ?? 0.5),
      random
    );
    if (!scorer) continue;
    const contribution = contributions.get(scorer.playerId);
    contribution.goals += 1;
    stats[scorer.playerId].goals += 1;
    let assister = null;
    if (random() < contributionWeights.assistProbability) {
      assister = chooseWeighted(
        creators.filter((player) => player.playerId !== scorer.playerId),
        (player) => player.profile.creation * player.minutes / 90 * Number(contributionWeights.assisterByPosition[player.position] ?? 0.5),
        random
      );
      if (assister) {
        contributions.get(assister.playerId).assists += 1;
        stats[assister.playerId].assists += 1;
      }
    }
    team.events.push({
      type: "goal",
      side: "player",
      minute: 3 + Math.floor(random() * 87),
      playerId: scorer.playerId,
      playerName: scorer.player.name,
      assistPlayerId: assister?.playerId ?? null,
      assistPlayerName: assister?.player.name ?? null
    });
  }

  const opponentEvents = opponentGoalEvents(context.opponentId, goalsAgainst, team, stats, random);
  team.events.push(...opponentEvents.events);
  const teamOverall = mean(Object.values(context.teamRatings));
  const opponentOverall = mean(Object.values(context.opponentRatings));
  const goalDifference = goalsFor - goalsAgainst;
  const playerRatings = [];
  for (const participant of team.participants) {
    const contribution = contributions.get(participant.playerId);
    const incident = opponentEvents.incidents.get(participant.playerId) ?? { errors: 0, ownGoals: 0 };
    const outcomeBonus = outcome === "win"
      ? ratingConfig.winBonus
      : outcome === "loss"
        ? ratingConfig.lossPenalty
        : ratingConfig.drawBonus;
    const cleanSheetBonus = goalsAgainst === 0
      ? participant.position === "GK"
        ? ratingConfig.cleanSheetGoalkeeperBonus
        : ["LB", "LWB", "CB", "RB", "RWB"].includes(participant.position)
          ? ratingConfig.cleanSheetDefenderBonus
          : participant.position === "CDM"
            ? ratingConfig.cleanSheetDefensiveMidfielderBonus
            : 0
      : 0;
    const concededPenalty = participant.position === "GK"
      ? goalsAgainst * ratingConfig.goalConcededGoalkeeperPenalty
      : ["LB", "LWB", "CB", "RB", "RWB"].includes(participant.position)
        ? goalsAgainst * ratingConfig.goalConcededDefenderPenalty
        : 0;
    const abilityEdge = clamp((roleAbility(participant) - opponentOverall) / 24, -0.8, 0.8);
    const tacticalFit = Number(team.styleExecution?.playerScores?.[participant.playerId] ?? 70);
    const tacticalOpportunity = (tacticalFit - 70) / 24 * styleRoleEmphasis(team.styleExecution?.styleId, participant.position);
    const formInfluence = Number(participant.form?.value ?? 0) * 0.12;
    const performanceRoll = ((random() + random() + random()) / 3 - 0.5) * 2.7;
    const rolePerformance = clamp(performanceRoll + abilityEdge * 0.34 + tacticalOpportunity * 0.28 + formInfluence, -1.35, 1.35);
    const strengthDifference = (opponentOverall - teamOverall) / 18;
    const opponentContext = outcome === "win"
      ? clamp(strengthDifference * 0.16, -0.06, 0.2)
      : outcome === "draw"
        ? clamp(strengthDifference * 0.1, -0.05, 0.14)
        : clamp(strengthDifference * 0.04, -0.16, 0.05);
    const saves = participant.position === "GK"
      ? Math.max(0, Math.round(context.opponentExpectedGoals * 2.1 + random() * 3.2 - goalsAgainst * 0.35))
      : 0;
    const contributionGoalBonus = Array.from({ length: contribution.goals }, (_, index) => ratingConfig.goalBonus * Math.pow(0.82, index))
      .reduce((sum, value) => sum + value, 0);
    const contributionAssistBonus = Array.from({ length: contribution.assists }, (_, index) => ratingConfig.assistBonus * Math.pow(0.82, index))
      .reduce((sum, value) => sum + value, 0);
    const goalDifferenceBonus = clamp(goalDifference * ratingConfig.goalDifferencePointBonus, -ratingConfig.goalDifferenceMaximum, ratingConfig.goalDifferenceMaximum);
    const rolePerformanceBonus = rolePerformance * ratingConfig.rolePerformanceWeight;
    const saveBonus = participant.position === "GK" ? saves * ratingConfig.saveBonus : 0;
    const rating = clamp(
      ratingConfig.base
        + contributionGoalBonus
        + contributionAssistBonus
        + outcomeBonus
        + goalDifferenceBonus
        + opponentContext
        + rolePerformanceBonus
        + cleanSheetBonus
        + saveBonus
        - concededPenalty
        - incident.errors * ratingConfig.errorLeadingToGoalPenalty
        - incident.ownGoals * ratingConfig.ownGoalPenalty,
      ratingConfig.minimum,
      ratingConfig.maximum
    );
    const row = stats[participant.playerId];
    row.ratingTotal += rating;
    row.ratedAppearances += 1;
    row.matchRatings ??= [];
    row.matchRatings.push({ round: context.round, rating: Math.round(rating * 10) / 10 });
    if (goalsAgainst === 0 && defensivePositions.has(participant.position)) row.cleanSheets += 1;
    if (participant.position === "GK") {
      row.goalsConceded += goalsAgainst;
      row.saves += saves;
    }
    playerRatings.push({
      playerId: participant.playerId,
      name: participant.player.name,
      position: participant.position,
      rating: Math.round(rating * 10) / 10,
      summary: performanceSummary({ rating, contribution, incident, position: participant.position, saves }),
      goals: contribution.goals,
      assists: contribution.assists,
      saves,
      errors: incident.errors,
      ownGoals: incident.ownGoals
    });
  }
  team.events.sort((a, b) => a.minute - b.minute);
  return playerRatings.sort((left, right) => right.rating - left.rating || left.name.localeCompare(right.name));
}

function emptyStanding(club, isPlayer) {
  return {
    clubId: club.id,
    name: isPlayer ? "我的梦幻球队" : club.displayName,
    englishName: club.name,
    isPlayer,
    played: 0,
    won: 0,
    drawn: 0,
    lost: 0,
    goalsFor: 0,
    goalsAgainst: 0,
    goalDifference: 0,
    points: 0
  };
}

function updateStanding(standing, goalsFor, goalsAgainst) {
  standing.played += 1;
  standing.goalsFor += goalsFor;
  standing.goalsAgainst += goalsAgainst;
  standing.goalDifference = standing.goalsFor - standing.goalsAgainst;
  if (goalsFor > goalsAgainst) {
    standing.won += 1;
    standing.points += 3;
  } else if (goalsFor === goalsAgainst) {
    standing.drawn += 1;
    standing.points += 1;
  } else {
    standing.lost += 1;
  }
}

function sortStandings(rows, fixtures) {
  const headToHead = new Map();
  const add = (teamId, opponentId, points, awayGoals) => {
    const key = `${teamId}>${opponentId}`;
    const current = headToHead.get(key) ?? { points: 0, awayGoals: 0 };
    current.points += points;
    current.awayGoals += awayGoals;
    headToHead.set(key, current);
  };
  for (const fixture of fixtures) {
    add(
      fixture.homeId,
      fixture.awayId,
      fixture.homeGoals > fixture.awayGoals ? 3 : fixture.homeGoals === fixture.awayGoals ? 1 : 0,
      0
    );
    add(
      fixture.awayId,
      fixture.homeId,
      fixture.awayGoals > fixture.homeGoals ? 3 : fixture.homeGoals === fixture.awayGoals ? 1 : 0,
      fixture.awayGoals
    );
  }
  return [...rows].sort((a, b) => {
    const primary = b.points - a.points || b.goalDifference - a.goalDifference || b.goalsFor - a.goalsFor;
    if (primary) return primary;
    const aHead = headToHead.get(`${a.clubId}>${b.clubId}`) ?? { points: 0, awayGoals: 0 };
    const bHead = headToHead.get(`${b.clubId}>${a.clubId}`) ?? { points: 0, awayGoals: 0 };
    return bHead.points - aHead.points
      || bHead.awayGoals - aHead.awayGoals
      || a.clubId.localeCompare(b.clubId);
  }).map((row, index) => ({ ...row, rank: index + 1 }));
}

function initializeStats(run) {
  return Object.fromEntries(run.squadIds.map((playerId) => {
    const player = publicPlayers.get(playerId);
    const starter = run.lineup?.starters.find((item) => item.playerId === playerId);
    return [playerId, {
      playerId,
      name: player.name,
      bestPosition: formationsConfig.positionLabels[starter?.position] ?? player.bestPositionDisplay,
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
    }];
  }));
}

function ensureStatsRows(run, stats) {
  for (const playerId of run.squadIds) {
    if (stats[playerId]) {
      stats[playerId].matchRatings ??= [];
      stats[playerId].errorsLeadingToGoal ??= 0;
      stats[playerId].ownGoals ??= 0;
      continue;
    }
    const player = publicPlayers.get(playerId);
    const starter = run.lineup?.starters.find((item) => item.playerId === playerId);
    stats[playerId] = {
      playerId,
      name: player.name,
      bestPosition: formationsConfig.positionLabels[starter?.position] ?? player.bestPositionDisplay,
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
  }
}

function publicPlayerStats(stats) {
  return Object.values(stats).map((row) => {
    const { ratingTotal, ratedAppearances, matchRatings = [], ...publicRow } = row;
    return {
      ...publicRow,
      averageRating: ratedAppearances ? Math.round(ratingTotal / ratedAppearances * 100) / 100 : null,
      recentRatings: matchRatings.slice(-5).map((item) => ({ round: item.round, rating: item.rating }))
    };
  }).sort((a, b) => (
    b.goals - a.goals
    || b.assists - a.assists
    || (b.averageRating ?? 0) - (a.averageRating ?? 0)
  ));
}

export function initializeSeason(run, { random = Math.random } = {}) {
  const teamIds = opponentsConfig.opponents.map((club) => club.id);
  const aiSeasonFormById = Object.fromEntries(teamIds
    .filter((teamId) => teamId !== run.replacedClub.id)
    .map((teamId) => [teamId, sampleAiSeasonForm(random)]));
  const schedule = generateSchedule(teamIds);
  const standingsById = new Map(opponentsConfig.opponents.map((club) => [
    club.id,
    emptyStanding(club, club.id === run.replacedClub.id)
  ]));
  const stats = initializeStats(run);
  const standings = sortStandings([...standingsById.values()], []);
  return {
    version: 2,
    startedAt: new Date().toISOString(),
    completedAt: null,
    rounds: 38,
    schedule,
    aiSeasonFormById,
    fixtures: [],
    leagueMatchCount: 0,
    playerFixtures: [],
    roundSnapshots: [],
    standings,
    playerStanding: standings.find((row) => row.isPlayer),
    playerRank: null,
    playerStatsState: stats,
    playerStats: publicPlayerStats(stats)
  };
}

export function simulateSeasonRound(run, season, { random = Math.random } = {}) {
  if (season.version !== 2) throw new Error("Only incremental seasons can advance by round");
  const round = season.roundSnapshots.length + 1;
  if (round > season.rounds) return season;
  const standingsById = new Map(season.standings.map((standing) => [standing.clubId, standing]));
  const stats = season.playerStatsState ?? initializeStats(run);
  ensureStatsRows(run, stats);
  const scheduledRound = season.schedule.filter((fixture) => fixture.round === round);

  for (const scheduled of scheduledRound) {
    const homeIsPlayer = scheduled.homeId === run.replacedClub.id;
    const awayIsPlayer = scheduled.awayId === run.replacedClub.id;
    const homeClub = opponents.get(scheduled.homeId);
    const awayClub = opponents.get(scheduled.awayId);
    const playerTeam = homeIsPlayer || awayIsPlayer ? preparePlayerTeam(run, stats, random) : null;
    const homeAiModifier = aiDifficultyRatingModifier(run, { versusPlayer: awayIsPlayer });
    const awayAiModifier = aiDifficultyRatingModifier(run, { versusPlayer: homeIsPlayer });
    const homeRatings = homeIsPlayer ? playerTeam.ratings : prepareAiTeam(homeClub, random, season.aiSeasonFormById[scheduled.homeId], homeAiModifier);
    const awayRatings = awayIsPlayer ? playerTeam.ratings : prepareAiTeam(awayClub, random, season.aiSeasonFormById[scheduled.awayId], awayAiModifier);
    const homeTactic = homeIsPlayer
      ? playerStyleChanceFactors(run, playerTeam, awayClub.tactic)
      : tacticChanceFactors(homeClub.tactic);
    const awayTactic = awayIsPlayer
      ? playerStyleChanceFactors(run, playerTeam, homeClub.tactic)
      : tacticChanceFactors(awayClub.tactic);
    const homeExpectedGoals = expectedGoals(
      homeRatings.attack,
      homeRatings.midfield,
      awayRatings.defense,
      awayRatings.goalkeeper,
      true
    ) * homeTactic.own * awayTactic.opponent;
    const awayExpectedGoals = expectedGoals(
      awayRatings.attack,
      awayRatings.midfield,
      homeRatings.defense,
      homeRatings.goalkeeper,
      false
    ) * awayTactic.own * homeTactic.opponent;
    let homeGoals = poisson(homeExpectedGoals, random);
    let awayGoals = poisson(awayExpectedGoals, random);

    const fixture = {
      ...scheduled,
      homeGoals,
      awayGoals,
      homeName: standingsById.get(scheduled.homeId).name,
      awayName: standingsById.get(scheduled.awayId).name
    };
    season.fixtures.push(fixture);
    updateStanding(standingsById.get(scheduled.homeId), homeGoals, awayGoals);
    updateStanding(standingsById.get(scheduled.awayId), awayGoals, homeGoals);

    if (playerTeam) {
      const playerGoals = homeIsPlayer ? homeGoals : awayGoals;
      const opponentGoals = homeIsPlayer ? awayGoals : homeGoals;
      const outcome = playerGoals > opponentGoals ? "win" : playerGoals === opponentGoals ? "draw" : "loss";
      const opponentId = homeIsPlayer ? scheduled.awayId : scheduled.homeId;
      const playerRatings = addPlayerMatchStats(playerTeam, playerGoals, opponentGoals, outcome, stats, {
        round: scheduled.round,
        opponentId,
        teamRatings: homeIsPlayer ? homeRatings : awayRatings,
        opponentRatings: homeIsPlayer ? awayRatings : homeRatings,
        ownExpectedGoals: homeIsPlayer ? homeExpectedGoals : awayExpectedGoals,
        opponentExpectedGoals: homeIsPlayer ? awayExpectedGoals : homeExpectedGoals
      }, random);
      season.playerFixtures.push({
        round: scheduled.round,
        venue: homeIsPlayer ? "home" : "away",
        opponentId: homeIsPlayer ? scheduled.awayId : scheduled.homeId,
        opponentName: homeIsPlayer ? awayClub.displayName : homeClub.displayName,
        goalsFor: playerGoals,
        goalsAgainst: opponentGoals,
        outcome,
        expectedGoals: Math.round((homeIsPlayer ? homeExpectedGoals : awayExpectedGoals) * 100) / 100,
        opponentExpectedGoals: Math.round((homeIsPlayer ? awayExpectedGoals : homeExpectedGoals) * 100) / 100,
        events: playerTeam.events,
        playerRatings
      });
    }

  }

  const standings = sortStandings([...standingsById.values()], season.fixtures);
  const playerStanding = standings.find((row) => row.isPlayer);
  season.leagueMatchCount = season.fixtures.length;
  season.playerRank = playerStanding.rank;
  season.playerStanding = playerStanding;
  season.standings = standings;
  season.playerStatsState = stats;
  season.playerStats = publicPlayerStats(stats);
  season.roundSnapshots.push({ round, standings, playerStanding });
  if (round >= season.rounds) season.completedAt = new Date().toISOString();
  return season;
}

export function simulateSeason(run, { random = Math.random } = {}) {
  const season = initializeSeason(run, { random });
  while (season.roundSnapshots.length < season.rounds) simulateSeasonRound(run, season, { random });
  return season;
}
