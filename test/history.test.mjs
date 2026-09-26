import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const markup = readFileSync(new URL('../src/pages/app.astro', import.meta.url), 'utf8');
const source = ts.transpile(
  readFileSync(new URL('../src/scripts/history.ts', import.meta.url), 'utf8').replace(
    /^import .*?;\s*/m,
    '',
  ),
  { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
);
const flush = async () => {
  for (let n = 0; n < 40; n++) await Promise.resolve();
};
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const documentId = '11111111-1111-4111-8111-111111111111';
const eventId = '22222222-2222-4222-8222-222222222222';
const doc = {
  id: documentId,
  name: 'Mounting bracket',
  source: 'Autodesk Fusion',
  event_count: 1,
  complete_count: 1,
  pending_count: 0,
  failed_count: 0,
  latest_at: '2026-09-26T06:00:00Z',
};
const checkpoint = {
  id: eventId,
  documentId,
  documentName: doc.name,
  capturedAt: doc.latest_at,
  source: doc.source,
  status: 'complete',
  ai: { title: 'Widened mounting plate', summary: 'Increased width for the mounting holes.' },
  rationale: 'Allow clearance for the fixture.',
  engineeringChanges: [
    {
      action: 'parameter_changed',
      feature: { name: 'Base extrusion' },
      properties: [{ name: 'Width', before: '20 mm', after: '30 mm' }],
    },
  ],
  changeCount: 1,
};

function setup(overrides = {}) {
  const ids = new Map();
  const all = new Set();
  class Element {
    constructor(tag = 'div') {
      this.tag = tag;
      this.children = [];
      this.listeners = new Map();
      this.attributes = {};
      this.dataset = {};
      this.hidden = false;
      this.value = '';
      this.open = false;
      this.disabled = false;
      this._text = '';
      all.add(this);
    }
    set id(value) {
      this._id = value;
      ids.set(value, this);
    }
    get id() {
      return this._id;
    }
    set textContent(value) {
      this._text = String(value);
      this.children = [];
    }
    get textContent() {
      return this._text + this.children.map((child) => child.textContent || '').join('');
    }
    append(...children) {
      for (const child of children) {
        child.parent = this;
        this.children.push(child);
      }
    }
    replaceChildren(...children) {
      this._text = '';
      this.children = [];
      this.append(...children);
    }
    replaceWith(child) {
      if (this.parent) {
        this.parent.children[this.parent.children.indexOf(this)] = child;
        child.parent = this.parent;
      }
    }
    remove() {
      if (this.parent)
        this.parent.children = this.parent.children.filter((child) => child !== this);
    }
    setAttribute(key, value) {
      this.attributes[key] = value;
    }
    removeAttribute(key) {
      delete this.attributes[key];
      if (key === 'src') this.src = undefined;
    }
    addEventListener(type, handler) {
      const handlers = this.listeners.get(type) || [];
      handlers.push(handler);
      this.listeners.set(type, handlers);
    }
    async dispatch(type) {
      for (const handler of this.listeners.get(type) || [])
        await handler({ target: this, currentTarget: this });
      await flush();
    }
    click() {
      this.clicked = true;
    }
    focus() {
      this.focused = true;
    }
    close() {
      this.open = false;
    }
    showModal() {
      this.open = true;
    }
    querySelector(tag) {
      return this.children.find((child) => child.tag === tag);
    }
  }
  for (const [, id] of markup.matchAll(/\bid="([^"]+)"/g)) {
    const node = new Element();
    node.id = id;
  }
  ids.get('history-gate').append(new Element('h1'), new Element('p'));
  const calls = [],
    redirects = [],
    created = [],
    revoked = [],
    listeners = new Map();
  const model = {
    user: { id: 'account-one', email: 'demo@example.test' },
    documents: [{ ...doc }],
    events: [checkpoint],
    nextCursor: null,
    ...overrides,
  };
  let onSession;
  const request = async (path, options = {}) => {
    calls.push({ path, options });
    const replacement = model.request?.(path, options);
    if (replacement !== undefined) return replacement;
    if (path === '/api/documents') return { documents: model.documents };
    if (path.startsWith('/api/events?'))
      return { events: model.events, nextCursor: model.nextCursor };
    if (path === `/api/events/${eventId}`) return checkpoint;
    if (path.endsWith('/image')) return new Blob(['png'], { type: 'image/png' });
    if (path.endsWith('/export')) return new Blob(['zip'], { type: 'application/zip' });
    throw new Error(`Unexpected request ${path}`);
  };
  const location = { search: '', replace: (url) => redirects.push(url), reload() {} };
  const context = vm.createContext({
    api: request,
    apiBlob: request,
    getUser: async () => model.user,
    onSessionChange: (fn) => {
      onSession = fn;
      return () => {};
    },
    signOut: async () => {
      model.user = null;
      onSession(null);
    },
    document: {
      hidden: false,
      body: new Element('body'),
      title: '',
      getElementById: (id) => ids.get(id),
      createElement: (tag) => new Element(tag),
      querySelectorAll: () => [...all].filter((node) => node.dataset.checkpoint),
    },
    location,
    history: {
      pushState: (_state, _unused, url) => {
        location.search = new URL(url, 'https://trace.test').search;
      },
      replaceState: (_state, _unused, url) => {
        location.search = new URL(url, 'https://trace.test').search;
      },
    },
    window: {
      setTimeout: () => 1,
      clearTimeout() {},
      setInterval: () => 1,
      clearInterval() {},
      addEventListener: (name, handler) => listeners.set(name, handler),
    },
    URL: {
      createObjectURL: () => {
        const url = `blob:test-${created.length}`;
        created.push(url);
        return url;
      },
      revokeObjectURL: (url) => revoked.push(url),
    },
    URLSearchParams,
    AbortController,
    Blob,
    Date,
    Error,
    Set,
    Map,
    matchMedia: () => ({ matches: false }),
  });
  vm.runInContext(
    source +
      '\nglobalThis.inspect = { openRoute, loadDocuments, loadCheckpoints, selectCheckpoint, downloadDocument, get state() { return { ready, documents, checkpoints, selectedCheckpoint }; } };',
    context,
  );
  return {
    model,
    calls,
    ids,
    redirects,
    created,
    revoked,
    listeners,
    location,
    app: context.inspect,
    session: (user) => onSession(user),
  };
}

test('unauthenticated visits redirect before any design request', async () => {
  const view = setup({ user: null });
  await flush();
  assert.deepEqual(view.redirects, ['/login?next=%2Fapp']);
  assert.equal(view.calls.length, 0);
  assert.equal(view.ids.get('history-content').hidden, true);
});

test('documents are the initial view and a chosen design opens its recorded context', async () => {
  const view = setup();
  await flush();
  assert.equal(view.ids.get('documents-view').hidden, false);
  assert.equal(view.ids.get('timeline-view').hidden, true);
  assert.equal(
    view.calls.some(({ path }) => path.startsWith('/api/events')),
    false,
  );
  await view.ids.get('document-grid').children[0].dispatch('click');
  assert.equal(view.location.search, `?document=${documentId}`);
  assert.equal(view.ids.get('documents-view').hidden, true);
  assert.match(view.ids.get('checkpoint-detail').textContent, /Allow clearance for the fixture/);
  assert.match(view.ids.get('checkpoint-detail').textContent, /20 mm → 30 mm/);
  assert.equal(view.created.length, 1);
});

test('late timeline and image responses cannot repopulate history after logout', async () => {
  const view = setup();
  await flush();
  const delayedImage = deferred();
  view.model.request = (path) => (path.endsWith('/image') ? delayedImage.promise : undefined);
  await view.ids.get('document-grid').children[0].dispatch('click');
  assert.match(view.ids.get('checkpoint-detail').textContent, /Widened mounting plate/);
  const delayedTimeline = deferred();
  view.model.request = (path) =>
    path.startsWith('/api/events?')
      ? delayedTimeline.promise
      : path.endsWith('/image')
        ? delayedImage.promise
        : undefined;
  const loading = view.app.loadCheckpoints();
  await view.ids.get('history-signout').dispatch('click');
  delayedTimeline.resolve({ events: [checkpoint], nextCursor: null });
  delayedImage.resolve(new Blob(['private image'], { type: 'image/png' }));
  await loading;
  await flush();
  assert.equal(view.app.state.ready, false);
  assert.equal(view.app.state.checkpoints.length, 0);
  assert.equal(view.ids.get('checkpoint-detail').textContent, '');
  assert.equal(view.created.length, 0);
  assert.equal(view.ids.get('history-email').textContent, '');
  assert.equal(view.calls.find(({ path }) => path.endsWith('/image')).options.signal.aborted, true);
});

test('metadata polling preserves loaded pages and flags changed document history', async () => {
  const view = setup({ nextCursor: 'page-two' });
  await flush();
  await view.ids.get('document-grid').children[0].dispatch('click');
  view.model.events = [{ ...checkpoint, id: '33333333-3333-4333-8333-333333333333' }];
  view.model.nextCursor = null;
  await view.app.loadCheckpoints(true);
  assert.equal(view.app.state.checkpoints.length, 2);
  const selected = view.app.state.selectedCheckpoint;
  const requestsBefore = view.calls.length;
  view.model.documents = [{ ...doc, event_count: 3, latest_at: '2026-09-26T09:00:00Z' }];
  await view.app.loadDocuments(true);
  assert.equal(view.app.state.checkpoints.length, 2);
  assert.equal(view.app.state.selectedCheckpoint, selected);
  assert.equal(view.ids.get('history-updates').hidden, false);
  assert.equal(view.calls.length, requestsBefore + 1);
});

test('downloads use the authenticated document endpoint and logout revokes all private blobs', async () => {
  const view = setup();
  await flush();
  await view.ids.get('document-grid').children[0].dispatch('click');
  await view.app.downloadDocument();
  assert.ok(
    view.calls.some(
      ({ path, options }) => path === `/api/documents/${documentId}/export` && !options.method,
    ),
  );
  assert.equal(view.created.length, 2);
  await view.ids.get('history-signout').dispatch('click');
  for (const url of view.created) assert.ok(view.revoked.includes(url));
  assert.equal(view.ids.get('history-content').hidden, true);
});

test('a failed documents request shows an error rather than an empty account', async () => {
  const view = setup({
    request: (path) =>
      path === '/api/documents' ? Promise.reject(new Error('Network unavailable')) : undefined,
  });
  await flush();
  assert.equal(view.ids.get('documents-error').hidden, false);
  assert.match(view.ids.get('document-grid').textContent, /temporarily unavailable/);
  assert.doesNotMatch(view.ids.get('document-grid').textContent, /Your next design/);
});

test('switching accounts clears the current page and revalidates from a fresh route', async () => {
  const view = setup();
  await flush();
  await view.ids.get('document-grid').children[0].dispatch('click');
  view.session({ id: 'account-two', email: 'second@example.test' });
  assert.equal(view.ids.get('history-content').hidden, true);
  assert.equal(view.ids.get('checkpoint-detail').textContent, '');
  assert.equal(view.app.state.documents.length, 0);
  assert.equal(view.redirects.at(-1), '/app');
});
