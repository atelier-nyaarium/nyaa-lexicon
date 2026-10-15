// Every question answered from the index alone.
//
// A store-backed facade, held by a residue test. Queries never start providers or touch the disk.

import {
	type CallHierarchy,
	type CommentQuery,
	type CommentsResult,
	type DescribeResult,
	type DocQuery,
	type DocsResult,
	defined,
	GROUPING_KINDS,
	type GraphSummary,
	type LiteralQuery,
	type LiteralsResult,
	type ModuleExclusion,
	type MostReferencedResult,
	type ReferencesResult,
	type ScopeSymbol,
	type ScopeSymbols,
	type SearchSymbolsResult,
	type SharedLiteralsResult,
	type SymbolEdges,
	type SymbolSummary,
	type TypeHierarchy,
	type UsesFromResult,
} from "@nyaa-lexicon/protocol";
import type { NamespaceTarget } from "./edges.js";
import { GraphReadModel } from "./graphReads.js";
import { inSourceOrder } from "./locals.js";
import { pageProbed, pageScanned, wire } from "./paging.js";
import { ReadContext, toSummary } from "./readContext.js";
import {
	DEFAULT_COMMENT_LIMIT,
	DEFAULT_LITERAL_LIMIT,
	DEFAULT_REFERENCE_LIMIT,
	REGEX_SCAN_LIMIT,
} from "./readLimits.js";
import { filterFor, resolveScope, strictlyContains } from "./scope.js";
import {
	type FileNotes,
	HiddenModules,
	type IndexStore,
	type StoredComment,
	type StoredDeclaration,
	type StoredDoc,
} from "./store.js";
import { TextFactReadModel } from "./textFactReads.js";

export type {
	AnswerTier,
	AttachedComment,
	CallHierarchy,
	CallHierarchyEdge,
	CommentAnchor,
	CommentQuery,
	CommentsResult,
	DescribeResult,
	DocQuery,
	DocsResult,
	FoundComment,
	FoundDoc,
	GraphSummary,
	LiteralQuery,
	LiteralsResult,
	ReferencesResult,
	ReferenceUse,
	SymbolSummary,
	TypeHierarchy,
	UsesFromResult,
} from "@nyaa-lexicon/protocol";

export {
	DEFAULT_COMMENT_LIMIT,
	DEFAULT_LITERAL_LIMIT,
	DEFAULT_REFERENCE_LIMIT,
	MAX_COMMENT_LIMIT,
	REGEX_SCAN_LIMIT,
} from "./readLimits.js";

////////////////////////////////
//  Constants & Helpers

/** Notes shown on describe. A long body's asides would otherwise crowd out its structure. */
const DESCRIBE_NOTE_LIMIT = 10;

////////////////////////////////
//  Class

/** Read queries against one index. Usable alone by anything holding a store. */
export class IndexReadModel {
	private readonly textFacts: TextFactReadModel;
	private readonly graph: GraphReadModel;

	constructor(private readonly store: IndexStore) {
		// Initialize readers from the facade's store.
		this.textFacts = new TextFactReadModel(store);
		this.graph = new GraphReadModel(store);
	}

	/** Symbols matching a name, so a caller holding a name rather than an id can start. */
	findByName(name: string, module?: string): SymbolSummary[] {
		const matches =
			module === undefined
				? this.store.declarationsNamed(name)
				: this.store.declarationsIn(module).filter((d) => d.name === name);
		return matches.map(toSummary);
	}

	/** A scope's declarations, members before the declaration holding them. */
	scopeSymbols(scope: {
		symbolId?: string | undefined;
		module?: string | undefined;
		members?: boolean | undefined;
		includeLocals?: boolean | undefined;
	}): ScopeSymbols | null {
		const context = new ReadContext(this.store);
		const root = scope.symbolId === undefined ? null : context.declaration(scope.symbolId);
		if (scope.symbolId !== undefined && root === null) return null;
		const module = root?.module ?? scope.module;
		if (module === undefined) return { symbols: [], localsExcluded: 0 };

		const symbols: ScopeSymbol[] = [];
		let localsExcluded = 0;
		const visited = new Set<string>();
		const visitMembers = (holder: string | undefined, depth: number) => {
			for (const member of context.membersOf(module, holder)) {
				if (scope.includeLocals !== true && context.isLocal(member)) {
					localsExcluded += context.descendantIds(member.symbolId).size;
					continue;
				}
				visit(member, depth, true);
			}
		};
		const visit = (declaration: StoredDeclaration, depth: number, withMembers: boolean) => {
			if (visited.has(declaration.symbolId)) return;
			visited.add(declaration.symbolId);
			if (withMembers) visitMembers(declaration.symbolId, depth + 1);
			symbols.push({ symbol: toSummary(declaration), depth });
		};
		if (root === null) visitMembers(undefined, 0);
		else if (!GROUPING_KINDS.has(root.kind)) visit(root, 0, scope.members === true);
		else if (scope.members === true) visitMembers(root.symbolId, 0);
		return { symbols, localsExcluded };
	}

	/**
	 * What a symbol is, plus its surface and how used it is.
	 *
	 * The member list is the compression tier: a four-hundred-line class answers as its signature
	 * surface, which is the thing that beats reading the file.
	 */
	describe(symbolId: string): DescribeResult | null {
		const context = new ReadContext(this.store);
		const declaration = context.declaration(symbolId);
		if (!declaration) return null;

		// Members render as one line each and carry no prose, so deriving their documentation would
		// be one query per member for text nothing prints.
		const members = context.declaredChildren(symbolId).map(toSummary);

		// Leading is excluded because it IS the documentation printed above. What is left is the
		// prose a reader would only find by opening the file: a note beside the code, or one written
		// inside the body. Capped, because a long function's body notes would otherwise crowd out
		// everything else describe exists to say.
		const attached = inSourceOrder(context.ownedIds(symbolId), (id) =>
			this.store.commentsAnchoredTo(id).filter((comment) => id !== symbolId || comment.form !== "leading"),
		);
		const comments = attached.slice(0, DESCRIBE_NOTE_LIMIT).map((comment) => ({
			form: comment.form,
			placement: comment.placement,
			line: comment.range.start.line,
			text: comment.normalized,
		}));

		// A heading has no body, so its prose is what a code symbol's body would be.
		const regions = declaration.kind === "heading" ? this.store.docsAnchoredTo(symbolId) : [];
		const prose = regions.slice(0, DESCRIBE_NOTE_LIMIT).map((region) => ({
			line: region.range.start.line,
			fenced: region.fenced,
			text: region.normalized,
		}));
		const moduleRole = this.store.roleOf(declaration.module);

		return {
			symbol: this.withDocumentation(toSummary(declaration)),
			members,
			...(prose.length === 0 ? {} : { prose }),
			...(regions.length > prose.length ? { moreProse: regions.length - prose.length } : {}),
			referenceCount: this.store.usesTo(symbolId).length,
			graph: this.graphSummary(context, symbolId),
			hierarchy: this.hierarchyOf(context, symbolId),
			...(comments.length === 0 ? {} : { comments }),
			...(attached.length > comments.length ? { moreComments: attached.length - comments.length } : {}),
			...(moduleRole === null ? {} : { moduleRole }),
			tier: "bound",
		};
	}

	/**
	 * Projects the leading attached comment into a symbol summary.
	 *
	 * The summary uses the stored normalized text, with comment markers removed and wrapping joined.
	 */
	private withDocumentation(summary: SymbolSummary): SymbolSummary {
		const leading = this.store.commentsAnchoredTo(summary.symbolId).find((item) => item.form === "leading");
		if (leading === undefined || leading.normalized === "") return summary;
		return { ...summary, docComment: leading.normalized };
	}

	/** Everything written about one symbol, in source order. */
	commentsFor(symbolId: string): StoredComment[] {
		return this.store.commentsAnchoredTo(symbolId);
	}

	/** Every comment, for a caller that must count or match them itself. */
	commentsToScan(scanLimit: number): StoredComment[] {
		return this.store.commentsToScan(scanLimit, { hidden: HiddenModules.none });
	}

	/** One declaration with its ranges, which `describe` deliberately does not carry. */
	declarationOf(symbolId: string): StoredDeclaration | null {
		return this.store.declaration(symbolId);
	}

	/** Everything declared in one file, in source order. What an editor outline is built from. */
	declarationsIn(module: string): StoredDeclaration[] {
		return this.store.declarationsIn(module);
	}

	/** A file's declared symbols, locals excluded, with use counts. */
	outline(module: string): SymbolSummary[] {
		const context = new ReadContext(this.store);
		const counts = this.store.useCountsIn(module);
		return context
			.heldIn(module)
			.filter((declaration) => !context.isLocal(declaration))
			.map((declaration) => ({
				...toSummary(declaration),
				referenceCount: counts.get(declaration.symbolId) ?? 0,
			}));
	}

	fileNotes(module: string): FileNotes {
		return this.store.fileNotes(module);
	}

	/** Search declared symbols by a name substring or regular expression. */
	searchSymbols(
		text: string | undefined,
		options: {
			regex?: string | undefined;
			kind?: string | undefined;
			module?: string | undefined;
			within?: string | undefined;
			limit?: number | undefined;
			exclude?: ModuleExclusion | undefined;
		} = {},
	): SearchSymbolsResult {
		if (text !== undefined && options.regex !== undefined) throw new Error(`Set at most one of text or regex.`);
		// No pattern lists what the other filters narrow to.
		if ([text, options.regex, options.kind, options.module, options.within].every((each) => each === undefined)) {
			throw new Error(`Set text, regex, kind, module or within.`);
		}
		const scope =
			options.within === undefined ? undefined : resolveScope(new ReadContext(this.store), options.within);
		const scoped = scope === undefined ? undefined : filterFor(scope);
		const found = this.store.searchSymbols(text, {
			...defined({ regex: options.regex, kind: options.kind, module: options.module, scope: scoped }),
			limit: options.within === undefined ? (options.limit ?? DEFAULT_REFERENCE_LIMIT) + 1 : REGEX_SCAN_LIMIT,
			hidden: this.store.hiddenModules(options.exclude),
		});
		const paged =
			scope === undefined
				? pageProbed(found, options.limit ?? DEFAULT_REFERENCE_LIMIT)
				: pageScanned(
						found.filter((row) => strictlyContains(scope, row.symbolId)),
						options.limit ?? DEFAULT_REFERENCE_LIMIT,
						{
							read: found.length,
							cap: REGEX_SCAN_LIMIT,
						},
					);
		return {
			text,
			...defined({ regex: options.regex }),
			symbols: paged.items.map(toSummary),
			...(options.exclude === undefined ? {} : { excluded: true }),
			...wire(paged),
		};
	}

	findReferences(
		symbolId: string,
		limit = DEFAULT_REFERENCE_LIMIT,
		within?: string,
		module?: string,
	): ReferencesResult {
		return this.graph.findReferences(symbolId, limit, within, module);
	}

	usesFrom(symbolId: string, limit = DEFAULT_REFERENCE_LIMIT): UsesFromResult {
		return this.graph.usesFrom(symbolId, limit);
	}

	findLiterals(query: LiteralQuery, limit = DEFAULT_LITERAL_LIMIT, exclude?: ModuleExclusion): LiteralsResult {
		return this.textFacts.findLiterals(query, limit, exclude);
	}

	findComments(query: CommentQuery, requested = DEFAULT_COMMENT_LIMIT, exclude?: ModuleExclusion): CommentsResult {
		return this.textFacts.findComments(query, requested, exclude);
	}

	findDocs(query: DocQuery, requested = DEFAULT_COMMENT_LIMIT, exclude?: ModuleExclusion): DocsResult {
		return this.textFacts.findDocs(query, requested, exclude);
	}

	headingPath(symbolId: string): string[] {
		return this.textFacts.headingPath(symbolId);
	}

	/** The prose of one section, which is how describe answers about a heading. */
	docsFor(symbolId: string): StoredDoc[] {
		return this.textFacts.docsFor(symbolId);
	}

	/** Values written in more than one file, which is the strongest textual signal of a relationship. */
	sharedLiterals(minimumFiles = 2, limit = DEFAULT_LITERAL_LIMIT, exclude?: ModuleExclusion): SharedLiteralsResult {
		return this.textFacts.sharedLiterals(minimumFiles, limit, exclude);
	}

	private graphSummary(context: ReadContext, symbolId: string): GraphSummary {
		return this.graph.graphSummaryForDescribe(context, symbolId);
	}

	typeHierarchy(symbolId: string, maxDepth = 16): TypeHierarchy {
		return this.graph.typeHierarchy(symbolId, maxDepth);
	}

	private hierarchyOf(context: ReadContext, symbolId: string, maxDepth = 16): TypeHierarchy {
		return this.graph.hierarchyForDescribe(context, symbolId, maxDepth);
	}

	callHierarchy(symbolId: string): CallHierarchy {
		return this.graph.callHierarchy(symbolId);
	}

	symbolEdges(
		symbolId: string,
		namespaces: ReadonlyMap<string, NamespaceTarget>,
		limit = DEFAULT_REFERENCE_LIMIT,
	): SymbolEdges {
		return this.graph.symbolEdges(symbolId, namespaces, limit);
	}

	mostReferenced(limit = 20): MostReferencedResult {
		return this.graph.mostReferenced(limit);
	}
}
