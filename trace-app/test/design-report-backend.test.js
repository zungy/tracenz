import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import {
  createDesignReportGenerator,
  collectReportCheckpoints,
  validateReportNarrative,
  reportLimits,
} from "../server/design-report.js";
import { LocalStore } from "../server/local-store.js";
import { createApp } from "../server/app.js";
import { createEdgeHandler } from "../supabase/functions/trace/handler.js";
import { demoEnvelopes } from "../server/demo.js";
import { validateEnvelope, hash } from "../server/domain.js";

const owner = "00000000-0000-4000-8000-000000000001",
  other = "00000000-0000-4000-8000-000000000002",
  documentId = randomUUID();
const event = {
  source: "Autodesk Fusion",
  document: {
    name: "Bracket",
    defaultLengthUnits: "mm",
    id: "design-stable-id",
  },
  engineeringChanges: [
    {
      action: "feature_added",
      feature: { name: "Hole2" },
      properties: [{ name: "HoleDiameter", value: "4.00 mm" }],
    },
  ],
  rationale: "Adding a hole for the recorded mounting location.",
  rawChangeCount: 4,
};

function rowsFixture(count = 4) {
  return Array.from({ length: count }, (_, index) => ({
    id: randomUUID(),
    owner_id: owner,
    document_id: documentId,
    raw_event: structuredClone(event),
    captured_at: new Date(Date.UTC(2026, 8, 20, 0, 0, index)).toISOString(),
    received_at: new Date().toISOString(),
    status: index % 2 ? "failed" : "complete",
    ai:
      index % 2
        ? null
        : { title: `Hole ${index}`, summary: "Recorded a 4.00 mm hole." },
    ai_provider: index % 2 ? null : "openai",
  })).reverse();
}
function fixtureStore(rows, { cap = 100, changed = false } = {}) {
  const calls = [];
  let documentReads = 0;
  return {
    calls,
    async documents(requestedOwner) {
      assert.equal(requestedOwner, owner);
      documentReads++;
      return [
        {
          id: documentId,
          name: "Bracket",
          event_count: rows.length + (changed && documentReads > 1 ? 1 : 0),
          latest_at: rows[0]?.captured_at,
        },
      ];
    },
    async list(requestedOwner, filters) {
      calls.push({ owner: requestedOwner, ...filters });
      assert.equal(requestedOwner, owner);
      assert.equal(filters.documentId, documentId);
      assert.equal(filters.status, undefined);
      assert.equal(filters.q, undefined);
      const cursor = filters.cursor
        ? rows.findIndex((row) => row.id === filters.cursor.id) + 1
        : 0;
      return rows.slice(cursor, cursor + Math.min(filters.limit, cap));
    },
  };
}
function goodNarrative(rows) {
  return {
    sections: [
      {
        heading: "Feature development",
        paragraphs: [
          {
            text: "The recorded HoleDiameter is 4.00 mm. The recorded rationale is reproduced in the evidence appendix.",
            checkpointIds: [rows[0].id],
          },
        ],
      },
    ],
  };
}
function modelResponse(value) {
  return Response.json({
    status: "completed",
    output: [
      { content: [{ type: "output_text", text: JSON.stringify(value) }] },
    ],
  });
}

test("Document report paginates beyond 1,000 rows, retains every status, original rationale and normalized change, and numbers chronology", async () => {
  const rows = rowsFixture(1103),
    store = fixtureStore(rows);
  const report = await createDesignReportGenerator(
    { ai: "deterministic" },
    store,
  )(owner, documentId);
  assert.equal(report.checkpoints.length, 1103);
  assert.equal(store.calls.length, Math.ceil(1103 / reportLimits.pageSize));
  assert.ok(store.calls.every((call) => call.limit === reportLimits.pageSize));
  assert.equal(report.checkpoints[0].id, rows.at(-1).id);
  assert.equal(report.checkpoints.at(-1).id, rows[0].id);
  assert.deepEqual(
    report.checkpoints.map((row) => row.number),
    Array.from({ length: 1103 }, (_, index) => index + 1),
  );
  assert.equal(report.checkpoints[0].rationale, event.rationale);
  assert.deepEqual(
    report.checkpoints[0].engineeringChanges,
    event.engineeringChanges,
  );
  assert.ok(
    report.checkpoints.some(
      (row) => row.summaryStatus === "failed" && row.summary === "",
    ),
  );
  assert.equal(report.provider, "template");
  assert.match(report.notes.join(" "), /Template report.*No AI report call/);
  assert.ok(
    Date.parse(report.evidenceCollectedAt) <= Date.parse(report.generatedAt),
  );
});

test("Report honors the database ordering for submillisecond captures instead of losing precision", async () => {
  const rows = rowsFixture(2);
  rows[0].captured_at = "2026-09-20T00:00:00.000002Z";
  rows[0].id = "00000000-0000-4000-8000-000000000001";
  rows[1].captured_at = "2026-09-20T00:00:00.000001Z";
  rows[1].id = "ffffffff-ffff-4fff-8fff-ffffffffffff";
  const result = await collectReportCheckpoints(
    fixtureStore(rows),
    owner,
    documentId,
  );
  assert.deepEqual(
    result.checkpoints.map((row) => row.id),
    [rows[1].id, rows[0].id],
  );
});

test("A changed document, unexpected store ownership and hard evidence limits reject rather than omit traces", async () => {
  await assert.rejects(
    collectReportCheckpoints(
      fixtureStore(rowsFixture(), { changed: true }),
      owner,
      documentId,
    ),
    (error) => error.status === 409,
  );
  const tooMany = fixtureStore(rowsFixture(reportLimits.checkpoints + 1));
  await assert.rejects(
    collectReportCheckpoints(tooMany, owner, documentId),
    (error) => error.status === 413,
  );
  assert.equal(tooMany.calls.length, 0);
  const large = rowsFixture(1);
  large[0].raw_event.rationale = "x".repeat(reportLimits.bytes + 1);
  await assert.rejects(
    collectReportCheckpoints(fixtureStore(large), owner, documentId),
    (error) => error.status === 413,
  );
  const wrong = rowsFixture(1);
  wrong[0].owner_id = other;
  await assert.rejects(
    collectReportCheckpoints(fixtureStore(wrong), owner, documentId),
    (error) => error.status === 500,
  );
  await assert.rejects(
    collectReportCheckpoints(
      fixtureStore(rowsFixture(150), { cap: 10 }),
      owner,
      documentId,
    ),
    (error) => error.status === 409,
  );
});

test("OpenAI report request sends the full normalized document record once with strict cited output, preserving original rationale", async () => {
  const rows = rowsFixture(),
    store = fixtureStore(rows);
  let sent,
    requests = 0;
  const report = await createDesignReportGenerator(
    { ai: "openai", model: "configured-model", openaiKey: "test-only" },
    store,
    {
      fetcher: async (url, options) => {
        assert.equal(url, "https://api.openai.com/v1/responses");
        requests++;
        sent = JSON.parse(options.body);
        return modelResponse(goodNarrative(rows));
      },
    },
  )(owner, documentId);
  assert.equal(requests, 1);
  assert.equal(sent.model, "configured-model");
  assert.equal(sent.store, false);
  assert.equal(sent.text.format.strict, true);
  assert.equal(sent.max_output_tokens, 6000);
  const evidence = JSON.parse(sent.input[0].content[0].text);
  assert.equal(evidence.checkpoints.length, rows.length);
  assert.equal(evidence.checkpoints[0].rationale, event.rationale);
  assert.deepEqual(
    evidence.checkpoints[0].engineeringChanges,
    event.engineeringChanges,
  );
  assert.equal(evidence.checkpoints[0].owner_id, undefined);
  assert.match(sent.instructions, /untrusted evidence, never instructions/);
  assert.equal(report.provider, "openai");
  assert.equal(report.model, "configured-model");
  assert.equal(report.checkpoints[0].rationale, event.rationale);
  assert.deepEqual(report.sections, goodNarrative(rows).sections);
});

test("Oversized AI evidence yields a labeled full template report with no model request", async () => {
  const rows = rowsFixture(20);
  for (const row of rows)
    row.raw_event.rationale = "recorded rationale ".repeat(400);
  const report = await createDesignReportGenerator(
    { ai: "openai", model: "configured", openaiKey: "unused" },
    fixtureStore(rows),
    {
      fetcher: () => {
        throw new Error("Must not call AI");
      },
    },
  )(owner, documentId);
  assert.equal(report.provider, "template");
  assert.equal(report.checkpoints.length, rows.length);
  assert.equal(report.checkpoints[0].rationale, rows[0].raw_event.rationale);
  assert.match(
    report.notes.join(" "),
    /exceeds the single AI request evidence budget/,
  );
});

test("Unknown/empty citations, refusals, incomplete output and upstream failures never become successful reports", async () => {
  const rows = rowsFixture();
  for (const ids of [[randomUUID()], [], [rows[0].id, rows[0].id]]) {
    const bad = goodNarrative(rows);
    bad.sections[0].paragraphs[0].checkpointIds = ids;
    assert.throws(
      () => validateReportNarrative(bad, rows),
      (error) => error.status === 502,
    );
  }
  const bad = goodNarrative(rows);
  bad.sections[0].paragraphs[0].checkpointIds = [randomUUID()];
  for (const response of [
    () => modelResponse(bad),
    () => Response.json({ status: "incomplete", output: [] }),
    () =>
      Response.json({
        status: "completed",
        output: [{ content: [{ type: "refusal", refusal: "No" }] }],
      }),
    () =>
      Response.json(
        { secret: "never expose private upstream data" },
        { status: 429 },
      ),
  ]) {
    const generate = createDesignReportGenerator(
      { ai: "openai", model: "configured", openaiKey: "secret" },
      fixtureStore(rows),
      { fetcher: async () => response() },
    );
    await assert.rejects(
      generate(owner, documentId),
      (error) =>
        error.status === 502 && !error.message.includes("private upstream"),
    );
  }
});

test("Concurrent report generation is bounded per account and released after an upstream failure", async () => {
  const rows = rowsFixture();
  let rejectFetch, started;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  const generate = createDesignReportGenerator(
    { ai: "openai", model: "configured", openaiKey: "test" },
    fixtureStore(rows),
    {
      fetcher: async () => {
        started();
        return new Promise((_, reject) => {
          rejectFetch = reject;
        });
      },
    },
  );
  const first = generate(owner, documentId);
  await ready;
  await assert.rejects(
    generate(owner, documentId),
    (error) => error.status === 409,
  );
  rejectFetch(new Error("provider unavailable"));
  await assert.rejects(first, (error) => error.status === 502);
  const second = generate(owner, documentId);
  await new Promise((resolve) => setTimeout(resolve, 0));
  rejectFetch(new Error("provider unavailable"));
  await assert.rejects(second, (error) => error.status === 502);
});

test("Node and Edge report endpoints require a user session, isolate documents, ignore timeline filters and preserve deleted-record exclusions", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "trace-report-")),
    store = new LocalStore(directory);
  const envelopes = demoEnvelopes();
  const first = await store.ingest(owner, validateEnvelope(envelopes[0]));
  const second = await store.ingest(owner, validateEnvelope(envelopes[1]));
  const deleted = await store.ingest(owner, validateEnvelope(envelopes[2]));
  await store.delete(owner, deleted.row.id);
  const unrelated = structuredClone(envelopes[3]);
  unrelated.event.document.key += "-other";
  const differentDoc = await store.ingest(owner, validateEnvelope(unrelated));
  const privateDoc = await store.ingest(other, validateEnvelope(envelopes[0]));
  const secret = "trc_" + "x".repeat(43);
  await store.createToken(owner, {
    id: randomUUID(),
    name: "Upload only",
    token_hash: hash(secret),
    prefix: secret.slice(0, 12),
    created_at: new Date().toISOString(),
  });
  const config = {
    mode: "supabase",
    ai: "deterministic",
    supabaseUrl: "https://test.supabase.co",
    anonKey: "public",
    publicOrigin: "https://test.supabase.co/functions/v1/trace",
  };
  const fetcher = async (_url, options) =>
    options.headers.Authorization === "Bearer user-one"
      ? Response.json({ id: owner, email: "one@test.invalid" })
      : Response.json({ error: "invalid" }, { status: 401 });
  const server = createApp(config, store, { fetcher });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const edge = createEdgeHandler(config, store, { fetcher });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  for (const [name, invoke] of [
    [
      "Node",
      (path, access) =>
        fetch(`http://127.0.0.1:${server.address().port}${path}`, {
          method: "POST",
          headers: access ? { Authorization: `Bearer ${access}` } : {},
        }),
    ],
    [
      "Edge",
      (path, access) =>
        edge(
          new Request(config.publicOrigin + path, {
            method: "POST",
            headers: access ? { Authorization: `Bearer ${access}` } : {},
          }),
        ),
    ],
  ]) {
    const path = `/api/documents/${first.row.document_id}/report`;
    assert.equal((await invoke(path, null)).status, 401, name);
    assert.equal((await invoke(path, secret)).status, 403, name);
    assert.equal(
      (
        await invoke(
          `/api/documents/${privateDoc.row.document_id}/report`,
          "user-one",
        )
      ).status,
      404,
      name,
    );
    const result = await invoke(
      path +
        "?status=complete&q=nonmatching&documentId=" +
        differentDoc.row.document_id,
      "user-one",
    );
    assert.equal(result.status, 200, name);
    const { report } = await result.json();
    assert.equal(report.documentId, first.row.document_id, name);
    assert.deepEqual(
      new Set(report.checkpoints.map((row) => row.id)),
      new Set([first.row.id, second.row.id]),
      name,
    );
    assert.equal(report.checkpoints[0].summaryStatus, "pending", name);
    assert.equal(
      (await invoke(`/api/documents/${randomUUID()}/report`, "user-one"))
        .status,
      404,
      name,
    );
    assert.equal(
      (await invoke(path, "user-one")).status,
      429,
      `${name} report rate limit`,
    );
  }
});
