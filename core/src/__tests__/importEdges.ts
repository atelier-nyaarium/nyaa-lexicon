// Import and export edges for test doubles, as a TypeScript provider reports them.

import type {
	Conflict,
	Declaration,
	Export,
	Import,
	ImportEdge,
	ImportResolution,
	Range,
} from "@nyaa-lexicon/protocol";

////////////////////////////////
//  Constants

/** TypeScript's policy: a local and an imported binding of one name cannot both stand. */
export const TS_CONFLICT: Conflict = { priority: 0, amongTransfers: "exclude", againstLocal: "localWins" };

const KNOWN = { status: "known" } as const;

////////////////////////////////
//  Functions & Helpers

/** One import edge; a binding edge takes TypeScript's conflict policy. */
export function edge(
	kind: ImportEdge["kind"],
	span: Range,
	fields: Partial<Omit<ImportEdge, "kind" | "span">> = {},
): ImportEdge {
	const bindsLocally = fields.bindsLocally ?? kind !== "sideEffect";
	return {
		kind,
		span,
		bindsLocally,
		...(bindsLocally ? { conflict: TS_CONFLICT } : {}),
		certainty: KNOWN,
		order: 0,
		...fields,
	};
}

/** `import { name } from "specifier"`, spanning the name. */
export function named(
	specifier: string,
	name: string,
	range: Range,
	fields: Partial<Omit<ImportEdge, "kind" | "span">> = {},
): Import {
	return { specifier, edges: [edge("named", range, { name, range, ...fields })] };
}

/** `import "specifier"`. */
export function sideEffect(specifier: string, span: Range, order = 0): Import {
	return { specifier, edges: [edge("sideEffect", span, { order })] };
}

/** An export forwarding the import edge at `span`. */
export function forwarding(
	form: "forward" | "star" | "namespace",
	span: Range,
	fields: Partial<Omit<Export, "form" | "span" | "target">> = {},
): Export {
	return {
		form,
		span,
		target: { kind: "import", span },
		conflict: TS_CONFLICT,
		certainty: KNOWN,
		order: 0,
		...fields,
	};
}

/** `export { name } from "specifier"`: an edge binding nothing here, and the export forwarding it. */
export function forward(
	specifier: string,
	name: string,
	range: Range,
	order = 0,
): { imports: Import[]; exports: Export[] } {
	return {
		imports: [{ specifier, edges: [edge("named", range, { name, range, bindsLocally: false, order })] }],
		exports: [forwarding("forward", range, { name, range, order })],
	};
}

/** `export class Name`: exported where it is declared, spanning its name. */
export function direct(declaration: Declaration, order = 0): Export {
	const span = declaration.selectionRange ?? declaration.range;
	return {
		form: "direct",
		span,
		name: declaration.name,
		range: span,
		target: { kind: "symbol", symbolId: declaration.symbolId },
		conflict: TS_CONFLICT,
		certainty: KNOWN,
		order,
	};
}

/** One character at the start of `line`, so each edge in a file gets its own span. */
export function onLine(line: number): Range {
	return { start: { line, character: 0 }, end: { line, character: 1 } };
}

/** A specifier resolved to a workspace module. */
export function landed(module: string): ImportResolution {
	return { status: "resolved", landing: { kind: "module", module } };
}
