import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const { BackendClient } = createRequire(import.meta.url)(
  "../desktop/transport.cjs",
);

test("Concurrent desktop requests refresh once and never return session credentials to the renderer", async () => {
  let refreshes = 0;
  const client = new BackendClient(
    "https://trace.test",
    async (url, options) => {
      if (url.endsWith("/api/auth/login"))
        return Response.json({
          user: { id: "a" },
          session: { access_token: "old", refresh_token: "rotate-me" },
        });
      if (url.endsWith("/api/auth/refresh")) {
        refreshes++;
        await new Promise((r) => setTimeout(r, 20));
        return Response.json({
          user: { id: "a" },
          session: { access_token: "new", refresh_token: "rotated" },
        });
      }
      if (options.headers.Authorization === "Bearer old")
        return Response.json({ error: "expired" }, { status: 401 });
      return Response.json({ ok: true });
    },
  );
  const login = await client.request("/api/auth/login", {
    method: "POST",
    body: {},
  });
  assert.equal(login.session, undefined);
  const result = await Promise.all(
    ["/api/auth/me", "/api/events", "/api/documents"].map((path) =>
      client.request(path),
    ),
  );
  assert.equal(refreshes, 1);
  assert.ok(result.every((data) => data.ok));
  assert.equal(client.session.refresh_token, "rotated");
});
test("Changing backends rejects in-flight credentials from the old server", async () => {
  let finish;
  const client = new BackendClient(
    "https://old.test",
    () => new Promise((resolve) => (finish = resolve)),
  );
  const request = client.request("/api/auth/login", {
    method: "POST",
    body: {},
  });
  client.connect("https://new.test");
  finish(Response.json({ session: { access_token: "old-server-secret" } }));
  await assert.rejects(request, /Connection changed/);
  assert.equal(client.session, null);
});
test("Logout clears credentials and invalidates requests from the previous session", async () => {
  let finish;
  const client = new BackendClient("https://trace.test", (url) =>
    url.endsWith("/logout")
      ? Promise.resolve(Response.json({ ok: true }))
      : new Promise((resolve) => (finish = resolve)),
  );
  client.session = { access_token: "a" };
  const pending = client.request("/api/events");
  await client.request("/api/auth/logout", { method: "POST" });
  finish(Response.json({ events: ["private"] }));
  await assert.rejects(pending, /Connection changed/);
  assert.equal(client.session, null);
});
