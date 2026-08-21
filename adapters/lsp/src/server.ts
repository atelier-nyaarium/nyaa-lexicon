// The editor-facing adapter.
//
// Thin on purpose. Answers come from the same index the MCP tools read, so the two surfaces cannot
// disagree about a repository. Only the vocabulary differs: positions and URIs, not names and ids.
//
// Every read is awaited because the index is usually in another process, and taking a
// `LexiconReads` rather than a service is what keeps that invisible here.
//
// Positions are the whole translation problem. LSP counts UTF-16 code units within a line, and the
// index stores whatever the provider reported. Both are zero-based lines, so the mapping is the
// identity for every character below U+FFFF and wrong above it. That is a real limitation, stated
// here rather than discovered later in a file full of emoji.

import type { StoredDeclaration, SymbolKind } from "@nyaa-lexicon/core";
import type { LexiconReads } from "./reads.js";

////////////////////////////////
//  Interfaces & Types

export interface Position {
	line: number;
	character: number;
}

export interface Range {
	start: Position;
	end: Position;
}

export interface Location {
	uri: string;
	range: Range;
}

export interface Hover {
	contents: { kind: "markdown"; value: string };
	range?: Range;
}

export interface DocumentSymbol {
	name: string;
	kind: number;
	range: Range;
	selectionRange: Range;
	detail?: string;
	children?: DocumentSymbol[];
}

/** One row of a call hierarchy expansion. The spec names the peer `from` or `to` by direction. */
export interface CallHierarchyEntry {
	from?: TypeHierarchyItem;
	to?: TypeHierarchyItem;
	fromRanges: Range[];
}

/** What prepareTypeHierarchy returns and the two expansions take back. `data` is ours to define. */
export interface TypeHierarchyItem {
	name: string;
	kind: number;
	uri: string;
	range: Range;
	selectionRange: Range;
	detail?: string;
	/** The symbol id, carried across the round trip so an expansion needs no second position lookup. */
	data: string;
}

////////////////////////////////
//  Constants

/**
 * The LSP SymbolKind numbers, which are a wire format rather than a design of ours.
 *
 * Anything absent falls to Variable rather than to a guess: an editor renders an unknown number as
 * nothing at all, so a wrong-but-plausible kind is worse than the dullest correct one.
 */
/**
 * Keyed by SymbolKind, so a new kind fails the build here instead of rendering as something else.
 *
 * LSP has no heading, and editors' markdown servers settle on String, so an outline of a document
 * looks like every other markdown outline rather than inventing a mapping nobody renders.
 */
const SYMBOL_KIND: Record<SymbolKind, number> = {
	file: 1,
	module: 2,
	namespace: 3,
	package: 4,
	class: 5,
	method: 6,
	property: 7,
	field: 8,
	constructor: 9,
	enum: 10,
	interface: 11,
	function: 12,
	variable: 13,
	constant: 14,
	heading: 15,
	struct: 23,
	event: 24,
	operator: 25,
	typeParameter: 26,
};

////////////////////////////////
//  Functions & Helpers

/** A file URI, which is what an editor speaks. Percent-encoded per segment, so spaces survive. */
export function toUri(workspaceRoot: string, module: string): string {
	const full = `${workspaceRoot.replace(/\/+$/, "")}/${module}`;
	return `file://${full.split("/").map(encodeURIComponent).join("/").replace("%3A", ":")}`;
}

/** The absolute path a file URI names, or null for any other scheme. */
export function pathFromUri(uri: string): string | null {
	if (!uri.startsWith("file://")) return null;
	return decodeURIComponent(uri.slice("file://".length));
}

/** The inverse, back to a workspace-relative module. Null when the URI names another workspace. */
export function toModule(workspaceRoot: string, uri: string): string | null {
	const full = pathFromUri(uri);
	if (full === null) return null;
	const root = `${workspaceRoot.replace(/\/+$/, "")}/`;
	return full.startsWith(root) ? full.slice(root.length) : null;
}

function locationOf(workspaceRoot: string, declaration: StoredDeclaration): Location {
	return { uri: toUri(workspaceRoot, declaration.module), range: declaration.selectionRange };
}

function contains(range: Range, position: Position): boolean {
	if (position.line < range.start.line || position.line > range.end.line) return false;
	if (position.line === range.start.line && position.character < range.start.character) return false;
	if (position.line === range.end.line && position.character > range.end.character) return false;
	return true;
}

////////////////////////////////
//  Class

/**
 * LSP requests answered from the shared service.
 *
 * Separate from any transport, so the whole surface is testable by calling methods. Wiring it to
 * stdio is a few lines and belongs with whatever runs it.
 */
export class LspServer {
	constructor(
		private readonly service: LexiconReads,
		private readonly workspaceRoot: string,
	) {}

	/**
	 * The symbol at a position, found by containment rather than by name.
	 *
	 * Innermost wins: a method inside a class contains the cursor just as the class does, and the
	 * one an editor user means is always the tighter of the two.
	 */
	async symbolAt(uri: string, position: Position): Promise<StoredDeclaration | null> {
		const module = toModule(this.workspaceRoot, uri);
		if (module === null) return null;

		let best: StoredDeclaration | null = null;
		for (const declaration of await this.service.declarationsIn(module)) {
			if (!contains(declaration.range, position)) continue;
			if (best === null || contains(best.range, declaration.range.start)) best = declaration;
		}
		return best;
	}

	/** textDocument/definition. The declaration's NAME span, which is what an editor highlights. */
	async definition(uri: string, position: Position): Promise<Location | null> {
		const found = await this.symbolAt(uri, position);
		return found === null ? null : locationOf(this.workspaceRoot, found);
	}

	/** textDocument/references, on bound edges only. A name match would be worse than nothing here. */
	async references(uri: string, position: Position, includeDeclaration = true): Promise<Location[]> {
		const found = await this.symbolAt(uri, position);
		if (found === null) return [];

		const locations = (await this.service.findReferences(found.symbolId, 1000)).references.map((reference) => ({
			uri: toUri(this.workspaceRoot, reference.module),
			range: {
				start: { line: reference.startLine, character: reference.startCharacter },
				end: { line: reference.endLine, character: reference.endCharacter },
			},
		}));
		return includeDeclaration ? [locationOf(this.workspaceRoot, found), ...locations] : locations;
	}

	/** textDocument/hover. The signature, the doc comment, and how widely it is used. */
	async hover(uri: string, position: Position): Promise<Hover | null> {
		const found = await this.symbolAt(uri, position);
		if (found === null) return null;

		const described = await this.service.describe(found.symbolId);
		const lines = [`\`\`\`\n${found.signature ?? `${found.kind} ${found.name}`}\n\`\`\``];
		// Derived from the comment attached above it, so a hover and the file cannot disagree.
		if (described?.symbol.docComment) lines.push(described.symbol.docComment);

		const type = await this.service.typeOf(found.symbolId);
		// Only when it adds something the signature did not already say. An editor tooltip repeating
		// itself is worse than a shorter one.
		if (type.status === "inferred") lines.push(`*inferred* \`${type.display}\` from ${type.basis}`);

		// Recorded knowledge is exactly what a hover is for: what a previous reader concluded, next
		// to what the code says. Marked when its ground has moved, so stale prose never reads as
		// current. Served without counting a gap, since a hover is browsing rather than demand.
		const recalled = (await this.service.recallAnswers(found.symbolId)).find(
			(r) => r.answer.question === "describe",
		);
		if (recalled !== undefined) {
			const doubted = recalled.answer.doubt !== undefined || recalled.doubtedUpstream.length > 0;
			const mark = doubted
				? " *(doubted)*"
				: recalled.stale.length > 0 || recalled.inheritedStale.length > 0
					? " *(stale)*"
					: "";
			lines.push(`${recalled.answer.prose}${mark}`);
		}

		if (described && described.referenceCount > 0) lines.push(`Used in ${described.referenceCount} places.`);
		return { contents: { kind: "markdown", value: lines.join("\n\n") }, range: found.selectionRange };
	}

	/**
	 * textDocument/typeDefinition. Where the TYPE of the thing under the cursor is declared.
	 *
	 * Answered only when the provider gave the type a symbol id. A primitive, a union and an external
	 * class have no declaration in the indexed set, and null is the correct answer for all three
	 * rather than a jump to something adjacent.
	 */
	async typeDefinition(uri: string, position: Position): Promise<Location | null> {
		const found = await this.symbolAt(uri, position);
		if (found === null) return null;

		const type = await this.service.typeOf(found.symbolId);
		const symbolId = type.status === "unknown" ? undefined : type.symbolId;
		return symbolId === undefined ? null : this.locationOfSymbol(symbolId);
	}

	/**
	 * textDocument/implementation. What extends or implements the type under the cursor.
	 *
	 * The same rows textDocument/references reads, filtered to the two heritage roles, which is why
	 * this needed no new provider capability.
	 */
	async implementation(uri: string, position: Position): Promise<Location[]> {
		const found = await this.symbolAt(uri, position);
		if (found === null) return [];

		const { subtypes } = await this.service.typeHierarchy(found.symbolId);
		const located = await Promise.all(subtypes.map((subtype) => this.locationOfSymbol(subtype.symbolId)));
		return located.filter((location): location is Location => location !== null);
	}

	/** textDocument/prepareTypeHierarchy. The item an editor then asks to expand. */
	async prepareTypeHierarchy(uri: string, position: Position): Promise<TypeHierarchyItem[]> {
		const found = await this.symbolAt(uri, position);
		return found === null ? [] : [this.hierarchyItem(found)];
	}

	/**
	 * typeHierarchy/supertypes and /subtypes, one level each, which is what the request asks for.
	 *
	 * An editor expands lazily, so a transitive closure here would be both slower and wrong: it would
	 * render a grandparent as a parent.
	 *
	 * The symbol id travels in the item's `data`, which is the field LSP defines for exactly this and
	 * promises to hand back untouched. Re-deriving it from the item's position instead would break
	 * the moment the file was edited between the prepare and the expansion.
	 */
	async typeHierarchyStep(params: unknown, direction: "supertypes" | "subtypes"): Promise<TypeHierarchyItem[]> {
		const symbolId = (params as { item?: { data?: unknown } } | undefined)?.item?.data;
		if (typeof symbolId !== "string") return [];

		const hierarchy = await this.service.typeHierarchy(symbolId);
		const declarations = await Promise.all(
			hierarchy[direction].map((summary) => this.service.declarationOf(summary.symbolId)),
		);
		return declarations
			.filter((declaration): declaration is StoredDeclaration => declaration !== null)
			.map((declaration) => this.hierarchyItem(declaration));
	}

	/** textDocument/prepareCallHierarchy. Same item shape as the type hierarchy, same `data` trick. */
	async prepareCallHierarchy(uri: string, position: Position): Promise<TypeHierarchyItem[]> {
		const found = await this.symbolAt(uri, position);
		return found === null ? [] : [this.hierarchyItem(found)];
	}

	/**
	 * callHierarchy/incomingCalls and /outgoingCalls.
	 *
	 * `fromRanges` is always relative to the OTHER end's file in the incoming direction and to the
	 * queried symbol's file in the outgoing one, which is what the spec asks for and falls out of
	 * recording every reference at its use site.
	 */
	async callHierarchyStep(params: unknown, direction: "incoming" | "outgoing"): Promise<CallHierarchyEntry[]> {
		const symbolId = (params as { item?: { data?: unknown } } | undefined)?.item?.data;
		if (typeof symbolId !== "string") return [];

		const hierarchy = await this.service.callHierarchy(symbolId);
		const edges = direction === "incoming" ? hierarchy.incoming : hierarchy.outgoing;

		const entries: CallHierarchyEntry[] = [];
		for (const edge of edges) {
			const declaration = await this.service.declarationOf(edge.symbol.symbolId);
			if (declaration === null) continue;
			const item = this.hierarchyItem(declaration);
			entries.push(
				direction === "incoming"
					? { from: item, fromRanges: edge.ranges }
					: { to: item, fromRanges: edge.ranges },
			);
		}
		return entries;
	}

	private hierarchyItem(declaration: StoredDeclaration): TypeHierarchyItem {
		return {
			name: declaration.name,
			kind: SYMBOL_KIND[declaration.kind] ?? 13,
			uri: toUri(this.workspaceRoot, declaration.module),
			range: declaration.range,
			selectionRange: declaration.selectionRange,
			data: declaration.symbolId,
			...(declaration.signature === undefined ? {} : { detail: declaration.signature }),
		};
	}

	private async locationOfSymbol(symbolId: string): Promise<Location | null> {
		const declaration = await this.service.declarationOf(symbolId);
		return declaration === null ? null : locationOf(this.workspaceRoot, declaration);
	}

	/** textDocument/documentSymbol, nested by container so an outline reads as the file's shape. */
	async documentSymbol(uri: string): Promise<DocumentSymbol[]> {
		const module = toModule(this.workspaceRoot, uri);
		if (module === null) return [];

		const declarations = await this.service.declarationsIn(module);
		const nodes = new Map<string, DocumentSymbol>();
		for (const declaration of declarations) {
			nodes.set(declaration.symbolId, {
				name: declaration.name,
				kind: SYMBOL_KIND[declaration.kind] ?? 13,
				range: declaration.range,
				selectionRange: declaration.selectionRange,
				...(declaration.signature === undefined ? {} : { detail: declaration.signature }),
			});
		}

		const roots: DocumentSymbol[] = [];
		for (const declaration of declarations) {
			const node = nodes.get(declaration.symbolId);
			if (node === undefined) continue;
			// A container outside this file leaves the member at the top level rather than dropping it.
			const parent = declaration.containerId === undefined ? undefined : nodes.get(declaration.containerId);
			if (parent === undefined) {
				roots.push(node);
				continue;
			}
			parent.children ??= [];
			parent.children.push(node);
		}
		return roots;
	}

	/**
	 * textDocument/prepareRename, which is the request our plan step was already shaped like.
	 *
	 * LSP wants the span the editor should offer to edit, or a refusal. A plan with any blocker is
	 * a refusal, which is exactly the check the MCP side makes.
	 */
	async prepareRename(uri: string, position: Position): Promise<{ range: Range; placeholder: string } | null> {
		const found = await this.symbolAt(uri, position);
		if (found === null) return null;

		const plan = await this.service.prepareRename(found.symbolId, `${found.name}_`);
		return plan.blockers.length > 0 ? null : { range: found.selectionRange, placeholder: found.name };
	}

	/**
	 * textDocument/rename. The edits, for the EDITOR to apply.
	 *
	 * Nothing is written here, which is what LSP asks for and also what makes this safe: the editor
	 * owns its buffers, and a server writing underneath open ones is how a rename comes back as
	 * unsaved-changes conflicts.
	 *
	 * Refused while a refactor transaction is open: edits handed over mid-transaction land outside
	 * its journal, and its undo would silently revert them.
	 */
	async rename(
		uri: string,
		position: Position,
		newName: string,
	): Promise<{ changes: Record<string, Array<{ range: Range; newText: string }>> } | null> {
		const found = await this.symbolAt(uri, position);
		if (found === null) return null;
		if (await this.service.transactionOpen()) return null;

		const planned = await this.service.renameEdits(found.symbolId, newName);
		if (!planned.ok) return null;

		const changes: Record<string, Array<{ range: Range; newText: string }>> = {};
		for (const file of planned.files) {
			changes[toUri(this.workspaceRoot, file.module)] = file.edits.map((edit) => ({
				range: edit.range,
				newText: edit.newText,
			}));
		}
		return { changes };
	}
}
