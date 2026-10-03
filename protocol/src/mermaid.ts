// Mermaid source read as statements of words and quoted strings, so a click is found by its tokens.

////////////////////////////////
//  Interfaces & Types

/** One word or quoted string, at its offset in the text it came from. */
export interface MermaidToken {
	kind: "word" | "string";
	/** A string's value, without its quotes. */
	text: string;
	from: number;
	to: number;
}

export interface MermaidStatement {
	tokens: MermaidToken[];
	from: number;
	to: number;
}

/** A run of source and where it starts, such as one line inside a code fence. */
export interface SourceSegment {
	text: string;
	from: number;
}

////////////////////////////////
//  Constants

const SPACE = new Set([" ", "\t", "\r"]);

////////////////////////////////
//  Functions & Helpers

/**
 * Statements end at a segment's end or a `;`, outside a string. A string runs from `"` to the next
 * `"`, across segments. `%%` opening a statement comments out the rest of its segment.
 */
export function mermaidStatements(segments: readonly SourceSegment[]): MermaidStatement[] {
	const statements: MermaidStatement[] = [];
	let tokens: MermaidToken[] = [];
	let string: { from: number; text: string } | null = null;
	const end = () => {
		const first = tokens[0];
		const last = tokens.at(-1);
		if (first !== undefined && last !== undefined) statements.push({ tokens, from: first.from, to: last.to });
		tokens = [];
	};
	for (const { text, from } of segments) {
		let at = 0;
		while (at < text.length) {
			if (string !== null) {
				const close = text.indexOf('"', at);
				if (close === -1) {
					string.text += `${text.slice(at)}\n`;
					at = text.length;
					continue;
				}
				tokens.push({
					kind: "string",
					text: string.text + text.slice(at, close),
					from: string.from,
					to: from + close + 1,
				});
				string = null;
				at = close + 1;
				continue;
			}
			const char = text[at] ?? "";
			if (SPACE.has(char)) at++;
			else if (char === ";") {
				end();
				at++;
			} else if (char === '"') {
				string = { from: from + at, text: "" };
				at++;
			} else if (tokens.length === 0 && text.startsWith("%%", at)) at = text.length;
			else {
				let stop = at;
				while (stop < text.length && !SPACE.has(text[stop] ?? "") && text[stop] !== '"' && text[stop] !== ";")
					stop++;
				tokens.push({ kind: "word", text: text.slice(at, stop), from: from + at, to: from + stop });
				at = stop;
			}
		}
		if (string === null) end();
	}
	end();
	return statements;
}

/** A `click id "target"` or `click id href "target"` statement's id and target. */
export function mermaidClick(statement: MermaidStatement): { id: MermaidToken; target: MermaidToken } | undefined {
	const [click, id, next, after] = statement.tokens;
	const target = next?.kind === "word" && next.text === "href" ? after : next;
	if (click?.kind !== "word" || click.text !== "click" || id?.kind !== "word" || target?.kind !== "string") {
		return undefined;
	}
	return { id, target };
}
