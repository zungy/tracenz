const { join } = require("node:path");
const { homedir } = require("node:os");
const { readFile, mkdir, writeFile, rename } = require("node:fs/promises");
function bridgeDir(env = process.env) {
  return (
    env.TRACE_BRIDGE_DIR ||
    (process.platform === "win32"
      ? join(env.LOCALAPPDATA || join(homedir(), "AppData/Local"), "Trace")
      : join(homedir(), "Library/Application Support/Trace"))
  );
}
async function atomicJSON(path, value) {
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await rename(temp, path);
}
async function readBridge(directory = bridgeDir(), fetcher = fetch) {
  try {
    const value = JSON.parse(
      await readFile(join(directory, "connection.json"), "utf8"),
    );
    const url = new URL(value.url);
    if (
      value.version !== 1 ||
      url.protocol !== "http:" ||
      url.hostname !== "127.0.0.1" ||
      url.pathname !== "/" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !value.instanceId ||
      !/^trc_[a-f0-9]{64}$/.test(value.uploadToken)
    )
      return null;
    const response = await fetcher(`${url.origin}/api/health`, {
      redirect: "error",
      signal: AbortSignal.timeout(1000),
    });
    const health = await response.json();
    return response.ok &&
      health.service === "trace-backend" &&
      health.instanceId === value.instanceId
      ? value
      : null;
  } catch {
    return null;
  }
}
module.exports = { bridgeDir, atomicJSON, readBridge };
