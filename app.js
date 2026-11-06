'use strict';

const { flatten, findDuplicates, findEmptyFolders, classifyStatus, countBookmarks, buildBackupHtml, runPool } = TidyLib;

// Permission to visit websites. Asked only when the user clicks "Check links".
const CHECK_ORIGINS = ['http://*/*', 'https://*/*'];
const CONCURRENCY = 5; // links checked at the same time
const TIMEOUT_MS = 10000; // give up on a link after 10 seconds

const state = {
  bookmarks: [],
  folderCount: 0,
  duplicates: [],
  emptyFolders: [],
  linkResults: new Map(), // url -> { status: 'ok' | 'dead' | 'review', reason }
  linksChecked: false,
  linksPartial: false,
  checking: null, // { done, total, controller } while a check is running
  selected: new Set(), // ids of bookmarks/folders marked for deletion
  offered: new Set(), // ids already pre-selected once, so we don't re-check what the user unchecked
  view: 'duplicates',
  busy: false,
};

// ---------- Small DOM helpers ----------
// Text always goes in with textContent/append, never innerHTML: a bookmark title
// could contain HTML, and this page has access to all the user's bookmarks.

const $ = (selector) => document.querySelector(selector);

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'checked' || key === 'disabled') node[key] = Boolean(value);
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : String(child));
  }
  return node;
}

let toastTimer;
function toast(message) {
  const box = $('#toast');
  box.textContent = message;
  box.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => box.classList.remove('show'), 4500);
}

const plural = (n, one, many = one + 's') => `${n.toLocaleString()} ${n === 1 ? one : many}`;

// Only real web links get an "Open" link. A "javascript:" bookmark opened from this
// page would run code with this extension's permissions.
const isWebUrl = (url) => /^(https?|ftp|file):/i.test(url);

// ---------- Reading bookmarks ----------

async function scan() {
  const tree = await chrome.bookmarks.getTree();
  const { bookmarks, folderCount } = flatten(tree);
  state.bookmarks = bookmarks;
  state.folderCount = folderCount;
  state.duplicates = findDuplicates(bookmarks);
  state.emptyFolders = findEmptyFolders(tree);

  // Forget selections for things that no longer exist (or folders that are no longer empty).
  const alive = new Set([...bookmarks.map((b) => b.id), ...state.emptyFolders.map((f) => f.id)]);
  for (const id of state.selected) if (!alive.has(id)) state.selected.delete(id);

  // Pre-select the obvious ones: extra copies (the oldest is kept) and empty folders.
  for (const group of state.duplicates) group.items.slice(1).forEach((b) => offer(b.id));
  state.emptyFolders.forEach((f) => offer(f.id));
  preselectDeadLinks();

  render();
}

function offer(id) {
  if (state.offered.has(id)) return;
  state.offered.add(id);
  state.selected.add(id);
}

function linkGroups() {
  const dead = [];
  const review = [];
  for (const b of state.bookmarks) {
    const result = state.linkResults.get(b.url);
    if (!result) continue;
    if (result.status === 'dead') dead.push({ ...b, reason: result.reason });
    else if (result.status === 'review') review.push({ ...b, reason: result.reason });
  }
  return { dead, review };
}

// Only 404/410 are pre-selected. "Review" links are left for the user to decide.
function preselectDeadLinks() {
  linkGroups().dead.forEach((b) => offer(b.id));
}

// Re-scan when bookmarks change in another tab or window (but not while we're deleting).
let rescanTimer;
function scheduleScan() {
  if (state.busy) return;
  clearTimeout(rescanTimer);
  rescanTimer = setTimeout(scan, 400);
}
for (const event of ['onCreated', 'onRemoved', 'onChanged', 'onMoved', 'onImportEnded']) {
  chrome.bookmarks[event].addListener(scheduleScan);
}

// ---------- Checking links ----------

async function fetchWithTimeout(url, method, signal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const stop = () => controller.abort();
  signal.addEventListener('abort', stop);
  try {
    // credentials: 'omit' -> no cookies are sent, so sites don't see the user as logged in.
    return await fetch(url, { method, redirect: 'follow', credentials: 'omit', cache: 'no-store', signal: controller.signal });
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', stop);
  }
}

async function checkUrl(url, signal) {
  try {
    // HEAD asks only for the headers (fast). Some servers answer HEAD badly,
    // so anything that isn't OK gets a second try with a normal GET.
    let res = await fetchWithTimeout(url, 'HEAD', signal);
    if (!res.ok) {
      res = await fetchWithTimeout(url, 'GET', signal);
      if (res.body) res.body.cancel().catch(() => {}); // we only need the status, not the page
    }
    const status = classifyStatus(res.status);
    const reason = res.status === 404 || res.status === 410 ? 'Page not found' : `Server answered ${res.status}`;
    return { status, reason };
  } catch (err) {
    if (signal.aborted) throw err; // the user pressed Cancel
    const timedOut = err.name === 'AbortError';
    return { status: 'review', reason: timedOut ? 'No answer after 10 s' : 'Could not connect' };
  }
}

async function startCheck() {
  // Must be the first thing in the click handler: Chrome only shows the
  // permission prompt in direct response to a user action.
  const granted = await chrome.permissions.request({ origins: CHECK_ORIGINS });
  if (!granted) {
    toast('Checking links needs that permission. Nothing was checked.');
    return;
  }
  if (!navigator.onLine) {
    toast("You're offline. Connect to the internet and try again.");
    return;
  }

  const urls = [...new Set(state.bookmarks.map((b) => b.url).filter((u) => /^https?:/i.test(u)))];
  const controller = new AbortController();
  state.linkResults = new Map();
  state.linksPartial = false;
  state.checking = { done: 0, total: urls.length, controller };
  render();

  try {
    await runPool(
      urls,
      CONCURRENCY,
      async (url) => state.linkResults.set(url, await checkUrl(url, controller.signal)),
      (done) => {
        state.checking.done = done;
        updateProgress();
      },
      controller.signal,
    );
  } catch (err) {
    if (!controller.signal.aborted) throw err;
    state.linksPartial = true;
    toast('Check cancelled. Showing the links checked so far.');
  } finally {
    state.checking = null;
    state.linksChecked = true;
    preselectDeadLinks();
    render();
  }
}

function updateProgress() {
  const c = state.checking;
  if (!c) return;
  const bar = $('#progressBar');
  const label = $('#progressLabel');
  if (bar) bar.style.width = `${c.total ? (c.done / c.total) * 100 : 100}%`;
  if (label) label.textContent = `Checked ${c.done.toLocaleString()} of ${c.total.toLocaleString()} links…`;
}

// ---------- Backup and delete ----------

async function downloadBackup() {
  const tree = await chrome.bookmarks.getTree();
  const blob = new Blob([buildBackupHtml(tree)], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  const name = `bookmarks-backup-${new Date().toISOString().slice(0, 10)}.html`;
  const link = el('a', { href: url, download: name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return name;
}

async function deleteSelected() {
  const ids = [...state.selected];
  const folderIds = new Set(state.emptyFolders.map((f) => f.id));
  state.busy = true;
  let deleted = 0;
  let skipped = 0;
  try {
    const backupName = await downloadBackup();
    for (const id of ids) {
      try {
        if (folderIds.has(id)) {
          // Safety net: check again that the folder is still empty right before deleting it.
          const [folder] = await chrome.bookmarks.getSubTree(id);
          if (countBookmarks(folder) > 0) {
            skipped++;
            continue;
          }
          await chrome.bookmarks.removeTree(id);
        } else {
          await chrome.bookmarks.remove(id);
        }
        deleted++;
      } catch {
        skipped++; // already gone, or Chrome refused (e.g. a managed bookmark)
      } finally {
        state.selected.delete(id);
      }
    }
    const extra = skipped ? ` ${plural(skipped, 'item')} skipped.` : '';
    toast(`Deleted ${plural(deleted, 'item')}. Backup saved as ${backupName}.${extra}`);
  } catch (err) {
    toast(`Something went wrong: ${err.message}. Nothing else was deleted.`);
  } finally {
    state.busy = false;
    await scan();
  }
}

// ---------- Rendering ----------

function render() {
  renderStats();
  renderTabs();
  renderPanel();
  renderActionbar();
}

function renderStats() {
  const extraCopies = state.duplicates.reduce((n, g) => n + g.items.length - 1, 0);
  const { dead, review } = linkGroups();
  const stats = [
    [state.bookmarks.length, 'Bookmarks'],
    [state.folderCount, 'Folders'],
    [extraCopies, 'Extra copies'],
    [state.emptyFolders.length, 'Empty folders'],
    [state.linksChecked ? dead.length + review.length : '–', 'Broken or doubtful links'],
  ];
  $('#stats').replaceChildren(
    ...stats.map(([value, label]) =>
      el('div', { class: 'stat' },
        el('div', { class: 'stat-value' }, typeof value === 'number' ? value.toLocaleString() : value),
        el('div', { class: 'stat-label' }, label))),
  );
}

function renderTabs() {
  const { dead, review } = linkGroups();
  const counts = {
    duplicates: state.duplicates.length,
    empty: state.emptyFolders.length,
    links: state.linksChecked ? dead.length + review.length : null,
  };
  for (const tab of document.querySelectorAll('.tab')) {
    const view = tab.dataset.view;
    tab.setAttribute('aria-selected', String(view === state.view));
    tab.querySelector('.count').textContent = counts[view] ? counts[view].toLocaleString() : '';
  }
}

function renderPanel() {
  const panel = $('#panel');
  if (state.view === 'duplicates') panel.replaceChildren(...duplicatesView());
  else if (state.view === 'empty') panel.replaceChildren(...emptyFoldersView());
  else panel.replaceChildren(...linksView());
  updateProgress();
}

function renderActionbar() {
  const n = state.selected.size;
  $('#actionbar').hidden = n === 0;
  $('#selCount').textContent = `${plural(n, 'item')} selected`;
}

function setSelected(id, on) {
  if (on) state.selected.add(id);
  else state.selected.delete(id);
  renderActionbar();
}

function setMany(ids, on) {
  ids.forEach((id) => (on ? state.selected.add(id) : state.selected.delete(id)));
  renderPanel();
  renderActionbar();
}

function toolbar(text, selectableIds, allIds = selectableIds) {
  return el('div', { class: 'toolbar' },
    el('span', {}, text),
    el('span', { class: 'spacer' }),
    el('button', { class: 'btn link', type: 'button', onclick: () => setMany(selectableIds, true) }, 'Select all'),
    el('button', { class: 'btn link', type: 'button', onclick: () => setMany(allIds, false) }, 'Select none'));
}

function emptyState(title, text, action) {
  return el('div', { class: 'empty-state' }, el('strong', {}, title), text, action || null);
}

function row({ id, title, meta, url, badge, badgeClass }) {
  const inputId = `cb-${id}`;
  return el('li', { class: 'row' },
    el('input', { type: 'checkbox', id: inputId, checked: state.selected.has(id), onchange: (e) => setSelected(id, e.target.checked) }),
    el('label', { for: inputId, class: 'row-main' },
      el('span', { class: 'row-title' }, title),
      meta ? el('span', { class: 'row-meta' }, meta) : null,
      url ? el('span', { class: 'row-url' }, url) : null),
    badge ? el('span', { class: `badge ${badgeClass || ''}` }, badge) : null,
    url && isWebUrl(url) ? el('a', { class: 'row-open', href: url, target: '_blank', rel: 'noopener noreferrer' }, 'Open') : null);
}

const folderLabel = (path) => `In: ${path || 'Top level'}`;

function duplicatesView() {
  if (!state.duplicates.length) {
    return [emptyState('No duplicates', 'Every bookmark points to a different page.')];
  }
  const copies = state.duplicates.flatMap((g) => g.items.slice(1).map((b) => b.id));
  const all = state.duplicates.flatMap((g) => g.items.map((b) => b.id));
  return [
    toolbar(`${plural(state.duplicates.length, 'page')} saved more than once. The oldest copy is kept unless you select it.`, copies, all),
    ...state.duplicates.map((group) =>
      el('div', { class: 'group' },
        el('div', { class: 'group-head' }, `${group.items.length} copies · ${group.items[0].url}`),
        el('ul', { class: 'rows' },
          group.items.map((b, i) =>
            row({
              id: b.id,
              title: b.title,
              meta: folderLabel(b.path) + (b.dateAdded ? ` · Added ${new Date(b.dateAdded).toLocaleDateString()}` : ''),
              badge: i === 0 ? 'Oldest' : null,
            }))))),
  ];
}

function emptyFoldersView() {
  if (!state.emptyFolders.length) {
    return [emptyState('No empty folders', 'Every folder has at least one bookmark inside.')];
  }
  const ids = state.emptyFolders.map((f) => f.id);
  return [
    toolbar(`${plural(ids.length, 'folder')} with no bookmarks inside.`, ids),
    el('div', { class: 'group' },
      el('ul', { class: 'rows' },
        state.emptyFolders.map((f) =>
          row({
            id: f.id,
            title: f.title,
            meta: folderLabel(f.path) + (f.subfolders ? ` · includes ${plural(f.subfolders, 'empty subfolder')}` : ''),
          })))),
  ];
}

function linksView() {
  if (state.checking) {
    return [
      el('div', { class: 'empty-state' },
        el('strong', {}, 'Checking your links'),
        el('div', { class: 'progress' }, el('div', { class: 'progress-bar', id: 'progressBar' })),
        el('div', { id: 'progressLabel' }),
        el('button', { class: 'btn ghost', type: 'button', onclick: () => state.checking && state.checking.controller.abort() }, 'Cancel')),
    ];
  }

  const checkButton = (label) => el('button', { class: 'btn primary', type: 'button', onclick: startCheck }, label);

  if (!state.linksChecked) {
    return [
      emptyState(
        'Find links that no longer work',
        el('p', { class: 'hint' }, 'Tidy Bookmarks visits each saved page once to see if it still exists. Chrome will ask for permission to access websites — it is used only for this check, without your cookies, and nothing is sent anywhere else.'),
        checkButton('Check links')),
    ];
  }

  const { dead, review } = linkGroups();
  const partial = state.linksPartial ? ' (stopped early — not every link was checked)' : '';
  const out = [];

  if (!dead.length && !review.length) {
    out.push(emptyState('All links work', `Every page answered normally${partial}.`, checkButton('Check again')));
    return out;
  }

  const ids = dead.map((b) => b.id);
  const allIds = [...dead, ...review].map((b) => b.id);
  out.push(toolbar(`Checked${partial}. Only pages that are definitely gone are pre-selected.`, ids, allIds));

  const list = (items, cls) =>
    el('div', { class: 'group' },
      el('ul', { class: 'rows' },
        items.map((b) => row({ id: b.id, title: b.title, meta: folderLabel(b.path), url: b.url, badge: b.reason, badgeClass: cls }))));

  if (dead.length) {
    out.push(el('h2', { class: 'section-title' }, `Gone (${dead.length.toLocaleString()})`));
    out.push(list(dead, 'dead'));
  }
  if (review.length) {
    out.push(el('h2', { class: 'section-title' }, `Take a look (${review.length.toLocaleString()})`));
    out.push(el('p', { class: 'hint' }, 'These sites blocked the check, were slow or had an error. Many still work when you open them, so check before deleting.'));
    out.push(list(review, 'review'));
  }
  out.push(el('div', { class: 'toolbar' }, el('span', { class: 'spacer' }), checkButton('Check again')));
  return out;
}

// ---------- Events ----------

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    state.view = tab.dataset.view;
    renderTabs();
    renderPanel();
  });
}

$('#backupBtn').addEventListener('click', async () => {
  const name = await downloadBackup();
  toast(`Backup saved as ${name}.`);
});

$('#deleteBtn').addEventListener('click', () => {
  $('#confirmCount').textContent = plural(state.selected.size, 'item');
  // Reset, or closing with Esc would reuse the answer from last time.
  $('#confirm').returnValue = '';
  $('#confirm').showModal();
});

$('#confirm').addEventListener('close', () => {
  if ($('#confirm').returnValue === 'confirm') deleteSelected();
});

scan().catch((err) => toast(`Could not read your bookmarks: ${err.message}`));
