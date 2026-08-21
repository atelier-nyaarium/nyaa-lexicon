// A deliberately minimal provider, shipped with the suite.
//
// It answers the tiers it declares, a minimal move subset, and NotImplemented everywhere else.
// This proves the suite reports a partial provider as partial rather than as broken.
//
// Its "analysis" is a toy regex over exported declarations. That is fine: what it demonstrates is
// the SHAPE of an honest provider, not how to analyze a language.

import path from "node:path";
import type { createMessageConnection } from "vscode-jsonrpc/node";
import { coordinatesOf } from "../coordinates.js";
import type { TextEdit } from "../edits.js";
import type { MoveEditsRequest, MoveEditsResponse } from "../move.js";
import {
	notImplementedBinding,
	notImplementedImport,
	notImplementedMove,
	notImplementedType,
	type ProviderHandlers,
	runProviderOnStdio,
	serveProvider,
} from "../serve.js";
import { composeSymbolId } from "../symbolId.js";
import type { Declaration, Range } from "../symbols.js";
import { PROTOCOL_VERSION } from "../version.js";

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

/** `export class Foo` / `export function foo` / `export const foo`, and nothing cleverer. */
const DECLARATION_RE = /^export\s+(class|function|const)\s+([A-Za-z_$][\w$]*)/gm;

const KIND_OF = { class: "class", function: "function", const: "constant" } as const;

////////////////////////////////
//  Functions & Helpers

function lineOf(text: string, index: number): number {
	let line = 0;
	for (let i = 0; i < index; i++) if (text[i] === "\n") line++;
	return line;
}

function offsetAt(text: string, position: Range["start"]): number | undefined {
	return coordinatesOf(text).offsetAt(position);
}

function rangeAt(text: string, start: number, end: number): Range {
	const range = coordinatesOf(text).rangeAt(start, end);
	if (range === undefined) throw new Error(`unaddressable reference-provider range: ${start} to ${end}`);
	return range;
}

/**
 * Comment spans, scanned with string awareness.
 *
 * A marker inside a quoted string is not a comment, which is the one thing the corpus's exact-set
 * cases exist to catch, so this walks the text rather than pattern-matching it. Blocks do not nest,
 * matching the C family the toy grammar borrows from.
 */
export function extractComments(text: string): Array<{ range: Range; text: string }> {
	const found: Array<{ range: Range; text: string }> = [];
	let index = 0;

	while (index < text.length) {
		const char = text[index];

		if (char === '"' || char === "'" || char === "`") {
			index++;
			while (index < text.length && text[index] !== char) {
				index += text[index] === "\\" ? 2 : 1;
			}
			index++;
			continue;
		}

		if (char === "/" && text[index + 1] === "/") {
			const end = text.indexOf("\n", index);
			let stop = end === -1 ? text.length : end;
			// Only a CR paired with the newline ends the line. A lone one is comment text.
			if (end !== -1 && stop > index && text[stop - 1] === "\r") stop--;
			found.push({ range: rangeAt(text, index, stop), text: text.slice(index, stop) });
			index = stop;
			continue;
		}

		if (char === "/" && text[index + 1] === "*") {
			const close = text.indexOf("*/", index + 2);
			// Unterminated runs to the end: the file has no more code to find after it.
			const stop = close === -1 ? text.length : close + 2;
			found.push({ range: rangeAt(text, index, stop), text: text.slice(index, stop) });
			index = stop;
			continue;
		}

		index++;
	}

	return found;
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
		site.reExport ||
		site.importedName !== request.name ||
		(site.localName !== undefined && site.localName !== request.name)
	) {
		return undefined;
	}

	const nameStart = offsetAt(request.text, site.range.start);
	const nameEnd = offsetAt(request.text, site.range.end);
	if (nameStart === undefined || nameEnd === undefined || request.text.slice(nameStart, nameEnd) !== request.name) {
		return undefined;
	}

	const statementStart = request.text.lastIndexOf("\n", nameStart) + 1;
	const nextLine = request.text.indexOf("\n", nameEnd);
	const statementEnd = nextLine === -1 ? request.text.length : nextLine;
	const statement = request.text.slice(statementStart, statementEnd);
	const match = /^import\s+\{\s*([A-Za-z_$][\w$]*)\s*\}\s+from\s+(["'])([^"']+)\2;?\s*$/.exec(statement);
	if (match?.[1] !== request.name || match[3] !== site.specifier) return undefined;

	const specifierStart = statement.lastIndexOf(site.specifier);
	if (specifierStart === -1) return undefined;
	const absoluteStart = statementStart + specifierStart;
	return {
		range: rangeAt(request.text, absoluteStart, absoluteStart + site.specifier.length),
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

export function extractDeclarations(module: string, text: string): Declaration[] {
	const out: Declaration[] = [];
	DECLARATION_RE.lastIndex = 0;

	for (const match of text.matchAll(DECLARATION_RE)) {
		const keyword = match[1] as keyof typeof KIND_OF;
		const name = match[2] as string;
		const line = lineOf(text, match.index);
		const column = (match[0].length - name.length) as number;
		const range = {
			start: { line, character: 0 },
			end: { line, character: match[0].length },
		};

		out.push({
			symbolId: composeSymbolId({
				language: LANGUAGE,
				module,
				descriptors: [{ kind: keyword === "class" ? "type" : "term", name }],
			}),
			kind: KIND_OF[keyword],
			name,
			range,
			selectionRange: { start: { line, character: column }, end: { line, character: column + name.length } },
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
	}),

	discoverProject: () => ({ files: [], externalRoots: [], configFiles: [], diagnostics: [] }),

	parseFile: (params) => ({
		module: params.module,
		contentHash: params.contentHash,
		declarations: extractDeclarations(params.module, params.text),
		// Declared false at initialize, so an empty list here is honest rather than a claim of none.
		references: [],
		imports: [],
		literals: [],
		comments: extractComments(params.text),
		diagnostics: [],
	}),

	// The point of the whole file: a tier it does not do says so, with a reason, in the value.
	resolveImport: () => notImplementedImport("the reference provider does not resolve imports"),
	bind: () => notImplementedBinding("the reference provider does not bind references"),
	typeOf: () => notImplementedType("the reference provider does not infer types"),
	// Refused whole, not "ready with zero edits", because rename is not implemented here.
	renameEdits: () => ({
		status: "refused",
		reason: "NotImplemented",
		detail: "the reference provider does not rewrite text",
	}),
	moveEdits: makeReferenceMoveEdits,
	shutdown: () => ({}),
};

/** Wires the handlers onto a connection. Separated so a test can drive it without a process. */
export function serveReferenceProvider(connection: ReturnType<typeof createMessageConnection>): void {
	serveProvider(connection, referenceHandlers);
}

if (import.meta.main) runProviderOnStdio(referenceHandlers);
