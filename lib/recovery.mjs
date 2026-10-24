// Polls the granted adb devices until one answers as a recovery sideload host. UI-agnostic: the
// caller decides how to show ticks, the permission prompt and the log.
import { connectAdb, grantedAdbDevices, sideload } from './adb.mjs'

// Every new ADB connection can raise an "Allow USB debugging" dialog on the phone. Re-opening the
// same device every second stacks those dialogs, so a device is asked once; only one that is
// already authorised (any state but unauthorized/authorizing) is retried until it reaches sideload.
export async function waitForSideload(
	seconds = 600,
	{ onTick = () => {}, onGrant = () => {}, onLog = () => {}, extra = () => null, connect = connectAdb, list = grantedAdbDevices, interval = 1000 } = {},
) {
	const asked = new Set()
	const retry = new Set()
	const keyOf = (device) => device.raw ?? device
	for (let i = 0; i < seconds; i++) {
		if (i === 0) onGrant()
		const pending = await extra()
		const devices = await list()
		// the device picked by the grant button also shows up in getDevices(): ask it once
		const queue = pending ? [pending, ...devices.filter((device) => keyOf(device) !== keyOf(pending))] : devices
		for (const device of queue) {
			const key = keyOf(device)
			if (device !== pending && asked.has(key) && !retry.has(key)) continue
			asked.add(key)
			try {
				const connected = await connect(device)
				if (connected.state === 'sideload') return connected
				if (connected.state === 'unauthorized' || connected.state === 'authorizing') {
					retry.delete(key) // lost its key: stop asking until the user allows it again
					onGrant()
				} else {
					retry.add(key)
				}
				onLog(`recovery adb: state ${connected.state}, still waiting for sideload mode`)
				await connected.adb.close?.().catch(() => {})
			} catch (err) {
				retry.delete(key)
				onLog(`recovery adb: ${err.message}`)
				onGrant()
			}
		}
		onTick(i)
		await new Promise((resolve) => setTimeout(resolve, interval))
	}
	throw new Error('recovery sideload never appeared')
}

// Recovery can reboot underneath a transfer (e.g. after answering Yes to “reboot to recovery”),
// which shows up as "The device was disconnected" mid-write. Reconnect and retry rather than
// failing the whole run.
export async function sideloadWithWait(adb, blob, { onProgress, onWait, onLog = () => {}, reconnect, label = 'sideload', attempts = 3 } = {}) {
	for (let attempt = 1; ; attempt++) {
		try {
			return await sideload(adb, blob, onProgress, { onWait })
		} catch (err) {
			const recoverable = /disconnected|cancelled|closed the sideload socket/i.test(err.message)
			if (!recoverable || attempt >= attempts) throw err
			onLog(`${label}: ${err.message} — waiting for recovery and retrying (${attempt}/${attempts})`)
			adb = await reconnect()
		}
	}
}
