import fs from "node:fs/promises";

const [ratingConfig, publicData, engineData] = await Promise.all([
  fs.readFile(new URL("../config/rating-config.json", import.meta.url), "utf8").then(JSON.parse),
  fs.readFile(new URL("../data/client/players-public.json", import.meta.url), "utf8").then(JSON.parse),
  fs.readFile(new URL("../data/server/players-engine.json", import.meta.url), "utf8").then(JSON.parse)
]);

const engineById = new Map(engineData.players.map((player) => [String(player.id), player]));
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function dimensionsFor(player) {
  const goalkeeper = player.bestPositionForPricing === "GK";
  const section = goalkeeper ? ratingConfig.goalkeeper : ratingConfig.outfield;
  return Object.fromEntries(section.axisOrder.map((axis) => {
    const weights = section.dimensions[axis];
    const totalWeight = Object.values(weights).reduce((sum, weight) => sum + Number(weight), 0) || 1;
    let score = Object.entries(weights).reduce((sum, [attribute, weight]) => (
      sum + Number(player.fmAttributes?.[attribute] ?? 10) * Number(weight)
    ), 0) / totalWeight * 5;
    if (goalkeeper && axis === "制空") score += clamp((Number(player.heightCm ?? 185) - 175) * 0.5, 0, 15);
    return [axis, Math.round(clamp(score, 0, 100) * 10) / 10];
  }));
}

for (const player of engineData.players) player.summaryRatings = dimensionsFor(player);
for (const player of publicData.players) {
  const enginePlayer = engineById.get(String(player.id));
  if (!enginePlayer) throw new Error(`Missing engine player ${player.id}`);
  player.summaryRatings = enginePlayer.summaryRatings;
}

for (const dataset of [publicData, engineData]) {
  dataset.meta.outfieldAxes = ratingConfig.outfield.axisOrder;
  dataset.meta.goalkeeperAxes = ratingConfig.goalkeeper.axisOrder;
  dataset.meta.summaryRatingScale = [0, 100];
  dataset.meta.summaryRatingPrecision = 1;
}

await Promise.all([
  fs.writeFile(new URL("../data/client/players-public.json", import.meta.url), `${JSON.stringify(publicData, null, 2)}\n`, "utf8"),
  fs.writeFile(new URL("../data/server/players-engine.json", import.meta.url), `${JSON.stringify(engineData, null, 2)}\n`, "utf8")
]);

console.log(`Rebuilt ${publicData.players.length} public and ${engineData.players.length} engine rating summaries.`);
