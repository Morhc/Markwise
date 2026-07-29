# AGENTS.md — Markwise on Windows (agent-facing)

Deterministic instructions to build, install, verify, and troubleshoot Markwise on
**Windows** (the `windows` branch), plus the architecture you need to change it safely.
Prefer exact commands; verify each step's output before continuing. Commands are PowerShell.

## What this is

Markwise is a native Windows app: a **Tauri 2** Rust host that drives the system
**WebView2** runtime, hosting a bundled [Milkdown Crepe](https://milkdown.dev) WYSIWYG
markdown editor loaded from local files. There is no server and no runtime network
dependency. The build produces `Markwise.exe` plus NSIS/MSI installers.

The macOS app (Swift + WebKit) lives on `main`. The web editor layer (`src/`, `app/web/`,
`build.mjs`) is **shared, not forked**: it is kept byte-identical to `main` by *merging*
`main` into `windows`, never by cherry-picking. A real merge advances the merge base, so
the next sync only has to consider new commits; cherry-picking would leave the base pinned
and re-present the same `swift/main.swift` / `build.sh` conflicts forever.

Last sync: `3307d26` (main @ `9dd33af`). Resolve a merge by keeping the macOS host files
deleted (`git rm swift/main.swift build.sh install.sh`) and keeping the Windows docs
(`git checkout --ours README.md AGENTS.md`). Then verify — this must print nothing:

```powershell
git diff --stat origin/Mac -- src/ app/web/index.html build.mjs
```

Only the native host differs (`src-tauri/` here vs `swift/` on `main`).

---

# Build & install runbook

## 0. Environment assumptions

- Platform: Windows 10/11 (x64).
- Working directory: the repository root (contains `src-tauri/`, `package.json`).
- WebView2 runtime present (default on Win11; the installer can bootstrap it otherwise).

## 1. Verify prerequisites

```powershell
node -v          # expect >= 18
npm -v
rustc --version  # Rust (MSVC toolchain)
cargo --version
```

If `rustc`/`cargo` are missing: install via https://rustup.rs and the Visual Studio
Build Tools "Desktop development with C++" workload (provides the MSVC linker).
If `node` is missing: install Node.js 18+.

## 2. Install build-time dependencies

```powershell
npm install
```

Installs `@milkdown/crepe` (editor), `esbuild` (bundler), and `@tauri-apps/cli`.
These are **build-time only** — not shipped inside the app. Rust crates are fetched
by cargo on first build.

## 3. Generate icons (one-time, or when app/icon.svg changes)

```powershell
npx tauri icon app/icon.svg   # writes src-tauri/icons/ (32x32.png, 128x128.png, icon.ico, ...)
```

`src-tauri/icons/` is gitignored; the build requires it, so run this before the first build.

## 4. Build

```powershell
npx tauri build
```

`tauri build` performs, in order:
1. `npm run bundle` (the `beforeBuildCommand`) — esbuild bundles `src/editor.js` + all
   CSS/fonts/icons into self-contained `app/web/bundle.js` + `app/web/bundle.css`
   (assets inlined as data URIs).
2. Compiles `src-tauri/src/*.rs` (release) into `Markwise.exe`.
3. Bundles NSIS + MSI installers (registers `.md` file associations, bootstraps WebView2).

For fast iteration:

```powershell
npx tauri dev                  # bundle + run the app (debug, no install)
npx tauri dev -- -- README.md  # also test opening a file via argv
node build.mjs                 # re-bundle JS/CSS only (when editing src/*.js)
```

## 5. Verify the build

```powershell
Test-Path src-tauri\target\release\markwise.exe                          # True
Test-Path app\web\bundle.js                                              # True (regenerated)
Get-ChildItem src-tauri\target\release\bundle\nsis\*setup.exe            # NSIS installer
Get-ChildItem src-tauri\target\release\bundle\msi\*.msi                  # MSI installer
```

## 6. Install / set as default handler

Run the NSIS installer: `src-tauri\target\release\bundle\nsis\Markwise_0.1.0_x64-setup.exe`.
It registers Markwise as a handler for `.md` (and related) extensions. To make it the
default: right-click a `.md` file → **Open with → Choose another app → Markwise →
Always**.

---

# Architecture

Two halves talk over a tiny bridge; understanding the contract is the key to working here.

- **`src/editor.js`** (shared, do NOT fork) — wraps Milkdown Crepe and defines `window.MW`.
  esbuild (`build.mjs`) bundles it + all CSS/fonts/icons into self-contained
  `app/web/bundle.js` + `bundle.css`, inlining assets as data URIs so the app needs no
  `node_modules` at runtime.
- **`src-tauri/src/lib.rs`** — the Windows host (analog of the macOS `AppDelegate` +
  `DocumentWindow`): document windows, per-window menu bars, Open/Save dialogs, dirty-state,
  recent files, find toggling, external links, image drops, argv / file-association handling,
  and the single IPC command `bridge_message`.
- **`src-tauri/src/init.js`** — injected as an `initialization_script` BEFORE `bundle.js`. It
  does the one thing that makes cross-platform reuse work (the bridge shim, below), plus the
  find-in-page overlay, the "change image source" prompt, and the local-path image rewrite.
- **`app/web/index.html`** (shared) — HTML shell that loads the bundle + custom CSS.
- **`src/codeblock.js`** (shared) — CodeMirror theme + language list.

## Where to change things

| Concern | File | Notes |
|---|---|---|
| Editor behavior, JS↔native bridge | `src/editor.js` | `window.MW.open(md)` / `getMarkdown()` / `markSaved()`; posts `{type}` to `webkit.messageHandlers.bridge`. **Shared with macOS — do not fork.** |
| `webkit`→Tauri shim, find bar, image prompt, local-image rewrite | `src-tauri/src/init.js` | Injected before `bundle.js`; routes `postMessage` to `bridge_message`. **The only sanctioned place for Windows-specific UI** — keeps `editor.js` unforked. |
| Windows, menus, open/save, dirty state, recent, argv, drops, links | `src-tauri/src/lib.rs` | Tauri host (the analog of the macOS `AppDelegate` + `DocumentWindow`). |
| HTML shell + custom CSS | `app/web/index.html` | Loads `bundle.js` / `bundle.css`. Shared with macOS. |
| Bundler config / asset inlining | `build.mjs` | esbuild; non-CSS assets use `dataurl`. Shared with macOS. |
| App metadata, file associations, bundling | `src-tauri/tauri.conf.json` | `fileAssociations`, identifier `com.josh.markwise`, NSIS/MSI targets. |
| Webview permissions | `src-tauri/capabilities/default.json` | `core:default`; dialogs/FS run Rust-side, so no plugin perms exposed to JS. |

## The bridge contract (the critical interface)

`editor.js` posts to `window.webkit.messageHandlers.bridge` — a WKWebView API that does not
exist in WebView2. Rather than fork `editor.js`, **`init.js` shims that object** and forwards
to `invoke('bridge_message', { msg })`. This is the whole reason the web layer can stay
byte-identical to `main`, and the shared layer never references `window.__TAURI__`.

| Direction | Message | Handled by | Notes |
|---|---|---|---|
| JS→native | `ready` | `lib.rs` | flushes `pending_path` for this window |
| JS→native | `opened` | — | no-op |
| JS→native | `dirty` / `clean` | `lib.rs` | drives the `•` title marker |
| JS→native | `openLink {href}` | `lib.rs` | http/https/mailto allowlist → `ShellExecuteW` |
| JS→native | `editImage {src}` | **`init.js`** | intercepted before Rust; shows the HTML prompt |
| JS→native | `chooseImage` | `lib.rs` | **Windows-only**, emitted by `init.js` |
| JS→native | `imageFromPath {path}` | `lib.rs` | **Windows-only**, emitted by `init.js` |
| native→JS | `MW.open(<json>)` | | loads a document |
| native→JS | `MW.getMarkdown()` | | read back via `eval_with_callback` |
| native→JS | `MW.markSaved()` | | resets the dirty baseline |
| native→JS | `MW.setOutline(<bool>)` | | native is the source of truth |
| native→JS | `MW.setImageSrc(<json>)` | | `''` = cancel; clears the pending image position |
| native→JS | `MW.insertImages(<json>, x, y)` | | CSS pixels, top-left origin |
| native→JS | `__mwSetDocDir(<json>)` | | **Windows-only**; relative-image resolution root |

The three Windows-only JS→native messages and `__mwSetDocDir` all originate in `init.js`.
That is the only sanctioned divergence — nothing Windows-specific belongs in `editor.js`.

## Four subtleties that drive the design

1. **`ready` gating.** A file opened before the editor signals `ready` (CLI arg / file
   association at startup) is stashed in `Doc::pending_path` and opened only once `bridge_message`
   receives `ready`. Don't `eval` into `window.MW` before then.
2. **Dirty tracking via baseline.** `editor.js` compares current markdown to a `baseline` string
   (with a `loading` flag + double-`requestAnimationFrame` settle) and emits `dirty`/`clean`.
   This lives entirely in the shared `editor.js` — Rust just receives the result. Preserve it.
3. **`getMarkdown` is async on Windows.** `eval` is fire-and-forget (unlike WKWebView's completion
   handler), so `fetch_markdown` in `lib.rs` uses `Webview::eval_with_callback` and blocks a
   **background** thread on a channel. Never call `fetch_markdown` from the main thread — the
   WebView2 script-completion callback is delivered on the UI thread, so it would deadlock.
   (It used to route through a global one-shot channel plus a `get_markdown_result` command;
   with one window per document that global slot was a race — two concurrent saves would have
   had the second `take()` the first's sender.)
4. **Rust owns file drops, not the webview.** `WebviewAttributes::drag_drop_handler_enabled`
   defaults to `true`, which makes wry intercept WebView2's drop and forward it to Rust as
   `WindowEvent::DragDrop`; the page never sees an HTML5 `drop` event. So Crepe's `uploadConfig`
   uploader in `editor.js` fires **only on paste** here, though it handles both on macOS. Do not
   set `dragDropEnabled: false` or call `.disable_drag_drop_handler()` unless you also delete the
   Rust handler — that hands drops back to the webview and both layers would insert the image.
   Note `DragDropEvent`'s `position` is in **physical** pixels while `posAtCoords()` wants CSS
   pixels; the scale-factor division is invisible at 100% display scaling and wrong above it.

## Conventions

- File-type associations, bundle id (`com.josh.markwise`), version, and installer targets live
  in `src-tauri/tauri.conf.json` (`bundle.fileAssociations`).
- Windows are created in `lib.rs` (`make_document_window`, not in config) so the init script,
  per-window menu and navigation hooks can be attached; `app.windows` in `tauri.conf.json` is
  intentionally empty.
- **One window per document**, labelled `doc-N`. Per-window state lives in `AppState.docs`
  keyed by label; `recent` is app-wide. Each window owns its **own menu bar** — never use
  `App::set_menu`, which on non-macOS pushes the same menu into every window (it would clobber
  each window's outline checkmark). `on_menu_event` hands you the originating window, so
  nothing has to guess which document is active.
- macOS's `validateMenuItem` greying and its Window menu are deliberately **not** ported: on
  Windows the menu bar lives inside a window, so "no window open" cannot happen.
- `security.csp` is `null`, so no CSP header is injected and `img-src` is unrestricted. **If a
  CSP is ever set it must include `img-src 'self' data: http://asset.localhost`**, or embedded
  and local-path images stop rendering.
- Dialogs and file I/O run Rust-side, so the webview capability (`capabilities/default.json`) only
  grants `core:default`; the app's own commands are always callable.
- The 3-way "Save / Don't Save / Cancel" prompt uses a Win32 `MessageBoxW` (`confirm_discard`)
  because the dialog plugin only expresses 2-button outcomes.
- Build outputs (`app/web/bundle.{js,css}`, `src-tauri/target/`, `src-tauri/icons/`) are
  gitignored — don't commit them.
- Full screen is F11 (Windows convention); Find is Ctrl+F.

## Status / known limitations

- **Verified building and running** with Tauri 2.11.3 (Rust 1.96, Node 24 LTS): `cargo build`
  is clean, the app launches, the native menus render, and opening a `.md` file (including via
  single-instance argv forwarding) renders it WYSIWYG.
- **Recent files menu** rebuilds per window (`refresh_menus`) after each open/save; each rebuild
  is seeded with that window's outline state so the checkmark survives.
- **Images are embedded, not linked.** Dropped and picked images become base64 `data:` URIs, so
  the `.md` stays self-contained but grows; `MAX_IMAGE_BYTES` caps a single image at 8 MB.
- **Relative image paths** (`![](./img/a.png)`) only resolve once a document has been saved —
  an unsaved document has no directory for `__mwSetDocDir`. Absolute paths always work.
- **Predefined Edit-menu items** (undo/redo/cut/copy/paste/select-all) rely on WebView2 routing;
  the keyboard shortcuts work natively regardless.

---

# Troubleshooting

- **`npm install` fails**: check network/registry (`npm ping`).
- **`cargo`/linker errors**: install the MSVC toolchain via rustup + VS Build Tools
  "Desktop development with C++".
- **Build fails on missing icon**: run `npx tauri icon app/icon.svg` (step 3).
- **Window opens blank**: confirm `app/web/bundle.js` exists and is non-empty; re-run
  `npm run bundle`. The window loads `index.html` from `frontendDist` (`../app/web`).
  A blank editor with no document is normal (empty doc = white page).
- **Edits don't save**: saving reads markdown back asynchronously via `eval_with_callback`;
  ensure the editor reported `ready` first (the title should show a filename, not stay blank).
- **"Windows protected your PC" (SmartScreen)**: the app is unsigned. Click **More info →
  Run anyway**. Code signing is out of scope for a local build.
- **File association not working**: associations are written by the installer, not by
  `tauri dev`. Install the NSIS/MSI build, then set the default via *Open with*.
- **Dropped images land in the wrong paragraph**: the scale-factor division in `handle_drop`.
  It looks correct at 100% display scaling and only misbehaves above it — test at 150%/200%.
- **A link opens nothing, or the app window goes blank on launch**: `on_navigation` in
  `make_document_window`. The frontend is served from `http://tauri.localhost`, which is
  scheme `http`, so `is_app_url` must match before the external-scheme branch runs.
- **`cargo build` is slow or locks**: the repo sits under OneDrive. Set `CARGO_TARGET_DIR` to a
  path outside the synced tree.

# Clean

```powershell
Remove-Item -Recurse -Force node_modules, src-tauri\target, app\web\bundle.js, app\web\bundle.css -ErrorAction SilentlyContinue
```
