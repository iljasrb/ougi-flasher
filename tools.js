// Tools page: one action by hand — sideload the add-on zip on its own, for repairing an add-on
// install after the ROM is already on the phone.
import { connectAdb, grantedAdbDevices, rebootAdb } from './lib/adb.mjs'
import { chooseConfig } from './lib/dialog.mjs'
import { loadConfigs } from './lib/config.mjs'
import { lockUi } from './lib/guard.mjs'
import { every } from './lib/log.mjs'
import { recoverySession } from './lib/session.mjs'
import { sideloadWithWait } from './lib/recovery.mjs'
import { failStep, progress, startRun, step } from './lib/steps.mjs'
import { $, cardTitle, hintBox, pageLog, paintConfigCard, renderKv, size, statusBox } from './lib/ui.mjs'
import { pickAddon, shortName } from './lib/addons.mjs'

const { log, download: downloadLog } = pageLog('log')
const say = statusBox('status')
const hint = hintBox('hint')
const setCard = cardTitle('device-name', 'device-meta')

const PLAN = [
	['download', 'Choose the add-on zip'],
	['wait', 'Get the phone into recovery sideload'],
	['flash', 'Sideload the add-on'],
	['done', 'Reboot system'],
]

let configs = []
let config = null
let current = 0 // index into config.addons (a <select> appears when there is more than one)
let phone = null // the connected adb device ({ adb, name, serial, state })
let busy = false

const addon = () => config?.addons[current] ?? null

const refresh = () => {
	const pkg = addon()
	$('connect').disabled = busy
	$('connect').textContent = phone ? 'Disconnect' : 'Connect'
	$('run').disabled = busy || !pkg
	$('package-name').textContent = pkg ? shortName(pkg) : 'No add-on package published'
	$('package-meta').textContent = pkg
		? `${size(pkg.size ?? 0)} · sha256 ${(pkg.sha256 ?? 'none').slice(0, 12)}… · pushed with adb sideload`
		: 'This configuration has no add-on package'
	setCard(
		phone ? (phone.name ?? 'device') : 'Not connected',
		phone ? (phone.state === 'sideload' ? 'recovery · sideload' : `adb · ${phone.state}`) : 'Booted Android, or recovery sideload',
	)
	renderKv('device', [
		['Mode', phone ? (phone.state === 'sideload' ? 'recovery (sideload)' : `adb (${phone.state})`) : 'not connected'],
		['Serial', phone?.serial ?? '—'],
		['State', phone ? (phone.state === 'sideload' ? 'ready for a package' : 'connected') : 'connect the phone'],
	])
	if (!phone && !busy) say('Press Sideload — it waits for the phone in recovery sideload.')
}

function wireConfigCard() {
	$('config-open').addEventListener('click', async () => {
		const id = await chooseConfig({ configs, current: config.id })
		if (id) setConfig(id)
	})
}

function renderAddonSelect() {
	const select = $('addon-select')
	select.replaceChildren(
		...config.addons.map((item, index) => {
			const option = document.createElement('option')
			option.value = String(index)
			option.textContent = item.title ?? item.label ?? item.name
			return option
		}),
	)
	select.hidden = config.addons.length < 2
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
}

function adopt(connected) {
	phone = connected
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

// Recovery has to be waiting for a package before the zip can be pushed.
async function ensureSideload() {
	if (phone?.state === 'sideload') return phone.adb
	step('wait', 'on', phone?.state === 'device' ? 'rebooting to recovery…' : 'waiting for recovery…')
	say(phone?.state === 'device' ? 'Rebooting the phone into recovery…' : 'Waiting for recovery sideload…')
	if (phone?.state === 'device') await rebootAdb(phone.adb, 'sideload')
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
	if (!pkg) return say('This configuration has no add-on package.', 'err')

	busy = true
	refresh()
	lockUi(true, 'A sideload is running.')
	startRun([[PLAN[0][0], pkg.url ? `Download ${shortName(pkg)}` : PLAN[0][1]], ...PLAN.slice(1)])
	try {
		// mirrored zips are downloaded and hashed in pickAddon; the rest are picked and hashed here
		const file = await pickAddon('download', pkg, log)
		hint('')

		let adb = await ensureSideload()

		step('flash', 'on', 'sideloading…')
		say('Sideloading the add-on…')
		hint('Recovery may say “Signature verification failed” during this install — tap Yes. Add-ons are not signed with the ROM’s key.')
		const logSideload = every(log, 'sideload', 10)
		const transfer = await sideloadWithWait(adb, file, {
			label: 'add-on sideload',
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

		step('flash', 'done', 'add-on installed')
		step('done', 'done', 'on the phone: back arrow → Reboot system now')
		say('Add-on installed. On the phone: back arrow, then Reboot system now.', 'ok')
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
		log(`tools: add-on ${addon()?.name}`)
		refresh()
	})
	setConfig(configs[0].id)
	log(`tools: ${configs.length} configuration(s), ${config.addons.length} add-on(s) in ${config.id}`)

	downloadLog('log-download')
	$('connect').addEventListener('click', connect)
	$('run').addEventListener('click', run)
	refresh()
	// the step plan is shown before the first run, like the Flash page's preview
	startRun(PLAN)

	// an already-authorised phone should just work
	try {
		const devices = await grantedAdbDevices()
		if (devices.length) adopt(await connectAdb(devices[0]))
	} catch (err) {
		log(`tools: auto-connect: ${err.message}`)
	}
}

init()
