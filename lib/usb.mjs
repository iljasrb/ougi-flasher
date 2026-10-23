import { FastbootDevice } from '../vendor/fastboot.min.mjs'
import { describeUnlock, parseLockWord, reconcile } from './unlock.mjs'

export const FASTBOOT_IFACE = 'ff/42/03'
export const ADB_IFACE = 'ff/42/01'

const hex = (n) => n.toString(16).padStart(2, '0')

// One picker for both modes: filter by vendor, then read the selected device's interfaces.
export async function pickDevice() {
	const usb = await navigator.usb.requestDevice({
		filters: [
			{ vendorId: 0x22b8 }, // Motorola
			{ vendorId: 0x18d1 }, // Google / Android
			{ classCode: 0xff, subclassCode: 0x42, protocolCode: 3 },
		],
	})
	return await describe(usb)
}

export function modeOf(interfaces) {
	if (interfaces.includes(FASTBOOT_IFACE)) return 'fastboot'
	if (interfaces.includes(ADB_IFACE)) return 'adb'
	return 'unknown'
}

async function describe(usb) {
	await usb.open()
	const interfaces = usb.configuration.interfaces.flatMap((iface) =>
		iface.alternates.map((alt) => `${hex(alt.interfaceClass)}/${hex(alt.interfaceSubclass)}/${hex(alt.interfaceProtocol)}`),
	)
	await usb.close()
	return { usb, interfaces, mode: modeOf(interfaces) }
}

// Devices the user already granted this origin (no picker, no gesture). Needed for auto-connect
// after a reload; the picker still runs for a device that was never authorised.
export async function grantedDevices() {
	const found = []
	for (const usb of await navigator.usb.getDevices()) {
		try {
			found.push(await describe(usb))
		} catch {
			/* busy or unplugged */
		}
	}
	return found
}

// WebUSB fires these for devices this origin was granted, so a replug, a reboot into the
// bootloader or into recovery all show up without a new picker run.
export function watchUsb(handler) {
	navigator.usb.addEventListener('connect', (event) => handler('connect', event.device))
	navigator.usb.addEventListener('disconnect', (event) => handler('disconnect', event.device))
}

// Attach an already-picked USBDevice to the fastboot client. connect() is the only public entry
// point and calls requestDevice() itself, so answer that call with the device we already have:
// one dialog, and the client's own reconnect listeners are still registered.
export async function attachFastboot(usb) {
	const dev = new FastbootDevice()
	const requestDevice = navigator.usb.requestDevice
	navigator.usb.requestDevice = async () => usb
	try {
		await dev.connect()
	} finally {
		navigator.usb.requestDevice = requestDevice
	}
	return dev
}

// A multi-part `getvar` answers with `name[0]: value` / `name[1]: value` lines and a trailing
// "Done", which the client hands back as one string. Keep the values in order, one per line.
export function sanitizeVar(name, text) {
	if (!text) return null
	const pattern = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\[(\\d+)\\])?:\\s*(.*)$`, 'i')
	const parts = []
	for (const raw of text.split('\n')) {
		const line = raw.trim()
		if (!line || /^done\.?$/i.test(line)) continue
		const match = line.match(pattern)
		if (match) parts.push({ index: match[1] === undefined ? parts.length : Number(match[1]), value: match[2].trim() })
		else if (!parts.length) parts.push({ index: 0, value: line }) // bootloader returns the bare value
	}
	parts.sort((a, b) => a.index - b.index)
	const values = parts.map((p) => p.value).filter(Boolean)
	return values.length ? values.join('\n') : null
}

const GETVARS = ['product', 'serialno', 'current-slot', 'version-bootloader', 'version-baseband', 'unlocked', 'securestate']

// Sequential on purpose: fastboot is one command/response stream, parallel getvars interleave.
export async function readFastbootInfo(dev) {
	const vars = {}
	for (const key of GETVARS) {
		try {
			vars[key] = sanitizeVar(key, await dev.getVariable(key))
		} catch {
			vars[key] = null
		}
	}
	// Motorola/Qualcomm bootloaders (this device) expose the real state as `securestate`
	// (flashing_unlocked / oem_locked) and have no `unlocked` var at all. `getvar secure` is NOT a
	// lock flag here — it answers yes on an unlocked phone, so it is not read.
	const observations = [
		{ name: 'getvar securestate', layer: 'bootloader', value: parseLockWord(vars.securestate) },
		{ name: 'getvar unlocked', layer: 'bootloader', value: parseLockWord(vars.unlocked) },
	]
	if (observations.every((o) => !o.value)) {
		try {
			const all = (await dev.runCommand('getvar:all')).text
			for (const line of all.split('\n')) {
				const [key, value] = line.trim().replace(/^\(bootloader\)\s*/, '').split(':')
				if (!value) continue
				if (/^securestate$/i.test(key)) observations.push({ name: 'getvar all securestate', layer: 'bootloader', value: parseLockWord(value) })
				if (/^unlocked$/i.test(key)) observations.push({ name: 'getvar all unlocked', layer: 'bootloader', value: parseLockWord(value) })
			}
		} catch {
			/* older bootloader */
		}
	}
	const unlock = reconcile(observations)
	const dash = (value) => (value && value.trim() ? value : '—')
	const info = {
		product: vars.product ?? null,
		serial: vars.serialno ?? null,
		slot: vars['current-slot'] ?? null,
		unlocked: describeUnlock(unlock),
	}
	return {
		unlock,
		info,
		rows: [
			['Product', dash(vars.product)],
			['Serial', dash(vars.serialno)],
			['Slot', dash(vars['current-slot'])],
			['Bootloader', dash(vars['version-bootloader'])],
			['Baseband', dash(vars['version-baseband'])],
			['Secure state', dash(vars.securestate)],
			['Unlocked', describeUnlock(unlock)],
		],
	}
}
