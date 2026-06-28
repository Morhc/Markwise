# Markwise (Windows)

A tiny, native **Windows** Markdown editor with **Typora-style inline editing**. Open a
`.md` file and you see the *rendered* document — headings, bold, lists, tables,
syntax-highlighted code — and you edit it directly in place. No raw `#` and `**`
clutter, no split-pane preview, no subscription.

<p align="center">
  <img src="app/icon.svg" width="120" alt="Markwise icon">
</p>

It's a small [Tauri 2](https://tauri.app) app: a Rust host that drives the system
**WebView2** runtime hosting the open-source [Milkdown](https://milkdown.dev) editor,
bundled to run fully offline.

> This is the **`windows` branch**. The original macOS app (Swift + WebKit) lives on
> `main`. Both share the same web editor (`src/`, `app/web/`); only the native host
> differs. See [AGENTS.md](AGENTS.md) for the build/install runbook and architecture.

## Features

- **Seamless WYSIWYG** — type `# ` and it becomes a heading; `**bold**` renders inline.
- **Set it as your default `.md` app** — double-click any markdown file to open it rendered.
- **Editable everything** — headings, lists, tables, blockquotes, code blocks, links.
- **Auto-linking** — type `[text](url)` and it converts to a real (blue) link.
- **Native Windows** — real window, menu bar, Open/Save dialogs, Ctrl+S to save, recent files, find-in-page.
- **Self-contained & offline** — the editor is bundled into the app; no network needed.

## Requirements

- Windows 10/11 with the **WebView2 runtime** (preinstalled on Windows 11; the installer
  fetches it automatically if missing).
- To build:
  - [Node.js](https://nodejs.org) 18+ (bundles the editor)
  - The [Rust toolchain](https://rustup.rs) (MSVC) + **"Desktop development with C++"**
    workload from the Visual Studio Build Tools

## Build & install

```powershell
git clone https://github.com/Morhc/Markwise.git
cd Markwise
git checkout windows

npm install                       # fetch the editor + the Tauri CLI (build-time only)
npx tauri icon app/icon.svg       # one-time: generate src-tauri/icons/ (incl. icon.ico)
npx tauri build                   # bundles the editor, compiles Rust, builds installers
```

The installers are written to:

```
src-tauri/target/release/bundle/nsis/Markwise_0.1.0_x64-setup.exe
src-tauri/target/release/bundle/msi/Markwise_0.1.0_x64_en-US.msi
```

Run either installer. (For a quick dev run without installing, use `npx tauri dev`.)

## Set as the default app for `.md` files

The installer registers Markwise as a handler for markdown extensions. To make it the
default: right-click any `.md` file → **Open with** → **Choose another app** → pick
**Markwise** → check **Always use this app**.

## Usage

| Action      | Shortcut     |
|-------------|--------------|
| New         | Ctrl+N       |
| Open        | Ctrl+O       |
| Save        | Ctrl+S       |
| Save As     | Ctrl+Shift+S |
| Close       | Ctrl+W       |
| Find        | Ctrl+F       |
| Find Next   | Ctrl+G       |
| Full screen | F11          |

Open a file, edit it inline, press Ctrl+S. That's it.

## Project layout

```
markwise/
├── src/                  # shared, cross-platform editor (reused verbatim from main)
│   ├── editor.js         #   editor logic + window.MW bridge (Milkdown Crepe)
│   └── codeblock.js      #   CodeMirror theme + languages
├── app/
│   ├── web/              #   HTML shell + built bundle (bundle.js / bundle.css)
│   └── icon.svg          #   app icon source
├── build.mjs             # esbuild config (bundles the editor into one JS+CSS)
├── src-tauri/            # the Windows host
│   ├── src/lib.rs        #   window, menus, open/save, dirty state, the JS↔Rust bridge
│   ├── src/init.js       #   webkit→Tauri bridge shim + find-in-page overlay
│   ├── tauri.conf.json   #   app metadata, file associations, bundling
│   └── Cargo.toml
└── package.json          # `dev` / `build` / `bundle` scripts
```

## License

MIT
