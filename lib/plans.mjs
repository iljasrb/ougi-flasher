// Step plans for the Flash page. Kept out of app.js so the order and the step ids can be checked
// without a browser: a recovery is a single choice, and an image recovery is flashed from the
// bootloader after the ROM instead of being sideloaded with the zip packages.
import { shortName } from './addons.mjs'

export const pickLabel = (pkg, index = 0) => {
	if (pkg.url) return `Download ${shortName(pkg, index)}`
	return `Choose the ${shortName(pkg, index)} ${pkg.kind === 'image' ? 'image' : 'zip'}`
}

export const pickSteps = (addons, recovery) => [
	...addons.map((addon, index) => [`pick${index}`, pickLabel(addon, index)]),
	...(recovery ? [['pickrecovery', pickLabel(recovery)]] : []),
]

// One recovery session installs every zip package in sequence; only the first one needs the reboot.
// An image recovery is flashed later, from the bootloader, so it is not part of the sideload loop.
export const installSteps = (addons, recovery) => {
	const zipRecovery = recovery && recovery.kind !== 'image' ? recovery : null
	const sideloads = [...addons, ...(zipRecovery ? [zipRecovery] : [])]
	const steps = sideloads.flatMap((pkg, index) => [
		...(index ? [] : [['reboot', 'Reboot to recovery']]),
		[pkg === zipRecovery ? 'recovery' : `addon${index}`, `Sideload ${shortName(pkg, index)}`],
	])
	if (recovery?.kind === 'image') steps.push(['recovery', `Flash ${shortName(recovery)}`])
	return steps
}

export const plans = {
	update: (addons, recovery) => [
		['check', 'Device check'],
		['download', 'Download OTA'],
		...pickSteps(addons, recovery),
		['flash', 'Sideload OTA'],
		...installSteps(addons, recovery),
		['done', addons.length || recovery ? 'Reboot system' : 'Finish'],
	],
	local: () => [
		['check', 'Device check'],
		['download', 'Download OTA'],
		['copy', 'Copy to the phone'],
		['done', 'Finish in the Updater'],
	],
	clean: (addons, recovery) => [
		['check', 'Device check'],
		['download', 'Download additional images'],
		['otadl', 'Download OTA'],
		...pickSteps(addons, recovery),
		['flash', 'Flash additional images'],
		['reset', 'Factory data reset (on the phone)'],
		['rom', 'Sideload ROM'],
		...installSteps(addons, recovery),
		['done', 'Reboot system'],
	],
}
