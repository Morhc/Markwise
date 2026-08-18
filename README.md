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
- **Auto-linking** — type `[text](url)` and it converts to a real (blue) link;
  double-click or ⌘-click a link to open it in your browser.
- **Math** — `$E = mc^2$` renders with KaTeX. Click an equation to edit its LaTeX
  with a live preview; delete the space between two equations to merge them.
- **Superscript & subscript** — ⌃⌘+ and ⌃⌘−, written out as the `<sup>`/`<sub>`
  HTML that GitHub, Pandoc and Typora all render.
- **See the raw markdown** — ⌘/ swaps the rendered view for an editable source
  view; edits made there flow back into the document.
- **Relative image paths** — `![](images/pic.png)` resolves against the file's own
  folder, and stays relative when saved.
- **Pasted images land on disk** — paste or drop a picture (including one copied
  from a web page) and it's written to an `images/` folder beside the document
  and linked relatively, instead of being inlined as a base64 blob.
- **Resizable images** — drag the corner handle; the size is saved as portable
  `<img … width="N">` HTML that GitHub, Typora and Pandoc all render.
- **Export as PDF** — ⇧⌘E, with scale, paper and margin options; the scale
  reflows the text rather than shrinking the page.
- **Text size** — set your reading size in Settings (⌘,); it scales the text,
  never the images, and doesn't leak into exports.
- **Spell checking** — the system spell checker, over the whole document as soon
  as it opens, with the usual Edit ▸ Spelling menu.
- **Dark mode** — follows the system by default; View ▸ Appearance pins it.
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

| Action              | Shortcut |
|---------------------|----------|
| New                 | ⌘N       |
| Open                | ⌘O       |
| Save                | ⌘S       |
| Save As             | ⇧⌘S      |
| Reload from disk    | ⌘R       |
| Show in Finder      | ⌥⌘R      |
| Export as PDF       | ⇧⌘E      |
| Settings            | ⌘,       |
| Close               | ⌘W       |
| Find                | ⌘F       |
| Markdown source     | ⌘/       |
| Document outline    | ⌥⌘O      |
| Appearance          | View menu |
| Superscript         | ⌃⌘+      |
| Subscript           | ⌃⌘−      |
| Full screen         | ⌃⌘F      |

Open a file, edit it inline, press ⌘S. That's it.

**Working with equations.** Type `$x^2$` to create one. Click a rendered
equation to reopen its LaTeX in a small field with a live preview — Enter
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
| unchanged | unsaved edits | **saves them** — there's nothing to reload, so it keeps your work |
| changed | unsaved edits | a real conflict — see below |

On a real conflict you get four choices. **Merge Both** is the one that loses
nothing: it merges the two against the text as you opened it, so edits that
don't overlap are simply combined, and only lines both versions changed are
marked up, in place, in the one file:

```
<<<<<<< YOUR VERSION (unsaved)
the line as you wrote it
<<<<<<< ON DISK (changed by another program)
the line as the other program wrote it
<<<<<<< END OF CONFLICT
```

Delete the version you don't want along with the three marker lines. (They all
start with `<<<<<<<` rather than using git's `=======`/`>>>>>>>`, because those
aren't safe in markdown — `=======` is a heading underline and `>>>>>>>` is a
stack of blockquotes, so an editor mangles them on the next save.)

The other choices are **Reload from Disk** (take theirs), **Keep My Version**
(take yours), and **Cancel**.

**Images.** Anything you paste or drop is written into an `images/` folder next
to the document and linked as `images/name.png`, so the markdown stays portable
and doesn't carry base64. An image copied from a web page is downloaded once so
the document doesn't depend on that server later. Untitled documents have no
folder to write into, so images stay embedded until you save the file somewhere.

Hover an image and drag the corner handle to resize it — up to the image's own
resolution, past the text column if you like (it stays centred). Double-click
the handle to return to the natural size. A resized image is saved as
`<img src="images/name.png" alt="…" width="400" />`, which GitHub, Typora and
Pandoc all render; at natural size it keeps the plain `![alt](src)` form.

**Exporting to PDF.** ⇧⌘E. The Scale option is typographic: at 50% the text is
half-size and re-wraps to fill the full printable width — more words per line,
fewer pages — rather than printing the 100% layout smaller. Paper size and
margins are remembered between exports; the scale deliberately resets to 100%.
The export always uses light colours and your Settings text size never affects
it.

## Project layout

```
markwise/
├── src/editor.js      # Editor logic + JS↔Swift bridge (Milkdown Crepe)
├── src/latex.js       # Inline-equation editing and merging
├── src/supsub.js      # <sup>/<sub> marks + markdown round-tripping
├── src/imageblock.js  # Keeps image alt text out of Milkdown's ratio field
├── src/imageresize.js # Corner-drag image resizing, saved as <img … width="N">
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
