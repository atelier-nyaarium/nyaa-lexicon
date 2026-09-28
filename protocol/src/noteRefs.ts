// The `ref://` links a knowledge note carries: found in its markdown, parsed into a module and a
// name chain. A ref is a link written as `[label](ref://...)`; a bare `ref://` in prose is text.
// Code spans and fences hold literal text, except a mermaid block's `click` line.

////////////////////////////////
//  Interfaces & Types

/** One `ref://` as written, and where it starts in the text. */
export interface FoundRef {
	ref: string;
	index: number;
}

/** A written link: its opening `[` through its closing `)`. */
export interface RefLink extends FoundRef {
	from: number;
	to: number;
	label: string;
}

/** A module path and the chain inside it; no chain names the module itself. */
export interface ParsedRef {
	module: string;
	segments: string[];
}

export type RefParse = { ok: true; ref: ParsedRef } | { ok: false; problem: string };

////////////////////////////////
//  Constants

export const REF_SCHEME = "ref://";

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)/;

/** `](ref://...)`, `](<ref://...>)`, with an optional title. */
const LINK_DESTINATION = /\]\(\s*(<ref:\/\/[^>\n]*>|ref:\/\/[^\s)]+)(?:\s+"[^"\n]*")?\s*\)/g;

/** A mermaid `click` line: `click id "ref://..."` or `click id href "ref://..."`. */
const MERMAID_CLICK = /^\s*click\s+\S+\s+(?:href\s+)?"(ref:\/\/[^"]+)"/;

/** A code span may wrap lines but never crosses a blank one, LF or CRLF. */
const CODE_SPAN = /(`+)((?:(?!\n[ \t\r]*\n)[\s\S])*?[^`])\1(?!`)/g;

////////////////////////////////
//  Functions & Helpers

/** Whether an odd run of backslashes escapes the character at `at`. */
function escapedAt(text: string, at: number): boolean {
	let slashes = 0;
	for (let i = at - 1; i >= 0 && text[i] === "\\"; i--) slashes++;
	return slashes % 2 === 1;
}

/** The unescaped `[` opening the label that the `]` at `close` ends, or -1. */
function labelStart(text: string, close: number): number {
	if (escapedAt(text, close)) return -1;
	let depth = 0;
	for (let i = close - 1; i >= 0 && text[i] !== "\n"; i--) {
		if (escapedAt(text, i)) continue;
		if (text[i] === "]") depth++;
		else if (text[i] === "[") {
			if (depth === 0) return i;
			depth--;
		}
	}
	return -1;
}

/** Written links and mermaid clicks outside code. */
function scan(text: string): { links: RefLink[]; clicks: FoundRef[] } {
	const links: RefLink[] = [];
	const clicks: FoundRef[] = [];
	const shown: string[] = [];
	let fence: { marker: string; mermaid: boolean } | null = null;
	let offset = 0;
	for (const line of text.split("\n")) {
		const opened = FENCE.exec(line);
		let hidden = true;
		if (fence !== null) {
			const closes =
				opened !== null &&
				opened[1] !== undefined &&
				opened[1][0] === fence.marker[0] &&
				opened[1].length >= fence.marker.length &&
				line.trim() === opened[1];
			if (closes) fence = null;
			else if (fence.mermaid) {
				const click = MERMAID_CLICK.exec(line);
				if (click?.[1] !== undefined) clicks.push({ ref: click[1], index: offset + line.indexOf(click[1]) });
			}
		} else if (opened?.[1] !== undefined) {
			fence = { marker: opened[1], mermaid: (opened[2] ?? "").toLowerCase() === "mermaid" };
		} else hidden = false;
		shown.push(hidden ? " ".repeat(line.length) : line);
		offset += line.length + 1;
	}

	// Fences and code spans blank to spaces, so every index still reads the text.
	const plain = shown.join("\n").replace(CODE_SPAN, (span) => span.replace(/[^\n]/g, " "));
	for (const match of plain.matchAll(LINK_DESTINATION)) {
		const at = match.index ?? 0;
		const from = labelStart(plain, at);
		if (from < 0) continue;
		const raw = match[1] ?? "";
		const angled = raw.startsWith("<");
		links.push({
			ref: angled ? raw.slice(1, -1) : raw,
			index: at + match[0].indexOf(raw) + (angled ? 1 : 0),
			from,
			to: at + match[0].length,
			label: text.slice(from + 1, at),
		});
	}
	return { links, clicks };
}

/** Every `ref://` link in markdown, in order, outside code; `index` is where the ref itself starts. */
export function findRefs(text: string): FoundRef[] {
	const { links, clicks } = scan(text);
	return [...links.map(({ ref, index }) => ({ ref, index })), ...clicks].sort((a, b) => a.index - b.index);
}

/** Each written `[label](ref://...)` outside code, in order, with the span it covers. */
export function findRefLinks(text: string): RefLink[] {
	return scan(text).links;
}

/** Splits on single colons; `::` stays inside a segment as a qualifier. */
function splitChain(text: string): string[] {
	const parts: string[] = [];
	let current = "";
	for (let i = 0; i < text.length; i++) {
		const char = text[i];
		if (char === ":" && text[i + 1] === ":") {
			current += "::";
			i++;
		} else if (char === ":") {
			parts.push(current);
			current = "";
		} else current += char;
	}
	parts.push(current);
	return parts;
}

function isAbsolute(path: string): boolean {
	return path.startsWith("/") || path.startsWith("~") || /^[A-Za-z]:[\\/]/.test(path);
}

/** `ref://<module>[:<segment>...]`, workspace-relative. Split first, then each part decoded. */
export function parseRef(ref: string): RefParse {
	if (!ref.startsWith(REF_SCHEME)) return { ok: false, problem: "a ref starts with ref://" };
	const body = ref.slice(REF_SCHEME.length);
	if (body.includes("#") || body.includes("@after:") || body.includes("@before:")) {
		return { ok: false, problem: "a note's ref names a symbol or a file; text anchors are not used" };
	}
	let parts: string[];
	try {
		parts = splitChain(body).map((part) => decodeURIComponent(part));
	} catch {
		return { ok: false, problem: "a percent escape in the ref does not decode" };
	}
	const [module = "", ...segments] = parts;
	if (isAbsolute(body) || isAbsolute(module)) return { ok: false, problem: "a note's ref is workspace-relative" };
	if (module === "") return { ok: false, problem: "the ref names no module" };
	if (segments.some((segment) => segment === "")) return { ok: false, problem: "the ref has an empty segment" };
	return { ok: true, ref: { module, segments } };
}

/** The ref text for a module and chain, escaping what would end the link or split the path. */
export function formatRef(module: string, segments: readonly string[]): string {
	const escaped = (part: string) =>
		part.replace(/%/g, "%25").replace(/ /g, "%20").replace(/\(/g, "%28").replace(/\)/g, "%29").replace(/#/g, "%23");
	return `${REF_SCHEME}${[escaped(module).replace(/:/g, "%3A"), ...segments.map(escaped)].join(":")}`;
}
