// What a rename moves in what landings expose. Each landing is read before and after, and every
// landing forwarding from one that moved is read too, so a name a shadowed or filtered star starts
// carrying is caught where it lands.

import { type Landing, sameRange } from "@nyaa-lexicon/protocol";
import {
	type EffectiveExport,
	type ExportOrigin,
	exportTracer,
	landingKey,
	narrowed,
	type ProjectionReads,
	type ReadImport,
	type ScopeLanding,
	type TracedExport,
} from "./exportProjection.js";

////////////////////////////////
//  Interfaces & Types

/** What the comparison reads on each side. */
export interface DiffReads extends ProjectionReads {
	importEdgesLandingOn(landing: Landing): Array<ReadImport & { module: string }>;
	/** The scopes a module contributes to. */
	scopesOf(module: string): ScopeLanding[];
}

/** One landing's rows on both sides. */
export interface LandingRows {
	landing: Landing;
	before: TracedExport[];
	after: TracedExport[];
}

/** A name a landing would expose differently than the rename plans. */
export interface ExposureMove {
	landing: Landing;
	name: string;
	/** `rebinds`: another origin's row moves. `clashes`: the subject meets another row of its name. */
	kind: "rebinds" | "clashes";
	/** The other row. */
	row: TracedExport;
}

export interface ExposureDiff {
	moves: ExposureMove[];
	/** Every landing read, by `landingKey`. */
	read: Map<string, LandingRows>;
	/** Keys of the landings whose rows moved. */
	moved: Set<string>;
}

////////////////////////////////
//  Functions & Helpers

/** One string per row: its name, meaning, origin and certainty, never its paths. */
export function rowKey(row: EffectiveExport, origin: ExportOrigin = row.origin): string {
	return JSON.stringify([row.name, row.meaning ?? null, origin, row.certainty.status]);
}

/** The star edges a row arrives through, by module and span. */
function stars(row: TracedExport): Set<string> {
	const keys = row.paths.flatMap((path) => {
		const [step] = path;
		return step?.export.form === "star" ? [`${step.module} ${JSON.stringify(step.export.span)}`] : [];
	});
	return new Set(keys);
}

/** Two rows of one name that cannot both stand: a shared meaning, or disjoint ones one star does not carry merged. */
function meets(left: TracedExport, right: TracedExport): boolean {
	if (left.name !== right.name) return false;
	if (narrowed(left.meaning, right.meaning) !== null) return true;
	// One star carries a module's merged value and type together; two stars meet by name alone.
	const through = stars(left);
	const other = stars(right);
	return ![...other].some((key) => through.has(key));
}

/** Every edge bringing a row lets a later binding of its name replace an earlier one. */
function rebinds(row: TracedExport): boolean {
	return row.paths.every((path) => path[0] !== undefined && path[0].export.conflict.amongTransfers !== "exclude");
}

/** The subject beside each row it meets, keyed by that row's name and origin. */
function clashesIn(rows: readonly TracedExport[], isSubject: (origin: ExportOrigin) => boolean) {
	const out = new Map<string, TracedExport>();
	rows.forEach((row, at) => {
		if (row.name === null || !isSubject(row.origin)) return;
		rows.forEach((other, index) => {
			if (index === at || !meets(row, other)) return;
			// The subject twice under one name counts once, and not at all where a later binding replaces an earlier.
			if (isSubject(other.origin) && (index < at || (rebinds(row) && rebinds(other)))) return;
			out.set(`${other.name}\n${JSON.stringify(other.origin)}`, other);
		});
	});
	return out;
}

/** What moved at one landing: rows of other origins, and new clashes of the subject. */
function movesAt(rows: LandingRows, isSubject: (origin: ExportOrigin) => boolean): ExposureMove[] {
	const { landing } = rows;
	const others = (list: readonly TracedExport[]) =>
		list.filter((row): row is TracedExport & { name: string } => row.name !== null && !isSubject(row.origin));
	const was = new Set(others(rows.before).map((row) => rowKey(row)));
	const now = new Set(others(rows.after).map((row) => rowKey(row)));
	const moved = new Map<string, TracedExport>();
	for (const row of others(rows.before)) if (!now.has(rowKey(row)) && !moved.has(row.name)) moved.set(row.name, row);
	for (const row of others(rows.after)) if (!was.has(rowKey(row)) && !moved.has(row.name)) moved.set(row.name, row);
	const moves: ExposureMove[] = [...moved].map(([name, row]) => ({ landing, name, kind: "rebinds", row }));
	const before = clashesIn(rows.before, isSubject);
	for (const [key, row] of clashesIn(rows.after, isSubject)) {
		if (!before.has(key) && row.name !== null) moves.push({ landing, name: row.name, kind: "clashes", row });
	}
	return moves;
}

/** Landings reading this one: every export forwarding from an import that lands here. */
function downstream(landing: Landing, reads: DiffReads): Landing[] {
	const out: Landing[] = [];
	for (const edge of reads.importEdgesLandingOn(landing)) {
		for (const each of reads.exportsIn(edge.module)) {
			if (each.target.kind !== "import" || !sameRange(each.target.span, edge.span)) continue;
			if (each.scopeId === undefined) out.push({ kind: "module", module: edge.module });
			else out.push(...reads.scopesOf(edge.module).filter((scope) => scope.scopeId === each.scopeId));
		}
	}
	return out;
}

/**
 * Reads `starts` on both sides, then every landing forwarding from one whose rows moved. Both sides
 * call the renamed declaration by one id, which `isSubject` names.
 */
export function exposureDiff(request: {
	before: DiffReads;
	after: DiffReads;
	starts: readonly Landing[];
	isSubject: (origin: ExportOrigin) => boolean;
}): ExposureDiff {
	const before = exportTracer(request.before);
	const after = exportTracer(request.after);
	const read = new Map<string, LandingRows>();
	const moved = new Set<string>();
	const moves: ExposureMove[] = [];
	const queue = [...request.starts];
	for (let landing = queue.shift(); landing !== undefined; landing = queue.shift()) {
		const key = landingKey(landing);
		if (read.has(key)) continue;
		const rows = { landing, before: before.landing(landing), after: after.landing(landing) };
		read.set(key, rows);
		const was = new Set(rows.before.map((row) => rowKey(row)));
		const now = new Set(rows.after.map((row) => rowKey(row)));
		if (was.size === now.size && [...now].every((each) => was.has(each))) continue;
		moved.add(key);
		moves.push(...movesAt(rows, request.isSubject));
		queue.push(...downstream(landing, request.before), ...downstream(landing, request.after));
	}
	return { moves, read, moved };
}
