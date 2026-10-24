// Small UI helpers shared by the three pages: element lookup, the status line, the hint box, the
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

// Configuration card: the summary that opens the picker window.
export function paintConfigCard(d) {
	$('config-name').textContent = d.name
	$('config-meta').textContent = [
		d.codename,
		d.models?.join('/'),
		d.build,
		d.channel,
		d.ota ? `OTA ${size(d.ota.size)}` : null,
		d.images ? `images ${size(d.images.size)}` : null,
		d.addons.length ? `${d.addons.length} add-on${d.addons.length > 1 ? 's' : ''}` : null,
	]
		.filter(Boolean)
		.join(' · ')
}

// Every parameter of one configuration, for the detail table in the config window.
const fileOf = (entry) => entry.url.split('/').pop()

export function configRows(d) {
	const rows = [
		['Config id', d.id],
		['Codename', d.codename],
		['Name', d.name],
		['Models', d.models?.join(', ') ?? '—'],
		['Build', d.build],
		['Channel', d.channel ?? '—'],
		['OTA file', d.ota ? fileOf(d.ota) : 'not published'],
		['OTA size', d.ota ? size(d.ota.size) : '—'],
		['OTA sha256', d.ota?.sha256 ?? '—'],
		['Images file', d.images ? fileOf(d.images) : 'not published'],
		['Images size', d.images ? size(d.images.size) : '—'],
		['Partitions', d.images?.partitions.join('\n') ?? '—'],
		['Slotless', d.images?.slotless.join(', ') || '—'],
		['Images sha256', d.images?.sha256 ?? '—'],
	]
	for (const addon of d.addons) {
		rows.push(
			['Add-on', addon.title ?? addon.label ?? addon.name],
			['Add-on file', addon.name],
			['Add-on source', addon.source],
			['Add-on size', addon.size ? size(addon.size) : '—'],
			['Add-on sha256', addon.sha256 ?? 'not published'],
			['Add-on detect', addon.detect?.join('\n') ?? '—'],
		)
	}
	return rows
}

// The risk list is page copy, not configuration: every deployment can be handed the same phone.
export const DEFAULT_RISKS = [
	'I understand that this may erase the data on my phone.',
	'I know how to recover the phone by hand if it gets stuck in a bootloop or a corrupted state.',
	'My phone’s bootloader is unlocked.',
]

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
