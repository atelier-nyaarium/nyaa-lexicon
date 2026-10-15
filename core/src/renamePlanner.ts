import type { Range, RenameConcern } from "@nyaa-lexicon/protocol";
import {
	applyEdits,
	composeSymbolId,
	defined,
	hashContent,
	isParameterSymbol,
	ownerOf,
	parseSymbolId,
	rebaseSymbolId,
} from "@nyaa-lexicon/protocol";
import type { FileEdits } from "./applyEdits.js";
import { landingKey } from "./exportProjection.js";
import type { ImportResolver } from "./imports.js";
import type { ProviderProbe } from "./providerProbe.js";
import { ReadContext } from "./readContext.js";
import type { PlannedRename, PlannedRenameEdits, RenameBlocker } from "./refusalSlots.js";
import {
	alreadyNamed,
	editsRefused,
	landingUnchecked,
	moduleUnreadable,
	nameNotInSource,
	occurrencesBlocked,
	projectionsUnsettled,
	providerRefused,
	type Refusal,
	routeChanged,
	siteBlocked,
	staleSincePlanned,
	subjectRefused,
} from "./refusals.js";
import { RenameCollisionPlanner } from "./renameCollisionPlanner.js";
import { type ModuleTiers, mentionsOf, type ResolvedRoutes, resolveRoutes } from "./renameRoutes.js";
import type { RenameCandidate } from "./renameValidation.js";
import type { SourceWorkspace } from "./sourceWorkspace.js";
import { type IndexStore, resolutionKey, type StoredDeclaration, type StoredImport } from "./store.js";

/**
 * Language kinds a use reaches only when the receiver's type has no member of the name: Kotlin and
 * C# extensions, Rust trait methods. Renaming one onto such a member's name moves those uses.
 */
const REACHED_BY_RESOLUTION_ORDER: ReadonlySet<string> = new Set([
	"extensionFunction",
	"extensionProperty",
	"extensionMethod",
	"traitMethod",
	"traitImplMethod",
]);

/** The issue kind a provider's rename refusal reads as. */
const REFUSAL_KINDS: Readonly<Record<string, string>> = {
	Collision: "NameTaken",
	NotImplemented: "NotImplemented",
	ParseError: "ParseError",
};

/** Routes not yet followed, mentions not yet counted. */
function untraced(): Pick<PlannedRename, "routes" | "mentions"> {
	return { routes: { edges: [], modules: [] }, mentions: { comments: 0, strings: 0, incomplete: true } };
}

export class RenamePlanner extends RenameCollisionPlanner {
	constructor(
		private readonly store: IndexStore,
		private readonly imports: ImportResolver,
		private readonly source: SourceWorkspace,
		private readonly probe: ProviderProbe,
		private readonly prove: (candidate: RenameCandidate) => Promise<RenameBlocker[]>,
	) {
		super();
	}

	/**
	 * Every id a rename re-mints, old to new.
	 *
	 * A member's id carries its container's descriptors, so renaming a class re-mints its methods
	 * and their parameters too. Migrating only the class itself would strand everything written
	 * about them under ids nothing resolves.
	 */
	renameIdMap(symbolId: string, newName: string, context: ReadContext): Map<string, string> {
		const declaration = context.declaration(symbolId);
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

		// The id grammar's own subtree, not the container walk: rebasing reads the id string.
		for (const candidate of context.symbolIdsIn(declaration.module)) {
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
	modulesBoundTo(ids: Iterable<string>, context: ReadContext): string[] {
		const modules = new Set<string>();
		for (const id of ids) {
			for (const reference of context.referencesTo(id)) modules.add(reference.module);
		}
		return [...modules];
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
		return (await this.planRename(symbolId, newName, context, stops)).plan;
	}

	/** The plan, and the routes it was read from; null where it stops before tracing any. */
	private async planRename(
		symbolId: string,
		newName: string,
		context: ReadContext,
		stops: readonly string[],
	): Promise<{ plan: PlannedRename; routes: ResolvedRoutes | null }> {
		// A write anywhere from here on moves the plan, an importer it never read included.
		context.pinIndex();
		const refused = (oldName: string, blocker: RenameBlocker) => ({
			plan: {
				symbolId,
				oldName,
				newName,
				files: [],
				occurrences: 0,
				blockers: [blocker],
				warnings: [],
				...untraced(),
			},
			routes: null,
		});
		const declaration = context.declaration(symbolId);
		if (!declaration) return refused("", { kind: "NotIndexed", detail: subjectRefused(symbolId, this.store) });

		const oldName = declaration.name;
		// A name that is nowhere in the source has no site to rewrite.
		if (declaration.selectionRange === undefined) {
			return refused(oldName, { kind: "NameNotInSource", detail: nameNotInSource(oldName) });
		}
		if (this.store.nextProjectionDebt() !== null) {
			return refused(oldName, { kind: "RouteUnknown", detail: projectionsUnsettled() });
		}
		const tiers = (module: string) => this.tiersOf(module);
		const routes = resolveRoutes({ subject: declaration, newName, stops: new Set(stops), tiers }, context);
		const byModule = routes.sites;

		// Renaming an owned symbol reaches its owner's CALLERS: a Python keyword argument names the
		// parameter at a site that spells the function's name, so nothing searching for the old name
		// can find it. Gathered here because who calls what is the index's question, not a provider's.
		const ownerCalls = this.ownerCallsFor(symbolId, context);
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
		// A kept site writes no new binding, so nothing captures it.
		const renamed = new Map(
			[...byModule].map(([module, sites]) => [module, sites.filter((site) => site.keep !== true)] as const),
		);
		// Every range a module's plan decides, which no mention counts.
		const decided = new Map(
			[...byModule].map(
				([module, sites]) =>
					[module, [...sites.map((site) => site.range), ...(routes.unchanged.get(module) ?? [])]] as const,
			),
		);
		const blockers =
			newName === oldName
				? [{ kind: "SameName", detail: alreadyNamed(oldName) }]
				: [
						...routes.blockers,
						...(await this.landingsMoved(routes.relied)),
						...this.renameCollisions(symbolId, newName, renamed, routes.qualified, routes.inert, context),
					];

		return {
			plan: {
				symbolId,
				oldName,
				newName,
				files,
				occurrences: files.reduce((total, file) => total + file.sites.length, 0),
				blockers,
				warnings: [
					...this.renameWarnings(declaration, oldName, newName, symbolId, context),
					...this.ownerCallConcerns(symbolId, context),
				],
				routes: routes.routes,
				mentions: mentionsOf(oldName, decided, context, tiers),
			},
			routes,
		};
	}

	/** Relied edges whose live landing differs from the stored one, or could not be checked. */
	async landingsMoved(relied: readonly StoredImport[]): Promise<RenameBlocker[]> {
		const bySpecifier = new Map(
			relied.map(
				(edge) => [`${edge.module}\0${resolutionKey(edge.specifier, edge.resolutionMode)}`, edge] as const,
			),
		);
		const checked = await Promise.all(
			[...bySpecifier.values()].map(async (edge) => {
				try {
					const live = await this.imports.resolveLive(edge.module, edge.specifier, edge.resolutionMode);
					const landing = live.status === "resolved" ? live.landing : null;
					const same =
						landing === null || edge.landing === null
							? landing === edge.landing
							: landingKey(landing) === landingKey(edge.landing);
					return { edge, outcome: same ? ("same" as const) : ("moved" as const) };
				} catch {
					return { edge, outcome: "unchecked" as const };
				}
			}),
		);
		const at = (edge: StoredImport) => ({ module: edge.module, line: edge.span.start.line + 1 });
		const moved = checked.filter((each) => each.outcome === "moved").map((each) => at(each.edge));
		const blockers: RenameBlocker[] = checked
			.filter((each) => each.outcome === "unchecked")
			.map(({ edge }) => ({
				kind: "RouteUnknown",
				detail: landingUnchecked(edge.module, edge.specifier),
				sites: [at(edge)],
			}));
		if (moved.length > 0) {
			blockers.unshift({ kind: "RouteChanged", detail: routeChanged(moved.length), sites: moved.slice(0, 20) });
		}
		return blockers;
	}

	/** What the owning provider declares for keeping a name and reading prose; null when none owns it. */
	private tiersOf(module: string): ModuleTiers | null {
		const owner = this.probe.owner(module);
		if (!owner.owned) return null;
		const { providerId } = owner;
		return {
			renameKeep: this.probe.declares(providerId, "renameKeep"),
			comments: this.probe.declares(providerId, "comments"),
			literals: this.probe.declares(providerId, "literals"),
		};
	}

	/**
	 * Bound calls to the declaration that owns this symbol, grouped by file.
	 *
	 * Empty for anything that owns itself, which is nearly every rename. For a parameter it is the
	 * set of call sites whose named arguments have to move with it, and the id grammar alone says
	 * which declaration that is, so no language knowledge enters here.
	 */
	private ownerCallsFor(symbolId: string, context: ReadContext): Map<string, Range[]> {
		const byModule = new Map<string, Range[]>();
		if (!isParameterSymbol(symbolId)) return byModule;

		const owner = ownerOf(symbolId);
		if (owner === null) return byModule;

		for (const reference of context.referencesTo(owner)) {
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
	private ownerCallConcerns(symbolId: string, context: ReadContext): RenameConcern[] {
		if (!isParameterSymbol(symbolId)) return [];

		const owner = ownerOf(symbolId);
		const declaration = owner === null ? null : context.declaration(owner);
		if (declaration === null) {
			return [
				{
					kind: "OwnerNotIndexed",
					detail: "the declaration this belongs to is not indexed, so its call sites cannot be found",
				},
			];
		}

		const unbound = context.referencesSpelled(declaration.name, declaration.symbolId);
		if (unbound.length === 0) return [];
		return [
			{
				kind: "OwnerCallsUnresolved",
				detail: `${unbound.length} occurrence${unbound.length === 1 ? "" : "s"} of ${declaration.name} did not bind to it. If any is a call passing this argument by name, it will not be rewritten`,
				sites: unbound.slice(0, 20).map((r) => ({ module: r.module, line: r.startLine + 1 })),
			},
		];
	}

	/** Builds the complete edit set for `renameEdits`. See `docs/daemon-protocol.md`. */
	async renameEdits(
		symbolId: string,
		newName: string,
		context: ReadContext = new ReadContext(this.store),
		stops: readonly string[] = [],
	): Promise<PlannedRenameEdits> {
		return (await this.planRenameEdits(symbolId, newName, context, stops)).edits;
	}

	/** The edit set, proved against every provider's view of it, and the import edges a writer checks again. */
	async planRenameEdits(
		symbolId: string,
		newName: string,
		context: ReadContext,
		stops: readonly string[] = [],
	): Promise<{ edits: PlannedRenameEdits; relied: StoredImport[] }> {
		const { plan, routes } = await this.planRename(symbolId, newName, context, stops);
		const relied = routes?.relied ?? [];
		const refuse = (reason: Refusal, blockers = plan.blockers) => ({
			edits: { ok: false as const, plan: { ...plan, blockers }, reason },
			relied,
		});
		const blocker = plan.blockers[0];
		if (blocker !== undefined) return refuse(blocker.detail);
		// File changes invalidate stored ranges.
		const stale = this.source.staleModules(plan.files.map((file) => file.module));
		if (stale.length > 0) return refuse(staleSincePlanned(stale, "rename"));

		const files: FileEdits[] = [];
		const proposed: RenameCandidate["proposed"] = [];
		const blocked: RenameBlocker[] = [];

		for (const file of plan.files) {
			const current = this.source.writable(file.module);
			if ("refused" in current) return refuse(current.refused);
			const text = current.text;
			if (text === null) return refuse(moduleUnreadable(file.module));

			const answer = await this.probe.renameEdits(file.module, {
				module: file.module,
				text,
				oldName: plan.oldName,
				newName,
				sites: file.sites,
				...defined({ ownerCalls: file.ownerCalls }),
			});

			if (answer.status === "refused") {
				const detail = providerRefused(file.module, answer.reason, answer.detail);
				const kind = REFUSAL_KINDS[answer.reason] ?? "NotEditable";
				return refuse(detail, [...plan.blockers, { kind, detail, sites: [{ module: file.module, line: 1 }] }]);
			}
			for (const site of answer.blocked) {
				blocked.push({
					kind: site.reason,
					detail: siteBlocked(file.module, site.detail),
					sites: [{ module: file.module, line: site.range.start.line + 1 }],
				});
			}
			if (answer.edits.length === 0) continue;
			const applied = applyEdits(text, answer.edits);
			if ("problem" in applied) return refuse(editsRefused(applied.problem));
			files.push({ module: file.module, contentHash: hashContent(text), edits: answer.edits });
			proposed.push({ module: file.module, before: text, text: applied.text, edits: answer.edits });
		}

		if (blocked.length > 0) return refuse(occurrencesBlocked(), blocked);

		const idMap = this.renameIdMap(symbolId, newName, context);
		const affected = [
			...plan.files.map((file) => file.module),
			...plan.routes.modules.map((row) => row.module),
			...this.modulesBoundTo(idMap.keys(), context),
			// A capture or a rebinding shows in an importer of a landing whose rows move.
			...(routes?.moved ?? []).flatMap((landing) =>
				context.importEdgesLandingOn(landing).map((edge) => edge.module),
			),
			// So does a dotted read through a namespace holder.
			...(routes?.readers ?? []),
		];
		const proof = await this.prove({
			proposed,
			affected,
			idMap,
			subject: symbolId,
			sites: new Map(plan.files.map((file) => [file.module, file.sites])),
			projected: routes?.projected ?? [],
		});
		const [unproved] = proof;
		if (unproved !== undefined) return refuse(unproved.detail, proof);
		return { edits: { ok: true, plan, files }, relied };
	}

	/**
	 * Where the index cannot see far enough to promise a rename is complete.
	 *
	 * Both of these are uncertainty rather than failure, so they are stated and the caller decides.
	 * Refusing on either would refuse most real renames; hiding them would claim a completeness the
	 * index does not have.
	 */
	private renameWarnings(
		declaration: StoredDeclaration,
		oldName: string,
		newName: string,
		symbolId: string,
		context: ReadContext,
	): RenameConcern[] {
		const warnings: RenameConcern[] = [];

		if (declaration.languageKind?.split(" ").some((part) => REACHED_BY_RESOLUTION_ORDER.has(part)) === true) {
			warnings.push({
				kind: "ReceiverMemberMayCapture",
				detail: `${oldName} is reached through receivers, and a receiver type's own member named ${newName} outranks it; the index does not know every receiver's type`,
			});
		}

		const unbound = context.referencesSpelled(oldName, symbolId);
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
