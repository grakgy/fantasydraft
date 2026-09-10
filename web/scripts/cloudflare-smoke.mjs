import assert from "node:assert/strict";

const base = String(process.env.FM26_BASE_URL ?? "http://127.0.0.1:3300").replace(/\/$/, "");
const verifyRunId = process.argv.find((value) => /^[a-f0-9]{32}$/.test(value));

async function request(pathname, options = {}) {
  const response = await fetch(`${base}${pathname}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers ?? {}) }
  });
  const payload = response.status === 204 ? null : await response.json();
  assert.ok(response.ok, `${options.method ?? "GET"} ${pathname}: ${payload?.error ?? response.status}`);
  return payload;
}

if (verifyRunId) {
  const persisted = await request(`/api/runs/${verifyRunId}`);
  assert.equal(persisted.runId, verifyRunId);
  console.log(`PERSISTENCE_OK=${verifyRunId}`);
  process.exit(0);
}

const health = await request("/api/health");
assert.equal(health.engineDataExposed, false);
assert.equal(health.draftPlayers, 900);
const config = await request("/api/config");
assert.ok(config.formations.length > 0);
assert.ok(config.draftPlaystyles.length > 0);

let run = await request("/api/runs", {
  method: "POST",
  body: JSON.stringify({
    formationId: config.formations[0].id,
    playstyleId: config.draftPlaystyles[0].id
  })
});
assert.match(run.runId, /^[a-f0-9]{32}$/);

for (let round = 0; round < 11; round += 1) {
  const draw = await request(`/api/runs/${run.runId}/draft/candidates`, { method: "POST", body: "{}" });
  const candidate = draw.candidates.find((item) => item.compatibleSlotIds.length);
  assert.ok(candidate, `第 ${round + 1} 轮没有可落位候选`);
  run = await request(`/api/runs/${run.runId}/draft/picks`, {
    method: "POST",
    body: JSON.stringify({ playerId: candidate.id, slotId: candidate.compatibleSlotIds[0] })
  });
}

run = await request(`/api/runs/${run.runId}/lineup`, {
  method: "PUT",
  body: JSON.stringify({ starters: run.draftLineup.starters, tacticId: run.playstyle.id })
});
let season = await request(`/api/runs/${run.runId}/season/simulate`, { method: "POST", body: "{}" });

async function resolvePendingEvent() {
  if (!season.pendingEvent) return;
  season = await request(`/api/runs/${run.runId}/season/event/choose`, {
    method: "POST",
    body: JSON.stringify({ choiceId: season.pendingEvent.choices[0].id })
  });
  assert.equal(season.pendingEvent.status, "resolved");
  season = await request(`/api/runs/${run.runId}/season/event/acknowledge`, { method: "POST", body: "{}" });
}

while (!season.completed) {
  await resolvePendingEvent();
  if (season.winterWindow?.status === "open") {
    season = await request(`/api/runs/${run.runId}/season/winter-window`, {
      method: "POST",
      body: JSON.stringify({ participate: false })
    });
  }
  season = await request(`/api/runs/${run.runId}/season/advance`, { method: "POST", body: "{}" });
}
assert.equal(season.progress, 38);
assert.equal(season.playerFixtures.length, 38);

const pvp = await request("/api/pvp/rooms", { method: "POST", body: "{}" });
assert.match(pvp.room.code, /^[A-Z0-9]{6}$/);
const pvpWithCpu = await request(`/api/pvp/rooms/${pvp.room.code}/add-cpu`, {
  method: "POST",
  headers: { "x-pvp-token": pvp.token },
  body: "{}"
});
assert.equal(pvpWithCpu.opponent.displayName, "AI 对手");

console.log(`CLOUDFLARE_SMOKE_OK run=${run.runId} progress=${season.progress} room=${pvp.room.code}`);
console.log(`PERSISTENCE_RUN_ID=${run.runId}`);
