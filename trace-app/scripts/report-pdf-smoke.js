// Isolated, hidden Electron print check. No account, network, or Fusion is used.
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { demoPng } from "../server/demo.js";
const require = createRequire(import.meta.url);
const { buildReportHtml } = require("../desktop/design-report.cjs");
const root = resolve("."),
  folder = resolve(".data/report-proof");
await mkdir(folder, { recursive: true });
const ids = [1, 2, 3].map(
  (n) => `20000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
);
const checkpoint = (index) => ({
  id: ids[index],
  number: index + 1,
  capturedAt: `2026-09-26T0${index + 1}:00:00Z`,
  title: [
    "Defined the mounting base",
    "Increased the rib thickness",
    "Recorded an unfinished hole adjustment",
  ][index],
  summary:
    index === 2
      ? ""
      : "This illustrative checkpoint records a dimensional design change without asserting tested performance.",
  rationale:
    index === 1
      ? Array.from(
          { length: 17 },
          (_, n) =>
            `Review note ${n + 1}: The rib needs clearance for the assembly tool. This note is deliberately long to check that the engineering report preserves full rationale and continues across printed pages without clipping, overlapping the footer, or hiding the following evidence.`,
        ).join("\n\n")
      : "Preserve the mounting interface and record the selected dimension for the next review.",
  engineeringChanges: Array.from({ length: index === 1 ? 5 : 1 }, (_, n) => ({
    action: "feature_updated",
    feature: { name: `Rib extrusion ${n + 1}`, type: "ExtrudeFeature" },
    properties: [
      { name: "Distance", oldValue: "4 mm", value: "6 mm" },
      {
        name: "Review reference",
        value: "Engineering-review-reference-".repeat(7),
      },
    ],
    operation: "join",
  })),
  source: "Autodesk Fusion (illustrative fixture)",
  document: { name: "Fixture mounting bracket", key: "fixture-only-document" },
  summaryStatus: index === 2 ? "failed" : "complete",
  summaryProvider: index === 2 ? null : "template",
  rawChangeCount: index + 1,
});
const report = {
  documentId: "10000000-0000-4000-8000-000000000001",
  documentName: "Fixture mounting bracket",
  generatedAt: "2026-09-26T04:00:00Z",
  evidenceCollectedAt: "2026-09-26T03:59:00Z",
  provider: "template",
  model: null,
  promptVersion: "trace-engineering-report-v1",
  overview:
    "Three illustrative design checkpoints are included in this layout fixture. It exercises recorded evidence, rationale, screenshot handling, and long content; it does not describe a real customer's work.",
  sections: [
    {
      heading: "Design evolution",
      paragraphs: [
        {
          text: "The recorded changes begin with the mounting base, then revise the rib and capture a hole adjustment for later review. The original engineering rationale remains in each appendix record.",
          checkpointIds: ids,
        },
      ],
    },
    {
      heading: "Engineering decisions",
      paragraphs: [
        {
          text: "The second checkpoint records a change from 4 mm to 6 mm. No load test or strength calculation accompanies the captured evidence, so this report makes no claim of a verified performance improvement.",
          checkpointIds: [ids[1]],
        },
      ],
    },
    {
      heading: "Open questions",
      paragraphs: [
        {
          text: "The final checkpoint has no completed summary and its screenshot is unavailable in this fixture. Its original rationale and normalized change remain included.",
          checkpointIds: [ids[2]],
        },
      ],
    },
  ],
  notes: [
    "LAYOUT FIXTURE ONLY - synthetic data and an illustrative viewport.",
    "The second checkpoint includes extended rationale and long identifiers to exercise page breaks and text wrapping.",
  ],
  checkpoints: ids.map((_, index) => checkpoint(index)),
};
const images = new Map(
  ids
    .slice(0, 2)
    .map((id) => [id, `data:image/png;base64,${demoPng().toString("base64")}`]),
);
const missingImages = new Map([
  [ids[2], "The fixture intentionally omits this screenshot."],
]);
const fonts = Object.fromEntries(
  await Promise.all(
    Object.entries({
      Barlow: "barlow-latin-400-normal.woff2",
      BarlowDisplay: "barlow-semi-condensed-latin-600-normal.woff2",
      PlexMono: "ibm-plex-mono-latin-400-normal.woff2",
    }).map(async ([name, file]) => [
      name,
      `data:font/woff2;base64,${(await readFile(join(root, "public/fonts", file))).toString("base64")}`,
    ]),
  ),
);
await writeFile(
  join(folder, "fixture.html"),
  buildReportHtml(report, { images, missingImages, fonts }),
);
await writeFile(
  join(folder, "fixture.json"),
  JSON.stringify({
    report,
    images: [...images],
    missingImages: [...missingImages],
  }),
);
if (process.argv.includes("--html-only")) {
  console.log(`HTML layout fixture: ${join(folder, "fixture.html")}`);
  process.exit(0);
}
const helper = join(folder, "electron-smoke.cjs");
await writeFile(
  helper,
  `const { app, BrowserWindow } = require('electron');
const { readFile, writeFile, mkdir } = require('node:fs/promises');
const { join } = require('node:path');
const { renderReportPdf } = require(${JSON.stringify(join(root, "desktop/design-report.cjs"))});
const folder = ${JSON.stringify(folder)};
app.setPath('userData', join(folder, 'user-data'));
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  await mkdir(app.getPath('userData'), { recursive: true });
  const input = JSON.parse(await readFile(join(folder, 'fixture.json'), 'utf8'));
  input.images = new Map(input.images); input.missingImages = new Map(input.missingImages);
  const pdf = await renderReportPdf(input, () => {}, { BrowserWindow, temporaryRoot: app.getPath('userData'), fontDirectory: ${JSON.stringify(join(root, "public/fonts"))} });
  await writeFile(join(folder, 'fixture.pdf'), pdf);
  console.log('TRACE_REPORT_SMOKE ' + JSON.stringify({ bytes: pdf.length, checkpoints: input.report.checkpoints.length }));
  app.quit();
}).catch((error) => { console.error(error); app.exit(1); });`,
);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(require("electron"), [helper], {
  env,
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
child.stdout.on("data", (bytes) => {
  output += bytes;
  process.stdout.write(bytes);
});
child.stderr.on("data", (bytes) => process.stderr.write(bytes));
const timer = setTimeout(() => {
  child.kill();
  process.exitCode = 1;
}, 120_000);
child.on("error", (error) => {
  clearTimeout(timer);
  console.error(error);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  clearTimeout(timer);
  if (code || !output.includes("TRACE_REPORT_SMOKE")) process.exitCode = 1;
  else console.log(`PDF layout fixture: ${join(folder, "fixture.pdf")}`);
});
