import { readEntry, sha256, zipIndex } from '../zip.mjs'

// Same origin: the URL is used as-is. Any other origin goes through the dev server's /pkg/ proxy,
// because the mirror sends no CORS headers and a cross-origin 2 GB fetch just fails.
export function packageUrl(url, origin = globalThis.location?.origin ?? '') {
	const absolute = new URL(url, origin)
	if (absolute.origin === origin) return absolute.href
	return `/pkg${absolute.pathname}${absolute.search}`
}

export async function download(url, onProgress = () => {}) {
	const target = packageUrl(url)
	const res = await fetch(target)
	if (!res.ok) throw new Error(`HTTP ${res.status} for ${target}`)
	const total = Number(res.headers.get('content-length')) || 0
	const reader = res.body.getReader()
	const chunks = []
	let got = 0
	for (;;) {
		const { done, value } = await reader.read()
		if (done) break
		chunks.push(value)
		got += value.length
		if (total) onProgress(got / total)
	}
	if (total && got !== total) throw new Error(`truncated download: ${got} of ${total} bytes`)
	return new Blob(chunks)
}

export async function fetchPackage(entry, onProgress) {
	const blob = await download(entry.url, onProgress)
	if (!entry.sha256) throw new Error(`no sha256 in flasher.json for ${entry.url} — refusing to flash it`)
	const digest = await sha256(blob)
	if (digest !== entry.sha256) throw new Error(`checksum mismatch: ${digest}`)
	return blob
}

// Exactly the partitions flasher.json lists, out of the build's additional_images zip. A missing
// entry is an error before anything is wiped, not a half-flashed boot chain.
// Copy a Blob to the device over adb sync (handing the OTA zip to the ROM's Updater app).
export async function pushBlob(adb, blob, remotePath, onProgress = () => {}) {
	const sync = await adb.sync()
	let sent = 0
	const file = blob.stream().pipeThrough(
		new TransformStream({
			transform(chunk, controller) {
				sent += chunk.byteLength
				onProgress(sent / blob.size)
				controller.enqueue(chunk)
			},
		}),
	)
	try {
		await sync.write({ filename: remotePath, file, permission: 0o644, mtime: Math.floor(Date.now() / 1000) })
	} finally {
		await (sync.close?.() ?? sync.dispose?.() ?? Promise.resolve())
	}
}

export async function readImages(blob, partitions, onProgress = () => {}) {
	const entries = await zipIndex(blob)
	const images = []
	for (const partition of partitions) {
		const entry = entries.get(`${partition}.img`)
		if (!entry) throw new Error(`the images zip has no ${partition}.img`)
		onProgress(partition)
		images.push({ partition, data: await readEntry(blob, entry) })
	}
	return images
}

// Flashed to the inactive slot — the same slot the OTA payload will be applied to — except the
// partitions the config marks as `slotless` (a plain `recovery` on an A/B device takes no suffix).
export async function flashImages(dev, images, { slot = 'other', slotless = [], onProgress = () => {} } = {}) {
	let index = 0
	for (const { partition, data } of images) {
		const target = slotless.includes(partition) ? 'current' : slot
		onProgress(partition, index / images.length, 0)
		await dev.flashBlob(partition, target, data, (p) => onProgress(partition, (index + p) / images.length, p))
		index += 1
	}
}
