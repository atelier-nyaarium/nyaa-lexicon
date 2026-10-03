// What a module exposes: every module-level binding by name, and `__all__`, which only decides what
// a star import of it brings.

import { comparePositions } from "@nyaa-lexicon/protocol";
import type * as A from "../syntax/ast.js";
import { childNodes, walk } from "../syntax/ast.js";
import type { Analyzer } from "./analyzer.js";
import { isStringConstant } from "./nodes.js";
import type { Source } from "./source.js";
import type {
	Position,
	Range,
	RawAllList,
	RawAllListEntry,
	RawExport,
	RawExportTarget,
	RawImportEdge,
} from "./types.js";

////////////////////////////////
//  Interfaces & Types

/** `__all__` as written, before its entries are matched to bindings. */
export type AllListReading =
	| { state: "absent" }
	| { state: "dynamic" }
	| { state: "static"; entries: Array<{ name: string; range: Range }> };

/** One statement binding a module-level name, and the export it would leave. */
interface Binder {
	at: Position;
	conditional: boolean;
	entry: RawExport;
}

////////////////////////////////
//  Constants

const ALL = "__all__";

const NOT_INDEXED: RawExportTarget = { kind: "unknown", reason: "NotIndexed" };

const AMBIGUOUS: RawExportTarget = { kind: "unknown", reason: "Ambiguous" };

/** List methods that change `__all__` in place. */
const MUTATORS: ReadonlySet<string> = new Set([
	"append",
	"extend",
	"insert",
	"remove",
	"pop",
	"clear",
	"sort",
	"reverse",
	"__iadd__",
	"__setitem__",
	"__delitem__",
]);

////////////////////////////////
//  Functions & Helpers

function isAll(node: A.Node): node is A.Name {
	return node.type === "Name" && node.id === ALL;
}

/** Whether `parent` reads the `__all__` it holds without handing the list on. */
function readsInPlace(parent: A.Node, child: A.Node): boolean {
	switch (parent.type) {
		case "Attribute":
		case "Subscript":
		case "Starred":
			return parent.value === child;
		case "For":
		case "AsyncFor":
		case "comprehension":
			return parent.iter === child;
		case "If":
		case "While":
		case "IfExp":
		case "Assert":
			return parent.test === child;
		case "Compare":
		case "BinOp":
		case "UnaryOp":
		case "Expr":
		case "FormattedValue":
			return true;
		default:
			return false;
	}
}

/** A literal list, tuple or set of non-empty strings. */
function literalEntries(value: A.Expression, source: Source): Array<{ name: string; range: Range }> | undefined {
	if (value.type !== "List" && value.type !== "Tuple" && value.type !== "Set") return undefined;
	const entries: Array<{ name: string; range: Range }> = [];
	for (const element of value.elts) {
		if (!isStringConstant(element) || element.value.value === "") return undefined;
		entries.push({ name: element.value.value, range: source.rangeOf(element) });
	}
	return entries;
}

/** Static only when every write is a module-level, unconditional literal, and no read hands the list on. */
export function readAllList(tree: A.Module, source: Source): AllListReading {
	const plain = new Set<A.Node>();
	let entries: Array<{ name: string; range: Range }> | null | undefined;
	for (const node of tree.body) {
		if (node.type === "Assign") {
			const targets = node.targets.filter(isAll);
			if (targets.length === 0) continue;
			for (const target of targets) plain.add(target);
			entries = literalEntries(node.value, source) ?? null;
		} else if (node.type === "AnnAssign" && isAll(node.target)) {
			plain.add(node.target);
			if (node.value !== undefined) entries = literalEntries(node.value, source) ?? null;
		}
	}
	let dynamic = entries === null;
	for (const node of walk(tree)) {
		if (dynamic) break;
		if (node.type === "Name") dynamic = node.id === ALL && node.ctx !== "Load" && !plain.has(node);
		else if (node.type === "Attribute") dynamic = isAll(node.value) && MUTATORS.has(node.attr);
		else if (node.type === "Subscript") dynamic = isAll(node.value) && node.ctx !== "Load";
		else if (node.type === "Global") dynamic = node.names.includes(ALL);
		else if (node.type === "alias") dynamic = (node.asname ?? node.name) === ALL;
		// A list handed on can be changed through another name.
		dynamic ||= childNodes(node).some(
			(child) => isAll(child) && child.ctx === "Load" && !readsInPlace(node, child),
		);
	}
	if (dynamic) return { state: "dynamic" };
	return entries === undefined || entries === null ? { state: "absent" } : { state: "static", entries };
}

/** The local name an import edge binds, if any. */
function boundName(edge: RawImportEdge): string | undefined {
	return edge.kind === "named" || edge.kind === "namespace" ? (edge.local ?? edge.name) : undefined;
}

/**
 * The exports a name's binders leave: the last unconditional one and every conditional one after it.
 * Several survivors compete, so none is certain.
 */
function settle(binders: Binder[]): RawExport[] {
	binders.sort((left, right) => comparePositions(left.at, right.at));
	const last = binders.findLastIndex((binder) => !binder.conditional);
	const survivors = [...new Set(binders.slice(Math.max(last, 0)).map((binder) => binder.entry))];
	const competing = survivors.length > 1 || last === -1;
	return survivors.map((entry) => (competing && !entry.conditional ? { ...entry, conditional: true } : entry));
}

/** Module-level bindings, export edges, and `__all__`'s entries matched to them. */
export function moduleExports(
	analyzer: Analyzer,
	reading: AllListReading,
): { exports: RawExport[]; allList: RawAllList } {
	const conditional = (name: string) => analyzer.scopes.isConditional([], name);
	const unconditional = analyzer.loadStatements();
	const binders = new Map<string, Binder[]>();
	const bind = (name: string, binder: Binder) => binders.set(name, [...(binders.get(name) ?? []), binder]);
	const exports: RawExport[] = [];

	for (const declaration of analyzer.declarations.values()) {
		if (declaration.containerPath.length > 0) continue;
		const entry: RawExport = {
			form: "direct",
			span: declaration.selectionRange,
			name: declaration.name,
			range: declaration.selectionRange,
			target: { kind: "symbol", descriptorPath: declaration.descriptorPath },
			conditional: conditional(declaration.name),
		};
		for (const node of analyzer.nodesOf(declaration)) {
			bind(declaration.name, {
				at: analyzer.source.rangeOf(node).start,
				conditional: !unconditional.has(node),
				entry,
			});
		}
	}

	const stars: Range[] = [];
	for (const edge of analyzer.imports.flatMap((statement) => statement.edges)) {
		if (!edge.moduleLevel) continue;
		const target: RawExportTarget = { kind: "import", span: edge.span };
		if (edge.kind === "wildcard") {
			stars.push(edge.span);
			exports.push({ form: "star", span: edge.span, target, conditional: edge.conditional });
			continue;
		}
		const name = boundName(edge);
		const range = edge.localRange ?? edge.range;
		if (name === undefined || range === undefined) continue;
		bind(name, {
			at: edge.span.start,
			conditional: edge.conditional,
			entry: {
				form: "forward",
				span: edge.span,
				name,
				range,
				...(edge.kind === "named" && edge.local !== undefined && edge.range !== undefined
					? { sourceRange: edge.range }
					: {}),
				target,
				conditional: edge.conditional,
			},
		});
	}

	const bindings = new Map<string, RawExportTarget[]>();
	for (const [name, each] of binders) {
		const settled = settle(each);
		exports.push(...settled);
		bindings.set(
			name,
			settled.map((entry) => entry.target),
		);
	}

	if (reading.state !== "static") {
		return {
			exports,
			allList: reading.state === "absent" ? reading : { state: "dynamic", reason: "RuntimeConstructed" },
		};
	}
	const boundElsewhere = (name: string) =>
		[...analyzer.scopes.infos.values()].some((info) =>
			info.path.length === 0 ? info.dynamic || info.locals.has(name) : info.globals.has(name),
		);
	const entries = reading.entries.map(({ name, range }): RawAllListEntry => {
		const found = bindings.get(name) ?? [];
		if (found.length === 0 && stars.length === 0) return { name, range, target: NOT_INDEXED };
		const only = found.length === 1 && !conditional(name) ? found[0] : undefined;
		if (only !== undefined) {
			const last = (binders.get(name) ?? [])
				.map((binder) => binder.at)
				.sort(comparePositions)
				.at(-1);
			const later = stars.filter((star) => last !== undefined && comparePositions(star.start, last) > 0);
			return { name, range, target: only, ...(later.length > 0 ? { stars: later } : {}) };
		}
		// Stars decide it only where no other binder competes.
		if (found.length > 0 || boundElsewhere(name)) return { name, range, target: AMBIGUOUS };
		return { name, range, target: NOT_INDEXED, stars };
	});
	return { exports, allList: { state: "static", entries } };
}
