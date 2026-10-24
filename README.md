# ougi-flasher

WebUSB flasher for custom ROM installs. The page downloads the package, checks its sha256 and writes
it to the phone from the browser. Nothing is installed on the user's machine and no server is
involved in the transfer. Chromium only.

`flasher.json` is the manifest: it points at one JSON file per configuration, so a deployment can
serve several devices or builds without one growing file. Everything device-specific lives in a
configuration: codename, image list, URLs, add-ons. No code knows a phone or a ROM by
name. The shipped configuration targets Project Infinity X on the Motorola ThinkPhone (`bronco`).

```
index.html      Flash    device check, download, flash (clean or update)
console.html    Console  fastboot and adb terminals
tools.html      Tools    re-sideload an add-on on its own

app.js, console.js, tools.js   page logic
flasher.json                   the configuration manifest
configs/                       one JSON per device/build
lib/config.mjs                 load and validate the manifest and configs
lib/usb.mjs                    device picker, mode detection, getvar parsing
lib/flash.mjs                  download, sha256, image read/flash, push to /sdcard
lib/adb.mjs                    connect, props, reboot, sideload-host
lib/recovery.mjs               wait for sideload mode, retry after a reconnect
lib/session.mjs                sideload wait, grant button, reconnect
lib/addons.mjs                 pick and hash an add-on zip
lib/ui.mjs, lib/dialog.mjs     tables, status boxes, dialogs
lib/term.js                    terminal pane
zip.mjs                        reads zip entries
style.css                      page styles
vendor/                        fastboot.js and ya-webadb, both MIT
serve.py                       dev server with a /pkg/ proxy
deploy.sh                      rsync deploy, writes version.txt
```

## Modes

| mode | what it does |
|---|---|
| Update (right) | sideloads the OTA over recovery. Keeps `/data`. |
| Clean (left, default) | flashes the boot-chain images over fastboot, factory reset in recovery, then sideloads the OTA and add-ons. Wipes data. |

## Clean install

The page walks through this; the phone does part of it by hand.

1. Images: `images.partitions` are read from the additional_images zip by name and flashed to the
   inactive slot, except `images.slotless` ones (`recovery` takes no slot suffix). A missing entry
   stops the run before anything is written.
2. Factory reset: the browser cannot format partitions, so recovery does it. On the phone:
   Factory Reset → Format data / factory reset → back → Apply update → Apply from ADB. A pending
   Virtual A/B snapshot is cancelled over fastboot first.
3. ROM: sideload over `sideload-host`. A socket that goes silent after the last block counts as
   success, because recovery starts verifying before it says so.
4. Add-ons: do not reboot to system yet. Answer **Yes** to the "reboot recovery for additional
   packages" prompt and the page sideloads each add-on. Recovery may warn *Signature verification
   failed* — answer Yes.
5. Back arrow → Reboot system now.

Firmware is not checked. LineageOS asks for a specific stock firmware version before flashing, and a
custom ROM's `/vendor` cannot be read to confirm it. Check it once on stock.

## Add-ons and updates

A recovery update does not run `addon.d`, so add-ons have to be installed again. Before updating,
with adb connected to a booted phone, the page looks each configured add-on up by its `detect`
package ids:

- present → offer the ROM Updater instead (it keeps add-ons), or sideload the ROM and re-push them;
- unknown, or no adb → ask;
- absent → plain sideload.

Add-on zips are not downloaded by the page. They are not mirrored and the browser cannot read a
GitHub release (no CORS), so the user picks the zip. It is hashed and compared to `sha256`; a
mismatch is logged as *unverified* and still allowed.

## Configuration files

`flasher.json` only lists where the configurations are. An entry is a path, a URL, or an inline
object:

```json
{
  "configs": [
    "configs/bronco-infinity-x.json"
  ]
}
```

`configs/bronco-infinity-x.json` holds the device/build data (the file itself is the reference):

```json
{
  "id": "bronco-infinity-x",
  "codename": "bronco",
  "name": "Motorola ThinkPhone",
  "build": "Project Infinity X 4.1 · 22.10.2026",
  "channel": "latest",
  "ota":    { "url": "https://…zip", "size": 1857262831, "sha256": "…" },
  "images": { "url": "https://…zip", "size": 50158695, "sha256": "…",
              "partitions": ["boot", "dtbo", "vbmeta", "vbmeta_system", "vendor_boot", "recovery"],
              "slotless": ["recovery"] },
  "addons": [
    { "title": "MindTheGapps", "name": "MindTheGapps-…zip",
      "source": "https://github.com/…/releases/latest", "size": 544284463, "sha256": "…",
      "detect": ["com.google.android.gms", "com.android.vending"] }
  ]
}
```

- `configs` is a list of paths, URLs, or inline objects. `id` is unique and is what the page
  remembers; it defaults to `codename`. Optional `source` is linked from the details window.
- `codename` must match what the phone reports (`getvar product`, `ro.product.device`). A mismatch
  disables the action button. When the connected phone matches exactly one configuration, that
  configuration is selected automatically.
- `ota` and `images` need `url`, `size` and `sha256`. `images` also needs `partitions`.
- `addons` is a list; the flash card shows one toggle per entry.
- Page copy — title, brand, caution banner, risk ticks — lives in the HTML pages, not the config.
- URLs must be absolute, and served from the same origin as the packages.

## Run locally

```sh
python3 serve.py 8080          # http://localhost:8080
MIRROR=https://example.org python3 serve.py 8080
```

`localhost` is a secure context, so WebUSB works. Any other host must be `https://`.

Files under `/pkg/` are served locally instead of proxied, so a package can be tested before it is
published:

```sh
mkdir -p pkg/bronco/latest
ln -s ~/android/out/target/product/bronco/*.zip pkg/bronco/latest/
```

## Deploy

Static files only, on the same origin as the packages:

```sh
./deploy.sh user@host:/path/under/the/webroot/bronco/flasher
```

The script writes `version.txt` with the short commit and the footer prints it. A clone that was
never deployed has no such file and shows `dev`. The directory needs its own rule on the web server
(any static file server; Caddy here):

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

1. Publish the OTA zip and an `additional_images-<tag>.zip` with the boot-chain images that device's
   flash guide uses.
2. Add `configs/<id>.json` and list it in `flasher.json`. Nothing else changes. The Configuration
   card on Flash and Tools opens a searchable configuration window.
3. `node check-images.mjs path/to/additional_images-<tag>.zip` checks every configuration and that
   the zip holds exactly the listed partitions.
4. `./check.sh`, then deploy.

## Limits

- Bootloader unlock cannot be done from a browser.
- The OTA is held in memory as a Blob (~1.9 GB). A download cannot be resumed.
- Mode comes from the USB interface: `ff/42/03` fastboot, `ff/42/01` adb.
- Recovery sideload only serves the sideload socket, so the codename cannot be checked there. The
  boot chain is already written by that point.
- The Flash page asks for a risk acknowledgement once per configuration (`localStorage`) before it
  enables anything, and locks the UI while a flash runs.

## Checks

```sh
./check.sh
```

Runs `check-unlock.mjs` (lock words, getvar, add-on detection), `check-sideload.mjs` (the
sideload reader against a scripted device, including reconnects), `check-paths.mjs` (URL resolution),
`check-images.mjs` (every configuration through the real loader, plus the image set), then `node --check` and
`eslint no-undef` over every file.

## Links

- <https://wiki.lineageos.org/devices/bronco/install/>
- <https://wiki.lineageos.org/devices/bronco/upgrade/>
- <https://github.com/lineageos-infra/fastboot.js>
- <https://github.com/yume-chan/ya-webadb>
