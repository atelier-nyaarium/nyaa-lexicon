// The `project-ref://` links a knowledge note carries.
// Code spans and fences hold literal text, except a mermaid block's `click` line.

import { parse, postprocess, preprocess } from "micromark";
import { mermaidClick, mermaidStatements } from "./mermaid.js";
import { ModulePathSchema } from "./modulePath.js";

////////////////////////////////
//  Interfaces & Types

/** One `project-ref://` as written, and where it starts in the text. */
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
	project: string;
	module: string;
	segments: string[];
}

export type RefParse = { ok: true; ref: ParsedRef } | { ok: false; problem: string };

/** A code fence: its info word and the span it covers, fences included. */
export interface CodeFence {
	info: string;
	from: number;
	to: number;
}

/** One token micromark read, by offset. */
interface Token {
	type: string;
	from: number;
	to: number;
}

////////////////////////////////
//  Constants

export const REF_SCHEME = "project-ref://";

export function validProjectId(project: string): boolean {
	return /^[A-Za-z0-9._-]+$/.test(project) && project !== "." && project !== "..";
}

/** What micromark reads as code: its text is literal. */
const CODE = new Set(["codeFenced", "codeIndented", "codeText"]);

////////////////////////////////
//  Functions & Helpers

/** Every token micromark reads in the text, in document order, parents before children. */
function tokensOf(text: string): Token[] {
	const chunks = preprocess()(text, undefined, true);
	const events = postprocess(parse().document().write(chunks));
	return events.flatMap(([kind, token]) =>
		kind === "enter" ? [{ type: token.type, from: token.start.offset, to: token.end.offset }] : [],
	);
}

/** Each code fence with its info word and the line values inside it. */
function fencesOf(text: string, tokens: readonly Token[]): Array<CodeFence & { values: Token[] }> {
	const fences: Array<CodeFence & { values: Token[] }> = [];
	let open: (CodeFence & { values: Token[] }) | null = null;
	for (const token of tokens) {
		if (open !== null && token.from >= open.to) open = null;
		if (token.type === "codeFenced") {
			open = { info: "", from: token.from, to: token.to, values: [] };
			fences.push(open);
		} else if (open?.info === "" && token.type === "codeFencedFenceInfo") {
			open.info = text.slice(token.from, token.to);
		} else if (open !== null && token.type === "codeFlowValue") open.values.push(token);
	}
	return fences;
}

/** Each code fence: its info word and the span it covers, fences included. */
export function codeFences(text: string): CodeFence[] {
	return fencesOf(text, tokensOf(text)).map(({ info, from, to }) => ({ info, from, to }));
}

/** Code blanked to spaces, newlines kept, so every index still reads the text. */
export function blankCode(text: string): string {
	let out = "";
	let kept = 0;
	for (const token of tokensOf(text)) {
		if (!CODE.has(token.type) || token.from < kept) continue;
		out += text.slice(kept, token.from) + text.slice(token.from, token.to).replace(/[^\n]/g, " ");
		kept = token.to;
	}
	return out + text.slice(kept);
}

/** Each written link to a ref, from its label and destination tokens. */
function linksOf(text: string, tokens: readonly Token[], legacy = false): RefLink[] {
	const links: RefLink[] = [];
	let link: { token: Token; label?: Token; destination?: Token } | null = null;
	const finish = (done: { token: Token; label?: Token; destination?: Token }) => {
		const { token, label, destination } = done;
		const ref = destination === undefined ? "" : text.slice(destination.from, destination.to);
		if (destination === undefined || !(ref.startsWith(REF_SCHEME) || (legacy && ref.startsWith("ref://")))) return;
		const written = label === undefined ? "" : text.slice(label.from, label.to);
		links.push({ ref, index: destination.from, from: token.from, to: token.to, label: written });
	};
	for (const token of tokens) {
		if (link !== null && token.from >= link.token.to) {
			finish(link);
			link = null;
		}
		if (token.type === "link") link = { token };
		else if (link === null) continue;
		else if (token.type === "labelText" && link.label === undefined) link.label = token;
		// After the label, so an image inside it cannot lend its destination.
		else if (token.type === "resourceDestinationString" && token.from >= (link.label?.to ?? link.token.from)) {
			link.destination ??= token;
		}
	}
	if (link !== null) finish(link);
	return links;
}

/** Each mermaid `click` whose target is a ref, pointing at the ref itself. */
function clicksOf(text: string, tokens: readonly Token[], legacy = false): FoundRef[] {
	return fencesOf(text, tokens).flatMap((fence) => {
		if (fence.info.toLowerCase() !== "mermaid") return [];
		const lines = fence.values.map((token) => ({ text: text.slice(token.from, token.to), from: token.from }));
		return mermaidStatements(lines).flatMap((statement) => {
			const target = mermaidClick(statement)?.target;
			return target?.text.startsWith(REF_SCHEME) || (legacy && target?.text.startsWith("ref://"))
				? [{ ref: target.text, index: target.from + 1 }]
				: [];
		});
	});
}

/** Every project ref in markdown, in order, outside code. */
export function findRefs(text: string, options: { legacy?: boolean } = {}): FoundRef[] {
	const tokens = tokensOf(text);
	const links = linksOf(text, tokens, options.legacy).map(({ ref, index }) => ({ ref, index }));
	return [...links, ...clicksOf(text, tokens, options.legacy)].sort((a, b) => a.index - b.index);
}

/** Each written project ref link outside code, with the span it covers. */
export function findRefLinks(text: string, options: { legacy?: boolean } = {}): RefLink[] {
	return linksOf(text, tokensOf(text), options.legacy);
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

/** `project-ref://<project>/<module>[:<segment>...]`. */
export function parseRef(ref: string): RefParse {
	if (!ref.startsWith(REF_SCHEME)) return { ok: false, problem: "a ref starts with project-ref://" };
	const body = ref.slice(REF_SCHEME.length);
	if (body.includes("#") || body.includes("@after:") || body.includes("@before:")) {
		return { ok: false, problem: "a note's ref names a symbol or a file; text anchors are not used" };
	}
	const slash = body.indexOf("/");
	const project = slash < 0 ? "" : body.slice(0, slash);
	if (!validProjectId(project)) return { ok: false, problem: "the ref has an invalid project id" };
	const path = body.slice(slash + 1);
	let parts: string[];
	try {
		parts = splitChain(path).map((part) => decodeURIComponent(part));
	} catch {
		return { ok: false, problem: "a percent escape in the ref does not decode" };
	}
	const [module = "", ...segments] = parts;
	if (isAbsolute(path) || isAbsolute(module)) return { ok: false, problem: "a note's ref is workspace-relative" };
	if (module.includes(REF_SCHEME)) return { ok: false, problem: "a ref cannot contain another ref" };
	if (module === "") return { ok: false, problem: "the ref names no module" };
	if (!ModulePathSchema.safeParse(module).success)
		return { ok: false, problem: "the ref has an invalid module path" };
	if (segments.some((segment) => segment === "")) return { ok: false, problem: "the ref has an empty segment" };
	return { ok: true, ref: { project, module, segments } };
}

/** The ref text for a module and chain, escaping what would end the link or split the path. */
export function formatRef(project: string, module: string, segments: readonly string[]): string {
	if (!validProjectId(project)) throw new Error("invalid project id");
	const escaped = (part: string, path = false, qualifiers = false) =>
		(qualifiers ? part.split("::") : [part])
			.map((piece) =>
				encodeURIComponent(piece)
					.replace(/:/g, "%3A")
					.replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`),
			)
			.join("::")
			.replace(qualifiers ? /^::/ : /$^/, "%3A%3A")
			.replace(path ? /%2F/gi : /$^/, "/");
	return `${REF_SCHEME}${project}/${[escaped(module, true), ...segments.map((segment) => escaped(segment, false, true))].join(":")}`;
}
