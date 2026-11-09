// Tools page: re-install one package by hand — a zip add-on or zip recovery over adb sideload, or
// an image recovery over fastboot — after the ROM is already on the phone.
import { connectAdb, grantedAdbDevices, rebootAdb } from './lib/adb.mjs'
import { chooseConfig } from './lib/dialog.mjs'
import { loadConfigs } from './lib/config.mjs'
import { lockUi } from './lib/guard.mjs'
import { every } from './lib/log.mjs'
import { recoverySession } from './lib/session.mjs'
import { sideloadWithWait } from './lib/recovery.mjs'
import { flashRecoveryImage } from './lib/recovery-image.mjs'
import { failStep, progress, startRun, step } from './lib/steps.mjs'
import { $, cardTitle, hintBox, pageLog, paintConfigCard, renderKv, size, statusBox } from './lib/ui.mjs'
import { pickAddon, shortName } from './lib/addons.mjs'
import { attachFastboot, grantedDevices, pickDevice, readFastbootInfo } from './lib/usb.mjs'

const { log, download: downloadLog } = pageLog('log')
const say = statusBox('status')
const hint = hintBox('hint')
const setCard = cardTitle('device-name', 'device-meta')

let configs = []
let config = null
let current = 0 // index into packages() (a <select> appears when there is more than one)
let phone = null // the connected adb device ({ adb, name, serial, state })
let fastboot = null // the connected bootloader (FastbootDevice)
let fastbootInfo = null // product/serial/slot/unlocked from readFastbootInfo()
let busy = false

// Every configured package, including image recoveries: the Tools page can flash both.
const packages = () => [...(config?.addons ?? []), ...(config?.recoveries ?? [])]
const addon = () => packages()[current] ?? null
const isImage = (pkg) => pkg?.kind === 'image'

const planFor = (pkg) => {
	if (isImage(pkg)) {
		return [
			['download', pkg.url ? `Download ${shortName(pkg)}` : `Choose the ${shortName(pkg)} image`],
			['wait', 'Connect the bootloader'],
			['flash', 'Flash recovery_a and recovery_b'],
			['done', 'Reboot system'],
		]
	}
	return [
		['download', pkg?.url ? `Download ${shortName(pkg)}` : 'Choose the package'],
		['wait', 'Get the phone into recovery sideload'],
		['flash', 'Sideload the package'],
		['done', 'Reboot system'],
	]
}

function statusHint() {
	if (busy || phone || fastboot) return
	const pkg = addon()
	if (!pkg) return say('This configuration has no package.')
	say(isImage(pkg) ? 'Press Flash recovery image — it waits for the bootloader.' : 'Press Sideload package — it waits for the phone in recovery sideload.')
}

function previewPlan() {
	if (busy) return
	startRun(planFor(addon()))
	statusHint()
}

const refresh = () => {
	const pkg = addon()
	const image = isImage(pkg)
	$('connect').disabled = busy
	$('fastboot-connect').disabled = busy
	$('config-open').disabled = busy
	$('connect').textContent = phone ? 'Disconnect' : 'Connect adb'
	$('fastboot-connect').textContent = fastboot ? 'Disconnect bootloader' : 'Connect bootloader'
	$('run').disabled = busy || !pkg
	$('run').textContent = image ? 'Flash recovery image' : 'Sideload package'
	$('package-name').textContent = pkg ? shortName(pkg) : 'No package published'
	$('package-meta').textContent = pkg
		? `${size(pkg.size ?? 0)} · sha256 ${(pkg.sha256 ?? 'none').slice(0, 12)}… · ${image ? 'flashed with fastboot' : 'pushed with adb sideload'}`
		: 'This configuration has no add-on or recovery package'
	const mode = fastboot ? 'fastboot' : phone ? (phone.state === 'sideload' ? 'recovery (sideload)' : `adb (${phone.state})`) : null
	const name = fastboot ? (fastbootInfo?.product ?? 'bootloader') : phone ? (phone.name ?? 'device') : 'Not connected'
	const meta = fastboot
		? `fastboot · slot ${fastbootInfo?.slot ?? '?'} · ${fastbootInfo?.unlocked ?? '—'}`
		: phone
			? phone.state === 'sideload'
				? 'recovery · sideload'
				: `adb · ${phone.state}`
			: 'Booted Android, recovery sideload, or the bootloader'
	setCard(name, meta)
	renderKv('device', [
		['Mode', mode ?? 'not connected'],
		['Serial', fastboot ? (fastbootInfo?.serial ?? '—') : (phone?.serial ?? '—')],
		['State', fastboot ? 'ready to flash an image' : phone ? (phone.state === 'sideload' ? 'ready for a package' : 'connected') : 'connect the phone'],
	])
}

function wireConfigCard() {
	$('config-open').addEventListener('click', async () => {
		const id = await chooseConfig({ configs, current: config.id })
		if (id) setConfig(id)
	})
}

function renderAddonSelect() {
	const select = $('addon-select')
	const list = packages()
	select.replaceChildren(
		...list.map((item, index) => {
			const option = document.createElement('option')
			option.value = String(index)
			option.textContent = item.title ?? item.label ?? item.name
			return option
		}),
	)
	select.hidden = list.length < 2
	select.value = String(current)
}

function setConfig(id) {
	const next = configs.find((item) => item.id === id)
	if (!next) return
	config = next
	current = 0
	document.title = `Tools · ${config.name} (${config.codename})`
	renderAddonSelect()
	paintConfigCard(config)
	log(`tools: config ${config.id} (${config.codename})`)
	refresh()
	previewPlan()
}

function adopt(connected) {
	phone = connected
	fastboot = null
	fastbootInfo = null
	log(`tools: connected (${connected.state}) to ${connected.name ?? connected.serial ?? 'device'}`)
	refresh()
	return connected.adb
}

const session = recoverySession({ log, hint, adopt })

async function connect() {
	if (busy) return
	if (phone) {
		phone = null
		say('Disconnected.')
		return refresh()
	}
	try {
		say('Authorising — confirm the USB debugging prompt on the phone.')
		adopt(await connectAdb((await grantedAdbDevices())[0] ?? null))
		say(phone.state === 'sideload' ? 'Recovery sideload ready.' : 'Connected.', 'ok')
	} catch (err) {
		phone = null
		log(`tools: connect failed: ${err.message}`)
		say(err.message, 'err')
		refresh()
	}
}

function resetFastboot() {
	fastboot = null
	fastbootInfo = null
	$('grant-fastboot').hidden = true
	say('Bootloader disconnected.')
	refresh()
}

async function connectFastboot() {
	if (busy) return
	if (fastboot) return resetFastboot()
	try {
		const { usb, mode } = await pickDevice()
		if (mode !== 'fastboot') throw new Error('not in fastboot mode — reboot the phone to the bootloader')
		fastboot = await attachFastboot(usb)
		const { info } = await readFastbootInfo(fastboot)
		fastbootInfo = info
		phone = null
		log(`tools: fastboot connected (${info.product ?? 'unknown'}, slot ${info.slot ?? '?'})`)
		say('Bootloader connected.', 'ok')
	} catch (err) {
		fastboot = null
		fastbootInfo = null
		log(`tools: fastboot connect failed: ${err.message}`)
		say(err.name === 'NotFoundError' ? 'No device selected.' : err.message, 'err')
	}
	refresh()
}

// A bootloader that was never granted needs a gesture; this is the same button as the Flash page.
async function waitForFastboot(seconds = 180) {
	for (let i = 0; i < seconds; i++) {
		const found = (await grantedDevices()).find((d) => d.mode === 'fastboot')
		if (found) {
			$('grant-fastboot').hidden = true
			try {
				const dev = await attachFastboot(found.usb)
				const { info } = await readFastbootInfo(dev)
				fastbootInfo = info
				return dev
			} catch (err) {
				log(`tools: bootloader attach failed: ${err.message}`)
			}
		}
		if (i === 0) $('grant-fastboot').hidden = false
		await new Promise((resolve) => setTimeout(resolve, 1000))
	}
	$('grant-fastboot').hidden = true
	throw new Error('no fastboot device appeared — connect the bootloader')
}

// Recovery has to be waiting for a package before a zip can be pushed. A bootloader or a booted
// phone can be sent there; otherwise the page waits for the user to open Apply from ADB.
async function ensureSideload() {
	if (phone?.state === 'sideload') return phone.adb
	const rebooting = Boolean(fastboot) || phone?.state === 'device' || phone?.state === 'recovery'
	step('wait', 'on', rebooting ? 'rebooting to recovery…' : 'waiting for recovery…')
	say(rebooting ? 'Rebooting the phone into recovery…' : 'Waiting for recovery sideload…')
	if (fastboot) {
		await fastboot.reboot('recovery').catch((err) => log(`tools: fastboot reboot recovery failed: ${err.message}`))
		fastboot = null
		fastbootInfo = null
	} else if (phone?.state === 'device' || phone?.state === 'recovery') {
		await rebootAdb(phone.adb, 'sideload')
	}
	phone = null
	refresh()
	const adb = await session.wait(600, (i) => {
		if (i % 15 === 0) say('Waiting for recovery sideload… — on the phone: Apply update → Apply from ADB')
	})
	step('wait', 'done', 'recovery is waiting for a package')
	return adb
}

async function run() {
	if (busy) return
	const pkg = addon()
	if (!pkg) return say('This configuration has no package.', 'err')
	if (isImage(pkg)) return runImage(pkg)
	return runZip(pkg)
}

async function runZip(pkg) {
	busy = true
	refresh()
	lockUi(true, 'A sideload is running.')
	startRun(planFor(pkg))
	try {
		// mirrored zips are downloaded and hashed in pickAddon; the rest are picked and hashed here
		const strict = Boolean(config.recoveries?.includes(pkg))
		const file = await pickAddon('download', pkg, log, { strict })
		hint('')

		let adb = await ensureSideload()

		step('flash', 'on', 'sideloading…')
		say(`Sideloading ${shortName(pkg)}…`)
		hint('Recovery may say “Signature verification failed” during this install — tap Yes. Packages are not signed with the ROM’s key.')
		const logSideload = every(log, 'sideload', 10)
		const transfer = await sideloadWithWait(adb, file, {
			label: `${shortName(pkg)} sideload`,
			reconnect: async () => {
				step('wait', 'on', 'recovery restarted, waiting…')
				adb = await ensureSideload()
				step('flash', 'on', 'sideloading…')
				return adb
			},
			onLog: log,
			onProgress: (p) => {
				step('flash', 'on', `sideloading ${Math.round(p * 100)}%`)
				progress('flash', p)
				logSideload(p)
			},
		})
		log(`tools: transfer ${transfer.sent} bytes (device said done: ${transfer.confirmed})`)

		step('flash', 'done', 'package installed')
		step('done', 'done', 'on the phone: back arrow → Reboot system now')
		say('Package installed. On the phone: back arrow, then Reboot system now.', 'ok')
		hint('Back arrow, then Reboot system now on the phone.')
		log('tools: sideload finished')
	} catch (err) {
		const message = failStep(err)
		say(message, 'err')
		log(`tools: sideload failed: ${message}`)
	} finally {
		busy = false
		lockUi(false)
		refresh()
	}
}

async function runImage(pkg) {
	busy = true
	refresh()
	lockUi(true, 'A recovery flash is running.')
	startRun(planFor(pkg))
	try {
		const file = await pickAddon('download', pkg, log, { strict: true })
		hint('')

		let dev = fastboot
		if (!dev) {
			if (phone) {
				step('wait', 'on', 'rebooting to the bootloader…')
				say('Rebooting the phone to the bootloader…')
				await rebootAdb(phone.adb, 'bootloader').catch((err) => log(`tools: adb reboot bootloader failed: ${err.message}`))
				phone = null
				refresh()
			}
			step('wait', 'on', 'waiting for the bootloader…')
			say('Waiting for the bootloader…')
			dev = await waitForFastboot(180)
			fastboot = dev
		}
		step('wait', 'done', 'bootloader connected')

		step('flash', 'on', 'flashing…')
		say(`Flashing ${shortName(pkg)}…`)
		const slots = await flashRecoveryImage(dev, file, {
			onProgress: (slot, done, p) => {
				step('flash', 'on', `${slot === 'current' ? 'recovery' : `recovery_${slot}`} ${Math.round(p * 100)}%`)
				progress('flash', done)
			},
		})
		const where = slots.map((slot) => (slot === 'current' ? 'recovery' : `recovery_${slot}`)).join(' and ')
		step('flash', 'done', `flashed to ${where}`)
		log(`tools: flashed ${shortName(pkg)} to ${where}`)
		try {
			await dev.reboot('')
			say('Recovery installed. The phone is rebooting.', 'ok')
		} catch (err) {
			log(`tools: reboot failed: ${err.message}`)
			say('Recovery installed. On the phone: Reboot system now.', 'ok')
			hint('The bootloader did not reboot by itself — choose Reboot system now on the phone.')
		}
		step('done', 'done', 'recovery installed')
		fastboot = null
		fastbootInfo = null
	} catch (err) {
		const message = failStep(err)
		say(message, 'err')
		log(`tools: recovery flash failed: ${message}`)
	} finally {
		busy = false
		lockUi(false)
		refresh()
	}
}

async function init() {
	if (!navigator.usb) return say('WebUSB unavailable — use Chrome, Edge, Brave or Helium.', 'err')
	try {
		configs = await loadConfigs()
	} catch (err) {
		return say(`config: ${err.message}`, 'err')
	}
	wireConfigCard()
	$('addon-select').addEventListener('change', () => {
		current = Number($('addon-select').value)
		log(`tools: package ${addon()?.name}`)
		refresh()
		previewPlan()
	})
	setConfig(configs[0].id)
	log(`tools: ${configs.length} configuration(s), ${packages().length} package(s) in ${config.id}`)

	downloadLog('log-download')
	$('connect').addEventListener('click', connect)
	$('fastboot-connect').addEventListener('click', connectFastboot)
	$('grant-fastboot').addEventListener('click', async () => {
		try {
			const { mode } = await pickDevice()
			log(`tools: bootloader grant: ${mode}`)
			if (mode === 'fastboot') $('grant-fastboot').hidden = true
			else hint('That device is not in fastboot mode — reboot it to the bootloader and try again.')
		} catch (err) {
			log(`tools: bootloader grant: ${err.message}`)
		}
	})
	$('run').addEventListener('click', run)
	refresh()
	previewPlan()

	// an already-authorised phone should just work: bootloader first, then adb
	try {
		const fastbootDevice = (await grantedDevices()).find((d) => d.mode === 'fastboot')
		if (fastbootDevice) {
			fastboot = await attachFastboot(fastbootDevice.usb)
			const { info } = await readFastbootInfo(fastboot)
			fastbootInfo = info
			log(`tools: fastboot connected (${info.product ?? 'unknown'})`)
		} else {
			const devices = await grantedAdbDevices()
			if (devices.length) adopt(await connectAdb(devices[0]))
		}
	} catch (err) {
		log(`tools: auto-connect: ${err.message}`)
	}
	if (fastboot) say('Bootloader connected — press Flash recovery image.', 'ok')
	else if (phone) say(phone.state === 'sideload' ? 'Recovery sideload ready.' : 'Connected.', 'ok')
	refresh()
}

init()
