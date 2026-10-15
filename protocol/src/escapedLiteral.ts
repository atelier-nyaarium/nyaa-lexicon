export type EscapedLiteralDialect = "c" | "cpp";

const SIMPLE_ESCAPES: Readonly<Record<string, string>> = {
	a: "\x07",
	b: "\b",
	f: "\f",
	n: "\n",
	r: "\r",
	t: "\t",
	v: "\v",
	"\\": "\\",
	'"': '"',
	"'": "'",
	"?": "?",
};

function isHexDigit(character: string): boolean {
	return /^[0-9A-Fa-f]$/.test(character);
}

function isOctalDigit(character: string): boolean {
	return /^[0-7]$/.test(character);
}

function codePoint(value: number, spelling: string): string {
	return Number.isInteger(value) && value >= 0 && value <= 0x10ffff ? String.fromCodePoint(value) : spelling;
}

export function decodeEscapedLiteral(value: string, dialect: EscapedLiteralDialect): string {
	let decoded = "";
	for (let index = 0; index < value.length; index++) {
		const character = value[index] as string;
		if (character !== "\\") {
			decoded += character;
			continue;
		}
		const escaped = value[index + 1];
		if (escaped === undefined) break;
		if (escaped === "e" && dialect === "c") {
			decoded += "\x1b";
			index++;
			continue;
		}
		const simple = SIMPLE_ESCAPES[escaped];
		if (simple !== undefined) {
			decoded += simple;
			index++;
			continue;
		}
		if (escaped === "x") {
			let end = index + 2;
			while (end < value.length && isHexDigit(value[end] as string)) end++;
			const spelling = value.slice(index, end);
			decoded +=
				end === index + 2 ? spelling : codePoint(Number.parseInt(value.slice(index + 2, end), 16), spelling);
			index = end - 1;
			continue;
		}
		if (escaped === "u" || escaped === "U") {
			const width = escaped === "u" ? 4 : 8;
			let end = index + 2;
			while (end < value.length && end < index + 2 + width && isHexDigit(value[end] as string)) end++;
			const spelling = value.slice(index, end);
			const digits = value.slice(index + 2, end);
			decoded += digits.length === width ? codePoint(Number.parseInt(digits, 16), spelling) : spelling;
			index = end - 1;
			continue;
		}
		if (isOctalDigit(escaped)) {
			let end = index + 2;
			while (end < value.length && end < index + 4 && isOctalDigit(value[end] as string)) end++;
			const spelling = value.slice(index, end);
			decoded += codePoint(Number.parseInt(value.slice(index + 1, end), 8), spelling);
			index = end - 1;
			continue;
		}
		decoded += `\\${escaped}`;
		index++;
	}
	return decoded;
}
