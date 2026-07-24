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
