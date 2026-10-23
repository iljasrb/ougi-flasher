// Small UI helpers shared by the four pages: element lookup, the status line, the hint box, the
// device key/value table and the process log.
import { startLog } from './log.mjs'

export const $ = (id) => document.getElementById(id)

export const statusBox = (id) => (text, cls = '') => {
	const el = $(id)
	el.textContent = text
	el.className = `status ${cls}`
}

export const hintBox = (id) => (text) => {
	const el = $(id)
	el.hidden = !text
	el.textContent = text ?? ''
}

export const cardTitle = (nameId, metaId) => (name, meta) => {
	$(nameId).textContent = name
	$(metaId).textContent = meta
}

const kvRows = (rows) =>
	rows.map(([label, value]) => {
		const tr = document.createElement('tr')
		const key = document.createElement('td')
		key.textContent = label
		const val = document.createElement('td')
		val.textContent = value
		tr.append(key, val)
		return tr
	})

// rows: [[label, value], ...]
export const renderKv = (tbodyId, rows) => $(tbodyId).replaceChildren(...kvRows(rows))

// The same key/value table as a standalone element, for the dialogs.
export const kvTable = (rows) => {
	const table = document.createElement('table')
	table.className = 'kv'
	const body = document.createElement('tbody')
	body.append(...kvRows(rows))
	table.append(body)
	return table
}

// Bytes as the pages print them: GB above a billion, MB below.
export const size = (bytes) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : `${(bytes / 1e6).toFixed(0)} MB`)

// Page copy that a deployment may want to word itself: title, brand line, the caution banner and the
// risk list all come from flasher.json (`text`). chrome.js paints the fallbacks first, so the banner
// is never missing while the config loads; an empty `warn` removes it.
export const DEFAULT_RISKS = [
	'I understand that this may erase the data on my phone.',
	'I know how to recover the phone by hand if it gets stuck in a bootloop or a corrupted state.',
	'My phone’s bootloader is unlocked.',
]

export function applyText(config, { page = 'Flash' } = {}) {
	const text = config.text ?? {}
	// only the flash page's name is configurable; Console and Tools keep their own
	const title = page === 'Flash' ? (text.title ?? page) : page
	document.title = `${title} · ${config.name} (${config.codename})`
	const heading = document.querySelector('header h1 a')
	if (heading) heading.textContent = title
	const eyebrow = document.querySelector('header .eyebrow')
	if (eyebrow) eyebrow.textContent = text.brand ?? 'ougi-flasher'
	const nav = document.querySelector('header nav a.on')
	if (nav) nav.textContent = title
	// the work card's section label sits above it, matching the sidebar's headings
	const section = document.querySelector('#flash-title')
	if (section) section.textContent = title
	const banner = document.querySelector('header + .callout.warn')
	if (!banner) return
	if (text.warn) banner.querySelector('span').textContent = text.warn
	else banner.remove()
}

// Process log in the page. `download(buttonId)` wires a button that saves it as a text file.
export function pageLog(elementId) {
	const { log, text } = startLog($(elementId))
	const download = (buttonId) => {
		const button = $(buttonId)
		if (!button) return
		button.addEventListener('click', () => {
			const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
			const url = URL.createObjectURL(new Blob([text()], { type: 'text/plain' }))
			const link = document.createElement('a')
			link.href = url
			link.download = `ougi-flasher-${stamp}.log`
			link.click()
			URL.revokeObjectURL(url)
			log('log downloaded')
		})
	}
	return { log, download }
}
