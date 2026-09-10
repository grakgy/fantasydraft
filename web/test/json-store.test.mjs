import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createJsonWriteQueue,
  recoverLegacyTemp,
  writeJsonAtomically
} from "../lib/json-store.mjs";

async function temporaryDirectory(context) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "fm26-json-store-"));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test("原子写入遇到Windows瞬时占用会重试且不留下临时文件", async (context) => {
  const directory = await temporaryDirectory(context);
  const destination = path.join(directory, "runs.json");
  let attempts = 0;
  const fsApi = {
    open: (...args) => fs.open(...args),
    rm: (...args) => fs.rm(...args),
    rename: async (...args) => {
      attempts += 1;
      if (attempts < 3) {
        const error = new Error("locked");
        error.code = "EPERM";
        throw error;
      }
      return fs.rename(...args);
    }
  };
  await writeJsonAtomically(destination, { version: 1, runs: ["saved"] }, {
    fsApi,
    retryDelaysMs: [1, 1],
    temporaryId: () => "retry"
  });
  assert.equal(attempts, 3);
  assert.deepEqual(JSON.parse(await fs.readFile(destination, "utf8")), { version: 1, runs: ["saved"] });
  assert.deepEqual((await fs.readdir(directory)).filter((name) => name.endsWith(".tmp")), []);
});

test("一次保存失败不会让后续保存队列永久失败", async () => {
  let attempts = 0;
  let stored = null;
  const enqueue = createJsonWriteQueue("ignored.json", {
    writer: async (_filePath, value) => {
      attempts += 1;
      if (attempts === 1) throw new Error("first write failed");
      stored = value;
    }
  });
  await assert.rejects(enqueue({ revision: 1 }), /first write failed/);
  await enqueue({ revision: 2 });
  assert.equal(attempts, 2);
  assert.deepEqual(stored, { revision: 2 });
});

test("并发原子写入使用独立临时文件", async (context) => {
  const directory = await temporaryDirectory(context);
  const destination = path.join(directory, "runs.json");
  await Promise.all([
    writeJsonAtomically(destination, { revision: 1 }, { temporaryId: () => "first" }),
    writeJsonAtomically(destination, { revision: 2 }, { temporaryId: () => "second" })
  ]);
  const stored = JSON.parse(await fs.readFile(destination, "utf8"));
  assert.ok([1, 2].includes(stored.revision));
  assert.deepEqual((await fs.readdir(directory)).filter((name) => name.endsWith(".tmp")), []);
});

test("启动时恢复比正式存档更新且内容有效的旧版临时文件", async (context) => {
  const directory = await temporaryDirectory(context);
  const destination = path.join(directory, "runs.json");
  const temporary = `${destination}.tmp`;
  await fs.writeFile(destination, JSON.stringify({ version: 1, runs: ["old"] }), "utf8");
  const oldTime = new Date(Date.now() - 10_000);
  await fs.utimes(destination, oldTime, oldTime);
  await fs.writeFile(temporary, JSON.stringify({ version: 1, runs: ["new"] }), "utf8");
  const result = await recoverLegacyTemp(destination, (stored) => Array.isArray(stored?.runs));
  assert.equal(result.recovered, true);
  assert.deepEqual(JSON.parse(await fs.readFile(destination, "utf8")), { version: 1, runs: ["new"] });
  await assert.rejects(fs.stat(temporary), { code: "ENOENT" });
});
