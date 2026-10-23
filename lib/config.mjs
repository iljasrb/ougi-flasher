// Flasher config: flasher.json. One deployment serves one device, so this file is the only thing
// that is device-specific — swap it (and the packages it points at) and the same pages flash another
// phone. Nothing here knows about a codename in particular.
export const CONFIG = 'flasher.json'

export async function loadConfig(path = CONFIG) {
	const res = await fetch(path, { cache: 'no-store' })
	if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`)
	const config = await res.json()

	if (!config.codename || !config.name) throw new Error(`${path}: \`codename\` and \`name\` are required`)
	if (!config.ota && !config.images) throw new Error(`${path}: nothing to flash (no \`ota\`, no \`images\`)`)
	for (const key of ['ota', 'images']) {
		const entry = config[key]
		if (!entry) continue
		if (!entry.url || !(entry.size > 0) || !/^[0-9a-f]{64}$/.test(entry.sha256 ?? '')) {
			throw new Error(`${path}: \`${key}\` needs \`url\`, \`size\` and \`sha256\``)
		}
	}
	if (config.images && !config.images.partitions?.length) throw new Error(`${path}: \`images.partitions\` is required`)
	for (const addon of config.addons ?? []) {
		if (!addon.name || !addon.source) throw new Error(`${path}: every add-on needs a \`name\` and a \`source\``)
	}
	config.addons ??= []
	if (config.images) config.images.slotless ??= []
	return config
}
