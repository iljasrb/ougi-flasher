// Flasher config: flasher.json is the manifest. It lists configuration files (or inline objects),
// so one deployment can serve several devices or builds and each device can live in its own JSON.
// Everything device-specific — codename, image list, URLs, add-ons, recovery variants — lives in a
// configuration, and no code knows a phone or a ROM by name.
import { packageUrl } from './flash.mjs'

export const CONFIG = 'flasher.json'

const SHA256 = /^[0-9a-f]{64}$/

function validateRecovery(recovery, where) {
	if (!recovery || typeof recovery !== 'object') throw new Error(`${where} must be an object`)
	if (!recovery.name || !recovery.source) throw new Error(`${where}: a recovery needs a \`name\` and a \`source\``)
	const kind = recovery.kind ?? 'zip'
	if (kind !== 'zip' && kind !== 'image') throw new Error(`${where}: \`kind\` must be "zip" or "image"`)
	if (kind === 'image' && !/\.img$/i.test(recovery.name)) throw new Error(`${where}: image recovery \`${recovery.name}\` must be a .img`)
	if (kind === 'zip' && !/\.zip$/i.test(recovery.name)) throw new Error(`${where}: zip recovery \`${recovery.name}\` must be a .zip`)
	// A mirrored recovery is downloaded by the page, so its hash has to be known before the click.
	if (recovery.url && !(recovery.size > 0 && SHA256.test(recovery.sha256 ?? ''))) {
		throw new Error(`${where}: recovery \`${recovery.name}\` has a \`url\` so it needs \`size\` and \`sha256\``)
	}
	// A recovery is written straight to the recovery partition; never do that without a hash.
	if (!SHA256.test(recovery.sha256 ?? '')) {
		throw new Error(`${where}: recovery \`${recovery.name}\` needs a \`sha256\``)
	}
	recovery.kind = kind
	return recovery
}

function validate(config, where) {
	if (!config || typeof config !== 'object') throw new Error(`${where} must be an object`)
	if (!config.codename || !config.name) throw new Error(`${where}: \`codename\` and \`name\` are required`)
	if (config.id != null && (typeof config.id !== 'string' || !config.id)) throw new Error(`${where}: \`id\` must be a non-empty string`)
	if (config.source != null && typeof config.source !== 'string') throw new Error(`${where}: \`source\` must be a string`)
	if (!config.ota && !config.images) throw new Error(`${where}: nothing to flash (no \`ota\`, no \`images\`)`)
	for (const key of ['ota', 'images']) {
		const entry = config[key]
		if (!entry) continue
		if (!entry.url || !(entry.size > 0) || !SHA256.test(entry.sha256 ?? '')) {
			throw new Error(`${where}: \`${key}\` needs \`url\`, \`size\` and \`sha256\``)
		}
	}
	if (config.images && !config.images.partitions?.length) throw new Error(`${where}: \`images.partitions\` is required`)
	if (config.addons != null && !Array.isArray(config.addons)) throw new Error(`${where}: \`addons\` must be an array`)
	for (const addon of config.addons ?? []) {
		if (!addon || typeof addon !== 'object') throw new Error(`${where}: every add-on must be an object`)
		if (!addon.name || !addon.source) throw new Error(`${where}: every add-on needs a \`name\` and a \`source\``)
		// a mirrored add-on is downloaded by the page, so its hash has to be known before the click
		if (addon.url && !(addon.size > 0 && SHA256.test(addon.sha256 ?? ''))) {
			throw new Error(`${where}: add-on \`${addon.name}\` has a \`url\` so it needs \`size\` and \`sha256\``)
		}
	}
	if (config.recoveries != null && !Array.isArray(config.recoveries)) throw new Error(`${where}: \`recoveries\` must be an array`)
	for (const [index, recovery] of (config.recoveries ?? []).entries()) {
		validateRecovery(recovery, `${where}: recoveries[${index}]`)
	}
	config.id ??= config.codename
	config.addons ??= []
	config.recoveries ??= []
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

// GitHub's release API sends CORS headers, so a recovery published only as a release asset can
// still be followed: the page learns the newest tag, the asset's size and its SHA-256. The asset
// itself is fetched by the user (release downloads send no CORS headers), so `href` is a link and
// not a `url` — `url` means "the page downloads this".
async function resolveGithub(addon, where) {
	if (!addon?.github) return addon
	const { repo, asset, tag } = addon.github
	if (!repo || !asset) throw new Error(`${where}: \`github\` needs \`repo\` and \`asset\``)
	try {
		const res = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=100`, {
			cache: 'no-store',
			headers: { Accept: 'application/vnd.github+json' },
		})
		if (!res.ok) throw new Error(`HTTP ${res.status}`)
		const releases = await res.json()
		const match = releases.find(
			(release) =>
				!release.draft &&
				!release.prerelease &&
				(!tag || new RegExp(tag).test(release.tag_name)) &&
				release.assets?.some((item) => item.name === asset),
		)
		if (!match) throw new Error(`no release with ${asset}`)
		const found = match.assets.find((item) => item.name === asset)
		const digest = found.digest?.replace(/^sha256:/, '')
		// The API is the source of truth when it answers; the pinned fields are the offline fallback.
		return {
			...addon,
			href: found.browser_download_url,
			name: found.name ?? addon.name,
			size: found.size ?? addon.size,
			sha256: digest ?? addon.sha256,
			version: match.tag_name,
			published: match.published_at,
		}
	} catch {
		// The pinned fields in the config still work when the API is rate-limited or offline.
		return addon
	}
}

// An add-on or recovery can point at the manifest of its own project (`artifacts` + `pick`), the
// same way the ROM does — AERA publishes a latest.json with an `image` and an `installer` entry. A
// field set in the config still wins, and `name` falls back to the published file name, so a new
// AERA build needs no config edit at all.
async function resolveAddon(addon, where) {
	let resolved = addon
	if (resolved?.artifacts) {
		const key = resolved.pick ?? 'installer'
		const latest = await fetchJson(resolved.artifacts, `${where}: artifacts`)
		const entry = latest[key]
		if (!entry?.url) throw new Error(`${where}: ${resolved.artifacts} has no \`${key}\``)
		resolved = { ...entry, ...resolved, name: resolved.name ?? entry.url.split('/').pop() }
	}
	return await resolveGithub(resolved, where)
}

async function resolve(config, where) {
	// Check the list shapes before iterating them: the detailed validation runs after the manifests
	// are resolved, but a non-array here would otherwise fail with a TypeError instead of a message.
	if (config.addons != null && !Array.isArray(config.addons)) throw new Error(`${where}: \`addons\` must be an array`)
	if (config.recoveries != null && !Array.isArray(config.recoveries)) throw new Error(`${where}: \`recoveries\` must be an array`)
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
	for (const [index, addon] of (config.addons ?? []).entries()) {
		config.addons[index] = await resolveAddon(addon, `${where}: addons[${index}]`)
	}
	for (const [index, recovery] of (config.recoveries ?? []).entries()) {
		config.recoveries[index] = await resolveAddon(recovery, `${where}: recoveries[${index}]`)
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
