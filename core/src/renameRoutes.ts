// A rename's routes: every export and import edge carrying the declaration's name, what the rename
// does to each, and the sites that follow. Read from stored facts, never from source text.

import type {
	AllList,
	Certainty,
	ExportTarget,
	ImportEdge,
	Landing,
	Meaning,
	Position,
	Range,
	RenamePlan,
	RenameSite,
	RouteEdge,
	RouteModule,
	RouteState,
	Selector,
} from "@nyaa-lexicon/protocol";
import {
	type EffectiveExport,
	exportTracer,
	landingKey,
	narrowedRows,
	type ProjectionReads,
	type ReadExport,
	type ReadImport,
	type RouteStep,
	type ScopeLanding,
	selects,
	type TracedExport,
} from "./exportProjection.js";
import { type DiffReads, type ExposureDiff, exposureDiff, type LandingRows } from "./exposureDiff.js";
import type { RenameBlocker } from "./refusalSlots.js";
import {
	allListUnproved,
	exposureRebinds,
	nameAlreadyExposed,
	nameShared,
	newNameUnproved,
	type Refusal,
	routeUncertain,
	siteDecidedTwice,
	starDropsName,
	stopNotKeepable,
	stopOffRoute,
	stopReceivesNoChange,
	stopUnsupported,
	useUntraced,
	wildcardCaptures,
	wildcardDropsName,
} from "./refusals.js";
import type { StoredComment, StoredDeclaration, StoredImport, StoredLiteral, StoredReference } from "./store.js";

////////////////////////////////
//  Interfaces & Types

/** What routes read. ReadContext answers each, stamped. */
export interface RouteReads extends ProjectionReads {
	declaration(symbolId: string): StoredDeclaration | null;
	heldIn(module: string): StoredDeclaration[];
	importEdgeAt(module: string, span: Range): StoredImport | null;
	importsIn(module: string): StoredImport[];
	modulesExposing(symbolId: string): string[];
	scopesHolding(symbolId: string): ScopeLanding[];
	/** Modules exposing a landing under some name, as a namespace or a module value. */
	modulesHoldingNamespace(landing: Landing): string[];
	/** The scopes a module contributes to. */
	scopesOf(module: string): ScopeLanding[];
	importEdgesLandingOn(landing: Landing): StoredImport[];
	referencesTo(symbolId: string): StoredReference[];
	referencesIn(module: string): StoredReference[];
	commentsIn(module: string): StoredComment[];
	literalsIn(module: string): StoredLiteral[];
}

/** The tiers a module's provider declares. */
export interface ModuleTiers {
	renameKeep: boolean;
	comments: boolean;
	literals: boolean;
}

export interface RouteRequest {
	subject: StoredDeclaration;
	newName: string;
	/** Export fact ids to keep the old name at. */
	stops: ReadonlySet<string>;
	/** Null when no provider owns the module. */
	tiers(module: string): ModuleTiers | null;
}

export interface ResolvedRoutes {
	/** Sites by module, the declaration's module first. */
	sites: Map<string, RenameSite[]>;
	/** Sites a receiver or path reaches, which no local captures, by `startKey`. */
	qualified: Set<string>;
	/** Sites that write and read no binding in their module, such as a forward's token, by `startKey`. */
	inert: Set<string>;
	blockers: RenameBlocker[];
	routes: { edges: RouteEdge[]; modules: RouteModule[] };
	/** Ranges decided to stay as written, such as a kept `__all__` entry, by module. */
	unchanged: Map<string, Range[]>;
	/** What each landing the rename reaches exposes once it runs, the subject under its old id. */
	projected: Array<{ landing: Landing; rows: EffectiveExport[] }>;
	/** Landings whose rows the rename moves. */
	moved: Landing[];
	/** Modules reading the subject's landings through a receiver, where a path may capture the new name. */
	readers: string[];
	/** Every import edge a decision rests on, with its stored landing, to check live before writing. */
	relied: StoredImport[];
}

/** One name the subject is exposed under, at a module or a scope, with every path there. */
interface Exposure {
	landing: Landing;
	name: string;
	row: TracedExport;
}

/** One export edge carrying one name: a star forwards each name apart. */
interface Node {
	key: string;
	step: RouteStep;
	name: string;
}

/** What the rename does at one node. */
interface Decision {
	state: RouteState;
	/** The name arriving at the node changes. */
	upstream: boolean;
	stopped: boolean;
	stoppable: boolean;
}

type Role = RouteModule["roles"][number];

/** How the binding a use reads fares: changes, stays, unproved, or on no route of the subject. */
type Verdict = "renames" | "stays" | "unproved" | "untracked";

/** Where a receiver's path continues: a landing's exports, or a declaration's members. */
type Hop = Landing | { owner: string };

type Site = { module: string; line: number };

////////////////////////////////
//  Constants

/** The declaration itself, behind the innermost edge of every path. */
const SUBJECT = "\0subject";

const ROLE_ORDER: readonly Role[] = ["declares", "imports", "reExports", "uses"];

/** Sites a blocker names before the list stops helping. */
const SITES_SHOWN = 20;

/** Coverage that can never hold a workspace declaration the landing does not already expose. */
const INERT_COVERAGE: ReadonlySet<string> = new Set(["ExternalDependency", "RecursionLimit"]);

////////////////////////////////
//  Functions & Helpers

/** A site by its start, as collision checks key it. */
export function startKey(module: string, at: Position): string {
	return `${module}\0${at.line}\0${at.character}`;
}

function rangeKey(range: Range): string {
	return `${range.start.line}:${range.start.character}-${range.end.line}:${range.end.character}`;
}

function exposureKey(landing: Landing, name: string): string {
	return `${landingKey(landing)}\n${name}`;
}

/** An export edge's fact id, else where it is written. */
function stepKey(step: RouteStep): string {
	return step.export.factId ?? `${step.module} ${rangeKey(step.export.span)}`;
}

function nodeKey(step: RouteStep, name: string): string {
	return `${stepKey(step)}\n${name}`;
}

/** The name a node reads from the edge behind it; null where it reaches the declaration. */
function innerName(step: RouteStep, name: string): string | null {
	if (step.export.form === "star") return name;
	const transfer = step.import;
	if (step.export.target.kind !== "import" || transfer === undefined) return null;
	if (transfer.kind === "named") return transfer.name ?? name;
	return transfer.kind === "default" ? "default" : name;
}

function lineOf(range: Range): number {
	return range.start.line + 1;
}

function after(left: Position, right: Position): boolean {
	return left.line > right.line || (left.line === right.line && left.character > right.character);
}

function overlaps(left: Range, right: Range): boolean {
	return after(left.end, right.start) && after(right.end, left.start);
}

/** The binding an import writes is spelled by the source name. */
function localFollows(edge: ImportEdge): boolean {
	if (!edge.bindsLocally) return false;
	return edge.kind === "named" ? edge.local === undefined : edge.kind === "wildcard" || edge.kind === "injection";
}

function isReceiver(edge: ImportEdge): boolean {
	return edge.kind === "namespace" || edge.kind === "require" || edge.kind === "sideEffect";
}

/** Whether a selector picks `newName` after the rename; a static list keeps its renamed entry. */
function picksRenamed(
	selector: Selector | undefined,
	oldName: string,
	newName: string,
	allList: AllList | null,
): boolean | Certainty {
	if (selector?.kind === "allList" && allList?.state === "static") {
		return allList.entries.some((entry) => entry.name === oldName);
	}
	return selects(selector, newName, allList);
}

function allListAt(reads: Pick<ProjectionReads, "fileOf">, landing: Landing | null | undefined): AllList | null {
	return landing?.kind === "module" ? (reads.fileOf(landing.module)?.allList ?? null) : null;
}

/** The names a wildcard brings from a landing's rows, each with its origins. */
function bringing(edge: ImportEdge, rows: readonly EffectiveExport[], allList: AllList | null): Map<string, string> {
	const origins = new Map<string, string[]>();
	for (const row of narrowedRows(rows, [edge.meaning])) {
		if (row.name === null || selects(edge.selector, row.name, allList) === false) continue;
		origins.set(row.name, [...(origins.get(row.name) ?? []), JSON.stringify(row.origin)]);
	}
	return new Map([...origins].map(([name, each]) => [name, each.sort().join("\n")]));
}

function isIdentifierPart(char: string | undefined): boolean {
	return char !== undefined && /[\p{L}\p{N}_$]/u.test(char);
}

/** `word` stands alone in `text`: no identifier character touches either end. */
export function holdsWord(text: string, word: string): boolean {
	for (let at = text.indexOf(word); at !== -1; at = text.indexOf(word, at + 1)) {
		if (!isIdentifierPart(text[at - 1]) && !isIdentifierPart(text[at + word.length])) return true;
	}
	return false;
}

/** Routes, sites and blockers for renaming `request.subject`. */
export function resolveRoutes(request: RouteRequest, reads: RouteReads): ResolvedRoutes {
	return new RouteResolver(request, reads).resolve();
}

/** The old name as a whole word in the comments and string values of `modules`, past each range they hold. */
export function mentionsOf(
	name: string,
	modules: ReadonlyMap<string, readonly Range[]>,
	reads: Pick<RouteReads, "commentsIn" | "literalsIn">,
	tiers: (module: string) => ModuleTiers | null,
): RenamePlan["mentions"] {
	let comments = 0;
	let strings = 0;
	let incomplete = false;
	for (const [module, written] of modules) {
		const held = tiers(module);
		if (held?.comments !== true || !held.literals) incomplete = true;
		if (held?.comments === true) {
			comments += reads.commentsIn(module).filter((comment) => holdsWord(comment.normalized, name)).length;
		}
		if (held?.literals === true) {
			strings += reads
				.literalsIn(module)
				.filter(
					(literal) =>
						literal.kind === "string" &&
						holdsWord(literal.value, name) &&
						!written.some((range) => overlaps(range, literal.range)),
				).length;
		}
	}
	return { comments, strings, ...(incomplete ? { incomplete: true as const } : {}) };
}

////////////////////////////////
//  Class

/** The stored facts as the planned sites leave them, for what landings expose once the rename runs. */
class RenamedReads implements DiffReads {
	constructor(
		private readonly reads: RouteReads,
		private readonly sites: ReadonlyMap<string, ReadonlyMap<string, RenameSite>>,
		private readonly subject: StoredDeclaration,
		private readonly newName: string,
	) {}

	fileOf(module: string): ReturnType<RouteReads["fileOf"]> {
		const file = this.reads.fileOf(module);
		if (file === null || file.allList?.state !== "static") return file;
		const entries = file.allList.entries.map((entry) =>
			this.siteAt(module, entry.range) === undefined ? entry : { ...entry, name: this.newName },
		);
		return { ...file, allList: { ...file.allList, entries } };
	}

	exportsIn(module: string): ReadExport[] {
		return this.reads.exportsIn(module).map((edge) => this.exportAfter(module, edge));
	}

	importEdgeAt(module: string, span: Range): ReadImport | null {
		const edge = this.reads.importEdgeAt(module, span);
		return edge === null ? null : this.importAfter(module, edge);
	}

	exportedDeclarations(module: string): Array<{ symbolId: string; name: string }> {
		return this.reads.exportedDeclarations(module).map((each) => this.declared(each));
	}

	scopeMembers(landing: ScopeLanding): Array<{ symbolId: string; name: string }> | null {
		return this.reads.scopeMembers(landing)?.map((each) => this.declared(each)) ?? null;
	}

	scopeExports(landing: ScopeLanding): Array<{ module: string; edge: ReadExport }> {
		return this.reads
			.scopeExports(landing)
			.map(({ module, edge }) => ({ module, edge: this.exportAfter(module, edge) }));
	}

	importEdgesLandingOn(landing: Landing): StoredImport[] {
		return this.reads.importEdgesLandingOn(landing).map((edge) => this.importAfter(edge.module, edge));
	}

	scopesOf(module: string): ScopeLanding[] {
		return this.reads.scopesOf(module);
	}

	private siteAt(module: string, range: Range | undefined): RenameSite | undefined {
		return range === undefined ? undefined : this.sites.get(module)?.get(rangeKey(range));
	}

	private declared(each: { symbolId: string; name: string }): { symbolId: string; name: string } {
		return each.symbolId === this.subject.symbolId ? { ...each, name: this.newName } : each;
	}

	/** The subject's direct export, or a name only a renaming token writes, takes the new name. */
	private exportAfter<T extends ReadExport>(module: string, edge: T): T {
		if (edge.name === undefined || edge.form === "default") return edge;
		const { target } = edge;
		const direct = edge.form === "direct" && target.kind === "symbol" && target.symbolId === this.subject.symbolId;
		const site = this.siteAt(module, edge.range);
		// An alias or an expanded shorthand keeps its name.
		const renames = site !== undefined && site.keep !== true && edge.sourceRange === undefined;
		return direct || renames ? { ...edge, name: this.newName } : edge;
	}

	/** A named import whose source token renames takes the new name; kept, the old name stays its local. */
	private importAfter<T extends ReadImport>(module: string, edge: T): T {
		if (edge.kind !== "named") return edge;
		const site = this.siteAt(module, edge.range);
		if (site === undefined) return edge;
		return { ...edge, name: this.newName, ...(site.keep === true ? { local: edge.local ?? edge.name } : {}) };
	}
}

class RouteResolver {
	private readonly tracer: ReturnType<typeof exportTracer>;
	private readonly oldName: string;
	private readonly subjectId: string;
	/** Every node on a route, by key. */
	private readonly nodes = new Map<string, Node>();
	/** The nodes behind each one; SUBJECT where it reaches the declaration. */
	private readonly inners = new Map<string, Set<string>>();
	/** Whether each node is the only one its module's row is reached by. */
	private readonly unique = new Map<string, boolean>();
	private readonly decisions = new Map<string, Decision>();
	private readonly deciding = new Set<string>();
	private readonly exposures = new Map<string, Exposure>();
	/** Every landing exposing the subject, a module's whole value included. */
	private readonly starts = new Map<string, Landing>();
	/** Import keys of the edges routes cross, and of those a stop keeps. */
	private readonly stepImports = new Set<string>();
	private readonly keptTransfers = new Set<string>();
	/** Whether a named or default import's local binding changes, by import key; null when unproved. */
	private readonly locals = new Map<string, boolean | null>();
	/** Whether a wildcard's binding of one name changes, by import key and name; null when unproved. */
	private readonly brought = new Map<string, boolean | null>();
	/** Modules with a binding of the old name that changes, and modules reaching it through a receiver. */
	private readonly bindsChanging = new Set<string>();
	private readonly receivesChanging = new Set<string>();
	/** Modules reading the subject's own module through a receiver, whose proved paths may name it. */
	private readonly pathReaders = new Set<string>();
	/** Namespace holders already followed, by module and the landing they hold. */
	private readonly holdersSeen = new Set<string>();
	private readonly sites = new Map<string, Map<string, RenameSite>>();
	private readonly inert = new Set<string>();
	private readonly unchanged = new Map<string, Range[]>();
	private readonly qualified = new Set<string>();
	private readonly blocked = new Map<string, RenameBlocker>();
	private readonly edges = new Map<string, RouteEdge>();
	private readonly relied = new Map<string, StoredImport>();
	private readonly roles = new Map<string, Set<Role>>();
	private readonly untraced = new Map<string, number>();

	constructor(
		private readonly request: RouteRequest,
		private readonly reads: RouteReads,
	) {
		this.tracer = exportTracer(reads);
		this.oldName = request.subject.name;
		this.subjectId = request.subject.symbolId;
	}

	resolve(): ResolvedRoutes {
		const { subject } = this.request;
		this.role(subject.module, "declares");
		// The declaration's own name is a site like any other, and forgetting it renames every use
		// to point at a definition that still has the old name.
		if (subject.selectionRange !== undefined) this.site(subject.module, { range: subject.selectionRange });
		this.collectExposures();
		this.checkStops();
		for (const node of this.nodes.values()) if (this.decide(node.key).stopped) this.keep(node);
		for (const node of this.nodes.values()) this.stepSites(node);
		for (const exposure of this.exposures.values()) {
			this.consumers(exposure);
			this.holders(exposure);
			this.allListSites(exposure);
		}
		// Every site that writes an export is decided; uses never change what a module exposes.
		const renamed = new RenamedReads(this.reads, this.sites, subject, this.request.newName);
		const diff = exposureDiff({
			before: this.reads,
			after: renamed,
			starts: [...this.starts.values()],
			isSubject: (origin) => origin.kind === "symbol" && origin.symbolId === this.subjectId,
		});
		for (const exposure of this.exposures.values()) this.landed(exposure, diff);
		for (const rows of diff.read.values()) this.gained(rows);
		for (const reference of this.reads.referencesTo(this.subjectId)) this.boundUse(reference);
		this.receivers();
		this.unboundUses();
		this.movesBlocked(diff);
		this.captures(diff, renamed);
		return {
			sites: new Map([...this.sites].map(([module, held]) => [module, [...held.values()]])),
			qualified: this.qualified,
			inert: this.inert,
			blockers: [...this.blocked.values()],
			routes: { edges: [...this.edges.values()], modules: this.moduleRows() },
			unchanged: this.unchanged,
			projected: [...diff.read.values()].map(({ landing, after: rows }) => ({
				landing,
				rows: rows.map(({ paths: _paths, ...row }) => row),
			})),
			moved: [...diff.moved].flatMap((key) => {
				const rows = diff.read.get(key);
				return rows === undefined ? [] : [rows.landing];
			}),
			readers: [...new Set([...this.receivesChanging, ...this.pathReaders])].sort(),
			relied: [...this.relied.values()],
		};
	}

	/** Every module and scope exposing the subject, and the nodes each path crosses. */
	private collectExposures(): void {
		const landings: Landing[] = [
			...this.reads.modulesExposing(this.subjectId).map((module): Landing => ({ kind: "module", module })),
			...this.reads.scopesHolding(this.subjectId),
		];
		for (const landing of landings) {
			this.starts.set(landingKey(landing), landing);
			for (const row of this.tracer.landing(landing)) {
				if (row.name === null || !this.isSubject(row)) continue;
				this.exposures.set(exposureKey(landing, row.name), { landing, name: row.name, row });
				const firsts = new Set<string>();
				for (const path of row.paths) {
					let name = row.name;
					path.forEach((step, at) => {
						const key = nodeKey(step, name);
						const inner = innerName(step, name);
						const next = path[at + 1];
						const held = this.inners.get(key) ?? new Set<string>();
						held.add(next === undefined || inner === null ? SUBJECT : nodeKey(next, inner));
						this.nodes.set(key, { key, step, name });
						this.inners.set(key, held);
						name = inner ?? name;
					});
					const [first] = path;
					firsts.add(first === undefined ? SUBJECT : nodeKey(first, row.name));
				}
				for (const key of firsts)
					if (key !== SUBJECT) this.unique.set(key, (this.unique.get(key) ?? true) && firsts.size === 1);
			}
		}
	}

	/** The rename at one node, from those behind it; uncertainty counts only where a change arrives. */
	private decide(key: string): Decision {
		const held = this.decisions.get(key);
		if (held !== undefined) return held;
		const node = this.nodes.get(key);
		if (node === undefined || this.deciding.has(key))
			return { state: "unknown", upstream: false, stopped: false, stoppable: false };
		this.deciding.add(key);
		const inners = [...(this.inners.get(key) ?? [])];
		const upstream = inners.every((inner) => inner === SUBJECT || this.decide(inner).state === "renamed");
		this.deciding.delete(key);
		const { step } = node;
		const stoppable =
			upstream &&
			this.keepable(step) &&
			this.unique.get(key) === true &&
			this.request.tiers(step.module)?.renameKeep === true;
		const stopped = stoppable && this.request.stops.has(stepKey(step));
		const certain = step.export.certainty.status === "known" && step.import?.certainty.status !== "unknown";
		let state: RouteState;
		if (!upstream) state = "fixed";
		else if (!certain) state = "unknown";
		else if (stopped) state = "stopped";
		else state = this.passes(step) ? "renamed" : "fixed";
		const decision = { state, upstream, stopped, stoppable };
		this.decisions.set(key, decision);
		return decision;
	}

	/** One plain transfer of the name, which one alias can keep: `export { N } from`, or `import { N }` exported as written. */
	private keepable(step: RouteStep): boolean {
		const transfer = step.import;
		if (transfer === undefined || transfer.kind !== "named" || transfer.local !== undefined) return false;
		if (step.export.form === "forward")
			return step.export.name === transfer.name && step.export.sourceRange === undefined;
		return step.export.form === "local" && step.export.sourceRange === undefined && transfer.bindsLocally;
	}

	/** The edge exposes the name it receives, so a change passes; a same-name alias stays an alias. */
	private passes(step: RouteStep): boolean {
		const { export: edge, import: transfer } = step;
		switch (edge.form) {
			case "direct":
			case "star":
				return true;
			case "forward":
				return (
					transfer?.kind === "named" &&
					edge.name === transfer.name &&
					edge.sourceRange === undefined &&
					transfer.local === undefined
				);
			case "local":
				return edge.sourceRange === undefined && (transfer === undefined || localFollows(transfer));
			default:
				return false;
		}
	}

	/** The exposure's name changes: every path into it renames. A kept path leaves the old name standing. */
	private renames(exposure: Exposure): boolean {
		return exposure.row.paths.every((path) => {
			const [first] = path;
			return first === undefined || this.decide(nodeKey(first, exposure.name)).state === "renamed";
		});
	}

	/** Each stop asked for, refused unless its edge can keep the old name. */
	private checkStops(): void {
		for (const id of this.request.stops) {
			const nodes = [...this.nodes.values()].filter((node) => stepKey(node.step) === id);
			if (nodes.length === 0) {
				this.block("StopNotReExport", stopOffRoute(id));
				continue;
			}
			for (const { key, step } of nodes) {
				if (this.decide(key).stopped) continue;
				const at = { module: step.module, line: lineOf(step.export.span) };
				if (!this.keepable(step) || this.unique.get(key) !== true) {
					this.block("StopNotReExport", stopNotKeepable(step.module), at);
				} else if (this.request.tiers(step.module)?.renameKeep !== true) {
					this.block("StopUnsupported", stopUnsupported(step.module), at);
				} else this.block("StopNotReExport", stopReceivesNoChange(step.module), at);
			}
		}
	}

	/** A stopped node's transfer stays as written for every node it feeds. */
	private keep(node: Node): void {
		const transfer = this.transferOf(node.step);
		if (transfer !== null) this.keptTransfers.add(transfer.factId);
	}

	private transferOf(step: RouteStep): StoredImport | null {
		const { target } = step.export;
		return target.kind === "import" ? this.reads.importEdgeAt(step.module, target.span) : null;
	}

	/** The sites one node writes, and whether its import's binding changes. */
	private stepSites(node: Node): void {
		const decision = this.decide(node.key);
		const { step, name } = node;
		const { export: edge, module } = step;
		const transfer = this.transferOf(step);
		const at = { module, line: lineOf(edge.span) };
		if (decision.state === "unknown") this.block("RouteUnknown", routeUncertain(module, name), at);
		if (edge.form === "star" && decision.upstream) this.carries(step, name, at);
		this.edges.set(`export ${node.key}`, {
			fact: "export",
			id: edge.factId ?? stepKey(step),
			from: module,
			...(transfer?.landing && decision.state !== "unknown" ? { landing: transfer.landing } : {}),
			form: edge.form,
			name: edge.name ?? name,
			state: decision.state,
			...(decision.stoppable ? { stoppable: true as const } : {}),
		});
		let localChanges = edge.target.kind === "symbol";
		if (transfer !== null) {
			this.role(module, "reExports");
			this.stepImports.add(transfer.factId);
			this.rely(transfer);
			const kept = this.keptTransfers.has(transfer.factId);
			const passed: RouteState = kept ? "stopped" : "renamed";
			this.importEdge(transfer, decision.state === "unknown" ? "unknown" : decision.upstream ? passed : "fixed");
			if (decision.upstream && transfer.kind === "named" && transfer.range !== undefined) {
				if (this.shares(transfer, transfer.name ?? name, [transfer.meaning, edge.meaning])) {
					this.block("NameTaken", nameShared(module, transfer.name ?? name), at);
				}
				this.site(module, { range: transfer.range, role: "import", ...(kept ? { keep: true as const } : {}) });
				if (!localFollows(transfer)) this.inert.add(startKey(module, transfer.range.start));
			}
			localChanges = decision.upstream && !kept && localFollows(transfer);
			if (transfer.kind === "wildcard" || transfer.kind === "injection") {
				this.brought.set(`${transfer.factId}\n${name}`, localChanges);
			} else this.locals.set(transfer.factId, localChanges);
			if (localChanges) this.bindsChanging.add(module);
		}
		const token = edge.sourceRange ?? edge.range;
		if (token === undefined || edge.form === "star") return;
		if (edge.form === "local" ? localChanges : decision.state === "renamed") {
			this.site(module, { range: token, role: "export" });
			if (edge.form === "forward" || edge.form === "namespace") this.inert.add(startKey(module, token.start));
		}
	}

	/** A star carrying a changing name must also carry the new one, through its selector and filter. */
	private carries(step: RouteStep, name: string, at: Site): void {
		const transfer = step.import;
		const allList = allListAt(this.reads, transfer?.landing);
		const { newName } = this.request;
		const picks = [transfer?.selector, step.export.selector].map((selector) =>
			picksRenamed(selector, name, newName, allList),
		);
		// An uncertain pick leaves the row uncertain, which blocks on its own.
		if (picks.some((picked) => picked === false))
			this.block("NoExportPath", starDropsName(step.module, newName), at);
	}

	/** Another declaration crossing this named import under the name, which a renamed token drops. */
	private shares(edge: ReadImport, name: string, meanings: ReadonlyArray<Meaning | undefined>): boolean {
		if (edge.landing === null) return false;
		const others = this.tracer.landing(edge.landing).filter((row) => row.name === name && !this.isSubject(row));
		return narrowedRows(others, meanings).length > 0;
	}

	/** A module reads the subject through an import, or a use there it cannot tell from it. */
	private readsThrough(edge: StoredImport): boolean {
		const span = rangeKey(edge.span);
		return this.reads
			.referencesIn(edge.module)
			.some(
				(reference) =>
					reference.origin?.kind === "import" &&
					rangeKey(reference.origin.span) === span &&
					(reference.targetId === this.subjectId || reference.targetId === null),
			);
	}

	/** Imports landing on an exposure: their sites, and whether each binding changes. */
	private consumers(exposure: Exposure): void {
		const renames = this.renames(exposure);
		const { landing, name, row } = exposure;
		const allList = allListAt(this.reads, landing);
		const { newName } = this.request;
		for (const edge of this.reads.importEdgesLandingOn(landing)) {
			if (this.stepImports.has(edge.factId)) continue;
			// A type-only import of a value, or the like, never reaches the subject.
			if (narrowedRows([row], [edge.meaning]).length === 0) continue;
			const certain = edge.certainty.status === "known";
			const at = { module: edge.module, line: lineOf(edge.span) };
			if (edge.kind === "named") {
				if (edge.name !== name) continue;
				if (renames && edge.range !== undefined) {
					if (this.shares(edge, name, [edge.meaning])) {
						// Unread through a shared token, the token stays.
						if (!this.readsThrough(edge)) {
							this.locals.set(edge.factId, false);
							continue;
						}
						this.block("NameTaken", nameShared(edge.module, name), at);
					}
					this.site(edge.module, { range: edge.range, role: "import" });
					if (!localFollows(edge)) this.inert.add(startKey(edge.module, edge.range.start));
				}
				this.locals.set(edge.factId, !renames ? false : certain ? localFollows(edge) : null);
			} else if (edge.kind === "default") {
				if (name !== "default") continue;
				this.locals.set(edge.factId, certain || !renames ? false : null);
			} else if (edge.kind === "wildcard" || edge.kind === "injection") {
				const picked = selects(edge.selector, name, allList);
				if (picked === false) continue;
				// An uncertain pick leaves the uses through it unproved, which blocks on its own.
				if (renames && picked === true && localFollows(edge)) {
					if (picksRenamed(edge.selector, name, newName, allList) === false) {
						this.block("NoExportPath", wildcardDropsName(edge.module, newName), at);
					}
				}
				this.brought.set(
					`${edge.factId}\n${name}`,
					!renames ? false : certain && picked === true ? localFollows(edge) : null,
				);
			} else {
				// A side-effect edge stands for the module it loads, which a dotted receiver may name.
				if (renames) this.receivesChanging.add(edge.module);
				continue;
			}
			this.role(edge.module, "imports");
			this.rely(edge);
			this.importEdge(edge, !renames ? "fixed" : certain ? "renamed" : "unknown");
			if (renames && localFollows(edge)) this.bindsChanging.add(edge.module);
		}
	}

	/** Namespace holders of a renaming landing, and their importers, which may reach it by path. */
	private holders(exposure: Exposure): void {
		if (!this.renames(exposure)) return;
		const follow = (landing: Landing): void => {
			const key = landingKey(landing);
			for (const module of this.reads.modulesHoldingNamespace(landing)) {
				const seen = `${module}\n${key}`;
				if (this.holdersSeen.has(seen)) continue;
				this.holdersSeen.add(seen);
				this.receivesChanging.add(module);
				const holder: Landing = { kind: "module", module };
				const names = new Set<string>();
				for (const row of this.tracer.landing(holder)) {
					const hop = this.hop(row);
					if (row.name !== null && hop !== null && "kind" in hop && landingKey(hop) === key)
						names.add(row.name);
				}
				for (const edge of this.reads.importEdgesLandingOn(holder)) {
					const name = edge.kind === "default" ? "default" : edge.name;
					const reaches = edge.kind === "named" || edge.kind === "default" ? names.has(name ?? "") : true;
					if (reaches) this.receivesChanging.add(edge.module);
				}
				follow(holder);
			}
		};
		follow(exposure.landing);
	}

	/** A static `__all__` entry naming a renamed exposure, decided by its target, never by its spelling. */
	private allListSites(exposure: Exposure): void {
		if (exposure.landing.kind !== "module") return;
		const { module } = exposure.landing;
		const allList = this.reads.fileOf(module)?.allList;
		if (allList?.state !== "static") return;
		for (const entry of allList.entries) {
			if (entry.name !== exposure.name || entry.target.kind === "unknown") continue;
			if (!this.reachesSubject(module, entry.target, exposure)) continue;
			if (this.renames(exposure)) {
				this.site(module, { range: entry.range, role: "export" });
				this.inert.add(startKey(module, entry.range.start));
			} else this.unchanged.set(module, [...(this.unchanged.get(module) ?? []), entry.range]);
		}
	}

	private reachesSubject(module: string, target: ExportTarget, exposure: Exposure): boolean {
		if (target.kind === "symbol") return target.symbolId === this.subjectId;
		if (target.kind !== "import") return false;
		const key = rangeKey(target.span);
		return exposure.row.paths.some(
			(path) =>
				path[0]?.import !== undefined && rangeKey(path[0].import.span) === key && path[0].module === module,
		);
	}

	/** Unplanned moves where the rename reaches: another row moving, or the subject meeting a rival. */
	private movesBlocked(diff: ExposureDiff): void {
		for (const move of diff.moves) {
			const where = this.where(move.landing);
			const declaration =
				move.row.origin.kind === "symbol" ? this.reads.declaration(move.row.origin.symbolId) : null;
			if (move.kind === "rebinds") {
				this.block("NameTaken", exposureRebinds(where, move.name), this.rowSite(move.row, move.landing));
				continue;
			}
			// renameCollisions names a clash where this rename binds a name.
			const declaredHere =
				declaration !== null &&
				declaration.symbolId !== this.subjectId &&
				move.landing.kind === "module" &&
				declaration.module === move.landing.module &&
				this.bindsSites(move.landing.module);
			if (declaredHere) continue;
			const at =
				declaration === null
					? this.rowSite(move.row, move.landing)
					: { module: declaration.module, line: lineOf(declaration.selectionRange ?? declaration.range) };
			this.block("NameTaken", nameAlreadyExposed(move.name, where), at);
		}
	}

	/** At a gaining exposure, an uncertain row blocks, as does a rival outranking the rename. */
	private landed(exposure: Exposure, diff: ExposureDiff): void {
		const { landing } = exposure;
		const { newName } = this.request;
		const where = this.where(landing);
		const rows = diff.read.get(landingKey(landing))?.after ?? [];
		if (!rows.some((each) => each.name === newName && this.isSubject(each))) {
			const other = rows.find((each) => each.name === newName);
			// Lost without a rival, the name dropped on its way; carries() says where. Unimported, a rival harms no one.
			const imported = this.reads.importEdgesLandingOn(landing).length > 0;
			if (this.renames(exposure) && other !== undefined && imported) {
				this.block("NameTaken", nameAlreadyExposed(newName, where), this.rowSite(other, landing));
			}
			return;
		}
		if (exposure.row.certainty.status !== "known") {
			this.block("RouteUnknown", routeUncertain(where, exposure.name), this.siteOf(exposure));
		}
		this.allListUnknown(exposure);
	}

	/** A landing newly exposing the new name, where coverage or an `__all__` entry may already bring it. */
	private gained({ landing, before, after }: LandingRows): void {
		const { newName } = this.request;
		const row = after.find((each) => each.name === newName && this.isSubject(each));
		if (row === undefined || before.some((each) => each.name === newName && this.isSubject(each))) return;
		const where = this.where(landing);
		for (const coverage of after) {
			if (coverage.name !== null || coverage.origin.kind !== "unknown") continue;
			// A provider without the exports tier proves nothing either way.
			if (!coverage.paths.some((path) => path.length > 0)) continue;
			// A cycle only brings again what the landing already exposes.
			if (coverage.origin.reason === "RecursionLimit") continue;
			if (this.competes(coverage, row)) {
				this.block("RouteUnknown", newNameUnproved(where, newName), this.rowSite(row, landing));
			} else if (landing.kind === "module") {
				// Uses past coverage may bind nothing; the landing's own are read.
				this.bindsChanging.add(landing.module);
			}
		}
		if (landing.kind !== "module") return;
		const { module } = landing;
		const allList = this.reads.fileOf(module)?.allList;
		if (allList?.state !== "static") return;
		for (const entry of allList.entries) {
			if (entry.name !== newName || entry.target.kind !== "unknown") continue;
			this.block("RouteUnknown", newNameUnproved(where, newName), { module, line: lineOf(entry.range) });
		}
	}

	/** An `__all__` entry named like a gaining exposure, which says nothing of what it binds. */
	private allListUnknown(exposure: Exposure): void {
		if (exposure.landing.kind !== "module") return;
		const { module } = exposure.landing;
		const allList = this.reads.fileOf(module)?.allList;
		if (allList?.state !== "static") return;
		for (const entry of allList.entries) {
			if (entry.name !== exposure.name || entry.target.kind !== "unknown") continue;
			this.block("RouteUnknown", allListUnproved(module, entry.name), { module, line: lineOf(entry.range) });
		}
	}

	/** Whether coverage can bring a rival `newName`: a star meets a star; an explicit export loses by its rule. */
	private competes(coverage: TracedExport, row: TracedExport): boolean {
		if (row.paths.some((path) => path[0]?.export.form === "star")) return true;
		const last = Math.max(...row.paths.map((path) => path[0]?.export.order ?? -1));
		return coverage.paths.some((path) => {
			const star = path[0]?.export;
			if (star === undefined) return true;
			const rule = star.conflict.againstLocal;
			return rule === "transferWins" || (rule === "sourceOrder" && star.order > last);
		});
	}

	/** A use bound to the subject: a site where its binding changes, a blocker where nothing proves it. */
	private boundUse(reference: StoredReference): void {
		const range = this.rangeOf(reference);
		// The transfer's own token, already decided.
		if (this.sites.get(reference.module)?.has(rangeKey(range)) === true) return;
		const verdict = this.verdict(reference);
		if (verdict === "unproved" || verdict === "untracked") {
			this.block("RouteUnknown", useUntraced(this.oldName), { module: reference.module, line: lineOf(range) });
			return;
		}
		this.role(reference.module, "uses");
		if (verdict === "renames") this.useSite(reference, range);
	}

	/** Importers reading the subject's module through a receiver, whose proved paths may name a member. */
	private receivers(): void {
		const own: Landing = { kind: "module", module: this.request.subject.module };
		for (const edge of this.reads.importEdgesLandingOn(own))
			if (isReceiver(edge)) this.pathReaders.add(edge.module);
	}

	/**
	 * Uses spelled like the old name that bound to nothing, where a changing binding or receiver
	 * reaches, a proved path may lead, or the subject's own module reads it. One with no origin blocks
	 * where a change reaches; one whose origin leaves the subject's routes stays.
	 */
	private unboundUses(): void {
		const { module: own } = this.request.subject;
		const modules = new Set([...this.bindsChanging, ...this.receivesChanging, ...this.pathReaders, own]);
		for (const module of [...modules].sort()) {
			for (const reference of this.reads.referencesIn(module)) {
				if (reference.targetId !== null || reference.name !== this.oldName) continue;
				const range = this.rangeOf(reference);
				if (this.sites.get(module)?.has(rangeKey(range)) === true) continue;
				const reaches =
					reference.qualified === true ? this.receivesChanging.has(module) : this.bindsChanging.has(module);
				const verdict =
					reference.origin === null ? (reaches ? "unproved" : "untracked") : this.verdict(reference);
				if (verdict === "unproved") {
					this.block("RouteUnknown", useUntraced(this.oldName), { module, line: lineOf(range) });
				} else if (verdict === "renames") this.useSite(reference, range);
			}
		}
	}

	private useSite(reference: StoredReference, range: Range): void {
		if (reference.qualified === true) this.qualified.add(startKey(reference.module, range.start));
		this.site(reference.module, { range, role: reference.role });
	}

	/** How the binding a use reads fares, through its proved origin. */
	private verdict(reference: StoredReference): Verdict {
		const { origin } = reference;
		if (origin === null) return "unproved";
		if (origin.kind === "declaration") {
			if (reference.targetId === this.subjectId) return "renames";
			// Ambiguous among the subject's own module's declarations: one of them may be the subject.
			return reference.targetId === null && reference.module === this.request.subject.module
				? "unproved"
				: "untracked";
		}
		const edge = this.reads.importEdgeAt(reference.module, origin.span);
		if (edge === null) return "untracked";
		if (origin.path !== undefined && origin.path.length > 0) return this.walk(reference, edge, origin.path);
		const held =
			edge.kind === "wildcard" || edge.kind === "injection"
				? this.brought.get(`${edge.factId}\n${reference.name}`)
				: this.locals.get(edge.factId);
		if (held === undefined) {
			if (!this.assigned(edge)) return "untracked";
			this.rely(edge);
			return "stays";
		}
		this.rely(edge);
		if (held === null) return "unproved";
		return held ? "renames" : "stays";
	}

	/** The edge loads the subject itself (`export =`, `module.exports =`), so its local binding is an alias. */
	private assigned(edge: StoredImport): boolean {
		if (edge.landing === null || (edge.kind !== "require" && edge.kind !== "namespace")) return false;
		return this.tracer.landing(edge.landing).some((row) => row.name === null && this.isSubject(row));
	}

	/**
	 * Follows a receiver's path from its import through namespace exports to the subject's exposure,
	 * or into a declaration's members. A bound use the facts contradict is untracked; a step they cannot
	 * follow leaves the use unproved.
	 */
	private walk(reference: StoredReference, edge: StoredImport, path: readonly string[]): Verdict {
		const bound = reference.targetId === this.subjectId;
		// A package outside the workspace cannot reach the subject.
		if (edge.landing === null) return bound ? "untracked" : "stays";
		this.rely(edge);
		let at = this.receiver(edge);
		for (const [index, segment] of path.entries()) {
			if (at === null) return "unproved";
			if (!("kind" in at)) return this.members(reference, at.owner, path.slice(index));
			const rows = this.tracer.landing(at);
			const named = rows.filter((row) => row.name === segment);
			const last = index === path.length - 1;
			if (named.length === 0) {
				// `export =`: the module's whole value, whose members the path names.
				const value = rows.find((row) => row.name === null && row.origin.kind !== "unknown");
				if (value !== undefined) {
					this.relyPaths(value);
					const next = this.hop(value);
					if (next === null) return "unproved";
					if (!("kind" in next)) return this.members(reference, next.owner, path.slice(index));
					at = next;
					continue;
				}
				const covered = rows.some(
					(row) =>
						row.name === null && row.origin.kind === "unknown" && !INERT_COVERAGE.has(row.origin.reason),
				);
				if (!covered) return bound ? "untracked" : "stays";
				// Without stated exports, a bound use there is the member's own token.
				const own = at.kind === "module" && at.module === this.request.subject.module;
				return bound && own ? "renames" : "unproved";
			}
			// A use bound to the subject reads its row where a declaration of another meaning shares the name:
			// the subject itself last, before that the declaration holding it.
			const subjects = !bound
				? []
				: last
					? named.filter((each) => this.isSubject(each))
					: named.filter((each) => each.origin.kind === "symbol" && this.within(each.origin.symbolId));
			const candidates = subjects.length === 1 ? subjects : named;
			const [row] = candidates;
			if (candidates.length > 1 || row === undefined || row.certainty.status !== "known") return "unproved";
			this.relyPaths(row);
			if (last) {
				const exposure = this.exposures.get(exposureKey(at, segment));
				if (exposure === undefined) {
					if (row.origin.kind === "unknown") return "unproved";
					return bound ? "untracked" : "stays";
				}
				const renames = this.renames(exposure);
				this.importEdge(edge, renames ? "renamed" : "fixed");
				if (renames) this.receivesChanging.add(edge.module);
				return renames ? "renames" : "stays";
			}
			at = this.hop(row);
		}
		return "untracked";
	}

	/** A path into a declaration's members: bound, the token is the member's name; unbound under the subject's owner, unproved. */
	private members(reference: StoredReference, owner: string, rest: readonly string[]): Verdict {
		const bound = reference.targetId === this.subjectId;
		if (rest.length === 0) return bound ? "untracked" : "stays";
		if (bound) return "renames";
		return rest.at(-1) === this.oldName && this.within(owner) ? "unproved" : "stays";
	}

	/** The subject is declared somewhere under `owner`. */
	private within(owner: string): boolean {
		const seen = new Set<string>();
		for (let at = this.request.subject.containerId; at !== undefined && !seen.has(at); ) {
			if (at === owner) return true;
			seen.add(at);
			at = this.reads.declaration(at)?.containerId;
		}
		return false;
	}

	/** Where a receiver's members are read: a namespace's or loaded module's exports, or what a name holds. */
	private receiver(edge: StoredImport): Hop | null {
		if (edge.landing === null || edge.certainty.status !== "known") return null;
		if (isReceiver(edge)) return edge.landing;
		const name = edge.kind === "default" ? "default" : edge.name;
		if (name === undefined) return null;
		const rows = this.tracer.landing(edge.landing).filter((row) => row.name === name);
		const [row] = rows;
		if (rows.length !== 1 || row === undefined || row.certainty.status !== "known") return null;
		this.relyPaths(row);
		return this.hop(row);
	}

	/** Where a row leads a path: the landing it stands for, or a declaration's members. */
	private hop(row: TracedExport): Hop | null {
		switch (row.origin.kind) {
			case "namespace":
				return row.origin.landing;
			case "moduleValue":
				return { kind: "module", module: row.origin.module };
			case "symbol":
				return { owner: row.origin.symbolId };
			default:
				return null;
		}
	}

	/** A wildcard newly bringing a name into a module that already binds or reads it. */
	private captures(diff: ExposureDiff, renamed: RenamedReads): void {
		for (const key of diff.moved) {
			const rows = diff.read.get(key);
			if (rows === undefined) continue;
			for (const edge of this.reads.importEdgesLandingOn(rows.landing)) {
				if ((edge.kind !== "wildcard" && edge.kind !== "injection") || !edge.bindsLocally) continue;
				const was = bringing(edge, rows.before, allListAt(this.reads, rows.landing));
				const now = bringing(edge, rows.after, allListAt(renamed, rows.landing));
				for (const [name, origins] of now) {
					if (was.get(name) === origins) continue;
					// The capture check rests on where the wildcard lands.
					this.rely(edge);
					const at = this.boundOtherwise(edge, name);
					if (at !== null) this.block("NameImported", wildcardCaptures(edge.module, name), at);
				}
			}
		}
	}

	/** Where a module binds or reads `name` apart from `edge`, which a wildcard bringing it captures. */
	private boundOtherwise(edge: StoredImport, name: string): Site | null {
		const { module } = edge;
		const sites = this.sites.get(module);
		const localWins = edge.conflict?.againstLocal === "localWins";
		const imports = this.reads.importsIn(module).filter((other) => other.factId !== edge.factId);
		const declared = this.reads
			.heldIn(module)
			.filter((each) => each.name === name && each.containerId === undefined);
		const explicit = imports.filter(
			(other) =>
				other.bindsLocally &&
				other.kind !== "wildcard" &&
				other.kind !== "injection" &&
				(other.local ?? other.name) === name,
		);
		// Under source order, a later binding of the name replaces the wildcard's from where it runs.
		const later = (at: Position) => edge.conflict?.againstLocal === "sourceOrder" && after(at, edge.span.end);
		const [shadow] = [
			...declared.map((each) => (each.selectionRange ?? each.range).start),
			...explicit.map((other) => other.span.start),
		]
			.filter(later)
			.sort((left, right) => (after(left, right) ? 1 : -1));
		// The declared and imported name checks cover a module holding sites that bind.
		if (!localWins && !this.bindsSites(module)) {
			const binding = declared.find((each) => !later((each.selectionRange ?? each.range).start));
			if (binding !== undefined) return { module, line: lineOf(binding.selectionRange ?? binding.range) };
			const imported = explicit.find((other) => !later(other.span.start));
			if (imported !== undefined) return { module, line: lineOf(imported.span) };
		}
		const wildcard = imports.find(
			(other) =>
				(other.kind === "wildcard" || other.kind === "injection") &&
				other.landing !== null &&
				bringing(other, this.tracer.landing(other.landing), allListAt(this.reads, other.landing)).has(name),
		);
		if (wildcard !== undefined) return { module, line: lineOf(wildcard.span) };
		const read = this.reads.referencesIn(module).find((reference) => {
			if (reference.name !== name || sites?.has(rangeKey(this.rangeOf(reference))) === true) return false;
			if (localWins && reference.targetId !== null) return false;
			if (shadow === undefined) return true;
			// Past a shadowing binding, and in any body run later, the name reads that binding.
			const at = { line: reference.startLine, character: reference.startCharacter };
			return reference.fromId === null && after(at, edge.span.end) && after(shadow, at);
		});
		return read === undefined ? null : { module, line: read.startLine + 1 };
	}

	/** A module holds a site that writes or reads a binding there. */
	private bindsSites(module: string): boolean {
		return [...(this.sites.get(module)?.values() ?? [])].some((site) => {
			const key = startKey(module, site.range.start);
			return site.keep !== true && !this.inert.has(key) && !this.qualified.has(key);
		});
	}

	/** One decision per range; a range both kept and renamed blocks. */
	private site(module: string, site: RenameSite): void {
		const held = this.sites.get(module) ?? new Map<string, RenameSite>();
		this.sites.set(module, held);
		const key = rangeKey(site.range);
		const prior = held.get(key);
		if (prior === undefined) held.set(key, site);
		else if ((prior.keep === true) !== (site.keep === true)) {
			this.block("StopNotReExport", siteDecidedTwice(module), { module, line: lineOf(site.range) });
		}
	}

	/** One blocker per sentence, naming every site it holds for. */
	private block(kind: string, detail: Refusal, at?: Site): void {
		if (at !== undefined && kind === "RouteUnknown")
			this.untraced.set(at.module, (this.untraced.get(at.module) ?? 0) + 1);
		const key = `${kind}\n${detail}`;
		const held = this.blocked.get(key) ?? { kind, detail };
		this.blocked.set(key, held);
		if (at === undefined) return;
		const sites = held.sites ?? [];
		if (sites.length < SITES_SHOWN && !sites.some((site) => site.module === at.module && site.line === at.line)) {
			held.sites = [...sites, at];
		}
	}

	/** Where to point at an exposure: its first edge, else its landing's first line. */
	private siteOf(exposure: Exposure): Site {
		return this.rowSite(exposure.row, exposure.landing);
	}

	/** Where to point at a row: the first edge bringing it, else its landing's first line. */
	private rowSite(row: TracedExport, landing: Landing): Site {
		const first = row.paths.flat()[0];
		if (first !== undefined) return { module: first.module, line: lineOf(first.export.span) };
		return { module: this.where(landing), line: 1 };
	}

	private isSubject(row: EffectiveExport): boolean {
		return row.origin.kind === "symbol" && row.origin.symbolId === this.subjectId;
	}

	private where(landing: Landing): string {
		return landing.kind === "module" ? landing.module : landing.scopeId;
	}

	private importEdge(edge: StoredImport, state: RouteState): void {
		this.edges.set(`import ${edge.factId}`, {
			fact: "import",
			id: edge.factId,
			from: edge.module,
			...(edge.landing !== null && state !== "unknown" ? { landing: edge.landing } : {}),
			transfer: edge.kind,
			...(edge.name === undefined ? {} : { name: edge.name }),
			state,
		});
	}

	private rely(edge: StoredImport): void {
		this.relied.set(edge.factId, edge);
	}

	/** Every import edge behind a row, so a hop resting on it is checked live too. */
	private relyPaths(row: TracedExport): void {
		for (const step of row.paths.flat()) {
			const transfer = this.transferOf(step);
			if (transfer !== null) this.rely(transfer);
		}
	}

	private role(module: string, role: Role): void {
		const held = this.roles.get(module) ?? new Set<Role>();
		held.add(role);
		this.roles.set(module, held);
	}

	private rangeOf(reference: StoredReference): Range {
		return {
			start: { line: reference.startLine, character: reference.startCharacter },
			end: { line: reference.endLine, character: reference.endCharacter },
		};
	}

	private moduleRows(): RouteModule[] {
		const modules = new Set([...this.roles.keys(), ...this.sites.keys(), ...this.untraced.keys()]);
		return [...modules].sort().map((module) => {
			const sites = [...(this.sites.get(module)?.values() ?? [])];
			const roles = this.roles.get(module) ?? new Set<Role>();
			return {
				module,
				roles: ROLE_ORDER.filter((role) => roles.has(role)),
				edited: sites.filter((site) => site.keep !== true).length,
				kept: sites.filter((site) => site.keep === true).length,
				unknown: this.untraced.get(module) ?? 0,
			};
		});
	}
}
