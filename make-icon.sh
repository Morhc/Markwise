#!/usr/bin/env bash
# Render app/icon.svg into app/AppIcon.icns using only built-in macOS tools
# (Quick Look for SVG rasterization, sips for resizing, iconutil for packing).
set -euo pipefail
cd "$(dirname "$0")/app"

echo "==> Rasterizing icon.svg (Quick Look)"
rm -f icon.svg.png
qlmanage -t -s 1024 -o . icon.svg >/dev/null 2>&1
[ -f icon.svg.png ] || { echo "Quick Look failed to render icon.svg"; exit 1; }

echo "==> Building iconset"
ICONSET=AppIcon.iconset
rm -rf "$ICONSET" && mkdir "$ICONSET"
specs=("16:icon_16x16.png" "32:icon_16x16@2x.png" "32:icon_32x32.png" \
       "64:icon_32x32@2x.png" "128:icon_128x128.png" "256:icon_128x128@2x.png" \
       "256:icon_256x256.png" "512:icon_256x256@2x.png" "512:icon_512x512.png" \
       "1024:icon_512x512@2x.png")
for spec in "${specs[@]}"; do
  size="${spec%%:*}"; name="${spec##*:}"
  sips -z "$size" "$size" icon.svg.png --out "$ICONSET/$name" >/dev/null 2>&1
done

echo "==> Packing AppIcon.icns"
iconutil -c icns "$ICONSET" -o AppIcon.icns
rm -rf "$ICONSET" icon.svg.png
echo "Done: app/AppIcon.icns"
