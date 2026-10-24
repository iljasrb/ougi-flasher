// adb client wrapper: connect, read props, reboot, sideload.
// Backend is @yume-chan/adb (the one the LineageOS flash tool uses), vendored in vendor/adb.min.mjs.
import { Adb, AdbDaemonTransport, AdbDaemonWebUsbDeviceManager, AdbWebCredentialStore } from '../vendor/adb.min.mjs'
import { lockState } from './usb.mjs'

// The adb key label the phone shows on the "Allow USB debugging?" prompt; the key is kept in
// IndexedDB, so the prompt appears once per browser.
const credentials = new AdbWebCredentialStore('ougi-flasher')
const SIDELOAD_CHUNK = 65536

export function adbManager() {
	return AdbDaemonWebUsbDeviceManager.BROWSER
}

// Devices this origin already authorised (no picker, no gesture).
export async function grantedAdbDevices() {
	return (await adbManager()?.getDevices()) ?? []
}

// The manager's wrapper for a raw USBDevice the user just picked (requestDevice grants it first).
export async function adbDeviceFor(usb) {
	const found = (await grantedAdbDevices()).find((device) => device.raw === usb)
	if (!found) throw new Error('not an adb device')
	return found
}

// device === null asks the user to pick one.
// WebUSB allows one open per device, so two callers opening the same phone at once makes the
// loser's transferIn throw "The transfer was cancelled" (seen when auto-connect and the Connect
// button, or the sideload poller and the USB watcher, fire together). Serialise the attempts.
let connectQueue = Promise.resolve()
const serialised = (task) => {
	const run = connectQueue.then(task, task)
	connectQueue = run.catch(() => {})
	return run
}

export async function connectAdb(device = null, onAuthorising = () => {}) {
	return serialised(() => openAdb(device, onAuthorising))
}

async function openAdb(device = null, onAuthorising = () => {}) {
	const manager = adbManager()
	if (!manager) throw new Error('WebUSB unavailable in this browser')
	device ??= await manager.requestDevice()
	if (!device) throw new Error('No device selected.')
	onAuthorising(device)
	const connection = await device.connect()
	const transport = await AdbDaemonTransport.authenticate({
		serial: device.serial,
		connection,
		credentialStore: credentials,
	})
	return { adb: new Adb(transport), name: device.name, serial: device.serial, state: transport.banner.state }
}

const PROPS = [
	'ro.product.device',
	'ro.build.display.id',
	'ro.build.version.release',
	'ro.boot.slot_suffix',
	'ro.boot.verifiedbootstate',
]

// One round trip per command; this is a console, not a syscall layer.
export async function shellText(adb, command) {
	const socket = await adb.createSocket(`shell:${command}`)
	const reader = socket.readable.getReader()
	const decoder = new TextDecoder()
	let out = ''
	try {
		for (;;) {
			const { done, value } = await reader.read()
			if (done) break
			out += decoder.decode(value, { stream: true })
		}
	} finally {
		reader.releaseLock()
		await socket.close().catch(() => {})
	}
	return out
}

export async function adbInfo(adb) {
	const props = {}
	for (const key of PROPS) {
		try {
			props[key] = await adb.getProp(key)
		} catch {
			props[key] = null
		}
	}
	const slot = props['ro.boot.slot_suffix']?.replace('_', '') ?? null
	const info = {
		device: props['ro.product.device'] ?? null,
		build: props['ro.build.display.id'] ?? null,
		android: props['ro.build.version.release'] ?? null,
		slot,
		unlocked: lockState(props['ro.boot.verifiedbootstate']),
	}
	return {
		info,
		rows: [
			['Device', info.device ?? '—'],
			['Build', info.build ?? '—'],
			['Android', info.android ?? '—'],
			['Slot', info.slot ?? '—'],
			['Unlocked', info.unlocked],
		],
	}
}

// Are the add-on's packages installed? Called with an `addon.detect` id list from flasher.json; only
// answerable with adb, because recovery/sideload serves the sideload socket and nothing else.
export async function detectPackages(adb, ids = []) {
	try {
		const out = await shellText(adb, 'pm list packages')
		const found = ids.filter((id) => new RegExp(`^package:${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm').test(out))
		return { state: found.length ? 'present' : 'absent', detail: found.join(', ') || 'none installed' }
	} catch (err) {
		return { state: 'unknown', detail: err.message }
	}
}

export async function rebootAdb(adb, target) {
	// The adb daemon's own service, so no shell or root is involved.
	await adb.createSocketAndWait(`reboot:${target}`).catch(() => {})
}

// adb sideload, same protocol the LineageOS web flasher uses: the device asks for blocks by index.
// Recovery sends DONEDONE when it has everything, but it may also go silent and start verifying —
// so a silent socket after the last block counts as done, and the caller is told whether the device
// confirmed it.
const readWithIdle = (reader, idleMs) => {
	let timer = null
	const idle = new Promise((resolve) => {
		timer = setTimeout(() => resolve({ idle: true }), idleMs)
	})
	return Promise.race([reader.read().finally(() => clearTimeout(timer)), idle])
}

export async function sideload(adb, blob, onProgress = () => {}, { onWait = () => {}, idleMs = 15000 } = {}) {
	const socket = await adb.createSocket(`sideload-host:${blob.size}:${SIDELOAD_CHUNK}`)
	const reader = socket.readable.getReader()
	const writer = socket.writable.getWriter()
	const decode = new TextDecoder('ascii')
	let sent = 0
	let confirmed = false
	try {
		for (;;) {
			const next = await readWithIdle(reader, sent >= blob.size ? idleMs : 60000)
			if (next.idle) {
				if (sent >= blob.size) break // device is verifying/installing now
				throw new Error(`device stopped asking for blocks at ${sent} of ${blob.size} bytes`)
			}
			const { done, value } = next
			if (done) {
				// a socket that closes before the device asked for every block is a dead transport
				// (recovery rebooted under us), not a finished transfer
				if (sent < blob.size) {
					throw new Error(`the device closed the sideload socket after ${sent} of ${blob.size} bytes`)
				}
				break
			}
			const text = decode.decode(value).trim()
			if (text === 'DONEDONE') {
				confirmed = true
				break
			}
			if (text === 'FAILFAIL') throw new Error('recovery rejected the package')
			const block = Number.parseInt(text, 10)
			if (!Number.isFinite(block)) throw new Error(`unexpected sideload reply: ${JSON.stringify(text.slice(0, 40))}`)
			const offset = block * SIDELOAD_CHUNK
			if (offset >= blob.size) throw new Error(`device asked for block ${block} past the end of the package`)
			const chunk = blob.slice(offset, Math.min(offset + SIDELOAD_CHUNK, blob.size))
			await writer.write(new Uint8Array(await chunk.arrayBuffer()))
			sent += chunk.size
			onProgress(sent / blob.size)
			if (sent >= blob.size) onWait()
		}
	} finally {
		try {
			reader.releaseLock()
			writer.releaseLock()
		} catch {}
		await socket.close().catch(() => {})
	}
	return { confirmed, sent }
}
