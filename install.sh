#!/usr/bin/env bash
# Build Markwise, install it to /Applications, register ONLY that copy with
# Launch Services, and set it as the default app for Markdown files — in one shot.
#
# ---------------------------------------------------------------------------
# The duplicate-bundle-id trap (why this script is so careful)
# ---------------------------------------------------------------------------
# build.sh produces a dev bundle at ./Markwise.app that carries the SAME bundle
# id (com.josh.markwise) as the installed /Applications/Markwise.app. Launch
# Services keys apps by bundle id, so if BOTH copies are registered at once it
# deduplicates them and can resolve the *wrong* (dev) copy.
#
# The tell-tale symptom of that confused state:
#   * Opening a .md by browsing to it in Finder WORKS, but
#   * Opening the same file from Finder's "Recents" view says
#       "There is no application set to open the document", and
#   * Markwise is missing from the Open With… "recommended applications" list.
#   (Direct-open and the Recents/Spotlight path resolve the handler through
#    different routes; only the latter trips over the duplicate.)
#
# The fix, enforced below: make sure EXACTLY ONE copy — the /Applications one —
# is ever registered. After installing we unregister and DELETE the dev build
# artifact, register the installed copy, set it as the default .md handler, then
# verify no duplicate registration survived (and tell you how to recover if one
# did). build.sh no longer registers its dev build for the same reason.
set -euo pipefail
cd "$(dirname "$0")"

APP="/Applications/Markwise.app"
DEV_APP="$PWD/Markwise.app"
BUNDLE_ID="com.josh.markwise"
UTI="net.daringfireball.markdown"
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"

echo "==> Building"
./build.sh

echo "==> Installing to $APP"
pkill -f "Markwise.app/Contents/MacOS/Markwise" 2>/dev/null || true
sleep 1
rm -rf "$APP"
cp -R "$DEV_APP" /Applications/

echo "==> Removing the dev build artifact (a second bundle with the same id is"
echo "    exactly what breaks the Recents / Open With path)"
"$LSREGISTER" -u "$DEV_APP" 2>/dev/null || true
rm -rf "$DEV_APP"

echo "==> Registering the installed copy with Launch Services"
"$LSREGISTER" -f "$APP"

echo "==> Setting Markwise as the default app for Markdown (.md)"
swift - <<SWIFT
import AppKit
LSSetDefaultRoleHandlerForContentType("$UTI" as CFString, .all, "$BUNDLE_ID" as CFString)
if let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "$BUNDLE_ID") {
    print("    default .md handler -> \(url.path)")
}
SWIFT

echo "==> Verifying exactly one copy is registered under $BUNDLE_ID"
count=$(swift - <<SWIFT
import Foundation
let urls = LSCopyApplicationURLsForBundleIdentifier("$BUNDLE_ID" as CFString, nil)?.takeRetainedValue() as? [URL] ?? []
for u in urls { FileHandle.standardError.write("    registered: \(u.path)\n".data(using: .utf8)!) }
print(urls.count)
SWIFT
)
if [ "$count" != "1" ]; then
    echo "!! WARNING: $count copies of $BUNDLE_ID are registered (expected 1)."
    echo "   A stale duplicate can make .md files fail to open from Finder's Recents."
    echo "   Rebuild the Launch Services database, then re-run this script:"
    echo "     \"$LSREGISTER\" -r -domain local -domain system -domain user"
    exit 1
fi
echo "    OK: exactly one registration."

echo "==> Installing the markwise command (for \$EDITOR)"
# `open -W -a Markwise` waits for the whole app to quit, so an editor session
# hangs while any other window is open. `markwise --wait` waits for the one
# document instead. Installed where the user's own tools go, not /usr/local,
# so no sudo is needed.
BIN_DIR="$HOME/.local/bin"
mkdir -p "$BIN_DIR"
cp bin/markwise "$BIN_DIR/markwise"
chmod +x "$BIN_DIR/markwise"
echo "    $BIN_DIR/markwise"
case ":$PATH:" in
    *":$BIN_DIR:"*) echo "    set it as your editor with:  export EDITOR=\"markwise --wait\"" ;;
    *) echo "    NOTE: $BIN_DIR is not on your PATH; add it, then"
       echo "          export EDITOR=\"markwise --wait\"" ;;
esac

echo "==> Activating the Quick Look preview extension"
# Copying the app registers the extension with PluginKit; electing it makes
# Quick Look actually use it, and the reset clears any cached plain-text
# previews. Both are safe to re-run.
pluginkit -e use -i com.josh.markwise.preview 2>/dev/null || true
qlmanage -r >/dev/null 2>&1 || true

echo "==> Done. Installed and set as the default .md app: $APP"
