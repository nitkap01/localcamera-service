# sd-card

What goes on the camera's microSD card to flash + configure it.

## Card requirements
- **≤ 32 GB**, formatted **FAT32**, partition scheme **MBR** (Master Boot Record).
  On macOS Disk Utility: *View → Show All Devices*, select the whole card, Erase as
  **MS-DOS (FAT)** + **Master Boot Record**. (exFAT / GPT / big cards will be ignored
  by the camera.)

## Card layout (what `scripts/prep-sd.sh` writes)
```
<card root>
├── home_y18            # firmware (flashed on first boot)
├── rootfs_y18          # firmware (flashed on first boot)
└── yi-hack-v3/
    ├── startup.sh              # runs on every boot (from /tmp/sd/yi-hack-v3/)
    └── wpa_supplicant.conf     # generated from config.env — HOLDS WIFI PASSWORD
```

## What each piece does
- **`home_y18` + `rootfs_y18`** — the yi-hack-v3 firmware. The camera flashes them on
  first boot (yellow LED ~30s), then reboots into the hacked firmware. Cloud is
  disabled automatically.
- **`yi-hack-v3/startup.sh`** — our **app-free wifi hook**. The firmware runs
  `/tmp/sd/yi-hack-v3/startup.sh` on every boot; ours brings up `wlan0` and joins wifi
  from the config below — so no Yi app / account is needed. It's non-blocking and logs
  to `yi-hack-v3/wifi-boot.log` on the card if you need to debug a no-connect.
- **`yi-hack-v3/wpa_supplicant.conf`** — the wifi credentials. Generated from
  `config.env` by `prep-sd.sh`; it is **gitignored** (contains your password). The
  committed template is `wpa_supplicant.conf.example`.

## Build the card
```
cp ../config.env.example ../config.env    # then edit wifi values
../firmware/fetch-firmware.sh             # get the firmware
../scripts/prep-sd.sh /Volumes/YOURCARD   # write everything to the card
```
