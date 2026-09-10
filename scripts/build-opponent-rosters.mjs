import fs from "node:fs/promises";

const PLAYERS_URL = "https://raw.githubusercontent.com/vaastav/Fantasy-Premier-League/master/data/2025-26/players_raw.csv";
const TEAMS_URL = "https://raw.githubusercontent.com/vaastav/Fantasy-Premier-League/master/data/2025-26/teams.csv";

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"') {
      if (quoted && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else quoted = !quoted;
    } else if (character === "," && !quoted) {
      row.push(field);
      field = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      row.push(field);
      if (row.some(Boolean)) rows.push(row);
      row = [];
      field = "";
    } else field += character;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  const headers = rows.shift();
  return rows.map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])));
}

const manualClubs = {
  coventry_city: [
    ["Oliver Dovin", "GK"], ["Ben Wilson", "GK"], ["Carl Rushworth", "GK"],
    ["Jay Dasilva", "DEF"], ["Bobby Thomas", "DEF"], ["Liam Kitching", "DEF"], ["Jake Bidwell", "DEF"],
    ["Joel Latibeaudiere", "DEF"], ["Luke Woolfenden", "DEF"], ["Milan van Ewijk", "DEF"], ["Miguel Ángel Brau", "DEF"],
    ["Kaine Kesler-Hayden", "DEF"], ["Jahnoah Markelo", "DEF"],
    ["Jack Rudoni", "MID"], ["Matt Grimes", "MID"], ["Tatsuhiro Sakamoto", "MID"], ["Jamie Allen", "MID"],
    ["Ephron Mason-Clark", "MID"], ["Romain Esse", "MID"], ["Frank Onyeka", "MID"], ["Yang Min-hyeok", "MID"],
    ["Josh Eccles", "MID"], ["Victor Torp", "MID"],
    ["Ellis Simms", "FWD"], ["Haji Wright", "FWD"], ["Brandon Thomas-Asante", "FWD"], ["Norman Bassette", "FWD"]
  ],
  hull_city: [
    ["Ivor Pandur", "GK"], ["Dillon Phillips", "GK"],
    ["Lewie Coyle", "DEF"], ["Ryan Giles", "DEF"], ["Charlie Hughes", "DEF"], ["Semi Ajayi", "DEF"],
    ["John Egan", "DEF"], ["Matty Jacob", "DEF"], ["Cody Drameh", "DEF"], ["Akin Famewo", "DEF"], ["Cathal McCarthy", "DEF"],
    ["Regan Slater", "MID"], ["John Lundstram", "MID"], ["Amir Hadžiahmetović", "MID"], ["Matt Crooks", "MID"],
    ["Kasey Palmer", "MID"], ["Toby Collyer", "MID"], ["Kieran Dowell", "MID"],
    ["Mohamed Belloumi", "FWD"], ["Oli McBurnie", "FWD", 19], ["Liam Millar", "FWD"], ["Joe Gelhardt", "FWD"],
    ["David Akintola", "FWD"], ["Enis Destan", "FWD"], ["Yū Hirakawa", "FWD"], ["Lewis Koumas", "FWD"], ["Kyle Joseph", "FWD"]
  ],
  ipswich_town: [
    ["Alex Palmer", "GK"], ["David Button", "GK"], ["Christian Walton", "GK"],
    ["Leif Davis", "DEF"], ["Cédric Kipré", "DEF"], ["Ashley Young", "DEF"], ["Ben Johnson", "DEF"],
    ["Darnell Furlong", "DEF"], ["Conor Townsend", "DEF"], ["Jacob Greaves", "DEF"], ["Elkan Baggott", "DEF"], ["Dara O'Shea", "DEF"],
    ["Azor Matusiwa", "MID"], ["Dan Neil", "MID"], ["Wes Burns", "MID"], ["Jens Cajuste", "MID"],
    ["Jack Taylor", "MID"], ["Marcelino Núñez", "MID"],
    ["Sindre Walle Egeli", "FWD"], ["George Hirst", "FWD"], ["Jaden Philogene", "FWD"], ["Kasey McAteer", "FWD"],
    ["Chuba Akpom", "FWD"], ["Iván Azón", "FWD"], ["Anis Mehmeti", "FWD"], ["Jack Clarke", "FWD"]
  ]
};

const clubMapping = {
  Arsenal: "arsenal",
  "Aston Villa": "aston_villa",
  Bournemouth: "bournemouth",
  Brentford: "brentford",
  Brighton: "brighton",
  Chelsea: "chelsea",
  Burnley: "burnley",
  "Crystal Palace": "crystal_palace",
  Everton: "everton",
  Fulham: "fulham",
  Leeds: "leeds_united",
  Liverpool: "liverpool",
  "Man City": "man_city",
  "Man Utd": "man_utd",
  Newcastle: "newcastle_united",
  "Nott'm Forest": "nottingham_forest",
  Sunderland: "sunderland",
  Spurs: "tottenham"
  ,"West Ham": "west_ham"
  ,Wolves: "wolves"
};

const positionByElementType = { 1: "GK", 2: "DEF", 3: "MID", 4: "FWD" };
async function download(url) {
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { "user-agent": "fantasy-draft-roster-builder/1.0" } });
      if (!response.ok) throw new Error(`${url} download failed: ${response.status}`);
      return await response.text();
    } catch (error) {
      lastError = error;
      if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, attempt * 750));
    }
  }
  throw lastError;
}
const [playersText, teamsText] = process.argv[2] && process.argv[3]
  ? await Promise.all([fs.readFile(process.argv[2], "utf8"), fs.readFile(process.argv[3], "utf8")])
  : await Promise.all([download(PLAYERS_URL), download(TEAMS_URL)]);

const teamNames = Object.fromEntries(parseCsv(teamsText).map((team) => [team.id, team.name]));
const clubs = Object.fromEntries(Object.values(clubMapping).map((id) => [id, []]));
for (const player of parseCsv(playersText)) {
  const clubId = clubMapping[teamNames[player.team]];
  if (!clubId) continue;
  const minutes = Number(player.minutes || 0);
  const goals = Number(player.goals_scored || 0);
  const assists = Number(player.assists || 0);
  clubs[clubId].push({
    name: `${player.first_name} ${player.second_name}`.replace(/\s+/g, " ").trim(),
    position: positionByElementType[player.element_type] || "MID",
    minutes,
    goals,
    assists,
    weight: Math.max(1, Math.round(minutes / 180) + goals * 3 + assists * 2)
  });
}

for (const [clubId, players] of Object.entries(manualClubs)) {
  if (!clubs[clubId]) continue;
  clubs[clubId] = players.map(([name, position, goals = 0]) => ({
    name,
    position,
    minutes: 0,
    goals,
    assists: 0,
    weight: Math.max(1, 3 + goals * 3)
  }));
}

for (const players of Object.values(clubs)) {
  players.sort((a, b) => b.minutes - a.minutes || b.weight - a.weight || a.name.localeCompare(b.name));
}

const output = {
  version: "1.0",
  season: "2025/26",
  description: "AI球队比赛事件使用的2025/26英超20队真实球员名单，来自该赛季FPL数据。与玩家梦幻阵容允许重名。",
  sources: [
    PLAYERS_URL,
    TEAMS_URL
  ],
  clubs
};

await fs.writeFile(new URL("../config/opponent-rosters.json", import.meta.url), `${JSON.stringify(output, null, 2)}\n`, "utf8");
console.log(Object.fromEntries(Object.entries(clubs).map(([id, players]) => [id, players.length])));
