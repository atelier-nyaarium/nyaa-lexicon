import type { RefactorIssue, TransactionStatus } from "@nyaa-lexicon/core";
import type { MoveAnchor, UnreversedRebind } from "@nyaa-lexicon/protocol";
import { z } from "zod";
import {
	renderInsertOutcome,
	renderIssues,
	renderMoveOutcome,
	renderMovePlan,
	renderRefactorCommit,
	renderRefactorStart,
	renderRefactorStatus,
	renderRenamePlan,
	renderRenameStep,
	renderReplaceOutcome,
} from "../render.js";
import type { SymbolArgs, ToolBackend, ToolResult } from "../result.js";
import { textResult as text } from "../result.js";
import { moduleOf, resolveOne, withIndexState } from "./shared.js";

////////////////////////////////
//  Schemas

export const RefactorTrackInput = {
	module: z.string().min(1).describe(`Workspace-relative path you are about to edit by hand.`),
};

export const RefactorCommitInput = {
	force: z.boolean().optional().describe(`Commit despite outstanding issues.`),
};

export const RefactorRevertInput = {
	drifted: z
		.array(
			z.object({
				module: z.string().min(1),
				contentHash: z
					.string()
					.regex(/^[0-9a-f]{32}$/)
					.nullable(),
			}),
		)
		.describe(`Reviewed \`drifted\` list from \`refactor_status\`.`),
	expect: z
		.object({ id: z.string().min(1), revision: z.number().int().nonnegative() })
		.optional()
		.describe(`Transaction id and revision from status.`),
};

export const RefactorReplaceInput = {
	symbolId: z.string().min(1).optional().describe(`Exact \`symbolId\` from an earlier result.`),
	factId: z.string().min(1).optional().describe(`A literal's \`factId\` from \`find_literals\`.`),
	newText: z.string().min(1).describe(`Replacement for the whole span \`symbol_source\` returned.`),
	expectedSpanHash: z.string().min(1).optional().describe(`\`spanHash\` from \`symbol_source\`. Needs \`symbolId\`.`),
};

export const RefactorInsertInput = {
	after: z.string().min(1).optional().describe(`Sibling anchor: the declaration goes directly after this symbol.`),
	module: z
		.string()
		.min(1)
		.optional()
		.describe(`Append at top level of this module instead; created if absent. Set exactly one anchor.`),
	text: z.string().min(1).describe(`The declaration(s), flush-left. Indentation is applied from the anchor.`),
};

const STOPS = z
	.array(z.string().min(1))
	.max(4096)
	.optional()
	.describe(`Stop ids from a rename preview: keeps the old name at those re-exports.`);

export const RefactorPreviewInput = {
	symbolId: z.string().min(1).optional().describe(`Exact \`symbolId\` from an earlier result.`),
	name: z.string().min(1).optional().describe(`Symbol name. Omit with \`symbolId\`.`),
	module: z.string().min(1).optional().describe(`Workspace-relative \`module\` path, to say which \`name\`.`),
	newName: z.string().min(1).optional().describe(`Preview a rename to this name.`),
	toModule: z.string().min(1).optional().describe(`Preview a move to this module path.`),
	stops: STOPS,
};

export const RefactorMoveInput = {
	name: z.string().min(1).optional().describe(`Symbol name. Omit with \`symbolId\`.`),
	symbolId: z.string().min(1).optional().describe(`Exact \`symbolId\` from an earlier result.`),
	module: z.string().min(1).optional().describe(`Workspace-relative \`module\` path.`),
	toModule: z.string().min(1).describe(`Workspace-relative path to move it to. Created if absent.`),
	together: z
		.array(z.string().min(1))
		.max(100)
		.optional()
		.describe(`More names to move with it, from the same \`module\`. Each moves after the ones it uses.`),
	before: z.string().min(1).optional().describe(`A declaration in \`toModule\` to land before.`),
	after: z.string().min(1).optional().describe(`A declaration in \`toModule\` to land after.`),
};

export const RefactorRenameInput = {
	name: z.string().min(1).optional().describe(`Symbol name. Omit with \`symbolId\`.`),
	symbolId: z.string().min(1).optional().describe(`Exact \`symbolId\` from an earlier result.`),
	module: z.string().min(1).optional().describe(`Workspace-relative \`module\` path.`),
	newName: z.string().min(1).describe(`Replacement symbol name.`),
	stops: STOPS,
};

////////////////////////////////
//  Constants

export const REFACTOR_MOVE_DESCRIPTION = `
# \`refactor_move\`

Move a declaration to another module, rewriting the imports that reach it.

Creates the target if it does not exist. Imports in every referencing file are re-pointed, and the
moved body's own dependencies are imported into its new home. A site that cannot be rewritten
safely stops the whole move rather than relocating the declaration and stranding its importers.

Name more declarations in \`together\` to move them too: one step where the language arranges moves,
else one step each, each after the ones it uses.

\`before\` or \`after\` lands it beside a declaration in \`toModule\`; with one, \`toModule\` may be its own module,
which reorders.
`.trim();

export const REFACTOR_RENAME_DESCRIPTION = `
# \`refactor_rename\`

Rename a bound symbol across declarations, uses, imports, and re-exports, as a transaction step.

Nothing is written unless every occurrence can be. Recorded knowledge follows the symbol and its
members, whose ids are re-minted too. Files that only used the old name through a member are
reindexed even though their text does not change.

\`stops\` keeps the old name at re-exports a preview offers, by stop id.
`.trim();

export const REFACTOR_START_DESCRIPTION = `
# \`refactor_start\`

Open the workspace's refactor transaction, and return the rules for operating it.

Every other \`refactor_\` tool needs one open. One per workspace, shared by every session.
`.trim();

export const REFACTOR_PREVIEW_DESCRIPTION = `
# \`refactor_preview\`

What a rename or a move would touch. Read-only, no transaction.

\`newName\` previews a rename: files, sites per file, routes with their stop ids, blockers, warnings, mentions.
\`toModule\` previews a move: the removal, the insertion, the imports re-pointed, and what the moved text depends on.
`.trim();

export const REFACTOR_STATUS_DESCRIPTION = `
# \`refactor_status\`

Show steps, tracked files, disk drift, editor writes and issues.

Pass \`drifted\`, \`id\` and \`revision\` from this result to \`refactor_revert\`.
Answers "none open" as a result, not an error. Also how you find what another session already did.
`.trim();

export const REFACTOR_TRACK_DESCRIPTION = `
# \`refactor_track\`

Snapshot a file BEFORE you edit it by hand, so undo and revert can put it back.

An untracked edit cannot be undone and survives revert. Tracking twice keeps the first snapshot.
`.trim();

export const REFACTOR_UNDO_DESCRIPTION = `
# \`refactor_undo\`

Remove the newest step, restoring the files it wrote.

Refuses when one of those files changed since, rather than overwriting whatever changed it.
`.trim();

export const REFACTOR_COMMIT_DESCRIPTION = `
# \`refactor_commit\`

Keep what is on disk and close the transaction. Nothing is undoable afterwards.

Refuses while issues are outstanding. \`force\` accepts them deliberately. \`ExportedBeyondIndex\`,
\`ReceiverMemberMayCapture\` and \`SameSpellingUnbound\` are advisory and never block.
`.trim();

export const REFACTOR_REPLACE_DESCRIPTION = `
# \`refactor_replace\`

Replace one symbol's whole span with new text, checked before it is written.

Text that does not parse is refused before touching disk. Text that parses is applied, then what it
broke is reported: symbols that vanished while other files still use them, and names that stopped
resolving. Read the span with \`symbol_source\` first and send back the edited whole.

Pass its \`spanHash\` as \`expectedSpanHash\` to refuse a span that changed since.

Renaming the declaration itself is refused; use \`refactor_rename\`.
`.trim();

export const REFACTOR_INSERT_DESCRIPTION = `
# \`refactor_insert\`

Author new declaration(s) as a transaction step: after a sibling symbol, or appended to a module.

Send the text flush-left; indentation is copied from the anchor. Text that does not parse in place
is refused before touching disk. Names the new body uses that resolve to nothing are reported, and
imports are never authored for you. A retry after a timeout answers already-inserted instead of
duplicating.

Declarations only: statement positions, switch cases, and single-line layouts are refused.
`.trim();

export const REFACTOR_REVERT_DESCRIPTION = `
# \`refactor_revert\`

Return every tracked file to how the transaction found it, and close it.

Pass \`drifted\` and \`expect\` from the reviewed \`refactor_status\`.
Each drift entry includes its module and current disk content hash, or null when no regular file hash is available.
Revert rechecks both under the write gate. If refused, review a fresh status.
`.trim();

////////////////////////////////
//  Handlers

export async function refactorMove(
	backend: ToolBackend,
	args: SymbolArgs & {
		toModule: string;
		together?: string[] | undefined;
		before?: string | undefined;
		after?: string | undefined;
	},
): Promise<ToolResult> {
	if (args.before !== undefined && args.after !== undefined) {
		return text(`Set \`before\` or \`after\`, not both.`, true);
	}
	const resolved = await resolveOne(backend, args);
	if ("problem" in resolved) return text(await withIndexState(backend, resolved.problem, args.module), true);
	const beside = args.before ?? args.after;
	let anchor: MoveAnchor | undefined;
	if (beside !== undefined) {
		const found = await resolveOne(backend, { name: beside, module: args.toModule });
		if ("problem" in found) return text(await withIndexState(backend, found.problem, args.toModule), true);
		anchor = { symbolId: found.symbolId, side: args.before === undefined ? "after" : "before" };
	}
	const together: string[] = [];
	const from = moduleOf(resolved.symbolId) ?? args.module;
	for (const name of args.together ?? []) {
		const each = await resolveOne(backend, { name, module: from });
		if ("problem" in each) return text(await withIndexState(backend, each.problem, args.module), true);
		together.push(each.symbolId);
	}

	const outcome = await backend.refactorMove(resolved.symbolId, args.toModule, together, anchor).catch(
		(error: unknown): Awaited<ReturnType<ToolBackend["refactorMove"]>> => ({
			moved: false,
			issues: [],
			reason: error instanceof Error ? error.message : String(error),
		}),
	);
	return text(renderMoveOutcome(outcome.toModule ?? args.toModule, outcome), !outcome.moved);
}

export async function refactorRename(
	backend: ToolBackend,
	args: SymbolArgs & { newName: string; stops?: string[] | undefined },
): Promise<ToolResult> {
	const resolved = await resolveOne(backend, args);
	if ("problem" in resolved) return text(await withIndexState(backend, resolved.problem, args.module), true);

	const outcome = await backend
		.refactorRename(resolved.symbolId, args.newName, args.stops)
		.catch((error: unknown) => ({
			renamed: false,
			issues: [] as RefactorIssue[],
			reason: error instanceof Error ? error.message : String(error),
		}));
	return text(renderRenameStep(args.newName, outcome), !outcome.renamed);
}

/**
 * Every refactor tool renders its own failure.
 *
 * A thrown request escapes as a transport error, which tells the caller nothing about the state
 * the transaction is in. Mid-refactor that is the difference between "retry" and "you have files
 * on disk from a step that did not finish".
 */
async function rendered(work: () => Promise<string>): Promise<ToolResult> {
	try {
		return text(await work());
	} catch (error) {
		return text(
			`the refactor could not be carried out: ${error instanceof Error ? error.message : String(error)}`,
			true,
		);
	}
}

export async function refactorStart(backend: ToolBackend): Promise<ToolResult> {
	return rendered(async () => renderRefactorStart(await backend.refactorStart()));
}

export async function refactorStatus(backend: ToolBackend): Promise<ToolResult> {
	return rendered(async () => renderRefactorStatus(await backend.refactorStatus()));
}

export async function refactorPreview(
	backend: ToolBackend,
	args: SymbolArgs & { newName?: string | undefined; toModule?: string | undefined; stops?: string[] | undefined },
): Promise<ToolResult> {
	if ((args.newName === undefined) === (args.toModule === undefined)) {
		return text(`Give \`newName\` for a rename preview or \`toModule\` for a move preview, not both.`, true);
	}
	try {
		const resolved = await resolveOne(backend, args);
		if ("problem" in resolved) return text(await withIndexState(backend, resolved.problem, args.module), true);

		const body =
			args.newName !== undefined
				? renderRenamePlan(await backend.prepareRename(resolved.symbolId, args.newName, args.stops))
				: renderMovePlan(await backend.planMove(resolved.symbolId, args.toModule ?? ""));
		return text(await withIndexState(backend, body, moduleOf(resolved.symbolId)));
	} catch (error) {
		return text(
			`the preview could not be worked out: ${error instanceof Error ? error.message : String(error)}`,
			true,
		);
	}
}

export async function refactorTrack(backend: ToolBackend, args: { module: string }): Promise<ToolResult> {
	return rendered(async () => {
		const outcome = await backend.refactorTrack(args.module);
		return outcome.tracked
			? `Tracking \`${args.module}\`. Its current contents are the state \`refactor_revert\` returns it to.`
			: (outcome.reason ?? `the file could not be tracked`);
	});
}

const UNREVERSED_WHY: Record<UnreversedRebind["reason"], string> = {
	gone: `its subject no longer exists`,
	movedOn: `its subject has moved on since`,
	fromHeld: `another subject now holds the old address`,
};

/** The subject moves a reversal left standing, one line each, so the caller knows which knowledge stayed where. */
function unreversedLines(unreversed: UnreversedRebind[] | undefined): string[] {
	if (unreversed === undefined || unreversed.length === 0) return [];
	return [
		`${unreversed.length} subject move(s) stayed as the step left them:`,
		...unreversed.map((move) => `- \`${move.from}\` to \`${move.to}\`: ${UNREVERSED_WHY[move.reason]}.`),
	];
}

export async function refactorUndo(backend: ToolBackend): Promise<ToolResult> {
	return rendered(async () => {
		const outcome = await backend.refactorUndo();
		const issues = renderIssues(outcome.issues ?? []);
		if (!outcome.undone) return [`Nothing was undone. ${outcome.reason ?? ""}`.trim(), ...issues].join("\n");
		return [
			`Undid step ${outcome.stepNo}, restoring ${(outcome.modules ?? []).map((m) => `\`${m}\``).join(", ")}.`,
			...unreversedLines(outcome.unreversed),
			...issues,
		].join("\n");
	});
}

export async function refactorRevert(
	backend: ToolBackend,
	args: { drifted: TransactionStatus["drifted"]; expect?: { id: string; revision: number } },
): Promise<ToolResult> {
	return rendered(async () => {
		const outcome = await backend.refactorRevert(args);
		const issues = renderIssues(outcome.issues ?? []);
		if (!outcome.reverted) return [`Nothing was reverted. ${outcome.reason ?? ""}`.trim(), ...issues].join("\n");
		const reverted =
			outcome.modules.length === 0
				? `Reverted. No file had been changed.`
				: `Reverted ${outcome.modules.length} file(s) to how the transaction found them: ${outcome.modules
						.map((m) => `\`${m}\``)
						.join(", ")}.`;
		return [reverted, ...unreversedLines(outcome.unreversed), ...issues].join("\n");
	});
}

export async function refactorCommit(backend: ToolBackend, args: { force?: boolean }): Promise<ToolResult> {
	return rendered(async () => renderRefactorCommit(await backend.refactorCommit(args.force)));
}

export async function refactorReplace(
	backend: ToolBackend,
	args: {
		symbolId?: string | undefined;
		factId?: string | undefined;
		newText: string;
		expectedSpanHash?: string | undefined;
	},
): Promise<ToolResult> {
	const { expectedSpanHash, ...address } = args;
	if (expectedSpanHash !== undefined && args.symbolId === undefined) {
		return text(`\`expectedSpanHash\` guards a symbol's span, so it needs \`symbolId\`.`, true);
	}
	const replaced =
		expectedSpanHash === undefined || args.symbolId === undefined
			? backend.refactorReplace(address)
			: backend.refactorReplaceSpan({ symbolId: args.symbolId, expectedSpanHash, newText: args.newText });
	const outcome = await replaced.catch((error: unknown) => ({
		replaced: false,
		issues: [] as RefactorIssue[],
		reason: error instanceof Error ? error.message : String(error),
	}));
	return text(renderReplaceOutcome(outcome), !outcome.replaced);
}

export async function refactorInsert(
	backend: ToolBackend,
	args: { after?: string | undefined; module?: string | undefined; text: string },
): Promise<ToolResult> {
	if ((args.after === undefined) === (args.module === undefined)) {
		return text(`Set exactly one of \`after\` or \`module\`.`, true);
	}
	const outcome = await backend.refactorInsert(args).catch(
		(error: unknown): Awaited<ReturnType<ToolBackend["refactorInsert"]>> => ({
			inserted: false,
			issues: [],
			reason: error instanceof Error ? error.message : String(error),
		}),
	);
	return text(renderInsertOutcome(outcome), !outcome.inserted && outcome.alreadyInserted !== true);
}
