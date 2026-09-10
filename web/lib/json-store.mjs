import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const transientRenameCodes = new Set(["EACCES", "EBUSY", "EPERM"]);
const defaultRetryDelaysMs = [20, 40, 80, 160, 320, 640, 1280];

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function renameWithRetry(source, destination, {
  fsApi = fs,
  retryDelaysMs = defaultRetryDelaysMs
} = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fsApi.rename(source, destination);
      return;
    } catch (error) {
      const delay = retryDelaysMs[attempt];
      if (!transientRenameCodes.has(error.code) || delay === undefined) throw error;
      await wait(delay);
    }
  }
}

export async function writeJsonAtomically(filePath, value, {
  fsApi = fs,
  retryDelaysMs = defaultRetryDelaysMs,
  temporaryId = () => crypto.randomBytes(8).toString("hex")
} = {}) {
  const serialized = `${JSON.stringify(value)}\n`;
  const temporary = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${temporaryId()}.tmp`
  );
  let promoted = false;
  try {
    const handle = await fsApi.open(temporary, "wx");
    try {
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await renameWithRetry(temporary, filePath, { fsApi, retryDelaysMs });
    promoted = true;
  } finally {
    if (!promoted) await fsApi.rm(temporary, { force: true }).catch(() => undefined);
  }
}

export function createJsonWriteQueue(filePath, { writer = writeJsonAtomically } = {}) {
  let queue = Promise.resolve();
  return (valueOrFactory) => {
    const task = queue.then(() => writer(
      filePath,
      typeof valueOrFactory === "function" ? valueOrFactory() : valueOrFactory
    ));
    queue = task.catch(() => undefined);
    return task;
  };
}

async function statOrNull(filePath, fsApi) {
  try {
    return await fsApi.stat(filePath);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export async function recoverLegacyTemp(filePath, validate, {
  fsApi = fs,
  retryDelaysMs = defaultRetryDelaysMs
} = {}) {
  const temporary = `${filePath}.tmp`;
  const temporaryStat = await statOrNull(temporary, fsApi);
  if (!temporaryStat) return { recovered: false, reason: "missing" };
  let parsed;
  try {
    parsed = JSON.parse(await fsApi.readFile(temporary, "utf8"));
  } catch {
    return { recovered: false, reason: "invalid" };
  }
  if (!validate(parsed)) return { recovered: false, reason: "invalid" };
  const destinationStat = await statOrNull(filePath, fsApi);
  if (destinationStat && destinationStat.mtimeMs >= temporaryStat.mtimeMs) {
    await fsApi.rm(temporary, { force: true });
    return { recovered: false, reason: "stale" };
  }
  await renameWithRetry(temporary, filePath, { fsApi, retryDelaysMs });
  return { recovered: true, reason: "newer-valid-temp" };
}
