// Every refusal core composes: why something will not happen, and what to do instead. A warning
// riding a success is not one. The brand refuses a raw string and a residue refuses the cast.

import { decodeModuleField, FACT_SCHEME, isLocalSymbol, parseSymbolIdResult, spellsName } from "@nyaa-lexicon/protocol";
import { candidatesFor } from "./candidates.js";
import type { IndexStore } from "./store.js";

////////////////////////////////
//  Types

declare const refusalBrand: unique symbol;

/** A sentence this module minted; a reason slot typed with it refuses a raw string. */
export type Refusal = string & { readonly [refusalBrand]: true };

/** The closed outcomes of asking about an id that names no declaration. */
export type DiagnosisKind = "factIdAsSubject" | "unminted" | "moved" | "stranded" | "waiting" | "unknown";

/** One diagnosis, reached from every tool: the kind, its sentence, and what a reader might mean instead. */
interface Diagnosed<K extends DiagnosisKind> {
	kind: K;
	reason: Refusal;
	/** The shortlist for an unminted id, the same-name-and-kind declarations for a stranded one. */
	candidates: string[];
}

/** Only a vacated address forwards, so only `moved` carries where. */
export type SubjectDiagnosis =
	| Diagnosed<Exclude<DiagnosisKind, "moved">>
	| (Diagnosed<"moved"> & { forwardedTo: string });

////////////////////////////////
//  Constants

/** How many neighbours a refusal names before the list stops helping. */
const NEIGHBOURS_SHOWN = 8;

////////////////////////////////
//  Functions & Helpers

/** The one cast. */
function mint(text: string): Refusal {
	return text as Refusal;
}

////////////////////////////////
//  Doubting

export function doubtNeedsReason(): Refusal {
	return mint(`a doubt needs a reason: it is what the next writer reads`);
}

////////////////////////////////
//  Notes

export function noteOpensWith(block: string): Refusal {
	return mint(
		`a note opens with a plain paragraph, the summary cards and hovers show; this one opens with a ${block}. Put the summary first`,
	);
}

export function noteTooLong(max: number, length: number): Refusal {
	return mint(`a note is at most ${max} characters, and this is ${length}`);
}

export function noteNotApplicable(kind: string): Refusal {
	return mint(`${kind} is function-scoped and takes no note. Note the declaration that owns it`);
}

export function noteRevisionMoved(expected: number, current: number): Refusal {
	return mint(
		current === 0
			? `no note stands, so expectedRevision is 0, not ${expected}`
			: `the note is at revision ${current}, not ${expected}. Read it again and write over what stands`,
	);
}

export function noteRefsRefused(count: number): Refusal {
	return mint(`${count} ref${count === 1 ? " does" : "s do"} not resolve. Each is listed with candidates`);
}

export function noNoteStands(symbolId: string): Refusal {
	return mint(`no note stands on ${symbolId}. \`write_note\` writes one`);
}

export function noProposalStands(symbolId: string): Refusal {
	return mint(`no proposal waits on the note about ${symbolId}`);
}

export function proposalReplaced(symbolId: string): Refusal {
	return mint(`a newer proposal replaced the one shown for ${symbolId}. Review it before resolving`);
}

export function refModuleNotIndexed(module: string): Refusal {
	return mint(`${module} is not an indexed file`);
}

export function refNamesNothing(module: string): Refusal {
	return mint(`names nothing in ${module}`);
}

export function refAmbiguous(count: number): Refusal {
	return mint(`names ${count} declarations. Pick one of the candidates`);
}

export function refTargetGone(): Refusal {
	return mint(`names nothing now; the symbol it named is gone`);
}

export function refNamesArguments(): Refusal {
	return mint(`names a parameter list. Name the function, or one parameter after \`arguments\``);
}

////////////////////////////////
//  Subject diagnoses

export function factIdAsSubject(symbolId: string): Refusal {
	return mint(`${symbolId} is a fact id, not a symbol id. Name the symbol it belongs to in \`symbolId\``);
}

export function unmintedId(symbolId: string, module: string, shown: string[], rest: number): Refusal {
	const held = shown.length === 0 ? "no declarations" : `${shown.join(", ")}${rest > 0 ? `, and ${rest} more` : ""}`;
	return mint(`${symbolId} is not in the index. ${module} holds ${held}`);
}

export function unknownModule(symbolId: string, module: string): Refusal {
	return mint(`${symbolId} is not in the index, and neither is ${module}`);
}

/** A spelling the grammar refuses, with no module readable from it to shortlist. */
export function unparsableId(symbolId: string, failure: string): Refusal {
	return mint(`${symbolId} is not a symbol id: ${failure}`);
}

export function movedId(symbolId: string, to: string, evidence: string): Refusal {
	return mint(`${symbolId} was rebound to ${to} (${evidence}), and any note on it moved with it. Ask about ${to}`);
}

/** An address a subject still names and the index no longer holds; the candidates are for a person to read. */
export function strandedId(
	symbolId: string,
	since: number | null,
	evidence: string | null,
	candidates: string[],
	local: boolean,
): Refusal {
	const dated =
		since === null ? "" : `, orphaned at ${new Date(since).toISOString()}, and deletion follows thirty days after`;
	const judged = evidence === "ambiguous" ? " (more than one declaration could have been it)" : "";
	const shown = candidates.slice(0, NEIGHBOURS_SHOWN).map((candidate) => `\`${candidate}\``);
	const rest = candidates.length - shown.length;
	const where = local
		? "; a local has no candidates, since its ordinal names no chain"
		: candidates.length === 0
			? "; nothing else in the index carries its name and kind"
			: `: ${shown.join(", ")}${rest > 0 ? `, and ${rest} more` : ""}`;
	return mint(
		`${symbolId} names a subject whose address no longer resolves${dated}${judged}. Write any note on it again where a reader will find it${where}`,
	);
}

export function waitingOnParseFailure(symbolId: string, module: string, reason: string): Refusal {
	return mint(
		`${symbolId} is waiting on ${module}, which is present and not parsing (${reason}); nothing about it is orphaned or deleted while that holds. Fix the parse, then ask again`,
	);
}

/**
 * Why a subject id names no declaration, as one value every tool reaches: the closed kind, the
 * sentence, the ids a reader might mean, and where a vacated address forwards. Never "not in the
 * index" alone.
 */
export function diagnoseSubject(symbolId: string, store: IndexStore): SubjectDiagnosis {
	if (symbolId.startsWith(`${FACT_SCHEME} `)) {
		return { kind: "factIdAsSubject", reason: factIdAsSubject(symbolId), candidates: [] };
	}

	const parsed = parseSymbolIdResult(symbolId);
	const module = parsed.ok ? parsed.value.module : moduleFieldOf(symbolId);

	// What the identity owner last left at the address decides the wording before any shortlist.
	const status = store.subjects.stateOf(symbolId, (of) => store.parseFailureOf(of)?.reason ?? null);
	if (status.subject === null && status.forwardedTo !== null) {
		return {
			kind: "moved",
			reason: movedId(symbolId, status.forwardedTo, status.evidence ?? "none"),
			candidates: [],
			forwardedTo: status.forwardedTo,
		};
	}
	if (status.subject !== null && !status.resolves) {
		// Only a bound subject waits; an orphan under a failing module was judged before it failed.
		if (status.exempt && status.state === "bound") {
			return {
				kind: "waiting",
				reason: waitingOnParseFailure(symbolId, module ?? "", status.reason ?? ""),
				candidates: [],
			};
		}
		const candidates = candidatesFor(store, symbolId);
		return {
			kind: "stranded",
			reason: strandedId(symbolId, status.orphanedAt, status.evidence, candidates, isLocalSymbol(symbolId)),
			candidates,
		};
	}
	// An indexed module is unminted territory even when it holds nothing; an unindexed one is unknown.
	const neighbours = module !== null && store.depthOf(module) !== null ? store.declarationsIn(module) : null;
	if (module !== null && neighbours !== null) {
		// Declarations the bad id spells lead: a parsed descriptor, or a whole token of the unparsed rest.
		const spells = spellsName(symbolId);
		const named = (declaration: { name: string }) => Number(spells(declaration.name));
		const shown = [...neighbours]
			.sort((a, b) => named(b) - named(a))
			.slice(0, NEIGHBOURS_SHOWN)
			.map((declaration) => declaration.symbolId);
		return {
			kind: "unminted",
			reason: unmintedId(
				symbolId,
				module,
				shown.map((id) => `\`${id}\``),
				neighbours.length - shown.length,
			),
			candidates: shown,
		};
	}

	if (!parsed.ok) return { kind: "unknown", reason: unparsableId(symbolId, parsed.failure.message), candidates: [] };
	return { kind: "unknown", reason: unknownModule(symbolId, parsed.value.module), candidates: [] };
}

/** The diagnosis's sentence, for a reason slot. */
export function subjectRefused(symbolId: string, store: IndexStore): Refusal {
	return diagnoseSubject(symbolId, store).reason;
}

////////////////////////////////
//  Source

export function moduleNotOnDisk(module: string): Refusal {
	return mint(`${module} is not on disk any more. Re-index the workspace if it was deleted or moved`);
}

export function moduleStale(module: string): Refusal {
	return mint(`${module} changed since it was indexed, so its ranges are stale. Re-index it and ask again`);
}

export function moduleChangedReindex(module: string): Refusal {
	return mint(`${module} changed since it was indexed; reindex and retry`);
}

export function moduleUnreadable(module: string): Refusal {
	return mint(`${module} could not be read. Check it exists and is readable, then try again`);
}

export function moduleNotUtf8(module: string): Refusal {
	return mint(
		`${module} is not valid UTF-8, so rewriting it would replace its undecodable bytes with U+FFFD. Convert it to UTF-8 and re-index, or edit it by hand`,
	);
}

export function textNotEncodable(module: string): Refusal {
	return mint(
		`the text for ${module} holds a lone surrogate, which UTF-8 cannot encode, so it would be written as U+FFFD. Send well-formed text`,
	);
}

/** Binary or too large. */
export function moduleNotText(module: string, why: string): Refusal {
	return mint(`${module} is not text a writer can splice (${why}). Edit it by hand`);
}

export function moduleOutsideWorkspace(module: string): Refusal {
	return mint(
		`${module} resolves outside the workspace through a link, so Lexicon neither reads nor writes it. Edit the file where the link points, or replace the link with the file`,
	);
}

export function rangeOutsideModule(module: string): Refusal {
	return mint(`the stored range falls outside ${module}. Re-index it and ask again`);
}

export function factNamesNothing(factId: string): Refusal {
	return mint(`${factId} names nothing in the index any more`);
}

export function factNotAddressable(factId: string, fact: string): Refusal {
	return mint(
		`${factId} names a ${fact}, and only a literal is addressable by fact id. Name the symbol it belongs to in \`symbolId\``,
	);
}

export function noAddressGiven(): Refusal {
	return mint(`give either a symbolId or a literal's factId`);
}

/** A path the grammar cannot represent; the thrower's message says which rule it broke. */
export function unrepresentableModule(problem: string): Refusal {
	return mint(problem);
}

////////////////////////////////
//  Refactor

export function noProviderOwns(module: string, detail?: string): Refusal {
	return mint(
		`no provider owns ${module}${detail === undefined ? "" : `: ${detail}`}. Only a claimed file can be rewritten`,
	);
}

/** The provider's own refusal, named with the module it was asked about. */
export function providerRefused(module: string, reason: string, detail?: string): Refusal {
	return mint(`${module}: ${reason}${detail === undefined ? "" : `: ${detail}`}`);
}

export function candidateDoesNotParse(
	what: "replacement" | "insert" | "candidate" | "sent text",
	reason: string,
): Refusal {
	return mint(`the ${what} does not parse: ${reason}`);
}

/** An edit that cannot be applied to the text it was cut from; the applier's message says why. */
export function editsRefused(problem: string): Refusal {
	return mint(problem);
}

export function sharesId(symbolId: string, module: string): Refusal {
	return mint(`${symbolId} names more than one declaration in ${module}, so it cannot be replaced safely`);
}

export function sharesSpan(name: string, others: string): Refusal {
	return mint(`${name} shares its span with ${others}, so replacing it would rewrite them too`);
}

export function replacementRenames(from: string, to: string): Refusal {
	return mint(
		`the replacement renames ${from} to ${to}, which replace cannot do. Keep the name, or use refactor_rename.`,
	);
}

export function nothingToInsert(): Refusal {
	return mint(`nothing to insert. Send the declaration in \`text\``);
}

export function oneAnchorOnly(): Refusal {
	return mint(`set exactly one of after or module`);
}

export function anchorNotInText(after: string, module: string): Refusal {
	return mint(`${after} is not declared in the text sent for ${module}`);
}

export function anchorCopiesMoved(after: string, module: string): Refusal {
	return mint(`the text sent for ${module} declares another count of ${after}'s name, so its id names another copy`);
}

export function noSingleLineName(name: string): Refusal {
	return mint(`the provider gives ${name} no single-line name, so indentation cannot be read`);
}

export function noInsertionPoint(who: string): Refusal {
	return mint(
		`no whole-line insertion point exists after the anchor (${who} leaves it no line of its own); hand-edit or anchor elsewhere`,
	);
}

export function alreadyInModule(name: string, module: string): Refusal {
	return mint(`${name} is already in ${module}. Pass an anchor to reorder it there`);
}

export function anchorNotTopLevel(anchor: string, module: string): Refusal {
	return mint(
		`${anchor} is not a top-level declaration of ${module} outside what moves. Anchor on one, or leave the anchor off to insert at the end`,
	);
}

export function anchorNotSibling(anchor: string, name: string, module: string): Refusal {
	return mint(`${anchor} is not a sibling of ${name} in ${module}. Anchor on a declaration at ${name}'s own level`);
}

export function anchorNeedsTopLevel(name: string, module: string): Refusal {
	return mint(
		`${name} sits inside another declaration, so its move to ${module} takes no anchor. Leave the anchor off to insert at the end`,
	);
}

export function occurrencesBlocked(): Refusal {
	return mint(`some occurrences cannot be rewritten; the blocked sites name which and why`);
}

/** One occurrence the provider will not rewrite, with whatever it said about why. */
export function siteBlocked(module: string, detail: string | undefined): Refusal {
	return mint(`${module}: ${detail ?? "cannot be rewritten safely"}`);
}

export function writeFailed(module: string | undefined, reason: string): Refusal {
	return mint(`${module ?? "a file"}: ${reason}`);
}

////////////////////////////////
//  Transactions

export function noTransactionOpen(): Refusal {
	return mint(`no refactor transaction is open; call refactor_start`);
}

export function transactionAlreadyOpen(): Refusal {
	return mint(`a refactor transaction is already open; commit or revert it before starting another`);
}

export function nothingToUndo(): Refusal {
	return mint(`this transaction has no steps to undo`);
}

export function refactorOpenForCommittedStep(id: string): Refusal {
	return mint(
		`refactor ${id} is open, and a committed step writes only when none is. Commit or revert that refactor, then retry`,
	);
}

export function stepCancelled(stepId: string): Refusal {
	return mint(`step ${stepId} was cancelled before it wrote anything`);
}

/** A step id already names a step, which was not answered. */
export function stepIdTaken(stepId: string, status: string): Refusal {
	return mint(`step ${stepId} is already ${status}; ask refactorStepOutcome what became of it`);
}

export function stepOutsideBases(modules: string[]): Refusal {
	const them = modules.length === 1 ? "it is" : "they are";
	return mint(
		`${modules.join(", ")} would be written, but ${them} missing from bases or no longer at the hash given. Preview again, journal what it names, then retry with its bases`,
	);
}

export function refactorChangedSinceShown(): Refusal {
	return mint(`the refactor changed since it was shown. Read refactor_status again and decide on what it holds now`);
}

export function refactorDriftChangedSinceShown(): Refusal {
	return mint(
		`the drifted modules or disk hashes changed since refactor_status. Read it again, review the changed files, then retry refactor_revert with its drifted list`,
	);
}

export function refactorPathLeavesWorkspace(module: string): Refusal {
	return mint(
		`${module} now resolves outside the workspace through a parent link. Remove or repoint that link, review refactor_status, then retry refactor_revert`,
	);
}

export function writeNotTracked(module: string): Refusal {
	return mint(`${module} is not tracked by this transaction. Call refactor_track before reporting an editor write`);
}

export function notedWriteDoesNotMatch(module: string): Refusal {
	return mint(
		`${module} no longer holds the reported editor state. Read it again and report its current hash or absence only after that write completes`,
	);
}

export function writeChanged(module: string, now: string | null): Refusal {
	const holds = now === null ? "is absent" : `now hashes to ${now}`;
	return mint(`${module} ${holds}, not what the write expected. Read it again and write against what it holds`);
}

export function writeRefactorMismatch(module: string, open: string | null, expected: string | null): Refusal {
	if (expected === null) {
		return mint(`refactor ${open} is open, so ${module} is not written. Keep or revert that refactor, then retry`);
	}
	const found = open === null ? "none is open" : `${open} is open instead`;
	return mint(`${module} expected refactor ${expected}, but ${found}. Read refactor_status, then retry`);
}

export function writeLeavesWorkspace(module: string): Refusal {
	return mint(
		`${module} resolves outside the workspace through a link, so nothing is written. Write a path inside it`,
	);
}

export function writeOverDirectory(module: string): Refusal {
	return mint(`${module} is a directory. Write a file path inside it`);
}

export function writeOverNonFile(module: string, found: "link" | "special"): Refusal {
	const what = found === "link" ? "a symbolic link" : "not a regular file";
	return mint(`${module} is ${what}, so nothing is written. Write the file it names, or edit this path by hand`);
}

export function writeTooLarge(module: string, bytes: number, cap: number): Refusal {
	return mint(`${module} would be ${bytes} bytes, over the ${cap}-byte write cap. Edit it by hand`);
}

export function recoveryPending(operation: "undo" | "revert"): Refusal {
	return mint(
		`a ${operation} is still restoring this transaction. Remove any blocking directory, then call refactor_${operation} again`,
	);
}

export function notARegularFile(module: string, found: "link" | "directory" | "special" | "outside"): Refusal {
	if (found === "outside") {
		return mint(
			`${module} resolves outside the workspace through a parent link, so a refactor cannot snapshot it. Name a path inside the workspace`,
		);
	}
	const what = found === "link" ? "a symbolic link" : found === "directory" ? "a directory" : "not a regular file";
	return mint(
		`${module} is ${what}, and a refactor snapshots regular files only. Name the file itself, or edit this path by hand`,
	);
}

export function directoryInTheWay(modules: string[], operation: "undo" | "revert"): Refusal {
	const them = modules.length === 1 ? "it" : "them";
	return mint(
		`${modules.join(", ")} ${modules.length === 1 ? "is" : "are"} now a directory, so the ${operation} cannot restore ${them}. Delete ${them} and ${operation} again`,
	);
}

export function pathInTheWay(modules: string[], operation: "undo" | "revert"): Refusal {
	return mint(
		`${modules.join(", ")} cannot be restored: a directory, a leftover staging folder beside it, or a file where its folder belongs is in the way. Remove it and ${operation} again`,
	);
}

export function restoreFailed(modules: string[], operation: "undo" | "revert"): Refusal {
	return mint(
		`${modules.join(", ")} could not be written back because of a disk error, such as permissions or space. Fix that and ${operation} again`,
	);
}

/** The step is journaled and the files are not, so the caller is told what still stands. */
export function stepNotWritten(kind: string, problem: string, stranded: string | null): Refusal {
	const remains =
		stranded === null
			? ""
			: `; the journaled step remains (${stranded}), refactor_revert restores the tracked files`;
	return mint(`the ${kind} could not be written: ${problem}${remains}`);
}

/** What a provider or the writer refused, kept as its own words. */
export function stepRefused(problem: string, stranded: string | null): Refusal {
	const remains =
		stranded === null
			? ""
			: `; the journaled step remains (${stranded}), refactor_revert restores the tracked files`;
	return mint(`${problem}${remains}`);
}

export function moveCycle(names: readonly string[]): Refusal {
	return mint(`${names.join(" uses ")}, so none can move first. Export one of them, then move them`);
}

export function moveTogetherSplit(name: string, module: string, from: string): Refusal {
	return mint(`${name} is in ${module}, not ${from}. Only declarations from one module move together`);
}

export function arrangeNeedsTopLevel(name: string): Refusal {
	return mint(`${name} sits inside another declaration. An arrangement places top-level declarations only`);
}

export function placedTwice(name: string): Refusal {
	return mint(`${name} is placed twice. Place each declaration once`);
}

export function anchorNotPlaced(anchor: string, name: string, module: string): Refusal {
	return mint(
		`${name}'s anchor ${anchor} has no place yet. Anchor on a declaration that stays in ${module}, or on one placed earlier`,
	);
}

export function alreadyDeclaredIn(name: string, module: string): Refusal {
	return mint(`${module} already declares ${name}. Rename one of them first`);
}

export function arrangeMisplaced(name: string, module: string): Refusal {
	return mint(`the provider's edits leave ${name} misplaced in ${module}. Move it on its own, or hand-edit`);
}

export function arrangeNotAsPreviewed(module: string): Refusal {
	return mint(`${module} would not be written as previewed. Preview the arrangement again`);
}

export function writtenNotAsPlanned(module: string): Refusal {
	return mint(`${module} on disk differs from what the step wrote, so the step was undone`);
}

/** The world moved between planning and the gate, so the plan describes text that is gone. */
export function changedWhilePlanned(module: string, kind: string): Refusal {
	return mint(`${module} changed while the ${kind} was planned. Re-index it and plan again`);
}

/** A read module owes a parse that failed, so it may bind as it did before a move. */
export function bindingsHeld(modules: string[], kind: string): Refusal {
	const one = modules.length === 1;
	return mint(
		`${modules.join(", ")} could not be parsed again after a move, so ${one ? "its" : "their"} bindings may be out of date. Plan the ${kind} again once ${one ? "it indexes" : "they index"}`,
	);
}

/** Each plan in turn was outrun by indexing elsewhere; a later try may find the index still. */
export function indexBusy(kind: string): Refusal {
	return mint(`files kept being indexed while the ${kind} was planned. Plan again in a moment`);
}

/** The index committed the rows again, so the plan read facts that are gone. */
export function factsMovedWhilePlanned(modules: string[], kind: string): Refusal {
	return mint(`indexed again while the ${kind} was planned: ${modules.join(", ")}. Plan again`);
}

/** An own step's failed write, settled as recovery would. */
export function stepAbandoned(problem: Refusal, conflicts: string[]): Refusal {
	const left = conflicts.length === 0 ? "" : `; ${conflicts.join(", ")} matched neither image and was left as found`;
	return mint(`${problem}${left}`);
}

/** The span changed since the caller read it. */
export function spanChanged(module: string, name: string): Refusal {
	return mint(
		`${name} in ${module} no longer holds the text the new text was written against. Read it again with symbol_source and edit what it holds now`,
	);
}

/** The index holds other text for the module than the caller read. */
export function baseMoved(module: string): Refusal {
	return mint(`${module} was indexed again since its content hash was read. Read it again and preview again`);
}

/** A module the index holds no text for. */
export function notStored(module: string): Refusal {
	return mint(`${module} is not indexed, so there is nothing to compare a replacement with. Index it first`);
}

export function staleSincePlanned(modules: string[], kind: string): Refusal {
	return mint(
		`${modules.join(", ")} changed since being indexed, so the ${kind} would rewrite stale positions. Re-index and plan again`,
	);
}

export function undoWouldDiscard(module: string, stepNo: number): Refusal {
	return mint(
		`${module} changed after step ${stepNo}, so undoing it would discard that edit. Keep the edit, or revert the transaction`,
	);
}

export function unresolvedIssues(count: number): Refusal {
	return mint(`${count} unresolved issue${count === 1 ? "" : "s"}; undo and correct, or commit with force`);
}

////////////////////////////////
//  Renaming

export function nameNotInSource(oldName: string): Refusal {
	return mint(`${oldName} is named after its file, not written in it. Rename a declaration the source spells`);
}

export function alreadyNamed(oldName: string): Refusal {
	return mint(`already named ${oldName}; pick a different name`);
}

export function nameAlreadyDeclared(newName: string, files: number): Refusal {
	return mint(
		`${newName} is already declared in ${files === 1 ? "a file" : `${files} files`} this rename rewrites. Rename that declaration first, or pick another name.`,
	);
}

export function nameAlreadyImported(newName: string, files: number): Refusal {
	return mint(
		`${newName} is already imported in ${files === 1 ? "a file" : `${files} files`} this rename rewrites, so the rewritten uses would bind to that import instead. Rename or alias that import first, or pick another name.`,
	);
}

export function useUntraced(name: string): Refusal {
	return mint(`the index cannot trace this use of ${name} to its declaration. Rename it by hand`);
}

export function routeUncertain(module: string, name: string): Refusal {
	return mint(`${module} may expose ${name} through an export the index cannot prove. Make that export static`);
}

export function stopOffRoute(id: string): Refusal {
	return mint(`${id} is not an export this rename passes through. Stop at a re-export on its routes`);
}

export function stopNotKeepable(module: string): Refusal {
	return mint(`${module} does not re-export the name as one plain transfer, so no alias can keep it. Stop elsewhere`);
}

export function stopReceivesNoChange(module: string): Refusal {
	return mint(`the name no longer changes at ${module}. Drop this stop`);
}

export function stopUnsupported(module: string): Refusal {
	return mint(`the provider for ${module} cannot keep an old name as an alias. Drop this stop`);
}

export function siteDecidedTwice(module: string): Refusal {
	return mint(`${module}: one occurrence would be both kept and renamed. Drop a stop`);
}

export function nameAlreadyExposed(newName: string, where: string): Refusal {
	return mint(`${where} already exposes ${newName}, so its importers would bind to that. Pick another name`);
}

export function nameShared(module: string, name: string): Refusal {
	return mint(
		`${module} carries ${name} for another declaration too, and renaming its token drops that one. Rename by hand`,
	);
}

export function exposureRebinds(where: string, name: string): Refusal {
	return mint(`${where} would expose ${name} differently, so its importers would bind elsewhere. Pick another name`);
}

export function wildcardCaptures(module: string, name: string): Refusal {
	return mint(
		`${module} would gain ${name} through a wildcard where it already binds or reads ${name}. Pick another name`,
	);
}

export function routeChanged(count: number): Refusal {
	const imports =
		count === 1
			? "1 import on this rename's routes now resolves"
			: `${count} imports on this rename's routes now resolve`;
	return mint(`${imports} elsewhere. Plan again`);
}

export function landingUnchecked(module: string, specifier: string): Refusal {
	return mint(`could not check where ${specifier} lands from ${module}. Try again`);
}

export function starDropsName(module: string, newName: string): Refusal {
	return mint(
		`${module} forwards it through a star that would not carry ${newName}. Pick another name, or forward it by name`,
	);
}

export function wildcardDropsName(module: string, newName: string): Refusal {
	return mint(
		`${module} imports it through a wildcard that would not bring ${newName}. Pick another name, or import it by name`,
	);
}

export function newNameUnproved(where: string, newName: string): Refusal {
	return mint(`${where} may also expose ${newName} through an export the index cannot prove. Pick another name`);
}

export function allListUnproved(module: string, name: string): Refusal {
	return mint(`${module} lists ${name} in __all__ without saying what binds it. Rename by hand`);
}

export function projectionsUnsettled(): Refusal {
	return mint("the index is still settling what modules export. Plan again in a moment");
}

export function proofUnavailable(why: string): Refusal {
	return mint(`the rename cannot be proved before it writes: ${why}. Rename by hand`);
}

export function bindingsMoved(count: number): Refusal {
	return mint(
		`${count} place${count === 1 ? "" : "s"} would bind differently after the rename than its plan expects. Plan again, or rename by hand`,
	);
}

////////////////////////////////
//  Paint

export function noProviderOwnsForPaint(module: string, detail?: string): Refusal {
	return mint(`no provider owns ${module}${detail === undefined ? "" : `: ${detail}`}, so it cannot be painted`);
}

/** The module an unparseable id still names in its third field, decoded as the grammar would. */
function moduleFieldOf(symbolId: string): string | null {
	const field = symbolId.split(" ")[2];
	if (field === undefined || field === "") return null;
	try {
		return decodeModuleField(field);
	} catch {
		return null;
	}
}
