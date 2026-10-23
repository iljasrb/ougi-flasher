// Config + image-set check, no device and no network:
//  - flasher.json passes lib/config.mjs (the same loader the pages use)
//  - the additional_images zip carries exactly the partitions the config lists
//
//   node check-images.mjs                   # newest additional_images zip under pkg/
//   node check-images.mjs /path/to/zip      # an explicit archive
import { join } from 'node:path'
import { readdir, readFile } from 'node:fs/promises'
import { loadConfig } from './lib/config.mjs'
import { readImages } from './lib/flash.mjs'
import { zipIndex } from './zip.mjs'
import { check, done } from './check.mjs'

// ---- flasher.json, through the real loader -------------------------------------------
globalThis.fetch = async (path) => new Response(await readFile(path))
let config
try {
	config = await loadConfig()
	check('flasher.json loads', Boolean(config.codename), `${config.codename} · ${config.name}`)
} catch (err) {
	check('flasher.json loads', false, err.message)
	done()
}
if (config.images) {
	const { partitions, slotless } = config.images
	check('slotless partitions are also flashed', slotless.every((p) => partitions.includes(p)), slotless.join(', '))
	check('does not flash logical partitions', !partitions.some((p) => ['system', 'product', 'vendor', 'system_ext', 'vendor_dlkm'].includes(p)))
}

// ---- the zip's contents against the config -------------------------------------------
const wanted = config.images?.partitions ?? []
// default to the newest additional_images zip anywhere under pkg/
const local = (await readdir('pkg', { recursive: true }).catch(() => []))
	.filter((file) => file.endsWith('.zip') && file.includes('additional_images-'))
	.sort()
	.pop()
const zip = process.argv[2] ?? (local ? join('pkg', local) : null)
if (!zip) {
	console.log('skipped — no additional_images zip under pkg/ (pass one as an argument)')
	done()
}
console.log('checking', zip)

const blob = new Blob([await readFile(zip)])
const entries = await zipIndex(blob)
const images = await readImages(blob, wanted)
check('reads every partition the config lists', images.length === wanted.length)
for (const partition of wanted) check(`flashes ${partition}`, entries.has(`${partition}.img`))

done()
