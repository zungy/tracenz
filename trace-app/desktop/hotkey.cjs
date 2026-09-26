const { randomUUID } = require("node:crypto");
const { readFile } = require("node:fs/promises");
const { join } = require("node:path");
const { bridgeDir, readBridge, atomicJSON } = require("./bridge.cjs");

const accelerator = "Control+Alt+S";

async function requestCheckpoint({
  directory = bridgeDir(),
  canCapture = () => true,
  fetcher = fetch,
  now = Date.now,
} = {}) {
  if (!canCapture())
    throw new Error("Sign in to Trace before recording a checkpoint.");
  const bridge = await readBridge(directory, fetcher);
  if (!bridge) throw new Error("Trace's Fusion connection is not ready yet.");
  let status;
  try {
    status = JSON.parse(
      await readFile(join(directory, "fusion-shortcut-status.json"), "utf8"),
    );
  } catch {}
  const time = now();
  if (
    !status ||
    status.version !== 1 ||
    !Number.isFinite(status.updatedAt) ||
    time - status.updatedAt > 3000 ||
    status.updatedAt > time + 1000
  )
    throw new Error(
      "Install/update the Fusion add-in and restart Fusion to enable Ctrl+Alt+S.",
    );
  if (status.foreground !== true)
    throw new Error(
      "Switch to Fusion, finish the current command, then press Ctrl+Alt+S.",
    );
  // Authentication may have changed while checking the local receiver.
  if (!canCapture())
    throw new Error("Sign in to Trace before recording a checkpoint.");
  const request = {
    version: 1,
    command: "record-checkpoint",
    id: randomUUID(),
    instanceId: bridge.instanceId,
    requestedAt: time,
    expiresAt: time + 5000,
  };
  await atomicJSON(join(directory, "checkpoint-request.json"), request);
  return request;
}

function registerCaptureShortcut({
  globalShortcut,
  directory = bridgeDir(),
  canCapture = () => true,
  onError = () => {},
  fetcher = fetch,
  now = Date.now,
}) {
  let disposed = false,
    pending = false,
    last = -Infinity,
    error = null;
  const capture = async () => {
    if (disposed || pending || now() - last < 1000) return;
    pending = true;
    last = now();
    try {
      await requestCheckpoint({
        directory,
        canCapture: () => !disposed && canCapture(),
        fetcher,
        now,
      });
      error = null;
    } catch (cause) {
      error = cause.message;
      onError(error);
    } finally {
      pending = false;
    }
  };
  let registered = false;
  try {
    registered = globalShortcut.register(accelerator, capture);
  } catch {}
  if (!registered) {
    error =
      "Ctrl+Alt+S is already in use. Record Design Change in Fusion still works.";
    onError(error);
  }
  return {
    accelerator,
    registered,
    get error() {
      return error;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (registered) globalShortcut.unregister(accelerator);
    },
  };
}

module.exports = { registerCaptureShortcut, requestCheckpoint };
