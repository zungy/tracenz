import { createServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  HttpError,
  hash,
  object,
  present,
  validateEnvelope,
} from "./domain.js";
import { zip } from "./zip.js";
import { seedDemo } from "./demo.js";
import { createDesignReportGenerator } from "./design-report.js";

const publicDir = join(dirname(fileURLToPath(import.meta.url)), "../public");
const localOwner = "00000000-0000-4000-8000-000000000001";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const allowedStatuses = [
  "receiving",
  "pending",
  "processing",
  "complete",
  "failed",
];
function send(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}
async function body(req, limit = 12 * 1024 * 1024) {
  if (!req.headers["content-type"]?.startsWith("application/json"))
    throw new HttpError(415, "Use Content-Type: application/json.");
  if (Number(req.headers["content-length"] || 0) > limit)
    throw new HttpError(413, "Request body is too large.");
  let length = 0;
  const parts = [];
  for await (const part of req) {
    length += part.length;
    if (length > limit) throw new HttpError(413, "Request body is too large.");
    parts.push(part);
  }
  try {
    return JSON.parse(Buffer.concat(parts).toString("utf8"));
  } catch {
    throw new HttpError(400, "Request contains invalid JSON.");
  }
}
function cookies(req) {
  return Object.fromEntries(
    (req.headers.cookie || "").split(";").map((c) => {
      const at = c.indexOf("=");
      return at < 0 ? ["", ""] : [c.slice(0, at).trim(), c.slice(at + 1)];
    }),
  );
}
function sessionCookies(res, session, secure) {
  const suffix = `; HttpOnly; SameSite=Strict; Path=/${secure ? "; Secure" : ""}`;
  res.setHeader("Set-Cookie", [
    `trace_access=${session?.access_token || ""}; Max-Age=${session ? session.expires_in || 3600 : 0}${suffix}`,
    `trace_refresh=${session?.refresh_token || ""}; Max-Age=${session ? 604800 : 0}${suffix}`,
  ]);
}
export function createApp(
  config,
  store,
  { fetcher = fetch, forwarding = null } = {},
) {
  const generateReport = createDesignReportGenerator(config, store, {
    fetcher,
  });
  const buckets = new Map();
  function rate(key, max = 60) {
    const now = Date.now(),
      item = buckets.get(key);
    if (!item || item.until <= now)
      buckets.set(key, { count: 1, until: now + 60_000 });
    else if (++item.count > max)
      throw new HttpError(429, "Too many requests. Try again in a minute.");
    if (buckets.size > 10000)
      for (const [k, v] of buckets) if (v.until <= now) buckets.delete(k);
  }
  async function authRequest(path, payload, bearer) {
    const response = await fetcher(`${config.supabaseUrl}/auth/v1/${path}`, {
      method: payload ? "POST" : "GET",
      headers: {
        apikey: config.anonKey,
        "Content-Type": "application/json",
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      },
      body: payload ? JSON.stringify(payload) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok)
      throw new HttpError(
        response.status >= 500 ? 503 : 401,
        response.status >= 500
          ? "Sign-in service is temporarily unavailable."
          : "Sign-in failed or session expired.",
      );
    return response.json();
  }
  async function identify(req, ingest = false) {
    const bearer = req.headers.authorization?.replace(/^Bearer /i, "");
    if (bearer?.startsWith("trc_")) {
      if (!ingest)
        throw new HttpError(
          403,
          "Installation tokens can upload checkpoints only.",
        );
      const owner = await store.tokenOwner(hash(bearer));
      if (!owner)
        throw new HttpError(401, "Installation token is invalid or revoked.");
      return { id: owner, installation: true };
    }
    if (config.mode === "local") {
      if (bearer) throw new HttpError(401, "Unrecognized credential.");
      return { id: localOwner, email: "Local workspace" };
    }
    const access = bearer || cookies(req).trace_access;
    if (!access) throw new HttpError(401, "Sign in to your Trace account.");
    return authRequest("user", null, access);
  }
  const server = createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    );
    const requestId = randomUUID();
    res.setHeader("X-Request-ID", requestId);
    try {
      const url = new URL(req.url, "http://trace.local");
      const path = url.pathname,
        method = req.method;
      if (config.mode === "local") {
        const hostname = (req.headers.host || "").replace(/:\d+$/, "");
        if (!["localhost", "127.0.0.1", "[::1]"].includes(hostname))
          throw new HttpError(403, "Invalid local host.");
      }
      const origin = req.headers.origin;
      if (
        origin &&
        origin !== config.publicOrigin &&
        origin !== `http://${req.headers.host}`
      )
        throw new HttpError(403, "Cross-origin requests are not allowed.");
      if (method === "OPTIONS")
        throw new HttpError(
          403,
          "Use the Trace desktop client or same-origin API.",
        );
      if (path === "/api/health" && method === "GET")
        return send(res, 200, {
          ok: true,
          service: "trace-backend",
          version: "0.6.2",
          instanceId: config.bridgeInstance,
        });
      if (path === "/api/config" && method === "GET")
        return send(res, 200, {
          mode: config.mode,
          ai: config.ai,
          signupUrl: config.signupUrl,
          uploadUrl: `${config.publicOrigin || `http://${req.headers.host}`}/api/events`,
        });
      if (path === "/api/auth/signup" && method === "POST") {
        if (config.mode !== "supabase")
          throw new HttpError(
            400,
            "Connect to a cloud workspace to create an account.",
          );
        rate(`signup:${req.socket.remoteAddress}`, 5);
        const input = await body(req, 16384);
        if (
          !object(input) ||
          typeof input.email !== "string" ||
          !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email.trim()) ||
          input.email.length > 254 ||
          typeof input.password !== "string" ||
          input.password.length < 8 ||
          input.password.length > 128
        )
          throw new HttpError(
            400,
            "Enter a valid email and a password of 8–128 characters.",
          );
        const redirect =
          config.authRedirectUrl || config.publicOrigin + "/auth/confirmed";
        const response = await fetcher(
          `${config.supabaseUrl}/auth/v1/signup?redirect_to=${encodeURIComponent(redirect)}`,
          {
            method: "POST",
            headers: {
              apikey: config.anonKey,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              email: input.email.trim(),
              password: input.password,
            }),
            signal: AbortSignal.timeout(15000),
          },
        );
        if (!response.ok)
          throw new HttpError(
            response.status === 429 ? 429 : 400,
            response.status === 429
              ? "Please wait before trying again."
              : "Account creation could not be completed. Check your password requirements or try signing in.",
          );
        const result = await response.json();
        // Even when confirmation is disabled, explicit sign-in keeps one consistent flow.
        return send(res, 200, {
          ok: true,
          message: result.access_token
            ? "Account created. You can sign in now."
            : "Check your email for a confirmation link, then return here to sign in. If you already have an account, use Sign in.",
        });
      }
      if (path === "/api/auth/login" && method === "POST") {
        if (config.mode === "local")
          throw new HttpError(400, "Local mode does not require sign-in.");
        rate(`login:${req.socket.remoteAddress}`, 10);
        const input = await body(req, 16384);
        if (
          !object(input) ||
          typeof input.email !== "string" ||
          typeof input.password !== "string"
        )
          throw new HttpError(400, "Email and password are required.");
        const session = await authRequest("token?grant_type=password", {
          email: input.email,
          password: input.password,
        });
        sessionCookies(res, session, true);
        return send(res, 200, {
          user: session.user,
          session: {
            access_token: session.access_token,
            refresh_token: session.refresh_token,
            expires_in: session.expires_in,
          },
        });
      }
      if (path === "/api/auth/refresh" && method === "POST") {
        if (config.mode !== "supabase")
          throw new HttpError(400, "No cloud session.");
        rate(`refresh:${req.socket.remoteAddress}`, 30);
        const input = await body(req, 16384),
          refresh = input.refresh_token || cookies(req).trace_refresh;
        if (typeof refresh !== "string")
          throw new HttpError(401, "Sign in again.");
        const session = await authRequest("token?grant_type=refresh_token", {
          refresh_token: refresh,
        });
        sessionCookies(res, session, true);
        return send(res, 200, {
          user: session.user,
          session: {
            access_token: session.access_token,
            refresh_token: session.refresh_token,
            expires_in: session.expires_in,
          },
        });
      }
      if (path === "/api/auth/logout" && method === "POST") {
        sessionCookies(res, null, config.mode === "supabase");
        return send(res, 200, { ok: true });
      }
      if (path.startsWith("/api/")) {
        const user = await identify(
          req,
          path === "/api/events" && method === "POST",
        );
        if (
          path.startsWith("/api/forwarding") &&
          forwarding &&
          config.mode === "local"
        ) {
          if (path === "/api/forwarding" && method === "GET")
            return send(res, 200, forwarding.status());
          if (path === "/api/forwarding" && method === "POST")
            return send(res, 200, forwarding.save(await body(req, 8192)));
          if (path === "/api/forwarding/backfill" && method === "POST")
            return send(res, 200, { queued: forwarding.backfill() });
          if (path === "/api/forwarding/retry" && method === "POST") {
            forwarding.retry();
            return send(res, 200, { ok: true });
          }
        }
        if (path === "/api/demo" && method === "POST") {
          if (config.mode !== "local")
            throw new HttpError(
              403,
              "Samples are available in local mode only.",
            );
          rate(`demo:${user.id}`, 5);
          return send(res, 200, {
            ok: true,
            added: await seedDemo(store, user.id),
          });
        }
        if (path === "/api/auth/me" && method === "GET")
          return send(res, 200, { id: user.id, email: user.email });
        if (path === "/api/events" && method === "POST") {
          rate(`ingest:${user.id}`, 30);
          const input = validateEnvelope(await body(req));
          const result = await store.ingest(user.id, input);
          // Return 200 for v0.4 compatibility: ok means durably accepted, not AI complete.
          return send(res, 200, {
            ok: true,
            eventId: result.row.id,
            status: result.row.status,
            duplicate: result.duplicate,
            ai: result.row.ai ?? null,
            message: result.row.ai
              ? "Checkpoint and summary saved."
              : "Checkpoint saved. Summary will appear in Trace shortly.",
          });
        }
        if (path === "/api/events" && method === "GET") {
          const limit = Number(url.searchParams.get("limit") || 30),
            documentId = url.searchParams.get("documentId"),
            status = url.searchParams.get("status"),
            q = url.searchParams.get("q");
          if (
            !Number.isInteger(limit) ||
            limit < 1 ||
            limit > 100 ||
            (documentId && !uuid.test(documentId)) ||
            (status && !allowedStatuses.includes(status)) ||
            (q && q.length > 200)
          )
            throw new HttpError(400, "Invalid timeline filters.");
          let cursor;
          if (url.searchParams.has("cursor")) {
            try {
              cursor = JSON.parse(
                Buffer.from(url.searchParams.get("cursor"), "base64url"),
              );
            } catch {
              throw new HttpError(400, "Invalid cursor.");
            }
            if (
              !object(cursor) ||
              !uuid.test(cursor.id) ||
              typeof cursor.time !== "string" ||
              !/^\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|\+00:00)$/.test(cursor.time) ||
              !Number.isFinite(Date.parse(cursor.time))
            )
              throw new HttpError(400, "Invalid cursor.");
          }
          const rows = await store.list(user.id, {
            documentId,
            status,
            q,
            cursor,
            limit: limit + 1,
          });
          const page = rows.slice(0, limit),
            last = page.at(-1);
          return send(res, 200, {
            events: page.map((r) => present(r)),
            nextCursor:
              rows.length > limit
                ? Buffer.from(
                    JSON.stringify({ time: last.captured_at, id: last.id }),
                  ).toString("base64url")
                : null,
          });
        }
        if (path === "/api/documents" && method === "GET")
          return send(res, 200, { documents: await store.documents(user.id) });
        const match = path.match(
          /^\/api\/events\/([0-9a-f-]+)(?:\/(image|retry-ai))?$/i,
        );
        if (match && uuid.test(match[1])) {
          const row = await store.get(user.id, match[1]);
          if (!row) throw new HttpError(404, "Checkpoint not found.");
          if (method === "GET" && match[2] === "image") {
            const image = await store.image(row);
            res.writeHead(200, {
              "Content-Type": "image/png",
              "Content-Length": image.length,
            });
            return res.end(image);
          }
          if (method === "GET" && !match[2])
            return send(res, 200, present(row, true));
          if (method === "POST" && match[2] === "retry-ai") {
            rate(`retry:${user.id}`, 10);
            if (!(await store.retry(user.id, row.id)))
              throw new HttpError(409, "Only failed summaries can be retried.");
            return send(res, 200, { ok: true });
          }
          if (method === "DELETE" && !match[2]) {
            await store.delete(user.id, row.id);
            return send(res, 200, { ok: true });
          }
        }
        const reportMatch = path.match(
          /^\/api\/documents\/([0-9a-f-]+)\/report$/i,
        );
        if (reportMatch && method === "POST" && uuid.test(reportMatch[1])) {
          rate(`report:${user.id}`, 3);
          return send(res, 200, {
            report: await generateReport(user.id, reportMatch[1]),
          });
        }
        const exportMatch = path.match(
          /^\/api\/documents\/([0-9a-f-]+)\/export$/i,
        );
        if (exportMatch && method === "GET" && uuid.test(exportMatch[1])) {
          rate(`export:${user.id}`, 5);
          const rows = await store.list(user.id, {
            documentId: exportMatch[1],
            limit: 501,
          });
          if (!rows.length)
            throw new HttpError(404, "Document has no checkpoints.");
          if (
            rows.length > 500 ||
            rows.reduce(
              (sum, r) =>
                sum +
                r.image_bytes +
                Buffer.byteLength(JSON.stringify(r.raw_event)),
              0,
            ) >
              64 * 1024 * 1024
          )
            throw new HttpError(
              413,
              "Export exceeds the 500 checkpoint / 64 MB limit.",
            );
          const entries = [
            {
              name: "manifest.json",
              bytes: JSON.stringify(
                {
                  format: "trace-export",
                  version: 1,
                  document: rows[0].raw_event.document,
                  exportedAt: new Date().toISOString(),
                  checkpoints: rows.length,
                },
                null,
                2,
              ),
            },
          ];
          for (const row of rows) {
            entries.push(
              {
                name: `${row.id}/event.json`,
                bytes: JSON.stringify(
                  {
                    event: row.raw_event,
                    ai: row.ai,
                    aiProvider: row.ai_provider,
                    status: row.status,
                    viewport: {
                      filename: "viewport.png",
                      contentType: "image/png",
                    },
                  },
                  null,
                  2,
                ),
              },
              { name: `${row.id}/viewport.png`, bytes: await store.image(row) },
            );
          }
          res.writeHead(200, {
            "Content-Type": "application/zip",
            "Content-Disposition": 'attachment; filename="trace-export.zip"',
          });
          return res.end(zip(entries));
        }
        if (path === "/api/tokens" && method === "GET")
          return send(res, 200, { tokens: await store.tokens(user.id) });
        if (path === "/api/tokens" && method === "POST") {
          rate(`tokens:${user.id}`, 10);
          const input = await body(req, 4096);
          if (
            !object(input) ||
            typeof input.name !== "string" ||
            !input.name.trim() ||
            input.name.length > 80
          )
            throw new HttpError(
              400,
              "Give this installation a name (up to 80 characters).",
            );
          const secret = `trc_${randomBytes(32).toString("base64url")}`;
          const token = {
            id: randomUUID(),
            name: input.name.trim(),
            token_hash: hash(secret),
            prefix: secret.slice(0, 12),
            created_at: new Date().toISOString(),
          };
          await store.createToken(user.id, token);
          return send(res, 201, { id: token.id, token: secret });
        }
        const tokenMatch = path.match(/^\/api\/tokens\/([0-9a-f-]+)$/i);
        if (tokenMatch && uuid.test(tokenMatch[1]) && method === "DELETE") {
          if (!(await store.revokeToken(user.id, tokenMatch[1])))
            throw new HttpError(404, "Installation not found.");
          return send(res, 200, { ok: true });
        }
        throw new HttpError(404, "API endpoint not found.");
      }
      const assets = {
        "/signup": ["signup.html", "text/html"],
        "/signup.js": ["signup.js", "text/javascript"],
        "/auth/confirmed": ["confirmed.html", "text/html"],
        "/confirmed.js": ["confirmed.js", "text/javascript"],
        "/": ["index.html", "text/html"],
        "/index.html": ["index.html", "text/html"],
        "/app.js": ["app.js", "text/javascript"],
        "/style.css": ["style.css", "text/css"],
      };
      if (method === "GET" && assets[path]) {
        const [file, type] = assets[path];
        res.writeHead(200, { "Content-Type": type });
        return res.end(await readFile(join(publicDir, file)));
      }
      throw new HttpError(404, "Not found.");
    } catch (error) {
      if (!error.status || error.status >= 500)
        console.error(`[${requestId}]`, error.message);
      if (!res.headersSent && !res.destroyed)
        send(res, error.status || 500, {
          error: error.status
            ? error.message
            : "Something went wrong. Your saved checkpoints are safe.",
          requestId,
        });
      else res.end();
    }
  });
  server.requestTimeout = 120_000;
  server.headersTimeout = 15_000;
  return server;
}
