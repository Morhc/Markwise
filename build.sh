#!/usr/bin/env bash
# Build Markwise.app: bundle the web editor, compile Swift, assemble the .app bundle.
set -euo pipefail

cd "$(dirname "$0")"
ROOT="$(pwd)"
APP="$ROOT/Markwise.app"
CONTENTS="$APP/Contents"
MACOS="$CONTENTS/MacOS"
RES="$CONTENTS/Resources"

echo "==> Bundling web editor (esbuild)"
node build.mjs

echo "==> Assembling app bundle skeleton"
rm -rf "$APP"
mkdir -p "$MACOS" "$RES/web"

echo "==> Compiling Swift"
swiftc -O \
    -framework AppKit -framework WebKit \
    -o "$MACOS/Markwise" \
    swift/main.swift

echo "==> Copying resources"
cp Info.plist "$CONTENTS/Info.plist"
cp app/web/index.html app/web/bundle.js app/web/bundle.css "$RES/web/"
[ -f app/AppIcon.icns ] && cp app/AppIcon.icns "$RES/AppIcon.icns" || true

echo "==> Building the Quick Look preview extension"
# Quick Look asks an app *extension* for previews, never the default app, so a
# rendered .md preview needs this .appex inside the bundle. The executable's
# entry point is Foundation's NSExtensionMain (there is no main function), and
# macOS only loads extensions that are signed AND sandboxed — ad-hoc signing
# (identity "-") with the sandbox entitlement satisfies both for a local build.
# The outer app is re-signed afterwards, since embedding the appex invalidates
# any existing seal on the bundle.
APPEX="$CONTENTS/PlugIns/MarkwisePreview.appex"
mkdir -p "$APPEX/Contents/MacOS" "$APPEX/Contents/Resources"
swiftc -O -parse-as-library \
    -framework QuickLookUI -framework JavaScriptCore \
    -Xlinker -e -Xlinker _NSExtensionMain \
    -o "$APPEX/Contents/MacOS/MarkwisePreview" \
    swift/preview.swift
cp swift/preview-Info.plist "$APPEX/Contents/Info.plist"
cp app/ql/qlpreview.js app/ql/qlpreview.css "$APPEX/Contents/Resources/"
codesign --force -s - --entitlements swift/preview.entitlements "$APPEX"
codesign --force -s - "$APP"

# NOTE: We deliberately do NOT register this dev build with Launch Services.
# It shares its bundle id (com.josh.markwise) with the installed /Applications
# copy. Registering both makes LS deduplicate by bundle id and sometimes resolve
# the wrong copy — which breaks opening .md files from Finder's "Recents" and
# drops Markwise from the Open With… list. Only install.sh registers, and it
# registers the /Applications copy exclusively. See install.sh for the full story.
# `open "$APP"` still works for a quick test without a persistent registration.

echo ""
echo "Built: $APP"
echo "Test it with:   open \"$APP\""
echo "Install it with: ./install.sh   (registers the /Applications copy only)"
