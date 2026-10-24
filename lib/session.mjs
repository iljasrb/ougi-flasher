// Shared recovery/adb plumbing for the Flash and Tools pages: the "Allow recovery adb" grant
// button, the polled sideload wait and the reconnect-during-sideload path. The page owns the state.
import { adbManager } from './adb.mjs'
import { waitForSideload as poll } from './recovery.mjs'
import { $ } from './ui.mjs'

export function recoverySession({ log, hint, adopt }) {
	let pending = null

	const wait = async (seconds, onWait = () => {}) => {
		const connected = await poll(seconds, {
			onTick: onWait,
			onLog: log,
			extra: () => {
				const device = pending
				pending = null
				return device
			},
			// shown while waiting: the phone may be waiting for an "Allow USB debugging" tap, and
			// the button is the manual retry that opens the picker again
			onGrant: () => {
				$('grant').hidden = false
			},
		})
		$('grant').hidden = true
		return adopt(connected)
	}

	$('grant').addEventListener('click', async () => {
		try {
			const device = await adbManager().requestDevice()
			if (!device) return
			pending = device
			$('grant').hidden = true
			hint('Access granted — continuing…')
		} catch (err) {
			log(`grant: ${err.message}`)
		}
	})

	return {
		wait,
		reconnect: (onWait) => wait(300, onWait),
	}
}
