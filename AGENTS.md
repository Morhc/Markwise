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

```bash
pkill -f "Markwise.app/Contents/MacOS/Markwise" 2>/dev/null || true
rm -rf /Applications/Markwise.app
cp -R Markwise.app /Applications/
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f /Applications/Markwise.app
```

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
| Editor behavior, JS↔Swift bridge | `src/editor.js` | `window.MW.open(md)` / `window.MW.getMarkdown()`; posts `{type}` messages to native via `webkit.messageHandlers.bridge`. |
| Native window, menus, open/save, dirty state | `swift/main.swift` | `AppDelegate`. File open via `application(_:open:)`; save via `evaluateJavaScript("window.MW.getMarkdown()")`. |
| HTML shell + custom CSS (link color, layout) | `app/web/index.html` | Loads `bundle.js` / `bundle.css`. |
| Bundler config / asset inlining | `build.mjs` | esbuild; non-CSS assets use `dataurl` loader. |
| File-type associations, bundle id, version | `Info.plist` | `CFBundleDocumentTypes` + `UTImportedTypeDeclarations` for markdown. Bundle id: `com.josh.markwise`. |
| Build orchestration | `build.sh` | Single source of truth for assembling the bundle. |

### JS↔Swift bridge contract

- Swift → JS: `webView.evaluateJavaScript("window.MW.open(<json-string>)")` to load
  a document; `"window.MW.getMarkdown()"` returns the current markdown (String).
- JS → Swift: `window.webkit.messageHandlers.bridge.postMessage({type})` with
  `type` ∈ `{ "ready", "opened", "changed" }`. Swift handles these in
  `userContentController(_:didReceive:)`. `ready` triggers loading any file that
  was requested before the editor finished loading (`pendingURL`).

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
