import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { LocalStore } from "../server/local-store.js";
import { Forwarding } from "../server/forwarding.js";
import { createApp } from "../server/app.js";
import { demoEnvelopes } from "../server/demo.js";
import { validateEnvelope, hash } from "../server/domain.js";
import { configFromEnv } from "../server/config.js";
import { SupabaseStore } from "../server/supabase-store.js";

test("Forwarding persists offline, survives a lost receipt, deduplicates remotely and isolates destination changes", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "trace-forward-"));
  let local = new LocalStore(join(dir, "local"));
  const remote = new LocalStore(join(dir, "remote"));
  const owner = randomUUID(),
    token = "trc_" + "a".repeat(43);
  await remote.createToken(owner, {
    id: randomUUID(),
    name: "test",
    token_hash: hash(token),
    prefix: "test",
    created_at: new Date().toISOString(),
  });
  const server = createApp({ mode: "local" }, remote);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((r) => server.close(r));
    local.close();
    remote.close();
    await rm(dir, { recursive: true, force: true });
  });
  const envelopes = demoEnvelopes();
  await local.ingest(owner, validateEnvelope(envelopes[0]));
  let forward = new Forwarding(local, {
    allowHttp: true,
    fetcher: async () => {
      throw Error("offline");
    },
  });
  forward.save({ url, token, enabled: true });
  assert.equal(
    forward.status().counts.pending,
    undefined,
    "old history is opt-in",
  );
  const { row } = await local.ingest(owner, validateEnvelope(envelopes[1]));
  await forward.tick();
  assert.equal(forward.status().counts.pending, 1);
  assert.equal(JSON.stringify(forward.status()).includes(token), false);
  local.close();
  local = new LocalStore(join(dir, "local"));
  let loseReceipt = true;
  forward = new Forwarding(local, {
    allowHttp: true,
    fetcher: async (...args) => {
      const response = await fetch(...args);
      if (loseReceipt) {
        loseReceipt = false;
        await response.text();
        throw Error("lost response");
      }
      return response;
    },
  });
  forward.retry();
  await forward.tick();
  assert.equal((await remote.list(owner)).length, 1);
  forward.retry();
  await forward.tick();
  assert.equal(forward.status().counts.uploaded, 1);
  assert.equal((await remote.list(owner)).length, 1);
  assert.equal(
    (await remote.list(owner))[0].raw_event.rationale,
    row.raw_event.rationale,
  );
  forward.save({ enabled: false });
  await local.ingest(owner, validateEnvelope(envelopes[2]));
  assert.equal(forward.status().counts.pending, undefined);
  forward.save({ enabled: true, url, token });
  assert.equal(forward.backfill(), 2);
  assert.equal(forward.backfill(), 0);
  const oldDestination = forward.config().destination;
  forward.save({ enabled: true, url, token: "trc_" + "b".repeat(43) });
  assert.deepEqual(forward.status().counts, {});
  forward.backfill();
  await forward.tick();
  assert.equal(
    forward.status().counts.blocked,
    1,
    "revoked/unknown token needs attention",
  );
  assert.equal(
    local.db
      .prepare("SELECT COUNT(*) AS n FROM forwarding_jobs WHERE destination=?")
      .get(oldDestination).n,
    3,
  );
  assert.equal(
    (
      await fetch(url + "/api/events", {
        headers: { Authorization: "Bearer " + token },
      })
    ).status,
    403,
  );
});

test("Forwarding requires HTTPS, rejects Supabase URL, skips deleted rows and never follows redirects", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "trace-forward-validation-")),
    store = new LocalStore(dir);
  t.after(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  const token = "trc_" + "a".repeat(43),
    forward = new Forwarding(store, {
      fetcher: async (url, options) => {
        assert.equal(options.redirect, "error");
        return new Response("", { status: 503 });
      },
    });
  assert.throws(() =>
    forward.save({ enabled: true, url: "http://example.com", token }),
  );
  assert.throws(() =>
    forward.save({ enabled: true, url: "https://test.supabase.co", token }),
  );
  forward.save({ enabled: true, url: "https://trace.example.com", token });
  const owner = randomUUID(),
    row = (await store.ingest(owner, validateEnvelope(demoEnvelopes()[0]))).row;
  await forward.tick();
  assert.equal(forward.status().counts.pending, 1);
  await store.delete(owner, row.id);
  forward.retry();
  await forward.tick();
  assert.deepEqual(forward.status().counts, {});
});

test("Modern Supabase key aliases use apikey without pretending the secret is a JWT", async () => {
  const config = configFromEnv({
    TRACE_MODE: "supabase",
    TRACE_AI: "deterministic",
    SUPABASE_URL: "https://test.supabase.co",
    SUPABASE_SECRET_KEY: "sb_secret_test",
    SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
    TRACE_PUBLIC_ORIGIN: "https://trace.example.com",
  });
  assert.equal(config.anonKey, "sb_publishable_test");
  const store = new SupabaseStore(config, async (url, options) => {
    assert.equal(options.headers.apikey, "sb_secret_test");
    assert.equal(options.headers.Authorization, undefined);
    return new Response("[]");
  });
  await store.request("/rest/v1/trace_events");
});
