// The candidate proof. Before a rename writes, each provider reads every proposed text it owns as one
// view and answers facts for the modules the rename reaches; those facts must bind as the plan said.

import {
	coordinatesOf,
	type FileFacts,
	hashContent,
	type ImportResolution,
	type Landing,
	type Position,
	type ProbeBatchRequest,
	type RenameSite,
	type TextEdit,
	UnknownReasonSchema,
} from "@nyaa-lexicon/protocol";
import { type EffectiveExport, type ExportOrigin, exportTracer, landingKey } from "./exportProjection.js";
import { rowKey } from "./exposureDiff.js";
import type { ProviderProbe } from "./providerProbe.js";
import type { RenameBlocker } from "./refusalSlots.js";
import { bindingsMoved, proofUnavailable } from "./refusals.js";
import type { IndexStore, StoredReference } from "./store.js";

////////////////////////////////
//  Interfaces & Types

export interface RenameCandidate {
	/** Each edited module's text before and after, with the edits between. */
	proposed: Array<{ module: string; before: string; text: string; edits: readonly TextEdit[] }>;
	/** Modules the proof reads again: edited, on routes, importing moved landings, or bound to an old id. */
	affected: readonly string[];
	/** Each old id to its new id, re-minted members included. */
	idMap: ReadonlyMap<string, string>;
	/** The renamed declaration's old id. */
	subject: string;
	/** Each module's planned sites, before the edits. */
	sites: ReadonlyMap<string, readonly RenameSite[]>;
	/** What each landing the rename reaches must expose after writing, under old ids. */
	projected: ReadonlyArray<{ landing: Landing; rows: readonly EffectiveExport[] }>;
}

/** One provider's batch: the texts it reads and the modules it answers. */
interface Batch {
	files: ProbeBatchRequest["files"];
	answer: string[];
}

/** A module's answered facts, with where each of its specifiers landed in the same view. */
interface Answered {
	providerId: string;
	facts: FileFacts;
	resolutions: Map<string, ImportResolution>;
}

/** The index before the overlay: answered modules' uses, edited modules' declarations. */
interface Held {
	references: Map<string, StoredReference[]>;
	declarations: Map<string, Array<{ symbolId: string; line: number }>>;
}

/** Positions across one module's edits. */
interface Edited {
	/** Where a position before the edits stands after them; null inside text an edit replaced. */
	shift(at: Position): Position | null;
	/** Whether a position after the edits lies in text an edit wrote. */
	written(at: Position): boolean;
	/** Whether an after position lies in the text replacing what began at `at`; null where no edit began. */
	writtenFrom(at: Position): ((after: Position) => boolean) | null;
}

type Site = { module: string; line: number };

////////////////////////////////
//  Constants

/** Sites a failed proof names before the list stops helping. */
const SITES_SHOWN = 20;

const REASONS: ReadonlySet<string> = new Set(UnknownReasonSchema.options);

////////////////////////////////
//  Functions & Helpers

function positionKey(line: number, character: number): string {
	return `${line}:${character}`;
}

/** How a stored use binds: to an id, ambiguously, or not at all for a reason. */
function bindingOf(reference: StoredReference, mapped: (id: string) => string = (id) => id): string {
	if (reference.targetId !== null) return `bound ${mapped(reference.targetId)}`;
	return REASONS.has(reference.provenance) ? `unbound ${reference.provenance}` : "ambiguous";
}

/** Positions across `edits`, or null when one addresses no text. */
function editedOf(before: string, after: string, edits: readonly TextEdit[]): Edited | null {
	const from = coordinatesOf(before);
	const to = coordinatesOf(after);
	const spans: Array<{ start: number; end: number; delta: number; length: number }> = [];
	for (const edit of edits) {
		const range = from.offsetsForRange(edit.range);
		if (range === undefined) return null;
		spans.push({ ...range, delta: edit.newText.length - (range.end - range.start), length: edit.newText.length });
	}
	spans.sort((left, right) => left.start - right.start);
	const written: Array<{ from: number; start: number; end: number }> = [];
	let moved = 0;
	for (const span of spans) {
		written.push({ from: span.start, start: span.start + moved, end: span.start + moved + span.length });
		moved += span.delta;
	}
	const inside = (span: { start: number; end: number }, at: Position) => {
		const offset = to.offsetAt(at);
		return offset !== undefined && offset >= span.start && offset < span.end;
	};
	return {
		shift(at) {
			const offset = from.offsetAt(at);
			if (offset === undefined) return null;
			let shift = 0;
			for (const span of spans) {
				if (span.start > offset) break;
				// Text an edit inserts at a token's start moves the token; text it replaces holds no old position.
				if (span.end <= offset && (span.start < offset || span.end === span.start)) shift += span.delta;
				else if (span.start < offset) return null;
			}
			return to.positionAt(offset + shift) ?? null;
		},
		written(at) {
			return written.some((span) => inside(span, at));
		},
		writtenFrom(at) {
			const offset = from.offsetAt(at);
			const span = written.find((each) => each.from === offset && each.end > each.start);
			return span === undefined ? null : (after) => inside(span, after);
		},
	};
}

/** Each provider's batch, or the module no provider owns. */
function batches(probe: ProviderProbe, candidate: RenameCandidate): Map<string, Batch> | { unowned: string } {
	const byProvider = new Map<string, Batch>();
	const batchOf = (module: string): Batch | null => {
		const owner = probe.owner(module);
		if (!owner.owned) return null;
		const held = byProvider.get(owner.providerId) ?? { files: [], answer: [] };
		byProvider.set(owner.providerId, held);
		return held;
	};
	for (const { module, text } of candidate.proposed) {
		const batch = batchOf(module);
		if (batch === null) return { unowned: module };
		batch.files.push({ module, contentHash: hashContent(text), text });
	}
	for (const module of new Set(candidate.affected)) {
		const batch = batchOf(module);
		if (batch === null) return { unowned: module };
		batch.answer.push(module);
	}
	return byProvider;
}

/** Every batch's answer, or the refusal of the first provider that cannot prove its share. */
async function answersOf(
	probe: ProviderProbe,
	byProvider: Map<string, Batch>,
): Promise<Answered[] | { refused: string; module: string }> {
	const answered: Answered[] = [];
	for (const [providerId, batch] of byProvider) {
		const [first] = batch.answer;
		if (first === undefined) continue;
		if (batch.files.length === 0)
			return { refused: `${providerId} reads none of the proposed text`, module: first };
		const response = await probe
			.probeBatch(first, batch)
			.catch((error: unknown) => ({ status: "unsupported" as const, detail: String(error) }));
		if (response.status === "unsupported")
			return { refused: response.detail ?? `${providerId} cannot prove it`, module: first };
		for (const module of batch.answer) {
			const facts = response.facts.filter((each) => each.module === module);
			const [only] = facts;
			if (only === undefined || facts.length > 1)
				return { refused: `${providerId} answered no single set of facts`, module };
			const resolutions = new Map(
				response.landings
					.filter((each) => each.module === module)
					.map((each) => [each.specifier, each.resolution] as const),
			);
			answered.push({ providerId, facts: only, resolutions });
		}
	}
	return answered;
}

/**
 * Proves a rename before it writes: providers answer the reached modules with every proposed text in
 * view, and those answers stand in for the stored facts inside a speculation. Every use must bind as
 * the plan said, every edited module must declare what it did under the new ids, and every landing
 * must expose what the plan projected. Empty when proved.
 */
export async function proveRename(
	store: IndexStore,
	probe: ProviderProbe,
	candidate: RenameCandidate,
): Promise<RenameBlocker[]> {
	const byProvider = batches(probe, candidate);
	if ("unowned" in byProvider) {
		const site = { module: byProvider.unowned, line: 1 };
		return [{ kind: "ProofUnavailable", detail: proofUnavailable("no provider owns it"), sites: [site] }];
	}
	const answered = await answersOf(probe, byProvider);
	if ("refused" in answered) {
		const site = { module: answered.module, line: 1 };
		return [{ kind: "ProofUnavailable", detail: proofUnavailable(answered.refused), sites: [site] }];
	}
	const held: Held = {
		references: new Map(answered.map(({ facts }) => [facts.module, store.referencesIn(facts.module)] as const)),
		declarations: new Map(
			candidate.proposed.map(({ module }) => [
				module,
				store.declarationsIn(module).map((each) => ({
					symbolId: each.symbolId,
					line: (each.selectionRange ?? each.range).start.line + 1,
				})),
			]),
		),
	};
	try {
		return overlaid(store, candidate, answered, held);
	} catch (error) {
		const why = `the index refused a provider's answer: ${error instanceof Error ? error.message : String(error)}`;
		return [{ kind: "ProofUnavailable", detail: proofUnavailable(why) }];
	}
}

/** The answers in place of the stored facts, inside a speculation; whatever moved from the plan. */
function overlaid(
	store: IndexStore,
	candidate: RenameCandidate,
	answered: readonly Answered[],
	held: Held,
): RenameBlocker[] {
	const overlay = answered.map(({ providerId, facts, resolutions }) => ({
		module: facts.module,
		contentHash: facts.contentHash,
		declarations: facts.declarations,
		references: facts.references,
		imports: facts.imports,
		provider: providerId,
		resolutions,
		exports: facts.exports,
		allList: facts.allList,
		scopeContributions: facts.scopeContributions,
	}));
	return store.readOverlaid(overlay, (moved) => {
		const sites = [...usesMoved(store, candidate, held), ...declarationsMoved(store, candidate, held)];
		sites.push(...exposuresMoved(store, candidate, moved));
		if (sites.length === 0) return [];
		return [{ kind: "ProofUnavailable", detail: bindingsMoved(sites.length), sites: sites.slice(0, SITES_SHOWN) }];
	});
}

/** Each use after the rename: a site binds the renamed id or stays as it was; others keep their binding, ids mapped. */
function usesMoved(store: IndexStore, candidate: RenameCandidate, held: Held): Site[] {
	const mapped = (id: string) => candidate.idMap.get(id) ?? id;
	const renamed = mapped(candidate.subject);
	const fresh = new Set(candidate.idMap.values());
	const moved: Site[] = [];
	for (const [module, was] of held.references) {
		const text = candidate.proposed.find((each) => each.module === module);
		const edited = text === undefined ? null : editedOf(text.before, text.text, text.edits);
		if (text !== undefined && edited === null) {
			moved.push({ module, line: 1 });
			continue;
		}
		const planned = new Set(
			(candidate.sites.get(module) ?? []).map((site) =>
				positionKey(site.range.start.line, site.range.start.character),
			),
		);
		const now = store.referencesIn(module);
		// A compound assignment reads and writes at one position.
		const atStart = new Map<string, StoredReference[]>();
		for (const each of now) {
			const key = positionKey(each.startLine, each.startCharacter);
			atStart.set(key, [...(atStart.get(key) ?? []), each]);
		}
		const matched = new Set<StoredReference>();
		for (const before of was) {
			const start = { line: before.startLine, character: before.startCharacter };
			const site = planned.has(positionKey(start.line, start.character));
			// An expanded site moves its use, as `{ parse }` to `{ parse: load }`.
			const within = site ? (edited?.writtenFrom(start) ?? null) : null;
			const at = edited === null ? start : edited.shift(start);
			const exact = at === null ? [] : (atStart.get(positionKey(at.line, at.character)) ?? []);
			// Same role only: a write cannot vouch for a captured read.
			const candidates = (
				within === null
					? exact
					: now.filter((each) => within({ line: each.startLine, character: each.startCharacter }))
			).filter((each) => each.role === before.role);
			const [first] = candidates;
			if (first === undefined) {
				moved.push({ module, line: before.startLine + 1 });
				continue;
			}
			for (const each of candidates) matched.add(each);
			const held = bindingOf(before, mapped);
			const keeps = candidates.some((each) => {
				const binds = bindingOf(each);
				return binds === held || (site && binds === `bound ${renamed}`);
			});
			if (!keeps) moved.push({ module, line: first.startLine + 1 });
		}
		for (const after of now) {
			if (matched.has(after)) continue;
			// A written token, such as a kept alias, binds a renamed id or nothing.
			const written = edited?.written({ line: after.startLine, character: after.startCharacter }) === true;
			if (!written || (after.targetId !== null && !fresh.has(after.targetId)))
				moved.push({ module, line: after.startLine + 1 });
		}
	}
	return moved;
}

/** Each edited module declares what it did, ids mapped; a lone renamed overload fails here. */
function declarationsMoved(store: IndexStore, candidate: RenameCandidate, held: Held): Site[] {
	const moved: Site[] = [];
	for (const [module, was] of held.declarations) {
		const want = new Map(was.map((each) => [candidate.idMap.get(each.symbolId) ?? each.symbolId, each.line]));
		const have = store.declarationsIn(module);
		const ids = new Set(have.map((each) => each.symbolId));
		for (const [symbolId, line] of want) if (!ids.has(symbolId)) moved.push({ module, line });
		for (const each of have) {
			if (!want.has(each.symbolId))
				moved.push({ module, line: (each.selectionRange ?? each.range).start.line + 1 });
		}
	}
	return moved;
}

/** Each projected landing exposes what the plan read, ids mapped; an export moving off the plan's reach fails. */
function exposuresMoved(store: IndexStore, candidate: RenameCandidate, moved: readonly string[]): Site[] {
	const tracer = exportTracer(store);
	const origin = (each: ExportOrigin): ExportOrigin =>
		each.kind === "symbol"
			? { kind: "symbol", symbolId: candidate.idMap.get(each.symbolId) ?? each.symbolId }
			: each;
	const where = (landing: Landing) => (landing.kind === "module" ? landing.module : landing.scopeId);
	const sites: Site[] = [];
	const projected = new Set<string>();
	for (const { landing, rows } of candidate.projected) {
		projected.add(landingKey(landing));
		const want = new Set(rows.map((row) => rowKey(row, origin(row.origin))));
		const have = new Set(tracer.landing(landing).map((row) => rowKey(row)));
		if (want.size !== have.size || [...have].some((each) => !want.has(each)))
			sites.push({ module: where(landing), line: 1 });
	}
	for (const module of moved) {
		if (!projected.has(landingKey({ kind: "module", module }))) sites.push({ module, line: 1 });
	}
	return sites;
}
