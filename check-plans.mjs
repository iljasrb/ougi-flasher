// Step-plan checks: exactly one recovery, one reboot at most, and the right order for zip and
// image recoveries. No device and no browser.
//
//   node check-plans.mjs
import { installSteps, pickLabel, pickSteps, plans } from './lib/plans.mjs'
import { check, done, eq } from './check.mjs'

const addon = { title: 'GApps', name: 'gapps.zip' }
const zipRecovery = { title: 'AERA', kind: 'zip', name: 'aera.zip' }
const imageRecovery = { title: 'Skyward', kind: 'image', name: 'skyward.img' }
const ids = (plan) => plan.map(([id]) => id)
const eqIds = (name, plan, want) => eq(name, ids(plan).join(','), want.join(','))

// ---- clean ----------------------------------------------------------------------------
eqIds('clean without packages', plans.clean([], null), ['check', 'download', 'otadl', 'flash', 'reset', 'rom', 'done'])
eqIds('clean with an add-on', plans.clean([addon], null), ['check', 'download', 'otadl', 'pick0', 'flash', 'reset', 'rom', 'reboot', 'addon0', 'done'])
eqIds('clean with a zip recovery', plans.clean([], zipRecovery), [
	'check',
	'download',
	'otadl',
	'pickrecovery',
	'flash',
	'reset',
	'rom',
	'reboot',
	'recovery',
	'done',
])
eqIds('clean with an image recovery', plans.clean([], imageRecovery), [
	'check',
	'download',
	'otadl',
	'pickrecovery',
	'flash',
	'reset',
	'rom',
	'recovery',
	'done',
])
eqIds('clean with an add-on and a zip recovery', plans.clean([addon], zipRecovery), [
	'check',
	'download',
	'otadl',
	'pick0',
	'pickrecovery',
	'flash',
	'reset',
	'rom',
	'reboot',
	'addon0',
	'recovery',
	'done',
])
eqIds('clean with an add-on and an image recovery', plans.clean([addon], imageRecovery), [
	'check',
	'download',
	'otadl',
	'pick0',
	'pickrecovery',
	'flash',
	'reset',
	'rom',
	'reboot',
	'addon0',
	'recovery',
	'done',
])

// ---- update ---------------------------------------------------------------------------
eqIds('update without packages', plans.update([], null), ['check', 'download', 'flash', 'done'])
eqIds('update with a zip recovery', plans.update([], zipRecovery), ['check', 'download', 'pickrecovery', 'flash', 'reboot', 'recovery', 'done'])
eqIds('update with an image recovery', plans.update([], imageRecovery), ['check', 'download', 'pickrecovery', 'flash', 'recovery', 'done'])
eqIds('update with an add-on and a zip recovery', plans.update([addon], zipRecovery), [
	'check',
	'download',
	'pick0',
	'pickrecovery',
	'flash',
	'reboot',
	'addon0',
	'recovery',
	'done',
])
eqIds('update with an add-on and an image recovery', plans.update([addon], imageRecovery), [
	'check',
	'download',
	'pick0',
	'pickrecovery',
	'flash',
	'reboot',
	'addon0',
	'recovery',
	'done',
])
eqIds('the local Updater path', plans.local(), ['check', 'download', 'copy', 'done'])

// ---- install steps --------------------------------------------------------------------
eqIds('no packages means no install steps', installSteps([], null), [])
eqIds('a zip recovery adds the reboot and the sideload', installSteps([], zipRecovery), ['reboot', 'recovery'])
eqIds('an image recovery is flashed without a reboot', installSteps([], imageRecovery), ['recovery'])
eqIds('an add-on gets the reboot and its own step', installSteps([addon], null), ['reboot', 'addon0'])
eqIds('an add-on then a zip recovery', installSteps([addon], zipRecovery), ['reboot', 'addon0', 'recovery'])
eqIds('an add-on then an image recovery', installSteps([addon], imageRecovery), ['reboot', 'addon0', 'recovery'])

// ---- pick steps -----------------------------------------------------------------------
eqIds('no packages means no pick steps', pickSteps([], null), [])
eqIds('a zip recovery gets a pick step', pickSteps([], zipRecovery), ['pickrecovery'])
eqIds('an add-on and an image recovery get pick steps', pickSteps([addon], imageRecovery), ['pick0', 'pickrecovery'])

// ---- labels ---------------------------------------------------------------------------
eq('a mirrored package is downloaded', pickLabel({ title: 'AERA', url: 'https://example.test/a.zip' }), 'Download AERA')
eq('a manual zip is picked', pickLabel({ title: 'GApps', name: 'gapps.zip' }), 'Choose the GApps zip')
eq('a manual image is picked as an image', pickLabel({ title: 'Skyward', kind: 'image', name: 'skyward.img' }), 'Choose the Skyward image')
eq('a package without a title uses its file name', pickLabel({ name: 'a.zip' }), 'Choose the a.zip zip')

// ---- invariants -----------------------------------------------------------------------
const everyPlan = [
	plans.clean([addon], zipRecovery),
	plans.clean([addon], imageRecovery),
	plans.update([addon], zipRecovery),
	plans.update([addon], imageRecovery),
	plans.clean([], zipRecovery),
	plans.clean([], imageRecovery),
]
for (const plan of everyPlan) {
	const planIds = ids(plan)
	check(`one recovery step in ${planIds.join('>')}`, planIds.filter((id) => id === 'recovery').length === 1)
	check(`at most one reboot step in ${planIds.join('>')}`, planIds.filter((id) => id === 'reboot').length <= 1)
	check(`unique step ids in ${planIds.join('>')}`, new Set(planIds).size === planIds.length)
}

done()
