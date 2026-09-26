// Isolated browser QA of the exact desktop renderer. Never reads credentials,
// starts Fusion, or writes to Supabase. Not included in the desktop distribution.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { demoEnvelopes, demoPng } from "../server/demo.js";
import { createSummarizer } from "../server/ai.js";

const root = resolve("public");
const { version } = JSON.parse(await readFile("package.json", "utf8"));
const summarize = createSummarizer({ ai: "deterministic" });
const docId = randomUUID();
const rows = await Promise.all(
  demoEnvelopes()
    .reverse()
    .map(async ({ event }, i) => ({
      id: randomUUID(),
      documentId: docId,
      documentName: "Mounting bracket · QA fixture",
      capturedAt: new Date(Date.now() - (i * 3 + 1) * 3600000).toISOString(),
      source: event.source,
      status: "complete",
      ai: (await summarize(event)).ai,
      aiProvider: "template",
      rationale: event.rationale,
      engineeringChanges: event.engineeringChanges,
      changeCount: event.changeCount,
      rawChangeCount: event.rawChangeCount,
      rawEvent: event,
    })),
);
const png = demoPng();
const shim = `const flags = new URLSearchParams(location.search);
let loggedIn = false;
async function request(path, options = {}) {
  if (flags.has('offline') && path === '/api/config') throw Error('QA: network unavailable');
  if (path === '/api/auth/me') {
    if (!loggedIn) throw Error('Sign in required');
    return {id:'qa-user',email:'engineer@example.com'};
  }
  if (path === '/api/auth/login') {
    if (options.body.password !== 'preview-pass') throw Error('Email or password is incorrect.');
    loggedIn = true; return {};
  }
  if (path === '/api/auth/logout') { loggedIn = false; return {}; }
  if (path !== '/api/config' && !loggedIn) throw Error('Sign in required');
  const u = new URL(path, location.origin);
  if (flags.has('empty')) u.searchParams.set('empty','1');
  const response = await fetch(u, {method:options.method || 'GET'});
  const data = await response.json();
  if (!response.ok) throw Error(data.error);
  return data;
}
window.trace = {
  request, connection: async () => ({version:${JSON.stringify(version)}}),
  image: async () => '/qa-image.png',
  fusionStatus: async () => ({version:'0.5.0',delivery:{updatedAt:Date.now()/1000,connected:true,queued:0,blocked:0}}),
  installFusion: async () => ({}), resumeSync: async () => ({}),
  generateDesignReport: async () => ({canceled:true}),
  exportDocument: async () => ({canceled:true}), importCheckpoint: async () => ({canceled:true}),
  openSignup: async () => ({})
};`;
const mime = {
  ".css": "text/css",
  ".js": "text/javascript",
  ".html": "text/html",
  ".woff2": "font/woff2",
  ".txt": "text/plain",
};
createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const json = (value, code = 200) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(value));
  };
  if (url.pathname === "/api/config")
    return json({
      mode: "supabase",
      ai: "openai",
      signupUrl: "https://example.com/signup",
    });
  if (url.pathname === "/api/documents")
    return json({
      documents: url.searchParams.has("empty")
        ? []
        : [
            {
              id: docId,
              name: rows[0].documentName,
              source: "Autodesk Fusion",
              event_count: 4,
              complete_count: 4,
              latest_at: rows[0].capturedAt,
            },
          ],
    });
  if (url.pathname === "/api/events") {
    const q = (url.searchParams.get("q") || "").toLowerCase();
    return json({
      events: url.searchParams.has("empty")
        ? []
        : rows.filter((row) => JSON.stringify(row).toLowerCase().includes(q)),
      nextCursor: null,
    });
  }
  if (url.pathname.startsWith("/api/events/")) {
    const row = rows.find((row) => row.id === url.pathname.split("/").at(-1));
    return json(row || { error: "Not found" }, row ? 200 : 404);
  }
  if (url.pathname === "/api/forwarding")
    return json({
      enabled: true,
      counts: { uploaded: 4, pending: 0, blocked: 0 },
    });
  if (url.pathname === "/qa-image.png") {
    res.writeHead(200, { "Content-Type": "image/png" });
    return res.end(png);
  }
  if (url.pathname === "/qa-shim.js") {
    res.writeHead(200, { "Content-Type": "text/javascript" });
    return res.end(shim);
  }
  try {
    const path = resolve(
      root,
      `.${decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname)}`,
    );
    if (!path.startsWith(root + sep)) return json({ error: "Not found" }, 404);
    let body = await readFile(path);
    if (path.endsWith("index.html"))
      body = body
        .toString()
        .replace(
          '<script src="./app.js"',
          '<script src="/qa-shim.js"></script><script src="./app.js"',
        );
    res.writeHead(200, {
      "Content-Type": mime[extname(path)] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(body);
  } catch {
    json({ error: "Not found" }, 404);
  }
}).listen(9197, "127.0.0.1", () =>
  console.log("Isolated desktop renderer QA: http://127.0.0.1:9197"),
);
