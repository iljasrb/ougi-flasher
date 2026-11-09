// Write a whole recovery image. Shared by the Flash page and the Tools page so both use the same
// slot rules: a bootloader that says `has-slot:recovery` is written to both slots, anything else is
// written once as a plain `recovery`.
import { sanitizeVar } from './usb.mjs'

export async function flashRecoveryImage(dev, blob, { onProgress = () => {} } = {}) {
	const rawSlot = await dev.getVariable('has-slot:recovery').catch(() => null)
	const hasSlot = sanitizeVar('has-slot:recovery', rawSlot)
	const slots = hasSlot === 'yes' ? ['a', 'b'] : ['current']
	for (const [index, slot] of slots.entries()) {
		await dev.flashBlob('recovery', slot, blob, (p) => onProgress(slot, (index + p) / slots.length, p))
	}
	return slots
}
