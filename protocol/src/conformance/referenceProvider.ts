// A deliberately minimal provider, shipped with the suite.
//
// It answers the tiers it declares, a minimal move subset, and NotImplemented everywhere else.
// This proves the suite reports a partial provider as partial rather than as broken.
//
// Its toy scanner derives declarations, imports and comments from one token list; strings are not code or comments.

import path from "node:path";
import type { createMessageConnection } from "vscode-jsonrpc/node";
import { coordinatesOf } from "../coordinates.js";
import type { TextEdit } from "../edits.js";
import { unjudgedLoadCycle } from "../loadCycles.js";
import type { MoveEditsRequest, MoveEditsResponse } from "../move.js";
import type { CommentSpan, FileFacts } from "../project.js";
import {
	notImplementedBinding,
	notImplementedImport,
	notImplementedImportEdits,
	notImplementedMove,
	notImplementedType,
	type ProviderHandlers,
	runProviderOnStdio,
	serveProvider,
} from "../serve.js";
import { composeSymbolId } from "../symbolId.js";
import type { Declaration, Range } from "../symbols.js";
import { PROTOCOL_VERSION } from "../version.js";
import { toySpelled as spelled, toyTokens as tokenize, toyStringValue } from "./toyLexer.js";

////////////////////////////////
//  Constants

const LANGUAGE = "reference";

/** Declares only what it actually does. Every other tier answers NotImplemented and is skipped. */
export const REFERENCE_TIERS = {
	projectModel: true,
	declarations: true,
	references: false,
	imports: false,
	binding: false,
	types: false,
	literals: false,
	comments: true,
	docs: false,
	metrics: false,
	syntaxDiagnostics: false,
} as const;

/** The toy grammar's own reserved words, so the suite's own words check has something honest to pass. */
export const REFERENCE_WORDS = {
	keywords: ["class", "const", "export", "function"],
	builtins: [],
	literals: [],
};

const KIND_OF = { class: "class", function: "function", const: "constant" } as const;

////////////////////////////////
//  Functions & Helpers

function offsetAt(text: string, position: Range["start"]): number | undefined {
	return coordinatesOf(text).offsetAt(position);
}

function rangeAt(text: string, start: number, end: number): Range {
	const range = coordinatesOf(text).rangeAt(start, end);
	if (range === undefined) throw new Error(`unaddressable reference-provider range: ${start} to ${end}`);
	return range;
}

/**
 * Comment spans from the lexer, with whether the nearest code token on either side shares its line.
 */
export function extractComments(text: string): CommentSpan[] {
	const coordinates = coordinatesOf(text);
	const lineOf = (offset: number) => coordinates.positionAt(offset)?.line;
	const tokens = tokenize(text);
	const code = (from: number, step: 1 | -1) => {
		for (let at = from + step; at >= 0 && at < tokens.length; at += step) {
			const token = tokens[at] as (typeof tokens)[number];
			if (token.kind !== "comment") return token;
		}
		return undefined;
	};
	return tokens.flatMap((token, at) => {
		if (token.kind !== "comment") return [];
		const before = code(at, -1);
		const after = code(at, 1);
		return [
			{
				range: rangeAt(text, token.start, token.end),
				text: token.text,
				codeBefore: before !== undefined && lineOf(before.end) === lineOf(token.start),
				codeAfter: after !== undefined && lineOf(after.start) === lineOf(token.end),
			},
		];
	});
}

/** Lines no token touches; a final line break does not add an empty line. */
export function blankLinesOf(text: string): number[] {
	const coordinates = coordinatesOf(text);
	const lineOf = (offset: number) => coordinates.positionAt(offset)?.line ?? 0;
	const touched = new Set<number>();
	for (const token of tokenize(text)) {
		for (let line = lineOf(token.start); line <= lineOf(token.end - 1); line++) touched.add(line);
	}
	const count = coordinates.lineCount() - (coordinates.lineText(coordinates.lineCount() - 1) === "" ? 1 : 0);
	return Array.from({ length: count }, (_, line) => line).filter((line) => !touched.has(line));
}

function sameModule(left: string, right: string): boolean {
	return path.posix.normalize(left.replaceAll("\\", "/")) === path.posix.normalize(right.replaceAll("\\", "/"));
}

function relativeSpecifier(fromModule: string, toModule: string): string {
	const target = toModule.endsWith(".ref") ? toModule.slice(0, -4) : toModule;
	const relative = path.posix.relative(path.posix.dirname(fromModule), target);
	return relative.startsWith(".") ? relative : `./${relative}`;
}

function namedImportEdit(request: MoveEditsRequest, index: number): TextEdit | undefined {
	const site = request.importSites[index];
	if (
		site === undefined ||
		site.importKind !== "named" ||
		site.importedName !== request.name ||
		(site.localName !== undefined && site.localName !== request.name)
	) {
		return undefined;
	}

	const nameStart = offsetAt(request.text, site.range.start);
	const nameEnd = offsetAt(request.text, site.range.end);
	if (nameStart === undefined || nameEnd === undefined) return undefined;

	// `import { name } from "specifier";`, alone on its line, the site's range naming the name token.
	const coordinates = coordinatesOf(request.text);
	const lineOf = (offset: number) => coordinates.positionAt(offset)?.line;
	const line = tokenize(request.text).filter((token) => lineOf(token.start) === lineOf(nameStart));
	const [opener, open, name, close, from, specifier, ...rest] = line;
	const shaped =
		spelled(opener, "word", "import") &&
		spelled(open, "punct", "{") &&
		spelled(name, "word", request.name) &&
		spelled(close, "punct", "}") &&
		spelled(from, "word", "from") &&
		spelled(specifier, "string") &&
		(rest.length === 0 || (rest.length === 1 && spelled(rest[0], "punct", ";")));
	if (!shaped || specifier === undefined || name?.start !== nameStart || name.end !== nameEnd) return undefined;
	const quote = specifier.text[0];
	if (quote === "`" || specifier.text.length < 2 || specifier.text.at(-1) !== quote) return undefined;
	if (toyStringValue(specifier) !== site.specifier) return undefined;

	return {
		range: rangeAt(request.text, specifier.start + 1, specifier.end - 1),
		newText: relativeSpecifier(request.module, request.toModule),
	};
}

export function makeReferenceMoveEdits(request: MoveEditsRequest): MoveEditsResponse {
	if (
		request.exists &&
		sameModule(request.module, request.toModule) &&
		extractDeclarations(request.module, request.text).some((declaration) => declaration.name === request.name)
	) {
		return { status: "refused", reason: "TargetCollision" };
	}

	if (
		request.role.removal !== undefined ||
		request.role.insertion !== undefined ||
		request.dependencies.length > 0 ||
		request.sites.length > 0 ||
		request.importSites.length === 0
	) {
		return notImplementedMove("the reference provider only repoints named imports");
	}

	const edits = request.importSites.map((_, index) => namedImportEdit(request, index));
	if (edits.some((edit) => edit === undefined)) {
		return notImplementedMove("the reference provider only repoints simple named imports");
	}
	return { status: "ready", edits: edits.filter((edit) => edit !== undefined), blocked: [] };
}

/** Line-opening declarations: `export class Foo`, `export function foo`, or `export const foo`. */
export function extractDeclarations(module: string, text: string): Declaration[] {
	const out: Declaration[] = [];
	const coordinates = coordinatesOf(text);
	const tokens = tokenize(text);

	for (const [at, opener] of tokens.entries()) {
		const keywordToken = tokens[at + 1];
		const nameToken = tokens[at + 2];
		if (!spelled(opener, "word", "export") || coordinates.positionAt(opener.start)?.character !== 0) continue;
		if (keywordToken === undefined || nameToken === undefined || !spelled(nameToken, "word")) continue;
		if (keywordToken.kind !== "word" || !Object.hasOwn(KIND_OF, keywordToken.text)) continue;
		const kind = keywordToken.text as keyof typeof KIND_OF;
		const name = nameToken.text;

		out.push({
			symbolId: composeSymbolId({
				language: LANGUAGE,
				module,
				descriptors: [{ kind: kind === "class" ? "type" : "term", name }],
			}),
			kind: KIND_OF[kind],
			name,
			range: rangeAt(text, opener.start, nameToken.end),
			selectionRange: rangeAt(text, nameToken.start, nameToken.end),
			visibility: "public",
			exported: true,
		});
	}
	return out;
}

////////////////////////////////
//  Main

export const referenceHandlers: ProviderHandlers = {
	initialize: () => ({
		providerId: "reference-provider",
		language: LANGUAGE,
		extensions: [".ref"],
		protocolVersion: PROTOCOL_VERSION,
		tiers: REFERENCE_TIERS,
		words: REFERENCE_WORDS,
	}),

	discoverProject: () => ({ files: [], externalRoots: [], configFiles: [], diagnostics: [] }),

	// Holds nothing across parses, so a probe is a parse.
	probeFile: (params) => referenceHandlers.parseFile(params),

	// Holds nothing across parses, so it proves a batch only for modules whose text it was given.
	probeBatch: (params) => {
		const given = new Map(params.files.map((file) => [file.module, file]));
		const facts: FileFacts[] = [];
		for (const module of params.answer) {
			const file = given.get(module);
			if (file === undefined) return { status: "unsupported" as const, detail: `it holds no text for ${module}` };
			facts.push(referenceHandlers.parseFile({ module, contentHash: file.contentHash, text: file.text }));
		}
		return { status: "ready" as const, facts, landings: [] };
	},

	parseFile: (params) => ({
		module: params.module,
		contentHash: params.contentHash,
		declarations: extractDeclarations(params.module, params.text),
		// Declared false at initialize, so an empty list here is honest rather than a claim of none.
		references: [],
		imports: [],
		literals: [],
		comments: extractComments(params.text),
		blankLines: blankLinesOf(params.text),
		diagnostics: [],
	}),

	// The point of the whole file: a tier it does not do says so, with a reason, in the value.
	resolveImport: () => notImplementedImport("the reference provider does not resolve imports"),
	judgeLoadCycle: unjudgedLoadCycle,
	bind: () => notImplementedBinding("the reference provider does not bind references"),
	typeOf: () => notImplementedType("the reference provider does not infer types"),
	// Refused whole, not "ready with zero edits", because rename is not implemented here.
	renameEdits: () => ({
		status: "refused",
		reason: "NotImplemented",
		detail: "the reference provider does not rewrite text",
	}),
	moveEdits: makeReferenceMoveEdits,
	arrangeEdits: () => notImplementedMove("the reference provider does not arrange declarations"),
	importEdits: () => notImplementedImportEdits("the reference provider does not write imports"),
	shutdown: () => ({}),
};

/** Wires the handlers onto a connection. Separated so a test can drive it without a process. */
export function serveReferenceProvider(connection: ReturnType<typeof createMessageConnection>): void {
	serveProvider(connection, referenceHandlers);
}

if (import.meta.main) runProviderOnStdio(referenceHandlers);
