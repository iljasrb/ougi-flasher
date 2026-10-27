// Flasher config: flasher.json is the manifest. It lists configuration files (or inline objects),
// so one deployment can serve several devices or builds and each device can live in its own JSON.
// Everything device-specific — codename, image list, URLs, add-ons — lives in a configuration, and
// no code knows a phone or a ROM by name.
import { packageUrl } from './flash.mjs'

export const CONFIG = 'flasher.json'

function validate(config, where) {
	if (!config || typeof config !== 'object') throw new Error(`${where} must be an object`)
	if (!config.codename || !config.name) throw new Error(`${where}: \`codename\` and \`name\` are required`)
	if (config.id != null && (typeof config.id !== 'string' || !config.id)) throw new Error(`${where}: \`id\` must be a non-empty string`)
	if (config.source != null && typeof config.source !== 'string') throw new Error(`${where}: \`source\` must be a string`)
	if (!config.ota && !config.images) throw new Error(`${where}: nothing to flash (no \`ota\`, no \`images\`)`)
	for (const key of ['ota', 'images']) {
		const entry = config[key]
		if (!entry) continue
		if (!entry.url || !(entry.size > 0) || !/^[0-9a-f]{64}$/.test(entry.sha256 ?? '')) {
			throw new Error(`${where}: \`${key}\` needs \`url\`, \`size\` and \`sha256\``)
		}
	}
	if (config.images && !config.images.partitions?.length) throw new Error(`${where}: \`images.partitions\` is required`)
	if (config.addons != null && !Array.isArray(config.addons)) throw new Error(`${where}: \`addons\` must be an array`)
	for (const addon of config.addons ?? []) {
		if (!addon.name || !addon.source) throw new Error(`${where}: every add-on needs a \`name\` and a \`source\``)
	}
	config.id ??= config.codename
	config.addons ??= []
	if (config.images) config.images.slotless ??= []
	return config
}

async function fetchJson(source, where) {
	// A config or its artifact manifest lives on the package mirror: same origin in production, and
	// through serve.py's /pkg/ proxy on localhost, because the mirror sends no CORS headers. Relative
	// paths resolve against the page, not the origin root — the page lives under /bronco/flasher/.
	const page = globalThis.location?.href
	const target = page ? packageUrl(new URL(source, page).href, new URL(page).origin) : source
	const res = await fetch(target, { cache: 'no-store' })
	if (!res.ok) throw new Error(`${where}: HTTP ${res.status}`)
	return res.json()
}

async function resolve(config, where) {
	// `artifacts` points at a small manifest publish.sh writes next to the zips. It supplies url,
	// size and sha256 for `ota` and `images`, so a published build never needs a config edit; a
	// field set in the config itself still wins (that is how a build gets pinned).
	if (config.artifacts) {
		const latest = await fetchJson(config.artifacts, `${where}: artifacts`)
		config.build ??= latest.build
		for (const key of ['ota', 'images']) {
			if (latest[key]) config[key] = { ...latest[key], ...config[key] }
		}
	}
	return validate(config, where)
}

async function loadSource(source) {
	return resolve(await fetchJson(source, source), source)
}

export async function loadConfigs(path = CONFIG) {
	// `{ "configs": ["configs/x.json", { ... }] }` — a string is loaded, an object is inline.
	const raw = await fetchJson(path, path)
	if (!Array.isArray(raw?.configs)) throw new Error('`configs` must be an array')
	const configs = []
	for (const [index, entry] of raw.configs.entries()) {
		configs.push(typeof entry === 'string' ? await loadSource(entry) : await resolve(entry, `${path}: configs[${index}]`))
	}
	if (!configs.length) throw new Error(`${path}: no configurations`)

	const ids = new Set()
	for (const config of configs) {
		if (ids.has(config.id)) throw new Error(`${path}: duplicate config id \`${config.id}\``)
		ids.add(config.id)
	}
	return configs
}
