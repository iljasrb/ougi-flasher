# ougi-flasher

WebUSB flasher for ROM packages. The page downloads the package, and writes
it to the phone from the browser. Nothing is installed on the user's machine. Chromium only.

`flasher.json` is the manifest: it points at one JSON file per configuration, so a deployment can
serve several devices or builds without one growing file. Everything device-specific lives in a
configuration: codename, image list, URLs, add-ons. No code knows a phone or a ROM by
name. The shipped configuration targets Project Infinity X on the Motorola ThinkPhone (`bronco`).

```
index.html      Flash    device check, download, flash (clean or update)
console.html    Console  fastboot and adb terminals
tools.html      Tools    re-sideload an add-on or zip recovery on its own

app.js, console.js, tools.js   page logic
flasher.json                   the configuration manifest
configs/                       one JSON per device/build
lib/config.mjs                 load and validate the manifest and configs
lib/usb.mjs                    device picker, mode detection, getvar parsing
lib/flash.mjs                  download, sha256, image read/flash, push to /sdcard
lib/adb.mjs                    connect, props, reboot, sideload-host
lib/recovery.mjs               wait for sideload mode, retry after a reconnect
lib/session.mjs                sideload wait, grant button, reconnect
lib/addons.mjs                 pick or download a package, hash it
lib/plans.mjs                  step plans for the Flash page
lib/ui.mjs, lib/dialog.mjs     tables, status boxes, dialogs
lib/term.js                    terminal pane
zip.mjs                        reads zip entries
style.css                      page styles
vendor/                        fastboot.js and ya-webadb, both MIT
serve.py                       dev server with a /pkg/ proxy
deploy.sh                      rsync deploy, writes version.txt
```

## Modes

Modes (Clean, Update) are now hardcoded, but soon will be configurable from the device config.

## Clean install

The page walks through this; the phone does part of it by hand.

1. Images: `images.partitions` are read from the additional_images zip by name and flashed to the
   inactive slot. `images.slotless` is only for a partition that really has no slot suffix; on this
   phone `recovery` is `recovery_a` / `recovery_b`, so it is not listed there. A missing entry stops
   the run before anything is written.
2. Factory reset: relying on fastboot wipe commands isn't robust in my opinion, so for now flasher tells user to do a factory reset in the recovery. On the phone:
   Factory Reset → Format data / factory reset → back → Apply update → Apply from ADB. A pending
   Virtual A/B snapshot is cancelled over fastboot first.
3. ROM: sideload over `sideload-host`.
4. Packages: do not reboot to system yet. Answer **Yes** to the "reboot recovery for additional
   packages" prompt and the page sideloads each add-on. Recovery may warn *Signature verification
   failed* — answer Yes. A zip recovery (AERA) is sideloaded here too.
5. Recovery image: an image recovery (Skyward) cannot be sideloaded. After the ROM and the zip
   packages, the page reboots to the bootloader and flashes it to both recovery slots. It has to be
   after the ROM: the OTA payload contains `recovery`, so an earlier flash would be overwritten.
6. Back arrow → Reboot system now.

Firmware is currently not checked.

## Recoveries and add-ons

A ROM install overwrites the recovery partition. The card therefore has a single-choice **recovery**
list — *No custom recovery*, AERA, Skyward — and never installs more than one. The chosen recovery
is installed after the ROM:

- a `kind: "zip"` recovery is a sideload package (AERA's installer writes `recovery_a` and
  `recovery_b`, which is how it survives the slot switch);
- a `kind: "image"` recovery is a whole partition image (Skyward). The page reboots to the
  bootloader after the ROM and flashes `recovery_a` and `recovery_b` with fastboot.

Add-ons (GApps and the like) are separate checkboxes. A recovery update does not run `addon.d`, so
add-ons have to be installed again. Before updating, with adb connected to a booted phone, the page
looks each configured add-on up by its `detect` package ids:

- present → offer the ROM Updater instead (it keeps add-ons), or sideload the ROM and re-push them;
- unknown, or no adb → ask;
- absent → plain sideload.

A selected recovery forces the sideload path: the Updater rewrites recovery too, so it would drop
the recovery the user asked for.

Packages that are not mirrored are not downloaded by the page. The browser cannot read a GitHub
release asset (no CORS), so the user downloads it once and picks it. It is hashed and compared to
`sha256`; a mismatched zip add-on is logged as *unverified* and still allowed, but a recovery is
refused.

A package that *is* mirrored carries a `url` and the page downloads it itself. A GitHub-only image
can instead carry `github` (`repo`, `asset`, optional `tag` regex): the page asks the GitHub API for
the newest matching release, its size and SHA-256, and links the user to the asset. The pinned
`name`/`size`/`sha256` in the config are the offline fallback. The AERA recovery uses `artifacts` +
`pick: "installer"`, so a new AERA build needs no config edit.

## Configuration files

`flasher.json` only lists where the configurations are:

```json
{
  "configs": [
    "configs/bronco-infinity-x.json"
  ]
}
```

`configs/bronco-infinity-x.json` holds the device/build data:

```json
{
  "id": "bronco-infinity-x",
  "codename": "bronco",
  "name": "Motorola ThinkPhone",
  "channel": "latest",
  "artifacts": "https://…/bronco/latest/latest.json",
  "images": { "partitions": ["boot", "dtbo", "vbmeta", "vbmeta_system", "vendor_boot", "recovery"] },
  "recoveries": [
    { "title": "AERA Recovery", "kind": "zip", "source": "https://…/aera/latest/",
      "artifacts": "https://…/aera/latest/latest.json", "pick": "installer" },
    { "title": "Skyward Recovery", "kind": "image",
      "source": "https://github.com/iljasrb/skyward/releases/latest",
      "github": { "repo": "iljasrb/skyward", "asset": "skyward-bronco.img", "tag": "^bronco-" },
      "name": "skyward-bronco.img", "size": 104857600, "sha256": "…" }
  ],
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
- `artifacts` points at a small manifest that `publish.sh` writes next to the zips
  (`latest/latest.json`). It supplies `build`, and `url`, `size`, `sha256` for `ota` and `images`, so
  publishing a build never needs a config edit. A field set in the config itself wins — that is how
  a build gets pinned.
- `ota` and `images` need `url`, `size` and `sha256` (from the manifest or the config). `images`
  also needs `partitions`.
- `recoveries` is a list; the card shows a radio for each entry plus *No custom recovery*, so at
  most one is installed. `kind` is `"zip"` (default) or `"image"`. `url`, `size` and `sha256` make
  the page download it (mirrored); `artifacts` + `pick` take them from the project's own manifest;
  `github` follows a release asset through the GitHub API. A recovery always needs a `sha256`,
  because it is written whole to the recovery partition.
- `addons` is a list; the card shows one checkbox per entry, unticked unless chosen. `url`, `size`
  and `sha256` make the page download it (mirrored); `artifacts` + `pick` take them from the
  project's own manifest (`latest.json`, key `installer` here) so a new build needs no config edit:
  `name` then defaults to the published file name. `detect` lists the package ids that mean
  *installed*.
- Page copy — title, brand, caution banner, risk ticks — lives in the HTML pages, not the config.
- URLs must be absolute, and served from the same origin as the packages (the GitHub API is the one
  exception: it sends CORS headers, and only its metadata is read).

## Checks

`./check.sh` runs the syntax lint and the no-device tests:

- `check-unlock.mjs` — lock words, getvar parsing, add-on detection;
- `check-sideload.mjs` — the sideload reader and the recovery poller;
- `check-paths.mjs` — package URL resolution;
- `check-config.mjs` — recovery variants, validation, artifacts and GitHub resolution;
- `check-packages.mjs` — download/hash, image flashing, package picking, sideload retry;
- `check-plans.mjs` — step plans and the single-recovery invariant;
- `check-images.mjs` — config loading and the additional_images zip.

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
2. Add `configs/<id>.json` and list it in `flasher.json`. List the boot-chain partitions in
   `images.partitions`; leave `images.slotless` empty unless the device really has a partition with
   no slot suffix. Add recovery variants under `recoveries` if the device has any.
3. `node check-images.mjs path/to/additional_images-<tag>.zip` checks every configuration and that
   the zip holds exactly the listed partitions.
4. `./check.sh`, then deploy.

## Limits

- Bootloader unlock cannot be done from a browser. -> will be configurable.
- The OTA is held in memory as a Blob (~1.9 GB). A download cannot be resumed.
- Mode comes from the USB interface: `ff/42/03` fastboot, `ff/42/01` adb.
- Recovery sideload only serves the sideload socket, so the codename cannot be checked there. The
  boot chain is already written by that point.
- An image recovery is flashed from the bootloader after the ROM. If the update was started over
  adb, the bootloader is a different USB identity and may need the *Allow bootloader* button once.
- GitHub release assets send no CORS headers, so an image published only on GitHub is downloaded by
  the user and picked in the page; the GitHub API supplies the expected hash.
- The Flash page asks for a risk acknowledgement once per configuration (`localStorage`) before it
  enables anything, and locks the UI while a flash runs.

## Links

- <https://wiki.lineageos.org/devices/bronco/install/>
- <https://wiki.lineageos.org/devices/bronco/upgrade/>
- <https://github.com/lineageos-infra/fastboot.js>
- <https://github.com/yume-chan/ya-webadb>
