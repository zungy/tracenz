import { api, apiBlob, getUser, onSessionChange, signOut } from '../lib/trace-client';

type DesignDocument = {
  id: string;
  name: string;
  source: string;
  event_count: number;
  latest_at: string;
  complete_count: number;
  pending_count: number;
  failed_count: number;
};
type ChangeProperty = {
  name?: string;
  parameter?: string;
  oldValue?: unknown;
  before?: unknown;
  value?: unknown;
  newValue?: unknown;
  after?: unknown;
};
type EngineeringChange = {
  action: string;
  feature?: { name?: string; operation?: string };
  component?: string;
  operation?: string;
  properties?: ChangeProperty[];
};
type Checkpoint = {
  id: string;
  documentId: string;
  documentName: string;
  capturedAt: string;
  source: string;
  status: string;
  ai?: { title?: string; summary?: string; tags?: string[]; notes?: string[] } | null;
  aiProvider?: string;
  rationale?: string;
  engineeringChanges: EngineeringChange[];
  changeCount: number;
  rawEvent?: { demo?: boolean };
};

const element = <T extends HTMLElement = HTMLElement>(id: string) => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing history element: ${id}`);
  return node as T;
};
const node = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = '',
  text?: string,
): HTMLElementTagNameMap[K] => {
  const result = document.createElement(tag);
  result.className = className;
  if (text !== undefined) result.textContent = text;
  return result;
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const date = (value: string, withTime = false) => {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return 'Date unavailable';
  return parsed.toLocaleString(
    undefined,
    withTime
      ? { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }
      : { year: 'numeric', month: 'short', day: 'numeric' },
  );
};
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
const displayValue = (value: unknown): string =>
  value === undefined
    ? 'Changed'
    : typeof value === 'object'
      ? JSON.stringify(value)
      : String(value);
const checkpointTitle = (row: Checkpoint) =>
  row.ai?.title || `${row.engineeringChanges[0]?.feature?.name || row.documentName} · checkpoint`;
const checkpointStatus = (row: Checkpoint) => {
  if (row.status === 'complete')
    return row.aiProvider === 'template' ? 'Change summary' : 'AI summary';
  return (
    (
      {
        pending: 'Summary queued',
        processing: 'Summarizing',
        receiving: 'Upload incomplete',
        failed: 'Summary unavailable',
      } as Record<string, string>
    )[row.status] || 'Checkpoint saved'
  );
};
const aborted = (error: unknown) => error instanceof Error && error.name === 'AbortError';
const unauthorized = (error: unknown) =>
  typeof error === 'object' && error !== null && 'status' in error && error.status === 401;
const message = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback;

let userId: string | null = null;
let epoch = 0;
let ready = false;
let routeInitialized = false;
let disposed = false;
let booting = false;
let signingOut = false;
let documents: DesignDocument[] = [];
let selectedDocument: DesignDocument | null = null;
let checkpoints: Checkpoint[] = [];
let selectedCheckpoint: Checkpoint | null = null;
let cursor: string | null = null;
let docsRequest: AbortController | null = null;
let listRequest: AbortController | null = null;
let detailRequest: AbortController | null = null;
let exportRequest: AbortController | null = null;
let detailUrl: string | null = null;
let listGeneration = 0;
let detailGeneration = 0;
let searchTimer: number | undefined;
const downloadUrls = new Set<string>();

function current(stamp: number) {
  return !disposed && ready && stamp === epoch;
}
function setNotice(id: string, text = '') {
  const box = element(id);
  box.textContent = text;
  box.hidden = !text;
}
function empty(title: string, text: string, compact = false) {
  const box = node('div', `history__empty${compact ? ' history__empty--compact' : ''}`);
  box.append(node('h2', '', title), node('p', '', text));
  return box;
}
function setDetailEmpty(
  title = 'Select a checkpoint',
  text = 'Explore its changes, rationale and captured viewport.',
) {
  element('checkpoint-detail').replaceChildren(empty(title, text, true));
  element('checkpoint-detail').setAttribute('aria-busy', 'false');
}
function releaseImage() {
  const dialog = element<HTMLDialogElement>('viewport-dialog');
  if (dialog.open) dialog.close();
  element<HTMLImageElement>('viewport-image').removeAttribute('src');
  if (detailUrl) URL.revokeObjectURL(detailUrl);
  detailUrl = null;
}
function clearPrivateView() {
  epoch++;
  ready = false;
  routeInitialized = false;
  listGeneration++;
  detailGeneration++;
  docsRequest?.abort();
  listRequest?.abort();
  detailRequest?.abort();
  exportRequest?.abort();
  docsRequest = listRequest = detailRequest = exportRequest = null;
  window.clearTimeout(searchTimer);
  releaseImage();
  for (const url of downloadUrls) URL.revokeObjectURL(url);
  downloadUrls.clear();
  documents = [];
  checkpoints = [];
  selectedDocument = null;
  selectedCheckpoint = null;
  cursor = null;
  element('history-content').hidden = true;
  element('history-gate').hidden = false;
  element('document-grid').replaceChildren();
  element('checkpoint-list').replaceChildren();
  element('checkpoint-detail').replaceChildren();
  element('history-email').textContent = '';
  element('document-name').textContent = 'Document timeline';
  element('document-meta').textContent = '';
  element('download-status').textContent = '';
  element('document-count').textContent = '';
  element('checkpoint-count').textContent = '';
  setNotice('documents-error');
  setNotice('timeline-error');
  element<HTMLInputElement>('document-search').value = '';
  element<HTMLInputElement>('checkpoint-search').value = '';
  document.title = 'Your documents — Trace';
}
function login() {
  clearPrivateView();
  const id = new URLSearchParams(location.search).get('document');
  const next = id && uuid.test(id) ? `/app?document=${id}` : '/app';
  location.replace(`/login?${new URLSearchParams({ next })}`);
}
function handleAuthError(error: unknown) {
  if (!unauthorized(error)) return false;
  login();
  return true;
}

function renderDocuments() {
  const query = element<HTMLInputElement>('document-search').value.trim().toLocaleLowerCase();
  const visible = documents.filter((item) => item.name.toLocaleLowerCase().includes(query));
  element('document-count').textContent = query
    ? `${visible.length} of ${plural(documents.length, 'document')}`
    : plural(documents.length, 'document');
  const grid = element('document-grid');
  grid.replaceChildren();
  if (!visible.length) {
    const box = empty(
      query ? 'No matching documents' : 'Your next design starts here',
      query
        ? 'Try a different document name.'
        : 'Sign in to the desktop app with this account and capture a checkpoint in Fusion. Your documents will appear here after they sync.',
    );
    if (!query) {
      const link = node('a', 'btn btn--secondary', 'Download Trace for Windows');
      link.href = '/download';
      box.append(link);
    }
    grid.append(box);
    return;
  }
  for (const item of visible) {
    const card = node('button', 'history__document');
    card.type = 'button';
    const top = node('div', 'history__document-top');
    top.append(
      node('span', 'label', item.source || 'Autodesk Fusion'),
      node('span', 'label', 'Document'),
    );
    const bottom = node('div', 'history__document-bottom');
    bottom.append(
      node('span', '', plural(Number(item.event_count) || 0, 'checkpoint')),
      node('strong', '', 'View timeline →'),
    );
    card.append(
      top,
      node('h2', '', item.name),
      node('p', '', `Last captured ${date(item.latest_at)}`),
      bottom,
    );
    card.addEventListener('click', () => {
      history.pushState(null, '', `/app?${new URLSearchParams({ document: item.id })}`);
      openRoute(true);
    });
    grid.append(card);
  }
}

function documentFingerprint(item: DesignDocument | undefined | null) {
  return item
    ? [
        item.latest_at,
        item.event_count,
        item.complete_count,
        item.pending_count,
        item.failed_count,
      ].join(':')
    : '';
}
async function loadDocuments(quiet = false) {
  if (!ready || docsRequest) return;
  const stamp = epoch;
  const controller = new AbortController();
  docsRequest = controller;
  element<HTMLButtonElement>('documents-refresh').disabled = true;
  if (!quiet) {
    setNotice('documents-error');
    element('document-grid').setAttribute('aria-busy', 'true');
    if (!documents.length)
      element('document-grid').replaceChildren(
        empty('Loading documents…', 'Fetching your design archive.'),
      );
  }
  try {
    const result = await api<{ documents: DesignDocument[] }>('/api/documents', {
      signal: controller.signal,
    });
    if (!current(stamp)) return;
    documents = result.documents.filter((item) => uuid.test(item.id));
    if (
      selectedDocument &&
      documentFingerprint(documents.find((item) => item.id === selectedDocument?.id)) !==
        documentFingerprint(selectedDocument)
    )
      element('history-updates').hidden = false;
    renderDocuments();
    if (!quiet) setNotice('documents-error');
    if (!routeInitialized) openRoute();
  } catch (error) {
    if (!current(stamp) || aborted(error) || handleAuthError(error)) return;
    if (!quiet) {
      setNotice(
        'documents-error',
        message(error, 'Your documents could not be loaded. Select Refresh to try again.'),
      );
      if (!documents.length)
        element('document-grid').replaceChildren(
          empty(
            'History is temporarily unavailable',
            'Your saved checkpoints are still in your account. Refresh to try again.',
          ),
        );
    }
  } finally {
    if (docsRequest === controller) docsRequest = null;
    if (current(stamp)) {
      element<HTMLButtonElement>('documents-refresh').disabled = false;
      element('document-grid').setAttribute('aria-busy', 'false');
    }
  }
}

function openRoute(focus = false) {
  if (!ready) return;
  routeInitialized = true;
  window.clearTimeout(searchTimer);
  listGeneration++;
  detailGeneration++;
  listRequest?.abort();
  detailRequest?.abort();
  exportRequest?.abort();
  listRequest = detailRequest = exportRequest = null;
  releaseImage();
  checkpoints = [];
  selectedCheckpoint = null;
  cursor = null;
  element('history-updates').hidden = true;
  element<HTMLInputElement>('checkpoint-search').value = '';
  setNotice('timeline-error');
  setNotice('download-status');
  element<HTMLButtonElement>('download-document').disabled = false;
  const requested = new URLSearchParams(location.search).get('document');
  const id = requested && uuid.test(requested) ? requested : null;
  if (requested && !id) history.replaceState(null, '', '/app');
  selectedDocument = id ? documents.find((item) => item.id === id) || null : null;
  element('documents-view').hidden = Boolean(id);
  element('timeline-view').hidden = !id;
  if (!id) {
    document.title = 'Your documents — Trace';
    renderDocuments();
    if (focus) element('documents-title').focus();
    return;
  }
  if (!selectedDocument) {
    element('document-name').textContent = 'Document unavailable';
    element('document-meta').textContent =
      'This document may have been removed or belongs to another account.';
    element('checkpoint-list').replaceChildren();
    element('checkpoint-count').textContent = '';
    element('load-checkpoints').hidden = true;
    element<HTMLButtonElement>('download-document').disabled = true;
    setDetailEmpty('Document unavailable', 'Return to your documents to choose another design.');
    if (focus) element('document-name').focus();
    return;
  }
  element('document-name').textContent = selectedDocument.name;
  element('document-meta').textContent =
    `${plural(Number(selectedDocument.event_count) || 0, 'checkpoint')} · ${selectedDocument.source || 'Autodesk Fusion'}`;
  document.title = `${selectedDocument.name} — Trace`;
  setDetailEmpty();
  if (focus) element('document-name').focus();
  void loadCheckpoints();
}

function renderCheckpoints() {
  const list = element('checkpoint-list');
  list.replaceChildren();
  element('checkpoint-count').textContent =
    `${checkpoints.length}${cursor ? '+' : ''} checkpoint${checkpoints.length === 1 ? '' : 's'}`;
  element('load-checkpoints').hidden = !cursor;
  if (!checkpoints.length) {
    const search = element<HTMLInputElement>('checkpoint-search').value.trim();
    list.append(
      empty(
        search ? 'No matching checkpoints' : 'No checkpoints yet',
        search
          ? 'Try another change or decision.'
          : 'Checkpoints captured in the desktop app will appear after they sync.',
        true,
      ),
    );
    return;
  }
  let previousDay = '';
  for (const item of checkpoints) {
    const day = date(item.capturedAt);
    if (day !== previousDay) list.append(node('div', 'history__day label', day));
    previousDay = day;
    const button = node('button', 'history__checkpoint');
    button.type = 'button';
    button.dataset.checkpoint = item.id;
    button.setAttribute('aria-pressed', String(item.id === selectedCheckpoint?.id));
    const meta = node('div', 'history__checkpoint-meta');
    const captured = new Date(item.capturedAt);
    meta.append(
      node('span', '', checkpointStatus(item)),
      node(
        'span',
        '',
        Number.isFinite(captured.getTime())
          ? captured.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
          : '',
      ),
    );
    button.append(
      node('h3', '', checkpointTitle(item)),
      node(
        'p',
        'history__checkpoint-summary',
        item.ai?.summary ||
          item.rationale ||
          'Checkpoint saved. Its recorded changes are available to view.',
      ),
      meta,
    );
    button.addEventListener('click', () => {
      void selectCheckpoint(item.id, true);
    });
    list.append(button);
  }
}

async function loadCheckpoints(append = false) {
  if (!ready || !selectedDocument || (append && (!cursor || listRequest))) return;
  listRequest?.abort();
  const controller = new AbortController();
  listRequest = controller;
  const stamp = epoch,
    generation = ++listGeneration,
    documentId = selectedDocument.id;
  const query = new URLSearchParams({ documentId, limit: '30' });
  const search = element<HTMLInputElement>('checkpoint-search').value.trim();
  if (search) query.set('q', search);
  if (append && cursor) query.set('cursor', cursor);
  setNotice('timeline-error');
  element('checkpoint-list').setAttribute('aria-busy', 'true');
  element<HTMLButtonElement>('timeline-refresh').disabled = true;
  element<HTMLButtonElement>('load-checkpoints').disabled = true;
  if (!append) {
    detailRequest?.abort();
    detailRequest = null;
    detailGeneration++;
    releaseImage();
    checkpoints = [];
    selectedCheckpoint = null;
    cursor = null;
    element('load-checkpoints').hidden = true;
    element('checkpoint-count').textContent = '';
    element('checkpoint-list').replaceChildren(
      empty('Loading checkpoints…', 'Opening this design’s timeline.', true),
    );
    setDetailEmpty();
  }
  try {
    const result = await api<{ events: Checkpoint[]; nextCursor: string | null }>(
      `/api/events?${query}`,
      { signal: controller.signal },
    );
    if (!current(stamp) || generation !== listGeneration) return;
    const valid = result.events.filter(
      (item) => uuid.test(item.id) && item.documentId === documentId,
    );
    checkpoints = append
      ? [
          ...checkpoints,
          ...valid.filter((item) => !checkpoints.some((existing) => existing.id === item.id)),
        ]
      : valid;
    cursor = result.nextCursor;
    element('history-updates').hidden = true;
    selectedDocument = documents.find((item) => item.id === documentId) || selectedDocument;
    renderCheckpoints();
    if (!selectedCheckpoint && !detailRequest && checkpoints.length)
      void selectCheckpoint(checkpoints[0].id);
    if (!checkpoints.length)
      setDetailEmpty(
        'No checkpoint selected',
        search
          ? 'Change your search to find a checkpoint.'
          : 'Your design history will appear here after the next capture syncs.',
      );
  } catch (error) {
    if (
      !current(stamp) ||
      generation !== listGeneration ||
      aborted(error) ||
      handleAuthError(error)
    )
      return;
    setNotice(
      'timeline-error',
      message(error, 'The timeline could not be loaded. Refresh to try again.'),
    );
    if (!append)
      element('checkpoint-list').replaceChildren(
        empty('Timeline unavailable', 'Refresh to try again.', true),
      );
  } finally {
    if (listRequest === controller) listRequest = null;
    if (current(stamp) && generation === listGeneration) {
      element('checkpoint-list').setAttribute('aria-busy', 'false');
      element<HTMLButtonElement>('timeline-refresh').disabled = false;
      element<HTMLButtonElement>('load-checkpoints').disabled = false;
    }
  }
}

function detailSection(panel: HTMLElement, label: string) {
  const section = node('section', 'history__detail-section');
  section.append(node('h3', 'label', label));
  panel.append(section);
  return section;
}
function renderDetail(item: Checkpoint) {
  const panel = element('checkpoint-detail');
  panel.replaceChildren();
  const head = node('div', 'history__detail-head');
  const source = node('div', 'history__detail-source');
  source.append(
    node('span', 'label', item.source || 'Autodesk Fusion'),
    node('span', 'history__badge', checkpointStatus(item)),
  );
  const heading = node('h2', '', checkpointTitle(item));
  heading.id = 'checkpoint-title';
  heading.tabIndex = -1;
  head.append(
    source,
    heading,
    node(
      'p',
      'history__detail-meta',
      `${date(item.capturedAt, true)} · ${plural(item.changeCount, 'change')}`,
    ),
  );
  panel.append(head);
  const viewport = node('div', 'history__viewport');
  const bar = node('div', 'history__viewport-bar label');
  bar.append(
    node(
      'span',
      '',
      item.rawEvent?.demo ? 'Illustrative sample · not a Fusion capture' : 'Captured viewport',
    ),
    node('span', '', 'Select to expand'),
  );
  const placeholder = node('div', 'history__viewport-placeholder', 'Loading captured viewport…');
  placeholder.id = 'checkpoint-viewport';
  viewport.append(bar, placeholder);
  panel.append(viewport);
  const summary = detailSection(
    panel,
    item.aiProvider === 'template' ? 'Recorded change summary' : 'AI summary',
  );
  summary.append(
    node(
      'p',
      '',
      item.ai?.summary ||
        (item.status === 'failed'
          ? 'This checkpoint is saved. Its summary is unavailable; the recorded changes and rationale are below.'
          : item.status === 'receiving'
            ? 'This checkpoint’s upload is incomplete. Its image will appear after Fusion finishes uploading.'
            : 'This checkpoint is saved. Trace is preparing its summary.'),
    ),
  );
  detailSection(panel, 'Engineer’s rationale').append(
    node(
      'blockquote',
      'history__rationale',
      item.rationale || 'No rationale was included with this checkpoint.',
    ),
  );
  const changes = detailSection(
    panel,
    `What changed · ${plural(item.changeCount, 'engineering change')}`,
  );
  for (const change of item.engineeringChanges) {
    const box = node('div', 'history__change');
    const header = node('div', 'history__change-head');
    header.append(
      node('strong', '', change.feature?.name || change.component || 'Design change'),
      node('span', '', change.action.replaceAll('_', ' ')),
    );
    box.append(header);
    const properties = [...(change.properties || [])];
    const operation = change.operation || change.feature?.operation;
    if (operation) properties.unshift({ name: 'Operation', value: operation });
    if (properties.length) {
      const table = node('table', 'history__properties');
      const caption = node(
        'caption',
        'visually-hidden',
        `Properties for ${change.feature?.name || 'this change'}`,
      );
      table.append(caption);
      const body = node('tbody');
      for (const property of properties) {
        const before = property.oldValue ?? property.before;
        const after = property.value ?? property.newValue ?? property.after;
        const row = node('tr');
        const label = node('th', '', property.name || property.parameter || 'Property');
        label.scope = 'row';
        row.append(
          label,
          node(
            'td',
            '',
            before === undefined
              ? displayValue(after)
              : `${displayValue(before)} → ${displayValue(after)}`,
          ),
        );
        body.append(row);
      }
      table.append(body);
      box.append(table);
    }
    changes.append(box);
  }
  if (!item.engineeringChanges.length)
    changes.append(node('p', '', 'No normalized changes were included.'));
  if (item.ai?.tags?.length) {
    const tags = node('div', 'history__tags');
    for (const tag of item.ai.tags) tags.append(node('span', 'history__badge', tag));
    changes.append(tags);
  }
  if (item.aiProvider !== 'template' && item.ai?.notes?.length)
    detailSection(panel, 'Summary notes').append(node('p', '', item.ai.notes.join(' ')));
}

async function selectCheckpoint(id: string, focus = false) {
  if (!ready || !selectedDocument || !uuid.test(id)) return;
  detailRequest?.abort();
  const controller = new AbortController();
  detailRequest = controller;
  const stamp = epoch,
    generation = ++detailGeneration,
    documentId = selectedDocument.id;
  releaseImage();
  selectedCheckpoint = null;
  element('checkpoint-detail').replaceChildren(
    empty('Opening checkpoint…', 'Fetching its recorded context.', true),
  );
  element('checkpoint-detail').setAttribute('aria-busy', 'true');
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-checkpoint]'))
    button.setAttribute('aria-pressed', String(button.dataset.checkpoint === id));
  try {
    const item = await api<Checkpoint>(`/api/events/${id}`, { signal: controller.signal });
    if (!current(stamp) || generation !== detailGeneration) return;
    if (item.documentId !== documentId)
      throw new Error('This checkpoint is not part of the selected document.');
    selectedCheckpoint = item;
    renderDetail(item);
    element('checkpoint-detail').setAttribute('aria-busy', 'false');
    if (focus && matchMedia('(max-width: 47.99rem)').matches) element('checkpoint-title').focus();
    try {
      const image = await apiBlob(`/api/events/${id}/image`, { signal: controller.signal });
      if (!current(stamp) || generation !== detailGeneration) return;
      if (!image.type.startsWith('image/png'))
        throw new Error('The captured image is unavailable.');
      detailUrl = URL.createObjectURL(image);
      const button = node('button', 'history__viewport-open');
      button.type = 'button';
      button.setAttribute('aria-label', `Expand captured viewport for ${item.documentName}`);
      const img = node('img');
      img.alt = `Captured viewport for ${item.documentName}`;
      img.src = detailUrl;
      img.addEventListener('error', () => {
        if (generation === detailGeneration)
          button.replaceWith(
            node(
              'p',
              'history__viewport-placeholder',
              'The captured image could not be displayed. Refresh to try again.',
            ),
          );
      });
      button.append(img);
      button.addEventListener('click', () => {
        if (!detailUrl || generation !== detailGeneration) return;
        const expanded = element<HTMLImageElement>('viewport-image');
        expanded.src = detailUrl;
        expanded.alt = img.alt;
        element<HTMLDialogElement>('viewport-dialog').showModal();
      });
      element('checkpoint-viewport').replaceWith(button);
    } catch (error) {
      if (
        !current(stamp) ||
        generation !== detailGeneration ||
        aborted(error) ||
        handleAuthError(error)
      )
        return;
      element('checkpoint-viewport').textContent =
        'The captured image is unavailable. The recorded changes are still shown below.';
    }
  } catch (error) {
    if (
      !current(stamp) ||
      generation !== detailGeneration ||
      aborted(error) ||
      handleAuthError(error)
    )
      return;
    setDetailEmpty(
      'Checkpoint unavailable',
      message(error, 'Select this checkpoint again to retry.'),
    );
  } finally {
    if (detailRequest === controller) detailRequest = null;
    if (current(stamp) && generation === detailGeneration)
      element('checkpoint-detail').setAttribute('aria-busy', 'false');
  }
}

async function downloadDocument() {
  if (!ready || !selectedDocument || exportRequest) return;
  const stamp = epoch,
    documentId = selectedDocument.id,
    name = selectedDocument.name;
  const controller = new AbortController();
  exportRequest = controller;
  element<HTMLButtonElement>('download-document').disabled = true;
  setNotice('download-status', 'Preparing your document download…');
  try {
    const data = await apiBlob(`/api/documents/${documentId}/export`, {
      signal: controller.signal,
    });
    if (!current(stamp) || controller.signal.aborted || selectedDocument?.id !== documentId) return;
    const url = URL.createObjectURL(data);
    downloadUrls.add(url);
    const anchor = node('a');
    anchor.href = url;
    anchor.download = `${name.replace(/[^a-z0-9._-]+/gi, '-').slice(0, 100) || 'Trace-document'}.zip`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => {
      URL.revokeObjectURL(url);
      downloadUrls.delete(url);
    }, 30_000);
    setNotice(
      'download-status',
      'Download started. The ZIP includes your document’s recorded checkpoints and viewports.',
    );
  } catch (error) {
    if (
      !current(stamp) ||
      controller.signal.aborted ||
      selectedDocument?.id !== documentId ||
      aborted(error) ||
      handleAuthError(error)
    )
      return;
    setNotice(
      'download-status',
      message(error, 'The download could not be prepared. Please try again.'),
    );
  } finally {
    if (exportRequest === controller) exportRequest = null;
    if (current(stamp) && selectedDocument?.id === documentId)
      element<HTMLButtonElement>('download-document').disabled = false;
  }
}

async function boot() {
  if (booting || disposed) return;
  booting = true;
  const stamp = ++epoch;
  element('history-retry').hidden = true;
  element('history-gate').querySelector('h1')!.textContent = 'Opening your design history…';
  element('history-gate').querySelector('p')!.textContent = 'Connecting to Trace.';
  try {
    const user = await getUser();
    if (disposed || stamp !== epoch) return;
    if (!user) {
      login();
      return;
    }
    userId = user.id;
    ready = true;
    element('history-email').textContent = user.email || 'Signed in';
    element('history-gate').hidden = true;
    element('history-content').hidden = false;
    await loadDocuments();
  } catch (error) {
    if (disposed || stamp !== epoch || handleAuthError(error)) return;
    element('history-gate').querySelector('h1')!.textContent =
      'Your history is temporarily unavailable';
    element('history-gate').querySelector('p')!.textContent = message(
      error,
      'Could not connect to Trace. Please try again.',
    );
    element('history-retry').hidden = false;
  } finally {
    booting = false;
  }
}

element('history-retry').addEventListener('click', () => {
  void boot();
});
element('document-search').addEventListener('input', renderDocuments);
element('documents-refresh').addEventListener('click', () => {
  void loadDocuments();
});
element('back-documents').addEventListener('click', () => {
  history.pushState(null, '', '/app');
  openRoute(true);
});
element('checkpoint-search').addEventListener('input', () => {
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => {
    void loadCheckpoints();
  }, 300);
});
element('timeline-refresh').addEventListener('click', () => {
  void loadCheckpoints();
});
element('history-updates').addEventListener('click', () => {
  void loadCheckpoints();
});
element('load-checkpoints').addEventListener('click', () => {
  void loadCheckpoints(true);
});
element('download-document').addEventListener('click', () => {
  void downloadDocument();
});
element('close-viewport').addEventListener('click', () => {
  element<HTMLDialogElement>('viewport-dialog').close();
});
element<HTMLDialogElement>('viewport-dialog').addEventListener('click', (event) => {
  const dialog = element<HTMLDialogElement>('viewport-dialog');
  if (event.target === dialog) {
    const bounds = dialog.getBoundingClientRect();
    if (
      event.clientX < bounds.left ||
      event.clientX > bounds.right ||
      event.clientY < bounds.top ||
      event.clientY > bounds.bottom
    )
      dialog.close();
  }
});
element('history-signout').addEventListener('click', async () => {
  signingOut = true;
  element<HTMLButtonElement>('history-signout').disabled = true;
  clearPrivateView();
  try {
    await signOut();
  } catch {
    /* The client clears this browser's session even if revocation is offline. */
  } finally {
    location.replace('/login');
  }
});
window.addEventListener('popstate', () => openRoute(true));
const unsubscribe = onSessionChange((user) => {
  if (disposed) return;
  if (!user) {
    if (!signingOut) login();
    return;
  }
  if (userId && user.id !== userId) {
    clearPrivateView();
    location.replace('/app');
  }
});
const poll = window.setInterval(() => {
  if (!document.hidden && ready) void loadDocuments(true);
}, 60_000);
window.addEventListener('pagehide', () => {
  disposed = true;
  clearPrivateView();
  unsubscribe();
  window.clearInterval(poll);
});
window.addEventListener('pageshow', (event) => {
  // A restored back/forward-cache page must revalidate its account before showing data.
  if (event.persisted) location.reload();
});
void boot();
