// Process log: timestamped lines in the page, mirrored to the browser console. Nothing is sent to
// a server — the log can be downloaded from the page when something goes wrong.
const SESSION = Math.random().toString(36).slice(2, 8)

const stamp = () => new Date().toISOString().slice(11, 23)

// Progress callbacks fire per usb transfer (~50/s); log once per bucket instead of per call.
export function every(log, label, step = 10) {
	let last = -1
	return (p) => {
		const bucket = Math.floor((Math.min(1, Math.max(0, p)) * 100) / step)
		if (bucket === last) return
		last = bucket
		log(`${label}: ${bucket * step}%`)
	}
}

export function startLog(element) {
	// one element per line: a wrapped line then keeps its continuation under the message instead of
	// starting a new paragraph at the left edge
	const append = (line) => {
		const row = document.createElement('div')
		row.className = / (ERROR|REJECTION) /.test(line) ? 'log-line err' : 'log-line'
		row.textContent = line
		element.append(row)
		element.scrollTop = element.scrollHeight
		console.log(line)
	}

	const log = (...parts) => {
		const text = parts.map((part) => (typeof part === 'string' ? part : JSON.stringify(part))).join(' ')
		if (text.trim()) append(`${stamp()} [${SESSION}] ${text}`)
	}

	window.addEventListener('error', (event) => log('ERROR', `${event.message} @ ${event.filename}:${event.lineno}`))
	window.addEventListener('unhandledrejection', (event) => log('REJECTION', String(event.reason?.message ?? event.reason)))
	log('page', location.href)
	log('agent', navigator.userAgent)

	return { log, text: () => [...element.children].map((row) => row.textContent).join('\n') }
}
