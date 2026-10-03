// One parse's raw facts with symbol ids composed, and its import and export edges in source order.

import {
	type AllList,
	type Binding,
	type Certainty,
	type CommentSpan,
	type Conflict,
	comparePositions,
	composeSymbolId,
	coordinatesOf,
	type Declaration,
	type Diagnostic,
	defined,
	type Export,
	type ExportTarget,
	type FileRole,
	type Import,
	type ImportEdge,
	type Literal,
	type Reference,
	type UnknownReason,
} from "@nyaa-lexicon/protocol";
import type {
	Range,
	RawAllList,
	RawBinding,
	RawDescriptor,
	RawExport,
	RawExportTarget,
	RawFacts,
	RawImportBinding,
	RawImportEdge,
	RawInferredType,
	RawScopeInfo,
	RawTypeAnnotation,
	RawTypeReference,
} from "./facts/types";
import { signatureOf } from "./header";

////////////////////////////////
//  Interfaces & Types

export type TypeAnswer =
	| {
			kind: "declared";
			text: string;
			forwardReference: boolean;
			symbolId?: string;
			typeReference?: RawTypeReference;
	  }
	| {
			kind: "inferred";
			display: string;
			basis: string;
			symbolId?: string;
			typeReference?: RawTypeReference;
	  }
	| { kind: "unknown"; reason: UnknownReason; detail?: string };

export type MappedTypeAnnotation = RawTypeAnnotation & { symbolId?: string };

/** A member's root name, as its own read binds, and the members after it. */
export interface Receiver {
	name: string;
	binding: Binding;
	path: string[];
	/** A lambda's or comprehension's own name, which no import reaches. */
	nestedLocal: boolean;
}

export interface MappedFacts {
	declarations: Declaration[];
	references: Reference[];
	role: FileRole;
	referenceScopes: Map<Reference, RawDescriptor[]>;
	receivers: Map<Reference, Receiver>;
	/** Uses of a lambda's or comprehension's own names. */
	nestedLocals: Set<Reference>;
	imports: Import[];
	/** Each `from` statement's load of its module, by its import. */
	loads: Map<Import, ImportEdge>;
	/** Absent when the file did not parse. */
	exports?: Export[];
	allList?: AllList;
	/** Each static `__all__` entry's competing stars, by entry index. */
	allListStars: Range[][];
	importBindings: RawImportBinding[];
	scopeInfos: RawScopeInfo[];
	diagnostics: Diagnostic[];
	typeAnnotations: MappedTypeAnnotation[];
	inferredTypes: RawInferredType[];
	literals: Literal[];
	comments: CommentSpan[];
	blankLines?: number[];
	typeAnswers: Map<string, TypeAnswer>;
}

////////////////////////////////
//  Constants

export const LANGUAGE = "python";

/** A later binding of a name replaces an earlier one, imported or not. */
const CONFLICT: Conflict = { priority: 0, amongTransfers: "laterWins", againstLocal: "sourceOrder" };

const KNOWN: Certainty = { status: "known" };

/** A binding in a control block may never run. */
const CONDITIONAL: Certainty = { status: "unknown", reason: "Ambiguous" };

/** What `from m import *` brings when `m` has no `__all__`. */
const STAR_FALLBACK = { glob: "[!_]*", caseInsensitive: false };

////////////////////////////////
//  Functions & Helpers

export function idFor(module: string, descriptors: RawDescriptor[]): string {
	return composeSymbolId({ language: LANGUAGE, module, descriptors });
}

function mapBinding(module: string, binding: RawBinding): Binding {
	return binding.status === "bound"
		? { status: "bound", symbolId: idFor(module, binding.descriptorPath), provenance: "bound" }
		: binding;
}

/** Import and export edges share one source order; an import precedes the export written on it. */
function edgeOrder(raw: RawFacts): Map<RawImportEdge | RawExport, number> {
	const items: Array<{ span: Range; rank: number; edge: RawImportEdge | RawExport }> = [
		...raw.imports.flatMap((statement) =>
			[...(statement.load === undefined ? [] : [statement.load]), ...statement.edges].map((edge) => ({
				span: edge.span,
				rank: 0,
				edge,
			})),
		),
		...(raw.exports ?? []).map((edge) => ({ span: edge.span, rank: 1, edge })),
	];
	items.sort((left, right) => comparePositions(left.span.start, right.span.start) || left.rank - right.rank);
	return new Map(items.map(({ edge }, order) => [edge, order]));
}

function importEdge(edge: RawImportEdge, order: number): ImportEdge {
	const binds = edge.kind !== "sideEffect";
	return {
		kind: edge.kind,
		span: edge.span,
		...defined({
			name: edge.name,
			range: edge.range,
			local: edge.local,
			localRange: edge.localRange,
			selector: edge.selector,
		}),
		bindsLocally: binds,
		...(binds ? { conflict: CONFLICT } : {}),
		certainty: edge.conditional ? CONDITIONAL : KNOWN,
		order,
	};
}

function exportTarget(module: string, target: RawExportTarget): ExportTarget {
	return target.kind === "symbol" ? { kind: "symbol", symbolId: idFor(module, target.descriptorPath) } : target;
}

function exportEdge(module: string, edge: RawExport, order: number): Export {
	return {
		form: edge.form,
		span: edge.span,
		...defined({ name: edge.name, range: edge.range, sourceRange: edge.sourceRange }),
		target: exportTarget(module, edge.target),
		conflict: CONFLICT,
		certainty: edge.conditional ? CONDITIONAL : KNOWN,
		order,
	};
}

function allListOf(module: string, allList: RawAllList): AllList {
	switch (allList.state) {
		case "absent":
			return { state: "absent", fallback: STAR_FALLBACK };
		case "dynamic":
			return allList;
		case "static":
			return {
				state: "static",
				entries: allList.entries.map(({ name, range, target }) => ({
					name,
					range,
					target: exportTarget(module, target),
				})),
			};
	}
}

/** Whether `from m import *` brings `name` past `m`'s list; undefined when the list is dynamic. */
export function starSelects(allList: AllList | undefined, name: string): boolean | undefined {
	if (allList === undefined || allList.state === "dynamic") return undefined;
	if (allList.state === "static") return allList.entries.some((entry) => entry.name === name);
	// The fallback, `[!_]*`.
	return name !== "" && !name.startsWith("_");
}

export function mapFacts(module: string, text: string, raw: RawFacts): MappedFacts {
	const coordinates = coordinatesOf(text);
	const declarations: Declaration[] = raw.declarations.map((declaration) => ({
		symbolId: idFor(module, declaration.descriptorPath),
		kind: declaration.kind,
		name: declaration.name,
		range: declaration.range,
		selectionRange: declaration.selectionRange,
		visibility: declaration.visibility,
		exported: declaration.exported,
		...defined({
			signature:
				declaration.header === undefined ? undefined : signatureOf(text, coordinates, declaration.header),
			memberInsertLine: declaration.memberInsertLine,
			metrics: declaration.metrics,
		}),
		...(declaration.containerPath.length === 0 ? {} : { containerId: idFor(module, declaration.containerPath) }),
	}));
	const typeAnnotations: MappedTypeAnnotation[] = raw.typeAnnotations.map((annotation) => ({
		...annotation,
		...(annotation.typeDescriptorPath === undefined
			? {}
			: { symbolId: idFor(module, annotation.typeDescriptorPath) }),
	}));
	const literals: Literal[] = raw.literals.map((literal) => ({
		kind: literal.kind,
		value: literal.value,
		...defined({ number: literal.number }),
		range: literal.range,
		...(literal.containerPath === undefined || literal.containerPath.length === 0
			? {}
			: { containerId: idFor(module, literal.containerPath) }),
	}));
	const typeAnswers = new Map<string, TypeAnswer>();
	for (const declaration of raw.declarations) {
		if (declaration.typeText !== undefined) {
			typeAnswers.set(idFor(module, declaration.descriptorPath), {
				kind: "declared",
				text: declaration.typeText,
				forwardReference: declaration.typeForwardReference === true,
				...(declaration.typeDescriptorPath === undefined
					? {}
					: { symbolId: idFor(module, declaration.typeDescriptorPath) }),
				...defined({ typeReference: declaration.typeReference }),
			});
		}
	}
	for (const inferred of raw.inferredTypes) {
		const symbolId = idFor(module, inferred.descriptorPath);
		if (inferred.display !== undefined && inferred.basis !== undefined) {
			typeAnswers.set(symbolId, {
				kind: "inferred",
				display: inferred.display,
				basis: inferred.basis,
				...(inferred.typeDescriptorPath === undefined
					? {}
					: { symbolId: idFor(module, inferred.typeDescriptorPath) }),
			});
		} else if (inferred.reason !== undefined) {
			typeAnswers.set(symbolId, {
				kind: "unknown",
				reason: inferred.reason,
				...defined({ detail: inferred.detail }),
			});
		}
	}
	const referenceScopes = new Map<Reference, RawDescriptor[]>();
	const receivers = new Map<Reference, Receiver>();
	const nestedLocals = new Set<Reference>();
	const references: Reference[] = raw.references.map((reference) => {
		const mapped: Reference = {
			name: reference.name,
			range: reference.range,
			role: reference.role,
			qualified: reference.qualified,
			binding: mapBinding(module, reference.binding),
			...(reference.ownerPath.length === 0 ? {} : { fromId: idFor(module, reference.ownerPath) }),
		};
		referenceScopes.set(mapped, reference.scopePath);
		if (reference.nestedLocal === true) nestedLocals.add(mapped);
		if (reference.receiver !== undefined) {
			receivers.set(mapped, {
				name: reference.receiver.name,
				binding: mapBinding(module, reference.receiver.binding),
				path: reference.receiver.path,
				nestedLocal: reference.receiver.nestedLocal,
			});
		}
		return mapped;
	});
	const order = edgeOrder(raw);
	const orderOf = (edge: RawImportEdge | RawExport) => order.get(edge) as number;
	const loads = new Map<Import, ImportEdge>();
	const imports = raw.imports.map((statement) => {
		const mapped: Import = {
			specifier: statement.specifier,
			edges: statement.edges.map((edge) => importEdge(edge, orderOf(edge))),
		};
		if (statement.load !== undefined) loads.set(mapped, importEdge(statement.load, orderOf(statement.load)));
		return mapped;
	});
	return {
		declarations,
		references,
		role: raw.role,
		referenceScopes,
		receivers,
		nestedLocals,
		imports,
		loads,
		...(raw.exports === null
			? {}
			: {
					exports: raw.exports
						.map((edge) => exportEdge(module, edge, orderOf(edge)))
						.sort((left, right) => left.order - right.order),
				}),
		...(raw.allList === null ? {} : { allList: allListOf(module, raw.allList) }),
		allListStars: raw.allList?.state === "static" ? raw.allList.entries.map((entry) => entry.stars ?? []) : [],
		importBindings: raw.importBindings,
		scopeInfos: raw.scopeInfos,
		diagnostics: raw.diagnostics,
		typeAnnotations,
		inferredTypes: raw.inferredTypes,
		literals,
		comments: raw.comments,
		...defined({ blankLines: raw.blankLines ?? undefined }),
		typeAnswers,
	};
}
