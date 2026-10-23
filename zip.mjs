// Minimal zip reader (browser): central directory only, stored + deflate entries.
// Images are a few hundred MB, so entries stay Blobs and are never fully buffered.

export async function sha256(blob) {
	const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export async function zipIndex(blob) {
	const buf = await blob.arrayBuffer()
	const dv = new DataView(buf)
	let eocd = -1
	for (let i = buf.byteLength - 22, stop = Math.max(0, buf.byteLength - 66000); i >= stop; i--) {
		if (dv.getUint32(i, true) === 0x06054b50) {
			eocd = i
			break
		}
	}
	if (eocd < 0) throw new Error('not a zip file')
	const count = dv.getUint16(eocd + 10, true)
	let p = dv.getUint32(eocd + 16, true)
	const entries = new Map()
	for (let n = 0; n < count; n++) {
		if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('corrupt zip central directory')
		const method = dv.getUint16(p + 10, true)
		const csize = dv.getUint32(p + 20, true)
		const usize = dv.getUint32(p + 24, true)
		const nameLen = dv.getUint16(p + 28, true)
		const extraLen = dv.getUint16(p + 30, true)
		const commentLen = dv.getUint16(p + 32, true)
		const local = dv.getUint32(p + 42, true)
		const name = new TextDecoder().decode(new Uint8Array(buf, p + 46, nameLen))
		if (csize === 0xffffffff || usize === 0xffffffff) throw new Error('zip64 archives are not supported')
		const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true)
		entries.set(name, { method, start, size: csize, usize })
		p += 46 + nameLen + extraLen + commentLen
	}
	return entries
}

export async function readEntry(blob, entry) {
	const raw = blob.slice(entry.start, entry.start + entry.size)
	if (entry.method === 0) return raw
	if (entry.method !== 8) throw new Error(`unsupported zip compression method ${entry.method}`)
	return new Response(raw.stream().pipeThrough(new DecompressionStream('deflate-raw'))).blob()
}
