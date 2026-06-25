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

echo "==> Registering with Launch Services"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister \
    -f "$APP" || true

echo ""
echo "Built: $APP"
echo "Open it with:  open \"$APP\""
