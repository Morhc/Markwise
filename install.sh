#!/usr/bin/env bash
# Build Markwise, install it to /Applications, register it with Launch Services,
# and set it as the default app for Markdown files — in one shot.
#
# Why this exists: the dev copy in this repo and the /Applications copy share the
# same bundle id (com.josh.markwise). `build.sh` registers the *dev* copy, which
# can quietly make it the default .md handler. This script installs the fresh
# build to /Applications and makes that copy win.
set -euo pipefail
cd "$(dirname "$0")"

APP="/Applications/Markwise.app"
BUNDLE_ID="com.josh.markwise"
UTI="net.daringfireball.markdown"
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"

echo "==> Building"
./build.sh

echo "==> Installing to $APP"
pkill -f "Markwise.app/Contents/MacOS/Markwise" 2>/dev/null || true
sleep 1
rm -rf "$APP"
cp -R Markwise.app /Applications/

echo "==> Registering with Launch Services (installed copy wins over the dev copy)"
"$LSREGISTER" -u "$PWD/Markwise.app" 2>/dev/null || true
"$LSREGISTER" -f "$APP"

echo "==> Setting Markwise as the default app for Markdown (.md)"
swift - <<SWIFT
import AppKit
LSSetDefaultRoleHandlerForContentType("$UTI" as CFString, .all, "$BUNDLE_ID" as CFString)
if let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "$BUNDLE_ID") {
    print("    default .md handler -> \(url.path)")
}
SWIFT

echo "==> Done. Installed and set as the default .md app: $APP"
