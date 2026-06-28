# AGENTS.md — Markwise on Windows (agent-facing)

Deterministic instructions to build, install, verify, and troubleshoot Markwise on
**Windows** (the `windows` branch), plus the architecture you need to change it safely.
Prefer exact commands; verify each step's output before continuing. Commands are PowerShell.

## What this is

Markwise is a native Windows app: a **Tauri 2** Rust host that drives the system
**WebView2** runtime, hosting a bundled [Milkdown Crepe](https://milkdown.dev) WYSIWYG
markdown editor loaded from local files. There is no server and no runtime network
dependency. The build produces `Markwise.exe` plus NSIS/MSI installers.

The macOS app (Swift + WebKit) lives on `main`. The **web editor layer (`src/`, `app/web/`,
`build.mjs`) is shared verbatim** across both branches; only the native host differs
(`src-tauri/` here vs `swift/` on `main`).

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
- **`src-tauri/src/lib.rs`** — the Windows host (analog of the macOS `AppDelegate`): builds the
  window, native menu bar, Open/Save dialogs, dirty-state, recent files, find toggling, argv /
  file-association handling, and the two IPC commands `bridge_message` + `get_markdown_result`.
- **`src-tauri/src/init.js`** — injected as an `initialization_script` BEFORE `bundle.js`. It
  does the one thing that makes cross-platform reuse work (the bridge shim, below), plus
  implements the find-in-page overlay.
- **`app/web/index.html`** (shared) — HTML shell that loads the bundle + custom CSS.
- **`src/codeblock.js`** (shared) — CodeMirror theme + language list.

## Where to change things

| Concern | File | Notes |
|---|---|---|
| Editor behavior, JS↔native bridge | `src/editor.js` | `window.MW.open(md)` / `getMarkdown()` / `markSaved()`; posts `{type}` to `webkit.messageHandlers.bridge`. **Shared with macOS — do not fork.** |
| `webkit`→Tauri bridge shim + find bar | `src-tauri/src/init.js` | Injected before `bundle.js`; routes `postMessage` to the `bridge_message` command. |
| Native window, menus, open/save, dirty state, recent, argv | `src-tauri/src/lib.rs` | Tauri host (the analog of the macOS `AppDelegate`). |
| HTML shell + custom CSS | `app/web/index.html` | Loads `bundle.js` / `bundle.css`. Shared with macOS. |
| Bundler config / asset inlining | `build.mjs` | esbuild; non-CSS assets use `dataurl`. Shared with macOS. |
| App metadata, file associations, bundling | `src-tauri/tauri.conf.json` | `fileAssociations`, identifier `com.josh.markwise`, NSIS/MSI targets. |
| Webview permissions | `src-tauri/capabilities/default.json` | `core:default`; dialogs/FS run Rust-side, so no plugin perms exposed to JS. |

## The bridge contract (the critical interface)

- **native → JS** via `WebviewWindow::eval` (the analog of WKWebView's `evaluateJavaScript`):
  `window.MW.open(<json-string>)` loads a document; `window.MW.getMarkdown()` returns the
  current markdown; `window.MW.markSaved()` resets the dirty baseline after save.
  Because `eval` is fire-and-forget, `getMarkdown` is read back via the `get_markdown_result`
  command + a one-shot channel (`fetch_markdown` in `lib.rs`).
- **JS → native**: `editor.js` posts to `window.webkit.messageHandlers.bridge` (a WKWebView
  API that does not exist in WebView2). Rather than fork `editor.js`, **`init.js` shims that
  object** to forward `postMessage({type})` → `invoke('bridge_message', { msg })`. Rust handles
  `type` ∈ `{ ready, opened, dirty, clean }` in the `bridge_message` command. This is why
  `editor.js` is byte-for-byte identical to `main`. `ready` flushes any `pending_path` (a file
  opened before the editor finished loading).

## Three subtleties that drive the design

1. **`ready` gating.** A file opened before the editor signals `ready` (CLI arg / file
   association at startup) is stashed in `Doc::pending_path` and opened only once `bridge_message`
   receives `ready`. Don't `eval` into `window.MW` before then.
2. **Dirty tracking via baseline.** `editor.js` compares current markdown to a `baseline` string
   (with a `loading` flag + double-`requestAnimationFrame` settle) and emits `dirty`/`clean`.
   This lives entirely in the shared `editor.js` — Rust just receives the result. Preserve it.
3. **`getMarkdown` is async on Windows.** `eval` is fire-and-forget (unlike WKWebView's completion
   handler), so `fetch_markdown` in `lib.rs` evals a snippet that calls
   `invoke('get_markdown_result', { markdown: window.MW.getMarkdown() })` and blocks a
   **background** thread on a one-shot channel. Never call `fetch_markdown` from the main thread
   (it would deadlock the event loop that pumps the eval).

## Conventions

- File-type associations, bundle id (`com.josh.markwise`), version, and installer targets live
  in `src-tauri/tauri.conf.json` (`bundle.fileAssociations`).
- The window is created in `lib.rs` `setup` (not in config) so the init script can be attached;
  `app.windows` in `tauri.conf.json` is intentionally empty.
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
- **Recent files menu** rebuilds via `app.set_menu` after each open/save; if menu refresh proves
  flaky, the fallback is to rebuild only on launch.
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
- **Edits don't save**: saving reads markdown back asynchronously via `get_markdown_result`;
  ensure the editor reported `ready` first (the title should show a filename, not stay blank).
- **"Windows protected your PC" (SmartScreen)**: the app is unsigned. Click **More info →
  Run anyway**. Code signing is out of scope for a local build.
- **File association not working**: associations are written by the installer, not by
  `tauri dev`. Install the NSIS/MSI build, then set the default via *Open with*.

# Clean

```powershell
Remove-Item -Recurse -Force node_modules, src-tauri\target, app\web\bundle.js, app\web\bundle.css -ErrorAction SilentlyContinue
```
