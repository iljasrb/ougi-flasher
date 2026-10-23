// Tiny terminal: output pane + prompt line with history. No dependencies, no ANSI parsing.
export class Terminal {
	constructor({ output, input, prompt = '$', onCommand = () => {}, onBusy = () => {} }) {
		this.output = output
		this.input = input
		this.prompt = prompt
		this.onCommand = onCommand
		this.onBusy = onBusy
		this.history = []
		this.cursor = 0
		this.busy = false

		input.addEventListener('keydown', (event) => this.#key(event))
	}

	#key(event) {
		if (event.key === 'Enter') {
			const text = this.input.value.trim()
			this.input.value = ''
			if (!text) return
			if (text === 'clear' || text === 'cls') return this.clear()
			this.history.push(text)
			this.cursor = this.history.length
			this.write(`${this.prompt} ${text}\n`)
			this.run(text)
			return
		}
		if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
			event.preventDefault()
			if (!this.history.length) return
			if (event.key === 'ArrowUp') this.cursor = Math.max(0, this.cursor - 1)
			else this.cursor = Math.min(this.history.length, this.cursor + 1)
			this.input.value = this.history[this.cursor] ?? ''
			this.input.setSelectionRange(this.input.value.length, this.input.value.length)
			return
		}
		if (event.key === 'l' && event.ctrlKey) {
			event.preventDefault()
			this.clear()
		}
	}

	async run(text) {
		if (this.busy) return
		this.busy = true
		this.onBusy(true)
		const spinner = setInterval(() => this.input.classList.toggle('waiting'), 400)
		try {
			await this.onCommand(text)
		} catch (err) {
			this.write(`${err.bootloaderMessage ?? err.message}\n`)
		} finally {
			clearInterval(spinner)
			this.input.classList.remove('waiting')
			this.busy = false
			this.onBusy(false)
		}
	}

	write(text) {
		if (!text) return
		this.output.textContent += text
		this.output.scrollTop = this.output.scrollHeight
	}

	clear() {
		this.output.textContent = ''
	}

	focus() {
		this.input.focus()
	}
}
