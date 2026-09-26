import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const source = readFileSync(
  new URL("../public/app.js", import.meta.url),
  "utf8",
);
const markup = readFileSync(
  new URL("../public/index.html", import.meta.url),
  "utf8",
);
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
class Node {
  constructor() {
    this.value = "";
    this.textContent = "";
    this.hidden = false;
    this.disabled = false;
    this.open = false;
    this.children = [];
    this.dataset = {};
    this.listeners = new Map();
    const classes = new Set();
    this.classList = {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name),
      toggle: (name, force) =>
        force ? classes.add(name) : classes.delete(name),
    };
  }
  addEventListener(type, callback) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(callback);
    this.listeners.set(type, listeners);
  }
  removeEventListener(type, callback) {
    this.listeners.set(
      type,
      (this.listeners.get(type) || []).filter((fn) => fn !== callback),
    );
  }
  async dispatch(type) {
    await Promise.all(
      (this.listeners.get(type) || []).map((fn) =>
        fn({
          currentTarget: this,
          target: this,
          preventDefault() {},
        }),
      ),
    );
    await flush();
  }
  append(...nodes) {
    this.children.push(...nodes);
  }
  add(node) {
    this.append(node);
  }
  replaceChildren(...nodes) {
    this.children = nodes;
  }
  setAttribute() {}
  removeAttribute() {}
  showModal() {
    this.open = true;
  }
  close() {
    this.open = false;
  }
}
function setup(overrides = {}) {
  const nodes = new Map(
    [...markup.matchAll(/\bid="([^"]+)"/g)].map((match) => [
      `#${match[1]}`,
      new Node(),
    ]),
  );
  nodes.set(".brand", new Node());
  nodes.set("#login-form [type=submit]", new Node());
  const body = new Node();
  const calls = [];
  const model = {
    authenticated: false,
    config: {
      mode: "supabase",
      signupUrl: "https://example.com/signup",
      ai: "openai",
    },
    documents: [],
    events: [],
    ...overrides,
  };
  const request = async (path, options = {}) => {
    calls.push({ path, options });
    if (model.request) {
      const override = model.request(path, options);
      if (override !== undefined) return override;
    }
    if (path === "/api/config") {
      if (model.configError) throw new Error("Network unavailable");
      return model.config;
    }
    if (path === "/api/auth/me") {
      if (!model.authenticated) throw new Error("Sign in required");
      return { id: "account-one", email: "engineer@example.com" };
    }
    if (path === "/api/auth/login") {
      model.authenticated = true;
      return {};
    }
    if (path === "/api/auth/logout") {
      model.authenticated = false;
      return {};
    }
    if (path === "/api/documents") return { documents: model.documents };
    if (path.startsWith("/api/events?"))
      return { events: model.events, nextCursor: null };
    if (path === "/api/forwarding") return { enabled: true, counts: {} };
    throw new Error(`Unexpected request ${path}`);
  };
  const context = vm.createContext({
    window: {
      trace: {
        request,
        generateDesignReport: async (id) => {
          calls.push({ reportId: id });
          return model.generateDesignReport
            ? model.generateDesignReport(id)
            : {
                saved: true,
                checkpointCount: 42,
                missingImageCount: 0,
                provider: "openai",
              };
        },
        connection: async () => ({ version: "0.6.0" }),
        fusionStatus: async () => ({ version: "0.5" }),
      },
    },
    document: {
      body,
      hidden: false,
      createElement: () => new Node(),
      querySelector(selector) {
        if (selector === "dialog[open]")
          return [...nodes.values()].find((node) => node.open);
        if (!nodes.has(selector))
          throw new Error(`Renderer references missing selector: ${selector}`);
        return nodes.get(selector);
      },
      querySelectorAll: () => [],
    },
    Option: class extends Node {
      constructor(text, value) {
        super();
        this.textContent = text;
        this.value = value;
      }
    },
    URLSearchParams,
    Date,
    Map,
    Set,
    setTimeout: () => 1,
    clearTimeout() {},
    setInterval: () => 1,
    clearInterval() {},
  });
  vm.runInContext(
    source +
      "\nglobalThis.renderer = { state, initialize, loadTimeline, loadForwarding, openDesignReport, generateDesignReport, clearState };",
    context,
  );
  return { model, calls, nodes, body, renderer: context.renderer };
}

test("desktop starts at the account gate and displays the real app version", async () => {
  const app = setup();
  await flush();
  assert.equal(app.body.classList.contains("account-gate"), true);
  assert.equal(app.nodes.get("#login-dialog").open, true);
  assert.equal(app.nodes.get("#email").disabled, false);
  assert.equal(app.nodes.get("#auth-toggle").disabled, false);
  assert.equal(app.nodes.get("#auth-retry").hidden, true);
  assert.equal(app.nodes.get("#app-version").textContent, "TRACE / 0.6.0");
  assert.equal(
    app.calls.some(({ path }) => path === "/api/documents"),
    false,
  );
});

test("offline startup stays gated and Retry restores cloud login without a local bypass", async () => {
  const app = setup({ configError: true });
  await flush();
  assert.equal(app.renderer.state.ready, false);
  assert.equal(app.nodes.get("#auth-retry").hidden, false);
  assert.equal(app.nodes.get("#email").disabled, true);
  app.model.configError = false;
  await app.nodes.get("#auth-retry").dispatch("click");
  assert.equal(app.nodes.get("#email").disabled, false);
  assert.equal(app.nodes.get("#login-dialog").open, true);
  assert.equal(app.nodes.has("#local-instead"), false);
  assert.equal(app.nodes.has("#auth-connect-form"), false);
});

test("a local-mode response never opens the desktop workspace", async () => {
  const app = setup({ authenticated: true, config: { mode: "local" } });
  await flush();
  assert.equal(app.renderer.state.ready, false);
  assert.equal(app.nodes.get("#login-dialog").open, true);
  assert.equal(app.nodes.get("#auth-retry").hidden, false);
  assert.equal(
    app.calls.some(({ path }) => path === "/api/auth/me"),
    false,
  );
});

test("signing out clears private data immediately and ignores an older timeline response", async () => {
  const app = setup({ authenticated: true });
  await flush();
  assert.equal(app.renderer.state.ready, true);
  app.renderer.state.documents = [{ id: "private-document" }];
  const timeline = deferred(),
    logout = deferred();
  app.model.request = (path) => {
    if (path.startsWith("/api/events?")) return timeline.promise;
    if (path === "/api/auth/logout") return logout.promise;
  };
  const loading = app.renderer.loadTimeline();
  const signingOut = app.nodes.get("#sign-out").dispatch("click");
  await flush();
  assert.equal(app.nodes.get("#login-dialog").open, true);
  assert.equal(app.renderer.state.documents.length, 0);
  assert.equal(app.renderer.state.events.length, 0);
  assert.equal(app.nodes.get("#account-name").textContent, "Your account");
  timeline.resolve({ events: [{ id: "old-private-event" }], nextCursor: null });
  await loading;
  assert.equal(app.renderer.state.events.length, 0);
  app.model.authenticated = false;
  logout.resolve({});
  await signingOut;
  assert.equal(app.renderer.state.ready, false);
  assert.equal(app.nodes.get("#login-dialog").open, true);
});

test("repeated login submissions cannot overlap account actions", async () => {
  const login = deferred();
  const app = setup({
    request: (path) => (path === "/api/auth/login" ? login.promise : undefined),
  });
  await flush();
  await app.nodes.get("#login-form").dispatch("submit");
  await app.nodes.get("#login-form").dispatch("submit");
  assert.equal(
    app.calls.filter(({ path }) => path === "/api/auth/login").length,
    1,
  );
  assert.equal(app.nodes.get("#auth-toggle").disabled, true);
  app.model.authenticated = true;
  login.resolve({});
  await flush();
  assert.equal(app.renderer.state.ready, true);
  assert.equal(app.nodes.get("#login-dialog").open, false);
  assert.equal(app.nodes.get("#password").value, "");
});

const reportDocuments = [
  {
    id: "document-a",
    name: "Bracket",
    event_count: 42,
    latest_at: "2026-09-26T01:00:00Z",
  },
  {
    id: "document-b",
    name: "Enclosure",
    event_count: 8,
    latest_at: "2026-09-25T01:00:00Z",
  },
];

test("design reports target the selected document regardless of search or loaded traces", async () => {
  const app = setup({ authenticated: true, documents: reportDocuments });
  await flush();
  app.renderer.state.selected = { documentId: "document-b" };
  app.nodes.get("#document-filter").value = "document-a";
  app.nodes.get("#search").value = "one matching hole";
  await app.nodes.get("#design-report").dispatch("click");
  assert.equal(app.nodes.get("#report-dialog").open, true);
  assert.equal(app.nodes.get("#report-document-name").textContent, "Bracket");
  assert.equal(
    app.nodes.get("#report-checkpoint-count").textContent,
    "42 saved checkpoints",
  );
  await app.nodes.get("#report-generate").dispatch("click");
  assert.equal(app.calls.filter((call) => call.reportId).length, 1);
  assert.equal(app.calls.find((call) => call.reportId).reportId, "document-a");
  assert.match(
    app.nodes.get("#report-status").textContent,
    /PDF saved with 42/,
  );
});

test("failed report generation unlocks retry and cancellation does not announce a save", async () => {
  const app = setup({
    authenticated: true,
    documents: reportDocuments,
    generateDesignReport: async () => {
      throw new Error("AI service unavailable");
    },
  });
  await flush();
  app.renderer.openDesignReport("document-a");
  await app.renderer.generateDesignReport();
  assert.equal(
    app.nodes.get("#report-error").textContent,
    "AI service unavailable",
  );
  assert.equal(app.nodes.get("#report-generate").disabled, false);
  app.model.generateDesignReport = async () => ({ canceled: true });
  await app.renderer.generateDesignReport();
  assert.match(app.nodes.get("#report-status").textContent, /Save canceled/);
  assert.equal(app.nodes.get("#report-error").textContent, "");
  assert.equal(app.calls.filter((call) => call.reportId).length, 2);
});

test("report requests cannot overlap and their results are discarded after signout", async () => {
  const pending = deferred();
  const app = setup({
    authenticated: true,
    documents: reportDocuments,
    generateDesignReport: () => pending.promise,
  });
  await flush();
  app.renderer.openDesignReport("document-a");
  const running = app.renderer.generateDesignReport();
  await app.renderer.generateDesignReport();
  assert.equal(app.calls.filter((call) => call.reportId).length, 1);
  app.renderer.clearState();
  pending.resolve({ saved: true, checkpointCount: 42, provider: "openai" });
  await running;
  assert.equal(app.nodes.get("#report-dialog").open, false);
  assert.equal(app.nodes.get("#report-document-name").textContent, "");
  assert.equal(app.nodes.get("#report-status").textContent, "");
  assert.equal(app.nodes.get("#toast").textContent, "");
});
