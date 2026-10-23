// Polls the granted adb devices until one answers as a recovery sideload host. UI-agnostic: the
// caller decides how to show ticks, the permission prompt and the log.
import { connectAdb, grantedAdbDevices, sideload } from './adb.mjs'

// onGrant fires on the first tick: the caller decides whether the permission button is needed (it
// stays hidden when the browser already has access and simply waits).
export async function waitForSideload(seconds = 600, { onTick = () => {}, onGrant = () => {}, onLog = () => {}, extra = () => null } = {}) {
	for (let i = 0; i < seconds; i++) {
		const pending = await extra()
		const devices = await grantedAdbDevices()
		for (const device of pending ? [pending, ...devices] : devices) {
			try {
				const connected = await connectAdb(device)
				if (connected.state === 'sideload') return connected
				// adbd already answers (recovery menu, or booted Android) but is not in sideload mode:
				// close it so the next tick can open the device again instead of failing "already open"
				onLog(`recovery adb: state ${connected.state}, still waiting for sideload mode`)
				await connected.adb.close?.().catch(() => {})
			} catch (err) {
				onLog(`recovery adb: ${err.message}`)
			}
		}
		if (i === 0) onGrant()
		onTick(i)
		await new Promise((resolve) => setTimeout(resolve, 1000))
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
