Vendored, browser-ready ES modules. Both are MIT.

| file | package | rebuilt with |
|---|---|---|
| `fastboot.min.mjs` | `@lineageos-infra/android-fastboot@1.1.6` | `npm pack` → `dist/fastboot.min.mjs` |
| `adb.min.mjs` | `@yume-chan/adb@2.6.4` + `adb-daemon-webusb@2.3.2` + `adb-credential-web@2.1.0` | `npx esbuild adb-entry.js --bundle --format=esm --minify --outfile=adb.min.mjs` in a dir with those three installed |

`adb-entry.js` is the bundle entry (kept so the build is reproducible).
