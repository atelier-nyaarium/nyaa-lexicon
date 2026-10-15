import {
	type CommentAnchor,
	type CommentQuery,
	type CommentsResult,
	type DocQuery,
	type DocsResult,
	defined,
	type LiteralQuery,
	type LiteralsResult,
	type ModuleExclusion,
	type SharedLiteralsResult,
} from "@nyaa-lexicon/protocol";
import { type Paged, pageCounted, pageScanned, wire } from "./paging.js";
import { proseHit } from "./proseText.js";
import { ReadContext } from "./readContext.js";
import { DEFAULT_COMMENT_LIMIT, DEFAULT_LITERAL_LIMIT, MAX_COMMENT_LIMIT, REGEX_SCAN_LIMIT } from "./readLimits.js";
import { contains, filterFor, resolveScope } from "./scope.js";
import { compileSearchRegex } from "./search.js";
import type { IndexStore, StoredComment, StoredDoc, StoredLiteral } from "./store.js";

/** Lines of a comment carried back. A banner runs to hundreds and no caller asked for them. */
const COMMENT_PREVIEW_LINES = 8;

/** And a width, because a minified file's one comment is a single line of tens of thousands. */
const COMMENT_PREVIEW_WIDTH = 200;

/**
 * Capped, and says how much it cut, so a caller never reads a preview as the whole comment.
 *
 * Bounded by width as well as by lines. A minified file's single comment can be one line and
 * tens of thousands of characters, which a line cap does nothing about.
 */
function preview(raw: string): string {
	const lines = raw.split("\n");
	const kept = lines
		.slice(0, COMMENT_PREVIEW_LINES)
		.map((line) => (line.length > COMMENT_PREVIEW_WIDTH ? `${line.slice(0, COMMENT_PREVIEW_WIDTH)}...` : line));
	const rest = lines.length - kept.length;
	const body = kept.join("\n");
	return rest === 0 ? body : `${body}\n... ${rest} more line${rest === 1 ? "" : "s"}`;
}

/**
 * Uses the paging strategy's count; capped results report a lower bound.
 */
function page(query: LiteralQuery, paged: Paged<StoredLiteral>): LiteralsResult {
	return { query, literals: paged.items, ...wire(paged) };
}

/** The query echoed, with `excluded` only when one ran. */
function asked<Q extends { excluded?: true | undefined }>(query: Q, exclude: ModuleExclusion | undefined): Q {
	const { excluded: _echo, ...rest } = query;
	return (exclude === undefined ? rest : { ...rest, excluded: true }) as Q;
}

function anchorOf(context: ReadContext, symbolId: string): CommentAnchor | null {
	const declaration = context.declaration(symbolId);
	if (declaration === null) return null;
	return {
		symbolId,
		name: declaration.name,
		kind: declaration.kind,
		...defined({ signature: declaration.signature }),
		line: declaration.range.start.line,
	};
}

////////////////////////////////
//  Text fact reads

export class TextFactReadModel {
	constructor(private readonly store: IndexStore) {}

	/**
	 * Find literal values: an exact one, a regex, or a numeric range.
	 *
	 * This is the tier that makes text searchable as facts. A name inside a string is not a
	 * reference and never was, so it appears in no other table: a rename could leave `__all__`
	 * stale and a GDScript signal reached by `connect("name")` was invisible entirely.
	 *
	 * An exact value and a numeric range are indexed reads. A regex is not, because SQLite has no
	 * REGEXP here, so it reads a bounded page and says when it stopped early.
	 */
	findLiterals(query: LiteralQuery, limit = DEFAULT_LITERAL_LIMIT, exclude?: ModuleExclusion): LiteralsResult {
		const context = new ReadContext(this.store);
		const scope = query.within === undefined ? undefined : resolveScope(context, query.within);
		const scoped = scope === undefined ? undefined : filterFor(scope);
		const base = {
			kind: query.kind,
			key: query.key,
			module: query.module,
			scope: scoped,
			hidden: this.store.hiddenModules(exclude),
		};
		const echo = asked(query, exclude);
		const ways = [query.value, query.regex, query.min ?? query.max].filter((each) => each !== undefined);
		if (ways.length > 1) throw new Error("give one of a value, a regex, or a numeric range, not several");
		if (query.value !== undefined) {
			const found = this.store.literalsWhere(
				{ ...base, value: query.value },
				scope === undefined ? limit : REGEX_SCAN_LIMIT,
			);
			const matched =
				scope === undefined ? found : found.filter((literal) => context.literalWithin(scope, literal));
			return page(
				echo,
				scope === undefined
					? pageCounted(matched, limit, this.store.countLiteralsWhere({ ...base, value: query.value }))
					: pageScanned(matched, limit, { read: found.length, cap: REGEX_SCAN_LIMIT }),
			);
		}

		if (query.min !== undefined || query.max !== undefined) {
			const low = query.min ?? Number.NEGATIVE_INFINITY;
			const high = query.max ?? Number.POSITIVE_INFINITY;
			const found = this.store.literalsWhere(
				{ ...base, low, high },
				scope === undefined ? limit : REGEX_SCAN_LIMIT,
			);
			const matched =
				scope === undefined ? found : found.filter((literal) => context.literalWithin(scope, literal));
			return page(
				echo,
				scope === undefined
					? pageCounted(matched, limit, this.store.countLiteralsWhere({ ...base, low, high }))
					: pageScanned(matched, limit, { read: found.length, cap: REGEX_SCAN_LIMIT }),
			);
		}

		if (query.regex !== undefined) {
			const expression = compileSearchRegex(query.regex);
			const scanned = this.store.literalsWhere({ ...base, kind: query.kind ?? "string" }, REGEX_SCAN_LIMIT);
			const matched = scanned.filter(
				(literal) =>
					expression.test(literal.value) && (scope === undefined || context.literalWithin(scope, literal)),
			);
			return page(echo, pageScanned(matched, limit, { read: scanned.length, cap: REGEX_SCAN_LIMIT }));
		}

		// The refusal shows the shapes, because naming the parameters alone was measured to fail: a
		// caller trying `text:` read the naming sentence and still never found `value`.
		throw new Error(
			'give a value, a regex, or a numeric range, e.g. { value: "cycleCheckpoint" } or { regex: "/^cycle/" } or { min: 0, max: 100 }',
		);
	}

	/**
	 * Find what was WRITTEN about the code, by substring or regex over the normalized text.
	 *
	 * The tier that makes doctrine reachable. Every other tier answers "what is this code"; this one
	 * answers "what did someone say about it", which was the question that always fell back to grep.
	 *
	 * Substring is an indexed-ish read; a regex is not, because SQLite has no REGEXP here, so it
	 * reads a bounded page and says when it stopped early.
	 */
	findComments(query: CommentQuery, requested = DEFAULT_COMMENT_LIMIT, exclude?: ModuleExclusion): CommentsResult {
		// Both is not a narrower search, it is two searches, and answering one of them silently
		// picks a winner the caller never chose.
		if (query.text !== undefined && query.regex !== undefined) {
			throw new Error("give a text or a regex, not both");
		}
		// Rounded and NaN-guarded, not just bounded: a fractional limit reaches SQLite as a type it
		// refuses, and the caller sees a datatype error where a clamp belonged.
		const limit = Number.isFinite(requested)
			? Math.min(Math.max(Math.floor(requested), 1), MAX_COMMENT_LIMIT)
			: DEFAULT_COMMENT_LIMIT;
		const filter = {
			...defined({ form: query.form, module: query.module }),
			hidden: this.store.hiddenModules(exclude),
		};
		const echo = asked(query, exclude);
		const context = new ReadContext(this.store);
		const scope = query.within === undefined ? undefined : resolveScope(context, query.within);

		if (query.text !== undefined) {
			// The same substring match as the unscoped read, so a scope never changes what text means.
			if (scope !== undefined) {
				const scanned = this.store.commentsContaining(query.text, REGEX_SCAN_LIMIT, filter);
				const matched = scanned.filter(
					(comment) => comment.anchorId !== null && contains(scope, comment.anchorId),
				);
				return this.pageComments(
					context,
					echo,
					pageScanned(matched, limit, { read: scanned.length, cap: REGEX_SCAN_LIMIT }),
				);
			}
			const found = this.store.commentsContaining(query.text, limit, filter);
			const total = this.store.countCommentsContaining(query.text, filter);
			return this.pageComments(context, echo, pageCounted(found, limit, total));
		}

		if (query.regex !== undefined) {
			const expression = compileSearchRegex(query.regex);
			const scanned = this.store.commentsToScan(REGEX_SCAN_LIMIT, filter);
			const matched = scanned.filter(
				(comment) =>
					expression.test(comment.normalized) &&
					(scope === undefined || (comment.anchorId !== null && contains(scope, comment.anchorId))),
			);
			return this.pageComments(
				context,
				echo,
				pageScanned(matched, limit, { read: scanned.length, cap: REGEX_SCAN_LIMIT }),
			);
		}

		// Neither given: the whole tier, filtered. Useful for "every comment in this module".
		if (query.form !== undefined || query.module !== undefined || query.within !== undefined) {
			if (scope !== undefined) {
				const scanned = this.store.commentsToScan(REGEX_SCAN_LIMIT, filter);
				const matched = scanned.filter(
					(comment) => comment.anchorId !== null && contains(scope, comment.anchorId),
				);
				return this.pageComments(
					context,
					echo,
					pageScanned(matched, limit, { read: scanned.length, cap: REGEX_SCAN_LIMIT }),
				);
			}
			const found = this.store.commentsToScan(limit, filter);
			return this.pageComments(context, echo, pageCounted(found, limit, this.store.countComments(filter)));
		}

		throw new Error('give a text or a regex, e.g. { text: "refuses rather than" } or { regex: "/TODO|FIXME/" }');
	}

	private pageComments(context: ReadContext, query: CommentQuery, paged: Paged<StoredComment>): CommentsResult {
		const shown = paged.items.map((comment) => ({
			factId: comment.factId,
			module: comment.module,
			range: comment.range,
			form: comment.form,
			placement: comment.placement,
			raw: preview(comment.raw),
			anchor: comment.anchorId === null ? null : anchorOf(context, comment.anchorId),
		}));
		return { query, comments: shown, ...wire(paged) };
	}

	/**
	 * Find what a document SAYS, by substring or regex over the normalized text.
	 *
	 * Separate from `findComments` because the ANSWER differs, not the data: a comment result names
	 * the symbol it documents, and this one names the heading path it was found under.
	 */
	findDocs(query: DocQuery, requested = DEFAULT_COMMENT_LIMIT, exclude?: ModuleExclusion): DocsResult {
		if (query.text !== undefined && query.regex !== undefined) {
			throw new Error("give a text or a regex, not both");
		}
		const limit = Number.isFinite(requested)
			? Math.min(Math.max(Math.floor(requested), 1), MAX_COMMENT_LIMIT)
			: DEFAULT_COMMENT_LIMIT;
		const filter = {
			...defined({ fenced: query.fenced, module: query.module }),
			hidden: this.store.hiddenModules(exclude),
		};
		const echo = asked(query, exclude);

		if (query.text !== undefined) {
			const found = this.store.docsContaining(query.text, limit, filter);
			const total = this.store.countDocsContaining(query.text, filter);
			return this.pageDocs(echo, pageCounted(found, limit, total));
		}

		if (query.regex !== undefined) {
			const expression = compileSearchRegex(query.regex);
			const scanned = this.store.docsToScan(REGEX_SCAN_LIMIT, filter);
			const matched = scanned.filter((region) => expression.test(region.normalized));
			return this.pageDocs(
				echo,
				pageScanned(matched, limit, { read: scanned.length, cap: REGEX_SCAN_LIMIT }),
				expression,
			);
		}

		// Neither given: the whole tier, filtered. Useful for "every region in this document".
		if (query.fenced !== undefined || query.module !== undefined) {
			const found = this.store.docsToScan(limit, filter);
			return this.pageDocs(echo, pageCounted(found, limit, this.store.countDocs(filter)));
		}

		throw new Error('give a text or a regex, e.g. { text: "band-aid" } or { regex: "/TODO|FIXME/" }');
	}

	private pageDocs(
		query: DocQuery,
		paged: Paged<StoredDoc>,
		pattern?: { find(text: string): string | null },
	): DocsResult {
		const context = new ReadContext(this.store);
		const paths = new Map<string, string[]>();
		const shown = paged.items.map((region) => {
			const anchor = region.anchorId;
			if (anchor !== null && !paths.has(anchor)) paths.set(anchor, this.headingPathIn(context, anchor));
			const match = query.text ?? pattern?.find(region.normalized) ?? undefined;
			const relative = match === undefined ? undefined : proseHit(region.raw, match);
			const hit =
				relative === undefined
					? undefined
					: {
							line: region.range.start.line + relative.line,
							character:
								relative.line === 0
									? region.range.start.character + relative.character
									: relative.character,
						};
			return {
				factId: region.factId,
				module: region.module,
				range: region.range,
				fenced: region.fenced,
				raw: preview(region.raw),
				headingPath: anchor === null ? [] : (paths.get(anchor) ?? []),
				...defined({ hit }),
			};
		});
		return { query, docs: shown, ...wire(paged) };
	}

	/**
	 * The headings above a symbol, outermost first. Owned here so no renderer rebuilds the walk.
	 *
	 * HEADINGS only, and only from ONE module. An anchor is any string on the wire, so a provider
	 * naming a function, or a container in another file, would otherwise put either inside something
	 * called a heading path: the answer being wrong rather than absent. Stopping keeps what is real.
	 *
	 * The context's walk is bounded, so an id containing itself stops rather than hanging.
	 */
	headingPath(symbolId: string): string[] {
		return this.headingPathIn(new ReadContext(this.store), symbolId);
	}

	private headingPathIn(context: ReadContext, symbolId: string): string[] {
		const start = context.declaration(symbolId);
		if (start === null || start.kind !== "heading") return [];
		const above = context.ancestorsOf(
			start,
			(container) => container.kind === "heading" && container.module === start.module,
		);
		return [start, ...above].map((heading) => heading.name).reverse();
	}

	/** The prose of one section, which is how describe answers about a heading. */
	docsFor(symbolId: string): StoredDoc[] {
		return this.store.docsAnchoredTo(symbolId);
	}

	/** Values written in more than one file, which is the strongest textual signal of a relationship. */
	sharedLiterals(minimumFiles = 2, limit = DEFAULT_LITERAL_LIMIT, exclude?: ModuleExclusion): SharedLiteralsResult {
		const rows = this.store.sharedLiterals(minimumFiles, limit, this.store.hiddenModules(exclude));
		return exclude === undefined ? rows : rows.map((row) => ({ ...row, excluded: true }));
	}
}
