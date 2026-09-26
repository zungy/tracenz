import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const {
  registerCaptureShortcut,
  requestCheckpoint,
} = require("../desktop/hotkey.cjs");

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "trace-shortcut-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(
    join(directory, "connection.json"),
    JSON.stringify({
      version: 1,
      url: "http://127.0.0.1:4318",
      instanceId: "running-trace",
      uploadToken: "trc_" + "a".repeat(64),
    }),
  );
  const status = async (value) =>
    writeFile(
      join(directory, "fusion-shortcut-status.json"),
      JSON.stringify({
        version: 1,
        foreground: true,
        updatedAt: 10000,
        ...value,
      }),
    );
  await status({});
  return {
    directory,
    status,
    now: () => 10000,
    fetcher: async () =>
      Response.json({ service: "trace-backend", instanceId: "running-trace" }),
  };
}

test("checkpoint shortcut emits one bounded command for the live receiver without credentials", async (t) => {
  const f = await fixture(t);
  const request = await requestCheckpoint(f);
  assert.equal(request.command, "record-checkpoint");
  assert.equal(request.instanceId, "running-trace");
  assert.equal(request.expiresAt - request.requestedAt, 5000);
  const contents = await readFile(
    join(f.directory, "checkpoint-request.json"),
    "utf8",
  );
  assert.deepEqual(JSON.parse(contents), request);
  assert.doesNotMatch(contents, /trc_|access_token|refresh_token/);
});

test("checkpoint shortcut rejects signed-out, stale, background and changed-receiver requests", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    requestCheckpoint({ ...f, canCapture: () => false }),
    /Sign in/,
  );
  await f.status({ updatedAt: 6000 });
  await assert.rejects(requestCheckpoint(f), /Install\/update/);
  await f.status({ foreground: false });
  await assert.rejects(requestCheckpoint(f), /Switch to Fusion/);
  await f.status({});
  await assert.rejects(
    requestCheckpoint({
      ...f,
      fetcher: async () =>
        Response.json({ service: "trace-backend", instanceId: "old-trace" }),
    }),
    /not ready/,
  );
  let signedIn = true;
  await assert.rejects(
    requestCheckpoint({
      ...f,
      canCapture: () => signedIn,
      fetcher: async () => {
        signedIn = false;
        return f.fetcher();
      },
    }),
    /Sign in/,
  );
  await assert.rejects(readFile(join(f.directory, "checkpoint-request.json")), {
    code: "ENOENT",
  });
});

test("shortcut registration reports conflicts and releases only its own accelerator", async () => {
  const errors = [],
    removed = [];
  const failed = registerCaptureShortcut({
    globalShortcut: {
      register: () => false,
      unregister: (key) => removed.push(key),
    },
    onError: (message) => errors.push(message),
  });
  assert.equal(failed.registered, false);
  assert.match(failed.error, /already in use/);
  failed.dispose();
  assert.equal(removed.length, 0);
  assert.equal(errors.length, 1);
  const active = registerCaptureShortcut({
    globalShortcut: {
      register: (key) => key === "Control+Alt+S",
      unregister: (key) => removed.push(key),
    },
  });
  assert.equal(active.registered, true);
  active.dispose();
  active.dispose();
  assert.deepEqual(removed, ["Control+Alt+S"]);
});

test("shortcut coalesces repeated presses and ignores callbacks after disposal", async (t) => {
  const f = await fixture(t);
  let callback,
    healthCalls = 0;
  const shortcut = registerCaptureShortcut({
    ...f,
    globalShortcut: {
      register: (_key, handler) => {
        callback = handler;
        return true;
      },
      unregister() {},
    },
    fetcher: async () => {
      healthCalls++;
      return f.fetcher();
    },
  });
  await Promise.all([callback(), callback(), callback()]);
  assert.equal(healthCalls, 1);
  shortcut.dispose();
  await callback();
  assert.equal(healthCalls, 1);
});
