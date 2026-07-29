# Markwise

A desktop Markdown editor with Typora-style inline editing. Open a `.md` file
and you see the rendered document while editing it directly in place. There is
no raw-markdown split pane, server, subscription, or runtime dependency on the
network.

<p align="center">
  <img src="app/icon.svg" width="120" alt="Markwise icon">
</p>

Markwise uses the open-source [Milkdown](https://milkdown.dev) editor. The
editor and all of its assets are bundled into the installed application.

## Features

- Seamless WYSIWYG editing for headings, emphasis, lists, tables, links, images,
  blockquotes, and syntax-highlighted code blocks
- Multiple document windows
- Open, Save, Save As, find-in-page, and document outline actions
- Embedded pasted and dropped images
- Markdown file association and default-handler registration
- Fully bundled editor with no server
- macOS 12+ and 64-bit Ubuntu Linux support

## Install on Ubuntu

The Ubuntu build uses Electron as the desktop host. Building requires:

- Ubuntu 22.04 or newer on x86-64 or ARM64
- Node.js 22.12 or newer
- npm
- `bubblewrap` on Ubuntu configurations that restrict unprivileged user
  namespaces

Confirm the toolchain:

```bash
node -v
npm -v
```

Then build and install:

```bash
git clone https://github.com/Morhc/Markwise.git
cd Markwise
./install.sh
```

The installer performs deterministic `npm ci` installs, packages the
application, and installs it for the current user. It does not use `sudo`.
Files are installed under the XDG data directory, normally:

```text
~/.local/share/markwise/
~/.local/share/applications/com.josh.markwise.desktop
~/.local/share/mime/packages/com.josh.markwise.xml
~/.local/bin/markwise
```

It also registers Markwise as the default handler for `text/markdown` and
`text/x-markdown`. Launch it from the desktop application menu or run:

```bash
~/.local/bin/markwise
~/.local/bin/markwise README.md
```

### Ubuntu build only

```bash
npm ci
npm --prefix linux ci
./build.sh
./dist/Markwise-linux-x64/markwise
```

On ARM64, the output directory is `dist/Markwise-linux-arm64`.

## Install on macOS

The macOS build uses the original Swift, AppKit, and WebKit host. Building
requires:

- macOS 12 or newer
- Node.js 18 or newer
- npm
- Swift from Xcode Command Line Tools

```bash
git clone https://github.com/Morhc/Markwise.git
cd Markwise
npm ci
./install.sh
```

The installer builds `Markwise.app`, copies it to `/Applications`, registers it
with Launch Services, and makes it the default `.md` application.

### macOS build only

```bash
npm ci
./build.sh
open ./Markwise.app
```

## Usage

| Action | macOS | Linux |
|---|---|---|
| New | Command+N | Ctrl+N |
| Open | Command+O | Ctrl+O |
| Save | Command+S | Ctrl+S |
| Save As | Shift+Command+S | Ctrl+Shift+S |
| Find | Command+F | Ctrl+F |
| Find next | Command+G | Ctrl+G |
| Find previous | Shift+Command+G | Ctrl+Shift+G |
| Document outline | Option+Command+O | Ctrl+Alt+O |

Open a file, edit it inline, and save it with the platform shortcut.

## Architecture

The editor is shared by both platforms. `build.mjs` bundles Milkdown and all
CSS, fonts, and icons into local web assets.

| Concern | Location |
|---|---|
| Editor behavior and host bridge | `src/editor.js` |
| macOS Swift host | `swift/main.swift` |
| Linux Electron host | `electron/main.cjs` |
| Restricted Electron preload bridge | `electron/preload.cjs` |
| Linux packaging and desktop integration | `linux/` |
| HTML shell and custom styles | `app/web/index.html` |
| Platform-aware build | `build.sh` |
| Platform-aware install | `install.sh` |

The Electron renderer has Node.js integration disabled. It uses context
isolation and Chromium process sandboxing, exposes only the editor message
bridge, rejects unexpected IPC senders, blocks in-app navigation, and
allowlists external URL protocols. On Ubuntu 24.04 systems that apply AppArmor
restrictions to unprivileged user namespaces, the launcher enters the permitted
`bubblewrap` namespace before Electron creates its renderer sandbox. It does
not use Electron's unsafe `--no-sandbox` option.

## Developing

Run the checks before building:

```bash
npm ci
npm run check
npm test
```

For Linux packaging, also install the isolated packaging toolchain:

```bash
npm --prefix linux ci
./build.sh
```

Build outputs are written to `Markwise.app` on macOS or `dist/` on Linux.

## Rebuilding the macOS icon

Edit `app/icon.svg`, then run this on macOS:

```bash
./make-icon.sh && ./build.sh
```

## License

MIT
