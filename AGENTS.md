# AGENTS.md — Build & Install Markwise (agent-facing)

Deterministic instructions for an automated agent to build, install, verify, and
troubleshoot Markwise on macOS. Prefer exact commands; verify each step's output
before continuing.

## What this is

Markwise is a native macOS app: a Swift + WebKit (`WKWebView`) host that loads a
bundled [Milkdown Crepe](https://milkdown.dev) WYSIWYG markdown editor from
local files. There is no server and no runtime network dependency. The build
produces `Markwise.app`.

## 0. Environment assumptions

- Platform: macOS 12+ (`sw_vers -productVersion`), Apple Silicon or Intel.
- Working directory: the repository root (contains `build.sh`, `Info.plist`).
- The agent can run `node`, `npm`, `swiftc`, and standard macOS CLI tools.

## 1. Verify prerequisites

```bash
node -v        # expect >= 18
npm -v
swiftc --version   # Swift toolchain (Xcode Command Line Tools)
sw_vers -productVersion
```

If `swiftc` is missing: `xcode-select --install` (interactive; requires a human).
If `node` is missing: install Node.js 18+ before continuing.

## 2. Install build-time dependencies

```bash
npm install
```

Installs `@milkdown/crepe` (editor) and `esbuild` (bundler) into `node_modules/`.
These are **build-time only** — they are not shipped inside `Markwise.app`.

## 3. Build

```bash
./build.sh
```

`build.sh` performs, in order:
1. `node build.mjs` — esbuild bundles `src/editor.js` + all CSS/fonts/icons into
   self-contained `app/web/bundle.js` and `app/web/bundle.css` (assets inlined as
   data URIs).
2. Assembles `Markwise.app/Contents/` (`MacOS/`, `Resources/web/`).
3. `swiftc -O -framework AppKit -framework WebKit` compiles `swift/main.swift`
   to `Markwise.app/Contents/MacOS/Markwise`.
4. Copies `Info.plist`, web assets, and `app/AppIcon.icns` into the bundle.
5. Registers the bundle with Launch Services (`lsregister`).

Expected tail of output: `Built: .../Markwise.app`. Swift deprecation warnings
about `allowedFileTypes` are benign.

## 4. Verify the build

```bash
test -x Markwise.app/Contents/MacOS/Markwise && echo "binary OK"
test -f Markwise.app/Contents/Resources/web/bundle.js && echo "web OK"
test -f Markwise.app/Contents/Resources/Info.plist && echo "plist OK"
plutil -lint Markwise.app/Contents/Info.plist        # expect: OK
```

Launch test (opens a GUI window; requires a logged-in session):

```bash
open -a "$PWD/Markwise.app" /path/to/some.md
sleep 2
pgrep -lf "MacOS/Markwise" && echo "running"
ls ~/Library/Logs/DiagnosticReports/Markwise* 2>/dev/null && echo "CRASHED" || echo "no crash"
```

## 5. Install

One shot (build + install + register + set default `.md` handler):

```bash
./install.sh
```

Or manually:

```bash
pkill -f "Markwise.app/Contents/MacOS/Markwise" 2>/dev/null || true
rm -rf /Applications/Markwise.app
cp -R Markwise.app /Applications/
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f /Applications/Markwise.app
```

Note: the dev copy (`./Markwise.app`) and the installed copy share bundle id
`com.josh.markwise`. `build.sh` registers the dev copy, which can reclaim the
default `.md` handler; `install.sh` unregisters the dev copy and re-asserts the
installed one, so prefer it.

## 6. Set as default handler for Markdown (optional)

Programmatic, no extra installs — uses Swift + LaunchServices:

```bash
swift - <<'SWIFT'
import AppKit
let id = "com.josh.markwise"
let uti = "net.daringfireball.markdown"
LSSetDefaultRoleHandlerForContentType(uti as CFString, .all, id as CFString)
print("set default handler:", id, "for", uti)
SWIFT
```

To also catch `.markdown`/plain-text-typed files, repeat with content type
`public.plain-text` if desired (note: this makes Markwise the default for *all*
plain-text files — usually not wanted).

Alternative if [`duti`](https://github.com/moretension/duti) is available:

```bash
duti -s com.josh.markwise net.daringfireball.markdown all
```

## 7. Rebuild the app icon (only if `app/icon.svg` changed)

```bash
./make-icon.sh   # rasterizes icon.svg via Quick Look, packs app/AppIcon.icns
./build.sh       # re-embed icon; then reinstall (step 5)
```

Icon caches are sticky. To force a refresh: `touch Markwise.app`, and if needed
`killall Finder Dock`.

## Architecture / where to change things

| Concern | File | Notes |
|---|---|---|
| Editor behavior, JS↔Swift bridge | `src/editor.js` | Defines `window.MW`; posts `{type}` messages to native via `webkit.messageHandlers.bridge`. |
| Inline equations | `src/latex.js` | Click-to-edit popup, adjacent-equation merging. Works around Crepe's broken LaTeX tooltip. Also decides what *isn't* an equation: `\$` is a literal dollar, and pandoc's whitespace condition keeps one literal dollar from capturing a later one. Applied twice over — a remark transform demotes the nodes remark-math already made on load, and `mathInputGuard` (a `handleTextInput` **view option**, consulted before any plugin's) keeps Crepe's un-removable input rule from seeing the keystroke. The clipboard gets its own `DOMSerializer`, so an equation is copied as a compact `<span data-type=math_inline>$…$</span>` rather than its whole KaTeX rendering (which pastes as the equation twice over, once as text and once as markup), and `transformPastedHTML` reduces an incoming KaTeX rendering to the same thing. Selection: Crepe lays an equation out `inline-block`, and WebKit paints a selection bounded by an inline-block starting a character to its left — `display: inline` fixes that. A click selects the equation (double click edits); `selectionStartAtAtom` re-spells the DOM range's start, which WebKit needs to paint a click-made selection correctly. **⇧← / ⇧→ landing exactly on an equation still paints the preceding word** — the DOM range is byte-identical to the click case that paints right, so it is a WebKit repaint quirk; the model and clipboard are correct. Don't convert the range to a `NodeSelection` to fix the paint: it breaks ⌘C completely. |
| `$EDITOR` support | `bin/markwise`, `AppDelegate.openMarker*` | `open -W` waits for the app to quit, so an editor session hangs while any other window is open. Markwise writes a marker file per open document (named for the SHA-256 of its canonical path) under `~/Library/Application Support/Markwise/open` and deletes it on `windowWillClose`; `markwise --wait` polls for that one file. The two sides normalise paths differently (`pwd -P` resolves `/tmp` → `/private/tmp`, Foundation goes the other way), so the shim hashes every spelling and waits for whichever marker appears. |
| Per-file zoom | `swift/main.swift` | `MWTextScale` is the Settings default; `MWFileTextScale` maps a canonical path to that file's own size. Zoom acts on `activeDocument` only. A document with no size of its own follows Settings live; ⌘0 clears the file's and goes back to following it. |
| Styled inline HTML | `src/htmlspan.js` | `<span style=…>`, `<u>`, `<mark>` folded from `html` node pairs into marks and written back out, mirroring `supsub.js`. Attributes ride along as the raw source string. |
| Superscript/subscript | `src/supsub.js` | `sup`/`sub` marks + remark parse/stringify so they round-trip as `<sup>`/`<sub>`. |
| Image alt text, width attr | `src/imageblock.js` | Patches Milkdown's `image-block` schema, which otherwise stores the aspect ratio in the markdown `alt` field and destroys the description on save. Adds a `width` attribute; a resized image serializes as `<img … width="N">` HTML. |
| Image resizing | `src/imageresize.js` | Corner drag handle + remark transform parsing standalone `<img>` tags back into image blocks. |
| Block-level editing | `src/blocks.js` | ⌫ bound to `joinBackward` ahead of Milkdown's `joinTextblockBackward` — the latter only *joins* two text blocks, so it does nothing at the start of a blockquote and there was no way to remove a `>` from the keyboard; `joinBackward`'s fallback lifts the block out of its parent. (List behaviour is unaffected: Milkdown's list keymap wins there.) Plus a capture-phase key handler for a code block at the edge of a blockquote: ↓ at the end keeps the caret *inside* the container (Milkdown's own escape uses `TextSelection.near`, which leaves the quote), and ⌫ at the start lifts the block out of it (Milkdown only converts a code block on ⌫ when it holds a single line, so a multi-line fence opening a quote had nothing bound at all). Capture phase because CodeMirror owns the block's DOM and stops the event. Also a `paragraph` stringify handler so an empty paragraph is nothing rather than `<br />`, and a `text` handler that restores escaping Milkdown drops for text ending in a space. **Do not fix serialization by re-registering a node schema**: a duplicate entry in `nodesCtx` reorders it, and the first block type is the one ProseMirror fills new blocks with — every new paragraph becomes a heading. |
| Code-block theme, language list, LaTeX preview | `src/codeblock.js` | CodeMirror highlight style; explicit `bash` entry; a visible caret (CodeMirror's own theme paints it `#ddd`, invisible on the light code panel). `renderCodePreview` renders a LaTeX code block — which is what `$$ … $$` is in Crepe's model — with KaTeX, and `previewOnlyByDefault` (set in `editor.js`) shows that instead of the source. |
| Native window, menus, open/save/export, dirty state | `swift/main.swift` | `AppDelegate` + `DocumentWindow`. File open via `application(_:open:)`; save and PDF export use the `window.MW` bridge. |
| Quick Look preview | `swift/preview.swift`, `src/qlpreview.js`, `src/qlpreview.css` | An .appex in `Contents/PlugIns` (assembled and ad-hoc signed by `build.sh` — extensions must be signed and sandboxed to load). Markdown→HTML via JavaScriptCore (`MWQL.render`), images inlined as data: URIs, shown in a JS-disabled WKWebView. Entry point is `_NSExtensionMain`, set by linker flag. |
| HTML shell + custom CSS (link color, layout, source view, equation popup) | `app/web/index.html` | Loads `bundle.js` / `bundle.css`. |
| Bundler config / asset inlining | `build.mjs` | esbuild; non-CSS assets use `dataurl` loader. |
| File-type associations, bundle id, version | `Info.plist` | `CFBundleDocumentTypes` + `UTImportedTypeDeclarations` for markdown. Bundle id: `com.josh.markwise`. |
| Build orchestration | `build.sh` | Single source of truth for assembling the bundle. |

### JS↔Swift bridge contract

Swift → JS, all via `evaluateJavaScript`:

| Call | Purpose |
|---|---|
| `window.MW.open(md, baseHref)` | Load a document. `baseHref` is the file's directory (or `null`), used to resolve relative image paths through a `<base>` element. |
| `window.MW.getMarkdown()` | Current markdown (String). Returns the textarea's text while source view is open. |
| `window.MW.markSaved()` | Re-baseline the dirty check after a successful write. |
| `window.MW.setOutline(bool)` / `setSource(bool)` | Show/hide the outline sidebar and the raw-source view. Swift owns the state so menu checkmarks stay in sync. |
| `window.MW.toggleMark(name)` | Toggle an inline mark (`"sup"` / `"sub"`) over the selection. |
| `window.MW.setBaseURL(href)` | Re-point relative paths (used after Save As). |
| `window.MW.preparePdfExport({textScale})` / `finishPdfExport()` | Enter and leave the shared print state. Preparation renders source-view edits, waits for fonts and images, and reports missing images before the native host creates a PDF. `textScale` (0.25–2) applies the export's Scale option as a font-size scale so the text reflows; the native side keeps `NSPrintInfo.scalingFactor` at 1. |
| `window.MW.setTextScale(percent)` | Settings ▸ Text size (50–300). Font-size scaling via calc() overrides in index.html — deliberately not CSS `zoom`, which scaled images, broke caret drawing on scale changes and leaked into hit-testing. |
| `window.MW.setImageSrc(src)` / `insertImages(srcs, x, y)` | Replies to an `editImage` prompt; insert dropped/pasted images. |
| `window.MW.primeSpellCheck()` | Walk the caret over every block so WebKit marks the whole document, not just the block the caret is in. |
| `window.MW.nativeReply(id, value)` | Answers a request the editor made with an `id` (see `saveImage`). |

JS → Swift: `postMessage({type, …})` with `type` ∈
`{ "ready", "opened", "clean", "dirty", "openLink", "editImage", "saveImage" }`,
handled in
`userContentController(_:didReceive:)`. `ready` triggers loading any file
requested before the editor finished loading (`pendingURL`); `clean`/`dirty`
drive the window's edited state.

`window.MW.__view()` returns the live ProseMirror view. It exists only so an
automated harness can drive the document model; the app never calls it.

### Note on Crepe internals

`node_modules/@milkdown/crepe` ships its **TypeScript source** under `src/`.
When something in the editor misbehaves, read that source rather than guessing —
several of the LaTeX behaviours here are workarounds for things found in it
(e.g. `plugin-block` hit-tests at the editor's horizontal centre, so inline
equations used to steal the drag handle; the inline-LaTeX tooltip never mounts
its editable field).

## Troubleshooting

- **`npm install` fails**: check network/registry reachability (`npm ping`).
- **`swiftc` not found**: install Xcode Command Line Tools (`xcode-select --install`).
- **Window opens blank**: confirm `app/web/bundle.js` exists and is non-empty;
  re-run `node build.mjs`. The shell loads `Resources/web/index.html` via
  `loadFileURL(_:allowingReadAccessTo:)` — all web assets must live under
  `Resources/web/`.
- **Edits don't save**: saving calls JS `getMarkdown()` asynchronously; ensure the
  editor reported `ready`/`opened` first.
- **Icon not updating**: `touch Markwise.app`; then `killall Finder Dock`.
- **"unidentified developer" on launch**: the app is unsigned. Right-click →
  **Open** once, or `xattr -dr com.apple.quarantine Markwise.app`. Signing/
  notarization is out of scope for a local build.

## Clean

```bash
rm -rf node_modules Markwise.app app/web/bundle.js app/web/bundle.css app/icon.svg.png
```
