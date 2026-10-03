// Each module's effective exports: the names it exposes, what each binds to, and how sure that is.
// One resolver feeds the surface digest, the stored projection and rename routes, so they agree.

import type {
	AllList,
	Certainty,
	Conflict,
	Export,
	ImportEdge,
	Landing,
	Meaning,
	Range,
	Selector,
	UnknownReason,
} from "@nyaa-lexicon/protocol";

////////////////////////////////
//  Interfaces & Types

export type ExportOrigin =
	| { kind: "symbol"; symbolId: string }
	| { kind: "namespace"; landing: Landing }
	| { kind: "moduleValue"; module: string }
	| { kind: "unknown"; reason: UnknownReason };

/** One name a module exposes. A null name is an unnamed route, such as unknown coverage. */
export interface EffectiveExport {
	name: string | null;
	meaning?: Meaning | undefined;
	origin: ExportOrigin;
	certainty: Certainty;
}

export type ScopeLanding = Exclude<Landing, { kind: "module" }>;

/** An export edge as read, with its fact id when the store holds one. */
export type ReadExport = Export & { factId?: string | undefined };

/** An import edge as read, with its fact id and where its specifier landed. */
export type ReadImport = ImportEdge & { factId?: string | undefined; landing: Landing | null };

/** One step of a route: an export in `module`, and the import edge it forwards from when it does. */
export interface RouteStep {
	module: string;
	export: ReadExport;
	import?: ReadImport | undefined;
}

/** An effective export with every path of edges that produced it, outermost step first. */
export interface TracedExport extends EffectiveExport {
	paths: RouteStep[][];
}

/** What the resolver reads, so it runs on the store and on fixtures alike. */
export interface ProjectionReads {
	/** Null when the index holds no such module. */
	fileOf(module: string): { exportsKnown: boolean; allList: AllList | null } | null;
	exportsIn(module: string): ReadExport[];
	/** The import edge written at exactly `span`, with where its specifier landed. */
	importEdgeAt(module: string, span: Range): ReadImport | null;
	/** Top-level declarations another module may reach, for a module without export facts. */
	exportedDeclarations(module: string): Array<{ symbolId: string; name: string }>;
	/** A scope's admitted members by name; null when nothing contributes to it. */
	scopeMembers(landing: ScopeLanding): Array<{ symbolId: string; name: string }> | null;
	/** Export edges a contributor states from the scope, each with its module. */
	scopeExports(landing: ScopeLanding): Array<{ module: string; edge: ReadExport }>;
}

/** The store side of settlement. */
export interface ProjectionStore extends ProjectionReads {
	/** Any module owing a projection, or null when none does. */
	nextProjectionDebt(): string | null;
	/** Writes the projection and its surface move, clears the debt, and owes its forwarders; true when it moved. */
	commitProjection(module: string, rows: readonly EffectiveExport[]): boolean;
}

/** A row on its way out, with the edge that brought it, for conflict rules. */
interface Candidate extends TracedExport {
	conflict: Conflict;
	order: number;
}

////////////////////////////////
//  Constants

const KNOWN: Certainty = { status: "known" };

/** A scope member is declared there, so it stands as a local against the scope's own transfers. */
const MEMBER: Conflict = { priority: 0, amongTransfers: "exclude", againstLocal: "localWins" };

////////////////////////////////
//  Functions & Helpers

function unknown(reason: UnknownReason): TracedExport {
	return { name: null, origin: { kind: "unknown", reason }, certainty: { status: "unknown", reason }, paths: [[]] };
}

function worst(...all: readonly Certainty[]): Certainty {
	return all.find((each) => each.status === "unknown") ?? KNOWN;
}

/** One string per scope: JSON of its provider, kind and id. */
export function scopeKey(scope: { providerId: string; kind: string; scopeId: string }): string {
	return JSON.stringify([scope.providerId, scope.kind, scope.scopeId]);
}

/** The scope a key names. */
export function scopeOfKey(key: string): ScopeLanding {
	const [providerId, kind, scopeId] = JSON.parse(key) as [string, ScopeLanding["kind"], string];
	return { kind, providerId, scopeId };
}

/** One string per landing: a module path, or a scope's key. */
export function landingKey(landing: Landing): string {
	return landing.kind === "module" ? `module ${landing.module}` : `scope ${scopeKey(landing)}`;
}

/** `*` any run, `?` one character, `[...]` a class, `[!...]` its complement. */
export function globMatches(glob: string, name: string, caseInsensitive: boolean): boolean {
	const fold = (text: string) => (caseInsensitive ? text.toLowerCase() : text);
	const pattern = fold(glob);
	const text = fold(name);
	const memo = new Map<string, boolean>();
	const at = (p: number, t: number): boolean => {
		const key = `${p},${t}`;
		const held = memo.get(key);
		if (held !== undefined) return held;
		let result: boolean;
		const char = pattern[p];
		if (char === undefined) result = t === text.length;
		else if (char === "*") result = at(p + 1, t) || (t < text.length && at(p, t + 1));
		else if (t >= text.length) result = false;
		else if (char === "?") result = at(p + 1, t + 1);
		else if (char === "[") {
			const close = pattern.indexOf("]", p + 2);
			if (close === -1) result = text[t] === "[" && at(p + 1, t + 1);
			else {
				const negated = pattern[p + 1] === "!";
				const members = pattern.slice(negated ? p + 2 : p + 1, close);
				result = members.includes(text[t] ?? "") !== negated && at(close + 1, t + 1);
			}
		} else result = char === text[t] && at(p + 1, t + 1);
		memo.set(key, result);
		return result;
	};
	return at(0, 0);
}

/** Each row's paths with `step` in front. */
function through(step: RouteStep, rows: readonly TracedExport[]): TracedExport[] {
	return rows.map((row) => ({ ...row, paths: row.paths.map((path) => [step, ...path]) }));
}

////////////////////////////////
//  Class

class Projector {
	private readonly done = new Map<string, TracedExport[]>();
	/** Computations under way, outermost first, each with the enclosing keys its cycles met. */
	private readonly open: Array<{ key: string; met: Set<string> }> = [];

	constructor(private readonly reads: ProjectionReads) {}

	of(module: string): TracedExport[] {
		return this.memo(module, () => this.compute(module));
	}

	/**
	 * One answer per module or scope; a cycle is not proved from inside it, so it reads unknown. Rows
	 * cut short by a cycle through an enclosing computation hold only inside it, so they are not kept.
	 */
	private memo(key: string, compute: () => TracedExport[]): TracedExport[] {
		const held = this.done.get(key);
		if (held !== undefined) return held;
		const at = this.open.findIndex((each) => each.key === key);
		if (at !== -1) {
			for (const inner of this.open.slice(at + 1)) inner.met.add(key);
			return [unknown("RecursionLimit")];
		}
		const frame = { key, met: new Set<string>() };
		this.open.push(frame);
		const rows = compute();
		this.open.pop();
		if (frame.met.size === 0) this.done.set(key, rows);
		return rows;
	}

	private compute(module: string): TracedExport[] {
		const file = this.reads.fileOf(module);
		if (file === null) return [];
		if (!file.exportsKnown) {
			const declared = this.reads.exportedDeclarations(module).map(
				({ symbolId, name }): TracedExport => ({
					name,
					origin: { kind: "symbol", symbolId },
					certainty: KNOWN,
					paths: [[]],
				}),
			);
			return [...declared, unknown("NotImplemented")];
		}
		// A scope's export, not the module's.
		const edges = this.reads.exportsIn(module).filter((edge) => edge.scopeId === undefined);
		return this.settledEdges(edges.map((edge) => ({ module, edge })));
	}

	/** Each edge's rows under its conflict rules, with `locals` standing as explicit exports. */
	private settledEdges(
		edges: ReadonlyArray<{ module: string; edge: ReadExport }>,
		locals: readonly Candidate[] = [],
	): TracedExport[] {
		const explicit: Candidate[] = [...locals];
		const transferred: Candidate[] = [];
		for (const { module, edge } of [...edges].sort((left, right) => left.edge.order - right.edge.order)) {
			const rows = this.rowsOf(module, edge).map((row) => ({
				...row,
				conflict: edge.conflict,
				order: edge.order,
			}));
			(edge.form === "star" ? transferred : explicit).push(...rows);
		}
		return settled(explicit, transferred);
	}

	/** What one edge exposes, before conflict rules. */
	private rowsOf(module: string, edge: ReadExport): TracedExport[] {
		const name = edge.form === "star" ? null : (edge.name ?? null);
		const own: RouteStep = { module, export: edge };
		const named = (
			origin: ExportOrigin,
			paths: RouteStep[][],
			certainty: Certainty = KNOWN,
			meaning = edge.meaning,
		): TracedExport => ({
			name,
			meaning,
			origin,
			certainty: worst(certainty, edge.certainty),
			paths,
		});
		const { target } = edge;
		if (target.kind === "symbol") return [named({ kind: "symbol", symbolId: target.symbolId }, [[own]])];
		if (target.kind === "unknown") return [named({ kind: "unknown", reason: target.reason }, [[own]])];
		const transfer = this.reads.importEdgeAt(module, target.span);
		if (transfer === null) return [named({ kind: "unknown", reason: "BrokenImport" }, [[own]])];
		const step: RouteStep = { module, export: edge, import: transfer };
		const { landing } = transfer;
		const certainty = worst(edge.certainty, transfer.certainty);
		if (landing === null) {
			return edge.form === "star"
				? through(step, [unknown("ExternalDependency")])
				: [named({ kind: "unknown", reason: "ExternalDependency" }, [[step]])];
		}
		const meanings = [transfer.meaning, edge.meaning];
		if (edge.form === "star") {
			return through(step, this.starred(landing, transfer.selector, edge.selector, certainty, meanings));
		}
		if (edge.form === "namespace" || transfer.kind === "namespace")
			return [named({ kind: "namespace", landing }, [[step]], certainty)];
		if (transfer.kind === "require") {
			const origin: ExportOrigin =
				landing.kind === "module"
					? { kind: "moduleValue", module: landing.module }
					: { kind: "namespace", landing };
			return [named(origin, [[step]], certainty)];
		}
		const source = transfer.kind === "default" ? "default" : transfer.name;
		if (source === undefined) return [named({ kind: "unknown", reason: "Ambiguous" }, [[step]])];
		const found = narrowedRows(this.named(landing, source), meanings);
		if (found.length === 0) return [named({ kind: "unknown", reason: "BrokenImport" }, [[step]], certainty)];
		return through(step, found).map((row) =>
			named(row.origin, row.paths, worst(row.certainty, certainty), row.meaning),
		);
	}

	/** What a landing exposes: a module's projection or a scope's, unknown when the index holds neither. */
	at(landing: Landing): TracedExport[] {
		if (landing.kind === "module") {
			return this.reads.fileOf(landing.module) === null ? [unknown("NotIndexed")] : this.of(landing.module);
		}
		return this.memo(`scope ${scopeKey(landing)}`, () => this.scopeRows(landing));
	}

	/** A scope's members, then what its contributors export from it, under the same conflict rules. */
	private scopeRows(landing: ScopeLanding): TracedExport[] {
		const members = this.reads.scopeMembers(landing);
		if (members === null) return [unknown("NotIndexed")];
		const locals = members.map(
			({ symbolId, name }): Candidate => ({
				name,
				origin: { kind: "symbol", symbolId },
				certainty: KNOWN,
				paths: [[]],
				conflict: MEMBER,
				order: -1,
			}),
		);
		return this.settledEdges(this.reads.scopeExports(landing), locals);
	}

	/** The rows a landing exposes under `name`; unknown coverage stands in when no row does. */
	private named(landing: Landing, name: string): TracedExport[] {
		const rows = this.at(landing);
		const hits = rows.filter((row) => row.name === name);
		if (hits.length > 0) return hits;
		return rows.filter((row) => row.name === null && row.origin.kind === "unknown");
	}

	/** Every name a star brings, through the import edge's selector, the export's filter and both meanings. */
	private starred(
		landing: Landing,
		selector: Selector | undefined,
		filter: Selector | undefined,
		certainty: Certainty,
		meanings: ReadonlyArray<Meaning | undefined>,
	): TracedExport[] {
		const allList = landing.kind === "module" ? (this.reads.fileOf(landing.module)?.allList ?? null) : null;
		// A selector proved to pick nothing brings no unknown coverage either.
		if (selectsNothing(selector) || selectsNothing(filter)) return [];
		return narrowedRows(this.at(landing), meanings).flatMap((row) => {
			if (row.name === null) return [row];
			const picked = selects(selector, row.name, allList);
			if (picked === false || selects(filter, row.name, allList) === false) return [];
			const sure = picked === true ? certainty : worst(certainty, picked);
			return [{ ...row, certainty: worst(row.certainty, sure) }];
		});
	}
}

/** The atoms both meanings allow: absent when neither says, null when they share none. */
export function narrowed(row: Meaning | undefined, wanted: Meaning | undefined): Meaning | undefined | null {
	if (wanted === undefined) return row;
	if (row === undefined) return wanted;
	const shared = row.filter((atom) => wanted.includes(atom));
	return shared.length === 0 ? null : shared;
}

/** Rows narrowed by each meaning in turn, dropping a row none allows. */
export function narrowedRows<T extends EffectiveExport>(
	rows: readonly T[],
	meanings: ReadonlyArray<Meaning | undefined>,
): T[] {
	return rows.flatMap((row) => {
		let meaning: Meaning | undefined | null = row.meaning;
		for (const wanted of meanings) meaning = meaning === null ? null : narrowed(meaning, wanted);
		if (meaning === null) return [];
		return [meaning === undefined ? row : { ...row, meaning }];
	});
}

function selectsNothing(selector: Selector | undefined): boolean {
	return selector?.kind === "names" && selector.names.length === 0;
}

/** True or false when a selector decides a name; a certainty when it cannot. */
export function selects(selector: Selector | undefined, name: string, allList: AllList | null): boolean | Certainty {
	switch (selector?.kind) {
		case undefined:
		case "visible":
			return true;
		case "allButDefault":
			return name !== "default";
		case "names":
			return selector.names.includes(name);
		case "pattern":
			return globMatches(selector.glob, name, selector.caseInsensitive);
		case "allList":
			if (allList === null) return { status: "unknown", reason: "NotIndexed" };
			if (allList.state === "static") return allList.entries.some((entry) => entry.name === name);
			if (allList.state === "absent")
				return globMatches(allList.fallback.glob, name, allList.fallback.caseInsensitive);
			return { status: "unknown", reason: allList.reason };
	}
}

/** Two origins name the same thing. */
function sameOrigin(left: ExportOrigin, right: ExportOrigin): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Applies each edge's conflict rules. An explicit export meets a transfer of its name by the
 * transfer's `againstLocal`; transfers meet each other by priority, then `amongTransfers`. One origin
 * reached by several paths keeps every path.
 */
function settled(explicit: readonly Candidate[], transferred: readonly Candidate[]): TracedExport[] {
	const out: Candidate[] = [];
	const meaningKey = (row: EffectiveExport) => JSON.stringify(row.meaning ?? null);
	const key = (row: EffectiveExport) => `${row.name}\n${meaningKey(row)}`;
	const coverage = new Map<string, Candidate>();
	const byKey = new Map<string, Candidate[]>();
	for (const row of transferred) {
		if (row.name === null) {
			const origin = JSON.stringify(row.origin);
			const held = coverage.get(origin);
			coverage.set(origin, held === undefined ? row : { ...held, paths: [...held.paths, ...row.paths] });
			continue;
		}
		const group = byKey.get(key(row)) ?? [];
		group.push(row);
		byKey.set(key(row), group);
	}
	const locals = new Map<string, Candidate[]>();
	for (const row of explicit) {
		const group = locals.get(key(row)) ?? [];
		group.push(row);
		locals.set(key(row), group);
	}
	for (const [name, group] of byKey) {
		const top = Math.max(...group.map((row) => row.conflict.priority));
		const best = group.filter((row) => row.conflict.priority === top);
		// One origin keeps its earliest edge, and is known when any path to it is.
		const distinct: Candidate[] = [];
		for (const row of [...best].sort((left, right) => left.order - right.order)) {
			const at = distinct.findIndex((other) => sameOrigin(other.origin, row.origin));
			const held = distinct[at];
			if (held === undefined) distinct.push(row);
			else
				distinct[at] = {
					...held,
					certainty: row.certainty.status === "known" ? KNOWN : held.certainty,
					paths: [...held.paths, ...row.paths],
				};
		}
		let winner: Candidate | undefined;
		if (distinct.length === 1) winner = distinct[0];
		else {
			const rule = distinct[0]?.conflict.amongTransfers ?? "exclude";
			const ordered = [...distinct].sort((left, right) => left.order - right.order);
			winner = rule === "earlierWins" ? ordered[0] : rule === "laterWins" ? ordered.at(-1) : undefined;
		}
		const local = locals.get(name);
		if (winner === undefined) continue;
		if (local === undefined) {
			out.push(winner);
			continue;
		}
		const rule = winner.conflict.againstLocal;
		const lastLocal = Math.max(...local.map((row) => row.order));
		if (rule === "transferWins" || (rule === "sourceOrder" && winner.order > lastLocal)) {
			locals.set(name, []);
			out.push(winner);
		}
	}
	for (const group of locals.values()) out.push(...group);
	out.push(...coverage.values());
	return out
		.sort((left, right) => left.order - right.order)
		.map(({ name, meaning, origin, certainty, paths }) => ({
			name,
			...(meaning === undefined ? {} : { meaning }),
			origin,
			certainty,
			paths,
		}));
}

/** The effective exports of one module, each with every path of edges that produced it. */
export function traceExports(module: string, reads: ProjectionReads): TracedExport[] {
	return new Projector(reads).of(module);
}

/** One memo across many modules and scopes, for a reader asking about several. */
export function exportTracer(reads: ProjectionReads): {
	module(module: string): TracedExport[];
	landing(landing: Landing): TracedExport[];
} {
	const projector = new Projector(reads);
	return { module: (module) => projector.of(module), landing: (landing) => projector.at(landing) };
}

/** The effective exports of one module. */
export function projectExports(module: string, reads: ProjectionReads): EffectiveExport[] {
	return traceExports(module, reads).map(({ paths: _paths, ...row }) => row);
}

/** Recomputes every owed projection to a fixpoint; answers the modules whose exports moved. */
export function settleProjections(store: ProjectionStore): string[] {
	const moved = new Set<string>();
	for (let module = store.nextProjectionDebt(); module !== null; module = store.nextProjectionDebt()) {
		if (store.commitProjection(module, projectExports(module, store))) moved.add(module);
	}
	return [...moved];
}
