#!/bin/sh
# Re-image a microSD as a yi-hack-v3 flash card for our camera.
#
# Usage:  scripts/prep-sd.sh /Volumes/YOURCARD
#
# The card must already be formatted FAT32 / MBR
# (Disk Utility: MS-DOS (FAT) + Master Boot Record). macOS-specific (uses diskutil).
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VOL="$1"

[ -n "$VOL" ] || { echo "usage: $0 /Volumes/YOURCARD"; exit 1; }
[ -d "$VOL" ] || { echo "error: '$VOL' not found — is the card mounted?"; exit 1; }
[ -f "$ROOT/config.env" ] || { echo "error: create config.env first (cp config.env.example config.env)"; exit 1; }
. "$ROOT/config.env"
[ -n "$WIFI_SSID" ] && [ -n "$WIFI_PASSWORD" ] || { echo "error: set WIFI_SSID and WIFI_PASSWORD in config.env"; exit 1; }

FW="$ROOT/firmware"
[ -f "$FW/home_y18" ] && [ -f "$FW/rootfs_y18" ] || { echo "error: firmware missing — run firmware/fetch-firmware.sh"; exit 1; }

echo ">> wiping old payload on $VOL"
rm -rf "$VOL/home" "$VOL/test" "$VOL/home_y18" "$VOL/rootfs_y18" "$VOL/yi-hack-v3" 2>/dev/null || true

echo ">> copying firmware (home_y18, rootfs_y18)"
cp "$FW/home_y18" "$FW/rootfs_y18" "$VOL/"

echo ">> copying wifi hook + generating wpa_supplicant.conf from config.env"
mkdir -p "$VOL/yi-hack-v3"
cp "$ROOT/sd-card/yi-hack-v3/startup.sh" "$VOL/yi-hack-v3/startup.sh"
cat > "$VOL/yi-hack-v3/wpa_supplicant.conf" <<EOF
ctrl_interface=/var/run/wpa_supplicant
update_config=1
network={
	ssid="$WIFI_SSID"
	psk="$WIFI_PASSWORD"
	key_mgmt=WPA-PSK
	scan_ssid=1
}
EOF

echo ">> cleaning macOS metadata"
dot_clean "$VOL" 2>/dev/null || true
find "$VOL" -name '._*' -delete 2>/dev/null || true
rm -rf "$VOL/.Spotlight-V100" "$VOL/.fseventsd" "$VOL/.Trashes" 2>/dev/null || true
sync

echo ">> card contents:"
ls -la "$VOL"
echo ">> ejecting"; diskutil eject "$VOL" 2>/dev/null || echo "(eject the card manually)"
echo
echo "Done. Insert into the POWERED-OFF camera and plug in power."
echo "Yellow LED flashes ~30s (flashing) -> reboots -> blue = on wifi."
echo "Do NOT cut power during the yellow flash."
