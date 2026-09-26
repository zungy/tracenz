import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { demoPng } from "../server/demo.js";
const require = createRequire(import.meta.url);
const {
  buildReportHtml,
  flattenFields,
  DesignReportExporter,
  savePdfAtomically,
  renderReportPdf,
} = require("../desktop/design-report.cjs");
const documentId = "10000000-0000-4000-8000-000000000001";
const checkpointId = (n) =>
  `20000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const image = demoPng();
const pdf = Buffer.from("%PDF-1.7\nfixture-only");
function report(count = 2) {
  return {
    documentId,
    documentName: "Mounting bracket",
    generatedAt: "2026-09-26T04:00:00Z",
    evidenceCollectedAt: "2026-09-26T03:59:00Z",
    provider: "template",
    model: null,
    promptVersion: "trace-report-v1",
    overview: "An evidence-led design history.",
    sections: [
      {
        heading: "Design evolution",
        paragraphs: [
          {
            text: "Changes are supported by recorded checkpoints.",
            checkpointIds: [checkpointId(1)],
          },
        ],
      },
    ],
    notes: ["No engineering performance was validated by this report."],
    checkpoints: Array.from({ length: count }, (_, index) => ({
      id: checkpointId(index + 1),
      number: index + 1,
      capturedAt: `2026-09-26T0${index}:00:00Z`,
      title: `Checkpoint title ${index + 1}`,
      summary: `Recorded summary ${index + 1}`,
      rationale: `Original rationale ${index + 1}`,
      engineeringChanges: [
        {
          action: "feature_added",
          feature: { name: "Base extrusion", type: "ExtrudeFeature" },
          properties: [{ name: "Distance", value: 6, units: "mm" }],
        },
      ],
      source: "Autodesk Fusion",
      document: { name: "Mounting bracket", key: "fixture-document" },
      summaryStatus: "complete",
      summaryProvider: "template",
      rawChangeCount: 2,
    })),
  };
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const tick = async () => {
  for (let n = 0; n < 20; n++) await Promise.resolve();
};
function exporter(overrides = {}) {
  const calls = [],
    saves = [],
    progress = [];
  const value = report(overrides.count || 2);
  const client = {
    epoch: 0,
    session: { access_token: "fixture-in-memory" },
    async request(path) {
      calls.push(path);
      if (path.endsWith("/report")) return { report: value };
      return image;
    },
  };
  const instance = new DesignReportExporter({
    client,
    selectPath: async () => ({ filePath: "fixture-report.pdf" }),
    normalizeImage: (bytes) => bytes,
    renderPdf: async () => pdf,
    savePdf: (...args) => saves.push(args),
    ...overrides,
  });
  return {
    instance,
    client,
    calls,
    saves,
    progress,
    value,
    generate: () =>
      instance.generate(documentId, (event) => progress.push(event)),
  };
}

test("report HTML escapes untrusted evidence, cites valid checkpoints and preserves every original field", () => {
  const data = report();
  data.documentName = '<img src="https://evil.test" onerror="alert(1)">';
  data.checkpoints[1].rationale =
    "<script>steal()</script> & original rationale";
  data.checkpoints[1].engineeringChanges[0].customField = {
    nested: '"quoted" <value>',
  };
  const html = buildReportHtml(data, {
    images: new Map([
      [checkpointId(1), `data:image/png;base64,${image.toString("base64")}`],
    ]),
    missingImages: new Map([[checkpointId(2), "Stored image not found."]]),
  });
  assert.match(
    html,
    /&lt;script&gt;steal\(\)&lt;\/script&gt; &amp; original rationale/,
  );
  assert.doesNotMatch(html, /<script|<img src="https:/);
  assert.match(
    html,
    /<th>Custom field \/ Nested<\/th><td><div class="record-value">&quot;quoted&quot; &lt;value&gt;<\/div>/,
  );
  assert.match(html, /Evidence: <a href="#checkpoint-1">Checkpoint 001/);
  assert.match(html, /Screenshot unavailable: Stored image not found/);
  assert.match(html, /1 checkpoint screenshot is unavailable/);
  assert.match(html, /Evidence retrieved: 2026-09-26 03:59:00 UTC/);
  assert.equal((html.match(/class="checkpoint" id=/g) || []).length, 2);
});

test("nested engineering fields become readable rows without losing values, empty containers, or list context", () => {
  const rows = flattenFields({
    feature: { name: "Rib", type: "ExtrudeFeature" },
    properties: [{ name: "Distance", oldValue: 4, value: 6, units: "mm" }],
    customData: { nested: [false, null, { count: 0 }, [], {}], blank: "" },
  });
  assert.deepEqual(rows, [
    { label: "Feature / Name", value: "Rib" },
    { label: "Feature / Type", value: "ExtrudeFeature" },
    { label: "Property 1 / Distance / Name", value: "Distance" },
    { label: "Property 1 / Distance / Old value", value: "4" },
    { label: "Property 1 / Distance / Value", value: "6" },
    { label: "Property 1 / Distance / Units", value: "mm" },
    { label: "Custom data / Nested / Item 1", value: "false" },
    { label: "Custom data / Nested / Item 2", value: "null" },
    { label: "Custom data / Nested / Item 3 / Count", value: "0" },
    { label: "Custom data / Nested / Item 4", value: "Empty list" },
    { label: "Custom data / Nested / Item 5", value: "Empty object" },
    { label: "Custom data / Blank", value: "Empty text" },
  ]);
  const html = buildReportHtml(report());
  assert.match(html, /Feature \/ Name/);
  assert.match(html, /Property 1 \/ Distance \/ Value/);
  assert.doesNotMatch(html, /<pre|&quot;name&quot;:/);
});

test("report preserves database evidence order and rejects citations outside that document", () => {
  const data = report();
  data.checkpoints[0].capturedAt = "2026-09-26T15:00:00+13:00";
  data.checkpoints[1].capturedAt = "2026-09-26T03:00:00Z";
  const html = buildReportHtml(data);
  assert.ok(
    html.indexOf("Original rationale 1") < html.indexOf("Original rationale 2"),
  );
  data.sections[0].paragraphs[0].checkpointIds.push(checkpointId(999));
  assert.throws(() => buildReportHtml(data), /not in this document/);
  assert.throws(
    () =>
      buildReportHtml(report(), {
        images: new Map([[checkpointId(1), "https://example.com/private.png"]]),
      }),
    /Invalid report image/,
  );
});

test("canceling the native save dialog avoids generation and concurrent reports are rejected", async () => {
  const selection = deferred();
  const setup = exporter({ selectPath: () => selection.promise });
  const pending = setup.generate();
  await assert.rejects(setup.generate(), /already being prepared/);
  selection.resolve({ canceled: true });
  assert.deepEqual(await pending, { canceled: true });
  assert.equal(setup.calls.length, 0);
  assert.equal(setup.saves.length, 0);
});

test("missing screenshot remains explicit while every checkpoint and progress count reaches the PDF", async () => {
  let rendered;
  const setup = exporter({
    renderPdf: async (input) => {
      rendered = input;
      return pdf;
    },
  });
  const request = setup.client.request.bind(setup.client);
  setup.client.request = async (path) => {
    if (path.includes(checkpointId(2)))
      throw Object.assign(new Error("Missing"), { status: 404 });
    return request(path);
  };
  const result = await setup.generate();
  assert.equal(result.checkpointCount, 2);
  assert.equal(result.missingImageCount, 1);
  assert.equal(rendered.report.checkpoints.length, 2);
  assert.equal(rendered.images.size, 1);
  assert.equal(rendered.missingImages.size, 1);
  assert.deepEqual(setup.progress.at(-1), {
    stage: "saving",
    completed: 2,
    total: 2,
  });
  assert.equal(setup.saves.length, 1);
});

test("signout during save selection, generation, image fetch or printing never writes old account data", async () => {
  for (const phase of ["selection", "generation", "image", "print"]) {
    const held = deferred();
    const setup = exporter({
      ...(phase === "selection" ? { selectPath: () => held.promise } : {}),
      ...(phase === "print" ? { renderPdf: () => held.promise } : {}),
    });
    const request = setup.client.request.bind(setup.client);
    setup.client.request = (path) =>
      (phase === "generation" && path.endsWith("/report")) ||
      (phase === "image" && path.endsWith("/image"))
        ? held.promise
        : request(path);
    const pending = setup.generate();
    await tick();
    setup.instance.invalidate();
    held.resolve(
      phase === "selection"
        ? { filePath: "fixture.pdf" }
        : phase === "generation"
          ? { report: setup.value }
          : phase === "image"
            ? image
            : pdf,
    );
    await assert.rejects(pending, /account changed/);
    assert.equal(setup.saves.length, 0, phase);
    assert.equal(setup.instance.busy, false);
  }
});

test("authentication failure, image memory limit and repeated timeouts stop without a partial PDF", async () => {
  const unauthorized = exporter();
  unauthorized.client.request = async (path) => {
    if (path.endsWith("/report")) return { report: unauthorized.value };
    throw Object.assign(new Error("Forbidden"), { status: 403 });
  };
  await assert.rejects(unauthorized.generate(), /Forbidden/);
  assert.equal(unauthorized.saves.length, 0);
  const oversized = exporter({ maxImageBytes: 1 });
  await assert.rejects(oversized.generate(), /memory limit/);
  assert.equal(oversized.saves.length, 0);
  const stalled = exporter({ count: 3, imageTimeoutMs: 2, imagePhaseMs: 200 });
  stalled.client.request = async (path) =>
    path.endsWith("/report")
      ? { report: stalled.value }
      : new Promise(() => {});
  await assert.rejects(stalled.generate(), /interrupted repeatedly/);
  assert.equal(stalled.instance.busy, false);
  assert.equal(stalled.saves.length, 0);
});

test("atomic saving preserves an existing output on account invalidation and leaves no temporary file", () => {
  const folder = mkdtempSync(join(tmpdir(), "trace-report-save-test-"));
  const target = join(folder, "report.pdf");
  try {
    writeFileSync(target, "previous report");
    let checks = 0;
    assert.throws(
      () =>
        savePdfAtomically(target, pdf, () => {
          if (++checks === 2) throw new Error("Changed account");
        }),
      /Changed account/,
    );
    assert.equal(readFileSync(target, "utf8"), "previous report");
    assert.deepEqual(readdirSync(folder), ["report.pdf"]);
    savePdfAtomically(target, pdf, () => {});
    assert.deepEqual(readFileSync(target), pdf);
  } finally {
    unlinkSync(target);
    rmdirSync(folder);
  }
});

test("print renderer denies network and permissions, disables scripts, and cleans private HTML after success", async () => {
  const folder = mkdtempSync(join(tmpdir(), "trace-report-render-test-"));
  const seen = {};
  class FakeWindow {
    constructor(options) {
      seen.options = options;
      this.webContents = {
        setWindowOpenHandler: (callback) => {
          seen.open = callback;
        },
        on() {},
        session: {
          setPermissionRequestHandler: (callback) => {
            seen.permission = callback;
          },
          webRequest: {
            onBeforeRequest: (callback) => {
              seen.request = callback;
            },
          },
        },
        printToPDF: async (options) => {
          seen.printOptions = options;
          return pdf;
        },
      };
    }
    async loadFile(path) {
      seen.html = readFileSync(path, "utf8");
    }
    isDestroyed() {
      return false;
    }
    destroy() {
      seen.destroyed = true;
    }
  }
  try {
    const result = await renderReportPdf(
      { report: report(), images: new Map(), missingImages: new Map() },
      () => {},
      {
        BrowserWindow: FakeWindow,
        temporaryRoot: folder,
        fontDirectory: new URL(
          "../public/fonts",
          import.meta.url,
        ).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
      },
    );
    assert.deepEqual(result, pdf);
    assert.equal(seen.options.show, false);
    assert.equal(seen.options.webPreferences.javascript, false);
    assert.equal(seen.options.webPreferences.nodeIntegration, false);
    assert.equal(seen.options.webPreferences.sandbox, true);
    assert.deepEqual(seen.open(), { action: "deny" });
    seen.request({ url: "https://evil.test/image.png" }, (value) =>
      assert.equal(value.cancel, true),
    );
    seen.permission(null, "camera", (allowed) => assert.equal(allowed, false));
    assert.match(seen.html, /font-src data:/);
    assert.equal(seen.printOptions.pageSize, "A4");
    assert.equal(seen.destroyed, true);
    assert.deepEqual(readdirSync(folder), []);
  } finally {
    rmdirSync(folder);
  }
});
