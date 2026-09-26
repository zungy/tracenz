import test from 'node:test';
import assert from 'node:assert/strict';
import { createTraceClient } from '../src/lib/trace-client.ts';
import { createSessionStorage, TRACE_API_URL } from '../src/lib/supabase.ts';

const user = { id: 'account-a', email: 'demo@example.test' };
const initial = { access_token: 'first', refresh_token: 'refresh', user };
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture(fetcher) {
  let stored = initial;
  let callback;
  let refreshCalls = 0;
  let logoutCalls = 0;
  let clearCalls = 0;
  let rememberValue;
  const auth = {
    onAuthStateChange(fn) {
      callback = fn;
      fn('INITIAL_SESSION', stored);
    },
    async getSession() {
      return { data: { session: stored }, error: null };
    },
    async refreshSession() {
      refreshCalls++;
      stored = { ...initial, access_token: 'renewed' };
      callback('TOKEN_REFRESHED', stored);
      return { data: { session: stored }, error: null };
    },
    async signOut(options) {
      assert.deepEqual(options, { scope: 'local' });
      logoutCalls++;
      stored = null;
      callback('SIGNED_OUT', null);
      return { error: null };
    },
    async signInWithPassword(credentials) {
      assert.equal(credentials.email, user.email);
      stored = initial;
      callback('SIGNED_IN', stored);
      return { data: { user, session: stored }, error: null };
    },
    async signUp(credentials) {
      assert.deepEqual(credentials.options.data, { full_name: 'Demo Account' });
      stored = initial;
      callback('SIGNED_IN', stored);
      return { data: { user, session: stored }, error: null };
    },
  };
  const client = createTraceClient(
    { auth },
    fetcher,
    (value) => {
      rememberValue = value;
    },
    () => {
      clearCalls++;
    },
  );
  return {
    client,
    auth,
    emit(event, value) {
      stored = value;
      callback(event, value);
    },
    get refreshCalls() {
      return refreshCalls;
    },
    get logoutCalls() {
      return logoutCalls;
    },
    get clearCalls() {
      return clearCalls;
    },
    get rememberValue() {
      return rememberValue;
    },
  };
}

test('private JSON and binary requests carry auth and never use browser cookies/cache', async () => {
  const f = fixture(async (url, options) => {
    assert.equal(url.startsWith(TRACE_API_URL + '/api/'), true);
    assert.equal(options.headers.get('Authorization'), 'Bearer first');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.cache, 'no-store');
    assert.equal(options.redirect, 'error');
    return url.endsWith('/image') ? new Response('png') : json({ documents: [] });
  });
  assert.deepEqual(await f.client.api('/api/documents'), { documents: [] });
  assert.equal(await (await f.client.apiBlob('/api/events/id/image')).text(), 'png');
});

test('web wrapper rejects foreign URLs, traversal and writes before sending tokens', async () => {
  const f = fixture(() => {
    throw new Error('Must not fetch');
  });
  for (const path of [
    'https://example.test/api/events',
    '//example.test/api/events',
    '/api/../other',
    '/api/events#secret',
  ]) {
    await assert.rejects(f.client.api(path), { status: 400 });
  }
  await assert.rejects(f.client.api('/api/events', { method: 'DELETE' }), { status: 405 });
});

test('concurrent unauthorized reads share one refresh and retry with renewed token', async () => {
  const gate = deferred();
  const f = fixture(async (_url, options) =>
    options.headers.get('Authorization') === 'Bearer first'
      ? json({ error: 'Expired' }, 401)
      : json({ ok: true }),
  );
  const original = f.auth.refreshSession;
  f.auth.refreshSession = async () => {
    await gate.promise;
    return original();
  };
  const reads = [f.client.api('/api/documents'), f.client.api('/api/events')];
  await new Promise((resolve) => setImmediate(resolve));
  gate.resolve();
  assert.deepEqual(await Promise.all(reads), [{ ok: true }, { ok: true }]);
  assert.equal(f.refreshCalls, 1);
});

test('a late response is discarded after logout and listeners clear immediately', async () => {
  const gate = deferred();
  const f = fixture(async () => gate.promise);
  const seen = [];
  f.client.onSessionChange((account) => seen.push(account));
  const pending = f.client.api('/api/events');
  await new Promise((resolve) => setImmediate(resolve));
  await f.client.signOut();
  assert.equal(seen[0], null);
  gate.resolve(json({ events: ['private'] }));
  await assert.rejects(pending, { status: 401 });
  assert.equal(await f.client.getUser(), null);
  assert.equal(f.clearCalls, 1);
});

test('account changes invalidate old in-flight data even when both accounts are logged in', async () => {
  const gate = deferred();
  const f = fixture(async () => gate.promise);
  const pending = f.client.api('/api/events');
  await new Promise((resolve) => setImmediate(resolve));
  f.emit('SIGNED_IN', { ...initial, user: { id: 'account-b' } });
  gate.resolve(json({ events: ['account-a'] }));
  await assert.rejects(pending, { status: 401 });
});

test('logout wins over a pending sign-in', async () => {
  const gate = deferred();
  const f = fixture(async () => json(user));
  f.auth.signInWithPassword = async () => gate.promise;
  const pending = f.client.signIn(user.email, 'password');
  await f.client.signOut();
  gate.resolve({ data: { user, session: initial }, error: null });
  await assert.rejects(pending, { status: 401 });
});

test('a network error during sign-out still clears stored credentials and blocks reads', async () => {
  const f = fixture(async () => json(user));
  f.auth.signOut = async () => {
    throw new TypeError('Offline');
  };
  await assert.rejects(f.client.signOut(), /Offline/);
  assert.equal(f.clearCalls, 1);
  assert.equal(await f.client.getUser(), null);
});

test('signup with immediate confirmation revokes only its browser session', async () => {
  const f = fixture(async () => json(user));
  assert.deepEqual(await f.client.signUp(' Demo Account ', ' demo@example.test ', 'password'), {
    confirmationRequired: false,
  });
  assert.equal(f.logoutCalls, 1);
  assert.equal(f.clearCalls, 1);
});

test('signup requiring confirmation does not claim a session or perform logout', async () => {
  const f = fixture(async () => json(user));
  f.auth.signUp = async () => ({ data: { user, session: null }, error: null });
  assert.deepEqual(await f.client.signUp('Demo Account', user.email, 'password'), {
    confirmationRequired: true,
  });
  assert.equal(f.logoutCalls, 0);
});

test('remember option reaches storage and sign-in trims email only', async () => {
  const f = fixture(async () => json(user));
  assert.deepEqual(await f.client.signIn(' demo@example.test ', ' password ', true), user);
  assert.equal(f.rememberValue, true);
});

test('abort signals reach fetch and permission errors retain useful status', async () => {
  const controller = new AbortController();
  const f = fixture(async (_url, options) => {
    assert.equal(options.signal.aborted, true);
    throw options.signal.reason;
  });
  controller.abort();
  await assert.rejects(f.client.api('/api/events', { signal: controller.signal }), {
    name: 'AbortError',
  });
  const denied = fixture(async () => json({ error: 'Not found' }, 404));
  await assert.rejects(denied.client.api('/api/events/unknown'), {
    message: 'Not found',
    status: 404,
  });
});

test('session storage is default; remember explicitly uses persistent storage', () => {
  function memory() {
    const rows = new Map();
    return {
      getItem: (key) => rows.get(key) ?? null,
      setItem: (key, value) => rows.set(key, value),
      removeItem: (key) => rows.delete(key),
    };
  }
  const session = memory();
  const local = memory();
  const storage = createSessionStorage(session, local);
  storage.setItem('trace-web-auth', 'session');
  assert.equal(session.getItem('trace-web-auth'), 'session');
  assert.equal(local.getItem('trace-web-auth'), null);
  storage.setRemember(true);
  storage.setItem('trace-web-auth', 'remembered');
  assert.equal(session.getItem('trace-web-auth'), null);
  assert.equal(local.getItem('trace-web-auth'), 'remembered');
  assert.equal(createSessionStorage(session, local).getItem('trace-web-auth'), 'remembered');
  storage.removeItem('trace-web-auth');
  assert.equal(local.getItem('trace-web-auth'), null);
});
