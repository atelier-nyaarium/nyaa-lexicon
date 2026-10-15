import type { FileFacts } from "@nyaa-lexicon/protocol";
import { applyEdits, isWithin, sameRange } from "@nyaa-lexicon/protocol";
import type { ProviderProbe } from "./providerProbe.js";
import { ReadContext } from "./readContext.js";
import type { ReplacementPlan, WholeReplacementPlan } from "./refactorPlanner.js";
import type { Refusal } from "./refusals.js";
import {
	baseMoved,
	candidateDoesNotParse,
	editsRefused,
	noProviderOwns,
	notStored,
	replacementRenames,
	sharesId,
	sharesSpan,
	spanChanged,
} from "./refusals.js";
import { writableText } from "./sourceRead.js";
import type { SourceWorkspace, SymbolSource } from "./sourceWorkspace.js";
import type { IndexStore } from "./store.js";
import type { RefactorIssue } from "./transactions.js";

type ImpactWithin = (context: ReadContext, module: string, candidate: FileFacts) => RefactorIssue[];
type SyntaxUnchecked = (providerId: string, module: string) => RefactorIssue | null;

export class ReplacementPlanner {
	constructor(
		private readonly store: IndexStore,
		private readonly source: SourceWorkspace,
		private readonly probe: ProviderProbe,
		private readonly impactWithin: ImpactWithin,
		private readonly syntaxUnchecked: SyntaxUnchecked,
	) {}

	/**
	 * What replacing one symbol's text would do, without writing anything.
	 *
	 * Everything expensive happens here and nothing touches disk, so a caller can hold the workspace
	 * gate for the write alone. The candidate is parsed by the owning provider, which is what turns
	 * "this text is different" into "these symbols moved and these references stopped binding".
	 */
	async planReplacement(
		address: { symbolId?: string | undefined; factId?: string | undefined },
		newText: string,
		expectedSpanHash?: string,
	): Promise<ReplacementPlan> {
		const read = this.source.symbolSourceRead(address);
		if (!read.found) return { ok: false, reason: read.reason };
		const { fileText: before, ...source } = read;
		const unwritable = writableText(source.module, newText);
		if (unwritable !== null) return { ok: false, reason: unwritable };

		const context = new ReadContext(this.store);
		const guard = this.replacementGuard(context, address, source);
		if (guard) return { ok: false, reason: guard };
		if (expectedSpanHash !== undefined && source.spanHash !== expectedSpanHash) {
			return { ok: false, reason: spanChanged(source.module, source.name), stale: true };
		}

		const spliced = applyEdits(before, [{ range: source.range, newText }]);
		if ("problem" in spliced) return { ok: false, reason: editsRefused(spliced.problem) };

		const owner = this.probe.owner(source.module);
		if (!owner.owned) return { ok: false, reason: noProviderOwns(source.module) };

		// The probe restores the provider's view of the module before it returns, on every path, so
		// nothing below has to remember to.
		const candidate = await this.probe.parseCandidate(source.module, spliced.text);
		if (!candidate.parsed) return { ok: false, reason: candidateDoesNotParse("replacement", candidate.reason) };

		const renamed = this.renamedDeclaration(context, address, candidate.facts, source);
		if (renamed) return { ok: false, reason: renamed };

		const issues = this.impactWithin(context, source.module, candidate.facts);
		const unchecked = this.syntaxUnchecked(owner.providerId, source.module);
		if (unchecked !== null) issues.push(unchecked);

		return {
			ok: true,
			module: source.module,
			text: spliced.text,
			range: source.range,
			baseHash: source.contentHash,
			facts: context.seen(),
			issues,
		};
	}

	/** What writing `text` over a whole module would break, judged against the stored text; nothing is written. */
	async planWholeReplacement(args: {
		module: string;
		contentHash: string;
		text: string;
	}): Promise<WholeReplacementPlan> {
		const stored = this.store.contentHashOf(args.module);
		if (stored === null) return { ok: false, reason: notStored(args.module) };
		if (stored !== args.contentHash) return { ok: false, reason: baseMoved(args.module), stale: true };
		const unwritable = writableText(args.module, args.text);
		if (unwritable !== null) return { ok: false, reason: unwritable };
		const owner = this.probe.owner(args.module);
		if (!owner.owned) return { ok: false, reason: noProviderOwns(args.module, owner.reason) };
		const candidate = await this.probe.parseCandidate(args.module, args.text);
		if (!candidate.parsed) return { ok: false, reason: candidateDoesNotParse("replacement", candidate.reason) };

		const issues = this.impactWithin(new ReadContext(this.store), args.module, candidate.facts);
		const unchecked = this.syntaxUnchecked(owner.providerId, args.module);
		if (unchecked !== null) issues.push(unchecked);

		return { ok: true, module: args.module, baseHash: args.contentHash, issues };
	}

	/** Reasons a replacement is refused before it is even parsed. */
	private replacementGuard(
		context: ReadContext,
		address: { symbolId?: string | undefined },
		source: Extract<SymbolSource, { found: true }>,
	): Refusal | null {
		if (address.symbolId === undefined) return null;
		const held = context.heldIn(source.module);

		// Two declarations sharing an id means the store kept one and discarded the other, so the
		// address names something the index cannot tell apart.
		const sharing = held.filter((declaration) => declaration.symbolId === address.symbolId);
		if (sharing.length > 1) return sharesId(address.symbolId, source.module);

		// One statement can declare several names, giving each the same span. Replacing that span
		// would rewrite siblings the caller never addressed.
		const overlapping = held.filter((declaration) => {
			if (declaration.symbolId === address.symbolId) return false;
			if (isWithin(declaration.symbolId, address.symbolId as string)) return false;
			if (isWithin(address.symbolId as string, declaration.symbolId)) return false;
			return sameRange(declaration.range, source.range);
		});
		if (overlapping.length > 0) {
			return sharesSpan(source.name, overlapping.map((declaration) => declaration.name).join(", "));
		}

		return null;
	}

	/**
	 * A replacement that renames its own declaration, which replace must not carry out.
	 *
	 * The id embeds the name, so the old symbol simply disappears and a new one takes its place.
	 * Nothing would migrate the knowledge written about it or rewrite the callers, which is exactly
	 * what rename exists to do.
	 */
	private renamedDeclaration(
		context: ReadContext,
		address: { symbolId?: string | undefined },
		candidate: FileFacts,
		source: Extract<SymbolSource, { found: true }>,
	): Refusal | null {
		if (address.symbolId === undefined) return null;
		if (candidate.declarations.some((declaration) => declaration.symbolId === address.symbolId)) return null;

		// The id is gone, which is either a rename or a deletion. Deleting is a real refactor and is
		// allowed; the orphan check reports what still points at it. A rename is refused, because
		// only rename rewrites the callers and carries the knowledge across.
		const old = context.declaration(address.symbolId);
		const replacement = candidate.declarations.find(
			(declaration) =>
				!context.holds(source.module, declaration.symbolId) &&
				declaration.kind === old?.kind &&
				declaration.containerId === old?.containerId,
		);
		if (!replacement) return null;

		return replacementRenames(source.name, replacement.name);
	}
}
