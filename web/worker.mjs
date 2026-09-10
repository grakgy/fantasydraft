import {
  PVP_ROOM_RETENTION_MS,
  createRuntimeStore,
  handleApiFetch
} from "./server.mjs";

const runPathPattern = /^\/api\/runs\/([a-f0-9]{32})(?:\/|$)/;
const pvpPathPattern = /^\/api\/pvp\/rooms\/([A-Z0-9]{6})(?:\/|$)/;
const pvpAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const internalRunHeader = "x-fm26-internal-run-id";
const internalPvpHeader = "x-fm26-internal-pvp-code";
const statelessRuntime = createRuntimeStore();

function randomRunId() {
  return crypto.randomUUID().replaceAll("-", "");
}

function randomPvpCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return [...bytes].map((value) => pvpAlphabet[value % pvpAlphabet.length]).join("");
}

function sessionStub(env, name) {
  return env.GAME_SESSIONS.get(env.GAME_SESSIONS.idFromName(name));
}

export function forwardedRequest(request, body, internalHeader, internalValue) {
  const headers = new Headers(request.headers);
  headers.delete(internalRunHeader);
  headers.delete(internalPvpHeader);
  if (internalHeader && internalValue) headers.set(internalHeader, internalValue);
  if (body === undefined) return new Request(request, { headers });
  return new Request(request.url, {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : body,
    redirect: request.redirect
  });
}

async function routeRunRequest(request, env, pathname) {
  if (request.method === "POST" && pathname === "/api/runs") {
    const body = await request.arrayBuffer();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const runId = randomRunId();
      const response = await sessionStub(env, `run:${runId}`).fetch(
        forwardedRequest(request, body, internalRunHeader, runId)
      );
      if (response.status !== 409) return response;
    }
    return Response.json({ error: "暂时无法创建运行，请重试" }, { status: 503 });
  }

  const match = pathname.match(runPathPattern);
  if (!match) return null;
  return sessionStub(env, `run:${match[1]}`).fetch(forwardedRequest(request));
}

async function routePvpRequest(request, env, pathname) {
  if (request.method === "POST" && pathname === "/api/pvp/rooms") {
    const body = await request.arrayBuffer();
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const code = randomPvpCode();
      const response = await sessionStub(env, `pvp:${code}`).fetch(
        forwardedRequest(request, body, internalPvpHeader, code)
      );
      if (response.status !== 409) return response;
    }
    return Response.json({ error: "暂时无法创建房间，请重试" }, { status: 503 });
  }

  const match = pathname.match(pvpPathPattern);
  if (!match) return null;
  return sessionStub(env, `pvp:${match[1]}`).fetch(forwardedRequest(request));
}

export class GameSession {
  constructor(ctx) {
    this.ctx = ctx;
    this.runtime = null;
    this.ready = ctx.blockConcurrencyWhile(async () => {
      const [run, room] = await Promise.all([
        ctx.storage.get("run"),
        ctx.storage.get("room")
      ]);
      this.runtime = createRuntimeStore({
        run,
        room,
        allowForcedIds: true,
        defer: (promise) => ctx.waitUntil(promise),
        persistRun: async (runs) => {
          if (runs[0]) await ctx.storage.put("run", runs[0]);
          else await ctx.storage.delete("run");
        },
        persistRoom: async (rooms) => {
          const currentRoom = rooms[0];
          if (!currentRoom) {
            await ctx.storage.delete("room");
            await ctx.storage.deleteAlarm();
            return;
          }
          await ctx.storage.put("room", currentRoom);
          const expiresAt = Date.parse(currentRoom.createdAt) + PVP_ROOM_RETENTION_MS;
          await ctx.storage.setAlarm(Math.max(Date.now() + 1_000, expiresAt));
        }
      });
    });
  }

  async fetch(request) {
    await this.ready;
    const runtime = {
      ...this.runtime,
      forcedRunId: request.headers.get(internalRunHeader),
      forcedPvpCode: request.headers.get(internalPvpHeader)
    };
    return handleApiFetch(request, runtime);
  }

  async alarm() {
    await this.ctx.storage.deleteAll();
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/runs")) {
      const response = await routeRunRequest(request, env, url.pathname);
      if (response) return response;
    }
    if (url.pathname.startsWith("/api/pvp/rooms")) {
      const response = await routePvpRequest(request, env, url.pathname);
      if (response) return response;
    }
    if (url.pathname.startsWith("/api/")) return handleApiFetch(request, statelessRuntime);
    return env.ASSETS.fetch(request);
  }
};
