// Explicit opt-in verification: one paid model request using a synthetic checkpoint.
// Credentials are read from the environment and never written to the report.
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { configFromEnv } from "../server/config.js";
import { LocalStore } from "../server/local-store.js";
import { createApp } from "../server/app.js";
import { createSummarizer } from "../server/ai.js";
import { demoEnvelopes } from "../server/demo.js";

const config = configFromEnv();
assert.equal(
  config.ai,
  "openai",
  "Set TRACE_AI=openai before running this opt-in check.",
);
const dir = resolve(".data/live-ai-verification");
const store = new LocalStore(dir);
const server = createApp({ ...config, mode: "local" }, store);
server.listen(0, "127.0.0.1");
await once(server, "listening");
const origin = `http://127.0.0.1:${server.address().port}`;
const report = {
  checkedAt: new Date().toISOString(),
  model: config.model,
  fixture: "Synthetic Fusion-shaped checkpoint; not a live Fusion capture",
};
try {
  const envelope = demoEnvelopes().at(-1);
  envelope.event.id = `live-ai-check-${Date.now()}`;
  const upload = await fetch(`${origin}/api/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(envelope),
  });
  assert.equal(upload.status, 200);
  const saved = await upload.json();
  const row = await store.claim();
  assert.equal(row.id, saved.eventId);
  try {
    const result = await createSummarizer(config)(
      row.raw_event,
      await store.image(row),
    );
    await store.settle(row, result, null);
  } catch (error) {
    await store.settle(row, null, error.message);
    throw error;
  }
  const timeline = await (await fetch(`${origin}/api/events`)).json();
  const completed = timeline.events.find((event) => event.id === saved.eventId);
  assert.equal(completed.status, "complete");
  assert.equal(completed.aiProvider, "openai");
  assert.equal(completed.ai.rationale_used, envelope.event.rationale);
  report.ok = true;
  report.title = completed.ai.title;
  report.summary = completed.ai.summary;
  report.eventId = saved.eventId;
} catch (error) {
  report.ok = false;
  report.error = error.message;
  process.exitCode = 1;
} finally {
  await new Promise((resolve) => server.close(resolve));
  store.close();
  await mkdir("artifacts", { recursive: true });
  await writeFile(
    "artifacts/live-ai-verification.json",
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
}
