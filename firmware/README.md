# firmware

Custom firmware for the camera (Yi Home 720p `47US` = the **`y18`** build).

## Files
- `home_y18` — main filesystem image (u-boot uImage, `0.1.6-hi3518-home`).
- `rootfs_y18` — root filesystem image (u-boot uImage, `0.1.6-hi3518-rootfs`).

Both are **gitignored** (binaries). Get them with `./fetch-firmware.sh`, which pulls
them from the `shadow-1/yi-hack-v3` `0.1.6` release.

## Why these
- Camera: `YHS-113-IR`, HiSilicon **Hi3518ev200**, serial id **`47US`**.
- Stock firmware was `1.8.7.0F` (2018) — region-locked, cloud-dependent, and the old
  2016 `fritz-smh/yi-hack` method does **not** work on it (wrong variant + newer HW).
- `shadow-1/yi-hack-v3` supports the `47US` / `y18` model and is **free** (unlike the
  donation-gated `TheCrypt0/yi-hack-v4`). Cloud is disabled by the firmware itself
  (it swaps the stock `cloudAPI` for a stub on first boot).

## How the flash works
The camera flashes any `home_*` / `rootfs_*` uImage it finds at the SD-card root on
boot: yellow LED flashes ~30s while writing, then it reboots into the new firmware.
Pulling the card does **not** revert it (unlike the old fritz card) — this is a real
flash. Use `scripts/prep-sd.sh` to build the card.

## Recovery / un-brick
- The only real brick risk is **cutting power during the ~30s flash** — don't.
- To recover, flash a known-good image via the same SD method:
  - re-flash these `y18` hack files again, or
  - flash **stock** `y18` firmware (Yi Home 720p `47US` stock ≈ `1.8.7.0A_201702081101`).
    Community stock images live in the yi-hack-v3 project links; drop them in a
    `recovery/` folder here (gitignored) if/when downloaded.

## Sources
- shadow-1/yi-hack-v3 — https://github.com/shadow-1/yi-hack-v3 (release `0.1.6`)
- 47US support — https://github.com/shadow-1/yi-hack-v3/issues/87
