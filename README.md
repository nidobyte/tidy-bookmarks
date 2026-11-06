# Tidy Bookmarks

_by [Nidobyte](https://github.com/nidobyte)_

A Chrome extension that cleans up your bookmarks: duplicates, empty folders and broken links.
Everything runs in your browser. No account, no servers, no tracking.

## Features

- **Duplicates** — finds pages saved more than once, even when the links differ slightly
  (`http`/`https`, `www.`, a trailing `/`, `utm_` tracking parameters). The oldest copy is kept by default.
- **Empty folders** — finds folders with no bookmarks inside, including nested empty folders.
- **Broken links** — checks every saved page and separates pages that are definitely gone (404/410)
  from ones that only need a look (blocked, slow or server errors).
- **Safe deletion** — a full backup in the standard bookmarks HTML format downloads before anything is deleted.
  Import it from Chrome's Bookmark manager to undo.

## Privacy

- The only permission requested at install is `bookmarks`.
- Access to websites is an optional permission, requested only when you press **Check links**.
  Pages are requested without cookies, and the results never leave your browser.
- See [PRIVACY.md](PRIVACY.md).

## Install for development

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and select this folder.
3. Click the extension icon in the toolbar.

## Tests

The core logic lives in `lib.js` and has no Chrome dependencies.

```bash
node --test tests/lib.test.js
```

## Project structure

| File | What it does |
|---|---|
| `manifest.json` | Extension name, version and permissions |
| `background.js` | Opens the app page when the icon is clicked |
| `app.html` / `app.css` | The page layout and styles |
| `app.js` | Reads bookmarks, checks links, renders the page, deletes |
| `lib.js` | Pure logic: URL normalizing, duplicates, empty folders, backup file |
| `tests/` | Tests for `lib.js` |

## License

MIT
