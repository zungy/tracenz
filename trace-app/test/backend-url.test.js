import test from "node:test";
import assert from "node:assert/strict";
import urls from "../desktop/backend-url.cjs";
test("Backend address accepts a deployed Edge endpoint but rejects raw projects and unsafe destinations", () => {
  assert.equal(
    urls.backendUrl("https://project.supabase.co/functions/v1/trace/"),
    "https://project.supabase.co/functions/v1/trace",
  );
  assert.equal(
    urls.backendUrl("http://127.0.0.1:4318"),
    "http://127.0.0.1:4318",
  );
  for (const value of [
    "https://project.supabase.co",
    "https://user:secret@example.com",
    "https://example.com?token=x",
    "https://example.com/#x",
    "https://example.com/unknown",
    "http://example.com",
    "file:///tmp/test",
  ])
    assert.throws(() => urls.backendUrl(value));
  assert.throws(() =>
    urls.backendUrl("http://127.0.0.1:4318", { allowLocal: false }),
  );
});
