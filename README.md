# ougi-flasher

WebUSB flasher for recovery-based custom ROM installs. Same idea as
<https://download.lineageos.org/flash/fastboot>: the page downloads the package, verifies its
sha256, and writes it to the phone itself — no SDK, no `adb`, no `fastboot`, nothing installed on
the user's machine, no server involved in the transfer.

**One deployment serves one device**, and the deployment is `flasher.json` — codename, image list,
URLs, add-ons, page copy. No code knows a phone or a ROM by name. The shipped example targets
Project Infinity X on the Motorola ThinkPhone (`bronco`); that is config content, nothing else.

```
index.html          Flash    — device check → download → flash (update or clean) → finish
console.html        Console  — a fastboot terminal and an adb terminal
tools.html          Tools    — an add-on sideload on its own
app.js              flash page logic
console.js          terminal page logic
tools.js            tools page logic
flasher.json        THE config: codename, images, OTA, add-ons, page copy
lib/config.mjs      load + validate flasher.json
lib/ui.mjs          $, status/hint boxes, key/value tables, page copy, process log
lib/usb.mjs         one picker, mode detection (ff/42/03 fastboot, ff/42/01 adb), getvar parsing
lib/flash.mjs       download + sha256, readImages/flashImages (boot chain)
lib/adb.mjs         adb wrapper: connect, props, reboot, sideload-host
lib/recovery.mjs    waitForSideload + sideloadWithWait (reconnect/retry)
lib/term.js         output pane + prompt line with history (no dependencies)
lib/unlock.mjs      bootloader lock state, reconciled across layers
zip.mjs             reads entries out of a zip instead of shipping a zip library
style.css           page styles (tokens, cards, steps, log)
vendor/             fastboot.min.mjs and adb.min.mjs, both MIT (see vendor/README.md)
check.sh            syntax + no-undef + the four checks below
serve.py            dev server: static files + /pkg/ proxy (same-origin, like production)
```

## The two flows

| mode | steps | effect |
|---|---|---|
| **Update** | OTA zip → recovery sideload | keeps `/data`; recovery does **not** run `addon.d`, so the add-ons have to be sideloaded again |
| **Clean** (default, left tile) | additional images over fastboot → factory reset in recovery → OTA sideload → add-ons | boot chain to the inactive slot, data wiped, ROM written by the payload |

### Clean install, step for step

1. **Firmware.** The LineageOS install page requires a specific *firmware* version before the ROM
   goes on ("Checking the correct firmware": Android 14/15/16 for bronco) and warns that getting it
   wrong can leave the device unbootable. Firmware is the part stock OS updates — a phone already
   running a custom ROM is the normal case, as long as that build was installed over the required
   stock version. This page **cannot check it**: `/vendor` on a custom ROM is the ROM's, not the
   stock firmware's. Check it on stock once; nothing here can confirm it.
2. **Additional partitions.** `boot`, `dtbo`, `vbmeta`, `vendor_boot` are what the LineageOS install
   page flashes, plus `vbmeta_system` and `recovery` from the same build (`recovery.img` is
   explicitly required there: `fastboot flash recovery recovery.img`, then reboot into recovery to
   verify it). The exact list is `images.partitions`; a missing entry fails before anything is
   wiped. `images.slotless` names the partitions that take no slot suffix (`recovery` on an A/B
   device) — the rest go to the inactive slot, the one the OTA lands on.
3. **Factory reset on the phone.** The browser cannot format partitions: `fastboot -w` = erase +
   `mkfs` on the *host*. An erased `/metadata` is exactly what recovery cannot mount and what makes
   the first boot die with "Can't load Android system. Your data may be corrupt". So recovery does
   it: *Factory Reset → Format data / factory reset* → main menu → *Apply update → Apply from ADB*.
   A pending Virtual A/B snapshot is cancelled over fastboot first (`snapshot-update:cancel`).
4. **ROM sideload.** `sideload-host`, the same block protocol the LineageOS flasher uses. LineageOS
   notes `Total xfer: 1.00x` and the "stops at 47% / `failed to read command: Success`" case — a
   silent socket after the last block is therefore treated as done, not as a failure.
5. **Do not reboot to system** before the add-ons are on (LineageOS: add-ons "need to be installed
   before booting into LineageOS for the first time"). Recovery asks
   *"To install additional packages, you need to reboot recovery first — reboot now?"*
   (`bootable/recovery/install/install.cpp`); answering **Yes** brings the sideload host back and
   the page pushes each add-on in sequence. Recovery may then say *Signature verification failed* —
   **Yes** is correct, add-ons are not signed with the ROM key.
6. **Reboot.** Back arrow → *Reboot system now*. First boot takes up to 15 minutes.

Per-device flash guides published by ROM projects describe the same order for a clean flash (boot
images → `fastboot reboot recovery` → format data → *Apply from ADB* → sideload the ROM → reboot
recovery for add-ons → reboot) and a dirty flash (reboot recovery → *Apply from ADB* → sideload the
ROM → reboot, or the in-system Updater). Guides differ per device only in *which* images are
flashed — that is `images.partitions`, nothing else.

### Add-ons and updates

`update_engine` only calls `backuptool_postinstall.sh` outside recovery
(`payload_consumer/postinstall_runner_action.cc`), and `adb sideload` runs the recovery build, so a
recovery update cannot keep add-ons. Before updating, the page checks each add-on's `detect` package
ids over adb (readable only from a booted phone):

- **present** → use the ROM's Updater instead (directions, plus a *Push the OTA to /sdcard via adb*
  button when adb is live — the install is still started by the user in the Updater, which runs
  `addon.d` and keeps them), or sideload the ROM and re-push those add-ons right after;
- **unknown** (no adb, or an add-on without `detect` ids) → ask; "I have it installed" leads to the
  same options;
- **absent** → straight to the sideload.

## flasher.json

```json
{
  "codename": "bronco",
  "name": "Motorola ThinkPhone",
  "models": ["XT2309-2", "XT2309-3"],
  "build": "Project Infinity X 4.1 · 22.10.2026",
  "channel": "latest",
  "text": {
    "title": "Flash",
    "brand": "ougi-flasher",
    "warn": "Experimental web flasher: …",
    "risks": ["I understand that this may erase the data on my phone.", "…"]
  },
  "ota":    { "label": "…", "url": "https://…zip", "size": 1857262831, "sha256": "…" },
  "images": { "label": "…", "url": "https://…zip", "size": 50158695, "sha256": "…",
              "partitions": ["boot", "dtbo", "vbmeta", "vbmeta_system", "vendor_boot", "recovery"],
              "slotless": ["recovery"] },
  "addons": [
    { "title": "MindTheGapps", "label": "MindTheGapps 17.0.0 arm64 · 22.10.2026",
      "name": "MindTheGapps-…zip", "source": "https://github.com/…/releases/latest",
      "size": 544284463, "sha256": "…",
      "detect": ["com.google.android.gms", "com.android.vending"] }
  ]
}
```

- `codename` must equal what the phone reports (`getvar product` in fastboot, `ro.product.device`
  over adb) — a mismatch disables the action button instead of writing another device's images.
- `images.partitions` are read from the additional_images zip **by name**; the run aborts before
  touching the phone if one is missing.
- `addons` is a list; the flash card renders one toggle per entry and the clean flow sideloads every
  one that is ticked. An add-on is **not fetched**: it is not mirrored, and a static page cannot read
  a GitHub release (the API sends `access-control-allow-origin: *`, the asset host sends no CORS
  headers), so the user hands over the zip with a file picker. It is hashed and compared with
  `sha256`; a mismatch is logged and shown as *unverified* rather than refused, so a newer release
  still flashes.
- `text` is the page copy: header title (and nav label), brand line, the caution banner and the risk
  list. The banner is painted by `lib/chrome.js` from `data-warn` in the HTML so it is never missing
  while `flasher.json` loads; `text.warn` replaces that wording, and an empty one removes the banner.
  `text.risks` defaults to the three safety lines and must be ticked before anything runs.
- URLs must be absolute. Served from the mirror's origin they are fetched as-is; on any other origin
  (the dev server) they go through its `/pkg/` proxy, because the mirror sends no CORS headers.

`lib/config.mjs` rejects a config with no `codename`/`name`, nothing to flash, `ota`/`images` without
`url`+`size`+`sha256`, `images` without `partitions`, or an add-on without `name`/`source` — before
the page is usable.

## Run locally

```sh
python3 serve.py 8080          # http://localhost:8080
MIRROR=https://example.org python3 serve.py 8080
```

Local files under `/pkg/` win over the proxy, so packages can be tested before they are published:

```sh
mkdir -p pkg/bronco/latest
ln -s ~/android/out/target/product/bronco/*.zip pkg/bronco/latest/
```

`localhost` counts as a secure context, so WebUSB works there. Any other host **must** be `https://`,
and the dev server sends `Cache-Control: no-store` so an edited module is never served from cache.

## Deploy

Static files only; the page has to be served from the same origin as the packages.
<https://rom.flac.moe/bronco/flasher/> is the live path:

```sh
./deploy.sh user@host:/path/under/the/webroot/bronco/flasher
```

It writes `version.txt` with the short commit it deploys; the footer prints it. A clone that was
never deployed has no such file and shows `dev`.

That directory needs a rule of its own on the web server, with the package directory reachable on
the same host (any static-file server will do; Caddy here):

```
flasher.example.org {
	handle /bronco/flasher/* {
		root * /srv/www
		file_server
	}
	handle { reverse_proxy 127.0.0.1:8080 }
}
```

## Porting to another device

1. Publish the build: the OTA zip (recovery flashable) and an `additional_images-<tag>.zip` holding
   the boot-chain images that device's flash guide flashes.
2. Edit `flasher.json` (schema above). Nothing else changes.
3. `node check-images.mjs /path/to/additional_images-<tag>.zip` — validates the config and that the
   zip carries exactly the partitions listed.
4. `./check.sh`, then deploy.

## Before anything runs

The Flash page opens with a risk acknowledgement (`confirmRisks()`): the flasher is experimental,
and every box must be ticked before the action button unlocks. Kept in `localStorage`
(`ougi-flasher:risk-ack-v1`), so it is asked once per browser. While a flash or sideload runs the UI
is locked and leaving asks first.

## Checks

```sh
./check.sh
```

`check-unlock.mjs` (lock-state parsers + reconciler, getvar sanitising, add-on detection),
`check-sideload.mjs` (the sideload reader against a scripted device, including the recovered-mid-
transfer cases), `check-paths.mjs` (URL resolution per origin), `check-images.mjs` (config via the
real loader + image set), then `node --check` and `eslint no-undef` over every file.

## Limits

- Chromium only (Chrome/Edge/Brave/Helium); Firefox and Safari have no WebUSB.
- Bootloader unlock is not possible from a browser — do it first with the vendor's unlock flow.
- The OTA is held in memory as a Blob (~1.9 GB) — the machine needs the RAM/swap for it, and a
  download cannot be resumed.
- Device mode comes from the USB interface: `ff/42/03` is fastboot, `ff/42/01` is adb.
- Recovery/sideload adbd serves only the sideload socket, so its codename cannot be checked there;
  the boot chain is already written by then.

## References

- <https://wiki.lineageos.org/devices/bronco/install/> — firmware requirement, unlocked bootloader,
  additional partitions, `fastboot flash recovery`, format data, *Apply update → Apply from ADB*,
  add-ons before first boot, signature-verification prompt, the 47%/`Success` sideload quirk.
- <https://wiki.lineageos.org/devices/bronco/upgrade/> — add-ons are reinstalled from recovery right
  after the ROM; `addon.d` only runs in the in-system Updater.
- <https://github.com/lineageos-infra/fastboot.js> — the WebUSB fastboot client this uses.
- <https://github.com/yume-chan/ya-webadb> — the adb client this uses.
