/*
 * Tidy Bookmarks — core logic.
 * Nothing in this file touches Chrome APIs, so it can be tested with Node (see tests/).
 */
(function (global) {
  'use strict';

  // Query parameters that only track where a click came from. Two links that differ
  // only in these point to the same page.
  const TRACKING_PARAM = /^(utm_\w+|fbclid|gclid|dclid|msclkid|yclid|mc_cid|mc_eid|igshid|_hsenc|_hsmi)$/i;

  /**
   * Turns a URL into a comparison key, so small differences don't hide duplicates:
   * http/https, "www.", a trailing "/", tracking params and param order are ignored.
   * The #hash is kept, because some web apps use it for different pages.
   */
  function normalizeUrl(raw) {
    const text = String(raw || '').trim();
    let u;
    try {
      u = new URL(text);
    } catch {
      return text;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return u.href;

    const host = u.hostname.replace(/^www\./, '');
    const port = u.port ? ':' + u.port : '';
    const path = u.pathname.replace(/\/+$/, '');
    const params = [...u.searchParams]
      .filter(([key]) => !TRACKING_PARAM.test(key))
      .sort((a, b) => (a[0] + '=' + a[1]).localeCompare(b[0] + '=' + b[1]));
    const query = params.length ? '?' + new URLSearchParams(params).toString() : '';
    return host + port + path + query + u.hash;
  }

  // Chrome's root (id "0") and its direct children (Bookmarks bar, Other, Mobile)
  // can't be deleted. Folders managed by a company or school can't either.
  function isRemovableFolder(node) {
    return node.url === undefined && node.parentId != null && node.parentId !== '0' && !node.unmodifiable;
  }

  function countBookmarks(node) {
    if (node.url !== undefined) return 1;
    return (node.children || []).reduce((sum, child) => sum + countBookmarks(child), 0);
  }

  function countFolders(node) {
    if (node.url !== undefined) return 0;
    return 1 + (node.children || []).reduce((sum, child) => sum + countFolders(child), 0);
  }

  // The tree's first level is the invisible root, so it adds nothing to the path.
  function childPath(node, path) {
    return node.parentId == null ? path : [...path, node.title];
  }

  /** Walks the tree and returns every bookmark the user can delete, with its folder path. */
  function flatten(roots) {
    const bookmarks = [];
    let folderCount = 0;
    const visit = (node, path) => {
      if (node.unmodifiable) return;
      if (node.url !== undefined) {
        bookmarks.push({
          id: node.id,
          title: node.title || node.url,
          url: node.url,
          dateAdded: node.dateAdded || 0,
          path: path.join(' › '),
        });
        return;
      }
      if (isRemovableFolder(node)) folderCount++;
      const next = childPath(node, path);
      for (const child of node.children || []) visit(child, next);
    };
    roots.forEach((root) => visit(root, []));
    return { bookmarks, folderCount };
  }

  /** Groups bookmarks that point to the same page. The oldest copy comes first. */
  function findDuplicates(bookmarks) {
    const groups = new Map();
    for (const b of bookmarks) {
      const key = normalizeUrl(b.url);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(b);
    }
    const byAge = (a, b) =>
      a.dateAdded - b.dateAdded || a.id.localeCompare(b.id, undefined, { numeric: true });
    return [...groups]
      .filter(([, items]) => items.length > 1)
      .map(([key, items]) => ({ key, items: items.slice().sort(byAge) }))
      .sort((a, b) => b.items.length - a.items.length || a.key.localeCompare(b.key));
  }

  /**
   * Folders that contain no bookmarks at any depth. Only the outermost one is
   * listed: deleting it also removes the empty folders inside it.
   */
  function findEmptyFolders(roots) {
    const result = [];
    const visit = (node, path) => {
      if (node.url !== undefined || node.unmodifiable) return;
      if (isRemovableFolder(node) && countBookmarks(node) === 0) {
        result.push({
          id: node.id,
          title: node.title || '(untitled folder)',
          path: path.join(' › '),
          subfolders: countFolders(node) - 1,
        });
        return;
      }
      const next = childPath(node, path);
      for (const child of node.children || []) visit(child, next);
    };
    roots.forEach((root) => visit(root, []));
    return result;
  }

  /**
   * Only 404 and 410 mean "this page is gone". Everything else that isn't OK
   * (403 blocked, 429 too many requests, 500 server error...) might work in a
   * normal visit, so the user should look at it before deleting.
   */
  function classifyStatus(code) {
    if (code >= 200 && code < 400) return 'ok';
    if (code === 404 || code === 410) return 'dead';
    return 'review';
  }

  function escapeHtml(text) {
    return String(text || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /** Backup in the standard bookmarks HTML format, which Chrome and other browsers can import. */
  function buildBackupHtml(roots) {
    const secs = (ms) => Math.floor((ms || 0) / 1000);
    const lines = [
      '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
      '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
      '<TITLE>Bookmarks</TITLE>',
      '<H1>Bookmarks</H1>',
      '<DL><p>',
    ];
    const visit = (node, depth) => {
      const pad = '    '.repeat(depth);
      if (node.url !== undefined) {
        lines.push(`${pad}<DT><A HREF="${escapeHtml(node.url)}" ADD_DATE="${secs(node.dateAdded)}">${escapeHtml(node.title)}</A>`);
        return;
      }
      const isBar = node.folderType === 'bookmarks-bar' || (node.parentId === '0' && node.id === '1');
      lines.push(`${pad}<DT><H3 ADD_DATE="${secs(node.dateAdded)}"${isBar ? ' PERSONAL_TOOLBAR_FOLDER="true"' : ''}>${escapeHtml(node.title)}</H3>`);
      lines.push(`${pad}<DL><p>`);
      for (const child of node.children || []) visit(child, depth + 1);
      lines.push(`${pad}</DL><p>`);
    };
    for (const root of roots) for (const top of root.children || []) visit(top, 1);
    lines.push('</DL><p>');
    return lines.join('\n') + '\n';
  }

  /** Runs `worker` over `items`, at most `limit` at a time. Stops if `signal` is aborted. */
  async function runPool(items, limit, worker, onProgress, signal) {
    let next = 0;
    let done = 0;
    const lane = async () => {
      while (next < items.length) {
        if (signal && signal.aborted) throw new DOMException('Cancelled', 'AbortError');
        const item = items[next++];
        await worker(item);
        done++;
        if (onProgress) onProgress(done, items.length);
      }
    };
    const lanes = Array.from({ length: Math.min(limit, items.length) }, lane);
    await Promise.all(lanes);
  }

  const api = {
    normalizeUrl,
    isRemovableFolder,
    countBookmarks,
    flatten,
    findDuplicates,
    findEmptyFolders,
    classifyStatus,
    escapeHtml,
    buildBackupHtml,
    runPool,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.TidyLib = api;
})(typeof self !== 'undefined' ? self : globalThis);
