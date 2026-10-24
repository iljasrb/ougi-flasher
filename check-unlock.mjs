// Self-check for device text: lock words, getvar parsing, add-on detection. No device, no network.
//
//   node check-unlock.mjs
import { detectPackages } from './lib/adb.mjs'
import { lockState, sanitizeVar } from './lib/usb.mjs'
import { done, eq } from './check.mjs'

// ---- lock words, from fastboot (securestate/unlocked) and Android (verifiedbootstate) ----
// verified boot words, securestate words and 0/1 flags in one table; the rest stays unknown
const states = {
	green: 'locked', yellow: 'locked', orange: 'unlocked', red: 'unlocked', purple: '—',
	1: 'locked', 0: 'unlocked', 3: '—', yes: 'unlocked', no: 'locked', 2: '—',
	flashing_unlocked: 'unlocked', oem_locked: 'locked', flashing_locked: 'locked',
	SECURE_PROD_MODE: '—', '"unlocked"': 'unlocked',
}
for (const [word, want] of Object.entries(states)) eq(word, lockState(word), want)
eq('null', lockState(null), '—')

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

// ---- add-on detection, over a fake shell -----------------------------------------------
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
