#!/usr/bin/env bash
# Build Markwise for the current host platform.
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

require_web_dependencies() {
    [ -d "$ROOT/node_modules/@milkdown/crepe" ] &&
        [ -x "$ROOT/node_modules/.bin/esbuild" ] ||
        die "web dependencies are missing; run: npm ci"
}

bundle_web_editor() {
    echo "==> Bundling web editor (esbuild)"
    node build.mjs
}

build_macos() {
    require_command node
    require_command swiftc
    require_node_version "18.0.0"
    require_web_dependencies

    local app="$ROOT/Markwise.app"
    local contents="$app/Contents"
    local macos="$contents/MacOS"
    local resources="$contents/Resources"

    bundle_web_editor

    echo "==> Assembling app bundle skeleton"
    rm -rf "$app"
    mkdir -p "$macos" "$resources/web"

    echo "==> Compiling Swift"
    swiftc -O \
        -framework AppKit -framework WebKit \
        -o "$macos/Markwise" \
        swift/main.swift

    echo "==> Copying resources"
    cp Info.plist "$contents/Info.plist"
    cp app/web/index.html app/web/bundle.js app/web/bundle.css "$resources/web/"
    [ -f app/AppIcon.icns ] && cp app/AppIcon.icns "$resources/AppIcon.icns" || true

    echo
    echo "Built: $app"
    echo "Test it with: open \"$app\""
    echo "Install it with: ./install.sh"
}

linux_electron_arch() {
    case "$(uname -m)" in
        x86_64) echo "x64" ;;
        aarch64 | arm64) echo "arm64" ;;
        *) die "unsupported Linux architecture: $(uname -m)" ;;
    esac
}

build_linux() {
    require_command node
    require_node_version "22.12.0"
    require_web_dependencies

    local packager="$ROOT/linux/node_modules/.bin/electron-packager"
    [ -x "$packager" ] ||
        die "Linux packaging dependencies are missing; run: npm --prefix linux ci"

    local electron_arch
    electron_arch="$(linux_electron_arch)"
    local stage="$ROOT/build/linux/app"
    local output="$ROOT/dist/Markwise-linux-$electron_arch"
    local electron_version
    electron_version="$(node -p "require('./linux/node_modules/electron/package.json').version")"

    bundle_web_editor

    echo "==> Staging Linux application"
    rm -rf "$stage" "$output"
    mkdir -p "$stage/electron" "$stage/app/web"
    cp linux/app-package.json "$stage/package.json"
    cp electron/main.cjs electron/preload.cjs electron/files.cjs "$stage/electron/"
    cp app/web/index.html app/web/bundle.js app/web/bundle.css "$stage/app/web/"
    cp app/icon.svg "$stage/app/icon.svg"

    echo "==> Packaging Electron application"
    "$packager" "$stage" Markwise \
        --platform=linux \
        --arch="$electron_arch" \
        --electron-version="$electron_version" \
        --out="$ROOT/dist" \
        --overwrite \
        --asar \
        --prune

    [ -x "$output/Markwise" ] || die "packager did not create $output/Markwise"
    cp linux/markwise "$output/markwise"
    chmod +x "$output/markwise"

    echo
    echo "Built: $output"
    echo "Open it with: \"$output/markwise\""
}

case "$(uname -s)" in
    Darwin) build_macos ;;
    Linux) build_linux ;;
    *) die "unsupported operating system: $(uname -s)" ;;
esac
