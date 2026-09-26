import test from "node:test";
import assert from "node:assert/strict";
import { SupabaseStore } from "../server/supabase-store.js";

const config = {
  supabaseUrl: "https://project.supabase.co",
  serviceKey: "test-key",
  bucket: "trace-viewports",
};
test("Supabase reads are owner-scoped and filter values are URL encoded", async () => {
  const urls = [];
  const store = new SupabaseStore(config, async (url) => {
    urls.push(new URL(url));
    return Response.json([]);
  });
  await store.get("owner-a", "event-a");
  await store.list("owner-a", { q: "a&owner_id=eq.b" });
  await store.tokens("owner-a");
  for (const url of urls)
    assert.equal(url.searchParams.get("owner_id"), "eq.owner-a");
  assert.equal(
    urls[1].searchParams.get("search_text"),
    "ilike.%a&ownerid=eq.b%",
  );
});
test("A failed image upload leaves receiving state; a retry resumes before pending", async () => {
  const calls = [],
    row = {
      id: "event-a",
      owner_id: "owner-a",
      image_path: "owner-a/event-a/viewport.png",
      status: "receiving",
    };
  let fail = true;
  const store = new SupabaseStore(config, async (url, options) => {
    calls.push({ url, method: options.method, body: options.body });
    if (url.endsWith("/rpc/trace_ingest"))
      return Response.json({ row, duplicate: true });
    if (url.includes("/storage/")) {
      if (fail) return new Response("", { status: 503 });
      return Response.json({ Key: row.image_path });
    }
    if (options.method === "PATCH") return new Response(null, { status: 204 });
    return Response.json([{ ...row, status: "pending" }]);
  });
  const input = {
    event: {},
    image: Buffer.from("x"),
    dimensions: {},
    dedupeKey: "key",
    fingerprint: "hash",
    documentKey: "doc",
  };
  await assert.rejects(store.ingest("owner-a", input));
  assert.equal(
    calls.some((c) => c.method === "PATCH"),
    false,
  );
  fail = false;
  assert.equal((await store.ingest("owner-a", input)).row.status, "pending");
  const patch = calls.find((c) => c.method === "PATCH");
  assert.equal(new URL(patch.url).searchParams.get("status"), "eq.receiving");
});
