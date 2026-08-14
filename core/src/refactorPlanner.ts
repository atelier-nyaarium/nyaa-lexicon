// Working out what a refactor WOULD do, and writing none of it.
//
// Nothing here writes or reindexes, so a plan is always safe to ask for. Providers only through
// ProviderProbe, which restores its own state in a finally.

import type {
	Binding,
	FileFacts,
	MoveDependency,
	MoveEditsRequest,
	Range,
	RenameSite,
	UnknownReason,
} from "@nyaa-lexicon/protocol";
import {
	applyEdits,
	composeSymbolId,
	isParameterSymbol,
	isWithin,
	ownerOf,
	parseSymbolId,
	rebaseSymbolId,
} from "@nyaa-lexicon/protocol";
import type { FileEdits } from "./applyEdits.js";
import { isExternalModule } from "./fileScope.js";
import type { ImportResolver } from "./imports.js";
import { toSummary } from "./indexReads.js";
import type { ProviderProbe } from "./providerProbe.js";
import type { SourceWorkspace, SymbolSource } from "./sourceWorkspace.js";
import type { IndexStore, StoredDeclaration, StoredReference } from "./store.js";
import type { RefactorIssue } from "./transactions.js";
import { hashContent } from "./watcher.js";

////////////////////////////////
//  Functions & Helpers

function detailOf(detail: string | undefined): string {
	return detail === undefined ? "" : `: ${detail}`;
}

function sameRange(a: Range, b: Range): boolean {
	return (
		a.start.line === b.start.line &&
		a.start.character === b.start.character &&
		a.end.line === b.end.line &&
		a.end.character === b.end.character
	);
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

/** Occurrences of one symbol in one file, which is the unit a provider is asked to rewrite. */
export interface RenameFile {
	module: string;
	sites: RenameSite[];
	/** Calls in this file to the declaration owning the renamed symbol. Absent for an unowned one. */
	ownerCalls?: Range[];
}

/**
 * Two kinds of bad news, kept apart because they call for different decisions.
 *
 * A blocker is something we KNOW would break: the symbol is not indexed, or a provider refuses.
 * A warning is somewhere we cannot see far enough to promise: an occurrence spelled the same that
 * never bound, or a symbol exported past the edge of the index. Folding the second into the first
 * would refuse most real renames; folding the first into the second would ship broken code.
 */
export interface RenameConcern {
	kind: string;
	detail: string;
	/** Where it was found, when the concern is about specific occurrences. */
	sites?: Array<{ module: string; line: number }>;
}

export interface RenamePlan {
	symbolId: string;
	oldName: string;
	newName: string;
	files: RenameFile[];
	/** Total occurrences to rewrite, the declaration's own name included. */
	occurrences: number;
	blockers: RenameConcern[];
	warnings: RenameConcern[];
}

/**
 * A replacement worked out but not yet written.
 *
 * Carries the whole new file rather than an edit, because the splice was already checked against
 * the text it was cut from and re-deriving it at write time is how the two come to disagree.
 */
/** How many times one name in one role failed to bind, kept with the parts so nothing re-splits. */
interface UnboundTally {
	name: string;
	role: string;
	/** Why the provider could not bind it, so a report says more than "does not resolve". */
	reason: string;
	count: number;
}

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

/**
 * A move worked out but not yet written.
 *
 * The closure is the moved declaration plus everything declared inside it, which is what the id
 * migration and the dependency walk are both scoped to.
 */
export type MovePlan =
	| {
			ok: true;
			symbolId: string;
			name: string;
			fromModule: string;
			toModule: string;
			/** The declaration's own text, which is what gets inserted at the target. */
			text: string;
			removal: Range;
			closure: string[];
			dependencies: MoveDependency[];
			/** Modules importing the moved symbol, which need their specifier re-pointed. */
			referencing: string[];
			/** Whether anything left behind in the source module still uses it. */
			usedAtSource: boolean;
			baseHash: string;
	  }
	| { ok: false; reason: string };

/** Whole new contents per module, so the writer never re-derives an edit it did not check. */
export type MoveEditsOutcome =
	| { ok: true; files: Array<{ module: string; text: string }>; issues: RefactorIssue[] }
	| { ok: false; issues: RefactorIssue[]; reason: string };

/** A rename worked out but not applied, for a caller that will apply it itself. */
export type RenameEditPlan =
	| { ok: true; plan: RenamePlan; files: FileEdits[] }
	| { ok: false; plan: RenamePlan; reason: string };

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

		// Silence from a provider that never claimed to report syntax errors is not approval. Said
		// out loud, because the alternative is a caller believing the candidate was checked.
		if (!this.probe.declares(owner.providerId, "syntaxDiagnostics")) {
			issues.push({
				kind: "SyntaxUnchecked",
				detail: `the provider for ${source.module} does not report syntax errors, so the replacement was not checked`,
				module: source.module,
			});
		}

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
	 * What moving one declaration to another module would involve, without writing anything.
	 *
	 * The core works out WHICH modules are touched and WHAT the moved body depends on, both of
	 * which come out of the index. Rendering the text is the provider's, so this stops at handing
	 * each module a request.
	 */
	planMove(symbolId: string, toModule: string): MovePlan {
		const declaration = this.store.declaration(symbolId);
		if (!declaration) return { ok: false, reason: `${symbolId} is not in the index` };
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
		return { ok: true, files, issues: [] };
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
				blockers: [{ kind: "NotIndexed", detail: `${symbolId} is not in the index` }],
				warnings: [],
			};
		}

		const oldName = declaration.name;
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
				sites: declared.map((other) => ({ module: other.module, line: other.selectionRange.start.line })),
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
