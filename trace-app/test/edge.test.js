import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalStore } from "../server/local-store.js";
import { demoEnvelopes } from "../server/demo.js";
import { createSummarizer } from "../supabase/functions/_shared/ai.js";
import { hash } from "../server/domain.js";
import {
  createEdgeHandler,
  createEdgeWorker,
} from "../supabase/functions/trace/handler.js";

const owner = "00000000-0000-4000-8000-000000000001";
const other = "00000000-0000-4000-8000-000000000002";
const endpoint = "https://test.supabase.co/functions/v1/trace";
const fixture = demoEnvelopes().at(-1);
function setup(t, extra = {}, auth = {}) {
  const dir = mkdtempSync(join(tmpdir(), "trace-edge-test-"));
  const store = new LocalStore(dir);
  const tasks = [],
    authCalls = [],
    reports = [];
  const processOne = createEdgeWorker({
    storeFactory: () => store,
    summarizerFactory: () => createSummarizer({ ai: "deterministic" }),
    report: (message) => reports.push(message),
  });
  async function fetcher(url, options) {
    authCalls.push({ url, options });
    const path = new URL(url).pathname;
    const input = options.body ? JSON.parse(options.body) : {};
    if (path.endsWith("/user")) {
      const access = options.headers.Authorization;
      const id =
        access === "Bearer user-one"
          ? owner
          : access === "Bearer user-two"
            ? other
            : null;
      return id
        ? Response.json({ id, email: `${id}@example.test` })
        : Response.json({ error: "invalid token" }, { status: 401 });
    }
    if (path.endsWith("/token")) {
      if (
        input.password === "correct-password" ||
        input.refresh_token === "refresh-one"
      )
        return Response.json({
          access_token: "user-one",
          refresh_token: "refresh-one",
          expires_in: 3600,
          user: {
            id: owner,
            email: "one@example.test",
            user_metadata: { private: "not-forwarded" },
          },
        });
      return Response.json({ error: "wrong password" }, { status: 400 });
    }
    if (path.endsWith("/logout"))
      return auth.logoutFails
        ? Response.json({ error: "upstream unavailable" }, { status: 500 })
        : new Response(null, { status: 204 });
    if (path.endsWith("/signup"))
      return Response.json(auth.signupResult || { id: owner });
    throw new Error("Unexpected auth request");
  }
  const handler = createEdgeHandler(
    {
      supabaseUrl: "https://test.supabase.co",
      publicOrigin: endpoint,
      anonKey: "public-key",
      ai: "deterministic",
      signupUrl: "https://accounts.example.test/signup",
      authRedirectUrl: "https://accounts.example.test/confirmed",
      ...extra,
    },
    store,
    {
      fetcher,
      processOne,
      waitUntil: (task) => tasks.push(task),
      report: (message) => reports.push(message),
    },
  );
  async function drain() {
    while (tasks.length) await Promise.all(tasks.splice(0));
  }
  t.after(async () => {
    await drain();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  function request(
    path,
    { method = "GET", body, access = "user-one", headers = {} } = {},
  ) {
    return handler(
      new Request(endpoint + path, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(access ? { Authorization: `Bearer ${access}` } : {}),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
  }
  return { store, request, handler, drain, authCalls, reports };
}

test("Edge login, refresh, signup and logout use Supabase Auth, and expose no privileged key or metadata", async (t) => {
  const { request, authCalls } = setup(t);
  const login = await request("/api/auth/login", {
    method: "POST",
    access: null,
    body: { email: "one@example.test", password: "correct-password" },
  });
  assert.equal(login.status, 200);
  const session = await login.json();
  assert.equal(session.session.access_token, "user-one");
  assert.deepEqual(session.user, { id: owner, email: "one@example.test" });
  assert.equal(login.headers.get("set-cookie"), null);
  assert.equal(
    (
      await request("/api/auth/login", {
        method: "POST",
        access: null,
        body: { email: "one@example.test", password: "bad" },
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await request("/api/auth/login", {
        method: "POST",
        access: null,
        body: null,
      })
    ).status,
    400,
  );
  const refresh = await request("/api/auth/refresh", {
    method: "POST",
    access: null,
    body: { refresh_token: "refresh-one" },
  });
  assert.equal(refresh.status, 200);
  assert.equal(
    (await request("/api/auth/refresh", { method: "POST", body: {} })).status,
    401,
  );
  assert.equal(
    (
      await request("/api/auth/signup", {
        method: "POST",
        access: null,
        body: {
          email: "new@example.test",
          password: "correct-password",
          redirect: "https://attacker.test",
        },
      })
    ).status,
    200,
  );
  const signup = authCalls.find((call) => call.url.includes("/signup"));
  assert.equal(
    new URL(signup.url).searchParams.get("redirect_to"),
    "https://accounts.example.test/confirmed",
  );
  assert.equal((await request("/api/auth/me")).status, 200);
  assert.equal(
    (await request("/api/auth/logout", { method: "POST" })).status,
    200,
  );
  assert.ok(
    authCalls.some(
      (call) =>
        call.url.endsWith("/logout?scope=local") &&
        call.options.method === "POST",
    ),
  );
  assert.ok(
    authCalls.every((call) => call.options.headers.apikey === "public-key"),
  );
});

test("Edge signup reports confirmation only when Supabase does not create a session", async (t) => {
  const { request, authCalls } = setup(t);
  const response = await request("/api/auth/signup", {
    method: "POST",
    access: null,
    body: { email: "new@example.test", password: "correct-password" },
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.ok, true);
  assert.equal(result.confirmationRequired, true);
  assert.match(result.message, /Check your email/);
  assert.equal(result.session, undefined);
  assert.equal(
    authCalls.some((call) => call.url.includes("/logout")),
    false,
  );
});

test("Edge immediate signup revokes only its new session and accepts bounded display names", async (t) => {
  const { request, authCalls } = setup(
    t,
    {},
    {
      signupResult: {
        access_token: "new-signup-session",
        refresh_token: "new-refresh",
        expires_in: 3600,
        user: { id: other, email: "new@example.test" },
      },
    },
  );
  const response = await request("/api/auth/signup", {
    method: "POST",
    // A pre-existing sign-in must never be the session that gets revoked.
    access: "user-one",
    body: {
      email: "new@example.test",
      password: "correct-password",
      name: "  Demo Engineer  ",
      data: { role: "admin" },
      redirect: "https://attacker.test",
    },
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.confirmationRequired, false);
  assert.match(result.message, /account is ready/);
  assert.doesNotMatch(JSON.stringify(result), /new-signup-session|new-refresh/);
  assert.equal(result.session, undefined);
  const signup = authCalls.find((call) => call.url.includes("/signup"));
  assert.deepEqual(JSON.parse(signup.options.body), {
    email: "new@example.test",
    password: "correct-password",
    data: { full_name: "Demo Engineer" },
  });
  assert.equal(
    new URL(signup.url).searchParams.get("redirect_to"),
    "https://accounts.example.test/confirmed",
  );
  const logout = authCalls.find((call) => call.url.includes("/logout"));
  assert.ok(logout.url.endsWith("/logout?scope=local"));
  assert.equal(logout.options.method, "POST");
  assert.equal(
    logout.options.headers.Authorization,
    "Bearer new-signup-session",
  );
});

test("Edge signup rejects invalid names before creating an account", async (t) => {
  const { request, authCalls } = setup(t);
  for (const name of [null, 42, " ", "a".repeat(121)]) {
    const response = await request("/api/auth/signup", {
      method: "POST",
      access: null,
      body: { email: "new@example.test", password: "correct-password", name },
    });
    assert.equal(response.status, 400);
  }
  assert.equal(authCalls.length, 0);
});

test("Edge signup does not claim success if its temporary session cannot be revoked", async (t) => {
  const { request } = setup(
    t,
    {},
    {
      signupResult: {
        access_token: "new-signup-session",
        refresh_token: "new-refresh",
        user: { id: other, email: "new@example.test" },
      },
      logoutFails: true,
    },
  );
  const response = await request("/api/auth/signup", {
    method: "POST",
    access: null,
    body: { email: "new@example.test", password: "correct-password" },
  });
  assert.equal(response.status, 503);
  const result = await response.json();
  assert.match(result.error, /account was created/);
  assert.doesNotMatch(JSON.stringify(result), /new-signup-session|new-refresh/);
});

test("Edge allows the configured website origin for authenticated reads and preflight", async (t) => {
  const { request } = setup(t, {
    signupUrl: "https://tracenz.vercel.app/signup",
  });
  const origin = "https://tracenz.vercel.app";
  const preflight = await request("/api/events", {
    method: "OPTIONS",
    access: null,
    headers: { origin, "access-control-request-headers": "authorization" },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), origin);
  assert.match(
    preflight.headers.get("access-control-allow-headers"),
    /authorization/,
  );
  const response = await request("/api/events", { headers: { origin } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), origin);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(
    (
      await request("/api/events", {
        headers: { origin: "https://tracenz-preview.vercel.app" },
      })
    ).status,
    403,
  );
});

test("Edge denies anonymous, invalid sessions and untrusted browser origins before reading data", async (t) => {
  const { request } = setup(t);
  for (const path of [
    "/api/events",
    "/api/documents",
    "/api/tokens",
    "/api/auth/me",
  ]) {
    assert.equal((await request(path, { access: null })).status, 401);
    assert.equal((await request(path, { access: "invalid" })).status, 401);
  }
  assert.equal(
    (
      await request("/api/events", {
        method: "POST",
        access: null,
        body: fixture,
      })
    ).status,
    401,
  );
  assert.equal((await request("/api/config", { access: null })).status, 200);
  assert.equal((await request("/api/health", { access: null })).status, 200);
  assert.equal(
    (
      await request("/api/events", {
        headers: { origin: "https://attacker.test" },
      })
    ).status,
    403,
  );
  const preflight = await request("/api/auth/signup", {
    method: "OPTIONS",
    access: null,
    headers: { origin: "https://accounts.example.test" },
  });
  assert.equal(preflight.status, 204);
  assert.equal(
    preflight.headers.get("Access-Control-Allow-Origin"),
    "https://accounts.example.test",
  );
});

test("Edge cloud workflow preserves normalized evidence, scopes users, renders images and exports, and tombstones deletes", async (t) => {
  const { request, drain, store } = setup(t);
  const upload = await request("/api/events", {
    method: "POST",
    body: { ...fixture, owner_id: other },
  });
  assert.equal(upload.status, 200);
  const saved = await upload.json();
  await drain();
  assert.equal((await store.get(owner, saved.eventId)).status, "complete");
  const detail = await (await request(`/api/events/${saved.eventId}`)).json();
  assert.equal(detail.aiProvider, "template");
  assert.equal(detail.rawEvent.rawChangeCount, 4);
  assert.equal(detail.engineeringChanges.length, 1);
  assert.equal(
    (await request(`/api/events/${saved.eventId}`, { access: "user-two" }))
      .status,
    404,
  );
  assert.equal(
    (
      await request(`/api/events/${saved.eventId}/image`, {
        access: "user-two",
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await request(`/api/events/${saved.eventId}`, {
        method: "DELETE",
        access: "user-two",
      })
    ).status,
    404,
  );
  assert.equal(
    (await (await request("/api/events", { access: "user-two" })).json()).events
      .length,
    0,
  );
  const bytes = Buffer.from(
    await (await request(`/api/events/${saved.eventId}/image`)).arrayBuffer(),
  );
  assert.equal(
    hash(bytes),
    hash(Buffer.from(fixture.viewport.base64, "base64")),
  );
  const doc = (await (await request("/api/documents")).json()).documents[0];
  assert.equal(
    (await request(`/api/documents/${doc.id}/export`, { access: "user-two" }))
      .status,
    404,
  );
  const archive = Buffer.from(
    await (await request(`/api/documents/${doc.id}/export`)).arrayBuffer(),
  );
  assert.equal(archive.readUInt32LE(0), 0x04034b50);
  assert.ok(archive.includes(Buffer.from(`${saved.eventId}/viewport.png`)));
  const duplicate = await (
    await request("/api/events", { method: "POST", body: fixture })
  ).json();
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.eventId, saved.eventId);
  const changed = structuredClone(fixture);
  changed.event.rationale = "Different content";
  assert.equal(
    (await request("/api/events", { method: "POST", body: changed })).status,
    409,
  );
  assert.equal((await request("/api/events?limit=101")).status, 400);
  assert.equal((await request("/api/events?cursor=broken")).status, 400);
  assert.equal(
    (await request(`/api/events/${saved.eventId}`, { method: "DELETE" }))
      .status,
    200,
  );
  assert.equal((await request(`/api/events/${saved.eventId}`)).status, 404);
  assert.equal(
    (await request("/api/events", { method: "POST", body: fixture })).status,
    409,
  );
});

test("Edge installation tokens allow only owner-scoped upload, and revocation takes effect", async (t) => {
  const { request, drain, store } = setup(t);
  const created = await request("/api/tokens", {
    method: "POST",
    body: { name: "Fusion desktop" },
  });
  assert.equal(created.status, 201);
  const token = await created.json();
  assert.match(token.token, /^trc_[A-Za-z0-9_-]{43}$/);
  assert.equal((await store.tokens(owner))[0].token_hash, undefined);
  for (const [path, method] of [
    ["/api/events", "GET"],
    ["/api/tokens", "POST"],
    ["/api/documents", "GET"],
    ["/api/auth/logout", "POST"],
  ])
    assert.equal(
      (await request(path, { method, access: token.token })).status,
      403,
    );
  const upload = await request("/api/events", {
    method: "POST",
    access: token.token,
    body: fixture,
  });
  assert.equal(upload.status, 200);
  const saved = await upload.json();
  await drain();
  assert.ok(await store.get(owner, saved.eventId));
  assert.equal(
    (
      await request(`/api/tokens/${token.id}`, {
        method: "DELETE",
        access: "user-two",
      })
    ).status,
    404,
  );
  assert.equal(
    (await request(`/api/tokens/${token.id}`, { method: "DELETE" })).status,
    200,
  );
  assert.equal(
    (
      await request("/api/events", {
        method: "POST",
        access: token.token,
        body: fixture,
      })
    ).status,
    401,
  );
});

test("Edge scheduled worker requires its own bounded secret, supports database verification, and processes one lease", async (t) => {
  const { request, store, drain } = setup(t);
  let authorizations = 0;
  store.rpc = async (name, args) => {
    assert.equal(name, "trace_worker_authorized");
    authorizations++;
    return args.p_token === "w".repeat(64);
  };
  assert.equal(
    (await request("/api/internal/process", { method: "POST", access: null }))
      .status,
    401,
  );
  assert.equal(authorizations, 0);
  assert.equal(
    (
      await request("/api/internal/process", {
        method: "POST",
        headers: { "x-trace-worker-secret": "x".repeat(300) },
      })
    ).status,
    401,
  );
  assert.equal(authorizations, 0);
  assert.equal(
    (
      await request("/api/internal/process", {
        method: "POST",
        headers: { "x-trace-worker-secret": "wrong".repeat(10) },
      })
    ).status,
    401,
  );
  assert.equal(authorizations, 1);
  assert.equal(
    (
      await request("/api/internal/process", {
        method: "POST",
        access: null,
        headers: { "x-trace-worker-secret": "w".repeat(64) },
      })
    ).status,
    202,
  );
  await drain();
  assert.equal(authorizations, 2);
  const calls = [],
    row = { id: "job", raw_event: fixture.event };
  const worker = createEdgeWorker({
    storeFactory: () => ({
      recoverExhausted: async () => calls.push("recover"),
      claim: async () => {
        calls.push("claim");
        return row;
      },
      image: async () => Buffer.from("png"),
      settle: async (_row, result, error) => {
        calls.push({ result, error });
      },
    }),
    summarizerFactory: () => async () => {
      throw new Error("credential must not leak");
    },
  });
  await Promise.all([worker(), worker()]);
  assert.equal(calls.filter((call) => call === "claim").length, 1);
  assert.equal(calls.at(-1).result, null);
  assert.match(calls.at(-1).error, /retry automatically/);
  assert.doesNotMatch(calls.at(-1).error, /credential/);
});

test("Edge copies exactly match shared server modules plus Deno Buffer imports", () => {
  for (const name of [
    "domain.js",
    "ai.js",
    "supabase-store.js",
    "zip.js",
    "design-report.js",
  ]) {
    const source = readFileSync(
      new URL(`../server/${name}`, import.meta.url),
      "utf8",
    );
    const edge = readFileSync(
      new URL(`../supabase/functions/_shared/${name}`, import.meta.url),
      "utf8",
    );
    const prefix = `// Generated by scripts/prepare-edge.js from server/${name}. Do not edit.\n${/\bBuffer\b/.test(source) ? 'import { Buffer } from "node:buffer";\n' : ""}`;
    assert.equal(
      edge,
      prefix + source,
      `Run node scripts/prepare-edge.js after editing ${name}`,
    );
  }
});
