// A deliberately minimal provider, shipped with the suite.
//
// It answers the tiers it declares and NotImplemented everywhere else, which is what proves the
// suite reports a partial provider as partial rather than as broken. Also the smallest complete
// example of the protocol a provider team can read.
//
// Its "analysis" is a toy regex over exported declarations. That is fine: what it demonstrates is
// the SHAPE of an honest provider, not how to analyze a language.

import type { createMessageConnection } from "vscode-jsonrpc/node";
import {
	notImplementedBinding,
	notImplementedImport,
	notImplementedType,
	type ProviderHandlers,
	runProviderOnStdio,
	serveProvider,
} from "../serve.js";
import { composeSymbolId } from "../symbolId.js";
import type { Declaration } from "../symbols.js";
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
	metrics: false,
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
		diagnostics: [],
	}),

	// The point of the whole file: a tier it does not do says so, with a reason, in the value.
	resolveImport: () => notImplementedImport("the reference provider does not resolve imports"),
	bind: () => notImplementedBinding("the reference provider does not bind references"),
	typeOf: () => notImplementedType("the reference provider does not infer types"),
	// Refused whole, not "ready with zero edits". The second reads as "nothing needed changing",
	// which for a provider that cannot rewrite anything is the wrong answer entirely.
	renameEdits: () => ({
		status: "refused",
		reason: "NotImplemented",
		detail: "the reference provider does not rewrite text",
	}),
	shutdown: () => ({}),
};

/** Wires the handlers onto a connection. Separated so a test can drive it without a process. */
export function serveReferenceProvider(connection: ReturnType<typeof createMessageConnection>): void {
	serveProvider(connection, referenceHandlers);
}

if (import.meta.main) runProviderOnStdio(referenceHandlers);
