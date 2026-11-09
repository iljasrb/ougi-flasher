// Config loader checks: recovery variants, validation, artifacts and GitHub resolution.
// No network: every fetch is answered from the test.
//
//   node check-config.mjs
import { loadConfigs } from './lib/config.mjs'
import { check, done, eq } from './check.mjs'

const json = (body) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
const sha = (char) => char.repeat(64)

const base = () => ({
	id: 'test',
	codename: 'bronco',
	name: 'Test phone',
	ota: { url: 'https://example.test/ota.zip', size: 10, sha256: sha('0') },
})

// The loader fetches the manifest, then any artifacts manifest, then the GitHub API. A route is
// chosen by prefix so a test can answer only the part it cares about.
async function load(config, { latest = null, github = null } = {}) {
	globalThis.fetch = async (url) => {
		const key = String(url)
		if (key === 'mock') return json({ configs: [config] })
		if (key.startsWith('https://api.github.com/')) {
			if (github instanceof Response) return github
			return json(github ?? { message: 'not configured' })
		}
		if (latest) return json(latest)
		return new Response('not found', { status: 404 })
	}
	const [loaded] = await loadConfigs('mock')
	return loaded
}

async function rejects(config, pattern) {
	try {
		await load(config)
		return false
	} catch (err) {
		return pattern ? pattern.test(err.message) : true
	}
}

const recovery = (overrides = {}) => ({ title: 'Recovery', source: 'https://example.test/recovery', name: 'recovery.zip', sha256: sha('1'), ...overrides })

// ---- recoveries are a list, and every entry is validated ------------------------------
const empty = await load(base())
check('recoveries defaults to an empty list', Array.isArray(empty.recoveries) && empty.recoveries.length === 0)

const many = await load({
	...base(),
	recoveries: [recovery({ title: 'Zip', kind: 'zip' }), recovery({ title: 'Image', kind: 'image', name: 'recovery.img', sha256: sha('2') })],
})
check('loads multiple recoveries', many.recoveries.length === 2 && many.recoveries[0].kind === 'zip' && many.recoveries[1].kind === 'image')

const defaultKind = await load({ ...base(), recoveries: [recovery()] })
eq('a recovery defaults to kind zip', defaultKind.recoveries[0].kind, 'zip')

check('rejects an image recovery that is not a .img', await rejects({ ...base(), recoveries: [recovery({ kind: 'image' })] }, /must be a \.img/))
check('rejects a zip recovery that is not a .zip', await rejects({ ...base(), recoveries: [recovery({ name: 'recovery.img' })] }, /must be a \.zip/))
check('rejects an unknown recovery kind', await rejects({ ...base(), recoveries: [recovery({ kind: 'tar' })] }, /kind/))
check('rejects a recovery without a name', await rejects({ ...base(), recoveries: [{ source: 'https://example.test', sha256: sha('1') }] }, /name/))
check('rejects a recovery without a source', await rejects({ ...base(), recoveries: [{ name: 'recovery.zip', sha256: sha('1') }] }, /source/))
check('rejects a recovery without a sha256', await rejects({ ...base(), recoveries: [{ source: 'https://example.test', name: 'recovery.zip' }] }, /sha256/))
check(
	'rejects a mirrored recovery without a size',
	await rejects({ ...base(), recoveries: [recovery({ url: 'https://example.test/recovery.zip' })] }, /size/),
)
check('rejects a non-array recoveries field', await rejects({ ...base(), recoveries: {} }, /recoveries/))
check('rejects a null recovery entry', await rejects({ ...base(), recoveries: [null] }, /must be an object/))
check('rejects a non-array addons field', await rejects({ ...base(), addons: {} }, /addons/))
check('rejects a null add-on entry', await rejects({ ...base(), addons: [null] }, /must be an object/))

// ---- a recovery can follow its project's own manifest --------------------------------
const latest = { installer: { url: 'https://example.test/AERA-1.zip', size: 123, sha256: sha('a') } }
const mirrored = await load(
	{ ...base(), recoveries: [{ title: 'AERA', kind: 'zip', source: 'https://example.test/aera/', artifacts: 'https://example.test/aera/latest.json', pick: 'installer' }] },
	{ latest },
)
check(
	'a recovery resolves url, size and sha256 from its artifacts manifest',
	mirrored.recoveries[0].url === latest.installer.url &&
		mirrored.recoveries[0].size === latest.installer.size &&
		mirrored.recoveries[0].sha256 === latest.installer.sha256 &&
		mirrored.recoveries[0].name === 'AERA-1.zip',
	mirrored.recoveries[0].name,
)

const addonFromManifest = await load(
	{ ...base(), addons: [{ title: 'AERA', source: 'https://example.test/aera/', artifacts: 'https://example.test/aera/latest.json', pick: 'installer' }] },
	{ latest },
)
check('an add-on still resolves from its artifacts manifest', addonFromManifest.addons[0].url === latest.installer.url && addonFromManifest.addons[0].name === 'AERA-1.zip')

// ---- a GitHub-only image follows the newest matching release --------------------------
const githubRecovery = (overrides = {}) => ({
	...base(),
	recoveries: [
		{
			title: 'Skyward',
			kind: 'image',
			source: 'https://github.com/iljasrb/skyward/releases/latest',
			github: { repo: 'iljasrb/skyward', asset: 'skyward-bronco.img', tag: '^bronco-' },
			name: 'skyward-bronco.img',
			size: 1,
			sha256: sha('0'),
			...overrides,
		},
	],
})
const release = (tag, { draft = false, prerelease = false, asset = 'skyward-bronco.img', size = 100, digest = sha('b'), href = `https://github.com/x/${tag}/${asset}` } = {}) => ({
	tag_name: tag,
	draft,
	prerelease,
	published_at: '2026-01-01T00:00:00Z',
	assets: [{ name: asset, size, digest: digest ? `sha256:${digest}` : undefined, browser_download_url: href }],
})

const newest = await load(githubRecovery(), { github: [release('r8q-1', { asset: 'skyward-r8q.img' }), release('bronco-2', { size: 200 })] })
check(
	'a GitHub recovery follows the newest matching release',
	newest.recoveries[0].version === 'bronco-2' &&
		newest.recoveries[0].size === 200 &&
		newest.recoveries[0].sha256 === sha('b') &&
		newest.recoveries[0].href === 'https://github.com/x/bronco-2/skyward-bronco.img',
	`${newest.recoveries[0].version} ${newest.recoveries[0].size}`,
)

const stable = await load(githubRecovery(), { github: [release('bronco-3', { draft: true }), release('bronco-2', { prerelease: true }), release('bronco-1')] })
eq('a GitHub recovery ignores drafts and prereleases', stable.recoveries[0].version, 'bronco-1')

const filtered = await load(githubRecovery(), { github: [release('other-9'), release('bronco-1')] })
eq('a GitHub recovery follows the tag filter', filtered.recoveries[0].version, 'bronco-1')

const httpError = await load(githubRecovery(), { github: new Response('nope', { status: 500 }) })
check(
	'a GitHub recovery keeps pinned fields when the API fails',
	httpError.recoveries[0].version === undefined && httpError.recoveries[0].size === 1 && httpError.recoveries[0].sha256 === sha('0'),
)

const nonsense = await load(githubRecovery(), { github: { message: 'rate limited' } })
check('a GitHub recovery keeps pinned fields when the API answers nonsense', nonsense.recoveries[0].version === undefined && nonsense.recoveries[0].size === 1)

const noDigest = await load(githubRecovery(), { github: [release('bronco-2', { size: 200, digest: null })] })
check(
	'a GitHub recovery falls back to the pinned sha256 when the API has no digest',
	noDigest.recoveries[0].version === 'bronco-2' && noDigest.recoveries[0].size === 200 && noDigest.recoveries[0].sha256 === sha('0'),
)

const noAsset = await load(githubRecovery(), { github: [release('bronco-2', { asset: 'other.img' })] })
check('a GitHub recovery keeps pinned fields when no release has the asset', noAsset.recoveries[0].version === undefined && noAsset.recoveries[0].size === 1)

done()
