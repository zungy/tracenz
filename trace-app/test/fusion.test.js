import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import bridge from "../desktop/bridge.cjs";
import installer from "../desktop/fusion.cjs";
import { publishBridge } from "../server/local-bridge.js";
import { LocalStore } from "../server/local-store.js";
import { createApp } from "../server/app.js";
import { hash } from "../server/domain.js";
test("Discovery verifies backend identity; publication reuses upload-only credential and cleans up safely", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "trace-bridge-"));
  const old = process.env.TRACE_BRIDGE_DIR;
  process.env.TRACE_BRIDGE_DIR = dir;
  const store = new LocalStore(join(dir, "data")),
    config = {
      mode: "local",
      dataDir: join(dir, "data"),
      bridgeInstance: randomUUID(),
    };
  const server = createApp(config, store);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    await new Promise((r) => server.close(r));
    store.close();
    if (old === undefined) delete process.env.TRACE_BRIDGE_DIR;
    else process.env.TRACE_BRIDGE_DIR = old;
    await rm(dir, { recursive: true, force: true });
  });
  const stop = await publishBridge(config, store, server.address().port);
  const first = await bridge.readBridge(dir);
  assert.ok(first);
  assert.ok(await store.tokenOwner(hash(first.uploadToken)));
  const denied = await fetch(first.url + "/api/events", {
    headers: { Authorization: "Bearer " + first.uploadToken },
  });
  assert.equal(denied.status, 403);
  await publishBridge(config, store, server.address().port);
  assert.equal((await bridge.readBridge(dir)).uploadToken, first.uploadToken);
  await bridge.atomicJSON(join(dir, "connection.json"), {
    ...first,
    instanceId: "stale",
  });
  assert.equal(await bridge.readBridge(dir), null);
  await stop();
  assert.ok(await readFile(join(dir, "connection.json")));
});
test("Add-in installer backs up working version and preserves user settings", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "trace-install-")),
    target = join(dir, "addin");
  await mkdir(target);
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(target, "DesignRecorderAgent.py"), "working v0.4");
  await writeFile(
    join(target, "DesignRecorderAgent.config.json"),
    '{"uploadEnabled":false}',
  );
  const result = await installer.installFusion(
    resolve("fusion/DesignRecorderAgent"),
    target,
    join(dir, "backups"),
  );
  assert.equal(
    await readFile(join(result.backup, "DesignRecorderAgent.py"), "utf8"),
    "working v0.4",
  );
  assert.equal(
    JSON.parse(
      await readFile(join(target, "DesignRecorderAgent.config.json"), "utf8"),
    ).uploadEnabled,
    false,
  );
  assert.equal(
    JSON.parse(
      await readFile(join(target, "DesignRecorderAgent.manifest"), "utf8"),
    ).version,
    JSON.parse(
      await readFile(
        resolve("fusion/DesignRecorderAgent/DesignRecorderAgent.manifest"),
        "utf8",
      ),
    ).version,
  );
  assert.ok(
    (await readFile(join(target, "trace_transport.py"), "utf8")).includes(
      "class Transport",
    ),
  );
});
