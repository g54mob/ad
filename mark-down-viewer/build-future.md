# Markdown.View Electron — Build Instructions

## Files Created (in order)

| # | File | Purpose |
|---|------|---------|
| 1 | `package.json` | Dependencies, scripts, electron-builder config |
| 2 | `main.js` | Main process — window, IPC, chokidar watcher, folder scanner, window bounds, Ctrl+Tab/W interception |
| 3 | `preload.js` | Bridge — `window.electronAPI` with all IPC methods + event listeners |
| 4 | `index.html` | Full UI — header, file tabs bar, view-mode tabs, file sidebar, TOC, find bar, context menu, status bar, landing page. All CSS inline. Mermaid CDN |
| 5 | `renderer.js` | All renderer logic — marked.js, hljs, mermaid, image resolution, file tabs, tree, editor, TOC, zoom, find, theme, sliders, dirty tracking, live reload |
| 6 | `sample.md` | Demo file exercising all features |

## Prerequisites

- **Node.js >= 18.x** (required by Electron 28+). Verify: `node --version`
- **npm** (comes with Node.js)

## Setup (from scratch)

```powershell
# 1. Create the folder
mkdir markdown-viewer-electron
cd markdown-viewer-electron

# 2. Create all files above (package.json, main.js, preload.js, index.html, renderer.js)

# 3. Install dependencies
npm install

# 4. Run the app
npx electron .
```

## Key Dependencies

| Package | Version | Why |
|---------|---------|-----|
| `electron` | ^28.1.0 | Desktop shell (Chromium + Node.js) — devDependency |
| `chokidar` | ^3.6.0 | OS-level file watching (add/change/unlink events) |
| `marked` | ^9.1.6 | Markdown to HTML parser |
| `highlight.js` | ^11.9.0 | Syntax highlighting for code blocks |
| `lz-string` | ^1.5.0 | Compression (kept from original HTML viewer) |
| `electron-builder` | ^24.9.1 | Package into .exe installer — devDependency |
| `mermaid` | ^10 (CDN) | Diagram rendering (flowcharts, sequence, gantt, etc.) — loaded via CDN in index.html |

## Architecture

```
main.js (Main Process)
  ├── Creates BrowserWindow (persists size/position/maximized state)
  ├── IPC handlers: pick-folder, read-file, save-file, save-file-as, scan-dir,
  │   watch-dir, stop-watch, show-in-explorer, open-folder-in-explorer
  ├── chokidar.watch() → sends fs-add, fs-change, fs-unlink to renderer
  ├── Intercepts Ctrl+Tab/Ctrl+W via before-input-event → sends switch-tab/close-tab
  ├── Recursive directory scanner (skips dotfiles, node_modules)
  └── Window bounds save/restore via %APPDATA%/window-bounds.json

preload.js
  └── window.electronAPI (IPC invoke/send wrappers + event listeners)

index.html + renderer.js (Renderer Process)
  ├── File tabs bar: multi-file tabs, close (x/middle-click), Ctrl+Tab round-robin, Ctrl+W
  ├── File sidebar: tree with branch lines, collapsible (Alt+click recursive), collapse-all,
  │   search filter, file count, right-click context menu, resizable (drag edge)
  ├── Markdown: marked.js + custom renderer (headings, code, tables, blockquotes, callouts,
  │   footnotes, math, task lists, mermaid diagrams, relative image resolution)
  ├── View modes: Raw (editor + line numbers), Preview (rendered + TOC), Split (draggable)
  ├── TOC sidebar: auto-generated, intersection observer, resizable
  ├── Live reload: chokidar changes auto-reload across all open tabs
  ├── Dirty tracking: title *, tab dot, auto-save 3s, Ctrl+S instant
  ├── Find: Ctrl+F, window.find(), Enter/Shift+Enter navigate, Escape close
  ├── Zoom: Ctrl+/-, Ctrl+scroll, Ctrl+0 reset, zoom % in status bar (persisted)
  └── Theme, font slider, width slider, DM Mono font, landing page with hero branding + recent folders
```

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+Tab` | Next file tab (round-robin) |
| `Ctrl+Shift+Tab` | Previous file tab (round-robin) |
| `Ctrl+W` | Close current file tab |
| `Ctrl+S` | Save current file |
| `Ctrl+F` | Find in page |
| `Ctrl+Enter` | Switch to Preview |
| `Ctrl+` / `Ctrl-` | Page zoom in/out |
| `Ctrl+0` | Reset zoom to 100% |
| `Ctrl+scroll` | Page zoom in/out |
| `Alt+click folder` | Recursive expand/collapse subtree |
| `Escape` | Close find bar / cancel rename |
| `Tab` (in editor) | Insert 4 spaces |
| `Middle-click tab` | Close that tab |

## Config Choices

- `nodeIntegration: true` + `contextIsolation: false` — allows `require()` in renderer. Safe: local-only app.
- highlight.js CSS from `./node_modules/highlight.js/styles/atom-one-dark.min.css` (local).
- mermaid.js from CDN (`cdn.jsdelivr.net/npm/mermaid@10`). Requires internet on first load.
- DM Mono font from Google Fonts CDN. Offline fallback: Consolas/system monospace.
- Window bounds saved to `%APPDATA%/markdown-viewer-electron/window-bounds.json`.

## Build .exe Installer

```powershell
# Requires electron-builder (already in devDependencies)
npm run build
# Output: dist/ folder with .exe installer
```

## Ported from Original HTML Viewer

Everything from `web-tools/markdown-viewer.html` is preserved:
- Dark/light theme with identical CSS variables
- All markdown styles (headings, lists, task lists, tables, blockquotes, callouts, code blocks, footnotes, math, images, kbd, abbreviations)
- Raw editor with line numbers, current-line highlight, tab-to-spaces, auto-pairs, list continuation
- Preview with TOC sidebar (auto-generated, intersection observer for active heading)
- Split view with draggable divider (position persisted)
- Code block copy buttons, language badges
- Preview width slider, font size slider
- Stats bar (words, lines, chars, read time)
- Drag and drop .md files

## What's New (Electron-only)

- **File tabs** — open multiple files in browser-style tabs. Close with x, middle-click, or Ctrl+W. Ctrl+Tab/Ctrl+Shift+Tab round-robin cycle. Each tab saves scroll position, view mode, dirty state
- **File sidebar** — tree hierarchy with branch lines, SVG outline file icons, collapsible folders (Alt+click recursive), collapse-all button, path input field, resizable (180-500px), right-click context menu (Show in Explorer, Open folder, Copy path)
- **TOC sidebar resizable** — drag right edge (160-400px), width persisted
- **Mermaid diagrams** — fenced mermaid code blocks render as SVG diagrams
- **Image preview** — relative image paths resolve to file:// URLs based on current file directory
- **Live file watching** — chokidar monitors directory, updates all open tabs
- **Auto-reload** — externally edited files refresh if no local unsaved edits
- **Auto-save** — saves to disk after 3s idle. Ctrl+S for instant save
- **Dirty tracking** — title bar `*`, tab dot indicator
- **Find in page** — Ctrl+F, live search, Enter/Shift+Enter navigate, match counter
- **Page zoom** — Ctrl+/-, Ctrl+scroll, Ctrl+0 reset. Zoom % in status bar, persisted
- **Window state** — size, position, maximized state restored on next launch
- **Landing hero** — branded logo badge, title + tagline, subtle accent radial glow background, single Open Folder CTA in the card footer
- **Recent folders** — landing page shows clickable folder history
- **Folder path input** — paste a path and press Enter to open
- **Filename rename** — click header filename to rename
- **Social links** — GitHub + Discord icons on landing page
- **Folders start collapsed** — cleaner initial view
- **DM Mono font** — same monospace as Claude.ai