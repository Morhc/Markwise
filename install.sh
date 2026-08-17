#!/usr/bin/env bash
# Build and install Markwise for the current host platform.
# On macOS, only the installed /Applications bundle is registered with Launch
# Services. Registering the development bundle as well creates two applications
# with the same bundle identifier and can break Finder's Recents and Open With.
set -euo pipefail

cd "$(dirname "$0")"
ROOT="$(pwd)"

die() {
    echo "error: $*" >&2
    exit 1
}

require_command() {
    command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

require_node_version() {
    local minimum="$1"
    node -e '
const current = process.versions.node.split(".").map(Number)
const minimum = process.argv[1].split(".").map(Number)
for (let i = 0; i < Math.max(current.length, minimum.length); i++) {
  const actual = current[i] || 0
  const required = minimum[i] || 0
  if (actual > required) process.exit(0)
  if (actual < required) process.exit(1)
}
' "$minimum" || die "Node.js $minimum or newer is required (found $(node -v))"
}

install_macos() {
    local app="/Applications/Markwise.app"
    local bundle_id="com.josh.markwise"
    local uti="net.daringfireball.markdown"
    local lsregister="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
    local dev_app="$ROOT/Markwise.app"

    echo "==> Building"
    ./build.sh

    echo "==> Installing to $app"
    pkill -f "Markwise.app/Contents/MacOS/Markwise" 2>/dev/null || true
    sleep 1
    rm -rf "$app"
    cp -R "$dev_app" /Applications/

    echo "==> Removing the development bundle from Launch Services"
    "$lsregister" -u "$dev_app" 2>/dev/null || true
    rm -rf "$dev_app"

    echo "==> Registering the installed copy with Launch Services"
    "$lsregister" -f "$app"

    echo "==> Setting Markwise as the default app for Markdown (.md)"
    swift - <<SWIFT
import AppKit
LSSetDefaultRoleHandlerForContentType("$uti" as CFString, .all, "$bundle_id" as CFString)
if let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "$bundle_id") {
    print("    default .md handler -> \\(url.path)")
}
SWIFT

    echo "==> Verifying the installed bundle registration"
    local count
    count=$(swift - <<SWIFT
import Foundation
let urls = LSCopyApplicationURLsForBundleIdentifier("$bundle_id" as CFString, nil)?.takeRetainedValue() as? [URL] ?? []
for url in urls {
    FileHandle.standardError.write("    registered: \(url.path)\n".data(using: .utf8)!)
}
print(urls.count)
SWIFT
)
    if [ "$count" != "1" ]; then
        echo "error: $count copies of $bundle_id are registered; expected 1" >&2
        echo "rebuild the Launch Services database and rerun this installer:" >&2
        echo "  \"$lsregister\" -r -domain local -domain system -domain user" >&2
        exit 1
    fi

    echo "==> Done. Installed and set as the default .md app: $app"
}

linux_electron_arch() {
    case "$(uname -m)" in
        x86_64) echo "x64" ;;
        aarch64 | arm64) echo "arm64" ;;
        *) die "unsupported Linux architecture: $(uname -m)" ;;
    esac
}

install_linux_bundle() {
    local bundle="$1"
    local data_home="${XDG_DATA_HOME:-$HOME/.local/share}"
    local bin_home="${XDG_BIN_HOME:-$HOME/.local/bin}"
    local install_dir="$data_home/markwise"
    local applications_dir="$data_home/applications"
    local icons_dir="$data_home/icons/hicolor/scalable/apps"
    local mime_dir="$data_home/mime/packages"
    local desktop_file="$applications_dir/com.josh.markwise.desktop"
    local executable="$install_dir/markwise"
    local staging
    local previous="${install_dir}.previous"

    mkdir -p "$data_home" "$bin_home" "$applications_dir" "$icons_dir" "$mime_dir"
    staging="$(mktemp -d "$data_home/.markwise-install.XXXXXX")"
    trap 'rm -rf "$staging"' RETURN

    cp -R "$bundle/." "$staging/"

    rm -rf "$previous"
    if [ -e "$install_dir" ]; then
        mv "$install_dir" "$previous"
    fi
    if mv "$staging" "$install_dir"; then
        rm -rf "$previous"
    else
        [ -e "$previous" ] && mv "$previous" "$install_dir"
        die "could not install Markwise to $install_dir"
    fi
    trap - RETURN

    ln -sfn "$executable" "$bin_home/markwise"
    cp app/icon.svg "$icons_dir/com.josh.markwise.svg"
    cp linux/com.josh.markwise.xml "$mime_dir/com.josh.markwise.xml"

    local escaped_executable="${executable//\\/\\\\}"
    escaped_executable="${escaped_executable//&/\\&}"
    escaped_executable="${escaped_executable//|/\\|}"
    escaped_executable="${escaped_executable//\"/\\\"}"
    sed "s|@EXECUTABLE@|$escaped_executable|g" \
        linux/com.josh.markwise.desktop.in >"$desktop_file"

    command -v update-mime-database >/dev/null 2>&1 &&
        update-mime-database "$data_home/mime" >/dev/null
    command -v update-desktop-database >/dev/null 2>&1 &&
        update-desktop-database "$applications_dir" >/dev/null
    command -v gtk-update-icon-cache >/dev/null 2>&1 &&
        gtk-update-icon-cache -q -t "$data_home/icons/hicolor" 2>/dev/null || true

    if command -v xdg-mime >/dev/null 2>&1; then
        xdg-mime default com.josh.markwise.desktop text/markdown || true
        xdg-mime default com.josh.markwise.desktop text/x-markdown || true
    fi

    echo "==> Done. Installed Markwise to $install_dir"
    echo "    Launch it from the application menu or run: $bin_home/markwise"
}

install_linux() {
    require_command node
    require_command npm
    require_node_version "22.12.0"

    echo "==> Installing deterministic build dependencies"
    npm ci
    npm --prefix linux ci

    echo "==> Building"
    ./build.sh

    local electron_arch
    electron_arch="$(linux_electron_arch)"
    local bundle="$ROOT/dist/Markwise-linux-$electron_arch"
    [ -x "$bundle/Markwise" ] && [ -x "$bundle/markwise" ] ||
        die "Linux bundle is missing or incomplete: $bundle"

    local apparmor_userns="/proc/sys/kernel/apparmor_restrict_unprivileged_userns"
    if [ -r "$apparmor_userns" ] &&
        [ "$(tr -d '[:space:]' <"$apparmor_userns")" = "1" ]; then
        command -v bwrap >/dev/null 2>&1 ||
            die "bubblewrap is required on this Ubuntu configuration; install it with: sudo apt install bubblewrap"
    fi

    echo "==> Installing for the current user"
    install_linux_bundle "$bundle"
}

case "$(uname -s)" in
    Darwin) install_macos ;;
    Linux) install_linux ;;
    *) die "unsupported operating system: $(uname -s)" ;;
esac
