import { kvTable } from './ui.mjs'

// What every dialog needs: appended, modal, scrolled to the top, closed and removed exactly once.
// A long table would otherwise open at the focused button, at the bottom.
function openModal(dialog, resolve, onCancel) {
	const done = (value) => {
		dialog.close()
		dialog.remove()
		resolve(value)
	}
	dialog.addEventListener('cancel', (event) => {
		event.preventDefault()
		done(onCancel)
	})
	document.body.append(dialog)
	dialog.showModal()
	dialog.scrollTop = 0
	return done
}

// Minimal modal chooser: returns the chosen value, or null when dismissed. `table` is an optional
// [label, value] list, rendered as the same key/value table the cards use.
export function choose({ title, body, steps = null, link = null, table = null, options, cancel = null }) {
	return new Promise((resolve) => {
		const dialog = document.createElement('dialog')
		dialog.className = 'chooser'

		const heading = document.createElement('h2')
		heading.textContent = title
		const text = document.createElement('p')
		text.textContent = body
		const list = document.createElement('div')
		list.className = 'choices'
		const dismiss = document.createElement('div')
		dismiss.className = 'dialog-dismiss'

		const chooseButton = (value, label, kind = '') => {
			const button = document.createElement('button')
			button.className = `btn ${kind}`.trim()
			button.textContent = label
			button.addEventListener('click', () => done(value))
			return button
		}
		if (cancel) dismiss.append(chooseButton(cancel.value, cancel.label, 'quiet'))
		for (const option of options) {
			list.append(chooseButton(option.value, option.label, option.kind ?? ''))
		}

		dialog.append(heading)
		if (body) dialog.append(text)
		if (link) {
			const anchor = document.createElement('a')
			anchor.className = 'link'
			anchor.href = link.href
			anchor.target = '_blank'
			anchor.rel = 'noreferrer'
			anchor.textContent = `${link.label ?? link.href} ↗`
			dialog.append(anchor)
		}
		if (table?.length) dialog.append(kvTable(table.map(([label, value]) => [label, value ?? '—'])))
		if (steps?.length) {
			const sub = document.createElement('h3')
			sub.textContent = 'On the phone'
			const ordered = document.createElement('ol')
			ordered.className = 'dialog-steps'
			for (const [index, text] of steps.entries()) {
				const item = document.createElement('li')
				const badge = document.createElement('b')
				badge.textContent = String(index + 1)
				const label = document.createElement('span')
				label.textContent = text
				item.append(badge, label)
				ordered.append(item)
			}
			dialog.append(sub, ordered)
		}
		dialog.append(list)
		if (cancel) dialog.append(dismiss)
		const done = openModal(dialog, resolve, null) // handlers above close over this
	})
}

// File chooser modal: link to where the file comes from, a drop zone and a picker. Resolves with the
// File, or null when dismissed. Only .zip is accepted — the caller sideloads it as-is.
export function chooseFile({ title, body, href = null, hrefLabel = 'Download', expected = null }) {
	return new Promise((resolve) => {
		const dialog = document.createElement('dialog')
		dialog.className = 'chooser file'
		dialog.innerHTML = `
			<h2></h2>
			<p class="body"></p>
			<p class="expected" hidden><span class="label">File</span><code></code></p>
			<div class="dropzone" tabindex="0" role="button">
				<strong>Drop the zip here</strong>
				<span>or click to select it</span>
			</div>
			<p class="picked" hidden></p>
			<div class="choices"><button class="btn primary" disabled>Use this file</button></div>
			<div class="dialog-dismiss"><button class="btn quiet">Cancel</button></div>`
		dialog.querySelector('h2').textContent = title
		dialog.querySelector('.body').textContent = body

		if (expected) {
			const row = dialog.querySelector('.expected')
			row.hidden = false
			row.querySelector('code').textContent = expected
		}
		if (href) {
			const link = document.createElement('a')
			link.className = 'link'
			link.href = href
			link.target = '_blank'
			link.rel = 'noreferrer'
			link.textContent = `${hrefLabel} ↗`
			dialog.querySelector('.body').after(link)
		}

		const zone = dialog.querySelector('.dropzone')
		const picked = dialog.querySelector('.picked')
		const use = dialog.querySelector('.choices .btn.primary')
		const input = document.createElement('input')
		input.type = 'file'
		input.accept = '.zip,application/zip'
		input.hidden = true
		dialog.append(input)

		let file = null
		const take = (candidate) => {
			if (!candidate) return
			const isZip = /\.zip$/i.test(candidate.name)
			picked.hidden = false
			picked.textContent = isZip
				? `${candidate.name} · ${(candidate.size / 1e6).toFixed(0)} MB`
				: `${candidate.name} is not a .zip`
			picked.classList.toggle('bad', !isZip)
			file = isZip ? candidate : null
			use.disabled = !file
		}

		zone.addEventListener('click', () => input.click())
		zone.addEventListener('keydown', (event) => {
			if (event.key === 'Enter' || event.key === ' ') input.click()
		})
		input.addEventListener('change', () => take(input.files?.[0]))
		for (const type of ['dragenter', 'dragover']) {
			zone.addEventListener(type, (event) => {
				event.preventDefault()
				zone.classList.add('over')
			})
		}
		for (const type of ['dragleave', 'dragend']) zone.addEventListener(type, () => zone.classList.remove('over'))
		zone.addEventListener('drop', (event) => {
			event.preventDefault()
			zone.classList.remove('over')
			take(event.dataTransfer?.files?.[0])
		})
		use.addEventListener('click', () => done(file))
		dialog.querySelector('.dialog-dismiss .btn').addEventListener('click', () => done(null))
		const done = openModal(dialog, resolve, null)
	})
}

// Risk acknowledgement: the page refuses to flash until every box is ticked. Resolves true when the
// user accepts, false when they back out.
export function confirmRisks({ title, body, items, acceptLabel = 'Start anyway', declineLabel = 'Not now' }) {
	return new Promise((resolve) => {
		const dialog = document.createElement('dialog')
		dialog.className = 'chooser risk'
		dialog.innerHTML = `
			<div class="risk-head">
				<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12,2L1,21H23M12,6L19.5,19H4.5M11,10V14H13V10M11,16V18H13V16"/></svg>
				<h2></h2>
			</div>
			<p class="body"></p>
			<ul class="risk-list"></ul>
			<div class="choices"><button class="btn primary" disabled></button></div>
			<div class="dialog-dismiss"><button class="btn quiet"></button></div>`
		dialog.querySelector('h2').textContent = title
		dialog.querySelector('.body').textContent = body
		dialog.querySelector('.choices .btn.primary').textContent = acceptLabel
		dialog.querySelector('.dialog-dismiss .btn').textContent = declineLabel

		const list = dialog.querySelector('.risk-list')
		const boxes = items.map((text) => {
			const item = document.createElement('li')
			const label = document.createElement('label')
			const box = document.createElement('input')
			box.type = 'checkbox'
			const span = document.createElement('span')
			span.textContent = text
			label.append(box, span)
			item.append(label)
			list.append(item)
			return box
		})

		const accept = dialog.querySelector('.choices .btn.primary')
		const sync = () => {
			accept.disabled = !boxes.every((box) => box.checked)
		}
		for (const box of boxes) box.addEventListener('change', sync)

		accept.addEventListener('click', () => done(true))
		dialog.querySelector('.dialog-dismiss .btn').addEventListener('click', () => done(false))
		const done = openModal(dialog, resolve, false)
	})
}
