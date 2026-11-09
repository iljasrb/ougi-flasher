// An add-on or recovery with a `url` is mirrored and the page downloads it; the rest are not
// mirrored and a static page cannot read a GitHub release (no CORS), so the user downloads those
// once and hands them over here. Either way the hash is checked against flasher.json before
// recovery sees it.
import { sha256 } from '../zip.mjs'
import { chooseFile } from './dialog.mjs'
import { fetchPackage } from './flash.mjs'
import { every } from './log.mjs'
import { progress, step } from './steps.mjs'
import { size, statusBox } from './ui.mjs'

const say = statusBox('status')

export const shortName = (addon, index = 0) => addon.title ?? addon.label ?? addon.name ?? `add-on ${index + 1}`

const kindOf = (addon) => (addon.kind === 'image' ? 'image' : 'zip')
const extensionOf = (addon) => (kindOf(addon) === 'image' ? 'img' : 'zip')

// A mirrored package (the AERA recovery zip): same origin as the page in production, so a plain
// fetch works, and the published sha256 is verified before anything is sideloaded.
async function downloadAddon(stepId, addon, log) {
	const name = shortName(addon)
	say(`Downloading ${name}…`)
	step(stepId, 'on', `downloading ${size(addon.size)}…`)
	log(`addon: downloading ${addon.url} (${size(addon.size)})`)
	const logDownload = every(log, 'download', 20)
	const blob = await fetchPackage(addon, (p) => {
		step(stepId, 'on', `${Math.round(p * 100)}% of ${size(addon.size)}`)
		progress(stepId, p)
		logDownload(p)
	})
	step(stepId, 'done', `${size(addon.size)}, sha256 ok`)
	return blob
}

export async function pickAddon(stepId, addon, log, { strict = false, choose = chooseFile } = {}) {
	if (addon.url) return await downloadAddon(stepId, addon, log)
	const name = shortName(addon)
	const kind = kindOf(addon)
	const extension = extensionOf(addon)
	// A recovery is written straight to the recovery partition, so a missing hash is a hard stop.
	if (strict && !addon.sha256) throw new Error(`no sha256 published for ${name} — refusing to flash it`)
	say(`Choose the ${name} ${kind}…`)
	step(stepId, 'on', `pick ${addon.name}`)
	log(`addon: asking for ${addon.name} (source ${addon.href ?? addon.source}, expected sha256 ${addon.sha256 ?? 'not published'})`)
	const file = await choose({
		title: `Choose the ${name} ${kind}`,
		body: `Not downloaded here — get the ${kind} once and drop it in.`,
		href: addon.href ?? addon.source,
		hrefLabel: addon.label ?? (addon.href ? 'Download the file' : 'release page'),
		expected: addon.name,
		extension,
	})
	if (!file) throw new Error(`no ${kind} selected`)
	step(stepId, 'on', `hashing ${size(file.size)}…`)
	const digest = await sha256(file)
	const matches = !addon.sha256 || digest === addon.sha256
	log(`addon: picked ${file.name} (${size(file.size)}, sha256 ${digest}${matches ? ', matches flasher.json' : ', DIFFERS from flasher.json'})`)
	// A zip add-on may be a different build than the one pinned; a recovery is written whole to a
	// partition, so it is only accepted when it is exactly the published file.
	if (strict && !matches) throw new Error(`checksum mismatch for ${file.name}: ${digest}`)
	step(stepId, 'done', `${file.name}${matches ? ', sha256 ok' : ' — unverified'}`)
	progress(stepId, 1)
	return file
}
