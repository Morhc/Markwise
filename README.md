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
- **Math** — `$E = mc^2$` renders with KaTeX, at the size of the text around it.
  Click an equation to edit its LaTeX with a live preview; delete the space
  between two equations to merge them. A `$$ … $$` block shows the rendered
  equation, not its source. Write `\$` for a dollar that isn't maths.
- **Superscript & subscript** — ⌃⌘+ and ⌃⌘−, written out as the `<sup>`/`<sub>`
  HTML that GitHub, Pandoc and Typora all render.
- **Styled text** — `<span style="color:red">…</span>`, `<u>` and `<mark>` render
  as what they describe instead of as visible tags, and save back as they were
  written.
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
  never the images, and doesn't leak into exports. ⌘+ and ⌘− zoom the window
  you're in, and each file remembers the size you left it at.
- **Works as your `$EDITOR`** — `markwise --wait` returns when you close the
  document, so `git commit` and Claude Code's ⌃G stop waiting on it.
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

## Rendered Quick Look previews

Pressing space on a `.md` file in Finder shows the rendered document, in
Markwise's own typography — headings, tables, images, and KaTeX math included.

Quick Look never asks the default app for previews; it asks a *Quick Look
extension*, so Markwise ships one inside the app
(`Contents/PlugIns/MarkwisePreview.appex`). `build.sh` assembles it and
`install.sh` activates it — nothing extra to install. The preview is static
and safe by construction: the markdown is converted to HTML inside the
sandboxed extension and displayed with JavaScript disabled, so scripts in a
downloaded file are inert.

If a preview ever shows plain text instead, check the toggle under
**System Settings ▸ General ▸ Login Items & Extensions ▸ Quick Look**.

## Using Markwise as your `$EDITOR`

`install.sh` puts a `markwise` command in `~/.local/bin`. Point your editor
variable at it:

```bash
export EDITOR="markwise --wait"
```

The obvious spelling, `EDITOR="open -W -a Markwise"`, waits for the wrong thing:
`open -W` returns when the *application* quits, so `git commit`, `crontab -e`
and Claude Code's ⌃G all sit there for as long as any other Markwise window is
open anywhere. `markwise --wait` waits for the one document it was asked to
open, and returns when you close that window.

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
| Zoom in / out       | ⌘+ / ⌘−  |
| Actual size         | ⌘0       |
| Appearance          | View menu |
| Font                | View menu |
| Superscript         | ⌃⌘+      |
| Subscript           | ⌃⌘−      |
| Full screen         | ⌃⌘F      |

Open a file, edit it inline, press ⌘S. That's it.

**Working with equations.** Type `$x^2$` to create one. Click a rendered
equation to reopen its LaTeX in a small field with a live preview — Enter
commits, Escape cancels, clicking anywhere else puts it away, and clearing the
field deletes the equation. Two equations separated by a single space merge into
one when you delete the space, since `$a$$b$` isn't valid markdown for two.

A `$$ … $$` block is a displayed equation and looks like one: you see the
equation, with its LaTeX one click away behind the toggle in the corner. One you
have just typed `$$` for opens on its source instead — there is nothing to show
yet — and stays that way until you leave it. (In the
editor's model it is a LaTeX code block, which is why the toggle is the same one
code blocks use.) Copying an equation copies `$x^2$` — the LaTeX, not the
rendering — so it pastes as an equation here and as source anywhere else.

**Getting out of a blockquote.** ⌫ at the start of a quote's first line takes
that line back out of the quote — one level at a time, so a nested quote
unwraps twice — which is how you get rid of the `>`. It works the same whether
the quote holds a paragraph or a code block.

A code block at the edge of a quote used to be a dead end forwards too: ↓ at the
end of the code now carries on inside the quote rather than dropping out below
it (⌘↵ does the same from anywhere in the block).

**Blank lines.** An empty line you leave behind is an empty line: it folds away
on save the way markdown does everywhere, rather than being written out as a
literal `<br />`. A break inside a paragraph is a hard break (⇧↵), which is kept.

**Zoom.** ⌘+ and ⌘− change the window you are in, not every window: two files
open side by side can be at different sizes. A size you set is remembered
against that file and comes back when you reopen it; ⌘0 forgets it and returns
the window to the size in Settings, which is what a file you have never zoomed
follows.

Superscript also answers to ⌃⌘= if you'd rather not reach for Shift.

**Dollars that aren't maths.** Markdown gives `$` two jobs, so `I paid $5 and
$10` has a perfectly good reading as an equation whose body is `5 and `. The
escape is yours to write — `\$` is a literal dollar, here as everywhere else in
markdown — and typing it does the WYSIWYG thing: the backslash resolves to the
dollar it was escaping, and saving spells the escape back out.

Two smaller things follow from that. Markwise won't read an equation whose
opening `$` is followed by a space or whose closing `$` is preceded by one,
which is the condition pandoc puts on inline maths and is what stops one
literal dollar from capturing a later one; nothing is lost, since trailing
space inside an equation means nothing to LaTeX. And a `$…$` pair that the rule
turns down is written back escaped, so the file says plainly what it means.
`$1$`, `$E = mc^2$` and `$^{44}\mathrm{Ti}$` are all equations, as before.

**Styled text.** Markdown has no syntax for a coloured or underlined run, so
the portable spelling is literal HTML, the same bargain `<sup>` and `<sub>`
make. `<span style="color:red">important</span>`, `<u>underlined</u>` and
`<mark>highlighted</mark>` render as what they describe — in the editor, in a
PDF export and in a Quick Look preview — and are saved back with their
attributes exactly as they were written. Other tags are left alone as the
literal HTML they are.

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
├── src/htmlspan.js    # <span style=…>/<u>/<mark> as marks, round-tripped as HTML
├── src/blocks.js      # Caret into/out of a quoted code block; empty paragraphs
├── bin/markwise       # CLI shim; `markwise --wait` is what $EDITOR wants
├── src/codeblock.js   # Code-block theme and language list
├── src/qlpreview.js   # Quick Look renderer: markdown -> HTML (runs in JavaScriptCore)
├── src/qlpreview.css  # Quick Look stylesheet (Markwise palette + KaTeX)
├── swift/main.swift   # Native macOS host: window, menus, file open/save
├── swift/preview.swift        # Quick Look preview extension controller
├── swift/preview-Info.plist   # The extension's NSExtension declaration
├── swift/preview.entitlements # Sandbox entitlements (required to load)
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
