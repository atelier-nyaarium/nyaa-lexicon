// The one place a recursion limit is recognized, for every reader that recurses.

/** What a reader says when a structure outruns the stack. */
export const TOO_DEEP = "nested too deeply to index";

/** What a stack exhaustion says, wherever it is met: thrown at us, or already caught by a library. */
export function saysTooDeep(message: string): boolean {
	return /call stack/i.test(message);
}

/** Deeper than any data file; far shallower than what exhausts a stack. */
export const MAX_NESTING = 1_000;

/** Comment syntax, as data, so a bracket in prose does not count. */
export interface CommentSyntax {
	line: string[];
	block?: [string, string];
}

/** True past `limit` open brackets, strings and comments skipped. Before any parser recurses. */
export function nestedTooDeep(text: string, comments: CommentSyntax, limit = MAX_NESTING): boolean {
	let depth = 0;
	let quote: string | null = null;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i] as string;
		if (quote !== null) {
			// Double quotes escape with a backslash; single quotes by doubling, as YAML reads them.
			if (quote === '"' && ch === "\\") i++;
			else if (ch === quote) {
				if (quote === "'" && text[i + 1] === "'") i++;
				else quote = null;
			}
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			continue;
		}
		if (comments.block !== undefined && text.startsWith(comments.block[0], i)) {
			const end = text.indexOf(comments.block[1], i + comments.block[0].length);
			if (end === -1) return false;
			i = end + comments.block[1].length - 1;
			continue;
		}
		if (comments.line.some((marker) => text.startsWith(marker, i))) {
			const end = text.indexOf("\n", i);
			if (end === -1) return false;
			i = end;
			continue;
		}
		if (ch === "[" || ch === "{") {
			if (++depth > limit) return true;
		} else if ((ch === "]" || ch === "}") && depth > 0) depth--;
	}
	return false;
}

export function markupTooDeep(text: string, limit = MAX_NESTING, rawText: string[] = []): boolean {
	let depth = 0;
	let i = 0;
	const raw = new Set(rawText.map((name) => name.toLowerCase()));
	while (i < text.length) {
		if (text[i] !== "<") {
			i++;
			continue;
		}
		if (text.startsWith("<!--", i)) {
			const end = text.indexOf("-->", i + 4);
			if (end < 0) return false;
			i = end + 3;
			continue;
		}
		if (text.startsWith("<![CDATA[", i)) {
			const end = text.indexOf("]]>", i + 9);
			if (end < 0) return false;
			i = end + 3;
			continue;
		}
		if (text.startsWith("<?", i)) {
			const end = text.indexOf("?>", i + 2);
			if (end < 0) return false;
			i = end + 2;
			continue;
		}
		if (text.startsWith("<!", i)) {
			const end = text.indexOf(">", i + 2);
			if (end < 0) return false;
			i = end + 1;
			continue;
		}
		let cursor = i + 1;
		const closing = text[cursor] === "/";
		if (closing) cursor++;
		while (cursor < text.length && /\s/u.test(text[cursor] as string)) cursor++;
		const nameStart = cursor;
		while (cursor < text.length && !/[\s/>]/u.test(text[cursor] as string)) cursor++;
		const name = text.slice(nameStart, cursor).toLowerCase();
		let quote: string | null = null;
		while (cursor < text.length) {
			const ch = text[cursor] as string;
			if (quote !== null) {
				if (ch === quote) quote = null;
				cursor++;
				continue;
			}
			if (ch === "'" || ch === '"') {
				quote = ch;
				cursor++;
				continue;
			}
			if (ch === ">") break;
			cursor++;
		}
		if (cursor >= text.length) return false;
		const selfClosing = !closing && /\/\s*$/u.test(text.slice(i, cursor));
		if (closing) depth = Math.max(0, depth - 1);
		else if (!selfClosing) {
			if (depth++ >= limit) return true;
			if (raw.has(name)) {
				let at = cursor + 1;
				while (at < text.length) {
					const mark = text.indexOf("<", at);
					if (mark < 0) break;
					let close = mark + 1;
					if (text[close] !== "/") {
						at = mark + 1;
						continue;
					}
					close++;
					while (close < text.length && /\s/u.test(text[close] as string)) close++;
					if (text.slice(close, close + name.length).toLowerCase() !== name) {
						at = mark + 1;
						continue;
					}
					close += name.length;
					while (close < text.length && /\s/u.test(text[close] as string)) close++;
					if (text[close] === ">") {
						i = close + 1;
						depth--;
						break;
					}
					at = mark + 1;
				}
				if (i !== cursor + 1) continue;
			}
		}
		i = cursor + 1;
	}
	return false;
}

/**
 * A stack exhaustion, and never another `RangeError`.
 *
 * Catching the type alone would report an out-of-range array length or a bad `toFixed` as a depth
 * problem, which is a real bug wearing a diagnostic that sends the reader somewhere else.
 */
export function isTooDeep(failure: unknown): boolean {
	return failure instanceof RangeError && saysTooDeep(failure.message);
}
