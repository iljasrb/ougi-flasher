// Flasher config: flasher.json is the manifest. It lists configuration files (or inline objects),
// so one deployment can serve several devices or builds and each device can live in its own JSON.
// Everything device-specific — codename, image list, URLs, add-ons — lives in a configuration, and
// no code knows a phone or a ROM by name.
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

async function loadSource(source) {
	const res = await fetch(source, { cache: 'no-store' })
	if (!res.ok) throw new Error(`${source}: HTTP ${res.status}`)
	return validate(await res.json(), source)
}

export async function loadConfigs(path = CONFIG) {
	const res = await fetch(path, { cache: 'no-store' })
	if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`)

	// `{ "configs": ["configs/x.json", { ... }] }` — a string is loaded, an object is inline.
	const raw = await res.json()
	if (!Array.isArray(raw?.configs)) throw new Error('`configs` must be an array')
	const configs = []
	for (const [index, entry] of raw.configs.entries()) {
		configs.push(typeof entry === 'string' ? await loadSource(entry) : validate(entry, `${path}: configs[${index}]`))
	}
	if (!configs.length) throw new Error(`${path}: no configurations`)

	const ids = new Set()
	for (const config of configs) {
		if (ids.has(config.id)) throw new Error(`${path}: duplicate config id \`${config.id}\``)
		ids.add(config.id)
	}
	return configs
}
