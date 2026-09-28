// C# raw string content: its lines, and the dedent a multi-line raw string takes.

import { isNewline, isWhitespace } from "./characters.js";

////////////////////////////////
//  Interfaces & Types

/** Raw string content: text, or a hole kept as written. */
export interface RawPart {
	text: string;
	hole: boolean;
}

interface RawLine {
	parts: RawPart[];
	lineBreak: string;
}

////////////////////////////////
//  Functions & Helpers

export function joined(parts: readonly RawPart[]): string {
	return parts.map((part) => part.text).join("");
}

/** Raw string content by line; a hole never breaks one. */
function rawLines(parts: readonly RawPart[]): RawLine[] {
	const lines: RawLine[] = [{ parts: [], lineBreak: "" }];
	for (const part of parts) {
		if (part.hole) {
			(lines.at(-1) as RawLine).parts.push(part);
			continue;
		}
		let text = "";
		let carriageReturn = false;
		for (const character of part.text) {
			const line = lines.at(-1) as RawLine;
			if (character === "\n" && carriageReturn) {
				(lines.at(-2) as RawLine).lineBreak = "\r\n";
				carriageReturn = false;
				continue;
			}
			carriageReturn = character === "\r";
			if (!isNewline(character)) {
				text += character;
				continue;
			}
			if (text !== "") line.parts.push({ text, hole: false });
			text = "";
			line.lineBreak = character;
			lines.push({ parts: [], lineBreak: "" });
		}
		if (text !== "") (lines.at(-1) as RawLine).parts.push({ text, hole: false });
	}
	return lines;
}

/** A multi-line raw string: its first and last lines go, and the last line's indentation leaves every line. */
export function dedented(parts: readonly RawPart[]): string {
	const lines = rawLines(parts);
	const closing = lines.at(-1) as RawLine;
	const indentation = joined(closing.parts);
	if (lines.length < 2 || closing.parts.some((part) => part.hole) || ![...indentation].every(isWhitespace))
		return joined(parts);
	const content = lines.slice(1, -1);
	return content
		.map((line, index) => {
			const blank = line.parts.every((part) => !part.hole && [...part.text].every(isWhitespace));
			const [first, ...rest] = line.parts;
			const kept =
				blank || first === undefined
					? ""
					: !first.hole && first.text.startsWith(indentation)
						? joined([{ text: first.text.slice(indentation.length), hole: false }, ...rest])
						: joined(line.parts);
			return index < content.length - 1 ? kept + line.lineBreak : kept;
		})
		.join("");
}
