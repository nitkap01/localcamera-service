#!/bin/sh
# Download the shadow-1/yi-hack-v3 firmware for our camera
# (Yi Home 720p, serial id 47US = the "y18" build). These binaries are gitignored.
set -e

REL="https://github.com/shadow-1/yi-hack-v3/releases/download/0.1.6"
DIR="$(cd "$(dirname "$0")" && pwd)"

for f in home_y18 rootfs_y18; do
    echo ">> downloading $f ..."
    curl -fL -o "$DIR/$f" "$REL/$f"
done

echo ">> verifying (should be u-boot uImage, Linux/ARM):"
file "$DIR/home_y18" "$DIR/rootfs_y18" 2>/dev/null || echo "(install 'file' to verify)"
echo "done."
