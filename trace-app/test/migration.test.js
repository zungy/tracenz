import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

test("PostgreSQL migration, ingestion, leases and owner isolation work under database roles", async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  // Minimal Supabase-provided schemas. This tests actual PostgreSQL SQL/RLS,
  // not the hosted Auth, REST or Storage services.
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create schema storage;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema public,auth to anon,authenticated,service_role;
    grant execute on function auth.uid() to authenticated;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
  `);
  await db.exec(
    await readFile(
      new URL("../supabase/migrations/20260926064927_trace_initial_schema.sql", import.meta.url),
      "utf8",
    ),
  );
  const a = "00000000-0000-4000-8000-000000000001",
    b = "00000000-0000-4000-8000-000000000002";
  await db.query("insert into auth.users values ($1),($2)", [a, b]);
  await db.exec("set role service_role");
  const event = {
    source: "Autodesk Fusion",
    document: { name: "Bracket" },
    timestamp: "2026-09-26T01:00:00Z",
    engineeringChanges: [],
    rationale: "Recorded evidence",
  };
  async function ingest(owner, fingerprint = "same") {
    return (
      await db.query("select trace_ingest($1,$2,$3,$4,$5,$6,$7) as result", [
        owner,
        "checkpoint",
        fingerprint,
        "document",
        JSON.stringify(event),
        100,
        JSON.stringify({ width: 1, height: 1 }),
      ])
    ).rows[0].result;
  }
  const first = await ingest(a);
  assert.equal(first.duplicate, false);
  assert.equal((await ingest(a)).row.id, first.row.id);
  assert.match((await ingest(a, "different")).conflict, /different content/);
  const second = await ingest(b);
  assert.notEqual(second.row.document_id, first.row.document_id);
  await db.exec("update trace_events set status='pending'");
  const claimed = (await db.query("select * from trace_claim()")).rows;
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].attempts, 1);
  const other = (await db.query("select * from trace_claim()")).rows;
  assert.notEqual(other[0].id, claimed[0].id);
  assert.equal((await db.query("select * from trace_claim()")).rows.length, 0);
  await db.exec(
    "update trace_events set attempts=3,lease_until=now()-interval '1 minute'; select trace_recover()",
  );
  assert.equal(
    (
      await db.query(
        "select count(*)::int as n from trace_events where status='failed'",
      )
    ).rows[0].n,
    2,
  );
  await db.exec("reset role; set role authenticated");
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [a]);
  assert.deepEqual(
    (await db.query("select owner_id from trace_events")).rows.map(
      (row) => row.owner_id,
    ),
    [a],
  );
  assert.equal(
    (await db.query("select * from trace_document_overview")).rows.length,
    1,
  );
  await assert.rejects(
    db.query("select * from trace_tokens"),
    /permission denied/,
  );
  await assert.rejects(
    db.query("select * from trace_claim()"),
    /permission denied/,
  );
  await assert.rejects(
    db.query("delete from trace_events"),
    /permission denied/,
  );
  await db.exec("reset role; set role service_role");
  await db.query("update trace_events set deleted_at=now() where id=$1", [
    first.row.id,
  ]);
  assert.match((await ingest(a)).conflict, /deleted/);
  await db.exec("reset role; set role authenticated");
  assert.equal((await db.query("select * from trace_events")).rows.length, 0);
  await db.exec("reset role; set role anon");
  await assert.rejects(
    db.query("select * from trace_events"),
    /permission denied/,
  );
});
