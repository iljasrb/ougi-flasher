// Flash page: connect (fastboot or adb) -> device check -> ROM flash / add-on sideload.
// Everything device-specific (codename, image list, URLs, add-ons) comes from one of the
// configurations in flasher.json.
import { setDebugLogger } from './vendor/fastboot.min.mjs'
import { adbDeviceFor, adbInfo, connectAdb, detectPackages, grantedAdbDevices, rebootAdb } from './lib/adb.mjs'
import { fetchPackage, flashImages, pushBlob, readImages } from './lib/flash.mjs'
import { choose, chooseConfig, confirmRisks } from './lib/dialog.mjs'
import { loadConfigs } from './lib/config.mjs'
import { pickAddon, shortName } from './lib/addons.mjs'
import { lockUi } from './lib/guard.mjs'
import { every } from './lib/log.mjs'
import { recoverySession } from './lib/session.mjs'
import { sideloadWithWait } from './lib/recovery.mjs'
import { failStep, progress, startRun, step } from './lib/steps.mjs'
import { $, cardTitle, DEFAULT_RISKS, hintBox, pageLog, paintConfigCard, renderKv, size, statusBox } from './lib/ui.mjs'
import { attachFastboot, grantedDevices, pickDevice, readFastbootInfo, watchUsb } from './lib/usb.mjs'

const ACK_KEY = 'ougi-flasher:risk-ack-v2'
const CONFIG_KEY = 'ougi-flasher:config'
const ackKey = (id) => `${ACK_KEY}:${id}`
const state = { mode: null, adbState: null, dev: null, adb: null, configs: [], config: null, codename: null, wrong: false, busy: false, ack: false }

// ---- ui -------------------------------------------------------------------------------

const { log, download: downloadLog } = pageLog('log')
setDebugLogger((...data) => log(...data.filter((d) => typeof d === 'string')))

const say = statusBox('status')
const hint = hintBox('hint')
const setCard = cardTitle('device-name', 'device-meta')
const renderDevice = (rows) => renderKv('device', rows)

// A leftover Virtual A/B snapshot makes the next boot fail ("Can't load Android system"), so cancel
// it before touching anything.
async function cancelPendingSnapshot(dev) {
	let status = null
	try {
		status = await dev.getVariable('snapshot-update-status')
	} catch {
		log('clean: snapshot-update-status unavailable on this bootloader')
		return
	}
	log(`clean: snapshot-update-status ${status ?? 'null'}`)
	if (!status || status === 'none') return
	try {
		await dev.runCommand('snapshot-update:cancel')
		log('clean: cancelled a pending snapshot update')
	} catch (err) {
		log(`clean: snapshot-update:cancel failed: ${err.message}`)
	}
}

// ---- step plans -----------------------------------------------------------------------

const pickSteps = (addons) => addons.map((addon, index) => [`pick${index}`, addon.url ? `Download ${shortName(addon, index)}` : `Choose the ${shortName(addon, index)} zip`])
// One recovery session installs every add-on in sequence; only the first one needs the reboot.
const installSteps = (addons) =>
	addons.flatMap((addon, index) => [...(index ? [] : [['reboot', 'Reboot to recovery']]), [`addon${index}`, `Sideload ${shortName(addon, index)}`]])

const plans = {
	update: (addons) => [
		['check', 'Device check'],
		['download', 'Download OTA'],
		...pickSteps(addons),
		['flash', 'Sideload OTA'],
		...installSteps(addons),
		['done', addons.length ? 'Reboot system' : 'Finish'],
	],
	local: () => [
		['check', 'Device check'],
		['download', 'Download OTA'],
		['copy', 'Copy to the phone'],
		['done', 'Finish in the Updater'],
	],
	clean: (addons) => [
		['check', 'Device check'],
		['download', 'Download additional images'],
		['otadl', 'Download OTA'],
		...pickSteps(addons),
		['flash', 'Flash additional images'],
		['reset', 'Factory data reset (on the phone)'],
		['rom', 'Sideload ROM'],
		...installSteps(addons),
		['done', 'Reboot system'],
	],
}

const selectedMode = () => document.querySelector('input[name="mode"]:checked')?.value ?? 'clean'
const addonBoxes = () => [...document.querySelectorAll('#modes input[data-addon]')]
const chosenAddons = () =>
	addonBoxes()
		.filter((box) => box.checked)
		.map((box) => state.config.addons[Number(box.dataset.addon)])

// The step list is the plan of the current selection, so ticking an add-on shows the extra steps
// before anything runs (never during a run — that would wipe its progress).
function previewPlan() {
	if (state.busy || !state.config) return
	startRun(plans[selectedMode()](chosenAddons()))
}

// One checkbox per configured add-on, rendered from the selected configuration so a second add-on
// needs no HTML.
function renderAddonToggles(addons) {
	const modes = $('modes')
	for (const old of modes.querySelectorAll('.addon-toggle')) old.remove()
	for (const [index, addon] of addons.entries()) {
		const wrap = document.createElement('label')
		wrap.className = 'mode span addon-toggle'
		const box = document.createElement('input')
		box.type = 'checkbox'
		box.id = `with-addon-${index}`
		box.dataset.addon = String(index)
		box.addEventListener('change', previewPlan)
		const text = document.createElement('span')
		const strong = document.createElement('strong')
		strong.textContent = `Include ${addon.title ?? 'add-on'}`
		const meta = document.createElement('em')
		meta.textContent = [addon.size ? size(addon.size) : null, addon.url ? 'downloaded from the mirror' : 'you pick the zip'].filter(Boolean).join(' · ')
		text.append(strong, meta)
		wrap.append(box, text)
		modes.append(wrap)
	}
}

function refreshUi() {
	const offline = state.busy
	const update = selectedMode() === 'update'
	const d = state.config
	$('connect').disabled = offline
	$('to-bootloader').hidden = state.mode !== 'adb' || state.adbState !== 'device'
	$('to-bootloader').disabled = offline
	$('flash').textContent = update ? 'Update' : 'Flash'
	// Update can start from adb (booted, or recovery sideload) or from the bootloader
	// (reboot-recovery); Clean needs the bootloader and the image set. An adb connection the phone
	// has not authorised yet is not usable, so it must not enable the button.
	const adbUsable = state.mode === 'adb' && !['unauthorized', 'authorizing', 'offline'].includes(state.adbState)
	const ready = update ? adbUsable || state.mode === 'fastboot' : state.mode === 'fastboot' && Boolean(d?.images)
	$('flash').disabled = offline || !ready || !state.ack || state.wrong
	// Add-ons are only sideloaded as part of a clean install; the update path detects what is on the
	// phone instead of asking, so the tiles leave with Update.
	for (const box of addonBoxes()) {
		box.closest('.mode').hidden = update
		box.disabled = offline
	}
	for (const radio of document.querySelectorAll('input[name="mode"]')) {
		radio.disabled = offline || (radio.value === 'update' ? !d?.ota : !d?.images)
	}
	$('connect').textContent = state.mode ? 'Disconnect' : 'Connect'
}

function busy(on) {
	state.busy = on
	lockUi(on, 'A flash is running — leaving now aborts it and can leave the slot half-written.')
	refreshUi()
}

function reset() {
	state.mode = null
	state.adbState = null
	state.dev = null
	state.adb = null
	state.codename = null
	state.wrong = false
	renderDevice([['State', 'not connected']])
	setCard('Not connected', '')
	refreshUi()
}

// ---- connecting -----------------------------------------------------------------------

// Says which mode the current connection can do, so the disabled button is never a mystery.
function modeHint() {
	if (!state.mode || state.wrong) return
	const update = selectedMode() === 'update'
	if (state.adbState === 'sideload') return say('Recovery is waiting for a package — Update can send it now.', 'ok')
	if (state.adbState === 'unauthorized' || state.adbState === 'authorizing') {
		return say('Allow the USB debugging prompt on the phone to use adb.', 'err')
	}
	if (update && state.mode === 'adb') say('Ready to sideload the update.', 'ok')
	else if (!update && state.mode === 'fastboot') say('Ready to clean flash.', 'ok')
	else if (update) say('Ready: Update reboots to recovery first.', 'ok')
	else say('Clean flashing needs the bootloader — press Reboot to bootloader.', 'err')
}

// Never write one device's images to another: the selected configuration names the codename the
// phone must report. If the phone matches exactly one configuration, select it automatically.
// Recovery/sideload cannot report it (adbd serves the sideload socket only), so it is not enforced
// there — the boot chain was written before recovery is reached.
async function checkCodename(codename) {
	state.codename = codename || null
	if (codename && codename !== state.config.codename) {
		const matches = state.configs.filter((config) => config.codename === codename)
		if (matches.length === 1) {
			log(`config: ${codename} matched ${matches[0].id} — switching`)
			await selectConfig(matches[0].id)
		}
	}
	const want = state.config.codename
	state.wrong = Boolean(codename) && codename !== want
	if (!state.wrong) return false
	log(`device: connected ${codename}, this page is set to ${want}`)
	const matching = state.configs.some((config) => config.codename === codename)
	say(`This page flashes ${want}, but the phone says ${codename} — ${matching ? `pick a ${codename} configuration` : 'connect the right phone'}.`, 'err')
	refreshUi()
	return true
}

async function useFastboot(usb) {
	if (state.mode) return // another path already attached
	state.dev = await attachFastboot(usb)
	state.mode = 'fastboot'
	const { rows, info } = await readFastbootInfo(state.dev)
	log(`fastboot: product=${info.product} slot=${info.slot} unlocked=${info.unlocked}`)
	renderDevice([['Mode', 'fastboot'], ...rows])
	setCard(info.product ?? state.config.name, `bootloader · slot ${info.slot ?? '?'} · ${info.unlocked}`)
	step('check', 'done', `${info.product} · slot ${info.slot} · ${info.unlocked}`)
	say('Connected.', 'ok')
	refreshUi()
	if (await checkCodename(info.product)) return
	modeHint()
	unlockHint(info.unlocked)
}

function unlockHint(unlocked) {
	if (unlocked === 'locked') {
		hint('The bootloader is locked — flashing will be refused. Unlock it first (the vendor’s unlock flow), then reconnect.')
	} else if (unlocked === '—') {
		hint('The bootloader lock state could not be read — if flashing is refused, unlock the bootloader and retry.')
	} else {
		hint('')
	}
}

async function useAdb(device) {
	const { adb, name, serial, state: adbState } = await connectAdb(device)
	log(`usb: adb attached (${adbState})`)
	state.adb = adb
	state.mode = 'adb'
	state.adbState = adbState
	if (adbState !== 'device') {
		// adbd in recovery/sideload only serves the sideload socket — `shell:` is closed, so there
		// are no props to read. Show what the banner does tell us instead.
		renderDevice([['Mode', `recovery (${adbState})`], ['Serial', serial ?? '—'], ['State', 'ready for a package']])
		setCard(name ?? 'recovery', `recovery · ${adbState}`)
		say('Recovery sideload ready.', 'ok')
		refreshUi()
		return
	}
	log(`adb: state=${adbState}`)
	const { rows, info } = await adbInfo(adb)
	renderDevice([['Mode', `adb (${adbState})`], ...rows])
	setCard(info.device ?? state.config.name, `${info.build ?? '—'} · slot ${info.slot ?? '?'} · ${info.unlocked}`)
	refreshUi()
	if (await checkCodename(info.device)) return
	unlockHint(info.unlocked)
	say(adbState === 'device' ? 'Connected.' : `Connected (${adbState}).`, 'ok')
	modeHint()
}

async function connect() {
	if (state.busy) return
	if (state.mode) return reset()
	clearTimeout(retryTimer)
	autoFailed = false
	busy(true)
	try {
		log('connect: opening the usb picker')
		const { usb, mode } = await pickDevice()
		log(`connect: selected a device in ${mode} mode`)
		if (mode === 'fastboot') await useFastboot(usb)
		else if (mode === 'adb') await useAdb(await adbDeviceFor(usb))
		else throw new Error('not an Android device')
	} catch (err) {
		reset()
		say(err.name === 'NotFoundError' ? 'No device selected.' : (err.bootloaderMessage ?? err.message), 'err')
	} finally {
		busy(false)
	}
}

// A device this origin already authorised: no picker. fastboot first, then adb.
let retryTimer = null
let autoPending = false
let autoFailed = false

async function autoConnect() {
	if (state.mode) return
	const fastbootDevice = (await grantedDevices()).find((d) => d.mode === 'fastboot')
	if (fastbootDevice) return await useFastboot(fastbootDevice.usb)
	const adbDevices = await grantedAdbDevices()
	if (adbDevices.length) await useAdb(adbDevices[0])
}

// One automatic attempt per device appearance. A failure is usually the phone waiting for the
// "Allow USB debugging" tap; retrying that in a loop only asks again, so wait for a replug or a
// manual Connect instead.
async function autoConnectOnce() {
	if (autoPending || autoFailed || state.mode) return false
	autoPending = true
	try {
		await autoConnect()
		autoFailed = false
		return Boolean(state.mode)
	} catch (err) {
		autoFailed = true
		log(`auto-connect: ${err.message}`)
		return false
	} finally {
		autoPending = false
	}
}

// ---- bootloader -----------------------------------------------------------------------

async function toBootloader() {
	busy(true)
	try {
		say('Rebooting to the bootloader…')
		await rebootAdb(state.adb, 'bootloader')
		state.adb = null
		state.mode = null
		refreshUi()
		await waitForFastboot()
	} catch (err) {
		say(err.message, 'err')
	} finally {
		busy(false)
	}
}

async function waitForFastboot(seconds = 45) {
	for (let i = 0; i < seconds; i++) {
		const found = (await grantedDevices()).find((d) => d.mode === 'fastboot')
		if (found) return await useFastboot(found.usb)
		await new Promise((resolve) => setTimeout(resolve, 1000))
	}
	throw new Error('no fastboot device appeared — replug the cable')
}

// Recovery advertises its own USB identity (18d1:d001 vs 18d1:4e11), so WebUSB permission is not
// inherited from the Android one and getDevices() stays empty until the user grants it once. The
// picker cannot be opened without a gesture, hence the "Allow recovery adb" button.
// `fastboot reboot-sideload` would save the manual Apply update → Apply from ADB dance, but this
// bootloader does not implement it, so ask for plain `reboot recovery` and let the user pick.
async function rebootToRecovery(stepId, { dev = state.dev, wait = 600 } = {}) {
	log(`fastboot reboot recovery (serial ${dev?.serial ?? '?'})`)
	step(stepId, 'on', 'rebooting to recovery…')
	say('Rebooting the phone to recovery…')
	try {
		await dev.reboot('recovery')
	} catch (err) {
		log(`reboot-recovery failed: ${err.message}`)
		throw new Error('this bootloader refused “reboot recovery” — pick Recovery mode on the phone (power + volume down), then retry')
	}
	state.dev = null
	state.mode = null
	state.adbState = null
	refreshUi()
	hint('On the phone: Recovery mode → Apply update → Apply from ADB — recovery has to be in sideload mode.')
	await session.wait(wait, (i) => {
		if (i % 15 === 0) hint('Waiting for recovery sideload mode — Apply update → Apply from ADB on the phone.')
	})
	return state.adb
}

// A polled adb connection (recovery sideload) becomes the page's live connection.
function adopt(connected) {
	state.adb = connected.adb
	state.mode = 'adb'
	state.adbState = connected.state
	refreshUi()
	return connected.adb
}

const session = recoverySession({ log, hint, adopt })

// Drops the dead handle and waits for recovery to come back, for sideloadWithWait().
async function reconnectSideload(onWait) {
	state.adb = null
	state.adbState = null
	state.mode = null
	refreshUi()
	return session.reconnect(onWait)
}

// ---- update: find the add-ons that are installed, then pick the path --------------------

// Which configured add-ons look installed? Only answerable over adb from a booted phone; an add-on
// with no `detect` ids cannot be checked at all. `always` add-ons are never checked either: a
// recovery partition has no package id and every ROM install overwrites it, so it always goes on
// again.
async function detectAddons() {
	const always = state.config.addons.filter((addon) => addon.always)
	const checkable = state.config.addons.filter((addon) => !addon.always)
	if (!checkable.length) return { present: [], unknown: [], always }
	if (!state.adb || state.adbState !== 'device') return { present: [], unknown: checkable, always }
	const present = []
	const unknown = []
	for (const addon of checkable) {
		if (!addon.detect?.length) {
			unknown.push(addon)
			continue
		}
		const result = await detectPackages(state.adb, addon.detect)
		log(`addon: ${shortName(addon, 0)} ${result.state} (${result.detail})`)
		if (result.state === 'present') present.push(addon)
		if (result.state === 'unknown') unknown.push(addon)
	}
	return { present, unknown, always }
}

const names = (addons) => addons.map((addon, i) => shortName(addon, i)).join(', ')

// Recovery never runs addon.d, so an update with add-ons installed would break them. Returns the
// add-ons to re-push, or null when the user aborts.
async function pickUpdatePath() {
	const { present, unknown, always } = await detectAddons()
	let repush = present
	if (unknown.length) {
		const choice = await choose({
			title: `Couldn’t check for ${names(unknown)}`,
			body: 'A recovery update would break it if it is installed.',
			options: [
				{ value: 'absent', label: 'I do not have it installed', kind: 'primary' },
				{ value: 'present', label: 'I have it installed' },
			],
		})
		log(`dialog: addon unknown -> ${choice ?? 'abort'}`)
		if (!choice) return null
		if (choice === 'present') repush = [...present, ...unknown]
	}
	if (!repush.length && !always.length) {
		log('update: no add-on packages, going straight to sideload')
		return []
	}
	// The ROM's Updater keeps add-on packages through addon.d, but it rewrites the recovery
	// partition like a sideload does, so an `always` add-on would be gone: sideload instead.
	if (always.length) {
		log(`update: ${names(always)} is rewritten by any update — sideloading it again after the ROM`)
		return [...repush, ...always]
	}
	const choice = await choose({
		title: `${names(repush)} installed`,
		body: 'Recovery does not run addon.d, so the add-on has to be installed again after the update.',
		options: [
			{ value: 'local', label: 'Use the ROM’s Updater instead — keeps it (recommended)', kind: 'primary' },
			{ value: 'sideload', label: 'Sideload the ROM, then the add-on again' },
		],
		cancel: { value: 'abort', label: 'Cancel' },
	})
	log(`dialog: addon present -> ${choice ?? 'abort'}`)
	if (choice === 'local') return 'local'
	return choice === 'sideload' ? repush : null
}

async function update() {
	if (state.busy) return
	hint('')
	log(`update: start (mode ${selectedMode()})`)
	const repush = await pickUpdatePath()
	if (repush === null) return say('Update cancelled.')
	if (repush === 'local') return await pushForLocalUpdate()
	startRun(plans.update(repush))
	return await recoveryUpdate({ repush })
}

// Local install: the zip has to reach the phone, then the ROM's own Updater runs addon.d and keeps
// the add-ons. Directions first — pushing is offered as a button, and only with live adb.
async function pushForLocalUpdate() {
	const ota = state.config.ota
	const name = ota.url.split('/').pop()
	const folder = ota.url.replace(/[^/]+$/, '')
	const adbReady = Boolean(state.adb) && state.adbState === 'device'
	log(`local install: ${adbReady ? 'adb is available, offering the push' : 'directions only (no adb)'}`)

	const choice = await choose({
		title: 'Update from the ROM’s Updater',
		body: adbReady ? 'The zip has to be on the phone first.' : 'Download the zip on the phone:',
		link: { href: folder, label: folder.replace(/^https?:\/\//, '') },
		steps: [
			`Download ${name} on the phone`,
			'Keep it in Download (the browser puts it there)',
			'Settings → System → Updater → three-dot menu → Local update',
			`Pick ${name}, Install, then Reboot`,
		],
		options: adbReady
			? [
					{ value: 'push', label: 'Push the OTA package to /sdcard via adb', kind: 'primary' },
					{ value: 'manual', label: 'I will copy it myself' },
				]
			: [{ value: 'done', label: 'Got it', kind: 'primary' }],
	})
	log(`local install: ${choice ?? 'dismissed'}`)
	if (choice !== 'push') return hint(`Zip: ${folder}${name} · Updater → three-dot menu → Local update`)

	let pushed = null
	startRun(plans.local())
	busy(true)
	try {
		step('check', 'done', `adb (${state.adbState})`)
		say('Downloading OTA…')
		log(`download: ${ota.url} (${size(ota.size)})`)
		const blob = await downloadStep('download', ota, 'OTA')

		const remote = `/sdcard/Download/${name}`
		step('copy', 'on', 'copying to the phone…')
		say('Copying to /sdcard/Download…')
		await pushBlob(state.adb, blob, remote, (p) => {
			step('copy', 'on', `copying ${Math.round(p * 100)}%`)
			progress('copy', p)
		})
		step('copy', 'done', `copied to ${remote}`)
		log(`pushed ${ota.url} -> ${remote}`)
		pushed = { name, remote }
	} catch (err) {
		failRun(err, 'local update push failed')
	} finally {
		busy(false)
	}
	if (!pushed) return

	await choose({
		title: 'Finish the update on the phone',
		body: `Zip is at ${pushed.remote}. The Updater runs addon.d, so the add-ons survive.`,
		steps: [
			'Open Settings → System → Updater',
			'Tap the three-dot menu → Local update',
			`Pick ${pushed.name} (Downloads)`,
			'Tap Install, wait for it to finish, then Reboot',
		],
		options: [{ value: 'ok', label: 'Got it', kind: 'primary' }],
	})
	step('done', 'done', 'update pending in the Updater')
	say('Copied — install it from the Updater on the phone.', 'ok')
	hint(`Zip: ${pushed.remote} · Updater → three-dot menu → Local update`)
}

// Marks the running step (and the status line) as failed. `on` is the only state a step can be in
// while the code that threw was running, so there is no need to track it by hand.
function failRun(err, label) {
	const message = failStep(err)
	say(message, 'err')
	log(`${label}: ${message}`)
}

async function downloadStep(stepId, entry, label) {
	const logDownload = every(log, 'download', 20)
	say(`Downloading ${label}…`)
	step(stepId, 'on', 'downloading…')
	const blob = await fetchPackage(entry, (p) => {
		step(stepId, 'on', `${Math.round(p * 100)}% of ${size(entry.size)}`)
		progress(stepId, p)
		logDownload(p)
	})
	step(stepId, 'done', `${size(entry.size)}, sha256 ok`)
	log(`${label} sha256 ok (${size(entry.size)})`)
	return blob
}

// Picks the zips of the add-ons that will be sideloaded, before the phone is touched.
async function pickAddons(addons) {
	const entries = []
	for (const [index, addon] of addons.entries()) {
		entries.push({ addon, blob: await pickAddon(`pick${index}`, addon, log) })
		hint('')
	}
	return entries
}

async function recoveryUpdate({ repush = [] } = {}) {
	const ota = state.config.ota
	busy(true)
	try {
		if (!ota) throw new Error('this build has no OTA zip published')
		const fromBootloader = state.mode === 'fastboot'
		if (!fromBootloader && (state.mode !== 'adb' || !state.adb)) {
			throw new Error('a recovery update needs adb or the bootloader: connect the phone in either one')
		}
		if (!fromBootloader && ['unauthorized', 'authorizing', 'offline'].includes(state.adbState)) {
			throw new Error('adb is not authorised — accept the USB debugging prompt on the phone, then retry')
		}
		log(`update: recovery sideload, starting from ${fromBootloader ? 'bootloader' : `adb (${state.adbState})`}`)
		step('check', 'done', fromBootloader ? 'fastboot' : `adb (${state.adbState})`)
		log(`download: ${ota.url} (${size(ota.size)})`)
		const blob = await downloadStep('download', ota, 'OTA')
		const addons = await pickAddons(repush)

		if (fromBootloader) {
			// download first, so the phone is not parked in sideload while 1.8 GB come down
			await rebootToRecovery('flash')
		} else if (state.adbState === 'sideload') {
			step('flash', 'on', 'recovery already in sideload')
			log('recovery is already in sideload mode — skipping the reboot')
		} else {
			step('flash', 'on', 'rebooting to recovery…')
			say('Rebooting to recovery (sideload)…')
			await rebootAdb(state.adb, 'sideload')
			state.adb = null
			state.mode = null
			state.adbState = null
			refreshUi()
			await session.wait(120, (i) => {
				if (i % 10 === 0) say('Waiting for recovery sideload mode…')
			})
		}

		step('flash', 'on', 'sideloading…')
		say('Sideloading the OTA…')
		const logSideload = every(log, 'sideload', 10)
		const transfer = await sideloadWithWait(state.adb, blob, {
			label: 'OTA sideload',
			reconnect: () => reconnectSideload(),
			onLog: log,
			onProgress: (p) => {
				step('flash', 'on', `sideloading ${Math.round(p * 100)}%`)
				progress('flash', p)
				logSideload(p)
			},
			onWait: () => {
				step('flash', 'on', 'recovery is verifying and installing…')
				say('Recovery is verifying and installing the OTA — this takes a few minutes…')
			},
		})
		log(`sideload transfer done (${transfer.sent} bytes, device said done: ${transfer.confirmed})`)
		step('flash', 'done', transfer.confirmed ? 'OTA installed' : 'transfer complete — recovery is installing')
		log('sideload finished — recovery asks whether to reboot recovery for more packages')
		await sideloadAddons(addons)
	} catch (err) {
		failRun(err, 'sideload failed')
	} finally {
		busy(false)
	}
}

async function cleanFlash() {
	const d = state.config
	const chosen = chosenAddons()
	// the usb watcher drops state.dev on every reboot mid-run, so keep our own handle
	const dev = state.dev
	startRun(plans.clean(chosen))
	busy(true)
	try {
		step('check', 'done', 'fastboot, unlocked')
		if (!d.ota) throw new Error('this build has no OTA zip published, and the clean flow needs one for the ROM sideload')
		// everything is on the host before the phone is touched: a failed download can no longer
		// leave a wiped device with no ROM to install
		const imageBlob = await downloadStep('download', d.images, 'additional images')
		const otaBlob = await downloadStep('otadl', d.ota, 'OTA')
		const addons = await pickAddons(chosen)

		// 1. additional images (boot chain) — the ROM itself comes from the OTA below
		step('flash', 'on', 'reading images…')
		const images = await readImages(imageBlob, d.images.partitions)
		say('Flashing additional images…')
		log(`clean: flashing ${images.map((i) => i.partition).join(', ')} to the inactive slot`)
		await flashImages(dev, images, {
			slot: 'other',
			slotless: d.images.slotless,
			onProgress: (partition, done, p) => {
				step('flash', 'on', `${partition} ${Math.round(p * 100)}%`)
				progress('flash', done)
				if (p <= 0.001) log(`clean: flash ${partition}`)
			},
		})
		step('flash', 'done', `${images.length} images flashed`)

		// 2. the factory reset: the browser cannot format partitions (fastboot -w's mkfs half runs on
		// the host), so this is done by hand in recovery — it is what clears the encryption keys in
		// /metadata and the Virtual A/B snapshot state that otherwise break the first boot.
		await cancelPendingSnapshot(dev)
		step('reset', 'on', 'waiting for you to factory reset in recovery')
		const confirmed = await choose({
			title: 'Factory data reset, on the phone',
			body: 'The phone reboots into recovery by itself: format data there before the ROM goes on.',
			steps: ['Factory Reset → Format data / factory reset', 'When it finishes, go back to the main menu', 'Apply update → Apply from ADB'],
			options: [{ value: 'ok', label: 'Got it — reboot to recovery', kind: 'primary' }],
			cancel: { value: 'stop', label: 'Stop' },
		})
		if (confirmed !== 'ok') throw new Error('factory reset not confirmed — the ROM was not installed')
		log('clean: asking for Factory Reset → Format data / factory reset in recovery')
		await dev.reboot('recovery').catch((err) => log(`clean: reboot to recovery failed: ${err.message}`))
		state.adb = null
		state.adbState = null
		state.mode = null
		refreshUi()
		hint('Recovery: Factory Reset → Format data / factory reset, back to the main menu, then Apply update → Apply from ADB.')
		await session.wait(900, (i) => {
			if (i % 15 === 0) hint('Waiting — Recovery: Factory Reset → Format data / factory reset → main menu → Apply update → Apply from ADB.')
		})
		step('reset', 'done', 'factory reset done, recovery is in sideload')

		// 3. the ROM itself: recovery sideload of the OTA payload
		step('rom', 'on', 'sideloading the ROM…')
		say('Sideloading the ROM…')
		const logSideload = every(log, 'rom', 10)
		await sideloadWithWait(state.adb, otaBlob, {
			label: 'ROM sideload',
			reconnect: () => reconnectSideload(),
			onLog: log,
			onProgress: (p) => {
				step('rom', 'on', `sideloading ${Math.round(p * 100)}%`)
				progress('rom', p)
				logSideload(p)
			},
			onWait: () => {
				step('rom', 'on', 'recovery is installing the payload…')
				say('Recovery is installing the payload — this takes a few minutes…')
			},
		})
		step('rom', 'done', 'ROM installed')

		// 4. the add-ons, if any were asked for
		await sideloadAddons(addons)
	} catch (err) {
		failRun(err, 'clean flash failed')
	} finally {
		busy(false)
	}
}

async function flash() {
	if (state.busy) return
	if (selectedMode() === 'update') return update()
	return cleanFlash()
}

// ---- add-ons --------------------------------------------------------------------------

// Answering Yes to recovery's "install additional packages" prompt brings the sideload host back;
// the add-ons then go on in sequence, before the first boot of the new build.
async function sideloadAddons(entries) {
	if (!entries.length) {
		step('done', 'done', 'on the phone: No, then Reboot system now')
		say('Installed. On the phone: answer No, then Reboot system now.', 'ok')
		hint('Recovery asks about additional packages — answer No (the package is already written), then choose Reboot system now.')
		return
	}
	const many = entries.length > 1
	const choice = await choose({
		title: 'Recovery is asking about additional packages',
		body: `Answer Yes — the page sideloads ${many ? 'them' : 'it'} before the first boot.`,
		steps: [
			'Answer Yes on the phone',
			'Wait for recovery to restart',
			'Choose Apply update → Apply from ADB',
			`The page sideloads ${many ? 'each add-on' : 'the add-on'} automatically; then Reboot system now`,
		],
		options: [
			{ value: 'addons', label: `Continue with the add-on${many ? 's' : ''}`, kind: 'primary' },
			{ value: 'skip', label: 'Skip' },
		],
	})
	log(`post-OTA prompt: ${choice ?? 'cancel'}`)
	if (choice !== 'addons') {
		step('done', 'done', 'on the phone: No, then Reboot system now')
		say('Installed. On the phone: answer No, then Reboot system now.', 'ok')
		return
	}
	for (const [index, { addon, blob }] of entries.entries()) {
		const name = shortName(addon, index)
		const onPhone = index ? `On the phone: Apply update → Apply from ADB again for ${name}.` : 'On the phone: tap Yes, then Apply update → Apply from ADB.'
		hint(onPhone)
		// recovery is (re)starting here, so the current handle is on its way out: never reuse it
		state.adb = null
		state.adbState = null
		state.mode = null
		refreshUi()
		step(`addon${index}`, 'on', 'waiting for recovery…')
		await session.wait(600, (i) => {
			if (i % 15 === 0) hint(onPhone)
		})
		if (!index) step('reboot', 'done', 'recovery is back')
		hint(`Recovery may say “Signature verification failed” during this install — tap Yes. Add-ons are not signed with the ROM’s key.`)
		step(`addon${index}`, 'on', 'sideloading…')
		say(`Sideloading ${name}…`)
		const transfer = await sideloadWithWait(state.adb, blob, {
			label: `${name} sideload`,
			reconnect: () => reconnectSideload(() => hint(`Waiting for recovery again — Apply update → Apply from ADB for ${name}.`)),
			onLog: log,
			onProgress: (p) => {
				step(`addon${index}`, 'on', `${Math.round(p * 100)}%`)
				progress(`addon${index}`, p)
			},
			onWait: () => step(`addon${index}`, 'on', 'recovery is installing it…'),
		})
		log(`${name} transfer done (${transfer.sent} bytes, device said done: ${transfer.confirmed})`)
		step(`addon${index}`, 'done', `${name} installed`)
	}
	step('done', 'done', 'on the phone: Reboot system now')
	say('Add-ons installed. On the phone: back arrow, then Reboot system now.', 'ok')
	hint('Back arrow, then Reboot system now on the phone.')
}

// ---- live connection state ------------------------------------------------------------

// Unplugged, rebooted into another mode, or a replug: keep the card honest instead of showing a
// stale device. Flash runs set state.busy and reconnect by themselves, so they are left alone.
function watchConnection() {
	watchUsb(async (kind) => {
		if (kind === 'disconnect') {
			autoFailed = false
			if (!state.mode) return
			const was = state.mode
			log(`usb: ${was} disconnected`)
			if (state.busy) {
				// a run is in progress and may be waiting for the phone to come back (recovery
				// restart): drop the dead handles but leave the run's own UI alone
				state.adb = null
				state.dev = null
				state.mode = null
				state.adbState = null
				return
			}
			reset()
			say(`Device disconnected${was === 'adb' ? ' (adb)' : ''} — waiting for it to come back.`)
			return
		}
		if (state.busy) return
		clearTimeout(retryTimer)
		retryTimer = setTimeout(async () => {
			if (state.busy || state.mode) return
			const connected = await autoConnectOnce()
			if (!connected && !state.mode && !autoFailed) say('A device appeared, but this page has no permission for it yet — press Connect.')
		}, 700)
	})
}

// ---- configurations -------------------------------------------------------------------

// Everything a run is decided by, in one place: the card shows the selected configuration, clicking
// it opens a searchable list and every parameter of the chosen configuration.
const configById = (id) => state.configs.find((config) => config.id === id) ?? null

// The card opens a searchable list; each result has an info button with that configuration's table.
function wireConfigCard() {
	$('config-open').addEventListener('click', async () => {
		const id = await chooseConfig({ configs: state.configs, current: state.config.id })
		if (!id) return
		await selectConfig(id)
		await checkCodename(state.codename)
		modeHint()
		previewPlan()
	})
}

const rememberedConfig = () => {
	try {
		return localStorage.getItem(CONFIG_KEY)
	} catch {
		return null
	}
}

// Paint every piece of the page that depends on the configuration, then let the device check decide
// whether the connected phone is the right one.
function renderConfig(d) {
	document.title = `Flash · ${d.name} (${d.codename})`
	$('build').textContent = d.build
	$('build-meta').textContent = [d.codename, d.models?.join('/'), d.ota ? `OTA ${size(d.ota.size)}` : null, d.images ? `images ${size(d.images.size)}` : null, d.addons.length ? `${d.addons.length} add-on${d.addons.length > 1 ? 's' : ''} by file` : null]
		.filter(Boolean)
		.join(' · ')
	const chip = $('build-chip')
	chip.hidden = false
	chip.textContent = d.channel === 'latest' ? 'latest build' : (d.channel ?? 'build')
	chip.classList.toggle('warn', d.channel !== 'latest')
	renderAddonToggles(d.addons)
	paintConfigCard(d)
	if (!d.ota && selectedMode() === 'update') document.querySelector('input[name="mode"][value="clean"]').checked = true
	if (!d.images && selectedMode() === 'clean' && d.ota) document.querySelector('input[name="mode"][value="update"]').checked = true
	state.wrong = Boolean(state.codename) && state.codename !== d.codename
	refreshUi()
	previewPlan()
	log(`config: ${d.id} — ${d.codename} · ${d.build} (${d.channel ?? 'build'})`)
	log(`ota: ${d.ota?.url.split('/').pop() ?? 'not published'} (${d.ota ? size(d.ota.size) : '—'})`)
	log(`images: ${d.images?.url.split('/').pop() ?? 'not published'} (${d.images ? size(d.images.size) : '—'})`)
	for (const addon of d.addons) log(`addon: ${addon.name} (${size(addon.size ?? 0)})`)
}

async function selectConfig(id) {
	const d = configById(id)
	if (!d || d === state.config) return
	state.config = d
	state.ack = ackStored(d.id)
	try {
		localStorage.setItem(CONFIG_KEY, d.id)
	} catch {
		// private mode: the page still works, it just forgets the pick
	}
	renderConfig(d)
	if (!state.ack) await acknowledge()
}

// ---- boot -----------------------------------------------------------------------------

// The page writes to the phone, so nothing runs until the risks are acknowledged, once per
// configuration (localStorage).

const ackStored = (id) => {
	try {
		return localStorage.getItem(ackKey(id)) === '1'
	} catch {
		return false
	}
}

async function acknowledge() {
	state.ack = true
	const accepted = await confirmRisks({
		title: 'Experimental web flasher',
		body: `Unfinished software talking to your bootloader over WebUSB: it can leave the phone unable to boot and erase your data. Tick all ${DEFAULT_RISKS.length}.`,
		items: DEFAULT_RISKS,
	})
	if (!accepted) {
		state.ack = false
		say('Flashing stays disabled until the warnings are accepted — reload to read them again.', 'err')
		refreshUi()
		return
	}
	try {
		localStorage.setItem(ackKey(state.config.id), '1')
	} catch {
		log('risk list accepted (localStorage unavailable, will ask again next reload)')
	}
	log(`risk list acknowledged for ${state.config.id}`)
	say('Warnings accepted.', 'ok')
	refreshUi()
}

async function init() {
	$('connect').disabled = true
	if (!navigator.usb) {
		say('WebUSB unavailable — use Chrome, Edge, Brave or Helium.', 'err')
		return
	}
	try {
		state.configs = await loadConfigs()
	} catch (err) {
		say(`config: ${err.message}`, 'err')
		return
	}

	wireConfigCard()
	for (const radio of document.querySelectorAll('input[name="mode"]')) {
		radio.addEventListener('change', () => {
			refreshUi()
			modeHint()
			previewPlan()
		})
	}

	$('connect').addEventListener('click', connect)
	$('to-bootloader').addEventListener('click', toBootloader)
	$('flash').addEventListener('click', flash)

	const first = configById(rememberedConfig()) ?? state.configs[0]
	await selectConfig(first.id)
	downloadLog('log-download')
	autoConnectOnce()
	watchConnection()
}

init()
