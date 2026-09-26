const $ = (selector) => document.querySelector(selector);
const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};
const state = {
  config: null,
  documents: [],
  events: [],
  selected: null,
  cursor: null,
  page: "timeline",
  generation: 0,
  detailGeneration: 0,
  connectionEpoch: 0,
  initialization: 0,
  imageCache: new Map(),
  ready: false,
  report: null,
};
const desktop = Boolean(window.trace);
let toastTimer,
  searchTimer,
  poll,
  authBusy = false;
function toast(message) {
  $("#toast").textContent = message;
  $("#toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($("#toast").hidden = true), 4500);
}
function error(message) {
  $("#global-error").textContent = message;
  $("#global-error").hidden = !message;
}
async function api(path, options = {}) {
  if (desktop) return window.trace.request(path, options);
  const response = await fetch(path, {
    method: options.method || "GET",
    headers: { "Content-Type": "application/json" },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Request failed.");
  return data;
}
async function action(button, fn) {
  button.disabled = true;
  try {
    await fn();
  } catch (cause) {
    toast(cause.message);
  } finally {
    button.disabled = false;
  }
}
function setAccountBusy(value) {
  authBusy = value;
  const connected = state.config?.mode === "supabase";
  for (const selector of ["#login-form [type=submit]", "#email", "#password"])
    $(selector).disabled = value || !connected;
  $("#auth-toggle").disabled = value || !state.config?.signupUrl;
  for (const selector of ["#sign-out", "#auth-retry"])
    $(selector).disabled = value;
}
async function accountAction(button, operation) {
  if (authBusy) return;
  setAccountBusy(true);
  try {
    await action(button, operation);
  } finally {
    setAccountBusy(false);
  }
}
const dateTime = (value) =>
  new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
const time = (value) =>
  new Date(value).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
function day(value) {
  const date = new Date(value),
    today = new Date(),
    yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return "TODAY";
  if (date.toDateString() === yesterday.toDateString()) return "YESTERDAY";
  return date
    .toLocaleDateString(undefined, {
      day: "numeric",
      month: "long",
      year: "numeric",
    })
    .toUpperCase();
}
function status(row) {
  if (row.status === "complete")
    return {
      name: row.aiProvider === "template" ? "Change summary" : "AI summary",
      cls: "green",
    };
  if (row.status === "failed") return { name: "Needs attention", cls: "red" };
  return {
    name:
      {
        receiving: "Upload incomplete",
        processing: "Summarizing…",
        pending: "Summary queued",
      }[row.status] || row.status,
    cls: "amber",
  };
}
function title(row) {
  return (
    row.ai?.title ||
    `${row.engineeringChanges[0]?.feature?.name || row.documentName} · checkpoint`
  );
}
function button(text, cls, listener) {
  const node = el("button", cls, text);
  node.type = "button";
  node.addEventListener("click", () => action(node, listener));
  return node;
}
function pill(text, cls = "") {
  return el("span", `pill ${cls}`, text);
}
function navigate(page) {
  state.page = page;
  for (const item of ["timeline", "documents", "connection"])
    $(`#${item}-page`).hidden = item !== page;
  document
    .querySelectorAll("[data-page]")
    .forEach((node) =>
      node.classList.toggle("active", node.dataset.page === page),
    );
  $("#breadcrumb-page").textContent = {
    timeline: "Timeline",
    documents: "Documents",
    connection: "Fusion connection",
  }[page];
  if (page === "documents") renderDocuments();
  if (page === "connection")
    loadSettings().catch((cause) => error(cause.message));
}
document
  .querySelectorAll("[data-page]")
  .forEach((node) =>
    node.addEventListener("click", () => navigate(node.dataset.page)),
  );
$(".brand").addEventListener("click", (event) => {
  event.preventDefault();
  navigate("timeline");
});
async function loadDocuments() {
  const epoch = state.connectionEpoch;
  const result = await api("/api/documents");
  if (epoch !== state.connectionEpoch) return;
  state.documents = result.documents;
  const all = state.documents,
    count = (key) => all.reduce((sum, d) => sum + Number(d[key] || 0), 0);
  $("#stat-events").textContent = count("event_count");
  $("#nav-count").textContent = count("event_count");
  $("#stat-documents").textContent = all.length;
  $("#stat-complete").textContent = count("complete_count");
  $("#stat-latest").textContent = all.length ? dateTime(all[0].latest_at) : "—";
  $("#latest-caption").textContent =
    all[0]?.name || "Your next idea starts here";
  $("#summary-caption").textContent =
    state.config?.ai === "deterministic"
      ? "Recorded change summaries"
      : "Context, without the catch-up";
  const selected = $("#document-filter").value;
  $("#document-filter").replaceChildren(new Option("All documents", ""));
  for (const doc of all)
    $("#document-filter").add(new Option(doc.name, doc.id));
  if (all.some((d) => d.id === selected))
    $("#document-filter").value = selected;
  if (state.page === "documents") renderDocuments();
  updateReportAction();
}
async function loadTimeline({ append = false, quiet = false } = {}) {
  const generation = ++state.generation;
  if (!quiet && !append && !state.events.length)
    $("#timeline-list").replaceChildren(
      el("div", "skeleton"),
      el("div", "skeleton"),
      el("div", "skeleton"),
    );
  const query = new URLSearchParams({ limit: "30" });
  for (const [key, selector] of [
    ["documentId", "#document-filter"],
    ["q", "#search"],
  ])
    if ($(selector).value.trim()) query.set(key, $(selector).value.trim());
  if (append && state.cursor) query.set("cursor", state.cursor);
  const result = await api(`/api/events?${query}`);
  if (generation !== state.generation) return;
  state.events = append
    ? [
        ...state.events,
        ...result.events.filter(
          (row) => !state.events.some((existing) => existing.id === row.id),
        ),
      ]
    : result.events;
  state.cursor = result.nextCursor;
  renderTimeline();
  if (!state.events.length) {
    state.selected = null;
    state.detailGeneration++;
    renderEmptyDetail();
  } else if (!state.events.some((row) => row.id === state.selected?.id))
    await selectEvent(state.events[0].id);
  else {
    const next = state.events.find((row) => row.id === state.selected.id);
    if (
      next.status !== state.selected.status ||
      next.ai?.summary !== state.selected.ai?.summary
    )
      await selectEvent(next.id);
  }
  updateReportAction();
}
function renderTimeline() {
  const list = $("#timeline-list");
  list.replaceChildren();
  $("#result-count").textContent =
    `${state.events.length}${state.cursor ? "+" : ""} checkpoint${state.events.length === 1 ? "" : "s"}`;
  $("#load-more").hidden = !state.cursor;
  if (!state.events.length) {
    const box = el("div", "empty-list");
    const filtered = $("#search").value || $("#document-filter").value;
    box.append(
      el("span", "empty-symbol", "⌁"),
      el(
        "h3",
        "",
        filtered ? "No matching checkpoints" : "Start your design story",
      ),
      el(
        "p",
        "",
        filtered
          ? "Try a different search or clear your filters."
          : "Connect Fusion or import a saved checkpoint. Your design history will appear here.",
      ),
    );
    box.append(
      button(
        filtered ? "Clear filters" : "Connect Fusion →",
        "button secondary",
        async () => {
          if (filtered) {
            $("#search").value = "";
            $("#document-filter").value = "";
            await loadTimeline();
          } else navigate("connection");
        },
      ),
    );
    list.append(box);
    return;
  }
  let previousDay;
  for (const row of state.events) {
    const label = day(row.capturedAt);
    if (previousDay !== label) {
      list.append(el("div", "day-heading", label));
      previousDay = label;
    }
    const card = el(
      "button",
      `event-card${row.id === state.selected?.id ? " selected" : ""}`,
    );
    card.type = "button";
    card.dataset.id = row.id;
    card.setAttribute("aria-pressed", String(row.id === state.selected?.id));
    const copy = el("div", "event-content"),
      meta = el("div", "event-meta");
    meta.append(
      el("span", "", row.documentName),
      el("span", "", "·"),
      el(
        "span",
        "",
        `${row.changeCount} change${row.changeCount === 1 ? "" : "s"}`,
      ),
    );
    const bottom = el("div", "event-bottom"),
      badge = status(row);
    bottom.append(
      pill(badge.name, badge.cls),
      el("span", "event-time", time(row.capturedAt)),
    );
    copy.append(
      el("h3", "", title(row)),
      meta,
      el(
        "p",
        "",
        row.ai?.summary ||
          row.rationale ||
          "Your checkpoint is saved. Its summary is on the way.",
      ),
      bottom,
    );
    card.append(
      el(
        "span",
        "event-glyph",
        row.engineeringChanges[0]?.action?.includes("added") ? "＋" : "↗",
      ),
      copy,
    );
    card.addEventListener("click", () =>
      selectEvent(row.id).catch((cause) => toast(cause.message)),
    );
    list.append(card);
  }
}
function renderEmptyDetail() {
  const panel = $("#detail-panel"),
    box = el("div", "detail-empty");
  box.append(
    el("span", "empty-symbol", "⌁"),
    el("h2", "", "A little context goes a long way."),
    el(
      "p",
      "",
      "Select a checkpoint to explore its changes, rationale, and viewport.",
    ),
  );
  panel.replaceChildren(box);
}
async function imageUrl(id) {
  if (state.imageCache.has(id)) return state.imageCache.get(id);
  const epoch = state.connectionEpoch;
  const url = desktop
    ? await window.trace.image(id)
    : `/api/events/${id}/image`;
  if (epoch !== state.connectionEpoch) throw new Error("Connection changed.");
  if (state.imageCache.size > 12)
    state.imageCache.delete(state.imageCache.keys().next().value);
  state.imageCache.set(id, url);
  return url;
}
async function selectEvent(id) {
  const generation = ++state.detailGeneration;
  const row = await api(`/api/events/${id}`);
  if (generation !== state.detailGeneration) return;
  state.selected = row;
  updateReportAction();
  renderTimeline();
  renderDetail(row);
  try {
    const url = await imageUrl(id);
    if (generation !== state.detailGeneration) return;
    const image = el("img");
    image.alt = `Captured viewport for ${row.documentName}`;
    image.src = url;
    image.addEventListener("click", () => {
      $("#large-image").src = url;
      $("#image-dialog").showModal();
    });
    image.addEventListener("error", () => {
      image.replaceWith(
        el(
          "div",
          "viewport-placeholder",
          "Viewport could not be loaded. Refresh to try again.",
        ),
      );
    });
    $("#viewport-placeholder")?.replaceWith(image);
  } catch (cause) {
    if (generation === state.detailGeneration && $("#viewport-placeholder"))
      $("#viewport-placeholder").textContent = cause.message;
  }
}
function renderDetail(row) {
  const panel = $("#detail-panel");
  panel.replaceChildren();
  const head = el("div", "detail-head"),
    top = el("div", "detail-topline"),
    badge = status(row);
  top.append(pill(row.source), pill(badge.name, badge.cls));
  const meta = el("div", "event-meta");
  meta.append(
    el("span", "", row.documentName),
    el("span", "", "·"),
    el("span", "", dateTime(row.capturedAt)),
  );
  head.append(top, el("h2", "", title(row)), meta);
  const viewport = el("div", "viewport"),
    placeholder = el(
      "div",
      "viewport-placeholder",
      "Loading captured viewport…",
    );
  placeholder.id = "viewport-placeholder";
  viewport.append(
    el(
      "span",
      "viewport-label",
      row.rawEvent?.demo
        ? "ILLUSTRATIVE SAMPLE · NOT A FUSION CAPTURE"
        : "CAPTURED VIEWPORT",
    ),
    placeholder,
    el("span", "viewport-tag", "⤢ Click to expand"),
  );
  panel.append(head, viewport);
  function section(label) {
    const box = el("section", "detail-section");
    box.append(el("h3", "section-label", label));
    panel.append(box);
    return box;
  }
  const summary = section(
    row.aiProvider === "template"
      ? "✧  RECORDED CHANGE SUMMARY"
      : "✧  AI SUMMARY",
  );
  summary.append(
    el(
      "p",
      "summary-text",
      row.ai?.summary ||
        (row.status === "failed"
          ? "Your checkpoint is safe. Summary generation needs another attempt."
          : row.status === "receiving"
            ? "The image upload did not finish. Retry the original Fusion upload."
            : "Checkpoint saved. Trace is preparing its summary."),
    ),
  );
  if (row.error) summary.append(el("p", "form-error", row.error));
  if (row.status === "failed")
    summary.append(
      button("Retry summary", "button secondary", async () => {
        await api(`/api/events/${row.id}/retry-ai`, { method: "POST" });
        toast("Summary queued for another attempt.");
        await loadTimeline();
      }),
    );
  section("ENGINEER’S RATIONALE").append(
    el(
      "blockquote",
      "rationale",
      row.rationale || "No rationale was included with this checkpoint.",
    ),
  );
  const changes = section(
    `WHAT CHANGED  ·  ${row.changeCount} ENGINEERING CHANGE${row.changeCount === 1 ? "" : "S"}`,
  );
  for (const change of row.engineeringChanges) {
    const box = el("div", "change"),
      header = el("div", "change-head");
    header.append(
      el(
        "strong",
        "",
        change.feature?.name || change.component || "Design change",
      ),
      el("span", "", change.action.replaceAll("_", " ")),
    );
    box.append(header);
    const props = [...(change.properties || [])];
    if (change.operation || change.feature?.operation)
      props.unshift({
        name: "Operation",
        value: change.operation || change.feature.operation,
      });
    if (props.length) {
      const table = el("table", "properties");
      for (const property of props) {
        const before = property.oldValue ?? property.before,
          after = property.value ?? property.newValue ?? property.after;
        const value =
          before !== undefined
            ? `${format(before)} → ${format(after)}`
            : format(after);
        const tr = el("tr");
        tr.append(
          el("td", "", property.name || property.parameter || "Property"),
          el("td", "", value),
        );
        table.append(tr);
      }
      box.append(table);
    }
    changes.append(box);
  }
  if (!row.changeCount)
    changes.append(
      el("p", "summary-text", "No normalized changes were included."),
    );
  if (row.ai?.tags?.length) {
    const tags = el("div", "detail-tags");
    row.ai.tags.forEach((tag) => tags.append(pill(tag)));
    changes.append(tags);
  }
  if (row.ai?.notes?.length && row.aiProvider !== "template")
    section("NOTES").append(el("p", "summary-text", row.ai.notes.join(" ")));
  const foot = el("div", "detail-foot");
  foot.append(
    reportButton(row.documentId),
    button("↓ Export source files", "text-button", () =>
      exportDocument(row.documentId),
    ),
    button("Delete checkpoint", "text-button delete", async () => {
      if (
        !(await confirmDelete(
          "Delete this checkpoint?",
          "Its recorded event and viewport will be removed from your history. Retrying the same upload will not restore it.",
        ))
      )
        return;
      await api(`/api/events/${row.id}`, { method: "DELETE" });
      state.selected = null;
      state.imageCache.delete(row.id);
      toast("Checkpoint deleted.");
      await refresh();
    }),
  );
  panel.append(foot);
}
function format(value) {
  return value === undefined
    ? "Changed"
    : typeof value === "object"
      ? JSON.stringify(value)
      : String(value);
}
function confirmDelete(title, text) {
  $("#confirm-title").textContent = title;
  $("#confirm-text").textContent = text;
  $("#confirm-dialog").showModal();
  return new Promise((resolve) => {
    const dialog = $("#confirm-dialog");
    const done = (result) => {
      dialog.close();
      cleanup();
      resolve(result);
    };
    const cancel = (event) => {
      event.preventDefault();
      done(false);
    };
    const no = () => done(false),
      yes = () => done(true);
    function cleanup() {
      $("#confirm-cancel").removeEventListener("click", no);
      $("#confirm-ok").removeEventListener("click", yes);
      dialog.removeEventListener("cancel", cancel);
    }
    $("#confirm-cancel").addEventListener("click", no);
    $("#confirm-ok").addEventListener("click", yes);
    dialog.addEventListener("cancel", cancel);
  });
}
function renderDocuments() {
  const grid = $("#document-grid");
  grid.replaceChildren();
  if (!state.documents.length) {
    grid.append(
      el(
        "div",
        "empty-list",
        "Documents appear here when Fusion sends its first checkpoint.",
      ),
    );
    return;
  }
  for (const doc of state.documents) {
    const card = el("article", "document-card");
    card.append(
      el("span", "document-icon", "▱"),
      el("h2", "", doc.name),
      el("p", "", `${doc.source} · ${doc.event_count} checkpoints`),
      el("p", "", `Last updated ${dateTime(doc.latest_at)}`),
    );
    const actions = el("div", "document-actions");
    actions.append(
      button("Open timeline →", "button primary", async () => {
        $("#document-filter").value = doc.id;
        $("#search").value = "";
        navigate("timeline");
        await loadTimeline();
      }),
      reportButton(doc.id),
      button("Source files", "text-button", () => exportDocument(doc.id)),
    );
    card.append(actions);
    grid.append(card);
  }
}
async function exportDocument(id) {
  if (desktop) {
    const result = await window.trace.exportDocument(id);
    if (!result.canceled)
      toast("Document exported with its JSON and PNG files.");
  } else {
    const response = await fetch(`/api/documents/${id}/export`);
    if (!response.ok) throw new Error((await response.json()).error);
    const url = URL.createObjectURL(await response.blob()),
      link = el("a");
    link.href = url;
    link.download = "trace-export.zip";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast("Export downloaded.");
  }
}
function currentReportDocument() {
  const id = $("#document-filter").value || state.selected?.documentId;
  return state.documents.find((doc) => doc.id === id);
}
function updateReportAction() {
  const current = currentReportDocument();
  const supported =
    desktop && typeof window.trace.generateDesignReport === "function";
  $("#design-report").disabled =
    !state.ready || !current || !supported || Boolean(state.report?.busy);
  $("#design-report").title = current
    ? `Create a PDF report for ${current.name}`
    : "Select a document or checkpoint to create its report.";
  for (const node of document.querySelectorAll("[data-design-report]"))
    if (node.id !== "design-report")
      node.disabled = !supported || !state.ready || Boolean(state.report?.busy);
}
function reportButton(id) {
  const node = button("Design report", "button secondary", () =>
    openDesignReport(id),
  );
  node.dataset.designReport = "";
  node.disabled =
    !desktop ||
    typeof window.trace.generateDesignReport !== "function" ||
    Boolean(state.report?.busy);
  return node;
}
function openDesignReport(id) {
  if (state.report?.busy || !state.ready) return;
  const doc = state.documents.find((item) => item.id === id);
  if (!doc)
    throw new Error("Refresh your documents before generating this report.");
  state.report = {
    id,
    name: doc.name,
    busy: false,
    epoch: state.connectionEpoch,
  };
  $("#report-document-name").textContent = doc.name;
  $("#report-checkpoint-count").textContent =
    `${doc.event_count} saved checkpoint${Number(doc.event_count) === 1 ? "" : "s"}`;
  $("#report-status").textContent =
    "Choose where to save your PDF, then Trace will prepare the report.";
  $("#report-error").textContent = "";
  $("#report-generate").textContent = "Generate PDF";
  $("#report-generate").disabled = false;
  $("#report-dialog").showModal();
}
async function generateDesignReport() {
  const job = state.report;
  if (!job || job.busy || !state.ready) return;
  job.busy = true;
  const current = () =>
    state.report === job && job.epoch === state.connectionEpoch && state.ready;
  $("#report-generate").disabled = true;
  $("#report-generate").textContent = "Generating…";
  $("#report-error").textContent = "";
  $("#report-status").textContent = "Choose a location for your PDF…";
  updateReportAction();
  const unsubscribe = window.trace.onDesignReportProgress?.((progress) => {
    if (!current()) return;
    const messages = {
      preparing: "Reading the full design history and writing your report…",
      images: `Adding screenshots (${progress.completed || 0} of ${progress.total || 0})…`,
      rendering: "Laying out the engineering report…",
      saving: "Saving your PDF…",
    };
    if (messages[progress.stage])
      $("#report-status").textContent = messages[progress.stage];
  });
  try {
    const result = await window.trace.generateDesignReport(job.id);
    if (!current()) return;
    if (result.canceled) {
      $("#report-status").textContent =
        "Save canceled. No report was generated.";
      return;
    }
    if (!result.saved)
      throw new Error("The PDF was not saved. Please try again.");
    const missing = result.missingImageCount
      ? ` ${result.missingImageCount} screenshot${result.missingImageCount === 1 ? " was" : "s were"} unavailable and marked in the report.`
      : "";
    $("#report-status").textContent =
      `PDF saved with ${result.checkpointCount} checkpoints.${missing}${result.provider === "template" ? " This report uses the recorded evidence without an AI-written synthesis." : ""}`;
    toast(`Design report saved for ${job.name}.`);
  } catch (cause) {
    if (!current()) return;
    $("#report-status").textContent =
      "Your checkpoints are unchanged. You can try again.";
    $("#report-error").textContent =
      cause.message || "The report could not be generated.";
  } finally {
    unsubscribe?.();
    job.busy = false;
    if (current()) {
      $("#report-generate").textContent = "Generate PDF";
      $("#report-generate").disabled = false;
      updateReportAction();
    }
  }
}
$("#design-report").addEventListener("click", (event) =>
  action(event.currentTarget, () => {
    const doc = currentReportDocument();
    if (doc) openDesignReport(doc.id);
  }),
);
$("#report-generate").addEventListener("click", generateDesignReport);
$("#report-close").addEventListener("click", () => $("#report-dialog").close());
async function loadFusionStatus() {
  $("#install-fusion").disabled = !desktop;
  if (!desktop) {
    $("#fusion-status").textContent =
      "Open the Trace desktop app to install the Fusion add-in.";
    return;
  }
  const epoch = state.connectionEpoch;
  const result = await window.trace.fusionStatus();
  if (epoch !== state.connectionEpoch || !state.ready) return;
  $("#shortcut-status").textContent =
    result.shortcut?.error ||
    (result.shortcut?.registered
      ? "Shortcut enabled. Update the add-in, then keep Trace running and signed in."
      : "Shortcut unavailable. Use Record Design Change in Fusion.");
  const delivery = result.delivery;
  const live = delivery && Date.now() / 1000 - delivery.updatedAt < 45;
  $("#fusion-status").textContent = !result.version
    ? "Install the add-in to start capturing your design history."
    : !live
      ? "Add-in installed. Start or restart Fusion to connect."
      : `${delivery.connected ? "Fusion is connected" : "Waiting for Fusion to connect"}. ${delivery.queued ? `${delivery.queued} checkpoint${delivery.queued === 1 ? "" : "s"} waiting to send. ` : ""}${delivery.blocked ? `${delivery.blocked} need attention.` : ""}`;
}
$("#install-fusion").addEventListener("click", (event) =>
  action(event.currentTarget, async () => {
    await window.trace.installFusion();
    toast("Add-in installed. Restart Fusion to connect automatically.");
    await loadFusionStatus();
  }),
);
async function loadForwarding() {
  $("#forwarding-settings").hidden = !desktop;
  if (!desktop || !state.ready) return;
  const epoch = state.connectionEpoch;
  const data = await api("/api/forwarding");
  const connection = await window.trace.connection();
  if (epoch !== state.connectionEpoch || !state.ready) return;
  const pending = data.counts.pending || 0;
  const blocked = data.counts.blocked || 0;
  const problem = connection.syncError || data.error;
  $("#forwarding-status").textContent = problem
    ? `Uploads need attention. ${problem}`
    : blocked
      ? `${blocked} checkpoint${blocked === 1 ? "" : "s"} need another upload attempt.`
      : !data.enabled
        ? "Reconnect to save new Fusion checkpoints to your account."
        : pending
          ? `${pending} checkpoint${pending === 1 ? "" : "s"} waiting to upload. Trace will retry automatically.`
          : "Connected. New Fusion checkpoints save to your account automatically.";
  $("#forwarding-resume").hidden = data.enabled && !connection.syncError;
  $("#forwarding-retry").hidden = !blocked;
  $("#sync-warning").textContent =
    problem || blocked
      ? "Some Fusion uploads need attention. Open Fusion connection to retry."
      : !data.enabled
        ? "Fusion uploads are disconnected. Open Fusion connection to reconnect."
        : "";
  $("#sync-warning").hidden = !$("#sync-warning").textContent;
}
$("#forwarding-resume").addEventListener("click", (event) =>
  action(event.currentTarget, async () => {
    await window.trace.resumeSync();
    await loadForwarding();
    toast("Fusion checkpoints will save to your account automatically.");
  }),
);
$("#forwarding-retry").addEventListener("click", (event) =>
  action(event.currentTarget, async () => {
    await api("/api/forwarding/retry", { method: "POST", body: {} });
    await loadForwarding();
    toast("Trace will retry the waiting uploads.");
  }),
);
async function loadSettings() {
  if (!state.ready) return;
  await Promise.all([loadForwarding(), loadFusionStatus()]);
}
function showAccountScreen(message) {
  document.body.classList.add("account-gate");
  if (!$("#login-dialog").open) $("#login-dialog").showModal();
  setAccountBusy(authBusy);
  $("#auth-retry").hidden = state.config?.mode === "supabase";
  $("#auth-message").textContent =
    message ||
    "Log in to see your design history and connect Fusion to your account.";
}
function enterWorkspace() {
  $("#login-dialog").close();
  document.body.classList.remove("account-gate");
}
$("#login-dialog").addEventListener("cancel", (event) =>
  event.preventDefault(),
);
$("#auth-retry").addEventListener("click", (event) =>
  accountAction(event.currentTarget, async () => {
    $("#login-error").textContent = "";
    await initialize();
  }),
);
$("#auth-toggle").addEventListener("click", (event) =>
  accountAction(event.currentTarget, async () => {
    if (desktop) await window.trace.openSignup();
    else {
      const config = await api("/api/config");
      if (!config.signupUrl)
        throw new Error("The signup website has not been configured yet.");
      location.assign(config.signupUrl);
    }
  }),
);
$("#login-form").addEventListener("submit", (event) => {
  event.preventDefault();
  if (authBusy) return;
  setAccountBusy(true);
  api("/api/auth/login", {
    method: "POST",
    body: { email: $("#email").value, password: $("#password").value },
  })
    .then(async (result) => {
      $("#password").value = "";
      $("#login-error").textContent = "";
      await initialize();
      if (result.syncError) {
        $("#sync-warning").textContent =
          `Signed in. Fusion uploads need attention: ${result.syncError}`;
        $("#sync-warning").hidden = false;
      }
    })
    .catch((cause) => {
      $("#login-error").textContent = cause.message;
    })
    .finally(() => {
      setAccountBusy(false);
    });
});
$("#sign-out").addEventListener("click", (event) =>
  accountAction(event.currentTarget, async () => {
    $("#password").value = "";
    clearState();
    showAccountScreen("Signing out…");
    let result;
    try {
      result = await api("/api/auth/logout", { method: "POST" });
    } catch (cause) {
      showAccountScreen(
        "You’re signed out. Check your connection before trying again.",
      );
      $("#login-error").textContent = cause.message;
      return;
    }
    await initialize();
    const warning = [result?.warning, result?.syncError]
      .filter(Boolean)
      .join(" ");
    if (warning) $("#login-error").textContent = warning;
  }),
);
$("#refresh").addEventListener("click", (event) =>
  action(event.currentTarget, () => (state.ready ? refresh() : initialize())),
);
$("#load-more").addEventListener("click", (event) =>
  action(event.currentTarget, () => loadTimeline({ append: true })),
);
$("#search").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(
    () => loadTimeline().catch((cause) => error(cause.message)),
    300,
  );
});
for (const selector of ["#document-filter"])
  $(selector).addEventListener("change", () => {
    updateReportAction();
    loadTimeline().catch((cause) => error(cause.message));
  });
$("#close-image").addEventListener("click", () => $("#image-dialog").close());
$("#import").addEventListener("click", (event) =>
  action(event.currentTarget, async () => {
    if (!desktop) {
      $("#browser-import").click();
      return;
    }
    const result = await window.trace.importCheckpoint();
    if (!result.canceled) {
      toast(
        result.duplicate
          ? "This checkpoint is already in your history."
          : "Checkpoint imported. Summary is on the way.",
      );
      await refresh();
    }
  }),
);
$("#browser-import").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    if (file.size > 12 * 1024 * 1024) throw new Error("File exceeds 12 MB.");
    const result = await api("/api/events", {
      method: "POST",
      body: JSON.parse(await file.text()),
    });
    toast(
      result.duplicate
        ? "Checkpoint already imported."
        : "Checkpoint imported.",
    );
    await refresh();
  } catch (cause) {
    toast(cause.message);
  } finally {
    event.target.value = "";
  }
});
function clearState() {
  state.ready = false;
  state.config = null;
  state.connectionEpoch++;
  state.initialization++;
  state.generation++;
  state.detailGeneration++;
  state.events = [];
  state.documents = [];
  state.selected = null;
  state.cursor = null;
  state.imageCache.clear();
  state.report = null;
  $("#report-dialog").close();
  $("#report-document-name").textContent = "";
  $("#report-checkpoint-count").textContent = "";
  $("#report-status").textContent = "";
  $("#report-error").textContent = "";
  $("#sync-warning").hidden = true;
  $("#timeline-list").replaceChildren();
  $("#document-grid").replaceChildren();
  $("#document-filter").replaceChildren(new Option("All documents", ""));
  $("#search").value = "";
  for (const selector of [
    "#stat-events",
    "#nav-count",
    "#stat-documents",
    "#stat-complete",
  ])
    $(selector).textContent = "0";
  $("#stat-latest").textContent = "—";
  $("#latest-caption").textContent = "Your next idea starts here";
  $("#account-name").textContent = "Your account";
  $("#large-image").removeAttribute("src");
  $("#image-dialog").close();
  renderEmptyDetail();
  updateReportAction();
  clearInterval(poll);
  clearTimeout(searchTimer);
}
async function refresh(quiet = false) {
  const epoch = state.connectionEpoch;
  try {
    await loadDocuments();
    if (epoch !== state.connectionEpoch) return;
    await loadTimeline({ quiet });
    if (epoch !== state.connectionEpoch) return;
    error("");
    $("#connection-dot").classList.remove("offline");
  } catch (cause) {
    if (epoch !== state.connectionEpoch) return;
    error(cause.message);
    $("#connection-dot").classList.add("offline");
    throw cause;
  }
}
async function initialize() {
  clearInterval(poll);
  const initialization = ++state.initialization,
    connectionEpoch = state.connectionEpoch;
  const current = () =>
    initialization === state.initialization &&
    connectionEpoch === state.connectionEpoch;
  try {
    const config = await api("/api/config");
    if (!current()) return;
    if (config.mode !== "supabase")
      throw new Error("Trace could not reach your account. Please try again.");
    state.config = config;
    $("#connection-label").textContent = "Connected";
    $("#account-mode").textContent = "Trace account";
    $("#connection-dot").classList.remove("offline");
    if (desktop) {
      const connection = await window.trace.connection();
      if (!current()) return;
      if (connection.version)
        $("#app-version").textContent = `TRACE / ${connection.version}`;
    }
    let user;
    try {
      user = await api("/api/auth/me");
    } catch {
      if (!current()) return;
      if (state.ready || state.events.length || state.documents.length) {
        clearState();
        state.config = config;
      }
      showAccountScreen();
      return;
    }
    if (!current()) return;
    $("#account-name").textContent = user.email || "Your account";
    $("#sign-out").hidden = false;
    enterWorkspace();
    state.ready = true;
    await refresh();
    if (!current()) return;
    if (desktop) {
      try {
        await loadForwarding();
      } catch {
        if (!current()) return;
        $("#sync-warning").textContent =
          "Your timeline is available. Open Fusion connection to reconnect uploads.";
        $("#sync-warning").hidden = false;
      }
    }
    if (state.page === "connection") await loadSettings();
    if (!current()) return;
    poll = setInterval(() => {
      if (state.page === "connection" && state.ready) {
        loadSettings().catch((cause) => error(cause.message));
      }
      // Preserve loaded older pages. Explicit refresh always returns to the latest.
      if (
        !document.hidden &&
        state.ready &&
        state.events.length <= 30 &&
        !document.querySelector("dialog[open]")
      )
        refresh(true).catch(() => {});
    }, 6000);
  } catch (cause) {
    if (!current()) return;
    state.ready = false;
    if (document.body.classList.contains("account-gate")) {
      state.config = null;
      showAccountScreen(
        "Trace is unavailable. Check your internet connection, then try again.",
      );
      $("#login-error").textContent = cause.message;
    } else {
      error(
        "Trace could not refresh your history. Check your internet connection and try again.",
      );
    }
    $("#connection-label").textContent = "Connection unavailable";
    $("#connection-dot").classList.add("offline");
  }
}
showAccountScreen("Connecting to your account…");
initialize();
