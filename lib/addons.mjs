// An add-on with a `url` is mirrored and the page downloads it; the rest are not mirrored and a
// static page cannot read a GitHub release (no CORS), so the user downloads those once and hands
// them over here. Either way the hash is checked against flasher.json before recovery sees it.
import { sha256 } from '../zip.mjs'
import { chooseFile } from './dialog.mjs'
import { fetchPackage } from './flash.mjs'
import { every } from './log.mjs'
import { progress, step } from './steps.mjs'
import { size, statusBox } from './ui.mjs'

const say = statusBox('status')

export const shortName = (addon, index = 0) => addon.title ?? addon.label ?? `add-on ${index + 1}`

// A mirrored zip (the AERA recovery package): same origin as the page in production, so a plain
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

export async function pickAddon(stepId, addon, log) {
	if (addon.url) return await downloadAddon(stepId, addon, log)
	const name = shortName(addon)
	say(`Choose the ${name} zip…`)
	step(stepId, 'on', `pick ${addon.name}`)
	log(`addon: asking for ${addon.name} (source ${addon.source}, expected sha256 ${addon.sha256 ?? 'not published'})`)
	const file = await chooseFile({
		title: `Choose the ${name} zip`,
		body: 'Not downloaded here — get the zip once and drop it in.',
		href: addon.source,
		hrefLabel: addon.label ?? 'add-on release',
		expected: addon.name,
	})
	if (!file) throw new Error('no add-on zip selected')
	step(stepId, 'on', `hashing ${size(file.size)}…`)
	const digest = await sha256(file)
	const matches = !addon.sha256 || digest === addon.sha256
	log(`addon: picked ${file.name} (${size(file.size)}, sha256 ${digest}${matches ? ', matches flasher.json' : ', DIFFERS from flasher.json'})`)
	step(stepId, 'done', `${file.name}${matches ? ', sha256 ok' : ' — unverified'}`)
	progress(stepId, 1)
	return file
}
