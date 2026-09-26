import assert from "node:assert/strict";
import { test } from "node:test";
import policy from "../desktop/renderer-policy.cjs";
const { allowedRequest } = policy;
const id = "12345678-1234-4234-9234-123456789abc";

test("Desktop bridge permits account and design operations", () => {
  for (const path of [
    "/api/config",
    "/api/auth/me",
    "/api/documents",
    "/api/forwarding",
    "/api/events?limit=30&q=hole",
    `/api/events/${id}`,
  ])
    assert.equal(allowedRequest(path), true, path);
  for (const path of [
    "/api/auth/login",
    "/api/auth/logout",
    "/api/events",
    "/api/forwarding/retry",
    `/api/events/${id}/retry-ai`,
  ])
    assert.equal(allowedRequest(path, "POST"), true, path);
  assert.equal(allowedRequest(`/api/events/${id}`, "DELETE"), true);
});

test("Desktop bridge rejects setup, testing, arbitrary paths and unsupported methods", () => {
  for (const path of [
    "/api/demo",
    "/api/tokens",
    "/api/auth/signup",
    "/api/forwarding/backfill",
    "/api/events/../../tokens",
    "/api/worker",
    "https://example.com/api/events",
    "/api/events#test",
    "/api/events/not-an-id",
    null,
    {},
  ])
    for (const method of ["GET", "POST", "DELETE"])
      assert.equal(allowedRequest(path, method), false, `${method} ${path}`);
  for (const method of ["POST", "DELETE", "PATCH", "PUT"])
    assert.equal(allowedRequest("/api/forwarding", method), false);
  assert.equal(allowedRequest("/api/events", "DELETE"), false);
  assert.equal(allowedRequest("/api/config", "POST"), false);
});

test("Queries and case changes cannot bypass serialized account or upload operations", () => {
  for (const path of [
    "/api/auth/login?x=1",
    "/api/auth/logout?x=1",
    "/api/auth/login?",
    "/api/AUTH/login",
    "/API/auth/logout",
    "/api/forwarding/retry?x=1",
  ])
    assert.equal(allowedRequest(path, "POST"), false, path);
  assert.equal(allowedRequest("/api/forwarding?x=1"), false);
  assert.equal(allowedRequest("/api/events?limit=30&q=bracket"), true);
});
