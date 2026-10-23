// Self-check for unlock detection. No device, no network:
//
//   node check-unlock.mjs
import { adbUnlock, detectPackages } from './lib/adb.mjs'
import { describeUnlock, parseLockedFlag, parseLockWord, reconcile } from './lib/unlock.mjs'
import { sanitizeVar } from './lib/usb.mjs'
import { done, eq } from './check.mjs'

// ---- parsers -------------------------------------------------------------------------
eq('verified green', parseLockWord('green'), 'locked')
eq('verified yellow', parseLockWord('yellow'), 'locked')
eq('verified orange', parseLockWord('orange'), 'unlocked')
eq('verified red', parseLockWord('red'), 'unlocked') // unlocked, verification failed
eq('verified unknown word', parseLockWord('purple'), null)
eq('flag 1', parseLockedFlag('1'), 'locked')
eq('flag 0', parseLockedFlag('0'), 'unlocked')
eq('flag "3" is not guessed', parseLockedFlag('3'), null)
eq('word yes', parseLockWord('yes'), 'unlocked')
eq('word no', parseLockWord('no'), 'locked')
eq('word 2 is not guessed', parseLockWord('2'), null)
eq('securestate flashing_unlocked', parseLockWord('flashing_unlocked'), 'unlocked')
eq('securestate oem_locked', parseLockWord('oem_locked'), 'locked')
eq('securestate flashing_locked', parseLockWord('flashing_locked'), 'locked')
eq('securestate junk', parseLockWord('SECURE_PROD_MODE'), null)

// ---- getvar sanitising (real bronco responses) ---------------------------------------
eq(
	'version-bootloader',
	sanitizeVar('version-bootloader', 'version-bootloader[0]: MBM-3.0-bronco-9aa3525200ee-260923-S\nversion-bootloader[1]: TBS32HV-63-ST27.9-c74e7\nDone'),
	'MBM-3.0-bronco-9aa3525200ee-260923-S\nTBS32HV-63-ST27.9-c74e7',
)
eq(
	'version-baseband',
	sanitizeVar('version-baseband', 'version-baseband[0]: M8475_DE305_30.1458.01.68.53R BRONCO_P\nversion-baseband[1]: VT2_ROWEDSDS_CUST\nDone'),
	'M8475_DE305_30.1458.01.68.53R BRONCO_P\nVT2_ROWEDSDS_CUST',
)
eq('single value', sanitizeVar('product', 'product: bronco\nDone'), 'bronco')
eq('dot in name', sanitizeVar('current-slot', 'current-slot: b\nDone'), 'b')
eq('empty answer', sanitizeVar('version-baseband', 'Done'), null)
eq('no answer', sanitizeVar('product', ''), null)

// ---- reconciler ----------------------------------------------------------------------
const o = (name, layer, value) => ({ name, layer, value })
eq('bootloader wins over props', reconcile([o('fb', 'bootloader', 'unlocked'), o('prop', 'props', 'locked')]).value, 'unlocked')
eq('...and is marked spoofed', reconcile([o('fb', 'bootloader', 'unlocked'), o('prop', 'props', 'locked')]).spoofed, true)
eq('bootloader vs kernel disagree -> unclear', reconcile([o('fb', 'bootloader', 'unlocked'), o('k', 'kernel', 'locked')]).value, 'unclear')
eq('kernel only', reconcile([o('k', 'kernel', 'unlocked')]).value, 'unlocked')
eq('props only', reconcile([o('p', 'props', 'locked')]).value, 'locked')
eq('props disagree -> unclear', reconcile([o('p1', 'props', 'locked'), o('p2', 'props', 'unlocked')]).value, 'unclear')
eq('nothing -> unknown', reconcile([o('p', 'props', null)]).value, 'unknown')
eq('describe spoofed', describeUnlock({ value: 'unlocked', spoofed: true }), 'unlocked (props disagree)')
eq('describe unknown', describeUnlock({ value: 'unknown', spoofed: false }), '—')

// this phone in fastboot: `securestate: flashing_unlocked`, no `unlocked` var, `secure: yes`
eq(
	'fastboot real device',
	describeUnlock(reconcile([{ name: 'getvar securestate', layer: 'bootloader', value: parseLockWord('flashing_unlocked') }])),
	'unlocked',
)

// ---- adb path, with the values read off the real device ------------------------------
function fakeAdb(props, bootconfig = '') {
	return {
		getProp: async (key) => props[key] ?? null,
		createSocket: async (service) => ({
			readable: new ReadableStream({
				start(controller) {
					controller.enqueue(new TextEncoder().encode(service.endsWith('/proc/bootconfig') ? bootconfig : ''))
					controller.close()
				},
			}),
			writable: { getWriter: () => ({ write: async () => {}, releaseLock: () => {} }) },
			close: async () => {},
		}),
	}
}

const realDevice = await adbUnlock(
	fakeAdb(
		{
			'ro.boot.verifiedbootstate': 'green',
			'ro.boot.flash.locked': '1',
			'ro.boot.vbmeta.device_state': 'locked',
			'ro.secureboot.lockstate': 'locked',
		},
		'androidboot.verifiedbootstate = "orange"\nandroidboot.secure_hardware = "1"',
	),
)
eq('real device value', realDevice.value, 'unlocked')
eq('real device spoofed', realDevice.spoofed, true)

const honestLocked = await adbUnlock(
	fakeAdb({ 'ro.boot.verifiedbootstate': 'green', 'ro.boot.flash.locked': '1' }, 'androidboot.verifiedbootstate = "green"\nandroidboot.flash.locked = "1"'),
)
eq('honest locked', honestLocked.value, 'locked')
eq('honest locked not spoofed', honestLocked.spoofed, false)

const noKernel = await adbUnlock(fakeAdb({ 'ro.boot.verifiedbootstate': 'orange' }, ''))
eq('no kernel layer -> props', noKernel.value, 'unlocked')

const nothing = await adbUnlock(fakeAdb({}, ''))
eq('nothing readable', nothing.value, 'unknown')

// ---- add-on detection, over the same fake shell ---------------------------------------
const packages = (text) => ({
	getProp: async () => null,
	createSocket: async () => ({
		readable: new ReadableStream({
			start(controller) {
				controller.enqueue(new TextEncoder().encode(text))
				controller.close()
			},
		}),
		writable: { getWriter: () => ({ write: async () => {}, releaseLock: () => {} }) },
		close: async () => {},
	}),
})
const ids = ['com.google.android.gms', 'com.android.vending']
eq('gms present', (await detectPackages(packages('package:com.android.vending\npackage:com.google.android.gms\n'), ids)).state, 'present')
eq('nothing installed', (await detectPackages(packages('package:org.fdroid.fdroid\n'), ids)).state, 'absent')
eq('substring is not a match', (await detectPackages(packages('package:com.google.android.gms.foo\n'), ids)).state, 'absent')

done()
