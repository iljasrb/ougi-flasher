// Locks the page while a flash/sideload runs: navigation between the three pages is disabled and
// leaving the page asks for confirmation, so a half-written slot cannot be walked away from by a
// stray click.
let reason = ''

const warn = (event) => {
	event.preventDefault()
	event.returnValue = reason
	return reason
}

const blockNavigation = (event) => {
	const link = event.target.closest?.('a[href]')
	if (!link) return
	event.preventDefault()
	event.stopPropagation()
}

export function lockUi(locked, why = 'An operation is running') {
	reason = why
	document.body.classList.toggle('locked', locked)
	for (const link of document.querySelectorAll('header nav a, footer a')) link.setAttribute('aria-disabled', String(locked))
	if (locked) {
		window.addEventListener('beforeunload', warn)
		document.addEventListener('click', blockNavigation, true)
	} else {
		window.removeEventListener('beforeunload', warn)
		document.removeEventListener('click', blockNavigation, true)
	}
}
