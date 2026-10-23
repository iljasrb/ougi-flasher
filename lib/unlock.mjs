// Unlock-state reconciliation, shared by the fastboot and adb paths.
//
// Rules, in order:
//   1. Bootloader and kernel observations are trusted; if they disagree the answer is "unclear"
//      rather than one of them being picked.
//   2. Props are a userspace surface that Play Integrity / SUSFS-style spoofing rewrites, so they
//      never decide on their own when a trusted layer exists — they only mark the value as spoofed.
//   3. Unrecognised values stay unrecognised. Guessing from a number (e.g. "Moto returns 3") is how
//      you get a confident wrong answer, so nothing numeric is interpreted beyond 0/1 flags.
//
// Every result: { value, spoofed, detail } where value is
// 'unlocked' | 'locked' | 'unclear' | 'unknown' and spoofed means a prop layer contradicted it.

const norm = (value) =>
	String(value ?? '')
		.trim()
		.toLowerCase()
		.replace(/^"(.*)"$/, '$1')

// One word list for every layer: verified-boot states (green/yellow/orange/red), Motorola/Qualcomm
// `securestate` (oem_locked / flashing_unlocked) and plain words (yes/no/unlocked/locked) mean the
// same thing everywhere they appear.
const UNLOCKED = ['yes', 'true', 'unlocked', 'orange', 'red', 'flashing_unlocked']
const LOCKED = ['no', 'false', 'locked', 'green', 'yellow', 'oem_locked', 'flashing_locked']

export function parseLockWord(value) {
	const v = norm(value)
	if (UNLOCKED.includes(v)) return 'unlocked'
	if (LOCKED.includes(v)) return 'locked'
	return null
}

// androidboot.flash.locked / androidboot.secureboot: the inverse — 0/off means unlocked.
export function parseLockedFlag(value) {
	const v = norm(value)
	if (v === '0' || v === 'no' || v === 'false') return 'unlocked'
	if (v === '1' || v === 'yes' || v === 'true') return 'locked'
	return null
}

export function reconcile(observations) {
	const known = observations.filter((o) => o.value)
	const valuesOf = (layer) => [...new Set(known.filter((o) => o.layer === layer).map((o) => o.value))]

	const trusted = [...new Set([...valuesOf('bootloader'), ...valuesOf('kernel')])]
	const props = valuesOf('props')
	const detail = known.map((o) => `${o.name}: ${o.value}`).join(' · ') || 'no boot flags readable'

	if (trusted.length > 1) return { value: 'unclear', spoofed: props.length > 0, detail }
	if (trusted.length === 1) return { value: trusted[0], spoofed: props.some((v) => v !== trusted[0]), detail }
	if (props.length > 1) return { value: 'unclear', spoofed: false, detail }
	if (props.length === 1) return { value: props[0], spoofed: false, detail }
	return { value: 'unknown', spoofed: false, detail }
}

// What the card prints next to "Unlocked".
export function describeUnlock(result) {
	switch (result.value) {
		case 'unlocked':
		case 'locked':
			return result.spoofed ? `${result.value} (props disagree)` : result.value
		case 'unclear':
			return 'unclear'
		default:
			return '—'
	}
}
