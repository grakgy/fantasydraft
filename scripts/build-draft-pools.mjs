import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicPath = path.join(root, "data", "client", "players-public.json");
const enginePath = path.join(root, "data", "server", "players-engine.json");
const configPath = path.join(root, "config", "draft-pools.json");
const reviewPath = path.join(root, "data", "manual", "draft-player-curation.csv");

const publicData = JSON.parse(fs.readFileSync(publicPath, "utf8"));
const engineData = JSON.parse(fs.readFileSync(enginePath, "utf8"));
const engineById = new Map(engineData.players.map((player) => [String(player.id), player]));

const targetCounts = { legend: 156, star: 344, player: 400 };
const poolLabels = { legend: "传奇池", star: "球星池", player: "球员池" };
const leagueBonus = {
  "英超": 10,
  "西甲": 7,
  "意甲": 7,
  "德甲": 7,
  "法甲": 6,
  "葡超": 3,
  "荷甲": 3,
  "土超": 2,
  "英冠": 2,
  "美职联": 2,
  "沙特联": 2,
  "巴甲": 2,
  "阿甲": 2
};
const famousClubs = new Set([
  "Manchester City", "Arsenal", "Liverpool", "Chelsea", "Manchester United", "Tottenham",
  "Newcastle", "Aston Villa", "West Ham", "Real Madrid", "Barcelona", "Atlético Madrid",
  "Atletico Madrid", "Athletic Club", "Sevilla", "Valencia", "Villarreal", "Real Sociedad",
  "Bayern Munich", "Borussia Dortmund", "Bayer Leverkusen", "RB Leipzig", "Paris Saint-Germain",
  "PSG", "Marseille", "Lyon", "Monaco", "Juventus", "Inter Milan", "AC Milan", "Napoli",
  "Roma", "Lazio", "Atalanta", "Ajax", "PSV", "Feyenoord", "Porto", "Benfica",
  "Sporting CP", "Celtic", "Rangers", "Galatasaray", "Fenerbahçe"
]);
const mustKeepNames = new Set([
  "Heung-Min Son", "Jack Grealish", "Aymeric Laporte", "Sofyan Amrabat", "Takehiro Tomiyasu",
  "Leandro Paredes", "Randal Kolo Muani", "Mohammed Kudus", "Darwin Núñez", "Georginio Wijnaldum",
  "Andrej Kramarić", "Kingsley Coman", "Hakim Ziyech", "Sadio Mané", "Alex Sandro",
  "Álvaro Morata", "Ismaël Bennacer", "Théo Hernández", "Memphis Depay", "Éric Bailly",
  "Thomas Müller", "Marc-André ter Stegen", "Fernando Muslera", "Willian", "Ángel Correa",
  "Emil Forsberg", "Mehdi Taremi", "Merih Demiral", "Lorenzo Insigne", "Julian Draxler",
  "Anthony Martial", "Edinson Cavani", "Radamel Falcao", "André Ayew", "Wilfred Ndidi",
  "Joel Campbell", "Jesús Corona", "Craig Gordon", "Thorgan Hazard", "José Fonte",
  "Jasper Cillessen", "Junya Ito", "Dominik Livaković", "André Carrillo", "Carlos Bacca",
  "Paolo Guerrero", "Vincent Aboubakar", "Lukas Podolski"
]);

function average(values) {
  const numeric = Object.values(values ?? {}).map(Number).filter(Number.isFinite);
  return numeric.length ? numeric.reduce((sum, value) => sum + value, 0) / numeric.length : 0;
}

function recognitionScore(player) {
  const engine = engineById.get(String(player.id));
  const price = Number(engine?.price?.base ?? 0);
  const quality = average(player.summaryRatings);
  const age = Number(player.age ?? 24);
  return price
    + quality * 0.12
    + Number(leagueBonus[player.league] ?? 0)
    + (famousClubs.has(player.club) ? 9 : 0)
    + (mustKeepNames.has(player.name) ? 1000 : 0)
    + Math.max(0, Math.min(5, age - 28)) * 0.45;
}

function sortByRecognition(players) {
  return [...players].sort((left, right) => (
    recognitionScore(right) - recognitionScore(left)
    || Number(engineById.get(String(right.id))?.price?.base ?? 0) - Number(engineById.get(String(left.id))?.price?.base ?? 0)
    || left.name.localeCompare(right.name, "en")
  ));
}

const legends = publicData.players.filter((player) => player.type === "legend");
const current = publicData.players.filter((player) => player.type !== "legend");
const originalStars = current.filter((player) => player.pricePool === "球星池");
const originalStrong = current.filter((player) => player.pricePool === "强援池");
const originalRegular = current.filter((player) => ["主力池", "轮换池", "基础池"].includes(player.pricePool));

if (legends.length !== targetCounts.legend) {
  throw new Error(`传奇人数应为${targetCounts.legend}，实际${legends.length}`);
}
if (originalStars.length > targetCounts.star) throw new Error("原球星池人数超过新球星池目标");

const selectedStrong = sortByRecognition(originalStrong).slice(0, targetCounts.star - originalStars.length);
const selectedRegular = sortByRecognition(originalRegular).slice(0, targetCounts.player);
const assignments = new Map();
for (const player of legends) assignments.set(String(player.id), "legend");
for (const player of [...originalStars, ...selectedStrong]) assignments.set(String(player.id), "star");
for (const player of selectedRegular) assignments.set(String(player.id), "player");

const selectedByPool = Object.fromEntries(Object.keys(targetCounts).map((pool) => [
  pool,
  publicData.players.filter((player) => assignments.get(String(player.id)) === pool)
]));
for (const [pool, expected] of Object.entries(targetCounts)) {
  if (selectedByPool[pool].length !== expected) {
    throw new Error(`${poolLabels[pool]}应为${expected}人，实际${selectedByPool[pool].length}`);
  }
}

const allPositionCodes = Object.keys(publicData.positions);
const coverage = {};
for (const [pool, players] of Object.entries(selectedByPool)) {
  coverage[pool] = Object.fromEntries(allPositionCodes.map((position) => [
    position,
    players.filter((player) => [
      ...player.positions.primary,
      ...player.positions.secondary,
      ...player.positions.other
    ].includes(position)).length
  ]));
  const missing = Object.entries(coverage[pool]).filter(([, count]) => count === 0).map(([position]) => position);
  if (missing.length) throw new Error(`${poolLabels[pool]}缺少位置：${missing.join(", ")}`);
}

const config = {
  version: "1.0",
  totalPlayers: assignments.size,
  voucherCount: 11,
  voucherWeights: { legend: 4, star: 4, player: 3 },
  poolLabels,
  candidateCount: 5,
  sharedVoucherSequenceForPvp: true,
  independentCandidateDrawsForPvp: true,
  assignments: Object.fromEntries([...assignments.entries()].sort(([left], [right]) => left.localeCompare(right, "en"))),
  stats: {
    counts: targetCounts,
    positionCoverage: coverage,
    sourceCounts: {
      legend: legends.length,
      originalStar: originalStars.length,
      originalStrong: originalStrong.length,
      originalRegular: originalRegular.length
    }
  }
};

function csvField(value) {
  const text = String(value ?? "");
  return /[;"\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

const reviewHeaders = [
  "Unique ID", "名字", "球员类型", "俱乐部", "联赛", "年龄", "原价格池", "新选秀池", "是否保留",
  "筛选分", "最佳位置", "第二位置", "其他位置", "基础价格参考", "八维均值"
];
const reviewRows = publicData.players
  .map((player) => {
    const pool = assignments.get(String(player.id));
    const engine = engineById.get(String(player.id));
    return {
      "Unique ID": String(player.id),
      "名字": player.name,
      "球员类型": player.typeDisplay,
      "俱乐部": player.club,
      "联赛": player.league,
      "年龄": player.age,
      "原价格池": player.pricePool,
      "新选秀池": pool ? poolLabels[pool] : "",
      "是否保留": pool ? "是" : "否",
      "筛选分": recognitionScore(player).toFixed(2),
      "最佳位置": player.positionDisplay.primary.join("、"),
      "第二位置": player.positionDisplay.secondary.join("、"),
      "其他位置": player.positionDisplay.other.join("、"),
      "基础价格参考": Number(engine?.price?.base ?? 0).toFixed(1),
      "八维均值": average(player.summaryRatings).toFixed(1)
    };
  })
  .sort((left, right) => (
    (right["是否保留"] === "是") - (left["是否保留"] === "是")
    || Number(right["筛选分"]) - Number(left["筛选分"])
  ));

fs.mkdirSync(path.dirname(reviewPath), { recursive: true });
fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
fs.writeFileSync(reviewPath, `\ufeff${reviewHeaders.join(";")}\r\n${reviewRows.map((row) => reviewHeaders.map((header) => csvField(row[header])).join(";")).join("\r\n")}\r\n`, "utf8");

console.log(`Draft pools built: legend=${targetCounts.legend}, star=${targetCounts.star}, player=${targetCounts.player}, total=${assignments.size}`);
for (const pool of Object.keys(targetCounts)) {
  console.log(`${poolLabels[pool]} coverage ${JSON.stringify(coverage[pool])}`);
}
