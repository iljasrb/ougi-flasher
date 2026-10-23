// Add-on zips are not mirrored and a static page cannot read a GitHub release (no CORS), so the user
// downloads each one once and hands it over here; it is hashed and checked against flasher.json.
import { sha256 } from '../zip.mjs'
import { chooseFile } from './dialog.mjs'
import { progress, step } from './steps.mjs'
import { size, statusBox } from './ui.mjs'

const say = statusBox('status')

export const shortName = (addon, index = 0) => addon.title ?? addon.label ?? `add-on ${index + 1}`

export async function pickAddon(stepId, addon, log) {
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
