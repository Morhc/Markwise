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
- Relative image paths and localized pasted or dropped images
- KaTeX equations, superscript, subscript, and editable Markdown source on macOS
- System-aware dark mode
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
| Markdown source | Command+/ | - |
| Reload from disk | Command+R | - |
| Show in file manager | Option+Command+R | - |
| Superscript | Control+Command++ | - |
| Subscript | Control+Command+- | - |

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

**Working with equations.** Type `$x^2$` to create one. Click a rendered
equation to reopen its LaTeX in a small field with a live preview. Enter
commits, Escape cancels, and clearing the field deletes the equation. Two
equations separated by a single space merge into one when you delete the space,
since `$a$$b$` isn't valid markdown for two.

Superscript also answers to ⌃⌘= if you'd rather not reach for Shift.

**Reloading.** ⌘R re-reads the file from disk, which is how you pick up edits
made by another program. What it does depends on where the changes are:

| On disk | In the editor | ⌘R does |
|---|---|---|
| unchanged | unchanged | says the file is already up to date |
| changed | unchanged | reloads |
| unchanged | unsaved edits | **saves them** because there is nothing to reload |
| changed | unsaved edits | presents a real conflict |

On a real conflict you get four choices. **Merge Both** is the one that loses
nothing: it merges the two against the text as you opened it, so edits that
don't overlap are simply combined, and only lines both versions changed are
marked up, in place, in the one file:

```
MARKWISE CONFLICT: YOUR VERSION (unsaved)
the line as you wrote it
MARKWISE CONFLICT: ON DISK (changed by another program)
the line as the other program wrote it
MARKWISE CONFLICT: END OF CONFLICT
```

Delete the version you don't want along with the three marker lines. (They all
use Markdown-safe text rather than git's marker characters, which Markdown can
reinterpret as headings and blockquotes on the next save.)

The other choices are **Reload from Disk** (take theirs), **Keep My Version**
(take yours), and **Cancel**.

**Images.** Anything you paste or drop is written into an `images/` folder next
to the document and linked as `images/name.png`, so the markdown stays portable
and doesn't carry base64. An image copied from a web page is downloaded once so
the document doesn't depend on that server later. Untitled documents have no
folder to write into, so images stay embedded until you save the file somewhere.

## Project layout

```
markwise/
├── src/editor.js      # Editor logic + JS↔Swift bridge (Milkdown Crepe)
├── src/latex.js       # Inline-equation editing and merging
├── src/supsub.js      # <sup>/<sub> marks + markdown round-tripping
├── src/imageblock.js  # Keeps image alt text out of Milkdown's ratio field
├── src/codeblock.js   # Code-block theme and language list
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
