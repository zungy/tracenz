import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { LocalStore } from "../server/local-store.js";
import { Forwarding } from "../server/forwarding.js";
import { demoEnvelopes } from "../server/demo.js";
import { validateEnvelope } from "../server/domain.js";
const { CloudPairing, CredentialVault } = createRequire(import.meta.url)(
  "../desktop/pairing.cjs",
);

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "trace-pair-"));
  const store = new LocalStore(directory);
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const forward = new Forwarding(store);
  let user = randomUUID(),
    records = {},
    created = 0;
  const tokens = new Map();
  const cloud = {
    origin: "https://trace.test",
    async request(path, options = {}) {
      if (path === "/api/auth/me") return { id: user };
      if (path === "/api/tokens" && options.method === "POST") {
        const value = {
          id: randomUUID(),
          token: "trc_" + String(++created).repeat(43),
        };
        tokens.set(value.id, { ...value, user });
        return value;
      }
      if (path === "/api/tokens")
        return {
          tokens: [...tokens.values()].filter((item) => item.user === user),
        };
      throw Error("Unexpected cloud request " + path);
    },
  };
  const local = {
    async request(path, options = {}) {
      assert.equal(
        path,
        "/api/forwarding",
        "automatic pairing never requests backfill",
      );
      return options.method === "POST"
        ? forward.save(options.body)
        : forward.status();
    },
  };
  const vault = {
    async read() {
      return structuredClone(records);
    },
    async write(value) {
      records = structuredClone(value);
    },
  };
  const pairing = new CloudPairing({ cloud, local, vault });
  return {
    store,
    forward,
    pairing,
    cloud,
    local,
    vault,
    tokens,
    get user() {
      return user;
    },
    set user(value) {
      user = value;
    },
    get created() {
      return created;
    },
  };
}

test("Desktop login preserves local evidence, resumes same-account queue and isolates another account", async (t) => {
  const f = await fixture(t),
    owner = randomUUID(),
    envelopes = demoEnvelopes();
  await f.store.ingest(owner, validateEnvelope(envelopes[0]));
  assert.deepEqual(await f.pairing.pair(), { ok: true });
  assert.deepEqual(
    f.forward.status().counts,
    {},
    "existing evidence stays local",
  );
  await f.store.ingest(owner, validateEnvelope(envelopes[1]));
  const firstDestination = f.forward.config().destination,
    firstUser = f.user;
  assert.equal(f.forward.status().counts.pending, 1);
  await f.pairing.pause();
  assert.equal(f.forward.status().enabled, false);
  await f.store.ingest(owner, validateEnvelope(envelopes[2]));
  await f.pairing.pair();
  assert.equal(f.created, 1, "same user reuses upload token");
  assert.equal(f.forward.config().destination, firstDestination);
  assert.equal(
    f.forward.status().counts.pending,
    1,
    "offline local-only capture does not become shared implicitly",
  );
  await f.pairing.pause();
  f.user = randomUUID();
  await f.pairing.pair();
  assert.equal(f.created, 2);
  assert.notEqual(f.forward.config().destination, firstDestination);
  assert.deepEqual(
    f.forward.status().counts,
    {},
    "earlier user's queue never transfers",
  );
  await f.store.ingest(owner, validateEnvelope(envelopes[3]));
  assert.equal(f.forward.status().counts.pending, 1);
  f.user = firstUser;
  await f.pairing.pair();
  assert.equal(f.forward.config().destination, firstDestination);
  assert.equal(f.forward.status().counts.pending, 1);
  assert.equal(f.created, 2);
});

test("Token revocation preserves its queued destination and fails visibly; failed pairing stays paused", async (t) => {
  const f = await fixture(t);
  await f.pairing.pair();
  const oldDestination = f.forward.config().destination;
  [...f.tokens.values()][0].revoked_at = new Date().toISOString();
  await assert.rejects(f.pairing.pair(), /connection was revoked/);
  assert.equal(f.created, 1);
  assert.equal(f.forward.status().enabled, false);
  assert.equal(f.forward.config().destination, oldDestination);
  f.vault.read = async () => {
    throw Error("Credential storage unavailable");
  };
  await assert.rejects(f.pairing.pair(), /Credential storage unavailable/);
  assert.equal(f.forward.status().enabled, false);
  assert.equal(f.pairing.error, "Credential storage unavailable");
});

test("Cloud login succeeds with a visible warning when the local receiver is offline", async () => {
  const calls = [],
    cloud = {
      origin: "https://trace.test",
      async request(path) {
        calls.push(path);
        return { user: { id: randomUUID() } };
      },
    };
  const pairing = new CloudPairing({
    cloud,
    local: {
      request: async () => {
        throw Error("offline");
      },
    },
    vault: {
      read: async () => {
        throw Error("must not enable pairing");
      },
    },
  });
  const result = await pairing.login({
    email: "test@example.test",
    password: "private",
  });
  assert.ok(result.user.id);
  assert.match(result.syncError, /pause could not be confirmed/);
  assert.deepEqual(calls, ["/api/auth/login"]);
});

test("Logout always clears the main session when local pause and cloud revocation both fail", async () => {
  let cleared = 0,
    revokeAttempted = 0;
  const cloud = {
    origin: "https://trace.test",
    session: { access_token: "private" },
    async request(path) {
      assert.equal(path, "/api/auth/logout");
      revokeAttempted++;
      throw Error("offline");
    },
    connect(origin) {
      assert.equal(origin, this.origin);
      this.session = null;
      cleared++;
    },
  };
  const pairing = new CloudPairing({
    cloud,
    local: {
      request: async () => {
        throw Error("offline");
      },
    },
    vault: {},
  });
  const result = await pairing.logout();
  assert.equal(result.ok, true);
  assert.match(result.warning, /Signed out on this computer/);
  assert.match(result.syncError, /pause could not be confirmed/);
  assert.equal(cloud.session, null);
  assert.equal(cleared, 1);
  assert.equal(revokeAttempted, 1);
});

test("Desktop credentials are encrypted at rest and unavailable encryption fails closed", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "trace-vault-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const encryption = {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(value).map((b) => b ^ 0xa5),
    decryptString: (value) => value.map((b) => b ^ 0xa5).toString(),
  };
  const path = join(directory, "credentials.bin"),
    vault = new CredentialVault(path, encryption);
  assert.deepEqual(await vault.read(), {});
  await vault.write({ example: { token: "trc_private_test_token" } });
  assert.equal(
    (await readFile(path)).includes("trc_private_test_token"),
    false,
  );
  assert.equal((await vault.read()).example.token, "trc_private_test_token");
  encryption.isEncryptionAvailable = () => false;
  await assert.rejects(vault.write({}), /protection is unavailable/);
  await assert.rejects(vault.read(), /protection is unavailable/);
});
