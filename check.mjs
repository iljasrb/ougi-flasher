// Shared harness for the check-*.mjs scripts: one line per assertion, one exit code.
let ok = true

export function check(name, pass, detail = '') {
	if (!pass) ok = false
	console.log(`${pass ? 'ok  ' : 'FAIL'} — ${name}${detail ? ` (${detail})` : ''}`)
}

export const eq = (name, got, want) => check(name, got === want, got === want ? '' : `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)

export const done = () => process.exit(ok ? 0 : 1)
