// Working out what a refactor WOULD do, and writing none of it.
//
// Nothing here writes or reindexes, so a plan is always safe to ask for. Providers only through
// ProviderProbe, which restores its own state in a finally.

import type {
	FileFacts,
	MoveDependency,
	MoveEditsRequest,
	MovePlan,
	Range,
	RenameConcern,
	RenameEditPlan,
	RenamePlan,
	RenameSite,
	UnknownReason,
} from "@nyaa-lexicon/protocol";
import {
	applyEdits,
	comparePositions,
	composeSymbolId,
	coordinatesOf,
	hashContent,
	isParameterSymbol,
	isWithin,
	normalizeModulePath,
	ownerOf,
	parseSymbolId,
	rebaseSymbolId,
	sameRange,
} from "@nyaa-lexicon/protocol";
import type { FileEdits } from "./applyEdits.js";
import type { ImportResolver } from "./imports.js";
import type { ProviderProbe } from "./providerProbe.js";
import { subjectRefused } from "./refusals.js";
import type { SourceWorkspace, SymbolSource } from "./sourceWorkspace.js";
import type { IndexStore, StoredDeclaration } from "./store.js";
import type { RefactorIssue } from "./transactions.js";

export type { MovePlan, RenameConcern, RenameEditPlan, RenameFile, RenamePlan } from "@nyaa-lexicon/protocol";

////////////////////////////////
//  Functions & Helpers

/** A module a plan may create or write, in its canonical spelling, or why not. */
function workspaceModule(raw: string): { module: string } | { refused: string } {
	try {
		return { module: normalizeModulePath(raw) };
	} catch (error) {
		return { refused: error instanceof Error ? error.message : String(error) };
	}
}

function detailOf(detail: string | undefined): string {
	return detail === undefined ? "" : `: ${detail}`;
}

/**
 * Whether a name failing to bind means the code is broken, or merely outside the index.
 *
 * A standard library call answers ExternalDependency and a local answers NotIndexed, and both are
 * correct code. Reporting them would make every edit that calls a method look like breakage, which
 * is what a first run against a real file showed.
 */
/**
 * A stored provenance back to the reason it came from.
 *
 * An unbound reference stores its reason in the provenance column. Anything else there belongs to
 * a binding that succeeded, which has no reason, so the honest answer is that the index does not
 * hold the target.
 */
function unknownReasonOf(provenance: string): UnknownReason {
	return UNKNOWN_REASONS.includes(provenance as UnknownReason) ? (provenance as UnknownReason) : "NotIndexed";
}

const UNKNOWN_REASONS: UnknownReason[] = [
	"NotImplemented",
	"DynamicallyTyped",
	"ExternalDependency",
	"ParseError",
	"RecursionLimit",
	"Ambiguous",
	"RuntimeConstructed",
	"NotIndexed",
];

function isDangling(reason: string): boolean {
	return reason !== "ExternalDependency" && reason !== "NotIndexed" && reason !== "DynamicallyTyped";
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

////////////////////////////////
//  Interfaces & Types

/** How many times one name in one role failed to bind, kept with the parts so nothing re-splits. */
interface UnboundTally {
	name: string;
	role: string;
	/** Why the provider could not bind it, so a report says more than "does not resolve". */
	reason: string;
	count: number;
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
			issues: RefactorIssue[];
	  }
	| { ok: false; reason: string };

/** Whole new contents per module, so the writer never re-derives an edit it did not check. */
export type MoveEditsOutcome =
	| { ok: true; files: Array<{ module: string; text: string }>; issues: RefactorIssue[] }
	| { ok: false; issues: RefactorIssue[]; reason: string };

export interface InsertArgs {
	/** Sibling anchor: the new declaration goes directly after this one. */
	after?: string | undefined;
	/** Top-level append target; created if absent. Exactly one of the two anchors. */
	module?: string | undefined;
	/** The declaration(s), flush-left. The planner owns indentation. */
	text: string;
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
			/** The exact whole-line block spliced in, indentation applied, framing blanks excluded. */
			block: string;
			/** Null when the module is being created. */
			baseHash: string | null;
			issues: RefactorIssue[];
	  }
	| { state: "present"; module: string }
	| { state: "refused"; reason: string };

/** Where an insert lands. `line` null means append at end of file. */
interface SplicePoint {
	module: string;
	before: string;
	created: boolean;
	line: number | null;
	indent: string;
	/** Blank line between block and what follows; true only above a sibling. */
	trailingBlank: boolean;
}

////////////////////////////////
//  Class

/** Takes readFile too: a provider needs a file's whole text, not one symbol's span. */
export class RefactorPlanner {
	constructor(
		private readonly store: IndexStore,
		private readonly imports: ImportResolver,
		private readonly source: SourceWorkspace,
		private readonly probe: ProviderProbe,
		private readonly readFile: (module: string) => string | null,
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
	): Promise<ReplacementPlan> {
		const source = this.source.symbolSource(address);
		if (!source.found) return { ok: false, reason: source.reason };

		const guard = this.replacementGuard(address, source);
		if (guard) return { ok: false, reason: guard };

		const before = this.readFile(source.module);
		if (before === null) return { ok: false, reason: `${source.module} is not on disk any more` };

		const spliced = applyEdits(before, [{ range: source.range, newText }]);
		if ("problem" in spliced) return { ok: false, reason: spliced.problem };

		const owner = this.probe.owner(source.module);
		if (!owner.owned) return { ok: false, reason: `no provider owns ${source.module}` };

		// The probe restores the provider's view of the module before it returns, on every path, so
		// nothing below has to remember to.
		const candidate = await this.probe.parseCandidate(source.module, spliced.text);
		if (!candidate.parsed) return { ok: false, reason: `the replacement does not parse: ${candidate.reason}` };

		const renamed = this.renamedDeclaration(address, candidate.facts, source);
		if (renamed) return { ok: false, reason: renamed };

		const issues = this.impactOf(source.module, candidate.facts);
		const unchecked = this.syntaxUnchecked(owner.providerId, source.module);
		if (unchecked !== null) issues.push(unchecked);

		return {
			ok: true,
			module: source.module,
			text: spliced.text,
			range: source.range,
			baseHash: hashContent(before),
			issues,
		};
	}

	/**
	 * What inserting new declaration(s) would do, without writing anything.
	 *
	 * Same shape as a replacement: everything expensive happens here, the caller holds the gate for
	 * the write alone. Refusal beats guessing at every ambiguous spot.
	 */
	async planInsert(args: InsertArgs): Promise<InsertPlan> {
		const flush = args.text.replace(/\s+$/, "");
		if (flush.trim().length === 0) return { state: "refused", reason: "nothing to insert" };
		if ((args.after === undefined) === (args.module === undefined)) {
			return { state: "refused", reason: "set exactly one of after or module" };
		}

		const point = args.after !== undefined ? this.afterPoint(args.after) : this.endPoint(args.module as string);
		if ("refused" in point) return { state: "refused", reason: point.refused };

		const block = flush
			.split("\n")
			.map((line) => (line.trim().length === 0 ? "" : point.indent + line))
			.join("\n");

		if (this.blockPresent(point, block)) return { state: "present", module: point.module };

		const candidate = this.spliceBlock(point, block);
		if (typeof candidate !== "string") return { state: "refused", reason: candidate.problem };

		const owner = this.probe.owner(point.module);
		if (!owner.owned) return { state: "refused", reason: `no provider owns ${point.module}: ${owner.reason}` };

		const parsed = await this.probe.parseCandidate(point.module, candidate);
		if (!parsed.parsed) return { state: "refused", reason: `the insert does not parse: ${parsed.reason}` };

		const issues = this.impactOf(point.module, parsed.facts);
		const unchecked = this.syntaxUnchecked(owner.providerId, point.module);
		if (unchecked !== null) issues.push(unchecked);
		issues.push(...this.collisionWarnings(point.module, parsed.facts));

		return {
			state: "planned",
			module: point.module,
			created: point.created,
			candidate,
			block,
			baseHash: point.created ? null : hashContent(point.before),
			issues,
		};
	}

	/** The splice for a sibling anchor, or an honest refusal where no sound point exists. */
	private afterPoint(after: string): SplicePoint | { refused: string } {
		const anchor = this.store.declaration(after);
		if (!anchor) return { refused: subjectRefused(after, this.store) };
		const module = anchor.module;
		const before = this.readFile(module);
		if (before === null) return { refused: `${module} is not on disk any more` };

		// The stored ranges address ONE version of the file; a moved file makes them wrong lines.
		const indexed = this.store.contentHashOf(module);
		if (indexed !== null && indexed !== hashContent(before)) {
			return { refused: `${module} changed since it was indexed; reindex and retry` };
		}

		// The name line is the declaration line; the range starts at leading comments, which may
		// legally indent differently.
		if (
			anchor.selectionRange === undefined ||
			anchor.selectionRange.start.line !== anchor.selectionRange.end.line
		) {
			return { refused: `the provider gives ${anchor.name} no single-line name, so indentation cannot be read` };
		}
		const coords = coordinatesOf(before);
		const nameLine = coords.lineText(anchor.selectionRange.start.line);
		if (nameLine === undefined) return { refused: `${module} changed since it was indexed; reindex and retry` };
		const indent = /^[ \t]*/.exec(nameLine)?.[0] ?? "";

		// SAME SCOPE only: without the container filter, a member anchor's "next sibling" was the
		// next top-level declaration, splicing member-indented text OUTSIDE the container.
		// Declarator and overload groups share ranges; nested declarations of a later sibling have
		// their own containerId and never compete.
		const scope = anchor.containerId ?? null;
		let next: StoredDeclaration | null = null;
		for (const candidate of this.store.declarationsIn(module)) {
			if (candidate.symbolId === anchor.symbolId) continue;
			if ((candidate.containerId ?? null) !== scope) continue;
			if (isWithin(candidate.symbolId, anchor.symbolId)) continue;
			if (sameRange(candidate.range, anchor.range)) continue;
			if (comparePositions(candidate.range.start, anchor.range.end) < 0) continue;
			if (next === null || comparePositions(candidate.range.start, next.range.start) < 0) next = candidate;
		}

		const shared = (who: string) => ({
			refused: `no whole-line insertion point exists after the anchor (${who} leaves it no line of its own); hand-edit or anchor elsewhere`,
		});

		if (next !== null) {
			if (next.range.start.line === anchor.range.end.line) return shared(next.name);
			return { module, before, created: false, line: next.range.start.line, indent, trailingBlank: true };
		}

		if (anchor.containerId === undefined) {
			return { module, before, created: false, line: null, indent, trailingBlank: false };
		}
		const container = this.store.declaration(anchor.containerId);
		if (!container) return { refused: subjectRefused(anchor.containerId, this.store) };
		const endPos = container.range.end;
		const endLine = coords.lineText(endPos.line);
		// Computable only when the end line holds nothing but closers: range.end is exclusive, and
		// with the anchor proven to end on an earlier line, whitespace and closing punctuation ahead
		// of it (C and C++ ranges end after "};") all belong to the container's own terminator.
		const clean =
			endLine !== undefined &&
			endPos.character >= 1 &&
			endPos.character <= endLine.length &&
			!/[^\s}\])>;,]/.test(endLine.slice(0, endPos.character - 1)) &&
			anchor.range.end.line < endPos.line;
		if (!clean) return shared(container.name);
		return { module, before, created: false, line: endPos.line, indent, trailingBlank: false };
	}

	private endPoint(rawModule: string): SplicePoint | { refused: string } {
		// "Created if absent" must never mean created OUTSIDE the workspace.
		const target = workspaceModule(rawModule);
		if ("refused" in target) return target;
		const module = target.module;
		const before = this.readFile(module);
		return {
			module,
			before: before ?? "",
			created: before === null,
			line: null,
			indent: "",
			trailingBlank: false,
		};
	}

	/** The retry answer: true when the exact block already sits where the splice would put it. */
	private blockPresent(point: SplicePoint, block: string): boolean {
		if (point.line !== null) {
			const start = coordinatesOf(point.before).offsetAt({ line: point.line, character: 0 });
			if (start === undefined) return false;
			const window = point.before.slice(start, start + block.length);
			const following = point.before.slice(start + block.length, start + block.length + 1);
			return window === block && (following === "\n" || following === "");
		}
		const trimmed = point.before.replace(/\n+$/, "");
		if (!trimmed.endsWith(block)) return false;
		return trimmed.length === block.length || trimmed[trimmed.length - block.length - 1] === "\n";
	}

	/** Whole-line splice, framed by blank lines where the neighbors are not already blank. */
	private spliceBlock(point: SplicePoint, block: string): string | { problem: string } {
		if (point.line !== null) {
			const coords = coordinatesOf(point.before);
			const above = point.line === 0 ? undefined : coords.lineText(point.line - 1);
			const leadingBlank = above !== undefined && above.trim().length > 0 ? "\n" : "";
			const newText = `${leadingBlank}${block}\n${point.trailingBlank ? "\n" : ""}`;
			const at = { line: point.line, character: 0 };
			const applied = applyEdits(point.before, [{ range: { start: at, end: at }, newText }]);
			return "problem" in applied ? applied : applied.text;
		}

		if (point.before.length === 0) return `${block}\n`;
		const base = point.before.endsWith("\n") ? point.before : `${point.before}\n`;
		const separator = base.endsWith("\n\n") ? "" : "\n";
		return `${base}${separator}${block}\n`;
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

	/** Importers are found from stored references and imports, each written by the provider owning the
	 * file it is in. One claiming neither reported none, which is not the same as there being none. */
	private importersUnfound(modules: string[]): RefactorIssue[] {
		const issues: RefactorIssue[] = [];
		for (const module of new Set(modules)) {
			const owner = this.probe.owner(module);
			if (!owner.owned) continue;
			const missing = (["references", "imports"] as const).filter(
				(tier) => !this.probe.declares(owner.providerId, tier),
			);
			if (missing.length === 0) continue;
			issues.push({
				kind: "ImportersUnchecked",
				detail: `the provider for ${module} reports no ${missing.join(" and no ")}, so uses of the moved symbol there were not looked for`,
				module,
			});
		}
		return issues;
	}

	/** Insert is rename's mirror: a new binder lands among existing uses. Whether that captures
	 * them is a language question core must not answer, so it is a warning, never a blocker. */
	private collisionWarnings(module: string, candidate: FileFacts): RefactorIssue[] {
		const stored = this.store.declarationsIn(module);
		const storedIds = new Set(stored.map((declaration) => declaration.symbolId));
		const warnings: RefactorIssue[] = [];

		for (const minted of candidate.declarations) {
			if (storedIds.has(minted.symbolId)) continue;
			const scope = minted.containerId ?? null;
			const declared = stored.filter(
				(existing) => existing.name === minted.name && (existing.containerId ?? null) === scope,
			);
			// Imports are module-level, provably not inside a member container.
			const imported =
				scope === null ? this.store.importsBinding(minted.name).filter((entry) => entry.module === module) : [];
			if (declared.length === 0 && imported.length === 0) continue;
			warnings.push({
				kind: "NameAlreadyBound",
				detail: `${minted.name} is already ${declared.length > 0 ? "declared" : "imported"} here; existing uses of the name may rebind to the inserted declaration`,
				module,
			});
		}
		return warnings;
	}

	/**
	 * What moving one declaration to another module would involve, without writing anything.
	 *
	 * The core works out WHICH modules are touched and WHAT the moved body depends on, both of
	 * which come out of the index. Rendering the text is the provider's, so this stops at handing
	 * each module a request.
	 */
	planMove(symbolId: string, rawTarget: string): MovePlan {
		const target = workspaceModule(rawTarget);
		if ("refused" in target) return { ok: false, reason: target.refused };
		const toModule = target.module;

		const declaration = this.store.declaration(symbolId);
		if (!declaration) return { ok: false, reason: subjectRefused(symbolId, this.store) };
		if (declaration.module === toModule) return { ok: false, reason: `${symbolId} is already in ${toModule}` };

		const source = this.source.symbolSource({ symbolId });
		if (!source.found) return { ok: false, reason: source.reason };

		const closure = this.store.symbolIdsIn(declaration.module).filter((candidate) => isWithin(candidate, symbolId));

		const dependencies = this.dependenciesOf(declaration.module, closure, symbolId);

		// Modules whose imports name the moved symbol, plus the source itself when something left
		// behind still uses it.
		const referencing = new Set(
			this.store
				.referencesTo(symbolId)
				.map((reference) => reference.module)
				.filter((module) => module !== declaration.module),
		);
		const usedAtSource = this.store
			.referencesTo(symbolId)
			.some((reference) => reference.module === declaration.module && !this.inRange(reference, source.range));

		return {
			ok: true,
			symbolId,
			name: declaration.name,
			fromModule: declaration.module,
			toModule,
			text: source.text,
			removal: source.range,
			closure,
			dependencies,
			referencing: [...referencing],
			usedAtSource,
			baseHash: source.contentHash,
		};
	}

	/**
	 * Asks every involved module's provider for its part of a move.
	 *
	 * One blocked site anywhere fails the whole move. A relocated declaration whose importers still
	 * point at the old module is code that does not build, which is worse than not starting.
	 */
	async moveEdits(plan: Extract<MovePlan, { ok: true }>): Promise<MoveEditsOutcome> {
		const requests = this.moveRequests(plan);
		const files: Array<{ module: string; text: string }> = [];
		const blocked: RefactorIssue[] = [];

		for (const request of requests) {
			const before = request.exists ? (this.readFile(request.module) ?? "") : "";
			const answer = await this.probe.moveEdits(request.module, { ...request, text: before });

			if (answer.status === "refused") {
				return {
					ok: false,
					issues: [],
					reason: `${request.module}: ${answer.reason}${detailOf(answer.detail)}`,
				};
			}
			for (const site of answer.blocked) {
				blocked.push({
					kind: site.reason,
					detail: `${request.module}: ${site.detail ?? "cannot be rewritten safely"}`,
					module: request.module,
				});
			}
			if (answer.edits.length === 0) continue;

			const applied = applyEdits(before, answer.edits);
			if ("problem" in applied) {
				return { ok: false, issues: [], reason: `${request.module}: ${applied.problem}` };
			}
			files.push({ module: request.module, text: applied.text });
		}

		if (blocked.length > 0) {
			return { ok: false, issues: blocked, reason: "some occurrences cannot be rewritten" };
		}
		return { ok: true, files, issues: this.importersUnfound([plan.fromModule, ...plan.referencing]) };
	}

	/** One request per involved module, each describing only that module's part. */
	private moveRequests(plan: Extract<MovePlan, { ok: true }>): MoveEditsRequest[] {
		const shared = {
			symbolId: plan.symbolId,
			name: plan.name,
			fromModule: plan.fromModule,
			toModule: plan.toModule,
		};

		const requests: MoveEditsRequest[] = [
			{
				...shared,
				module: plan.fromModule,
				text: "",
				exists: true,
				role: { removal: plan.removal },
				importSites: [],
				// The source keeps needing the symbol when something left behind still calls it.
				dependencies: plan.usedAtSource
					? [
							{
								name: plan.name,
								origin: { kind: "workspaceModule", symbolId: plan.symbolId, module: plan.toModule },
							},
						]
					: [],
				sites: [],
			},
			{
				...shared,
				module: plan.toModule,
				text: "",
				exists: this.readFile(plan.toModule) !== null,
				role: { insertion: { text: plan.text } },
				importSites: [],
				dependencies: plan.dependencies,
				sites: [],
			},
		];

		for (const module of plan.referencing) {
			requests.push({
				...shared,
				module,
				text: "",
				exists: true,
				role: {},
				importSites: this.imports.importSitesForMove(module, plan.name),
				dependencies: [],
				sites: [],
			});
		}

		return requests;
	}

	/**
	 * Whether the moved symbol is still reachable from everywhere that used it.
	 *
	 * Run after the reindex, because the question is about what the providers concluded rather than
	 * what the edits looked like. A specifier that is syntactically fine and points nowhere produces
	 * exactly this: an importer whose reference no longer binds.
	 */
	checkMoveLanded(name: string, modules: string[]): RefactorIssue[] {
		const issues: RefactorIssue[] = [];

		for (const module of modules) {
			for (const reference of this.store.referencesIn(module)) {
				if (reference.name !== name) continue;
				if (reference.targetId !== null) continue;
				if (!isDangling(reference.provenance)) continue;

				issues.push({
					kind: "UnresolvedAfterMove",
					detail: `${name} no longer resolves here: ${reference.provenance}`,
					module,
					line: reference.startLine + 1,
				});
			}
		}

		return issues;
	}

	/** Re-mints one id of a moved closure for its new module. */
	rebaseIntoModule(id: string, movedId: string, toModule: string): string | null {
		const parsed = parseSymbolId(movedId);
		if (parsed === null) return null;
		return rebaseSymbolId(id, movedId, composeSymbolId({ ...parsed, module: toModule }));
	}

	/** Whether a stored reference sits inside a range, which is how the moved body is bounded. */
	private inRange(reference: { startLine: number; startCharacter: number }, range: Range): boolean {
		if (reference.startLine < range.start.line || reference.startLine > range.end.line) return false;
		if (reference.startLine === range.start.line && reference.startCharacter < range.start.character) return false;
		if (reference.startLine === range.end.line && reference.startCharacter > range.end.character) return false;
		return true;
	}

	/**
	 * Every name the moved body uses, with what the index proved about where it comes from.
	 *
	 * Walked over the whole closure rather than over references owned by the moved symbol, because
	 * a moved class's body references belong to its METHODS and a top-level initializer may be
	 * owned by nothing at all.
	 */
	dependenciesOf(module: string, closure: string[], symbolId: string): MoveDependency[] {
		const inside = new Set(closure);
		const source = this.source.symbolSource({ symbolId });
		if (!source.found) return [];

		const seen = new Set<string>();
		const dependencies: MoveDependency[] = [];

		for (const reference of this.store.referencesIn(module)) {
			if (!this.inRange(reference, source.range)) continue;
			if (seen.has(reference.name)) continue;
			seen.add(reference.name);

			const target = reference.targetId;
			if (target !== null && inside.has(target)) {
				dependencies.push({ name: reference.name, origin: { kind: "insideClosure", symbolId: target } });
				continue;
			}

			if (target !== null) {
				const declaration = this.store.declaration(target);
				if (declaration?.module === module) {
					dependencies.push({
						name: reference.name,
						origin: {
							kind: "sourceModule",
							symbolId: target,
							name: declaration.name,
							...(declaration.exported === undefined ? {} : { exported: declaration.exported }),
						},
					});
					continue;
				}
				if (declaration) {
					dependencies.push({
						name: reference.name,
						origin: { kind: "workspaceModule", symbolId: target, module: declaration.module },
					});
					continue;
				}
			}

			const via = this.imports.importOriginFor(module, reference.name);
			if (via !== null) {
				dependencies.push({ name: reference.name, origin: { kind: "external", via } });
				continue;
			}

			// A benign unbound reference is a builtin or an external the index never claims to place;
			// listing it would make every provider block on `int` or `max`. Only reasons that mark a
			// genuinely unplaceable name flow through, and the provider decides what those block.
			const reason = unknownReasonOf(reference.provenance);
			if (!isDangling(reason)) continue;

			dependencies.push({
				name: reference.name,
				origin: { kind: "unresolved", reason },
			});
		}

		return dependencies;
	}

	/**
	 * Every id a rename re-mints, old to new.
	 *
	 * A member's id carries its container's descriptors, so renaming a class re-mints its methods
	 * and their parameters too. Migrating only the class itself would strand everything written
	 * about them under ids nothing resolves.
	 */
	renameIdMap(symbolId: string, newName: string): Map<string, string> {
		const declaration = this.store.declaration(symbolId);
		const map = new Map<string, string>();
		if (!declaration) return map;

		const parsed = parseSymbolId(symbolId);
		if (parsed === null || parsed.local !== undefined) return map;

		const last = parsed.descriptors.at(-1);
		if (last === undefined) return map;
		const renamed = composeSymbolId({
			...parsed,
			descriptors: [...parsed.descriptors.slice(0, -1), { ...last, name: newName }],
		});

		for (const candidate of this.store.symbolIdsIn(declaration.module)) {
			const rebased = rebaseSymbolId(candidate, symbolId, renamed);
			if (rebased !== null) map.set(candidate, rebased);
		}
		return map;
	}

	/**
	 * Modules whose stored facts name an id the rename re-mints, whether or not their text changes.
	 *
	 * A file calling a renamed class's METHOD contains no occurrence of the class name, so it gets
	 * no edit, yet its reference rows point at ids that are about to stop existing. Left alone it
	 * would keep answering with them.
	 */
	modulesBoundTo(ids: Iterable<string>): string[] {
		const modules = new Set<string>();
		for (const id of ids) {
			for (const reference of this.store.referencesTo(id)) modules.add(reference.module);
		}
		return [...modules];
	}

	/** Reasons a replacement is refused before it is even parsed. */
	private replacementGuard(
		address: { symbolId?: string | undefined },
		source: Extract<SymbolSource, { found: true }>,
	): string | null {
		if (address.symbolId === undefined) return null;

		// Two declarations sharing an id means the store kept one and discarded the other, so the
		// address names something the index cannot tell apart.
		const sharing = this.store
			.declarationsIn(source.module)
			.filter((declaration) => declaration.symbolId === address.symbolId);
		if (sharing.length > 1) {
			return `${address.symbolId} names more than one declaration in ${source.module}, so it cannot be replaced safely`;
		}

		// One statement can declare several names, giving each the same span. Replacing that span
		// would rewrite siblings the caller never addressed.
		const overlapping = this.store.declarationsIn(source.module).filter((declaration) => {
			if (declaration.symbolId === address.symbolId) return false;
			if (isWithin(declaration.symbolId, address.symbolId as string)) return false;
			if (isWithin(address.symbolId as string, declaration.symbolId)) return false;
			return sameRange(declaration.range, source.range);
		});
		if (overlapping.length > 0) {
			const names = overlapping.map((declaration) => declaration.name).join(", ");
			return `${source.name} shares its span with ${names}, so replacing it would rewrite them too`;
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
		address: { symbolId?: string | undefined },
		candidate: FileFacts,
		source: Extract<SymbolSource, { found: true }>,
	): string | null {
		if (address.symbolId === undefined) return null;
		if (candidate.declarations.some((declaration) => declaration.symbolId === address.symbolId)) return null;

		// The id is gone, which is either a rename or a deletion. Deleting is a real refactor and is
		// allowed; the orphan check reports what still points at it. A rename is refused, because
		// only rename rewrites the callers and carries the knowledge across.
		const before = new Set(this.store.declarationsIn(source.module).map((declaration) => declaration.symbolId));
		const old = this.store.declaration(address.symbolId);
		const replacement = candidate.declarations.find(
			(declaration) =>
				!before.has(declaration.symbolId) &&
				declaration.kind === old?.kind &&
				declaration.containerId === old?.containerId,
		);
		if (!replacement) return null;

		return `the replacement renames ${source.name} to ${replacement.name}, which replace cannot do. Keep the name, or use refactor_rename.`;
	}

	/**
	 * What the candidate breaks, minus what was already broken.
	 *
	 * Subtracted by (name, role, reason) rather than by fact id, because a fact id contains its
	 * range: any edit above an untouched problem would otherwise make it look newly introduced.
	 */
	impactOf(module: string, candidate: FileFacts): RefactorIssue[] {
		const issues: RefactorIssue[] = [];

		const before = this.store.declarationsIn(module);
		const after = new Set(candidate.declarations.map((declaration) => declaration.symbolId));
		for (const declaration of before) {
			if (after.has(declaration.symbolId)) continue;
			const users = this.store.referencesTo(declaration.symbolId).filter((row) => row.module !== module);
			if (users.length === 0) continue;

			issues.push({
				kind: "OrphanedReference",
				detail: `${declaration.name} is gone but still used in ${[...new Set(users.map((u) => u.module))].join(", ")}`,
				module,
			});
		}

		const wasUnbound = countUnbound(
			this.store
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

	/**
	 * What renaming a symbol would touch, and what stands in the way. Reads only.
	 *
	 * The whole reason this is separate from applying: a rename is honest only over a set that is
	 * provably closed, and closedness is a question the index can answer without editing anything.
	 * The occurrences come from bound edges alone, because a name match is a guess and a guess is
	 * acceptable in a reading tool and disqualifying in a writing one.
	 */
	async prepareRename(symbolId: string, newName: string): Promise<RenamePlan> {
		const declaration = this.store.declaration(symbolId);
		if (!declaration) {
			return {
				symbolId,
				oldName: "",
				newName,
				files: [],
				occurrences: 0,
				blockers: [{ kind: "NotIndexed", detail: subjectRefused(symbolId, this.store) }],
				warnings: [],
			};
		}

		const oldName = declaration.name;
		// A name that is nowhere in the source has no site to rewrite.
		if (declaration.selectionRange === undefined) {
			return {
				symbolId,
				oldName,
				newName,
				files: [],
				occurrences: 0,
				blockers: [
					{ kind: "NameNotInSource", detail: `${oldName} is named after its file, not written in it` },
				],
				warnings: [],
			};
		}
		const byModule = new Map<string, RenameSite[]>();
		// The declaration's own name is a site like any other, and forgetting it renames every use
		// to point at a definition that still has the old name.
		byModule.set(declaration.module, [{ range: declaration.selectionRange }]);

		for (const reference of this.store.referencesTo(symbolId)) {
			const sites = byModule.get(reference.module) ?? [];
			sites.push({
				range: {
					start: { line: reference.startLine, character: reference.startCharacter },
					end: { line: reference.endLine, character: reference.endCharacter },
				},
				role: reference.role,
			});
			byModule.set(reference.module, sites);
		}

		for (const site of await this.imports.importSitesFor(declaration.module, oldName)) {
			const sites = byModule.get(site.module) ?? [];
			sites.push({ range: site.range, role: "import" });
			byModule.set(site.module, sites);
		}

		// Renaming an owned symbol reaches its owner's CALLERS: a Python keyword argument names the
		// parameter at a site that spells the function's name, so nothing searching for the old name
		// can find it. Gathered here because who calls what is the index's question, not a provider's.
		const ownerCalls = this.ownerCallsFor(symbolId);
		// A file holding only owner calls still has to be visited, so it needs an entry even with no
		// occurrence of the old name in it.
		for (const module of ownerCalls.keys()) if (!byModule.has(module)) byModule.set(module, []);

		// Absent and empty mean different things, and the difference is the whole contract here.
		// EMPTY says the core gathered the owner's calls and none are in this file, which is the
		// normal case for the declaring file. ABSENT says nothing was gathered, so a provider still
		// has to refuse. Attaching the field only where calls happen to live conflates the two, and a
		// parameter declared in a file that never calls its own function would refuse forever.
		const owned = isParameterSymbol(symbolId);
		const files = [...byModule.entries()].map(([module, sites]) => ({
			module,
			sites,
			...(owned ? { ownerCalls: ownerCalls.get(module) ?? [] } : {}),
		}));
		const blockers =
			newName === oldName
				? [{ kind: "SameName", detail: `already named ${oldName}` }]
				: this.renameCollisions(symbolId, newName, new Set(byModule.keys()));

		return {
			symbolId,
			oldName,
			newName,
			files,
			occurrences: files.reduce((total, file) => total + file.sites.length, 0),
			blockers,
			warnings: [...this.renameWarnings(declaration, oldName, symbolId), ...this.ownerCallConcerns(symbolId)],
		};
	}

	/**
	 * Bound calls to the declaration that owns this symbol, grouped by file.
	 *
	 * Empty for anything that owns itself, which is nearly every rename. For a parameter it is the
	 * set of call sites whose named arguments have to move with it, and the id grammar alone says
	 * which declaration that is, so no language knowledge enters here.
	 */
	private ownerCallsFor(symbolId: string): Map<string, Range[]> {
		const byModule = new Map<string, Range[]>();
		if (!isParameterSymbol(symbolId)) return byModule;

		const owner = ownerOf(symbolId);
		if (owner === null) return byModule;

		for (const reference of this.store.referencesTo(owner)) {
			if (reference.role !== "call") continue;
			const ranges = byModule.get(reference.module) ?? [];
			ranges.push({
				start: { line: reference.startLine, character: reference.startCharacter },
				end: { line: reference.endLine, character: reference.endCharacter },
			});
			byModule.set(reference.module, ranges);
		}
		return byModule;
	}

	/**
	 * What a rename of an owned symbol cannot see.
	 *
	 * A call that never bound may still pass the argument being renamed, and nothing here can tell a
	 * genuinely different function from one binding could not follow. Reported rather than guessed,
	 * which is the same rule the same-spelling warning already follows.
	 */
	private ownerCallConcerns(symbolId: string): RenameConcern[] {
		if (!isParameterSymbol(symbolId)) return [];

		const owner = ownerOf(symbolId);
		const declaration = owner === null ? null : this.store.declaration(owner);
		if (declaration === null) {
			return [
				{
					kind: "OwnerNotIndexed",
					detail: "the declaration this belongs to is not indexed, so its call sites cannot be found",
				},
			];
		}

		const unbound = this.store.referencesSpelled(declaration.name, declaration.symbolId);
		if (unbound.length === 0) return [];
		return [
			{
				kind: "OwnerCallsUnresolved",
				detail: `${unbound.length} occurrence${unbound.length === 1 ? "" : "s"} of ${declaration.name} did not bind to it. If any is a call passing this argument by name, it will not be rewritten`,
				sites: unbound.slice(0, 20).map((r) => ({ module: r.module, line: r.startLine + 1 })),
			},
		];
	}

	/**
	 * Places the new name already means something, in a file this rename would rewrite.
	 *
	 * Without this a rename produces a file where one spelling means two things, which still parses
	 * often enough to be committed. Checked against the files being REWRITTEN rather than the whole
	 * workspace, because another module owning the name is normal and only a collision inside a file
	 * we are editing is a collision.
	 *
	 * A blocker rather than a warning: this is something known to break, not somewhere we cannot see
	 * far enough. Each one names the conflicting site and both ways out, since a refusal that does
	 * not say what to do next just moves the search to the caller.
	 */
	private renameCollisions(symbolId: string, newName: string, touched: Set<string>): RenameConcern[] {
		const declared = this.store
			.declarationsNamed(newName)
			.filter((other) => other.symbolId !== symbolId && touched.has(other.module));

		const bound = this.store.importsBinding(newName).filter((entry) => touched.has(entry.module));

		const concerns: RenameConcern[] = [];
		if (declared.length > 0) {
			concerns.push({
				kind: "NameTaken",
				detail: `${newName} is already declared in ${declared.length === 1 ? "a file" : `${declared.length} files`} this rename rewrites. Rename that declaration first, or pick another name.`,
				sites: declared.map((other) => ({
					module: other.module,
					line: (other.selectionRange ?? other.range).start.line,
				})),
			});
		}
		if (bound.length > 0) {
			concerns.push({
				kind: "NameImported",
				detail: `${newName} is already imported in ${bound.length === 1 ? "a file" : `${bound.length} files`} this rename rewrites, so the rewritten uses would bind to that import instead. Rename or alias that import first, or pick another name.`,
				sites: bound.map((entry) => ({ module: entry.module, line: entry.range?.start.line ?? 0 })),
			});
		}
		return concerns;
	}

	/**
	 * What a rename WOULD write, without writing it.
	 *
	 * Separate from `renameSymbol` because an editor applies the edits itself, and computing them
	 * twice is how the two disagree about which occurrences a rename touches.
	 *
	 * One blocked site fails the whole operation: it is an occurrence that should change and cannot,
	 * so applying the rest leaves code that no longer builds.
	 */
	async renameEdits(symbolId: string, newName: string): Promise<RenameEditPlan> {
		const plan = await this.prepareRename(symbolId, newName);
		if (plan.blockers.length > 0) return { ok: false, plan, reason: plan.blockers[0]?.detail ?? "blocked" };

		const files: FileEdits[] = [];
		const blocked: RenameConcern[] = [];

		for (const file of plan.files) {
			const text = this.readFile(file.module);
			if (text === null) return { ok: false, plan, reason: `${file.module} could not be read` };

			const answer = await this.probe.renameEdits(file.module, {
				module: file.module,
				text,
				oldName: plan.oldName,
				newName,
				sites: file.sites,
				...(file.ownerCalls === undefined ? {} : { ownerCalls: file.ownerCalls }),
			});

			if (answer.status === "refused") {
				return { ok: false, plan, reason: `${file.module}: ${answer.reason}${detailOf(answer.detail)}` };
			}
			for (const site of answer.blocked) {
				blocked.push({
					kind: site.reason,
					detail: `${file.module}: ${site.detail ?? "cannot be rewritten safely"}`,
					sites: [{ module: file.module, line: site.range.start.line + 1 }],
				});
			}
			if (answer.edits.length > 0) files.push({ module: file.module, edits: answer.edits });
		}

		if (blocked.length > 0) {
			return {
				ok: false,
				plan: { ...plan, blockers: blocked },
				reason: "some occurrences cannot be rewritten",
			};
		}
		return { ok: true, plan, files };
	}

	/**
	 * Where the index cannot see far enough to promise a rename is complete.
	 *
	 * Both of these are uncertainty rather than failure, so they are stated and the caller decides.
	 * Refusing on either would refuse most real renames; hiding them would claim a completeness the
	 * index does not have.
	 */
	private renameWarnings(declaration: StoredDeclaration, oldName: string, symbolId: string): RenameConcern[] {
		const warnings: RenameConcern[] = [];

		const unbound = this.store.referencesSpelled(oldName, symbolId);
		if (unbound.length > 0) {
			warnings.push({
				kind: "SameSpellingUnbound",
				detail: `${unbound.length} occurrence${unbound.length === 1 ? "" : "s"} of ${oldName} did not bind to this symbol; some may be uses of it that binding could not follow`,
				sites: unbound.slice(0, 20).map((r) => ({ module: r.module, line: r.startLine + 1 })),
			});
		}

		if (declaration.exported === true) {
			warnings.push({
				kind: "ExportedBeyondIndex",
				detail: `${oldName} is exported, so anything outside this workspace that uses it is not visible here`,
			});
		}

		return warnings;
	}
}
