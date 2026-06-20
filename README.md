# NoteYT — YouTube Markdown Notes

A Chrome Extension (Manifest V3) that injects a rich markdown note-taking panel into YouTube watch pages, with timestamp linking, autosave, and a full notes library.

## Features

- **WYSIWYG markdown editor** (TipTap/ProseMirror) injected directly into YouTube's sidebar
- **Timestamp linking** — pin individual notes to a video moment; click the chip to seek
- **SPA navigation survival** — panel persists across YouTube's video-to-video navigation
- **Autosave** with 800ms debounce, silent "Saved" indicator
- **Export single video** notes as a `.md` file
- **Notes Library** — full-tab page with search, sort, thumbnails, and zip export of all notes

## Install (development)

```bash
npm install
npm run build     # production bundle → dist/
npm run dev       # watch mode for development
```

Then in Chrome:
1. Go to `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** → select the `dist/` folder

## Project structure

```
src/
  content-script/
    inject.ts         — Panel mounting + SPA navigation detection
    editor.ts         — TipTap setup and toolbar
    player-bridge.ts  — Timestamp capture/seek logic
  background/
    service-worker.ts — Toolbar click → open library; message routing
  lib/
    storage.ts        — Typed chrome.storage.local get/set helpers
    export-md.ts      — Markdown file generation
  library/
    notes-library.html
    notes-library.ts  — Library grid, detail view, zip export
  styles/
    panel.css         — Content script panel (all classes prefixed .ynx-)
    library.css       — Library page (shadcn/ui-aesthetic dark theme)
manifest.json
webpack.config.js
tsconfig.json
```

## SPA navigation

YouTube doesn't do full page reloads between videos. The extension listens for YouTube's `yt-navigate-finish` DOM event (YouTube's own internal signal) to detect navigation. If that ever breaks, see the fallback MutationObserver block commented in `inject.ts`.

## Bundle size note

The content-script bundle is ~470KB unminified / ~140KB gzip. TipTap + ProseMirror account for the bulk of this — the tradeoff for getting a correct, cursor-safe WYSIWYG editor without building one from scratch. JSZip is only in the library bundle (not content script).

## Icons

Placeholder icons are provided. Replace `public/icons/icon16.png`, `icon48.png`, and `icon128.png` with real artwork before publishing.
