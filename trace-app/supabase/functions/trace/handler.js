import { Buffer } from "node:buffer";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  HttpError,
  hash,
  object,
  present,
  validateEnvelope,
} from "../_shared/domain.js";
import { zip } from "../_shared/zip.js";
import { createDesignReportGenerator } from "../_shared/design-report.js";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const statuses = new Set([
  "receiving",
  "pending",
  "processing",
  "complete",
  "failed",
]);

async function body(req, limit = 12 * 1024 * 1024) {
  if (!req.headers.get("content-type")?.startsWith("application/json"))
    throw new HttpError(415, "Use Content-Type: application/json.");
  if (Number(req.headers.get("content-length") || 0) > limit)
    throw new HttpError(413, "Request body is too large.");
  const reader = req.body?.getReader();
  if (!reader) throw new HttpError(400, "Request contains invalid JSON.");
  let length = 0;
  const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) {
        await reader.cancel();
        throw new HttpError(413, "Request body is too large.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Request contains invalid JSON.");
  }
}

function credentials(input, signup = false) {
  if (
    !object(input) ||
    typeof input.email !== "string" ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email.trim()) ||
    input.email.length > 254 ||
    typeof input.password !== "string" ||
    input.password.length < (signup ? 8 : 1) ||
    input.password.length > 128
  )
    throw new HttpError(
      400,
      signup
        ? "Enter a valid email and a password of 8–128 characters."
        : "Enter your email and password.",
    );
  return { email: input.email.trim(), password: input.password };
}

// One durable lease per invocation. A terminated invocation is recovered by the
// next invocation/cron after lease expiry; no continuous process is required.
export function createEdgeWorker({
  storeFactory,
  summarizerFactory,
  report = console.error,
}) {
  let running;
  return function processOne() {
    if (running) return running;
    running = (async () => {
      const signal = AbortSignal.timeout(125_000);
      const store = storeFactory(signal);
      try {
        await store.recoverExhausted();
        const row = await store.claim();
        if (row) {
          try {
            const result = await summarizerFactory(signal)(
              row.raw_event,
              await store.image(row),
            );
            await store.settle(row, result, null);
          } catch {
            // Provider error text may contain evidence or credentials. Only a
            // fixed, actionable message is persisted in the user's timeline.
            await store.settle(
              row,
              null,
              "Summary generation could not finish. Trace will retry automatically, up to three attempts.",
            );
          }
        }
        await store.cleanup?.();
      } catch {
        report(
          "Trace background work was interrupted; its durable lease can be retried.",
        );
      }
    })().finally(() => {
      running = null;
    });
    return running;
  };
}

export function createEdgeHandler(
  config,
  store,
  {
    fetcher = fetch,
    processOne = async () => {},
    waitUntil = () => {},
    report = console.error,
  } = {},
) {
  const generateReport = createDesignReportGenerator(config, store, {
    fetcher,
  });
  const allowedOrigins = new Set([new URL(config.publicOrigin).origin]);
  if (config.signupUrl) allowedOrigins.add(new URL(config.signupUrl).origin);
  const buckets = new Map();
  function rate(key, max) {
    const now = Date.now(),
      item = buckets.get(key);
    if (!item || item.until <= now)
      buckets.set(key, { count: 1, until: now + 60_000 });
    else if (++item.count > max)
      throw new HttpError(429, "Too many requests. Try again in a minute.");
    if (buckets.size > 10000)
      for (const [key, item] of buckets)
        if (item.until <= now) buckets.delete(key);
  }
  function kick() {
    waitUntil(
      Promise.resolve()
        .then(processOne)
        .catch(() => report("Trace background work could not start.")),
    );
  }
  async function authRequest(path, payload, bearer, method) {
    let response;
    try {
      response = await fetcher(`${config.supabaseUrl}/auth/v1/${path}`, {
        method: method || (payload ? "POST" : "GET"),
        headers: {
          apikey: config.anonKey,
          "Content-Type": "application/json",
          ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
        },
        body: payload ? JSON.stringify(payload) : undefined,
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new HttpError(503, "Sign-in service is temporarily unavailable.");
    }
    if (!response.ok)
      throw new HttpError(
        response.status === 429 ? 429 : response.status >= 500 ? 503 : 401,
        response.status === 429
          ? "Too many authentication attempts. Please try again later."
          : response.status >= 500
            ? "Sign-in service is temporarily unavailable."
            : "Sign-in failed or session expired.",
      );
    const text = await response.text();
    return text ? JSON.parse(text) : {};
  }
  async function identify(req, ingest = false) {
    const bearer = req.headers
      .get("authorization")
      ?.match(/^Bearer (\S+)$/i)?.[1];
    if (!bearer) throw new HttpError(401, "Sign in to your Trace account.");
    if (bearer.startsWith("trc_")) {
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
    const user = await authRequest("user", null, bearer);
    if (!uuid.test(user.id))
      throw new HttpError(401, "Sign in to your Trace account.");
    return user;
  }
  function sessionResult(session) {
    if (
      !session.access_token ||
      !session.refresh_token ||
      !uuid.test(session.user?.id)
    )
      throw new HttpError(502, "Sign-in service returned an invalid session.");
    return {
      user: { id: session.user.id, email: session.user.email },
      session: {
        access_token: session.access_token,
        refresh_token: session.refresh_token,
        expires_in: session.expires_in,
      },
    };
  }
  return async function handler(req) {
    const requestId = randomUUID();
    const headers = new Headers({
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Request-ID": requestId,
    });
    const json = (status, data) =>
      new Response(JSON.stringify(data), {
        status,
        headers: {
          ...Object.fromEntries(headers),
          "Content-Type": "application/json",
        },
      });
    try {
      const origin = req.headers.get("origin");
      if (origin && !allowedOrigins.has(origin))
        throw new HttpError(403, "Cross-origin requests are not allowed.");
      if (origin) {
        headers.set("Access-Control-Allow-Origin", origin);
        headers.set("Vary", "Origin");
        headers.set(
          "Access-Control-Allow-Headers",
          "authorization, apikey, content-type, x-client-info",
        );
        headers.set(
          "Access-Control-Allow-Methods",
          "GET, POST, DELETE, OPTIONS",
        );
      }
      if (req.method === "OPTIONS")
        return new Response(null, { status: 204, headers });
      const url = new URL(req.url);
      const path = url.pathname.replace(
        /^\/(?:functions\/v1\/)?trace(?=\/|$)/,
        "",
      );
      const method = req.method;
      const ip = req.headers.get("x-forwarded-for")?.split(",")[0] || "unknown";
      if (path === "/api/health" && method === "GET")
        return json(200, {
          ok: true,
          service: "trace-backend",
          version: "0.5.0",
          runtime: "supabase-edge",
        });
      if (path === "/api/config" && method === "GET")
        return json(200, {
          mode: "supabase",
          ai: config.ai,
          signupUrl: config.signupUrl || "",
          uploadUrl: `${config.publicOrigin}/api/events`,
        });
      if (path === "/api/auth/signup" && method === "POST") {
        if (!config.authRedirectUrl)
          throw new HttpError(503, "Registration is not configured yet.");
        rate(`signup:${ip}`, 5);
        const input = await body(req, 16384);
        const account = credentials(input, true);
        if (
          input.name !== undefined &&
          (typeof input.name !== "string" ||
            !input.name.trim() ||
            input.name.length > 120)
        )
          throw new HttpError(400, "Enter a name of 1–120 characters.");
        const result = await authRequest(
          `signup?redirect_to=${encodeURIComponent(config.authRedirectUrl)}`,
          {
            ...account,
            ...(input.name === undefined
              ? {}
              : { data: { full_name: input.name.trim() } }),
          },
        );
        const confirmationRequired = !result.access_token;
        if (!confirmationRequired) {
          // Autoconfirm creates a session. Registration must not leave an
          // undisclosed session alive or sign out the user's other devices.
          const { session } = sessionResult(result);
          try {
            await authRequest(
              "logout?scope=local",
              null,
              session.access_token,
              "POST",
            );
          } catch {
            throw new HttpError(
              503,
              "Your account was created, but registration could not finish. Sign in to continue.",
            );
          }
        }
        return json(200, {
          ok: true,
          confirmationRequired,
          message: confirmationRequired
            ? "Check your email to confirm your account, then sign in to Trace."
            : "Your account is ready. Sign in to Trace on the web or in the desktop app.",
        });
      }
      if (path === "/api/auth/login" && method === "POST") {
        rate(`login:${ip}`, 15);
        return json(
          200,
          sessionResult(
            await authRequest(
              "token?grant_type=password",
              credentials(await body(req, 16384)),
            ),
          ),
        );
      }
      if (path === "/api/auth/refresh" && method === "POST") {
        rate(`refresh:${ip}`, 60);
        const input = await body(req, 16384);
        if (
          !object(input) ||
          typeof input.refresh_token !== "string" ||
          !input.refresh_token ||
          input.refresh_token.length > 8192
        )
          throw new HttpError(401, "Sign in again.");
        return json(
          200,
          sessionResult(
            await authRequest("token?grant_type=refresh_token", {
              refresh_token: input.refresh_token,
            }),
          ),
        );
      }
      if (path === "/api/internal/process" && method === "POST") {
        const provided = req.headers.get("x-trace-worker-secret") || "";
        if (provided.length < 32 || provided.length > 256)
          throw new HttpError(401, "Worker authorization is required.");
        const authorized = config.workerSecret
          ? timingSafeEqual(
              Buffer.from(hash(provided)),
              Buffer.from(hash(config.workerSecret)),
            )
          : (await store.rpc("trace_worker_authorized", {
              p_token: provided,
            })) === true;
        if (!authorized)
          throw new HttpError(401, "Worker authorization is required.");
        kick();
        return json(202, { ok: true });
      }
      const user = await identify(
        req,
        path === "/api/events" && method === "POST",
      );
      if (path === "/api/auth/logout" && method === "POST") {
        await authRequest(
          "logout?scope=local",
          null,
          req.headers.get("authorization").slice(7),
          "POST",
        );
        return json(200, { ok: true });
      }
      if (path === "/api/auth/me" && method === "GET")
        return json(200, { id: user.id, email: user.email });
      if (path === "/api/events" && method === "POST") {
        rate(`ingest:${user.id}`, 30);
        const result = await store.ingest(
          user.id,
          validateEnvelope(await body(req)),
        );
        kick();
        return json(200, {
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
          (status && !statuses.has(status)) ||
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
          }),
          page = rows.slice(0, limit),
          last = page.at(-1);
        if (page.some((row) => ["pending", "processing"].includes(row.status)))
          kick();
        return json(200, {
          events: page.map((row) => present(row)),
          nextCursor:
            rows.length > limit
              ? Buffer.from(
                  JSON.stringify({ time: last.captured_at, id: last.id }),
                ).toString("base64url")
              : null,
        });
      }
      if (path === "/api/documents" && method === "GET")
        return json(200, { documents: await store.documents(user.id) });
      const eventMatch = path.match(
        /^\/api\/events\/([0-9a-f-]+)(?:\/(image|retry-ai))?$/i,
      );
      if (eventMatch && uuid.test(eventMatch[1])) {
        const row = await store.get(user.id, eventMatch[1]);
        if (!row) throw new HttpError(404, "Checkpoint not found.");
        if (method === "GET" && eventMatch[2] === "image")
          return new Response(await store.image(row), {
            headers: {
              ...Object.fromEntries(headers),
              "Content-Type": "image/png",
            },
          });
        if (method === "GET" && !eventMatch[2]) {
          if (["pending", "processing"].includes(row.status)) kick();
          return json(200, present(row, true));
        }
        if (method === "POST" && eventMatch[2] === "retry-ai") {
          rate(`retry:${user.id}`, 10);
          if (!(await store.retry(user.id, row.id)))
            throw new HttpError(409, "Only failed summaries can be retried.");
          kick();
          return json(200, { ok: true });
        }
        if (method === "DELETE" && !eventMatch[2]) {
          await store.delete(user.id, row.id);
          kick();
          return json(200, { ok: true });
        }
      }
      const reportMatch = path.match(
        /^\/api\/documents\/([0-9a-f-]+)\/report$/i,
      );
      if (reportMatch && uuid.test(reportMatch[1]) && method === "POST") {
        rate(`report:${user.id}`, 3);
        return json(200, {
          report: await generateReport(user.id, reportMatch[1]),
        });
      }
      const exportMatch = path.match(
        /^\/api\/documents\/([0-9a-f-]+)\/export$/i,
      );
      if (exportMatch && uuid.test(exportMatch[1]) && method === "GET") {
        rate(`export:${user.id}`, 5);
        const rows = await store.list(user.id, {
          documentId: exportMatch[1],
          limit: 501,
        });
        if (!rows.length)
          throw new HttpError(404, "Document has no checkpoints.");
        // A conservative Edge limit leaves room for image buffers, zip output and
        // concurrent requests inside the 256 MB runtime memory budget.
        if (
          rows.length > 500 ||
          rows.reduce(
            (sum, row) =>
              sum +
              row.image_bytes +
              Buffer.byteLength(JSON.stringify(row.raw_event)),
            0,
          ) >
            20 * 1024 * 1024
        )
          throw new HttpError(
            413,
            "Cloud export exceeds the 500 checkpoint / 20 MB limit. Export larger histories from the local desktop workspace.",
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
        for (const row of rows)
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
        return new Response(zip(entries), {
          headers: {
            ...Object.fromEntries(headers),
            "Content-Type": "application/zip",
            "Content-Disposition": 'attachment; filename="trace-export.zip"',
          },
        });
      }
      if (path === "/api/tokens" && method === "GET")
        return json(200, { tokens: await store.tokens(user.id) });
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
        const secret = `trc_${randomBytes(32).toString("base64url")}`,
          token = {
            id: randomUUID(),
            name: input.name.trim(),
            token_hash: hash(secret),
            prefix: secret.slice(0, 12),
            created_at: new Date().toISOString(),
          };
        await store.createToken(user.id, token);
        return json(201, { id: token.id, token: secret });
      }
      const tokenMatch = path.match(/^\/api\/tokens\/([0-9a-f-]+)$/i);
      if (tokenMatch && uuid.test(tokenMatch[1]) && method === "DELETE") {
        if (!(await store.revokeToken(user.id, tokenMatch[1])))
          throw new HttpError(404, "Installation not found.");
        return json(200, { ok: true });
      }
      throw new HttpError(404, "API endpoint not found.");
    } catch (error) {
      if (!error.status || error.status >= 500)
        report(`Trace request ${requestId} failed (${error.status || 500}).`);
      return json(error.status || 500, {
        error: error.status
          ? error.message
          : "Something went wrong. Your saved checkpoints are safe.",
        requestId,
      });
    }
  };
}
