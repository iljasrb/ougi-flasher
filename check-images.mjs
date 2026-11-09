// Config + image-set check, no device and no network:
//  - flasher.json and its config files pass lib/config.mjs (the same loader the pages use)
//  - the additional_images zip carries exactly the partitions a configuration lists
//
//   node check-images.mjs                   # every config with a matching zip under pkg/
//   node check-images.mjs /path/to/zip      # an explicit archive, matched to its config by name
import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import { readdir, readFile } from 'node:fs/promises'
import { loadConfigs } from './lib/config.mjs'
import { readImages } from './lib/flash.mjs'
import { zipIndex } from './zip.mjs'
import { check, done } from './check.mjs'

// ---- flasher.json, through the real loader -------------------------------------------
// readdir() answers relative to pkg/, so the paths are made readable from here
const local = (await readdir('pkg', { recursive: true }).catch(() => []))
	.filter((file) => file.endsWith('.zip'))
	.map((file) => join('pkg', file))
	.filter((file) => existsSync(file)) // skip a stale/broken test symlink instead of crashing
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
for (const recovery of fixture.recoveries) {
	delete recovery.artifacts
	delete recovery.github // already resolved above; the fixture tests mock no GitHub
}
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
check('a mirrored add-on keeps its config fields', addon.pick === 'installer', addon.pick)

// ---- a recovery variant is a list entry with a kind, and only one is installed at a time ----
const mirroredRecovery = {
	id: 'mirror-recovery',
	codename: 'bronco',
	name: 'x',
	ota: { url: 'https://rom.flac.moe/bronco/latest/a.zip', size: 1, sha256: '0'.repeat(64) },
	recoveries: [{ title: 'AERA', kind: 'zip', source: 'https://rom.flac.moe/aera/', artifacts: 'https://rom.flac.moe/aera/aera.json', pick: 'installer' }],
}
globalThis.fetch = async (path) => new Response(JSON.stringify(String(path).endsWith('aera.json') ? aeraLatest : { configs: [mirroredRecovery] }))
const [pulledRecovery] = await loadConfigs('mirrored-recovery.json')
const recovery = pulledRecovery.recoveries[0]
check('a mirrored recovery gets url, size and sha256 from its manifest', recovery.url === aeraLatest.installer.url && recovery.size === aeraLatest.installer.size && recovery.sha256 === aeraLatest.installer.sha256, recovery.url)
check('a mirrored recovery is named after the published file', recovery.name === 'AERA-bronco-74-split.zip', recovery.name)
check('a mirrored recovery keeps its kind', recovery.kind === 'zip', recovery.kind)

// An image is written straight to the recovery partition, so it is rejected without a hash.
const badImage = { ...mirroredRecovery, id: 'bad-image', recoveries: [{ title: 'Skyward', kind: 'image', source: 'https://github.com/iljasrb/skyward', name: 'skyward-bronco.img' }] }
globalThis.fetch = async () => new Response(JSON.stringify({ configs: [badImage] }))
let rejectedImage = false
try {
	await loadConfigs('bad-image.json')
} catch {
	rejectedImage = true
}
check('a recovery without a sha256 is rejected', rejectedImage)

// ---- a GitHub-only image follows the newest matching release ----------------------------
const githubReleases = [
	{ tag_name: 'r8q-20261110', draft: false, assets: [{ name: 'skyward-r8q.img', size: 1, digest: `sha256:${'c'.repeat(64)}`, browser_download_url: 'https://github.com/x/r8q.img' }] },
	{ tag_name: 'bronco-20261108', draft: false, assets: [{ name: 'skyward-bronco.img', size: 104857600, digest: `sha256:${'b'.repeat(64)}`, browser_download_url: 'https://github.com/x/skyward-bronco.img' }] },
]
const githubConfig = {
	...mirroredRecovery,
	id: 'github-recovery',
	recoveries: [
		{
			title: 'Skyward',
			kind: 'image',
			source: 'https://github.com/iljasrb/skyward/releases/latest',
			github: { repo: 'iljasrb/skyward', asset: 'skyward-bronco.img', tag: '^bronco-' },
			name: 'skyward-bronco.img',
			size: 1,
			sha256: '0'.repeat(64),
		},
	],
}
globalThis.fetch = async (path) => {
	if (String(path).startsWith('https://api.github.com/')) return new Response(JSON.stringify(githubReleases))
	return new Response(JSON.stringify({ configs: [githubConfig] }))
}
const [githubLoaded] = await loadConfigs('github-recovery.json')
const skyward = githubLoaded.recoveries[0]
check('a GitHub recovery follows the newest matching release', skyward.sha256 === 'b'.repeat(64) && skyward.size === 104857600 && skyward.href.endsWith('skyward-bronco.img'), `${skyward.sha256} ${skyward.size}`)
check('a GitHub recovery keeps the tag it came from', skyward.version === 'bronco-20261108', skyward.version)

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
