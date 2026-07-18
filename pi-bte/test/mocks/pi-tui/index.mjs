/** Minimal test double for @earendil-works/pi-tui */

export class Text {
	constructor(text, _a = 0, _b = 0) {
		this.text = text;
	}
	toString() {
		return String(this.text);
	}
}
