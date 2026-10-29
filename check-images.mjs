// Config + image-set check, no device and no network:
//  - flasher.json and its config files pass lib/config.mjs (the same loader the pages use)
//  - the additional_images zip carries exactly the partitions a configuration lists
//
//   node check-images.mjs                   # every config with a matching zip under pkg/
//   node check-images.mjs /path/to/zip      # an explicit archive, matched to its config by name
import { basename, join } from 'node:path'
import { readdir, readFile } from 'node:fs/promises'
import { loadConfigs } from './lib/config.mjs'
import { readImages } from './lib/flash.mjs'
import { zipIndex } from './zip.mjs'
import { check, done } from './check.mjs'

// ---- flasher.json, through the real loader -------------------------------------------
// readdir() answers relative to pkg/, so the paths are made readable from here
const local = (await readdir('pkg', { recursive: true }).catch(() => [])).filter((file) => file.endsWith('.zip')).map((file) => join('pkg', file))
// No network in a check: stand in for the manifest publish.sh writes next to the zips. The URLs
// point at whatever zips are under pkg/, so the contents check below still runs; only the hashes
// are fake, and the loader only checks their shape.
const pick = (prefix) => basename(local.filter((file) => basename(file).startsWith(prefix)).sort().pop() ?? `${prefix}fixture.zip`)
const latest = {
	build: 'fixture build',
	ota: { url: `https://rom.flac.moe/bronco/latest/${pick('Project_Infinity-X-')}`, size: 1, sha256: '0'.repeat(64) },
	images: { url: `https://rom.flac.moe/bronco/latest/${pick('additional_images-')}`, size: 1, sha256: '0'.repeat(64) },
	installer: { url: 'https://rom.flac.moe/bronco/recovery/aera/latest/AERA-bronco-fixture.zip', size: 1, sha256: '0'.repeat(64) },
}
globalThis.fetch = async (path) => {
	const file = String(path)
	if (file.endsWith('/latest.json')) return new Response(JSON.stringify(latest))
	return new Response(await readFile(file))
}
let configs
try {
	configs = await loadConfigs()
	check('flasher.json loads', configs.length > 0, `${configs.length} configuration(s)`)
} catch (err) {
	check('flasher.json loads', false, err.message)
	done()
}

for (const config of configs) {
	check(`${config.id}: has a codename and name`, Boolean(config.codename && config.name), `${config.codename} · ${config.name}`)
	check(`${config.id}: has something to flash`, Boolean(config.ota || config.images))
	if (!config.images) continue
	const { partitions, slotless } = config.images
	check(`${config.id}: slotless partitions are also flashed`, slotless.every((p) => partitions.includes(p)), slotless.join(', '))
	check(`${config.id}: does not flash logical partitions`, !partitions.some((p) => ['system', 'product', 'vendor', 'system_ext', 'vendor_dlkm'].includes(p)))
}

// ---- the loader itself: lists, old shape, unique ids ---------------------------------
// The real file above already passed; these use the same valid config as a fixture and a mocked
// fetch, so adding a second configuration cannot quietly break the loader.
const fixture = structuredClone(configs[0])
delete fixture.artifacts // already resolved above; the fixture tests mock no manifest
for (const addon of fixture.addons) delete addon.artifacts
const respond = (body) => {
	globalThis.fetch = async () => new Response(JSON.stringify(body))
}

respond({ configs: [fixture, { ...structuredClone(fixture), id: 'second' }] })
check('loads multiple configurations', (await loadConfigs('mock')).length === 2)

const files = { 'manifest.json': { configs: ['configs/fixture.json'] }, 'configs/fixture.json': fixture }
globalThis.fetch = async (path) => new Response(JSON.stringify(files[path]))
check('loads configurations from their own files', (await loadConfigs('manifest.json')).length === 1)

respond({ configs: [fixture, structuredClone(fixture)] })
let duplicate = false
try {
	await loadConfigs('mock')
} catch {
	duplicate = true
}
check('rejects duplicate configuration ids', duplicate)

// ---- a mirrored add-on takes url/size/sha256 from its own project's manifest -------------
const aeraLatest = { build: '74', image: { url: 'x', size: 1, sha256: '0'.repeat(64) }, installer: { url: 'https://rom.flac.moe/aera/AERA-bronco-74-split.zip', size: 53181146, sha256: '1'.repeat(64) } }
globalThis.fetch = async (path) => new Response(JSON.stringify(String(path).endsWith('aera.json') ? aeraLatest : { configs: [mirrored] }))
const mirrored = {
	id: 'mirror',
	codename: 'bronco',
	name: 'x',
	ota: { url: 'https://rom.flac.moe/bronco/latest/a.zip', size: 1, sha256: '0'.repeat(64) },
	addons: [{ title: 'AERA', source: 'https://rom.flac.moe/aera/', artifacts: 'https://rom.flac.moe/aera/aera.json', pick: 'installer', always: true }],
}
const [pulled] = await loadConfigs('mirrored.json')
const addon = pulled.addons[0]
check('a mirrored add-on gets url, size and sha256 from its manifest', addon.url === aeraLatest.installer.url && addon.size === aeraLatest.installer.size && addon.sha256 === aeraLatest.installer.sha256, addon.url)
check('a mirrored add-on is named after the published file', addon.name === 'AERA-bronco-74-split.zip', addon.name)
check('a mirrored add-on keeps its config fields', addon.always === true && addon.pick === 'installer', JSON.stringify([addon.always, addon.pick]))

// ---- each configuration's zip against its contents ----------------------------------
const explicit = process.argv[2] ?? null
let checked = 0

for (const config of configs) {
	if (!config.images) continue
	const name = basename(config.images.url)
	const zip = explicit && basename(explicit) === name ? explicit : local.filter((file) => basename(file) === name).sort().pop()
	if (!zip) continue
	console.log(`checking ${config.id}: ${zip}`)

	const blob = new Blob([await readFile(zip)])
	const entries = await zipIndex(blob)
	const wanted = config.images.partitions
	const images = await readImages(blob, wanted)
	check(`${config.id}: reads every partition the config lists`, images.length === wanted.length)
	for (const partition of wanted) check(`${config.id}: flashes ${partition}`, entries.has(`${partition}.img`))
	checked++
}

// A relative config path must resolve against the page, not the origin root: the deployed page
// lives under /bronco/flasher/ while the packages live under /bronco/latest/.
const page = 'https://rom.flac.moe/bronco/flasher/index.html'
globalThis.location = { href: page, origin: new URL(page).origin }
const manifestConfig = { id: 'x', codename: 'bronco', name: 'x', ota: { url: 'https://rom.flac.moe/bronco/latest/a.zip', size: 1, sha256: '0'.repeat(64) } }
const askedPaths = []
globalThis.fetch = async (path) => {
	askedPaths.push(String(path))
	return new Response(JSON.stringify(String(path).endsWith('flasher.json') ? { configs: ['configs/x.json'] } : manifestConfig))
}
await loadConfigs('flasher.json')
check('relative config paths resolve against the page', !askedPaths.includes('https://rom.flac.moe/configs/x.json') && askedPaths.includes('https://rom.flac.moe/bronco/flasher/configs/x.json'), askedPaths.join(' '))
delete globalThis.location

if (!checked) console.log('skipped image zips — none under pkg/ matches a configuration (pass one as an argument)')
done()
