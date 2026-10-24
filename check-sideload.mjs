// Checks the sideload reader without a phone: the device is a scripted ReadableStream.
//
//   node check-sideload.mjs
import { sideload } from './lib/adb.mjs'
import { waitForSideload } from './lib/recovery.mjs'
import { check, done } from './check.mjs'

const enc = new TextEncoder()

// A device that says the given chunks, then closes the socket.
function fakeAdb(script) {
	return {
		createSocket: async () => ({
			readable: new ReadableStream({
				pull(controller) {
					const next = script.shift()
					if (next === undefined) return controller.close()
					controller.enqueue(enc.encode(next))
				},
			}),
			writable: new WritableStream(),
			close: async () => {},
		}),
	}
}

const blob = new Blob([new Uint8Array(65536 * 3)])
const blocks = ['0', '1', '2']

// Recovery rebooting under the transfer closes the socket before any block is requested; that must
// be an error so sideloadWithWait() retries instead of reporting "0 bytes, done".
try {
	await sideload(fakeAdb([]), blob)
	check('closed socket without a request throws', false)
} catch (err) {
	check('closed socket without a request throws', /closed the sideload socket after 0 of 196608/.test(err.message), err.message)
}

// A half transfer has to fail too.
try {
	await sideload(fakeAdb(['0']), blob)
	check('closed socket mid-transfer throws', false)
} catch (err) {
	check('closed socket mid-transfer throws', /after 65536 of 196608/.test(err.message), err.message)
}

const full = await sideload(fakeAdb([...blocks, 'DONEDONE']), blob)
check('blocks + DONEDONE is a confirmed transfer', full.sent === blob.size && full.confirmed, JSON.stringify(full))

const quiet = await sideload(fakeAdb([...blocks]), blob, () => {}, { idleMs: 200 })
check('silence after the last block counts as done', quiet.sent === blob.size && !quiet.confirmed, JSON.stringify(quiet))

const rejected = await sideload(fakeAdb(['FAILFAIL']), blob).catch((err) => err.message)
check('FAILFAIL is reported', /recovery rejected the package/.test(rejected), String(rejected))

// ---- waitForSideload: do not re-ask a phone that is waiting for authorisation -------------
// Every ask can raise an "Allow USB debugging" dialog; asking once per second stacked tens of them.
const phone = { raw: {}, name: 'phone' }
let asks = 0
await waitForSideload(3, {
	interval: 0,
	list: async () => [phone],
	connect: async () => {
		asks += 1
		return { state: 'unauthorized', adb: { close: async () => {} } }
	},
}).catch(() => {})
check('an unauthorised device is asked once', asks === 1, `${asks} asks`)

// a device handed over by the grant button is also in getDevices(): still one ask, not two
let duplicateAsks = 0
const picked = { raw: {}, name: 'recovery' }
await waitForSideload(1, {
	interval: 0,
	extra: () => picked,
	list: async () => [picked],
	connect: async () => {
		duplicateAsks += 1
		return { state: 'unauthorized', adb: { close: async () => {} } }
	},
}).catch(() => {})
check('a pending device is asked once', duplicateAsks === 1, `${duplicateAsks} asks`)

// a device that drops back to unauthorised is not asked again in the same wait
const flap = ['device', 'unauthorized', 'device', 'sideload']
let flapped = 0
await waitForSideload(4, {
	interval: 0,
	list: async () => [phone],
	connect: async () => {
		flapped += 1
		return { state: flap.shift(), adb: { close: async () => {} } }
	},
}).catch(() => {})
check('a device that loses authorisation is not re-asked', flapped === 2, `${flapped} asks`)

// an already-authorised device is retried until recovery reaches sideload mode
const states = ['device', 'device', 'sideload']
const connected = await waitForSideload(5, {
	interval: 0,
	list: async () => [phone],
	connect: async () => ({ state: states.shift(), adb: { close: async () => {} } }),
})
check('an authorised device is retried until sideload', connected.state === 'sideload', connected.state)

done()
