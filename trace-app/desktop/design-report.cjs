const { writeFileSync, renameSync, unlinkSync } = require("node:fs");
const { randomUUID } = require("node:crypto");
const { dirname, basename, join } = require("node:path");
const {
  readFile,
  writeFile,
  mkdtemp,
  unlink,
  rmdir,
} = require("node:fs/promises");
const { pathToFileURL } = require("node:url");

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_IMAGE_BYTES = 96 * 1024 * 1024;
const MAX_PDF_BYTES = 160 * 1024 * 1024;
const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character],
  );
function fieldLabel(key) {
  const words = String(key)
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replaceAll("_", " ")
    .split(/\s+/)
    .filter(Boolean);
  return (
    words
      .map((word, index) =>
        index === 0
          ? word[0].toUpperCase() + word.slice(1)
          : /^[A-Z0-9]+$/.test(word)
            ? word
            : word.toLowerCase(),
      )
      .join(" ") || "(unnamed field)"
  );
}

// Flat labeled rows allow long evidence to span pages without nested tables.
// Every leaf, list position and explicit empty value remains represented.
function flattenFields(object) {
  const rows = [],
    pending = [{ value: object, path: [], key: null }];
  while (pending.length) {
    const { value, path, key } = pending.pop();
    if (Array.isArray(value)) {
      if (!value.length)
        rows.push({ label: path.join(" / ") || "Value", value: "Empty list" });
      for (let index = value.length - 1; index >= 0; index--) {
        const item = value[index];
        const property = key === "properties";
        const context =
          property && item && typeof item.name === "string" && item.name
            ? [item.name]
            : [];
        pending.push({
          value: item,
          path: [
            ...(property ? path.slice(0, -1) : path),
            `${property ? "Property" : "Item"} ${index + 1}`,
            ...context,
          ],
          key: null,
        });
      }
    } else if (value !== null && typeof value === "object") {
      const entries = Object.entries(value);
      if (!entries.length)
        rows.push({
          label: path.join(" / ") || "Value",
          value: "Empty object",
        });
      for (let index = entries.length - 1; index >= 0; index--) {
        const [name, child] = entries[index];
        pending.push({
          value: child,
          path: [...path, fieldLabel(name)],
          key: name,
        });
      }
    } else {
      rows.push({
        label: path.join(" / ") || "Value",
        value:
          value === null
            ? "null"
            : value === ""
              ? "Empty text"
              : value === undefined
                ? "Not provided"
                : String(value),
      });
    }
  }
  return rows;
}
const date = (value) => {
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf())
    ? String(value || "Not recorded")
    : parsed
        .toISOString()
        .replace("T", " ")
        .replace(/\.\d{3}Z$/, " UTC");
};

function validateReport(report, documentId) {
  if (
    !report ||
    report.documentId !== documentId ||
    !Array.isArray(report.checkpoints) ||
    !report.checkpoints.length ||
    report.checkpoints.length > 2000
  )
    throw new Error(
      "Trace returned an incomplete document report. No PDF was saved.",
    );
  const ids = new Set();
  for (const checkpoint of report.checkpoints) {
    if (
      !uuid.test(checkpoint.id) ||
      ids.has(checkpoint.id) ||
      !Array.isArray(checkpoint.engineeringChanges)
    )
      throw new Error(
        "Trace returned invalid checkpoint evidence. No PDF was saved.",
      );
    ids.add(checkpoint.id);
  }
  if (!Array.isArray(report.sections) || !Array.isArray(report.notes))
    throw new Error(
      "Trace returned an invalid report structure. No PDF was saved.",
    );
  for (const section of report.sections) {
    if (!Array.isArray(section.paragraphs))
      throw new Error("Trace returned an invalid report section.");
    for (const paragraph of section.paragraphs) {
      if (
        !Array.isArray(paragraph.checkpointIds) ||
        paragraph.checkpointIds.some((id) => !ids.has(id))
      )
        throw new Error(
          "The report cites checkpoint evidence that is not in this document.",
        );
    }
  }
  return report;
}

function buildReportHtml(
  report,
  { images = new Map(), missingImages = new Map(), fonts = {} } = {},
) {
  validateReport(report, report.documentId);
  // The database supplies the chronological order, including timestamp
  // precision beyond JavaScript Date. Preserve that authoritative order.
  const checkpoints = report.checkpoints;
  const numbers = new Map(
    checkpoints.map((checkpoint, index) => [checkpoint.id, index + 1]),
  );
  const checkpointLabel = (id) =>
    `Checkpoint ${String(numbers.get(id)).padStart(3, "0")}`;
  const fontCss = Object.entries(fonts)
    .map(([name, data]) => {
      if (
        !["Barlow", "BarlowDisplay", "PlexMono"].includes(name) ||
        !/^data:font\/woff2;base64,[A-Za-z0-9+/=]+$/.test(data)
      )
        throw new Error("Invalid report font asset.");
      return `@font-face{font-family:${name};src:url('${data}') format('woff2');font-weight:400 600;font-display:block}`;
    })
    .join("");
  const renderFields = (object) =>
    `<table class="fields"><tbody>${flattenFields(object)
      .map(
        ({ label, value }) =>
          `<tr><th>${escape(label)}</th><td><div class="record-value">${escape(value)}</div></td></tr>`,
      )
      .join("")}</tbody></table>`;
  const narrative = report.sections
    .map(
      (section) =>
        `<section class="report-section"><h2>${escape(section.heading)}</h2>${section.paragraphs.map((paragraph) => `<p class="narrative">${escape(paragraph.text)}</p>${paragraph.checkpointIds.length ? `<p class="citations">Evidence: ${paragraph.checkpointIds.map((id) => `<a href="#checkpoint-${numbers.get(id)}">${checkpointLabel(id)}</a>`).join(", ")}</p>` : ""}`).join("")}</section>`,
    )
    .join("");
  const appendix = checkpoints
    .map((checkpoint) => {
      const image = images.get(checkpoint.id);
      if (image && !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(image))
        throw new Error("Invalid report image.");
      const changes = checkpoint.engineeringChanges
        .map(
          (change, index) =>
            `<section class="change"><h4>Change ${index + 1}${change.feature?.name ? ` - ${escape(change.feature.name)}` : ""}</h4>${renderFields(change)}</section>`,
        )
        .join("");
      return `<article class="checkpoint" id="checkpoint-${numbers.get(checkpoint.id)}">
      <div class="eyebrow">Evidence appendix / ${checkpointLabel(checkpoint.id)}</div>
      <h2>${escape(checkpoint.title || "Design checkpoint")}</h2>
      <p class="checkpoint-meta">${escape(date(checkpoint.capturedAt))} / ${escape(checkpoint.source || "Autodesk Fusion")}</p>
      <p class="record-id">Record ID: ${escape(checkpoint.id)}</p>
      <figure>${image ? `<img src="${image}" alt="Captured viewport for ${escape(checkpoint.title || checkpointLabel(checkpoint.id))}" />` : `<div class="missing-image">Screenshot unavailable: ${escape(missingImages.get(checkpoint.id) || "No screenshot was returned for this checkpoint.")}</div>`}<figcaption>${checkpointLabel(checkpoint.id)} - captured viewport${image ? " (scaled for this report)" : " not embedded"}</figcaption></figure>
      <h3>Recorded summary</h3><p class="preserve">${escape(checkpoint.summary || "No completed summary is available for this checkpoint.")}</p>
      <p class="small">Summary status: ${escape(checkpoint.summaryStatus || "not recorded")}${checkpoint.summaryProvider ? ` / ${escape(checkpoint.summaryProvider)}` : ""}</p>
      <h3>Original engineering rationale</h3><blockquote>${escape(checkpoint.rationale || "No rationale was recorded.")}</blockquote>
      <h3>Engineering changes (${checkpoint.engineeringChanges.length})</h3>${changes || "<p>No normalized engineering changes were recorded.</p>"}
      ${checkpoint.rawChangeCount !== undefined ? `<p class="small">Raw source records: ${escape(checkpoint.rawChangeCount)}</p>` : ""}
      ${checkpoint.document ? `<h3>Source document metadata</h3>${renderFields(checkpoint.document)}` : ""}
    </article>`;
    })
    .join("");
  const notes = [...report.notes];
  if (missingImages.size)
    notes.push(
      `${missingImages.size} checkpoint screenshot${missingImages.size === 1 ? " is" : "s are"} unavailable. Each affected appendix entry identifies the missing image; checkpoint text is retained.`,
    );
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'; script-src 'none'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"><title>${escape(report.documentName)} - Trace engineering report</title><style>
    ${fontCss}
    @page{size:A4;margin:18mm 17mm 20mm}
    @media screen{html body{max-width:176mm;margin:0 auto;padding:12mm 0}}
    *{box-sizing:border-box}html{color:#192c64;background:#fff;font-family:Barlow,Arial,sans-serif;font-size:10.5pt;line-height:1.48;-webkit-print-color-adjust:exact;print-color-adjust:exact}
    body{margin:0}h1,h2,h3,h4{font-family:BarlowDisplay,Barlow,Arial,sans-serif;line-height:1.16;font-weight:600;break-after:avoid;overflow-wrap:anywhere}h1{font-size:33pt;margin:22mm 0 5mm}h2{font-size:22pt;margin:0 0 5mm}h3{font-size:13pt;margin:7mm 0 2.5mm}h4{font-size:11pt;margin:5mm 0 2mm}p{margin:0 0 3.5mm;orphans:3;widows:3;overflow-wrap:anywhere}
    .brand{display:flex;align-items:center;gap:3mm;font-family:BarlowDisplay,Arial,sans-serif;font-size:22pt;font-weight:600;padding-bottom:6mm;border-bottom:1px solid #bdc5dd}.brand svg{width:9mm;height:9mm}.eyebrow,.record-id,.citations,.meta-label{font-family:PlexMono,Consolas,monospace;font-size:8pt}.eyebrow{letter-spacing:.12em;text-transform:uppercase;margin:9mm 0 4mm;color:#57658a}.subtitle{font-size:15pt;color:#57658a}.overview{font-size:12pt;line-height:1.55;white-space:pre-wrap;margin:8mm 0}.facts{display:grid;grid-template-columns:1fr 1fr;gap:5mm;padding:5mm 0;border-top:1px solid #bdc5dd;border-bottom:1px solid #bdc5dd;margin:7mm 0}.facts p{margin:1mm 0 0}.meta-label{color:#57658a;text-transform:uppercase;font-size:7pt}.report-section{margin-top:10mm}.report-section h2{font-size:20pt}.narrative{white-space:pre-wrap}.citations{font-size:7.5pt;color:#57658a;margin-top:-1mm;margin-bottom:5mm}a{color:#243f8f;text-decoration:none}.notes{background:#f4f5f9;padding:5mm;margin:8mm 0}.notes ul{margin:2mm 0 0;padding-left:5mm}.notes li{margin:2mm 0;overflow-wrap:anywhere}.generation{font-size:8pt;color:#57658a;margin-top:8mm;overflow-wrap:anywhere}
    .appendix-intro{break-before:page;margin-top:8mm}.checkpoint{break-before:page}.checkpoint .eyebrow{margin-top:0}.checkpoint h2{margin-bottom:3mm}.checkpoint-meta{font-size:10pt;color:#57658a}.record-id{font-size:7pt;color:#57658a}.small,figcaption{font-size:8pt;color:#57658a}.preserve,blockquote{white-space:pre-wrap;overflow-wrap:anywhere}blockquote{margin:3mm 0;padding:4mm 5mm;background:#f4f5f9;border-left:2px solid #243f8f}figure{margin:5mm 0 6mm;break-inside:avoid}figure img{display:block;width:100%;height:auto;max-height:90mm;object-fit:contain;border:1px solid #bdc5dd;background:#f4f5f9}figcaption{margin-top:2mm}.missing-image{padding:12mm 5mm;border:1px dashed #bdc5dd;background:#f4f5f9;font-size:10pt;color:#57658a}.fields{width:100%;border-collapse:collapse;table-layout:fixed;font-size:8.5pt;margin:0 0 5mm}.fields th,.fields td{border-top:1px solid #e9ebf3;vertical-align:top;text-align:left;padding:2.3mm 2mm;overflow-wrap:anywhere}.fields th{width:26%;color:#57658a;font-weight:500}.record-value{font-family:Barlow,Arial,sans-serif;font-size:8.5pt;white-space:pre-wrap;overflow-wrap:anywhere;margin:0;line-height:1.4}.report-section:last-child{margin-bottom:5mm}
    </style></head><body>
    <div class="brand"><svg viewBox="0 0 28 28" fill="none" stroke="#192c64" stroke-width="1.3"><path d="M4 4h20v20H4zM4 14h20M14 4v20M4 24 24 4"/></svg><span>Trace</span></div>
    <div class="eyebrow">Engineering design report</div><h1>${escape(report.documentName || "Untitled design")}</h1><p class="subtitle">Design evolution, decisions, and supporting evidence</p>
    <div class="facts"><div><span class="meta-label">Recorded checkpoints</span><p>${checkpoints.length}</p></div><div><span class="meta-label">Generated</span><p>${escape(date(report.generatedAt))}</p></div><div><span class="meta-label">First checkpoint</span><p>${escape(date(checkpoints[0].capturedAt))}</p></div><div><span class="meta-label">Latest checkpoint</span><p>${escape(date(checkpoints.at(-1).capturedAt))}</p></div></div>
    <div class="overview">${escape(report.overview)}</div>
    <p class="generation">${report.provider === "openai" ? "AI-assisted synthesis of recorded evidence. Original rationale and checkpoint records are preserved in the appendix." : "Recorded-evidence report. Narrative uses a deterministic summary; no document-level AI synthesis was generated."}</p>
    ${narrative}
    ${notes.length ? `<section class="notes"><h3>Report notes</h3><ul>${notes.map((note) => `<li>${escape(note)}</li>`).join("")}</ul></section>` : ""}
    <p class="generation">Generated by Trace / Provider: ${escape(report.provider)}${report.model ? ` / Model: ${escape(report.model)}` : ""} / Report format: ${escape(report.promptVersion)}<br>Document ID: ${escape(report.documentId)}<br>Evidence retrieved: ${escape(date(report.evidenceCollectedAt || report.generatedAt))}. Includes every checkpoint returned for this document, including checkpoints without completed summaries. Later changes are not included.</p>
    <section class="appendix-intro"><div class="eyebrow">Complete chronological record</div><h2>Evidence appendix</h2><p>The following ${checkpoints.length} checkpoint${checkpoints.length === 1 ? " preserves" : "s preserve"} the recorded rationale, engineering changes, source metadata, and available viewport images. Evidence citations in the report refer to these numbered entries.</p><p class="small">${images.size} screenshot${images.size === 1 ? "" : "s"} embedded${missingImages.size ? `; ${missingImages.size} unavailable` : ""}.</p></section>
    ${appendix}</body></html>`;
}

function savePdfAtomically(filePath, bytes, assertCurrent) {
  const temporary = join(
    dirname(filePath),
    `.${basename(filePath)}.${randomUUID()}.tmp`,
  );
  try {
    assertCurrent();
    writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 });
    assertCurrent();
    renameSync(temporary, filePath);
  } finally {
    try {
      unlinkSync(temporary);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

class DesignReportExporter {
  constructor({
    client,
    selectPath,
    normalizeImage,
    renderPdf,
    savePdf = savePdfAtomically,
    isSignedIn = () => Boolean(client.session),
    maxImageBytes = MAX_IMAGE_BYTES,
    imagePhaseMs = 300_000,
    imageTimeoutMs = 20_000,
  }) {
    Object.assign(this, {
      client,
      selectPath,
      normalizeImage,
      renderPdf,
      savePdf,
      isSignedIn,
      maxImageBytes,
      imagePhaseMs,
      imageTimeoutMs,
    });
    this.accountVersion = 0;
    this.busy = false;
  }
  invalidate() {
    this.accountVersion++;
  }
  async generate(documentId, onProgress = () => {}) {
    if (!uuid.test(documentId))
      throw new Error("Select a valid document to generate its report.");
    if (this.busy)
      throw new Error("A design report is already being prepared.");
    const accountVersion = this.accountVersion,
      epoch = this.client.epoch;
    const assertCurrent = () => {
      if (
        accountVersion !== this.accountVersion ||
        epoch !== this.client.epoch ||
        !this.isSignedIn()
      )
        throw new Error(
          "Your account changed. The report was canceled and no PDF was saved.",
        );
    };
    const progress = (stage, completed = 0, total = 0) => {
      assertCurrent();
      onProgress({ stage, completed, total });
    };
    assertCurrent();
    this.busy = true;
    try {
      const selection = await this.selectPath();
      assertCurrent();
      if (selection.canceled || !selection.filePath) return { canceled: true };
      progress("preparing");
      const { report } = await this.client.request(
        `/api/documents/${documentId}/report`,
        { method: "POST", body: {} },
      );
      assertCurrent();
      validateReport(report, documentId);
      const images = new Map(),
        missingImages = new Map();
      let imageBytes = 0,
        consecutiveDownloadFailures = 0;
      const imageDeadline = Date.now() + this.imagePhaseMs;
      progress("images", 0, report.checkpoints.length);
      for (const checkpoint of report.checkpoints) {
        assertCurrent();
        const remaining = imageDeadline - Date.now();
        if (remaining <= 0)
          throw new Error(
            "Downloading this report's screenshots took too long. No PDF was saved; please retry with a stable connection.",
          );
        let downloaded = false;
        try {
          const source = await bounded(
            this.client.request(`/api/events/${checkpoint.id}/image`, {
              binary: true,
            }),
            Math.min(remaining, this.imageTimeoutMs),
            "Screenshot download timed out.",
          );
          assertCurrent();
          downloaded = true;
          consecutiveDownloadFailures = 0;
          if (
            !Buffer.isBuffer(source) ||
            source.length > 8 * 1024 * 1024 ||
            !source
              .subarray(0, 8)
              .equals(Buffer.from("89504e470d0a1a0a", "hex"))
          )
            throw new Error(
              "The stored screenshot could not be read as a PNG.",
            );
          const png = await this.normalizeImage(source);
          assertCurrent();
          if (
            !Buffer.isBuffer(png) ||
            !png.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
          )
            throw new Error(
              "The stored screenshot could not be prepared for printing.",
            );
          imageBytes += png.length;
          if (imageBytes > this.maxImageBytes) {
            const error = new Error(
              "This document's screenshots exceed the PDF memory limit. No report was saved; export the document archive instead.",
            );
            error.reportLimit = true;
            throw error;
          }
          images.set(
            checkpoint.id,
            `data:image/png;base64,${png.toString("base64")}`,
          );
        } catch (error) {
          assertCurrent();
          if ([401, 403].includes(error.status) || error.reportLimit)
            throw error;
          if (
            !downloaded &&
            error.status !== 404 &&
            ++consecutiveDownloadFailures >= 3
          )
            throw new Error(
              "The screenshot connection was interrupted repeatedly. No PDF was saved; please reconnect and try again.",
            );
          if (error.status === 404) consecutiveDownloadFailures = 0;
          missingImages.set(
            checkpoint.id,
            error.status === 404
              ? "The stored image was not found."
              : "The screenshot could not be downloaded or decoded. Original checkpoint text is retained.",
          );
        }
        progress(
          "images",
          images.size + missingImages.size,
          report.checkpoints.length,
        );
      }
      progress(
        "rendering",
        report.checkpoints.length,
        report.checkpoints.length,
      );
      const pdf = await this.renderPdf(
        { report, images, missingImages },
        assertCurrent,
      );
      assertCurrent();
      if (
        !Buffer.isBuffer(pdf) ||
        !pdf.subarray(0, 5).equals(Buffer.from("%PDF-")) ||
        pdf.length > MAX_PDF_BYTES
      )
        throw new Error(
          "The PDF could not be generated within its size limit. No report was saved.",
        );
      progress("saving", report.checkpoints.length, report.checkpoints.length);
      this.savePdf(selection.filePath, pdf, assertCurrent);
      return {
        saved: true,
        path: selection.filePath,
        checkpointCount: report.checkpoints.length,
        missingImageCount: missingImages.size,
        provider: report.provider,
      };
    } finally {
      this.busy = false;
    }
  }
}

function bounded(promise, milliseconds, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), milliseconds);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function renderReportPdf(
  input,
  assertCurrent,
  { BrowserWindow, temporaryRoot, fontDirectory },
) {
  let reportWindow, directory, htmlPath;
  try {
    assertCurrent();
    const files = {
      Barlow: "barlow-latin-400-normal.woff2",
      BarlowDisplay: "barlow-semi-condensed-latin-600-normal.woff2",
      PlexMono: "ibm-plex-mono-latin-400-normal.woff2",
    };
    const fonts = Object.fromEntries(
      await Promise.all(
        Object.entries(files).map(async ([name, file]) => [
          name,
          `data:font/woff2;base64,${(await readFile(join(fontDirectory, file))).toString("base64")}`,
        ]),
      ),
    );
    assertCurrent();
    const html = buildReportHtml(input.report, { ...input, fonts });
    directory = await mkdtemp(join(temporaryRoot, "trace-report-"));
    assertCurrent();
    htmlPath = join(directory, "report.html");
    await writeFile(htmlPath, html, { flag: "wx", mode: 0o600 });
    assertCurrent();
    const fileUrl = pathToFileURL(htmlPath).href;
    reportWindow = new BrowserWindow({
      show: false,
      width: 794,
      height: 1123,
      webPreferences: {
        partition: `trace-report-${randomUUID()}`,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        javascript: false,
        webSecurity: true,
        backgroundThrottling: false,
      },
    });
    reportWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    reportWindow.webContents.on("will-navigate", (event, url) => {
      if (url !== fileUrl) event.preventDefault();
    });
    reportWindow.webContents.on("will-attach-webview", (event) =>
      event.preventDefault(),
    );
    reportWindow.webContents.session.setPermissionRequestHandler(
      (_contents, _permission, callback) => callback(false),
    );
    reportWindow.webContents.session.webRequest.onBeforeRequest(
      (details, callback) =>
        callback({
          cancel: details.url !== fileUrl && !details.url.startsWith("data:"),
        }),
    );
    await bounded(
      reportWindow.loadFile(htmlPath),
      60_000,
      "The report preview could not be prepared. No PDF was saved.",
    );
    assertCurrent();
    const pdf = await bounded(
      reportWindow.webContents.printToPDF({
        pageSize: "A4",
        preferCSSPageSize: true,
        printBackground: true,
        displayHeaderFooter: true,
        headerTemplate: "<div></div>",
        footerTemplate:
          '<div style="font-family:Arial,sans-serif;font-size:8px;color:#57658a;width:100%;padding:0 17mm;display:flex;justify-content:space-between"><span>Trace / Engineering design report</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>',
      }),
      180_000,
      "The report is too large to print within the time limit. No PDF was saved.",
    );
    assertCurrent();
    return pdf;
  } finally {
    if (reportWindow && !reportWindow.isDestroyed()) reportWindow.destroy();
    if (htmlPath)
      await unlink(htmlPath).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    if (directory)
      await rmdir(directory).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
  }
}

module.exports = {
  buildReportHtml,
  flattenFields,
  validateReport,
  DesignReportExporter,
  savePdfAtomically,
  renderReportPdf,
};
