import { renderIssues } from "./shared/issues.js";
import { code } from "./shared/markdown.js";
import type {
	InsertOutcome,
	MoveOutcome,
	MovePlan,
	RefactorCommitResult,
	RefactorStartResult,
	RenamePlan,
	RenameStepOutcome,
	ReplaceOutcome,
	RouteState,
	SymbolSource,
	TransactionStatus,
} from "./shared/types.js";

/** What a rename would touch, and what the index cannot promise about it. */
export function renderRenamePlan(plan: RenamePlan): string {
	if (plan.blockers.length > 0) {
		const lines = [
			`# Rename blocked

Cannot rename ${code(plan.oldName || plan.symbolId)}.

## Blockers
`,
		];
		for (const blocker of plan.blockers) {
			lines.push(`- **${blocker.kind}:** ${blocker.detail}`);
			for (const site of blocker.sites ?? []) lines.push(`  - ${code(`${site.module}:${site.line}`)}`);
		}
		return lines.join("\n");
	}

	// Owner calls are counted in the headline and shown per file, because a plan that says "2
	// occurrences" and then rewrites four places is a plan a reader stops trusting. They are not
	// occurrences of the name, so they are named separately rather than folded into the same number.
	const calls = plan.files.reduce((total, file) => total + (file.ownerCalls?.length ?? 0), 0);
	const touches = `${plan.occurrences} occurrence${plan.occurrences === 1 ? "" : "s"}`;
	const withCalls = calls === 0 ? touches : `${touches} and ${calls} call${calls === 1 ? "" : "s"} that name it`;

	const lines = [
		`# Rename ${plan.oldName} to ${plan.newName}

Touches ${withCalls} in ${plan.files.length} file${plan.files.length === 1 ? "" : "s"}.

## Files
`,
	];
	for (const file of plan.files) {
		const here = file.ownerCalls?.length ?? 0;
		const kept = file.sites.filter((site) => site.keep === true).length;
		lines.push(
			`- ${code(file.module)}: ${file.sites.length} occurrence${file.sites.length === 1 ? "" : "s"}${kept === 0 ? "" : `, ${kept} kept`}${here === 0 ? "" : ` plus ${here} call${here === 1 ? "" : "s"}`}`,
		);
	}

	const exports = plan.routes.edges.filter((edge) => edge.fact === "export" && edge.form !== "direct");
	if (exports.length > 0) {
		lines.push(`
## Routes
`);
	}
	for (const edge of exports) {
		if (edge.fact !== "export") continue;
		const stop = edge.stoppable === true ? `, stop ${code(edge.id)}` : "";
		lines.push(`- ${code(edge.from)}: ${edge.form} export, ${ROUTE_STATES[edge.state]}${stop}`);
	}

	const { comments, strings, incomplete } = plan.mentions;
	if (comments + strings > 0 || incomplete === true) {
		const unread = incomplete === true ? " Some files have no comment or string facts." : "";
		lines.push(
			`
${code(plan.oldName)} also appears in ${comments} comment${comments === 1 ? "" : "s"} and ${strings} string${strings === 1 ? "" : "s"}, which a rename never edits.${unread}`,
		);
	}

	// Never omitted when empty in a way a reader could mistake for silence: the absence of this
	// section is itself the claim that the index saw everything.
	if (plan.warnings.length === 0) {
		lines.push(`
Every occurrence is a bound edge.`);
		return lines.join("\n");
	}

	lines.push(`
## Warnings

This set may not be complete.
`);
	for (const warning of plan.warnings) {
		lines.push(`- **${warning.kind}:** ${warning.detail}`);
		for (const site of warning.sites ?? []) lines.push(`  - ${code(`${site.module}:${site.line}`)}`);
	}
	return lines.join("\n");
}

/** What a rename does at one route edge, as a preview says it. */
const ROUTE_STATES: Record<RouteState, string> = {
	renamed: "renamed",
	fixed: "name fixed by an alias",
	stopped: "kept by its stop",
	unknown: "not proved",
};

/** What a move would touch. */
export function renderMovePlan(plan: MovePlan): string {
	if (!plan.ok) return `# Move refused\n\n${plan.reason}`;

	// What the closure uses from inside itself moves with it and needs no import.
	const needed = plan.dependencies.filter((dependency) => dependency.origin.kind !== "insideClosure");
	const moved = plan.removal.end.line - plan.removal.start.line + 1;
	const lines = [
		`# Move ${plan.name} from ${code(plan.fromModule)} to ${code(plan.toModule)}

## Files

- ${code(plan.fromModule)}: lines ${plan.removal.start.line + 1} to ${plan.removal.end.line + 1} removed${plan.usedAtSource ? ", and an import back added, since something here still uses it" : ""}
- ${code(plan.toModule)}: ${moved} line${moved === 1 ? "" : "s"} inserted${plan.exportsAtTarget ? " and exported" : ""}${needed.length === 0 ? "" : ", plus the imports below"}`,
	];
	for (const module of plan.referencing) lines.push(`- ${code(module)}: import specifier re-pointed`);
	if (plan.closure.length > 1) {
		lines.push(`
Moves ${plan.closure.length} symbols: the declaration and what it contains.`);
	}

	if (needed.length === 0) {
		lines.push(`
The moved text depends on nothing outside itself.`);
		return lines.join("\n");
	}
	lines.push(`
## Dependencies

Names the moved text uses, and where each would be imported from.`);
	for (const dependency of needed) {
		const origin = dependency.origin;
		switch (origin.kind) {
			case "sourceModule":
				lines.push(
					`- ${code(dependency.name)}: stays in ${code(plan.fromModule)}${origin.exported === false ? ", and is not exported, which blocks the move" : ""}`,
				);
				break;
			case "workspaceModule":
				lines.push(`- ${code(dependency.name)}: from ${code(origin.module)}`);
				break;
			case "external":
				lines.push(`- ${code(dependency.name)}: from ${code(origin.via.specifier)}, outside the workspace`);
				break;
			case "unresolved":
				lines.push(`- ${code(dependency.name)}: unresolved (${origin.reason}), so the provider decides`);
				break;
		}
	}
	return lines.join("\n");
}

////////////////////////////////
//  Refactor

/** Fenced, since the whole point is text a caller edits and hands back verbatim. */
export function renderSymbolSource(source: SymbolSource): string {
	if (!source.found) {
		return source.stale === true
			? `# Symbol source\n\n${source.reason}. Ask again once it has been re-indexed.`
			: `# Symbol source\n\n${source.reason}`;
	}

	const { start, end } = source.range;
	const sourceText =
		source.valueStatus === undefined
			? source.text
			: `${source.text} ${source.valueStatus === "set" ? "(redacted)" : "(empty)"}`;
	return [
		`# ${code(source.name)}`,
		"",
		`${source.kind} in ${code(source.module)}, lines ${start.line + 1} to ${end.line + 1}.`,
		...(source.spanHash === undefined ? [] : [`Span hash: ${code(source.spanHash)}`]),
		"",
		"```",
		sourceText,
		"```",
	].join("\n");
}

/**
 * The operating rules, returned at start rather than documented elsewhere.
 *
 * Tracking is honour-based: nothing can stop an agent editing a file behind the transaction's
 * back, so the one moment it is certain to read this is the moment it opens one.
 */
export function renderRefactorStart(outcome: RefactorStartResult): string {
	if (!outcome.started) {
		return [
			`# Refactor already open`,
			"",
			`Transaction ${code(outcome.id)} is already open on this workspace. One transaction at a time.`,
			"",
			`Call \`refactor_status\` to see it, then continue it, \`refactor_commit\` it, or \`refactor_revert\` it.`,
		].join("\n");
	}

	return [
		`# Refactor ${code(outcome.id)} open`,
		"",
		`## Before you edit anything by hand`,
		"",
		`Call \`refactor_track\` on the file FIRST. Only tracked files and files a refactor tool touched`,
		`can be put back. An untracked edit is invisible to undo and survives revert.`,
		"",
		`## How it unwinds`,
		"",
		`- \`refactor_undo\` removes the newest step. It refuses if that step's files changed since,`,
		`  rather than overwriting whatever changed them.`,
		`- \`refactor_revert\` returns every tracked file to how this transaction found it, discarding`,
		`  manual edits made since.`,
		`- \`refactor_commit\` keeps what is on disk and ends the transaction. Nothing is undoable after.`,
		`  It refuses while issues are outstanding; pass \`force\` to accept them deliberately.`,
		"",
		`## While it is open`,
		"",
		`Re-fetch addresses after every step. Ranges move, so a symbolId or range read before a step`,
		`may not describe the same text after it.`,
		"",
		`Any session may operate this transaction. There is no owner token, so \`refactor_status\` is`,
		`how you find out what someone else already did.`,
	].join("\n");
}

export function renderRefactorStatus(status: TransactionStatus): string {
	if (!status.open) {
		return `# Refactor status\n\nNo transaction is open. Call \`refactor_start\` to begin one.`;
	}

	// Optional on the wire, so an absent one is a malformed peer rather than a closed transaction.
	const lines = [`# Refactor ${code(status.id ?? "unknown")}`];

	if (status.steps.length === 0)
		lines.push(`
No steps yet.`);
	else {
		lines.push(`
## Steps
`);
		for (const step of status.steps) {
			const files = step.modules.length === 0 ? `no files` : step.modules.map((m) => code(m)).join(", ");
			lines.push(`${step.stepNo}. **${step.kind}** (${step.phase}): ${files}`);
		}
	}

	if (status.tracked.length > 0) {
		lines.push(`
## Tracked

${status.tracked.map((module) => `- ${code(module)}`).join("\n")}`);
	}
	if (status.drifted.length > 0) {
		lines.push(`
## Changed on disk

${status.drifted
	.map(
		({ module, contentHash }) =>
			`- ${code(module)} (content hash: ${contentHash === null ? "unavailable" : code(contentHash)})`,
	)
	.join("\n")}`);
	}
	if (status.edited.length > 0) {
		lines.push(`
## Editor writes recorded

${status.edited.map((module) => `- ${code(module)}`).join("\n")}`);
	}

	const issues = renderIssues(status.issues);
	if (issues.length > 0) lines.push("", ...issues);
	else if (status.steps.length > 0)
		lines.push(`
No outstanding issues. \`refactor_commit\` would succeed.`);

	return lines.join("\n");
}

/**
 * A replacement, with what it broke.
 *
 * A step with issues is still applied and still says so. Refusing would leave the caller with no
 * way to make a change whose fallout it intends to fix in the next step.
 */
export function renderReplaceOutcome(outcome: ReplaceOutcome): string {
	if (!outcome.replaced) {
		return `# Not replaced\n\n${outcome.reason ?? `the replacement could not be applied`}`;
	}

	const lines = [
		`# Replaced in ${code(outcome.module ?? "unknown")}
`,
	];
	if (outcome.issues.length === 0) {
		lines.push(`Nothing else stopped resolving. \`refactor_commit\` would succeed.`);
		return lines.join("\n");
	}

	lines.push(
		`Applied, but it introduced ${outcome.issues.length} issue${outcome.issues.length === 1 ? "" : "s"}.`,
		`Fix them in a later step, \`refactor_undo\` this one, or commit with force.`,
		"",
		...renderIssues(outcome.issues),
	);
	return lines.join("\n");
}

/** An insert, with what it warned about. `alreadyInserted` is the retry answer, not a failure. */
export function renderInsertOutcome(outcome: InsertOutcome): string {
	if (outcome.alreadyInserted === true) {
		return `# Already inserted\n\nThe exact text already sits at that spot in ${code(outcome.module ?? "unknown")}; nothing was written.`;
	}
	if (!outcome.inserted) {
		return `# Not inserted\n\n${outcome.reason ?? `the insert could not be applied`}`;
	}

	const lines = [
		`# Inserted into ${code(outcome.module ?? "unknown")}
`,
	];
	for (const symbolId of outcome.symbolIds ?? []) lines.push(`- ID: ${code(symbolId)}`);
	if ((outcome.symbolIds ?? []).length > 0) lines.push("");

	if (outcome.issues.length === 0) {
		lines.push(`Everything the new text names resolves. \`refactor_commit\` would succeed.`);
		return lines.join("\n");
	}
	lines.push(
		`Applied, with ${outcome.issues.length} warning${outcome.issues.length === 1 ? "" : "s"} to judge:`,
		"",
		...renderIssues(outcome.issues),
	);
	return lines.join("\n");
}

/** A move step. A blocked site stops the whole move, so a refusal names what could not be written. */
export function renderMoveOutcome(toModule: string, outcome: MoveOutcome): string {
	if (!outcome.moved) {
		const lines = [
			`# Not moved

${outcome.reason ?? `the move could not be carried out`}`,
		];
		if (outcome.issues.length > 0) lines.push("", ...renderIssues(outcome.issues));
		return lines.join("\n");
	}

	const modules = outcome.modules ?? [];
	const lines = [
		`# Moved to ${code(toModule)}

${modules.length} file${modules.length === 1 ? "" : "s"} written: ${modules.map((m) => code(m)).join(", ")}`,
	];
	if (outcome.order !== undefined && outcome.order.length > 1) {
		lines.push(`
Moved in order, one step each: ${outcome.order.map((name) => code(name)).join(", ")}`);
	}
	if (outcome.issues.length > 0) lines.push("", ...renderIssues(outcome.issues));
	return lines.join("\n");
}

/** A rename step, with what the index could not promise. */
export function renderRenameStep(newName: string, outcome: RenameStepOutcome): string {
	if (!outcome.renamed) {
		const lines = [
			`# Not renamed

${outcome.reason ?? `the rename could not be carried out`}`,
		];
		if (outcome.issues.length > 0) lines.push("", ...renderIssues(outcome.issues));
		return lines.join("\n");
	}

	const modules = outcome.modules ?? [];
	const lines = [
		`# Renamed to ${newName}

${modules.length} file${modules.length === 1 ? "" : "s"} reindexed: ${modules.map((m) => code(m)).join(", ")}`,
	];

	if (outcome.issues.length > 0) lines.push("", ...renderIssues(outcome.issues));
	return lines.join("\n");
}

export function renderRefactorCommit(outcome: RefactorCommitResult): string {
	if (outcome.committed) {
		const note = outcome.issues.length > 0 ? ` ${outcome.issues.length} issue(s) were accepted by force.` : "";
		return `# Committed\n\nThe transaction is closed and nothing is undoable now.${note}`;
	}

	return [
		`# Not committed`,
		"",
		outcome.reason ?? `the transaction could not be committed`,
		"",
		...renderIssues(outcome.issues),
	].join("\n");
}
