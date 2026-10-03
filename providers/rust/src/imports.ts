import { type Certainty, defined, type Export, type ImportEdge, type Range } from "@nyaa-lexicon/protocol";
import { Declarations, type ParseContext } from "./declarations.js";
import { EXPLICIT, GLOBBED, KNOWN, type Placed, type PlacedEdge, VISIBLE } from "./edges.js";
import type { ImportBinding } from "./model.js";
import type { Prefix } from "./prefixes.js";
import type { SpanRange } from "./references.js";
import { isNameToken, isValueToken, type RustToken } from "./tokens.js";

////////////////////////////////
//  Interfaces & Types

interface UseEntry {
	path: string[];
	sourceName: string | null;
	localName: string | null;
	sourceIndex?: number;
	localIndex?: number;
	glob: boolean;
	/** The leaf as written, by token index, both inclusive. */
	first: number;
	last: number;
	/** The token spelling the source name; a `self` leaf's is its module's segment. */
	nameIndex?: number;
}

/** A path segment and the token spelling it. */
interface Segment {
	name: string;
	index: number;
}

////////////////////////////////
//  Constants

/** Resolution starts at the file's top, so a relative path inside an inline module lands elsewhere. */
const UNPLACED: Certainty = { status: "unknown", reason: "NotImplemented" };

////////////////////////////////
//  Classes

/** `use` and `extern crate` items: each leaf an import edge and a binding, a `pub` one also an export. */
export abstract class Imports extends Declarations {
	protected readonly importBindings: ImportBinding[] = [];
	protected readonly importEdges: PlacedEdge[] = [];
	protected readonly forwardExports: Placed<Export>[] = [];
	protected readonly useRanges: SpanRange[] = [];

	/** A written path's last segment, through the imports of its scope that rename its first. */
	protected importedName(names: readonly string[], containerId: string | undefined): string | undefined {
		let path = names;
		const followed = new Set<ImportBinding>();
		for (;;) {
			const binding = this.importBindings.find(
				(candidate) =>
					!candidate.glob &&
					candidate.localName === path[0] &&
					candidate.containerId === containerId &&
					!followed.has(candidate),
			);
			if (binding === undefined) return path.at(-1);
			followed.add(binding);
			path = [...binding.path, ...path.slice(1)];
		}
	}

	////////////////////////////////
	//  Imports

	protected parseUse(start: number, end: number, prefix: Prefix, context: ParseContext): number {
		const statement = this.statementEnd(start, end);
		const useToken = this.tokens[start] as RustToken;
		const statementToken = this.tokens[statement] as RustToken;
		this.useRanges.push({ startOffset: useToken.startOffset, endOffset: statementToken.endOffset });
		const absolute = isValueToken(this.tokens[start + 1], "::");
		for (const entry of this.useTree(start + 1, statement, [])) this.addImport(entry, prefix, context, absolute);
		return statement + 1;
	}

	/** `extern crate name;` binds the crate's name, or its alias. */
	protected parseExternCrate(start: number, end: number, prefix: Prefix, context: ParseContext): number {
		const statement = this.statementEnd(start, end);
		const nameIndex = start + 1;
		const name = this.tokens[nameIndex];
		const aliased = isValueToken(this.tokens[nameIndex + 1], "as") && isNameToken(this.tokens[nameIndex + 2]);
		const localIndex = aliased ? nameIndex + 2 : nameIndex;
		this.useRanges.push({
			startOffset: (this.tokens[start] as RustToken).startOffset,
			endOffset: (this.tokens[statement] as RustToken).endOffset,
		});
		if (isNameToken(name)) {
			const local = this.tokens[localIndex] as RustToken;
			this.addImport(
				{
					path: [name.value],
					sourceName: name.value,
					localName: local.value,
					sourceIndex: nameIndex,
					localIndex,
					glob: false,
					first: nameIndex,
					last: localIndex,
					nameIndex,
				},
				prefix,
				context,
				true,
				false,
			);
		}
		return statement + 1;
	}

	/**
	 * One import per use-tree leaf, its specifier the leaf's whole path. An absolute one names a crate
	 * first, and a leading `::` spells that.
	 */
	private addImport(
		entry: UseEntry,
		prefix: Prefix,
		context: ParseContext,
		absolute = false,
		spelled = absolute,
	): void {
		const source = entry.sourceIndex === undefined ? undefined : this.tokens[entry.sourceIndex];
		const local = entry.localIndex === undefined ? undefined : this.tokens[entry.localIndex];
		const written = entry.glob ? [...entry.path, "*"].join("::") : entry.path.join("::");
		if (written === "") return;
		const specifier = spelled ? `::${written}` : written;
		const sourceRange = source === undefined ? undefined : rangeOf(source);
		const localRange = local === undefined ? undefined : rangeOf(local);
		this.importBindings.push({
			specifier,
			path: entry.path,
			sourceName: entry.sourceName,
			localName: entry.localName,
			glob: entry.glob,
			...defined({
				sourceRange,
				sourceIndex: entry.sourceIndex,
				localRange,
				containerId: context.containerId,
			}),
			...(absolute ? { absolute } : {}),
			ambiguous: entry.glob,
		});
		const edge = this.edgeOf(entry, context, absolute);
		const offset = (this.tokens[entry.first] as RustToken).startOffset;
		this.importEdges.push({ specifier, fact: edge, offset });
		const forward = prefix.exported ? this.forwardOf(edge, prefix, context) : undefined;
		if (forward !== undefined) this.forwardExports.push({ fact: forward, offset });
	}

	/**
	 * A glob is a wildcard; a lone segment binds a crate or module whole; any other leaf names one
	 * item. `as _` binds no name, and on a lone segment only links the crate.
	 */
	private edgeOf(entry: UseEntry, context: ParseContext, absolute: boolean): ImportEdge {
		const span = {
			start: (this.tokens[entry.first] as RustToken).start,
			end: (this.tokens[entry.last] as RustToken).end,
		};
		const anchored = absolute || entry.path[0] === "crate";
		const nested = context.descriptors.some((descriptor) => descriptor.kind === "namespace");
		const certainty = nested && !anchored ? UNPLACED : KNOWN;
		if (entry.glob)
			return {
				kind: "wildcard",
				span,
				bindsLocally: true,
				selector: VISIBLE,
				conflict: GLOBBED,
				certainty,
				order: 0,
			};
		const nameToken = this.tokens[entry.nameIndex ?? entry.sourceIndex ?? entry.first] as RustToken;
		const aliasToken = entry.localIndex === entry.sourceIndex ? undefined : this.tokens[entry.localIndex ?? -1];
		const anonymous = aliasToken?.value === "_";
		if (entry.path.length === 1) {
			if (anonymous) return { kind: "sideEffect", span, bindsLocally: false, certainty, order: 0 };
			const binding = aliasToken ?? nameToken;
			return {
				kind: "namespace",
				span,
				local: binding.value,
				localRange: rangeOf(binding),
				bindsLocally: true,
				conflict: EXPLICIT,
				certainty,
				order: 0,
			};
		}
		return {
			kind: "named",
			span,
			name: entry.sourceName ?? nameToken.value,
			range: rangeOf(nameToken),
			...(aliasToken === undefined || anonymous
				? {}
				: { local: aliasToken.value, localRange: rangeOf(aliasToken) }),
			bindsLocally: !anonymous,
			...(anonymous ? {} : { conflict: EXPLICIT }),
			certainty,
			order: 0,
		};
	}

	/** A `pub use` leaf at a module's top re-exports what its edge binds; one in a body exposes nothing. */
	private forwardOf(edge: ImportEdge, prefix: Prefix, context: ParseContext): Export | undefined {
		if (context.kind !== "root" && context.kind !== "module") return undefined;
		const shared = {
			span: edge.span,
			target: { kind: "import" as const, span: edge.span },
			...defined({ scopeId: context.kind === "module" ? context.containerId : undefined }),
			visibility: prefix.visibility,
			certainty: KNOWN,
			order: 0,
		};
		if (edge.kind === "wildcard") return { form: "star", ...shared, conflict: GLOBBED };
		if (!edge.bindsLocally) return undefined;
		if (edge.kind === "namespace")
			return { form: "namespace", name: edge.local, range: edge.localRange, ...shared, conflict: EXPLICIT };
		return {
			form: "forward",
			name: edge.local ?? edge.name,
			range: edge.localRange ?? edge.range,
			...(edge.local === undefined ? {} : { sourceRange: edge.range }),
			...shared,
			conflict: EXPLICIT,
		};
	}

	private useTree(start: number, end: number, prefix: readonly Segment[]): UseEntry[] {
		const entries: UseEntry[] = [];
		let index = start;
		let path = [...prefix];
		let first = start;
		let guard = -1;
		while (index < end) {
			if (index <= guard) throw new Error("use tree parser failed to advance");
			guard = index;
			const token = this.tokens[index] as RustToken;
			if (isValueToken(token, ",")) {
				path = [...prefix];
				index++;
				first = index;
				continue;
			}
			if (isValueToken(token, "{")) {
				const close = this.matchingIndex(index);
				if (close < 0 || close >= end) break;
				entries.push(...this.useTree(index + 1, close, path));
				index = close + 1;
				continue;
			}
			if (isValueToken(token, "*")) {
				entries.push({
					path: path.map((segment) => segment.name),
					sourceName: null,
					localName: null,
					sourceIndex: index,
					glob: true,
					first,
					last: index,
				});
				index++;
				continue;
			}
			if (!isNameToken(token)) {
				index++;
				continue;
			}
			if (isValueToken(this.tokens[index + 1], "::")) {
				path = [...path, { name: token.value, index }];
				index += 2;
				continue;
			}
			const sourcePath =
				token.value === "self" && path.length > 0 ? path : [...path, { name: token.value, index }];
			const named = sourcePath.at(-1) ?? { name: token.value, index };
			const aliased = isValueToken(this.tokens[index + 1], "as") && isNameToken(this.tokens[index + 2]);
			const localIndex = aliased ? index + 2 : index;
			entries.push({
				path: sourcePath.map((segment) => segment.name),
				sourceName: named.name,
				localName: aliased ? (this.tokens[localIndex] as RustToken).value : named.name,
				sourceIndex: index,
				localIndex,
				glob: false,
				first,
				last: localIndex,
				nameIndex: named.index,
			});
			index = localIndex + 1;
		}
		return entries;
	}
}

////////////////////////////////
//  Functions & Helpers

function rangeOf(token: RustToken): Range {
	return { start: token.start, end: token.end };
}
