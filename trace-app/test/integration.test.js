import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { LocalStore } from "../server/local-store.js";
import { createApp } from "../server/app.js";
import { createSummarizer } from "../server/ai.js";
import { demoEnvelopes } from "../server/demo.js";
import { validateEnvelope, hash } from "../server/domain.js";

const owner = "00000000-0000-4000-8000-000000000001";
const fixture = demoEnvelopes().at(-1);
function envelope(id = undefined) {
  const body = structuredClone(fixture);
  if (id) body.event.id = id;
  return body;
}
async function setup(t, config = {}, fetcher) {
  const dir = mkdtempSync(join(tmpdir(), "trace-test-")),
    store = new LocalStore(dir);
  const server = createApp(
    { mode: "local", ai: "deterministic", ...config },
    store,
    { fetcher },
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  async function request(path, { method = "GET", body, headers = {} } = {}) {
    return fetch(`${url}${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  return { store, request, url, dir };
}
test("Fusion upload → durable image/event → summary → timeline → complete ZIP export", async (t) => {
  const { store, request } = await setup(t);
  const response = await request("/api/events", {
    method: "POST",
    body: envelope(),
  });
  assert.equal(response.status, 200);
  const saved = await response.json();
  assert.equal(saved.status, "pending");
  assert.equal(saved.ai, null);
  const row = await store.claim();
  assert.equal(row.id, saved.eventId);
  assert.equal(row.raw_event.engineeringChanges.length, 1);
  assert.equal(row.raw_event.rawChangeCount, 4);
  const result = await createSummarizer({ ai: "deterministic" })(
    row.raw_event,
    await store.image(row),
  );
  await store.settle(row, result, null);
  const timeline = await (await request("/api/events")).json();
  assert.equal(timeline.events.length, 1);
  assert.equal(timeline.events[0].changeCount, 1);
  assert.equal(timeline.events[0].status, "complete");
  assert.match(timeline.events[0].ai.summary, /4\.00 mm/);
  assert.equal(timeline.events[0].aiProvider, "template");
  const png = Buffer.from(
    await (await request(`/api/events/${saved.eventId}/image`)).arrayBuffer(),
  );
  assert.equal(hash(png), hash(Buffer.from(fixture.viewport.base64, "base64")));
  const doc = (await (await request("/api/documents")).json()).documents[0];
  assert.equal(doc.event_count, 1);
  const archive = Buffer.from(
    await (await request(`/api/documents/${doc.id}/export`)).arrayBuffer(),
  );
  assert.equal(archive.readUInt32LE(0), 0x04034b50);
  assert.ok(archive.includes(Buffer.from("manifest.json")));
  assert.ok(archive.includes(Buffer.from(`${saved.eventId}/viewport.png`)));
  assert.ok(archive.includes(Buffer.from('"aiProvider": "template"')));
});
test("Concurrent retry is idempotent; changed content under same client ID conflicts", async (t) => {
  const { request, store } = await setup(t);
  const replies = await Promise.all(
    Array.from({ length: 5 }, async () =>
      (
        await request("/api/events", { method: "POST", body: envelope() })
      ).json(),
    ),
  );
  assert.equal(new Set(replies.map((r) => r.eventId)).size, 1);
  assert.equal(replies.filter((r) => !r.duplicate).length, 1);
  assert.equal((await store.list(owner)).length, 1);
  const changed = envelope();
  changed.event.rationale = "A different checkpoint with the same ID";
  assert.equal(
    (await request("/api/events", { method: "POST", body: changed })).status,
    409,
  );
});
test("Fingerprint fallback ignores remote upload bookkeeping and local viewport paths", async (t) => {
  const { request } = await setup(t);
  const first = envelope();
  delete first.event.id;
  const one = await (
    await request("/api/events", { method: "POST", body: first })
  ).json();
  first.event.remoteUpload = {
    ok: true,
    response: { ai: { title: "untrusted" } },
  };
  first.event.viewport = { captured: true, path: "C:\\another\\viewport.png" };
  const two = await (
    await request("/api/events", { method: "POST", body: first })
  ).json();
  assert.equal(one.eventId, two.eventId);
  assert.equal(two.duplicate, true);
});
test("Invalid image, unsupported schema, mismatched count and missing stable document key are rejected", async (t) => {
  const { request, store } = await setup(t);
  const bad = [
    (body) => (body.viewport.base64 = ""),
    (body) =>
      (body.viewport.base64 = Buffer.from("not a PNG").toString("base64")),
    (body) => (body.event.schemaVersion = 4),
    (body) => (body.event.changeCount = 4),
    (body) => delete body.event.document.key,
    (body) => (body.event.timestamp = "2026-01-01"),
    (body) => (body.viewport.contentType = "image/svg+xml"),
  ];
  for (const mutate of bad) {
    const body = envelope();
    mutate(body);
    assert.equal(
      (await request("/api/events", { method: "POST", body })).status,
      400,
    );
  }
  const body = envelope(),
    bytes = Buffer.from(body.viewport.base64, "base64");
  bytes[100] ^= 0xff;
  body.viewport.base64 = bytes.toString("base64");
  assert.equal(
    (await request("/api/events", { method: "POST", body })).status,
    400,
  );
  assert.equal((await store.list(owner)).length, 0);
});
test("AI failures retain evidence, stop after three attempts, and can be retried", async (t) => {
  const { store, request } = await setup(t);
  const saved = await store.ingest(owner, validateEnvelope(envelope()));
  for (let i = 0; i < 3; i++) {
    const row = await store.claim();
    assert.ok(row);
    await store.settle(row, null, "Provider unavailable");
    store.db.prepare("UPDATE events SET available_at=0 WHERE id=?").run(row.id);
  }
  const failed = await store.get(owner, saved.row.id);
  assert.equal(failed.status, "failed");
  assert.ok((await store.image(failed)).length);
  assert.equal(failed.raw_event.rationale, fixture.event.rationale);
  assert.equal(await store.claim(), null);
  assert.equal(
    (await request(`/api/events/${failed.id}/retry-ai`, { method: "POST" }))
      .status,
    200,
  );
  assert.equal((await store.claim()).attempts, 1);
});
test("Leases recover after restart; stale workers cannot overwrite new results", async (t) => {
  const { store } = await setup(t);
  await store.ingest(owner, validateEnvelope(envelope()));
  const first = await store.claim();
  assert.equal(await store.claim(), null);
  store.db.prepare("UPDATE events SET lease_until=0").run();
  const second = await store.claim();
  assert.notEqual(first.lease_id, second.lease_id);
  await store.settle(
    second,
    {
      ai: { title: "new" },
      provider: "template",
      model: "test",
      promptVersion: "1",
    },
    null,
  );
  await store.settle(
    first,
    {
      ai: { title: "stale" },
      provider: "template",
      model: "test",
      promptVersion: "1",
    },
    null,
  );
  assert.equal((await store.get(owner, first.id)).ai.title, "new");
});
test("Deleted checkpoints disappear, remove local image bytes, and cannot be replayed", async (t) => {
  const { request, store } = await setup(t);
  const saved = await (
    await request("/api/events", { method: "POST", body: envelope() })
  ).json();
  const worker = await store.claim();
  assert.equal(
    (await request(`/api/events/${saved.eventId}`, { method: "DELETE" }))
      .status,
    200,
  );
  await store.settle(worker, { ai: { title: "late" } }, null);
  assert.equal((await request(`/api/events/${saved.eventId}`)).status, 404);
  assert.equal(
    (await request(`/api/events/${saved.eventId}/image`)).status,
    404,
  );
  assert.equal(
    (await request("/api/events", { method: "POST", body: envelope() })).status,
    409,
  );
  assert.equal(
    store.db.prepare("SELECT image FROM events WHERE id=?").get(saved.eventId)
      .image,
    null,
  );
});
test("Cloud users cannot access another owner; installation credentials are upload-only and revocable", async (t) => {
  const fakeAuth = async (_url, options) => {
    const bearer = options.headers.Authorization;
    if (bearer === "Bearer user-a")
      return Response.json({ id: owner, email: "a@example.test" });
    if (bearer === "Bearer user-b")
      return Response.json({
        id: "00000000-0000-4000-8000-000000000002",
        email: "b@example.test",
      });
    return Response.json({}, { status: 401 });
  };
  const { request } = await setup(
    t,
    { mode: "supabase", supabaseUrl: "https://example.test", anonKey: "test" },
    fakeAuth,
  );
  const a = { Authorization: "Bearer user-a" },
    b = { Authorization: "Bearer user-b" };
  assert.equal((await request("/api/events")).status, 401);
  const created = await (
    await request("/api/tokens", {
      method: "POST",
      body: { name: "Fusion laptop" },
      headers: a,
    })
  ).json();
  const credential = { Authorization: `Bearer ${created.token}` };
  const saved = await (
    await request("/api/events", {
      method: "POST",
      body: envelope(),
      headers: credential,
    })
  ).json();
  assert.ok(saved.eventId);
  assert.equal(
    (await request("/api/events", { headers: credential })).status,
    403,
  );
  assert.equal(
    (await request(`/api/events/${saved.eventId}`, { headers: b })).status,
    404,
  );
  assert.equal(
    (await request(`/api/events/${saved.eventId}/image`, { headers: b }))
      .status,
    404,
  );
  assert.equal(
    (
      await request(`/api/events/${saved.eventId}`, {
        method: "DELETE",
        headers: b,
      })
    ).status,
    404,
  );
  assert.equal(
    (await (await request("/api/documents", { headers: b })).json()).documents
      .length,
    0,
  );
  await request(`/api/tokens/${created.id}`, { method: "DELETE", headers: a });
  assert.equal(
    (
      await request("/api/events", {
        method: "POST",
        body: envelope(),
        headers: credential,
      })
    ).status,
    401,
  );
});
test("Stable pagination has no duplicates, filters are validated and cross-origin writes are blocked", async (t) => {
  const { request } = await setup(t);
  for (let i = 0; i < 4; i++)
    await request("/api/events", {
      method: "POST",
      body: envelope(`page-${i}`),
    });
  const one = await (await request("/api/events?limit=2")).json();
  const two = await (
    await request(`/api/events?limit=2&cursor=${one.nextCursor}`)
  ).json();
  assert.equal(
    new Set([...one.events, ...two.events].map((r) => r.id)).size,
    4,
  );
  assert.equal(two.nextCursor, null);
  assert.equal((await request("/api/events?cursor=bad")).status, 400);
  assert.equal((await request("/api/events?status=arbitrary")).status, 400);
  assert.equal((await request("/api/events?documentId=anything")).status, 400);
  assert.equal(
    (
      await request("/api/events", {
        method: "POST",
        body: envelope(),
        headers: { Origin: "https://untrusted.example" },
      })
    ).status,
    403,
  );
  assert.equal(
    (await (await request("/api/events?q=no-such-word")).json()).events.length,
    0,
  );
});
test("SQLite persists checkpoints across store reopening", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "trace-reopen-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const first = new LocalStore(dir);
  const saved = await first.ingest(owner, validateEnvelope(envelope()));
  first.close();
  const second = new LocalStore(dir);
  assert.equal(
    (await second.get(owner, saved.row.id)).raw_event.rationale,
    fixture.event.rationale,
  );
  second.close();
});

test("Signup uses configured confirmation URL and never returns a session", async (t) => {
  let called;
  const {request} = await setup(t, {mode:"supabase",supabaseUrl:"https://project.supabase.co",anonKey:"public",publicOrigin:"https://trace.example",authRedirectUrl:"https://trace.example/auth/confirmed"}, async (url, options) => {
    called={url,options};
    return new Response(JSON.stringify({access_token:"private-token",refresh_token:"private-refresh",user:{id:"user"}}));
  });
  const bad=await request("/api/auth/signup",{method:"POST",body:{email:"bad",password:"short"}});
  assert.equal(bad.status,400);
  const response=await request("/api/auth/signup",{method:"POST",body:{email:"person@example.com",password:"a-long-password",redirectTo:"https://evil.example"}});
  assert.equal(response.status,200);
  assert.equal(new URL(called.url).searchParams.get("redirect_to"),"https://trace.example/auth/confirmed");
  assert.equal(called.options.headers.apikey,"public");
  assert.equal((await response.text()).includes("private-token"),false);
  assert.equal(response.headers.get("set-cookie"),null);
  assert.equal((await request("/signup")).status,200);
  assert.equal((await request("/auth/confirmed")).status,200);
});
