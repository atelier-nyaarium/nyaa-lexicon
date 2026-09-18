// Paint facts: a projection of stored or freshly parsed facts, never a second parser.

import {
	type Declaration,
	type FileFacts,
	hashContent,
	type ModuleFactsResult,
	type PaintFacts,
	type ParseFactsResult,
	type ProviderWords,
	type Range,
	type Reference,
	type StoredComment,
	type StoredDeclaration,
	type StoredReference,
} from "@nyaa-lexicon/protocol";
import type { ProviderProbe } from "./providerProbe.js";
import { candidateDoesNotParse, noProviderOwnsForPaint } from "./refusals.js";
import type { IndexStore } from "./store.js";

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

////////////////////////////////
//  Class

/** One module's paint facts, stored or freshly parsed. The store and the probe are its whole world. */
export class PaintReads {
	constructor(
		private readonly store: IndexStore,
		private readonly probe: ProviderProbe,
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

	/** From text not yet written, parsed like a refactor plan's candidate: nothing stored, no gate held. */
	async parseFacts(module: string, text: string): Promise<ParseFactsResult> {
		const owner = this.probe.owner(module);
		if (!owner.owned) return { ok: false, reason: noProviderOwnsForPaint(module, owner.reason) };
		const words = this.probe.words(module);
		if (words === null) return { ok: false, reason: noProviderOwnsForPaint(module) };

		const candidate = await this.probe.parseCandidate(module, text);
		if (!candidate.parsed) return { ok: false, reason: candidateDoesNotParse("candidate", candidate.reason) };

		return paintFromCandidate(hashContent(text), words, candidate.facts);
	}
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
