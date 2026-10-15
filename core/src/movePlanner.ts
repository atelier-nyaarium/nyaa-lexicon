import type {
	MoveAnchor,
	MoveDependency,
	MoveEditsRequest,
	MoveImportSite,
	Range,
	TextEdit,
	UnknownReason,
} from "@nyaa-lexicon/protocol";
import {
	applyEdits,
	composeSymbolId,
	coordinatesOf,
	defined,
	hashContent,
	isWithin,
	parseSymbolId,
	positionInRange,
	rebaseSymbolId,
} from "@nyaa-lexicon/protocol";
import { separatedRemoval } from "./arrangeLayout.js";
import { mergeRemovals } from "./arrangeText.js";
import type { ImportResolver } from "./imports.js";
import { promoteDependency, promotedFrom, unacknowledgedPromotions } from "./movePromotion.js";
import { isDangling, workspaceModule } from "./plannerCommon.js";
import type { ProviderProbe } from "./providerProbe.js";
import type { ReadContext } from "./readContext.js";
import type { MoveEditsOutcome } from "./refactorPlanner.js";
import type { PlannedMove } from "./refusalSlots.js";
import {
	alreadyInModule,
	anchorNeedsTopLevel,
	anchorNotSibling,
	anchorNotTopLevel,
	moduleNotOnDisk,
	noInsertionPoint,
	occurrencesBlocked,
	providerRefused,
	type Refusal,
	subjectRefused,
} from "./refusals.js";
import type { SourceWorkspace } from "./sourceWorkspace.js";
import type { IndexStore, StoredDeclaration } from "./store.js";
import type { RefactorIssue } from "./transactions.js";

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
	"BrokenImport",
	"NotIndexed",
];

/** A removal alone on its lines takes them whole, with one blank line beside them. */
function wholeLines<T extends Pick<MoveEditsRequest, "role">>(request: T, before: string): T {
	const removal = request.role.removal;
	if (removal === undefined) return request;
	const coords = coordinatesOf(before);
	const first = coords.lineText(removal.start.line);
	const last = coords.lineText(removal.end.line);
	if (first === undefined || last === undefined) return request;
	if (first.slice(0, removal.start.character).trim() !== "" || last.slice(removal.end.character).trim() !== "") {
		return { ...request, role: { ...request.role, removal: separatedRemoval(before, removal) } };
	}
	const blank = (line: number) => coords.lineText(line)?.trim() === "";
	let start = removal.start.line;
	let end = removal.end.line + 1;
	if (blank(end) && coords.lineText(end + 1) !== undefined) end += 1;
	else if (start > 0 && blank(start - 1)) start -= 1;
	const to = coords.lineText(end) === undefined ? coords.positionAt(before.length) : { line: end, character: 0 };
	if (to === undefined) return request;
	return { ...request, role: { ...request.role, removal: { start: { line: start, character: 0 }, end: to } } };
}

/** An anchored insertion as whole lines, framed by a blank line where a neighbor is not blank; past the last line, the end. */
function framed<T extends Pick<MoveEditsRequest, "role">>(request: T, before: string): T {
	const insertion = request.role.insertion;
	if (insertion?.position === undefined) return request;
	const coords = coordinatesOf(before);
	const { line } = insertion.position;
	const at = coords.lineText(line);
	const eol = before.includes("\r\n") ? "\r\n" : "\n";
	// Past the last line: the text has no final line break, so the insertion ends that line first.
	if (at === undefined) {
		const end = coords.positionAt(before.length);
		if (end === undefined) return request;
		const text = `${eol}${eol}${insertion.text}`;
		return { ...request, role: { ...request.role, insertion: { ...insertion, position: end, text } } };
	}
	const above = line === 0 ? undefined : coords.lineText(line - 1);
	const leading = above !== undefined && above.trim().length > 0 ? eol : "";
	const trailing = at.trim().length > 0 ? eol : "";
	return {
		...request,
		role: { ...request.role, insertion: { ...insertion, text: `${leading}${insertion.text}${trailing}` } },
	};
}

/** `text` with its last line ended, in the line ending it already uses. */
function lineEnded(text: string): string {
	if (text.endsWith("\n")) return text;
	return `${text}${text.includes("\r\n") ? "\r\n" : "\n"}`;
}

export class MovePlanner {
	constructor(
		private readonly store: IndexStore,
		private readonly imports: ImportResolver,
		private readonly source: SourceWorkspace,
		private readonly probe: ProviderProbe,
	) {}

	/** Derives move facts for `previewMove` from one read context. See `docs/daemon-protocol.md`. */
	planMove(
		symbolId: string,
		rawTarget: string,
		context: ReadContext,
		anchor?: MoveAnchor,
		promote = false,
	): PlannedMove {
		const target = workspaceModule(rawTarget);
		if ("refused" in target) return { ok: false, reason: target.refused };
		const toModule = target.module;

		const declaration = context.declaration(symbolId);
		if (!declaration) return { ok: false, reason: subjectRefused(symbolId, this.store) };
		// With an anchor the target may be the source: a reorder, with no import to write.
		const reorder = declaration.module === toModule;
		if (reorder && anchor === undefined) return { ok: false, reason: alreadyInModule(declaration.name, toModule) };

		const source = this.source.symbolSourceRead({ symbolId });
		if (!source.found) return { ok: false, reason: source.reason };

		// The id grammar's own subtree, not the container walk: `isWithin` and `rebaseSymbolId`
		// read the id string, never a stored containerId.
		const closure = context.symbolIdsIn(declaration.module).filter((candidate) => isWithin(candidate, symbolId));
		const placed =
			anchor === undefined ? undefined : this.anchorLine(anchor, declaration, toModule, closure, context);
		if (placed !== undefined && "refused" in placed) return { ok: false, reason: placed.refused };

		// Declared at the target already, so nothing to import there.
		const dependencies = this.dependenciesOf(declaration.module, closure, symbolId, context)
			.filter(
				(dependency) => dependency.origin.kind !== "workspaceModule" || dependency.origin.module !== toModule,
			)
			.map((dependency) => promoteDependency(dependency, promote));
		const promoted = promotedFrom(dependencies);

		// Modules whose imports name the moved symbol, plus the source itself when something left
		// behind still uses it.
		const referencing = new Set(
			context
				.referencesTo(symbolId)
				.map((reference) => reference.module)
				.filter((module) => module !== declaration.module),
		);
		const usedAtSource = context
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
			dependencies: reorder ? [] : dependencies,
			// Present only when promoting, so a plain plan answers as it always has.
			...(reorder || promoted.length === 0 ? {} : { promoted }),
			referencing: reorder ? [] : [...referencing],
			usedAtSource: !reorder && usedAtSource,
			exportsAtTarget: !reorder && (usedAtSource || referencing.size > 0) && declaration.exported === false,
			baseHash: source.contentHash,
			...defined({
				insertion: placed === undefined ? undefined : { line: placed.line, character: 0 },
				restore: this.restoreAnchor(declaration, context),
			}),
		};
	}

	/** The declarations a move may land beside: its siblings for a reorder, else the target's top level; null for a nested one leaving. */
	private siblingsOf(moved: StoredDeclaration, toModule: string, context: ReadContext): StoredDeclaration[] | null {
		const container = context.ancestorsOf(moved)[0];
		if (container === undefined)
			return context.heldBy(toModule, undefined).filter((each) => !context.isLocal(each));
		return moved.module === toModule ? context.declaredChildren(container.symbolId) : null;
	}

	/** The whole line an anchored move lands on: the anchor's first line, or the one after its last. */
	private anchorLine(
		anchor: MoveAnchor,
		moved: StoredDeclaration,
		toModule: string,
		closure: readonly string[],
		context: ReadContext,
	): { line: number } | { refused: Refusal } {
		const siblings = this.siblingsOf(moved, toModule, context);
		if (siblings === null) return { refused: anchorNeedsTopLevel(moved.name, toModule) };
		const at = siblings.findIndex((sibling) => sibling.symbolId === anchor.symbolId);
		if (at === -1 || closure.includes(anchor.symbolId)) {
			const label = context.declaration(anchor.symbolId)?.name ?? anchor.symbolId;
			const reorder = moved.module === toModule;
			return {
				refused: reorder ? anchorNotSibling(label, moved.name, toModule) : anchorNotTopLevel(label, toModule),
			};
		}
		const read = this.source.symbolSourceRead({ symbolId: anchor.symbolId });
		if (!read.found) return { refused: read.reason };
		// A neighbor sharing the anchor's first or last line leaves no whole line between them.
		if (anchor.side === "before") {
			const previous = siblings[at - 1];
			if (previous !== undefined && previous.range.end.line === read.range.start.line) {
				return { refused: noInsertionPoint(previous.name) };
			}
			return { line: read.range.start.line };
		}
		const next = siblings[at + 1];
		if (next !== undefined && next.range.start.line === read.range.end.line) {
			return { refused: noInsertionPoint(next.name) };
		}
		return { line: read.range.end.line + 1 };
	}

	/** The anchor that puts a declaration back: its next sibling, else its previous. */
	private restoreAnchor(declaration: StoredDeclaration, context: ReadContext): MoveAnchor | undefined {
		const siblings = this.siblingsOf(declaration, declaration.module, context) ?? [];
		const at = siblings.findIndex((sibling) => sibling.symbolId === declaration.symbolId);
		if (at === -1) return undefined;
		const next = siblings[at + 1];
		if (next !== undefined) return { symbolId: next.symbolId, side: "before" };
		const previous = siblings[at - 1];
		return previous === undefined ? undefined : { symbolId: previous.symbolId, side: "after" };
	}

	/** Collects provider edits for `previewMove`. See `docs/daemon-protocol.md`. */
	async moveEdits(plan: Extract<PlannedMove, { ok: true }>, context: ReadContext): Promise<MoveEditsOutcome> {
		if (plan.fromModule !== plan.toModule) {
			const sourceRead = this.source.writable(plan.fromModule);
			if ("refused" in sourceRead) return { ok: false, issues: [], reason: sourceRead.refused };
		}
		const requests = await this.moveRequests(plan, context);
		const files: Array<{ module: string; text: string; edits: TextEdit[] }> = [];
		const bases: Array<{ module: string; hash: string | null }> = [];
		const blocked: RefactorIssue[] = [];

		for (const request of requests) {
			const current = this.source.writable(request.module);
			if ("refused" in current) return { ok: false, issues: [], reason: current.refused };
			// Only the target may be absent, and is created.
			if (current.text === null && request.module !== plan.toModule) {
				return { ok: false, issues: [], reason: moduleNotOnDisk(request.module) };
			}
			bases.push({ module: request.module, hash: current.text === null ? null : hashContent(current.text) });
			const before = current.text ?? "";
			const answer = await this.probe.moveEdits(request.module, {
				...framed(wholeLines(request, before), before),
				text: before,
				exists: current.text !== null,
			});

			if (answer.status === "refused") {
				return { ok: false, issues: [], reason: providerRefused(request.module, answer.reason, answer.detail) };
			}
			if (request.exportInPlace?.length) {
				blocked.push(
					...unacknowledgedPromotions(
						request.exportInPlace,
						answer.exportedInPlace ?? [],
						plan.promoted ?? [],
						request.module,
					),
				);
			}
			for (const site of answer.blocked) {
				blocked.push({
					kind: site.reason,
					detail: `${request.module}: ${site.detail ?? "cannot be rewritten safely"}`,
					module: request.module,
				});
			}
			if (answer.edits.length === 0) continue;

			const edits = mergeRemovals(answer.edits);
			const applied = applyEdits(before, edits);
			if ("problem" in applied) {
				return { ok: false, issues: [], reason: providerRefused(request.module, applied.problem) };
			}
			files.push({ module: request.module, text: applied.text, edits });
		}

		if (blocked.length > 0) {
			return { ok: false, issues: blocked, reason: occurrencesBlocked() };
		}
		return { ok: true, files, bases, issues: this.importersUnfound([plan.fromModule, ...plan.referencing]) };
	}

	/** One request per involved module, each describing only that module's part; the read fills its text. */
	private async moveRequests(
		plan: Extract<PlannedMove, { ok: true }>,
		context: ReadContext,
	): Promise<Array<Omit<MoveEditsRequest, "text" | "exists">>> {
		const shared = {
			symbolId: plan.symbolId,
			name: plan.name,
			fromModule: plan.fromModule,
			toModule: plan.toModule,
		};

		// A reorder: one module loses and takes the text, and every import stays right.
		if (plan.fromModule === plan.toModule) {
			const insertion = { text: lineEnded(plan.text), ...defined({ position: plan.insertion }) };
			return [
				{
					...shared,
					module: plan.fromModule,
					role: { removal: plan.removal, insertion },
					importSites: [],
					dependencies: [],
					sites: [],
				},
			];
		}

		const requests: Array<Omit<MoveEditsRequest, "text" | "exists">> = [
			{
				...shared,
				module: plan.fromModule,
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
				...(plan.promoted?.length ? { exportInPlace: plan.promoted.map((item) => item.symbolId) } : {}),
				sites: [],
			},
			{
				...shared,
				module: plan.toModule,
				role: {
					insertion: {
						text: lineEnded(plan.text),
						...defined({ position: plan.insertion }),
						...(plan.exportsAtTarget ? { exported: true } : {}),
					},
				},
				importSites: [],
				dependencies: plan.dependencies,
				sites: [],
			},
		];

		// By what each specifier resolves to: a barrel's re-export follows, a same-named import from elsewhere stays.
		const sitesIn = new Map<string, MoveImportSite[]>();
		const sites = await this.imports.importSitesResolvingTo(plan.symbolId, plan.fromModule, plan.name, context);
		for (const { module, site } of sites) {
			sitesIn.set(module, [...(sitesIn.get(module) ?? []), site]);
		}
		for (const module of new Set([...plan.referencing, ...sitesIn.keys()])) {
			const importSites = sitesIn.get(module) ?? [];
			// A module already asked, the target importing what moves home, takes its sites in that one
			// request, so its edits share one base and land as one write.
			const asked = requests.find((request) => request.module === module);
			if (asked !== undefined) asked.importSites = [...asked.importSites, ...importSites];
			else requests.push({ ...shared, module, role: {}, importSites, dependencies: [], sites: [] });
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
		return positionInRange(range, { line: reference.startLine, character: reference.startCharacter });
	}

	/**
	 * Every name the moved body uses, with what the index proved about where it comes from.
	 *
	 * Walked over the whole closure rather than over references owned by the moved symbol, because
	 * a moved class's body references belong to its METHODS and a top-level initializer may be
	 * owned by nothing at all.
	 */
	dependenciesOf(module: string, closure: string[], symbolId: string, context: ReadContext): MoveDependency[] {
		const inside = new Set(closure);
		const source = this.source.symbolSource({ symbolId });
		if (!source.found) return [];

		const seen = new Set<string>();
		const dependencies: MoveDependency[] = [];

		for (const reference of context.referencesIn(module)) {
			if (!this.inRange(reference, source.range)) continue;
			const target = reference.targetId;
			const declaration = target === null ? null : context.declaration(target);
			// Members and receiver accesses need no import.
			const held = declaration?.containerId !== undefined && !isWithin(symbolId, declaration.containerId);
			if (reference.qualified === true || held) continue;
			if (seen.has(reference.name)) continue;
			seen.add(reference.name);

			if (target !== null && inside.has(target)) {
				dependencies.push({ name: reference.name, origin: { kind: "insideClosure", symbolId: target } });
				continue;
			}

			if (target !== null) {
				if (declaration?.module === module) {
					dependencies.push({
						name: reference.name,
						origin: {
							kind: "sourceModule",
							symbolId: target,
							name: declaration.name,
							...defined({ exported: declaration.exported }),
						},
					});
					continue;
				}
				if (declaration) {
					const via = this.imports.importOriginFor(module, reference.name, context);
					dependencies.push({
						name: reference.name,
						origin: {
							kind: "workspaceModule",
							symbolId: target,
							module: declaration.module,
							...(via === null ? {} : { via }),
						},
					});
					continue;
				}
			}

			const via = this.imports.importOriginFor(module, reference.name, context);
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

	/** Importers are found from stored references and imports, each written by the provider owning the
	 * file it is in. One claiming neither reported none, which is not the same as there being none. */
	importersUnfound(modules: string[]): RefactorIssue[] {
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
}
