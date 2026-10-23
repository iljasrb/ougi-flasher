// Page chrome: one header, one nav, one footer for all four pages, so the tabs cannot drift apart.
// Classic (non-module) script on purpose — it runs while the parser is still going, so the header is
// already there when the browser paints and nothing jumps.
;(() => {
	const NAV = [
		['./', 'Flash'],
		['console.html', 'Console'],
		['tools.html', 'Tools'],
	]
	const footerText =
		'fastboot over WebUSB by <a href="https://github.com/lineageos-infra/fastboot.js">lineageos-infra/fastboot.js</a>, ' +
		'adb by <a href="https://github.com/yume-chan/ya-webadb">ya-webadb</a> (MIT) · ' +
		'<a href="https://github.com/iljasrb/ougi-flasher">source on GitHub</a> (MIT)' +
		'<br><span id="version">dev</span>'

	const { page = './', title = '', lede = '' } = document.body.dataset
	const wrapper = document.querySelector('.wrapper')

	const nav = document.createElement('nav')
	for (const [href, label] of NAV) {
		const link = document.createElement('a')
		link.href = href
		link.textContent = label
		if (href === page) link.className = 'on'
		nav.append(link)
	}

	const grow = document.createElement('div')
	grow.className = 'grow'
	const eyebrow = document.createElement('p')
	eyebrow.className = 'eyebrow'
	eyebrow.textContent = document.body.dataset.brand ?? 'ougi-flasher'
	const heading = document.createElement('h1')
	const headingLink = document.createElement('a')
	headingLink.href = page
	headingLink.textContent = title
	heading.append(headingLink)
	grow.append(eyebrow, heading)
	if (lede) {
		const sub = document.createElement('p')
		sub.className = 'lede'
		sub.textContent = lede
		grow.append(sub)
	}

	const bar = document.createElement('div')
	bar.className = 'bar'
	bar.append(grow, nav)

	const header = document.createElement('header')
	header.append(bar)

	const footer = document.createElement('footer')
	footer.innerHTML = footerText

	wrapper.prepend(header)

	// optional caution banner under the header (pages that write to the phone set data-warn)
	const warn = document.body.dataset.warn
	if (warn) {
		const banner = document.createElement('p')
		banner.className = 'callout warn'
		banner.innerHTML =
			'<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12,2L1,21H23M12,6L19.5,19H4.5M11,10V14H13V10M11,16V18H13V16"/></svg>'
		const text = document.createElement('span')
		text.textContent = warn
		banner.append(text)
		header.after(banner)
	}

	wrapper.append(footer)

	// deploy.sh drops version.txt next to the pages with the short commit it deployed; a plain
	// clone has no such file and says dev
	fetch('version.txt', { cache: 'no-store' })
		.then((res) => (res.ok ? res.text() : 'dev'))
		.then((version) => {
			footer.querySelector('#version').textContent = version.trim() || 'dev'
		})
		.catch(() => {})
})()
