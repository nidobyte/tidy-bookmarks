// Run with: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const lib = require('../lib.js');

// A small fake bookmark tree shaped like the one chrome.bookmarks.getTree() returns.
function sampleTree() {
  return [{
    id: '0', title: '', children: [
      { id: '1', parentId: '0', title: 'Bookmarks bar', folderType: 'bookmarks-bar', children: [
        { id: '10', parentId: '1', title: 'Example', url: 'https://www.example.com/', dateAdded: 1000 },
        { id: '11', parentId: '1', title: 'Example again', url: 'http://example.com?utm_source=x', dateAdded: 500 },
        { id: '12', parentId: '1', title: 'Work', children: [
          { id: '13', parentId: '12', title: 'Empty inside', children: [] },
          { id: '14', parentId: '12', title: 'Docs', url: 'https://docs.example.com/a', dateAdded: 1 },
        ] },
      ] },
      { id: '2', parentId: '0', title: 'Other bookmarks', children: [
        { id: '20', parentId: '2', title: 'Old stuff', children: [
          { id: '21', parentId: '20', title: 'Nested empty', children: [] },
        ] },
        { id: '22', parentId: '2', title: 'Script <b>', url: 'javascript:alert(1)', dateAdded: 2 },
      ] },
      { id: '3', parentId: '0', title: 'Mobile bookmarks', children: [] },
      { id: '4', parentId: '0', title: 'Managed', unmodifiable: 'managed', children: [
        { id: '40', parentId: '4', title: 'Company', url: 'https://example.com', dateAdded: 0 },
        { id: '41', parentId: '4', title: 'Empty managed', children: [] },
      ] },
    ],
  }];
}

test('normalizeUrl ignores small differences', () => {
  const key = lib.normalizeUrl('https://example.com');
  assert.equal(lib.normalizeUrl('http://www.example.com/'), key);
  assert.equal(lib.normalizeUrl('https://EXAMPLE.com/?utm_source=news&fbclid=1'), key);
  assert.equal(lib.normalizeUrl('https://a.com/p?b=2&a=1'), lib.normalizeUrl('https://a.com/p?a=1&b=2'));
});

test('normalizeUrl keeps real differences', () => {
  assert.notEqual(lib.normalizeUrl('https://a.com/page'), lib.normalizeUrl('https://a.com/Page'));
  assert.notEqual(lib.normalizeUrl('https://a.com/?id=1'), lib.normalizeUrl('https://a.com/?id=2'));
  assert.notEqual(lib.normalizeUrl('https://app.com/#/inbox'), lib.normalizeUrl('https://app.com/#/sent'));
  assert.notEqual(lib.normalizeUrl('https://a.com:8080/'), lib.normalizeUrl('https://a.com/'));
  assert.equal(lib.normalizeUrl('not a url'), 'not a url');
});

test('flatten skips managed bookmarks and builds folder paths', () => {
  const { bookmarks, folderCount } = lib.flatten(sampleTree());
  assert.deepEqual(bookmarks.map((b) => b.id).sort(), ['10', '11', '14', '22']);
  assert.equal(bookmarks.find((b) => b.id === '14').path, 'Bookmarks bar › Work');
  assert.equal(folderCount, 4); // Work, Empty inside, Old stuff, Nested empty
});

test('findDuplicates groups copies with the oldest first', () => {
  const { bookmarks } = lib.flatten(sampleTree());
  const groups = lib.findDuplicates(bookmarks);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].items.map((b) => b.id), ['11', '10']);
});

test('findEmptyFolders lists only the outermost empty folder, never roots or managed ones', () => {
  const empty = lib.findEmptyFolders(sampleTree());
  assert.deepEqual(empty.map((f) => f.id).sort(), ['13', '20']);
  const oldStuff = empty.find((f) => f.id === '20');
  assert.equal(oldStuff.subfolders, 1);
  assert.equal(oldStuff.path, 'Other bookmarks');
});

test('classifyStatus is careful about what counts as dead', () => {
  assert.equal(lib.classifyStatus(200), 'ok');
  assert.equal(lib.classifyStatus(301), 'ok');
  assert.equal(lib.classifyStatus(404), 'dead');
  assert.equal(lib.classifyStatus(410), 'dead');
  for (const code of [401, 403, 429, 500, 503]) assert.equal(lib.classifyStatus(code), 'review');
});

test('buildBackupHtml escapes titles and includes every bookmark', () => {
  const html = lib.buildBackupHtml(sampleTree());
  assert.match(html, /^<!DOCTYPE NETSCAPE-Bookmark-file-1>/);
  assert.match(html, /Script &lt;b&gt;/);
  assert.doesNotMatch(html, /Script <b>/);
  assert.match(html, /PERSONAL_TOOLBAR_FOLDER="true">Bookmarks bar/);
  for (const url of ['https://www.example.com/', 'https://docs.example.com/a', 'https://example.com']) {
    assert.ok(html.includes(`HREF="${url}"`), url);
  }
  assert.equal((html.match(/<DL><p>/g) || []).length, (html.match(/<\/DL><p>/g) || []).length);
});

test('runPool respects the limit and can be cancelled', async () => {
  let running = 0;
  let peak = 0;
  const seen = [];
  await lib.runPool([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
    running++;
    peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, 5));
    seen.push(n);
    running--;
  });
  assert.equal(peak, 3);
  assert.equal(seen.length, 7);

  const controller = new AbortController();
  const done = [];
  await assert.rejects(
    lib.runPool([1, 2, 3, 4, 5, 6], 1, async (n) => {
      done.push(n);
      if (n === 2) controller.abort();
    }, null, controller.signal),
    { name: 'AbortError' },
  );
  assert.deepEqual(done, [1, 2]);
});
