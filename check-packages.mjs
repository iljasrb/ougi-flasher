// Package checks: download/hash, image flashing, add-on picking and the sideload retry.
// No phone and no browser; the DOM helpers get a tiny shim.
//
//   node check-packages.mjs
import { sha256 } from './zip.mjs'
import { check, done, eq } from './check.mjs'

// The package code reports through lib/steps.mjs and lib/ui.mjs, which only need these methods.
const element = () => ({
	textContent: '',
	className: '',
	style: {},
	dataset: {},
	append() {},
	appendChild() {},
	replaceChildren() {},
	querySelector() {
		return null
	},
	querySelectorAll() {
		return []
	},
})
const dummy = element()
globalThis.document = {
	getElementById: () => dummy,
	querySelector: () => null,
	querySelectorAll: () => [],
	createElement: () => element(),
}
// packageUrl() needs an origin; in the browser it is always there.
globalThis.location = { origin: 'https://example.test', href: 'https://example.test/' }

const { fetchPackage, flashImages } = await import('./lib/flash.mjs')
const { pickAddon, shortName } = await import('./lib/addons.mjs')
const { sideloadWithWait } = await import('./lib/recovery.mjs')
const { flashRecoveryImage } = await import('./lib/recovery-image.mjs')

const bytes = new TextEncoder().encode('package bytes')
const digest = await sha256(new Blob([bytes]))
const respond = (body, headers = {}) => {
	globalThis.fetch = async () => new Response(body, { headers: { 'content-length': String(body.byteLength), ...headers } })
}

// ---- download + hash ------------------------------------------------------------------
respond(bytes)
const downloaded = await fetchPackage({ url: 'https://example.test/pkg', sha256: digest })
check('fetchPackage returns the bytes when the hash matches', downloaded.size === bytes.byteLength)

respond(bytes)
const wrongHash = await fetchPackage({ url: 'https://example.test/pkg', sha256: '0'.repeat(64) }).catch((err) => err.message)
check('fetchPackage rejects a wrong hash', /checksum mismatch/.test(wrongHash), wrongHash)

respond(bytes)
const noHash = await fetchPackage({ url: 'https://example.test/pkg' }).catch((err) => err.message)
check('fetchPackage refuses a package with no sha256', /no sha256/.test(noHash), noHash)

globalThis.fetch = async () => new Response(bytes, { headers: { 'content-length': String(bytes.byteLength + 10) } })
const truncated = await fetchPackage({ url: 'https://example.test/pkg', sha256: digest }).catch((err) => err.message)
check('download rejects a truncated body', /truncated download/.test(truncated), truncated)

globalThis.fetch = async () => new Response('nope', { status: 500 })
const httpError = await fetchPackage({ url: 'https://example.test/pkg', sha256: digest }).catch((err) => err.message)
check('download reports an HTTP error', /HTTP 500/.test(httpError), httpError)

// ---- image flashing -------------------------------------------------------------------
const calls = []
const dev = {
	flashBlob: async (partition, slot, data, onProgress) => {
		calls.push({ partition, slot, size: data.size })
		onProgress?.(1)
	},
}
const images = [
	{ partition: 'boot', data: new Blob([new Uint8Array(1)]) },
	{ partition: 'recovery', data: new Blob([new Uint8Array(1)]) },
]
const progress = []
await flashImages(dev, images, {
	slot: 'other',
	slotless: ['recovery'],
	onProgress: (partition, done, p) => progress.push([partition, done, p]),
})
eq('flashes the first image to the inactive slot', calls[0].slot, 'other')
eq('flashes a slotless image to the current slot', calls[1].slot, 'current')
check('reports the final progress', progress.at(-1)[1] === 1, JSON.stringify(progress.at(-1)))

calls.length = 0
await flashImages(dev, images, { slot: 'other' })
eq('flashes everything to the inactive slot by default', calls.map((call) => call.slot).join(','), 'other,other')

// ---- image recovery slots -------------------------------------------------------------
const recoveryCalls = []
const recoveryDev = (hasSlot) => ({
	getVariable: async (name) => (name === 'has-slot:recovery' ? hasSlot : null),
	flashBlob: async (partition, slot, data, onProgress) => {
		recoveryCalls.push({ partition, slot })
		onProgress?.(1)
	},
})
const recoveryBlob = new Blob([new Uint8Array(1)])
recoveryCalls.length = 0
const slotted = await flashRecoveryImage(recoveryDev('has-slot:recovery: yes\nDone'), recoveryBlob)
check('flashes a slotted recovery to both slots', slotted.join(',') === 'a,b' && recoveryCalls.map((call) => call.slot).join(',') === 'a,b')
recoveryCalls.length = 0
const plain = await flashRecoveryImage(recoveryDev('has-slot:recovery: no\nDone'), recoveryBlob)
check('flashes a plain recovery once', plain.join(',') === 'current' && recoveryCalls.length === 1 && recoveryCalls[0].slot === 'current')
recoveryCalls.length = 0
const unknown = await flashRecoveryImage(recoveryDev(null), recoveryBlob)
check('treats an unknown slot answer as one plain recovery', unknown.join(',') === 'current' && recoveryCalls.length === 1)

// ---- picking a package ----------------------------------------------------------------
respond(bytes)
const mirrored = { title: 'Mirrored', url: 'https://example.test/a.zip', size: bytes.byteLength, sha256: digest, name: 'a.zip' }
const mirroredBlob = await pickAddon('pick', mirrored, () => {})
check('pickAddon downloads and hashes a mirrored package', mirroredBlob.size === bytes.byteLength)

respond(bytes)
const mirroredBad = await pickAddon('pick', { ...mirrored, sha256: '0'.repeat(64) }, () => {}).catch((err) => err.message)
check('pickAddon rejects a mirrored package with a wrong hash', /checksum mismatch/.test(mirroredBad), mirroredBad)

const noImageHash = await pickAddon('pick', { kind: 'image', source: 'https://example.test', name: 'a.img' }, () => {}, { strict: true }).catch((err) => err.message)
check('pickAddon refuses a recovery image with no hash', /no sha256/.test(noImageHash), noImageHash)

const fileBytes = new TextEncoder().encode('picked bytes')
const fileDigest = await sha256(new Blob([fileBytes]))
const imageFile = new File([fileBytes], 'a.img')
const imageAddon = { kind: 'image', source: 'https://example.test', name: 'a.img', sha256: fileDigest }
const pickedImage = await pickAddon('pick', imageAddon, () => {}, { strict: true, choose: async () => imageFile })
check('pickAddon accepts a recovery image with the published hash', pickedImage === imageFile)

const wrongImage = await pickAddon('pick', { ...imageAddon, sha256: '0'.repeat(64) }, () => {}, { strict: true, choose: async () => imageFile }).catch(
	(err) => err.message,
)
check('pickAddon rejects a recovery image with a wrong hash', /checksum mismatch/.test(wrongImage), wrongImage)

const zipFile = new File([fileBytes], 'a.zip')
const zipAddon = { kind: 'zip', source: 'https://example.test', name: 'a.zip', sha256: '0'.repeat(64) }
const pickedZip = await pickAddon('pick', zipAddon, () => {}, { choose: async () => zipFile })
check('pickAddon allows an unverified zip add-on', pickedZip === zipFile)

eq('shortName prefers the title', shortName({ title: 'A', name: 'a.zip' }), 'A')
eq('shortName falls back to the file name', shortName({ name: 'a.zip' }), 'a.zip')
eq('shortName falls back to a numbered add-on', shortName({}, 2), 'add-on 3')

// ---- sideload retry -------------------------------------------------------------------
const blob = new Blob([new Uint8Array(1)])
let attempts = 0
const flaky = async () => {
	attempts += 1
	if (attempts === 1) throw new Error('The device was disconnected')
	return { sent: 10, confirmed: true }
}
const retried = await sideloadWithWait({}, blob, { transfer: flaky, reconnect: async () => ({}), onLog: () => {} })
check('sideloadWithWait retries a recoverable error', attempts === 2 && retried.sent === 10, `${attempts} attempts`)

let rejectedAttempts = 0
const rejected = async () => {
	rejectedAttempts += 1
	throw new Error('recovery rejected the package')
}
const rejectedMessage = await sideloadWithWait({}, blob, { transfer: rejected, reconnect: async () => ({}), onLog: () => {} }).catch((err) => err.message)
check('sideloadWithWait does not retry a rejected package', rejectedAttempts === 1 && /rejected/.test(rejectedMessage), `${rejectedAttempts} attempts`)

let exhaustedAttempts = 0
const exhausted = async () => {
	exhaustedAttempts += 1
	throw new Error('The device was disconnected')
}
const exhaustedMessage = await sideloadWithWait({}, blob, { transfer: exhausted, reconnect: async () => ({}), onLog: () => {}, attempts: 2 }).catch(
	(err) => err.message,
)
check('sideloadWithWait stops after its attempt limit', exhaustedAttempts === 2 && /disconnected/.test(exhaustedMessage), `${exhaustedAttempts} attempts`)

let reconnects = 0
let reconnectAttempts = 0
const reconnectTransfer = async () => {
	reconnectAttempts += 1
	if (reconnectAttempts === 1) throw new Error('The device was disconnected')
	return { sent: 1, confirmed: false }
}
await sideloadWithWait({}, blob, {
	transfer: reconnectTransfer,
	reconnect: async () => {
		reconnects += 1
		return {}
	},
	onLog: () => {},
})
eq('sideloadWithWait reconnects before retrying', reconnects, 1)

done()
