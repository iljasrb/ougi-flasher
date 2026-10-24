// Console page: a fastboot terminal and an adb terminal.
import { connectAdb, grantedAdbDevices } from './lib/adb.mjs'
import { setDebugLogger } from './vendor/fastboot.min.mjs'
import { Terminal } from './lib/term.js'
import { lockUi } from './lib/guard.mjs'
import { attachFastboot, grantedDevices, pickDevice, watchUsb } from './lib/usb.mjs'
import { $, statusBox } from './lib/ui.mjs'


const HELP = {
	fastboot: [
		'any raw fastboot command is sent as-is: getvar <name>, flash:<partition>, set_active:<slot>, reboot-<target>',
		'clear   empty the console',
		'There is no image upload here; use the Flash page for that.',
	],
	adb: [
		'every line is run as `adb shell <line>` (pipes and redirects work)',
		'root is KernelSU: su -c "id"',
		'clear   empty the console',
		'long-running commands (logcat, top) stream until you reload the page',
	],
}

// ---- fastboot -------------------------------------------------------------------------

let fastboot = null
let autoPending = false
let autoFailed = false
const fbTerm = new Terminal({
	output: $('fb-out'),
	input: $('fb-in'),
	prompt: 'fastboot>',
	onBusy: (on) => lockUi(on, 'A fastboot command is still running.'),
	onCommand: async (text) => {
		if (!fastboot) return fbTerm.write('not connected\n')
		if (text === 'help') return fbTerm.write(HELP.fastboot.join('\n') + '\n')
		const res = await fastboot.runCommand(text)
		fbTerm.write(`${res.text}\n`)
	},
})
setDebugLogger((...data) => {
	const line = data.filter((d) => typeof d === 'string').join(' ')
	if (line) fbTerm.write(`# ${line}\n`)
})

const fbStatus = statusBox('fb-status')

async function connectFastboot(usb) {
	autoFailed = false
	$('fb-connect').disabled = true
	try {
		if (!usb) {
			const picked = await pickDevice()
			if (picked.mode !== 'fastboot') throw new Error('not in fastboot mode — reboot the phone to the bootloader')
			usb = picked.usb
		}
		fastboot = await attachFastboot(usb)
		$('fb-in').disabled = false
		$('fb-connect').textContent = 'Disconnect'
		fbStatus('Connected. Type help.', 'ok')
		fbTerm.focus()
	} catch (err) {
		fastboot = null
		fbStatus(err.name === 'NotFoundError' ? 'No device selected.' : (err.bootloaderMessage ?? err.message), 'err')
	} finally {
		$('fb-connect').disabled = false
	}
}

$('fb-connect').addEventListener('click', async () => {
	if (!fastboot) return await connectFastboot()
	resetFastboot()
})

// ---- adb ------------------------------------------------------------------------------

let adb = null
const adbTerm = new Terminal({
	output: $('adb-out'),
	input: $('adb-in'),
	prompt: 'adb>',
	onBusy: (on) => lockUi(on, 'An adb command is still running.'),
	onCommand: async (text) => {
		if (!adb) return adbTerm.write('not connected\n')
		if (text === 'help') return adbTerm.write(HELP.adb.join('\n') + '\n')
		const socket = await adb.createSocket(`shell:${text}`)
		const reader = socket.readable.getReader()
		const decoder = new TextDecoder()
		try {
			for (;;) {
				const { done, value } = await reader.read()
				if (done) break
				adbTerm.write(decoder.decode(value, { stream: true }))
			}
		} finally {
			reader.releaseLock()
			await socket.close().catch(() => {})
		}
		adbTerm.write('\n')
	},
})

const adbStatus = statusBox('adb-status')

async function connectAdbDevice(device) {
	autoFailed = false
	$('adb-connect').disabled = true
	try {
		adbStatus('Authorising — confirm the USB debugging prompt on the phone.')
		const connected = await connectAdb(device)
		adb = connected.adb
		$('adb-in').disabled = false
		$('adb-connect').textContent = 'Disconnect'
		adbStatus(`Connected to ${connected.name}. Type help.`, 'ok')
		adbTerm.focus()
	} catch (err) {
		adb = null
		adbStatus(err.name === 'NotFoundError' ? 'No device selected.' : err.message, 'err')
	} finally {
		$('adb-connect').disabled = false
	}
}

$('adb-connect').addEventListener('click', async () => {
	if (!adb) return await connectAdbDevice(null)
	await resetAdb()
})

// ---- live connection state ------------------------------------------------------------

function resetFastboot() {
	fastboot = null
	$('fb-in').disabled = true
	$('fb-connect').textContent = 'Connect'
	fbStatus('Disconnected.')
}

async function resetAdb() {
	await adb?.close().catch(() => {})
	adb = null
	$('adb-in').disabled = true
	$('adb-connect').textContent = 'Connect'
	adbStatus('Disconnected.')
}

// A replug or a reboot changes the device underneath the terminals; say so instead of leaving a
// dead prompt enabled.
function watchConnection() {
	let retry = null
	watchUsb((kind) => {
		if (kind === 'disconnect') {
			autoFailed = false
			if (fastboot) {
				resetFastboot()
				fbStatus('Device disconnected.')
			}
			if (adb) {
				resetAdb()
				adbStatus('Device disconnected.')
			}
			return
		}
		clearTimeout(retry)
		retry = setTimeout(async () => {
			if (!fastboot && !adb) await autoConnectOnce()
		}, 700)
	})
}

// ---- boot -----------------------------------------------------------------------------

// Already-authorised devices connect without a picker: fastboot first, then adb.
async function autoConnect() {
	const fastbootDevice = (await grantedDevices()).find((d) => d.mode === 'fastboot')
	if (fastbootDevice) return await connectFastboot(fastbootDevice.usb)
	for (const device of await grantedAdbDevices()) return await connectAdbDevice(device)
}

// One automatic attempt per device appearance; retrying a phone that is waiting for the "Allow USB
// debugging" tap just asks it again.
async function autoConnectOnce() {
	if (autoPending || autoFailed || fastboot || adb) return
	autoPending = true
	try {
		await autoConnect()
		autoFailed = false
	} catch (err) {
		autoFailed = true
		fbStatus(err.message, 'err')
	} finally {
		autoPending = false
	}
}

$('fb-line').addEventListener('submit', (event) => event.preventDefault())
$('adb-line').addEventListener('submit', (event) => event.preventDefault())

autoConnectOnce()
watchConnection()
