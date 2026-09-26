import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { demoEnvelopes } from "../server/demo.js";
import bridge from "../desktop/bridge.cjs";
test("Receiver chooses another port when occupied and publishes a usable discovery record", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "trace-process-"));
  const fixture = demoEnvelopes().at(-1);
  await writeFile(join(dir, "event.json"), JSON.stringify(fixture.event));
  await writeFile(
    join(dir, "viewport.png"),
    Buffer.from(fixture.viewport.base64, "base64"),
  );
  async function python(mode) {
    const proc = spawn("python", ["test/fusion-deliver.py", dir, mode], {
      windowsHide: true,
      stdio: "pipe",
    });
    let errors = "";
    proc.stderr.on("data", (chunk) => (errors += chunk));
    proc.stdout.resume();
    const [code] = await once(proc, "exit");
    assert.equal(code, 0, errors);
  }
  await python("queue");
  const occupied = createServer((req, res) => res.end("unrelated"));
  occupied.listen(0, "127.0.0.1");
  await once(occupied, "listening");
  const child = spawn(process.execPath, ["server/index.js"], {
    windowsHide: true,
    env: {
      ...process.env,
      TRACE_MODE: "local",
      TRACE_AI: "deterministic",
      TRACE_BRIDGE_DIR: dir,
      TRACE_DATA_DIR: join(dir, "data"),
      PORT: String(occupied.address().port),
      HOST: "127.0.0.1",
    },
    stdio: "pipe",
  });
  let output = "";
  child.stderr.on("data", (chunk) => (output += chunk));
  child.stdout.resume();
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill();
      await once(child, "exit");
    }
    await new Promise((r) => occupied.close(r));
    await rm(dir, { recursive: true, force: true });
  });
  let record;
  for (let i = 0; i < 80; i++) {
    record = await bridge.readBridge(dir);
    if (record) break;
    if (child.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(record, output || "Discovery file was not published");
  await python("deliver");
  const events = await (await fetch(record.url + "/api/events")).json();
  assert.equal(events.events.length, 1);
  assert.equal(events.events[0].rationale, fixture.event.rationale);
  assert.notEqual(Number(new URL(record.url).port), occupied.address().port);
  const response = await fetch(record.url + "/api/config");
  assert.equal((await response.json()).mode, "local");
});
