// Paint facts: a projection of stored or freshly parsed facts, never a second parser.

import {
	type Declaration,
	type FileFacts,
	hashContent,
	type ModuleFactsResult,
	type PaintFacts,
	type ParseFactsResult,
	type Position,
	type ProviderWords,
	type Range,
	type Reference,
	type StoredComment,
	type StoredDeclaration,
	type StoredReference,
	type SymbolAtReply,
	type SymbolAtResult,
} from "@nyaa-lexicon/protocol";
import type { CandidateParse, ProviderProbe } from "./providerProbe.js";
import { candidateDoesNotParse, noProviderOwnsForPaint } from "./refusals.js";
import type { IndexStore } from "./store.js";

////////////////////////////////
//  Constants

/** Candidates kept for cursor moves over unchanged text. */
const CANDIDATE_CAPACITY = 8;

////////////////////////////////
//  Functions & Helpers

/** A declaration's paint range is its NAME, the selection range, never its body. */
function declarationRange(declaration: { range: Range; selectionRange?: Range | undefined }): Range {
	return declaration.selectionRange ?? declaration.range;
}

/** A stored reference's flattened columns, as a Range. */
function storedReferenceRange(reference: StoredReference): Range {
	return {
		start: { line: reference.startLine, character: reference.startCharacter },
		end: { line: reference.endLine, character: reference.endCharacter },
	};
}

function paintDeclarations(
	declarations: readonly Declaration[] | readonly StoredDeclaration[],
): PaintFacts["declarations"] {
	return declarations.map((declaration) => ({ kind: declaration.kind, range: declarationRange(declaration) }));
}

function paintStoredReferences(references: readonly StoredReference[]): PaintFacts["references"] {
	return references.map((reference) => ({
		role: reference.role,
		range: storedReferenceRange(reference),
		bound: reference.targetId !== null,
	}));
}

function paintCandidateReferences(references: readonly Reference[]): PaintFacts["references"] {
	return references.map((reference) => ({
		role: reference.role,
		range: reference.range,
		bound: reference.binding.status === "bound",
	}));
}

/** A literal's kind and range, the same shape a stored row and a fresh candidate both carry. */
function paintLiterals(
	literals: readonly { kind: PaintFacts["literals"][number]["kind"]; range: Range }[],
): PaintFacts["literals"] {
	return literals.map((literal) => ({ kind: literal.kind, range: literal.range }));
}

function paintStoredComments(comments: readonly StoredComment[]): PaintFacts["comments"] {
	return comments.map((comment) => ({ range: comment.range }));
}

function before(a: Position, b: Position): boolean {
	return a.line < b.line || (a.line === b.line && a.character < b.character);
}

/** `end` counts, so a cursor just past a name still means it. */
function covers(range: Range, position: Position, endCounts: boolean): boolean {
	if (before(position, range.start)) return false;
	return endCounts ? !before(range.end, position) : before(position, range.end);
}

function inside(inner: Range, outer: Range): boolean {
	return !before(inner.start, outer.start) && !before(outer.end, inner.end);
}

/**
 * The target a bound reference under `position` names, else the innermost declaration around it.
 * A reference strictly under the cursor wins over one ending at it.
 */
export function pickSymbol(
	references: readonly { range: Range; target: string | null }[],
	declarations: readonly { range: Range; symbolId: string }[],
	position: Position,
): { symbolId: string; via: "reference" | "declaration" } | null {
	const bound = references.filter((reference) => reference.target !== null);
	const under =
		bound.find((reference) => covers(reference.range, position, false)) ??
		bound.find((reference) => covers(reference.range, position, true));
	if (under?.target != null) return { symbolId: under.target, via: "reference" };

	let innermost: { range: Range; symbolId: string } | null = null;
	for (const declaration of declarations) {
		if (!covers(declaration.range, position, true)) continue;
		if (innermost === null || inside(declaration.range, innermost.range)) innermost = declaration;
	}
	return innermost === null ? null : { symbolId: innermost.symbolId, via: "declaration" };
}

////////////////////////////////
//  Class

/** One module's paint facts, stored or freshly parsed. The store and the probe are its whole world. */
export class PaintReads {
	/** Oldest first; keyed by module, text and index generation, since a candidate binds against the index. */
	private readonly candidates = new Map<string, CandidateParse>();

	constructor(
		private readonly store: IndexStore,
		private readonly probe: ProviderProbe,
		private readonly generation: () => number,
	) {}

	/** From the store's rows for one module. Refused the same way `fileNotes` refuses an unindexed one. */
	moduleFacts(module: string): ModuleFactsResult {
		const depth = this.store.depthOf(module);
		if (depth === null) return { module, known: false, reason: "notIndexed" };
		const words = this.probe.words(module);
		if (words === null) return { module, known: false, reason: "unowned" };

		return {
			module,
			known: true,
			depth,
			contentHash: this.store.contentHashOf(module),
			words,
			declarations: paintDeclarations(this.store.declarationsIn(module)),
			references: paintStoredReferences(this.store.referencesIn(module)),
			literals: paintLiterals(this.store.literalsIn(module)),
			comments: paintStoredComments(this.store.commentsIn(module)),
		};
	}

	/** From text not yet written, parsed like a refactor plan's candidate: nothing stored. Caller holds the read gate. */
	async parseFacts(module: string, text: string): Promise<ParseFactsResult> {
		const owner = this.probe.owner(module);
		if (!owner.owned) return { ok: false, reason: noProviderOwnsForPaint(module, owner.reason) };
		const words = this.probe.words(module);
		if (words === null) return { ok: false, reason: noProviderOwnsForPaint(module) };

		const candidate = await this.candidate(module, text);
		if (!candidate.parsed) return { ok: false, reason: candidateDoesNotParse("candidate", candidate.reason) };

		return paintFromCandidate(hashContent(text), words, candidate.facts);
	}

	/**
	 * The symbol a cursor means: from the stored facts when they hold the caller's bytes, else from a
	 * kept or freshly parsed candidate, else `needsText`. An unstored module is final. Handed text
	 * names its own bytes. Caller holds the read gate.
	 */
	async symbolAt(request: {
		module: string;
		position: Position;
		contentHash?: string | undefined;
		text?: string | undefined;
	}): Promise<SymbolAtReply> {
		const { module, position, text } = request;
		const stored = this.store.contentHashOf(module);
		if (this.store.depthOf(module) === null || stored === null) {
			return this.probe.owner(module).owned ? { found: false, reason: "notIndexed" } : this.unowned(module);
		}
		const contentHash = text === undefined ? request.contentHash : hashContent(text);
		if (contentHash === undefined || contentHash === stored) {
			const references = this.store
				.referencesIn(module)
				.map((reference) => ({ range: storedReferenceRange(reference), target: reference.targetId }));
			return picked(pickSymbol(references, this.store.declarationsIn(module), position), stored);
		}
		if (!this.probe.owner(module).owned) return this.unowned(module);
		const candidate =
			this.kept(module, contentHash) ?? (text === undefined ? null : await this.parsed(module, text));
		if (candidate === null) return { needsText: true };
		if (!candidate.parsed) return { found: false, reason: "unparsed", contentHash, detail: candidate.reason };
		const references = candidate.facts.references.map((reference) => ({
			range: reference.range,
			target: reference.binding.status === "bound" ? reference.binding.symbolId : null,
		}));
		return picked(pickSymbol(references, candidate.facts.declarations, position), contentHash);
	}

	private unowned(module: string): SymbolAtResult {
		const owner = this.probe.owner(module);
		const reason = owner.owned ? undefined : owner.reason;
		return { found: false, reason: "unowned", detail: noProviderOwnsForPaint(module, reason) };
	}

	private async candidate(module: string, text: string): Promise<CandidateParse> {
		return this.kept(module, hashContent(text)) ?? this.parsed(module, text);
	}

	private kept(module: string, contentHash: string): CandidateParse | null {
		const key = candidateKey(module, contentHash, this.generation());
		const kept = this.candidates.get(key);
		if (kept === undefined) return null;
		this.candidates.delete(key);
		this.candidates.set(key, kept);
		return kept;
	}

	private async parsed(module: string, text: string): Promise<CandidateParse> {
		const parsed = await this.probe.parseCandidate(module, text);
		// A refusal may be the provider's outage, not the text's.
		if (!parsed.parsed) return parsed;
		this.candidates.set(candidateKey(module, hashContent(text), this.generation()), parsed);
		for (const oldest of this.candidates.keys()) {
			if (this.candidates.size <= CANDIDATE_CAPACITY) break;
			this.candidates.delete(oldest);
		}
		return parsed;
	}
}

function candidateKey(module: string, contentHash: string, generation: number): string {
	return [module, contentHash, generation].join("\n");
}

function picked(
	symbol: { symbolId: string; via: "reference" | "declaration" } | null,
	contentHash: string,
): SymbolAtResult {
	return symbol === null
		? { found: false, reason: "noSymbol", contentHash }
		: { found: true, ...symbol, contentHash };
}

function paintFromCandidate(contentHash: string, words: ProviderWords, facts: FileFacts): ParseFactsResult {
	return {
		ok: true,
		contentHash,
		words,
		// parseCandidate asks parseFile with no depth, which a provider answers as full.
		depth: "full",
		declarations: paintDeclarations(facts.declarations),
		references: paintCandidateReferences(facts.references),
		literals: paintLiterals(facts.literals),
		comments: (facts.comments ?? []).map((comment) => ({ range: comment.range })),
	};
}
