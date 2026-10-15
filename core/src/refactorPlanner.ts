// Working out what a refactor WOULD do, and writing none of it.
//
// Nothing here writes or reindexes, so a plan is always safe to ask for. Providers only through
// ProviderProbe, which restores its own state in a finally.

import type { FileFacts, MoveAnchor, MoveDependency, Range, TextEdit } from "@nyaa-lexicon/protocol";
import type { ImportResolver } from "./imports.js";
import { InsertPlanner } from "./insertPlanner.js";
import { MovePlanner } from "./movePlanner.js";
import { isDangling } from "./plannerCommon.js";
import type { ProviderProbe } from "./providerProbe.js";
import { type FactsSeen, factsMovedSince, ReadContext } from "./readContext.js";
import type { PlannedMove, PlannedRename, PlannedRenameEdits, RenameBlocker } from "./refusalSlots.js";
import type { Refusal } from "./refusals.js";
import { RenamePlanner } from "./renamePlanner.js";
import { proveRename, type RenameCandidate } from "./renameValidation.js";
import { ReplacementPlanner } from "./replacementPlanner.js";
import type { SourceWorkspace } from "./sourceWorkspace.js";
import type { IndexStore, StoredImport } from "./store.js";
import type { RefactorIssue } from "./transactions.js";

export type { MovePlan, RenameConcern, RenameEditPlan, RenameFile, RenamePlan } from "@nyaa-lexicon/protocol";
export { workspaceModule } from "./plannerCommon.js";

////////////////////////////////
// Interfaces & Types

/** How many times one name in one role failed to bind, kept with the parts so nothing re-splits. */
interface UnboundTally {
	name: string;
	role: string;
	/** Why the provider could not bind it, so a report says more than "does not resolve". */
	reason: string;
	count: number;
}

/**
 * Counts by name and role, which is what survives an edit that moves every range below it.
 *
 * The parts ride along with the count so nothing has to split the key back apart, which is where a
 * delimiter would have to be chosen and where choosing wrong is invisible.
 */
function countUnbound(rows: Array<{ name: string; role: string; reason: string }>): Map<string, UnboundTally> {
	const counts = new Map<string, UnboundTally>();
	for (const row of rows) {
		// Keyed without the reason, so the same broken name reported under a different reason is
		// still recognized as the problem that was already there.
		const key = `${row.role}:${row.name}`;
		const tally = counts.get(key);
		if (tally) tally.count++;
		else counts.set(key, { name: row.name, role: row.role, reason: row.reason, count: 1 });
	}
	return counts;
}

/**
 * A replacement worked out but not yet written.
 *
 * Carries the whole new file rather than an edit, because the splice was already checked against
 * the text it was cut from and re-deriving it at write time is how the two come to disagree.
 */
export type ReplacementPlan =
	| {
			ok: true;
			module: string;
			text: string;
			range: Range;
			/** Of the text the splice was cut from, so the writer can prove nothing moved since. */
			baseHash: string;
			/** The rows the plan read, stamped, so the writer can prove they were not committed again. */
			facts: FactsSeen[];
			issues: RefactorIssue[];
	  }
	| { ok: false; reason: Refusal; stale?: true };

/** What a whole module's new text would break, judged against the stored text `baseHash` names. */
export type WholeReplacementPlan =
	| { ok: true; module: string; baseHash: string; issues: RefactorIssue[] }
	| { ok: false; reason: Refusal; stale?: true };

/** Whole new contents per module, so the writer never re-derives an edit it did not check. */
export type MoveEditsOutcome =
	| {
			ok: true;
			/** Apply edits to the base, or empty text when created, to get `text`. */
			files: Array<{ module: string; text: string; edits: TextEdit[] }>;
			/** Each module's hash as its edits were cut, null where absent. */
			bases: Array<{ module: string; hash: string | null }>;
			issues: RefactorIssue[];
	  }
	| { ok: false; issues: RefactorIssue[]; reason: Refusal };

export interface InsertArgs {
	/** Sibling anchor: the new declaration goes directly after this one. */
	after?: string | undefined;
	/** Top-level append target; created if absent. Exactly one of the two anchors. */
	module?: string | undefined;
	/** The declaration(s), flush-left. The planner owns indentation. */
	text: string;
	/** The anchor module's text as the caller holds it; the stored text when absent. */
	moduleText?: string | undefined;
}

/** An insert worked out but not written. `present` is the retry answer: the block already sits
 * where it would go, so applying again would duplicate it. */
export type InsertPlan =
	| {
			state: "planned";
			module: string;
			created: boolean;
			/** Whole candidate file, splice applied. */
			candidate: string;
			/** Edit that produces candidate text from the base, or empty text if created. */
			edits: TextEdit[];
			/** The exact whole-line block spliced in, indentation applied, framing blanks excluded. */
			block: string;
			/** Null when the module is being created. */
			baseHash: string | null;
			/** The rows the plan read, stamped, so the writer can prove they were not committed again. */
			facts: FactsSeen[];
			issues: RefactorIssue[];
	  }
	| { state: "present"; module: string }
	| { state: "refused"; reason: Refusal };

////////////////////////////////
// Class

/** Reads a module it will write through `SourceWorkspace.writable`. */
export class RefactorPlanner {
	private readonly replacementPlanner: ReplacementPlanner;
	private readonly insertPlanner: InsertPlanner;
	private readonly movePlanner: MovePlanner;
	private readonly renamePlanner: RenamePlanner;

	constructor(
		private readonly store: IndexStore,
		private readonly imports: ImportResolver,
		private readonly source: SourceWorkspace,
		private readonly probe: ProviderProbe,
		/** The candidate proof; a planner test that is not about it passes its own. */
		private readonly prove: (candidate: RenameCandidate) => Promise<RenameBlocker[]> = (candidate) =>
			proveRename(store, probe, candidate),
	) {
		this.replacementPlanner = new ReplacementPlanner(
			this.store,
			this.source,
			this.probe,
			(context, module, candidate) => this.impactWithin(context, module, candidate),
			(providerId, module) => this.syntaxUnchecked(providerId, module),
		);
		this.insertPlanner = new InsertPlanner(
			this.store,
			this.source,
			this.probe,
			(context, module, candidate) => this.impactWithin(context, module, candidate),
			(providerId, module) => this.syntaxUnchecked(providerId, module),
		);
		this.movePlanner = new MovePlanner(this.store, this.imports, this.source, this.probe);
		// Keep the rename proof bound to this facade's store and probe.
		this.renamePlanner = new RenamePlanner(this.store, this.imports, this.source, this.probe, this.prove);
	}

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
		return this.replacementPlanner.planReplacement(address, newText, expectedSpanHash);
	}

	/** What writing `text` over a whole module would break, judged against the stored text; nothing is written. */
	async planWholeReplacement(args: {
		module: string;
		contentHash: string;
		text: string;
	}): Promise<WholeReplacementPlan> {
		return this.replacementPlanner.planWholeReplacement(args);
	}

	/** Owns insertion splice selection for `previewInsert`. See `docs/daemon-protocol.md`. */
	async planInsert(args: InsertArgs): Promise<InsertPlan> {
		return this.insertPlanner.planInsert(args);
	}

	/** Importers are found from stored references and imports, each written by the provider owning the
	 * file it is in. One claiming neither reported none, which is not the same as there being none. */
	importersUnfound(modules: string[]): RefactorIssue[] {
		return this.movePlanner.importersUnfound(modules);
	}

	/** Derives move facts for `previewMove` from one read context. See `docs/daemon-protocol.md`. */
	planMove(
		symbolId: string,
		rawTarget: string,
		context: ReadContext,
		anchor?: MoveAnchor,
		promote = false,
	): PlannedMove {
		return this.movePlanner.planMove(symbolId, rawTarget, context, anchor, promote);
	}

	/** Collects provider edits for `previewMove`. See `docs/daemon-protocol.md`. */
	async moveEdits(plan: Extract<PlannedMove, { ok: true }>, context: ReadContext): Promise<MoveEditsOutcome> {
		return this.movePlanner.moveEdits(plan, context);
	}

	/**
	 * Whether the moved symbol is still reachable from everywhere that used it.
	 *
	 * Run after the reindex, because the question is about what the providers concluded rather than
	 * what the edits looked like. A specifier that is syntactically fine and points nowhere produces
	 * exactly this: an importer whose reference no longer binds.
	 */
	checkMoveLanded(name: string, modules: string[]): RefactorIssue[] {
		return this.movePlanner.checkMoveLanded(name, modules);
	}

	/** Re-mints one id of a moved closure for its new module. */
	rebaseIntoModule(id: string, movedId: string, toModule: string): string | null {
		return this.movePlanner.rebaseIntoModule(id, movedId, toModule);
	}

	/**
	 * Every name the moved body uses, with what the index proved about where it comes from.
	 *
	 * Walked over the whole closure rather than over references owned by the moved symbol, because
	 * a moved class's body references belong to its METHODS and a top-level initializer may be
	 * owned by nothing at all.
	 */
	dependenciesOf(module: string, closure: string[], symbolId: string, context: ReadContext): MoveDependency[] {
		return this.movePlanner.dependenciesOf(module, closure, symbolId, context);
	}

	/**
	 * Every id a rename re-mints, old to new.
	 *
	 * A member's id carries its container's descriptors, so renaming a class re-mints its methods
	 * and their parameters too. Migrating only the class itself would strand everything written
	 * about them under ids nothing resolves.
	 */
	renameIdMap(symbolId: string, newName: string, context: ReadContext): Map<string, string> {
		return this.renamePlanner.renameIdMap(symbolId, newName, context);
	}

	/**
	 * Modules whose stored facts name an id the rename re-mints, whether or not their text changes.
	 *
	 * A file calling a renamed class's METHOD contains no occurrence of the class name, so it gets
	 * no edit, yet its reference rows point at ids that are about to stop existing. Left alone it
	 * would keep answering with them.
	 */
	modulesBoundTo(ids: Iterable<string>, context: ReadContext): string[] {
		return this.renamePlanner.modulesBoundTo(ids, context);
	}

	/**
	 * What renaming a symbol would touch, and what stands in the way. Reads only.
	 *
	 * The whole reason this is separate from applying: a rename is honest only over a set that is
	 * provably closed, and closedness is a question the index can answer without editing anything.
	 * The occurrences come from bound edges and proved routes alone, because a name match is a guess
	 * and a guess is acceptable in a reading tool and disqualifying in a writing one.
	 */
	async prepareRename(
		symbolId: string,
		newName: string,
		context: ReadContext,
		stops: readonly string[] = [],
	): Promise<PlannedRename> {
		return this.renamePlanner.prepareRename(symbolId, newName, context, stops);
	}

	/** Relied edges whose live landing differs from the stored one, or could not be checked. */
	async landingsMoved(relied: readonly StoredImport[]): Promise<RenameBlocker[]> {
		return this.renamePlanner.landingsMoved(relied);
	}

	/** Builds the complete edit set for `renameEdits`. See `docs/daemon-protocol.md`. */
	async renameEdits(
		symbolId: string,
		newName: string,
		context: ReadContext = new ReadContext(this.store),
		stops: readonly string[] = [],
	): Promise<PlannedRenameEdits> {
		return this.renamePlanner.renameEdits(symbolId, newName, context, stops);
	}

	/** The edit set, proved against every provider's view of it, and the import edges a writer checks again. */
	async planRenameEdits(
		symbolId: string,
		newName: string,
		context: ReadContext,
		stops: readonly string[] = [],
	): Promise<{ edits: PlannedRenameEdits; relied: StoredImport[] }> {
		return this.renamePlanner.planRenameEdits(symbolId, newName, context, stops);
	}

	/** Modules whose stored facts changed after the read context captured them. */
	factsMoved(seen: FactsSeen[]): string[] {
		return factsMovedSince(seen, this.store);
	}

	/** Silence from a provider that never claimed syntax reporting is not approval. Said out loud,
	 * or a caller believes the candidate was checked. */
	private syntaxUnchecked(providerId: string, module: string): RefactorIssue | null {
		if (this.probe.declares(providerId, "syntaxDiagnostics")) return null;
		return {
			kind: "SyntaxUnchecked",
			detail: `the provider for ${module} does not report syntax errors, so the candidate was not checked`,
			module,
		};
	}

	/**
	 * What the candidate breaks, minus what was already broken.
	 *
	 * Subtracted by (name, role, reason) rather than by fact id, because a fact id contains its
	 * range: any edit above an untouched problem would otherwise make it look newly introduced.
	 */
	impactOf(module: string, candidate: FileFacts): RefactorIssue[] {
		return this.impactWithin(new ReadContext(this.store), module, candidate);
	}

	/** The same, over the context a plan already holds. */
	private impactWithin(context: ReadContext, module: string, candidate: FileFacts): RefactorIssue[] {
		const issues: RefactorIssue[] = [];

		const before = context.heldIn(module);
		const after = new Set(candidate.declarations.map((declaration) => declaration.symbolId));
		for (const declaration of before) {
			if (after.has(declaration.symbolId)) continue;
			const users = context.referencesTo(declaration.symbolId).filter((row) => row.module !== module);
			if (users.length === 0) continue;

			issues.push({
				kind: "OrphanedReference",
				detail: `${declaration.name} is gone but still used in ${[...new Set(users.map((u) => u.module))].join(", ")}`,
				module,
			});
		}

		const wasUnbound = countUnbound(
			context
				.referencesIn(module)
				.filter((row) => row.targetId === null && isDangling(row.provenance))
				.map((row) => ({ name: row.name, role: row.role, reason: row.provenance })),
		);
		const nowUnbound = countUnbound(
			candidate.references
				.filter((reference) => reference.binding.status === "unbound" && isDangling(reference.binding.reason))
				.map((reference) => ({
					name: reference.name,
					role: reference.role,
					reason: reference.binding.status === "unbound" ? reference.binding.reason : "",
				})),
		);

		for (const [key, tally] of nowUnbound) {
			if (tally.count <= (wasUnbound.get(key)?.count ?? 0)) continue;
			issues.push({
				kind: "UnboundReference",
				detail: `${tally.name} (${tally.role}) does not resolve: ${tally.reason}`,
				module,
			});
		}

		return issues;
	}
}
