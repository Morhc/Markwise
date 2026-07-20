# Markwise

A tiny, native macOS Markdown editor with **Typora-style inline editing**. Open a
`.md` file and you see the *rendered* document — headings, bold, lists, tables,
syntax-highlighted code — and you edit it directly in place. No raw `#` and `**`
clutter, no split-pane preview, no subscription.

<p align="center">
  <img src="app/icon.svg" width="120" alt="Markwise icon">
</p>

It's a small Swift + WebKit app (a few MB) that hosts the open-source
[Milkdown](https://milkdown.dev) editor, bundled to run fully offline.

## Features

- **Seamless WYSIWYG** — type `# ` and it becomes a heading; `**bold**` renders inline.
- **Set it as your default `.md` app** — double-click any markdown file to open it rendered.
- **Editable everything** — headings, lists, tables, blockquotes, code blocks, links.
- **Auto-linking** — type `[text](url)` and it converts to a real (blue) link.
- **Native macOS** — real window, menus, Open/Save dialogs, ⌘S to save, recent files.
- **Self-contained & offline** — the editor is bundled into the app; no network needed.

## Requirements

- macOS 12 (Monterey) or newer
- To build: [Node.js](https://nodejs.org) 18+ and the Swift toolchain
  (Xcode Command Line Tools: `xcode-select --install`)

## Build & install

```bash
git clone https://github.com/Morhc/Markwise.git
cd Markwise
npm install        # fetch the editor + bundler (build-time only)
./install.sh       # build, install to /Applications, and set as the default .md app
```

`install.sh` runs `build.sh`, copies the app to `/Applications`, registers it with
Launch Services, and makes it the default handler for `.md` files. Run it again any
time to reinstall the latest build.

### Build only (no install)

```bash
./build.sh         # bundles the editor, compiles Swift, assembles ./Markwise.app
open ./Markwise.app
```

## Set as the default app for `.md` files

`./install.sh` already does this. To (re)apply it on its own without a full install:

```bash
swift -e 'import AppKit; LSSetDefaultRoleHandlerForContentType("net.daringfireball.markdown" as CFString, .all, "com.josh.markwise" as CFString)'
```

Or in Finder: right-click any `.md` → **Get Info** → **Open with: Markwise** →
**Change All…**. (Or, if you have [`duti`](https://github.com/moretension/duti):
`duti -s com.josh.markwise net.daringfireball.markdown all`.)

## Usage

| Action      | Shortcut |
|-------------|----------|
| New         | ⌘N       |
| Open        | ⌘O       |
| Save        | ⌘S       |
| Save As     | ⇧⌘S      |
| Close       | ⌘W       |
| Full screen | ⌘F       |

Open a file, edit it inline, press ⌘S. That's it.

## Project layout

```
markwise/
├── src/editor.js      # Editor logic + JS↔Swift bridge (Milkdown Crepe)
├── swift/main.swift   # Native macOS host: window, menus, file open/save
├── app/
│   ├── web/           # HTML shell + built bundle (bundle.js / bundle.css)
│   ├── icon.svg       # App icon source
│   └── AppIcon.icns   # Built icon
├── build.mjs          # esbuild config (bundles editor into one JS+CSS)
├── build.sh           # Full build: bundle → compile → assemble .app
├── install.sh         # Build + install to /Applications + set default .md handler
├── make-icon.sh       # Regenerate AppIcon.icns from icon.svg
└── Info.plist         # App metadata + Markdown file-type associations
```

## Developing

`build.sh` builds `./Markwise.app` in place and registers it with Launch Services.
Because this dev copy and the installed `/Applications/Markwise.app` share the same
bundle id (`com.josh.markwise`), **running `./build.sh` can quietly make the dev copy
the default `.md` handler again.** If double-clicking a `.md` starts opening the dev
build, just re-run `./install.sh` to point the default back at `/Applications`.

## Rebuilding the icon

Edit `app/icon.svg`, then:

```bash
./make-icon.sh && ./build.sh
```

## License

MIT
