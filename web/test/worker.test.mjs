import test from "node:test";
import assert from "node:assert/strict";
import { forwardedRequest } from "../worker.mjs";

test("Worker转发已有API请求时保留JSON请求体并清除伪造内部编号", async () => {
  const original = new Request("https://example.test/api/runs/abc/draft/picks", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-fm26-internal-run-id": "forged"
    },
    body: JSON.stringify({ playerId: "49038271", slotId: "starter_3" })
  });
  const forwarded = forwardedRequest(original);
  assert.deepEqual(await forwarded.json(), { playerId: "49038271", slotId: "starter_3" });
  assert.equal(forwarded.headers.has("x-fm26-internal-run-id"), false);
});

test("Worker创建运行时只注入自己生成的编号", async () => {
  const original = new Request("https://example.test/api/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}"
  });
  const body = await original.arrayBuffer();
  const forwarded = forwardedRequest(
    original,
    body,
    "x-fm26-internal-run-id",
    "0123456789abcdef0123456789abcdef"
  );
  assert.deepEqual(await forwarded.json(), {});
  assert.equal(
    forwarded.headers.get("x-fm26-internal-run-id"),
    "0123456789abcdef0123456789abcdef"
  );
});
