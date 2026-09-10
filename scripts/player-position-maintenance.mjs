import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const maintenancePath = path.join(root, "data", "manual", "player-position-maintenance.csv");
const sourceFiles = [
  "data/server/现役外场.csv",
  "data/server/传奇外场.csv",
  "data/server/现役门将.csv",
  "data/server/传奇门将.csv"
];
const outfieldFiles = sourceFiles.slice(0, 2);
const publicJsonPath = path.join(root, "data", "client", "players-public.json");
const engineJsonPath = path.join(root, "data", "server", "players-engine.json");
const draftPoolsPath = path.join(root, "config", "draft-pools.json");

const positionCodeByLabel = {
  "门将": "GK",
  "左后卫": "LB",
  "左翼卫": "LWB",
  "中后卫": "CB",
  "右后卫": "RB",
  "右翼卫": "RWB",
  "后腰": "CDM",
  "中前卫": "CM",
  "前腰": "CAM",
  "左边前卫": "LM",
  "右边前卫": "RM",
  "左边锋": "LW",
  "右边锋": "RW",
  "中锋": "ST"
};
const positionLabelByCode = Object.fromEntries(
  Object.entries(positionCodeByLabel).map(([label, code]) => [code, label])
);

const maintenanceHeaders = [
  "Unique ID",
  "球员类型",
  "名字",
  "俱乐部",
  "年龄",
  "最佳位置",
  "第二位置",
  "其他可用位置",
  "定价位置（只读）",
  "原全部位置（参考）",
  "评分_射门",
  "评分_传球",
  "评分_控球",
  "评分_防守",
  "评分_速度",
  "评分_身体",
  "评分_意识",
  "评分_意志",
  "修改说明"
];

const approvedInitialChanges = {
  "2000233530": {
    secondary: "左边锋",
    note: "人工确认：Thierry Henry补充左边锋，保留中锋为最佳位置"
  },
  "43139595": {
    secondary: "后腰",
    note: "仅CM修正：抢断16、工作投入18，补充后腰"
  },
  "28106684": {
    secondary: "前腰",
    note: "仅CM修正：前插和无球跑动突出，补充前腰"
  },
  "28106685": {
    secondary: "前腰",
    note: "仅CM修正：传球、远射和进攻参与更适合前腰"
  },
  "55012106": {
    secondary: "后腰",
    note: "仅CM修正：William Carvalho现实主职偏后腰"
  },
  "80000931": {
    secondary: "后腰",
    note: "仅CM修正：防守站位与中场组织更适合后腰"
  },
  "23244496": {
    secondary: "后腰",
    note: "仅CM修正：Xavi可担任拖后组织核心，补充后腰"
  },
  "23168735": {
    secondary: "前腰",
    note: "仅CM修正：Fàbregas传球20、射门17，补充前腰"
  }
};

// 依据球员长期真实角色进行的多最佳位置复核。这里只记录明确可长期胜任、
// 且水平接近主职的位置；偶尔客串的位置仍保留在第二/其他位置。
const reviewedPrimaryByName = {
  "Alexis Sánchez": ["右边锋"],
  "Andrés Iniesta": ["前腰"],
  "Andrea Pirlo": ["中前卫"],
  "Arda Turan": ["左边锋"],
  "Bobby Charlton": ["中前卫"],
  "Bryan Robson": ["前腰"],
  "Carles Puyol": ["右后卫"],
  "Carlos Tevez": ["中锋"],
  "Cesc Fàbregas": ["前腰"],
  "Clarence Seedorf": ["前腰"],
  "Daniele De Rossi": ["中前卫"],
  "Daniel Alves": ["右后卫"],
  "David Beckham": ["中前卫"],
  "Denis Irwin": ["右后卫"],
  "Dennis Bergkamp": ["前腰"],
  "Eden Hazard": ["前腰"],
  "Edgar Davids": ["后腰"],
  "Eric Cantona": ["中锋"],
  "Frank Rijkaard": ["中后卫"],
  "Gareth Bale": ["右边锋"],
  "George Best": ["右边锋"],
  "Gianluca Zambrotta": ["右后卫"],
  "Johan Cruyff": ["中锋"],
  "Jordi Alba": ["左后卫", "左翼卫"],
  "Luis Enrique": ["右边前卫"],
  "Luis Figo": ["右边前卫"],
  "Michael Carrick": ["后腰"],
  "Patrice Evra": ["左后卫"],
  "Patrick Vieira": ["中前卫"],
  "Pavel Nedvěd": ["前腰", "左边前卫"],
  "Pelé": ["前腰"],
  "Raúl": ["前腰"],
  "Rivaldo": ["中锋"],
  "Robert Pirès": ["左边前卫"],
  "Ronaldinho": ["左边锋"],
  "Ruud Gullit": ["中前卫", "前腰"],
  "Santi Cazorla": ["中前卫"],
  "Steven Gerrard": ["前腰"],
  "Thierry Henry": ["左边锋"],
  "Tomas Rosicky": ["前腰"],
  "Wayne Rooney": ["前腰"],
  "Xabi Alonso": ["中前卫"],
  "Yaya Touré": ["中前卫"],
  "Zico": ["中锋"],

  "Achraf Hakimi": ["右边前卫"],
  "Alex Sandro": ["左后卫", "左翼卫"],
  "Alphonso Davies": ["左后卫", "左翼卫"],
  "Antoine Griezmann": ["中锋"],
  "Aurélien Tchouaméni": ["后腰", "中前卫"],
  "Christian Pulisic": ["左边锋", "右边锋"],
  "Christopher Nkunku": ["前腰", "中锋"],
  "Cody Gakpo": ["中锋"],
  "Dejan Kulusevski": ["右边锋"],
  "Denzel Dumfries": ["右后卫"],
  "Dominik Szoboszlai": ["中前卫"],
  "Eduardo Camavinga": ["后腰", "中前卫"],
  "Federico Chiesa": ["右边锋"],
  "Federico Valverde": ["右边前卫"],
  "Florian Wirtz": ["左边锋"],
  "İlkay Gündoğan": ["中前卫"],
  "Jack Grealish": ["左边锋"],
  "James Maddison": ["中前卫"],
  "Jamal Musiala": ["左边锋"],
  "Jérémy Doku": ["右边锋"],
  "Joško Gvardiol": ["左后卫"],
  "Jude Bellingham": ["前腰"],
  "Julián Álvarez": ["前腰"],
  "Kaoru Mitoma": ["左边前卫"],
  "Kingsley Coman": ["右边锋"],
  "Konrad Laimer": ["右翼卫"],
  "Kylian Mbappé": ["中锋"],
  "Leon Goretzka": ["中前卫"],
  "Leroy Sané": ["右边锋"],
  "Luka Modrić": ["前腰"],
  "Marc Cucurella": ["左后卫"],
  "Michael Olise": ["右边前卫"],
  "Nicolò Barella": ["后腰"],
  "Nico Williams": ["右边锋"],
  "Ousmane Dembélé": ["左边锋", "右边锋"],
  "Paulo Dybala": ["中锋"],
  "Phil Foden": ["右边锋"],
  "Reece James": ["右后卫", "右翼卫"],
  "Riyad Mahrez": ["右边前卫"],
  "Rodri": ["中前卫"],
  "Sadio Mané": ["右边锋", "中锋"],
  "Stanislav Lobotka": ["中前卫"],
  "Takehiro Tomiyasu": ["左后卫", "右后卫"],
  "Théo Hernández": ["左后卫"],
  "Thomas Müller": ["前腰", "中锋"],
  "Trent Alexander-Arnold": ["右后卫"],
  "Willian": ["左边锋", "右边锋"],
  "Xavi Simons": ["左边锋", "右边锋"]
};

const reviewedPrimaryById = {
  // 同名球员使用ID区分时代版本。
  "23244590": ["左边锋"], // Cristiano Ronaldo（传奇）
  "23244492": ["前腰"], // Lionel Messi（传奇）
  "23244570": ["前腰"], // Neymar（传奇）
  "19024412": ["左边锋"], // Neymar（现役）
  "7456688": ["中前卫"], // Santi Cazorla（现役）
  "92020288": ["左边锋"], // Heung-Min Son
  "28009441": ["右后卫"], // Kyle Walker
  "16010162": ["左后卫"], // David Alaba
  "37052843": ["右后卫"], // Denzel Dumfries
  "85078058": ["右边前卫"], // Riyad Mahrez
  "91013383": ["左边锋"], // Marco Reus
  "2105510": ["右边锋"] // Hulk
};

const reviewedExactPositions = {
  "36521997": { primary: ["前腰"], secondary: [], other: [] }, // Pablo Aimar误标中后卫
  "23244480": { primary: ["右边前卫", "右边锋"], secondary: ["左边前卫", "左边锋"], other: [] }, // Arjen Robben主职右路
  "23168728": { primary: ["中前卫", "后腰"], secondary: ["左边前卫", "右边前卫"], other: ["前腰"] }, // Schweinsteiger
  "23244498": { primary: ["后腰", "中前卫"], secondary: ["中后卫", "右边前卫"], other: [] }, // Michael Essien
  "23168729": { primary: ["右后卫"], secondary: ["中后卫"], other: [] }, // Gary Neville
  "2000214661": { primary: ["左后卫", "左翼卫"], secondary: ["左边前卫"], other: ["左边锋"] }, // Jordi Alba
  "48042326": { primary: ["后腰", "中前卫"], secondary: ["中后卫"], other: [] }, // Tchouaméni
  "28108035": { primary: ["右后卫", "右翼卫"], secondary: ["中后卫", "后腰"], other: [] }, // Reece James
  "49056243": { primary: ["后腰", "中前卫"], secondary: ["左后卫"], other: [] }, // Camavinga
  "28104124": { primary: ["右后卫", "中前卫"], secondary: ["右翼卫", "后腰"], other: [] }, // Alexander-Arnold
  "20041862": { primary: ["左后卫", "左翼卫"], secondary: ["左边前卫", "左边锋"], other: [] }, // Alphonso Davies
  "35011448": { primary: ["前腰", "中锋"], secondary: ["中前卫", "右边前卫", "右边锋"], other: [] }, // Thomas Müller
  "18108540": { primary: ["中锋"], secondary: ["前腰", "左边锋", "右边锋"], other: [] }, // Jonathan David
  "29125842": { primary: ["右边锋", "中锋"], secondary: ["右边前卫", "左边锋"], other: ["左边前卫"] }, // Jarrod Bowen
  "45095490": { primary: ["中后卫", "右后卫"], secondary: ["左后卫", "左翼卫", "右翼卫"], other: [] }, // Tomiyasu
  "24060473": { primary: ["中后卫", "左后卫"], secondary: ["左翼卫"], other: [] }, // Gvardiol
  "16010162": { primary: ["中后卫", "左后卫"], secondary: ["左翼卫"], other: [] }, // David Alaba
  "28009441": { primary: ["中后卫", "右后卫"], secondary: ["右翼卫"], other: [] }, // Kyle Walker
  "19067093": { primary: ["左后卫", "左翼卫"], secondary: ["中后卫"], other: [] }, // Alex Sandro
  "85104424": { primary: ["左边锋", "右边锋"], secondary: ["左边前卫", "右边前卫"], other: [] }, // Kingsley Coman
  "91138280": { primary: ["左边锋", "右边锋"], secondary: ["前腰", "左边前卫", "右边前卫"], other: [] }, // Leroy Sané
  "85100467": { primary: ["左边锋", "右边锋", "中锋"], secondary: ["左边前卫"], other: [] }, // Sadio Mané
  "8832889": { primary: ["前腰", "左边锋", "右边锋"], secondary: ["左边前卫", "右边前卫"], other: [] } // Willian
};

function parseCsv(text, delimiter = ";") {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const records = [];
  let record = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"' && source[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"' && field === "") {
      quoted = true;
    } else if (char === delimiter) {
      record.push(field);
      field = "";
    } else if (char === "\n") {
      record.push(field.endsWith("\r") ? field.slice(0, -1) : field);
      records.push(record);
      record = [];
      field = "";
    } else {
      field += char;
    }
  }

  if (field !== "" || record.length > 0) {
    record.push(field.endsWith("\r") ? field.slice(0, -1) : field);
    records.push(record);
  }
  if (!records.length) return { headers: [], rows: [] };

  const headers = records[0];
  const rows = records.slice(1)
    .filter((values) => values.some((value) => value !== ""))
    .map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])));
  return { headers, rows };
}

function encodeCsvField(value, delimiter = ";") {
  const text = String(value ?? "");
  return text.includes(delimiter) || /["\r\n]/.test(text)
    ? `"${text.replaceAll('"', '""')}"`
    : text;
}

function stringifyCsv(headers, rows, { bom = false, eol = "\r\n", trailingEol = true } = {}) {
  const lines = [
    headers.map(encodeCsvField).join(";"),
    ...rows.map((row) => headers.map((header) => encodeCsvField(row[header])).join(";"))
  ];
  return `${bom ? "\ufeff" : ""}${lines.join(eol)}${trailingEol ? eol : ""}`;
}

function loadCsv(relativePath) {
  const absolutePath = path.join(root, relativePath);
  const text = fs.readFileSync(absolutePath, "utf8");
  const parsed = parseCsv(text);
  return {
    relativePath,
    absolutePath,
    headers: parsed.headers,
    rows: parsed.rows,
    format: {
      bom: text.charCodeAt(0) === 0xfeff,
      eol: text.includes("\r\n") ? "\r\n" : "\n",
      trailingEol: /(?:\r\n|\n)$/.test(text)
    }
  };
}

function splitPositions(value) {
  return String(value ?? "")
    .split(/[、,，/|]+/)
    .map((position) => position.trim())
    .filter(Boolean);
}

function normalizeTier(value, id, tierName) {
  const positions = splitPositions(value);
  const invalid = positions.filter((position) => !positionCodeByLabel[position]);
  if (invalid.length) {
    throw new Error(`${id} ${tierName}包含非法位置：${invalid.join("、")}`);
  }
  if (new Set(positions).size !== positions.length) {
    throw new Error(`${id} ${tierName}内部存在重复位置`);
  }
  return positions;
}

function addReviewedPrimary(row, positions) {
  const allPositions = new Set([
    ...splitPositions(row["最佳位置"]),
    ...splitPositions(row["第二位置"]),
    ...splitPositions(row["其他可用位置"])
  ]);
  for (const position of positions) allPositions.add(position);
  const requested = new Set(positions);
  row["最佳位置"] = [...new Set([
    ...splitPositions(row["最佳位置"]),
    ...positions
  ])].join("、");
  row["第二位置"] = splitPositions(row["第二位置"])
    .filter((position) => !requested.has(position))
    .join("、");
  row["其他可用位置"] = splitPositions(row["其他可用位置"])
    .filter((position) => !requested.has(position))
    .join("、");
  return allPositions;
}

function applyReviewedPositionRules(rows) {
  const draftAssignments = JSON.parse(fs.readFileSync(draftPoolsPath, "utf8")).assignments;
  const changed = [];
  const missingNamedRules = new Set(Object.keys(reviewedPrimaryByName));
  const missingIdRules = new Set([...Object.keys(reviewedPrimaryById), ...Object.keys(reviewedExactPositions)]);

  for (const row of rows) {
    const id = String(row["Unique ID"]);
    if (!draftAssignments[id]) continue;
    if (reviewedPrimaryByName[row["名字"]]) missingNamedRules.delete(row["名字"]);
    const before = [row["最佳位置"], row["第二位置"], row["其他可用位置"]].join("|");
    const exact = reviewedExactPositions[id];
    if (exact) {
      row["最佳位置"] = exact.primary.join("、");
      row["第二位置"] = exact.secondary.join("、");
      row["其他可用位置"] = exact.other.join("、");
      missingIdRules.delete(id);
    } else {
      const byId = reviewedPrimaryById[id] ?? [];
      if (reviewedPrimaryById[id]) missingIdRules.delete(id);
      const byName = reviewedPrimaryByName[row["名字"]] ?? [];
      const reviewed = [...new Set([...byId, ...byName])];
      if (reviewed.length) addReviewedPrimary(row, reviewed);

    }

    const after = [row["最佳位置"], row["第二位置"], row["其他可用位置"]].join("|");
    if (before !== after) {
      row["修改说明"] = `多最佳位置复核：${row["最佳位置"]}`;
      changed.push(row);
    }
  }

  if (missingNamedRules.size) {
    throw new Error(`多位置复核名单中找不到球员：${[...missingNamedRules].join("、")}`);
  }
  if (missingIdRules.size) {
    throw new Error(`多位置复核名单中找不到ID：${[...missingIdRules].join("、")}`);
  }
  return changed;
}

function validateMaintenance(rows, sourceRows) {
  const sourceById = new Map(sourceRows.map((row) => [String(row["Unique ID"]), row]));
  const seen = new Set();
  const normalized = new Map();

  for (const row of rows) {
    const id = String(row["Unique ID"] ?? "").trim();
    if (!id) throw new Error("维护表存在空Unique ID");
    if (seen.has(id)) throw new Error(`维护表存在重复Unique ID：${id}`);
    seen.add(id);

    const source = sourceById.get(id);
    if (!source) throw new Error(`维护表存在底库中没有的球员：${id} ${row["名字"] ?? ""}`);
    if (String(row["名字"] ?? "") !== String(source["名字"] ?? "")) {
      throw new Error(`${id}的名字与底库不一致，请勿修改ID或姓名`);
    }

    const primary = normalizeTier(row["最佳位置"], id, "最佳位置");
    const secondary = normalizeTier(row["第二位置"], id, "第二位置");
    const other = normalizeTier(row["其他可用位置"], id, "其他可用位置");
    if (!primary.length) throw new Error(`${id} ${row["名字"]}缺少最佳位置`);
    if ([...primary, ...secondary, ...other].includes("门将")) {
      throw new Error(`${id} ${row["名字"]}是外场维护记录，不能包含门将`);
    }

    const all = [...primary, ...secondary, ...other];
    if (new Set(all).size !== all.length) {
      throw new Error(`${id} ${row["名字"]}的位置跨档重复`);
    }

    normalized.set(id, {
      primary,
      secondary,
      other,
      primaryCodes: primary.map((position) => positionCodeByLabel[position]),
      secondaryCodes: secondary.map((position) => positionCodeByLabel[position]),
      otherCodes: other.map((position) => positionCodeByLabel[position])
    });
  }

  const missing = sourceRows.filter((row) => !seen.has(String(row["Unique ID"])));
  if (missing.length) {
    throw new Error(`维护表缺少${missing.length}名外场球员，请先运行--refresh`);
  }
  return normalized;
}

function makeMaintenanceRow(source, previous, firstCreation) {
  const id = String(source["Unique ID"]);
  const approved = firstCreation ? approvedInitialChanges[id] : null;
  return {
    "Unique ID": id,
    "球员类型": source["球员类型"],
    "名字": source["名字"],
    "俱乐部": source["俱乐部"],
    "年龄": source["年龄"],
    "最佳位置": previous?.["最佳位置"] ?? source["最佳位置"],
    "第二位置": approved?.secondary ?? previous?.["第二位置"] ?? source["第二位置"],
    "其他可用位置": previous?.["其他可用位置"] ?? source["其他可用位置"],
    "定价位置（只读）": source["定价位置"],
    "原全部位置（参考）": source["原全部位置"],
    "评分_射门": source["评分_射门"],
    "评分_传球": source["评分_传球"],
    "评分_控球": source["评分_控球"],
    "评分_防守": source["评分_防守"],
    "评分_速度": source["评分_速度"],
    "评分_身体": source["评分_身体"],
    "评分_意识": source["评分_意识"],
    "评分_意志": source["评分_意志"],
    "修改说明": approved?.note ?? previous?.["修改说明"] ?? ""
  };
}

function refreshMaintenance() {
  const sources = outfieldFiles.map(loadCsv);
  const sourceRows = sources.flatMap((source) => source.rows);
  const exists = fs.existsSync(maintenancePath);
  const previousRows = exists ? parseCsv(fs.readFileSync(maintenancePath, "utf8")).rows : [];
  const previousById = new Map(previousRows.map((row) => [String(row["Unique ID"]), row]));
  const rows = sourceRows.map((source) => makeMaintenanceRow(
    source,
    previousById.get(String(source["Unique ID"])),
    !exists
  ));

  fs.mkdirSync(path.dirname(maintenancePath), { recursive: true });
  fs.writeFileSync(maintenancePath, stringifyCsv(maintenanceHeaders, rows, { bom: true }), "utf8");
  console.log(`已刷新位置维护表：${path.relative(root, maintenancePath)}（${rows.length}名外场球员）`);
  if (!exists) console.log(`已写入${Object.keys(approvedInitialChanges).length}条本轮确认修正`);
}

function reviewPrimaryPositions() {
  if (!fs.existsSync(maintenancePath)) {
    throw new Error("位置维护表不存在，请先运行--refresh");
  }
  const parsed = parseCsv(fs.readFileSync(maintenancePath, "utf8"));
  const sourceRows = outfieldFiles.flatMap((file) => loadCsv(file).rows);
  const sourceById = new Map(sourceRows.map((row) => [String(row["Unique ID"]), row]));
  const draftAssignments = JSON.parse(fs.readFileSync(draftPoolsPath, "utf8")).assignments;
  for (const row of parsed.rows) {
    const id = String(row["Unique ID"]);
    if (!draftAssignments[id]) continue;
    const source = sourceById.get(id);
    if (!source) continue;
    row["最佳位置"] = source["最佳位置"];
    row["第二位置"] = source["第二位置"];
    row["其他可用位置"] = source["其他可用位置"];
    if (String(row["修改说明"]).startsWith("多最佳位置复核：")) row["修改说明"] = "";
  }
  const changed = applyReviewedPositionRules(parsed.rows);
  fs.writeFileSync(maintenancePath, stringifyCsv(maintenanceHeaders, parsed.rows, { bom: true }), "utf8");
  console.log(`多最佳位置复核完成：修改${changed.length}名球员`);
  console.log(changed.map((row) => `${row["Unique ID"]} ${row["名字"]}：${row["最佳位置"]}`).join("\n"));
}

function loadMaintenanceAndSources() {
  if (!fs.existsSync(maintenancePath)) {
    throw new Error("位置维护表不存在，请先运行--refresh");
  }
  const allSources = sourceFiles.map(loadCsv);
  const outfieldSources = allSources.slice(0, 2);
  const outfieldRows = outfieldSources.flatMap((source) => source.rows);
  const maintenanceRows = parseCsv(fs.readFileSync(maintenancePath, "utf8")).rows;
  const normalized = validateMaintenance(maintenanceRows, outfieldRows);
  return { allSources, outfieldSources, outfieldRows, maintenanceRows, normalized };
}

function updateSourceRows(outfieldSources, normalized) {
  let changed = 0;
  for (const source of outfieldSources) {
    for (const row of source.rows) {
      const id = String(row["Unique ID"]);
      const positions = normalized.get(id);
      const nextPrimary = positions.primary.join("、");
      const nextSecondary = positions.secondary.join("、");
      const nextOther = positions.other.join("、");
      if (
        row["最佳位置"] !== nextPrimary
        || row["第二位置"] !== nextSecondary
        || row["其他可用位置"] !== nextOther
      ) changed += 1;

      row["最佳位置"] = nextPrimary;
      row["第二位置"] = nextSecondary;
      row["其他可用位置"] = nextOther;
      const primaryAbility = Number(row["最佳位置能力"]);
      if (Number.isFinite(primaryAbility)) {
        row["第二位置能力"] = positions.secondary.length ? (primaryAbility * 0.95).toFixed(1) : "";
        row["其他位置能力"] = positions.other.length ? (primaryAbility * 0.9).toFixed(1) : "";
      }
    }
  }
  return changed;
}

function updateJsonFile(filePath, normalized) {
  const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
  let changed = 0;
  for (const player of data.players) {
    const positions = normalized.get(String(player.id));
    if (!positions) continue;
    const previous = JSON.stringify(player.positions);
    player.positions = {
      primary: positions.primaryCodes,
      secondary: positions.secondaryCodes,
      other: positions.otherCodes
    };
    player.positionDisplay = {
      primary: positions.primaryCodes.map((code) => positionLabelByCode[code]),
      secondary: positions.secondaryCodes.map((code) => positionLabelByCode[code]),
      other: positions.otherCodes.map((code) => positionLabelByCode[code])
    };
    player.bestPositionDisplay = positions.primaryCodes
      .map((code) => positionLabelByCode[code])
      .join("、");
    if (previous !== JSON.stringify(player.positions)) changed += 1;
  }
  if (data.meta) data.meta.positionTierOverlapCount = 0;
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  return changed;
}

function assertJsonSynchronized(filePath, normalized) {
  const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const playersById = new Map(data.players.map((player) => [String(player.id), player]));
  for (const [id, positions] of normalized) {
    const player = playersById.get(id);
    if (!player) throw new Error(`${path.relative(root, filePath)}缺少球员${id}`);
    const actual = JSON.stringify(player.positions);
    const expected = JSON.stringify({
      primary: positions.primaryCodes,
      secondary: positions.secondaryCodes,
      other: positions.otherCodes
    });
    if (actual !== expected) throw new Error(`${path.relative(root, filePath)}的球员${id}尚未同步`);
  }
}

function assertCsvSynchronized(outfieldSources, normalized) {
  for (const source of outfieldSources) {
    for (const row of source.rows) {
      const id = String(row["Unique ID"]);
      const positions = normalized.get(id);
      if (
        row["最佳位置"] !== positions.primary.join("、")
        || row["第二位置"] !== positions.secondary.join("、")
        || row["其他可用位置"] !== positions.other.join("、")
      ) throw new Error(`${source.relativePath}的球员${id}尚未同步`);
    }
  }
}

function reportOnlyCm(normalized, maintenanceRows) {
  const onlyCm = maintenanceRows.filter((row) => {
    const positions = normalized.get(String(row["Unique ID"]));
    return [...positions.primaryCodes, ...positions.secondaryCodes, ...positions.otherCodes].join(",") === "CM";
  });
  if (onlyCm.length) {
    throw new Error(`仍有${onlyCm.length}名球员只有CM：${onlyCm.map((row) => row["名字"]).join("、")}`);
  }
  console.log("仅有CM位置的外场球员：0");
}

function applyMaintenance() {
  const state = loadMaintenanceAndSources();
  const changedCsvPlayers = updateSourceRows(state.outfieldSources, state.normalized);
  for (const source of state.outfieldSources) {
    fs.writeFileSync(
      source.absolutePath,
      stringifyCsv(source.headers, source.rows, source.format),
      "utf8"
    );
  }
  const publicChanges = updateJsonFile(publicJsonPath, state.normalized);
  const engineChanges = updateJsonFile(engineJsonPath, state.normalized);
  console.log(`位置同步完成：底库${changedCsvPlayers}名，公开JSON ${publicChanges}名，引擎JSON ${engineChanges}名`);
  checkMaintenance();
}

function checkMaintenance() {
  const state = loadMaintenanceAndSources();
  assertCsvSynchronized(state.outfieldSources, state.normalized);
  assertJsonSynchronized(publicJsonPath, state.normalized);
  assertJsonSynchronized(engineJsonPath, state.normalized);
  reportOnlyCm(state.normalized, state.maintenanceRows);
  console.log(`位置维护校验通过：${state.maintenanceRows.length}名外场球员，跨档重复0，非法位置0`);
}

const mode = process.argv[2] ?? "--check";
try {
  if (mode === "--refresh") refreshMaintenance();
  else if (mode === "--review-primary") reviewPrimaryPositions();
  else if (mode === "--apply") applyMaintenance();
  else if (mode === "--check") checkMaintenance();
  else {
    throw new Error("用法：node scripts/player-position-maintenance.mjs --refresh|--review-primary|--apply|--check");
  }
} catch (error) {
  console.error(`位置维护失败：${error.message}`);
  process.exitCode = 1;
}
