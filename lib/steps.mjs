// Numbered steps and one progress slice per step. Both the flash card and the tools page use the
// same markup contract: <ol id="steps"> with <li data-step>, and <div id="track"> with spans
// carrying data-track.

const $ = (id) => document.getElementById(id)

export function startRun(plan) {
	const list = $('steps')
	const track = $('track')
	list.textContent = ''
	track.textContent = ''
	const half = Math.ceil(plan.length / 2)
	for (const [index, [id, label]] of plan.entries()) {
		const item = document.createElement('li')
		item.dataset.step = id
		item.dataset.state = 'waiting'
		// column-major reading order with rows that line up across both columns
		item.style.setProperty('--col', index < half ? '1' : '2')
		item.style.setProperty('--row', String(index < half ? index + 1 : index - half + 1))
		const badge = document.createElement('b')
		badge.textContent = String(index + 1)
		const body = document.createElement('div')
		const name = document.createElement('strong')
		name.textContent = label
		const detail = document.createElement('span')
		detail.className = 'detail'
		detail.textContent = 'waiting'
		body.append(name, detail)
		item.append(badge, body)
		list.append(item)

		const slice = document.createElement('span')
		slice.dataset.track = id
		slice.append(document.createElement('i'))
		track.append(slice)
	}
	const hint = $('hint')
	if (hint) {
		hint.hidden = true
		hint.textContent = ''
	}
}

export function step(name, mode, detail = '') {
	// only one step is ever running: a second 'on' would leave two slices widened
	if (mode === 'on') {
		for (const other of document.querySelectorAll('#steps [data-state="on"]')) {
			if (other.dataset.step !== name) other.dataset.state = 'waiting'
		}
		for (const other of document.querySelectorAll('.track [data-state="on"]')) {
			if (other.dataset.track !== name) other.removeAttribute('data-state')
		}
	}
	const item = document.querySelector(`#steps [data-step="${name}"]`)
	const slice = document.querySelector(`.track [data-track="${name}"]`)
	if (slice) {
		// reset the fill only when the step actually starts, not on every progress tick that also
		// passes mode 'on' — that made the slice jump back to zero again and again
		const starting = mode === 'on' && slice.dataset.state !== 'on'
		slice.dataset.state = mode
		if (mode === 'done') slice.querySelector('i').style.width = '100%'
		if (starting) slice.querySelector('i').style.width = '0%'
	}
	if (!item) return
	item.dataset.state = mode
	if (detail) item.querySelector('.detail').textContent = detail
}

// Marks the running step as failed and returns the message to show. Only a running step can be
// failed, so the state does not need to be tracked by hand.
export function failStep(err) {
	const running = document.querySelector('#steps li[data-state="on"]')
	if (running) step(running.dataset.step, 'err', err.message)
	return err.bootloaderMessage ?? err.message
}

// Each slice fills on its own (0..1).
export function progress(name, value) {
	const fill = document.querySelector(`.track [data-track="${name}"] i`)
	if (fill) fill.style.width = `${Math.max(0, Math.min(1, value)) * 100}%`
}
