// Knowledge notes: one per symbol. Owns what a write must carry, where its refs point, what moved
// since, and whose words an agent may replace.

import {
	chainOf,
	findRefs,
	formatRef,
	isLocalSymbol,
	moduleOf,
	NOT_APPLICABLE,
	NOTE_FIELDS,
	type Note,
	type NoteAuthor,
	NoteAuthorSchema,
	type NoteBacklinks,
	type NoteField,
	type NoteLink,
	type NoteOutcome,
	type NoteProposal,
	type NoteRefProblem,
	parseRef,
	type RefCandidate,
	type SearchRefs,
	walkChain,
} from "@nyaa-lexicon/protocol";
import { type Clock, systemClock } from "./clock.js";
import {
	MODULE_TARGET,
	type NoteFieldValues,
	type NoteLinkRow,
	type NoteProposalRow,
	type NoteRow,
} from "./noteRows.js";
import { ReadContext } from "./readContext.js";
import * as refusal from "./refusals.js";
import type { IndexStore } from "./store.js";

////////////////////////////////
//  Interfaces & Types

/** Every field as the writer sent it: text, or `n/a`. */
export interface NoteWrite {
	symbolId: string;
	summary: string;
	description: string;
	why: string;
	gotchas: string;
	/** 0 when no note stands. */
	expectedRevision: number;
	author?: NoteAuthor | undefined;
}

type Refused = Extract<NoteOutcome, { outcome: "refused" }>;

/** The wire shape with its reason slot narrowed to the catalog's brand. */
export type LedgerNoteOutcome = Exclude<NoteOutcome, Refused> | (Omit<Refused, "reason"> & { reason: refusal.Refusal });

/** A ref that resolved, not yet claimed. */
interface ResolvedRef {
	field: NoteField;
	written: string;
	target: { kind: "symbol"; symbolId: string } | { kind: "module"; module: string };
}

type Checked<T> = { ok: true; value: T } | { ok: false; outcome: LedgerNoteOutcome };

////////////////////////////////
//  Constants

const SUMMARY_MAX = 300;
const FIELD_MAX = 16_000;
const BACKLINKS_SHOWN = 50;
const CANDIDATES_SHOWN = 8;
const REFS_SHOWN = 30;
const FILES_SHOWN = 8;
/** Rows a search reads at most while skipping locals. */
const SEARCH_SCANNED = 2000;

////////////////////////////////
//  Functions & Helpers

function refused(reason: refusal.Refusal, extra: Partial<Omit<Refused, "outcome" | "reason">> = {}): LedgerNoteOutcome {
	return { outcome: "refused", reason, ...extra };
}

function authorText(author: NoteAuthor | null | undefined): string | null {
	return author === null || author === undefined ? null : JSON.stringify(author);
}

function authorOf(text: string | null): NoteAuthor | null {
	if (text === null) return null;
	try {
		const parsed = NoteAuthorSchema.safeParse(JSON.parse(text));
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}

function isPerson(author: NoteAuthor | null | undefined): boolean {
	return author?.kind === "person";
}

/** A person wrote or vouched for the standing revision. */
function heldByPerson(row: NoteRow): boolean {
	return isPerson(authorOf(row.editedBy)) || isPerson(authorOf(row.confirmedBy));
}

function allEmpty(values: NoteFieldValues): boolean {
	return NOTE_FIELDS.every((field) => values[field] === null);
}

/** Each ref at its target's current address, rewritten from the end so indices hold. */
function rewriteRefs(text: string, current: ReadonlyMap<string, string>): string {
	let out = text;
	for (const found of findRefs(text).reverse()) {
		const next = current.get(found.ref);
		if (next === undefined || next === found.ref) continue;
		out = out.slice(0, found.index) + next + out.slice(found.index + found.ref.length);
	}
	return out;
}

////////////////////////////////
//  Class

export class NoteLedger {
	constructor(
		private readonly store: IndexStore,
		private readonly clock: Clock = systemClock,
	) {}

	read(symbolId: string): Note | null {
		const row = this.store.notes.byAddress(symbolId);
		return row === null ? null : this.render(row);
	}

	/** An agent's write over a note a person holds becomes a proposal; every `n/a` removes the note. */
	write(request: NoteWrite): LedgerNoteOutcome {
		const values = this.fieldValues(request);
		if (!values.ok) return values.outcome;

		const declaration = this.store.declaration(request.symbolId);
		if (declaration === null) return refused(refusal.subjectRefused(request.symbolId, this.store));
		if (new ReadContext(this.store).questionsOf(declaration).length === 0) {
			return refused(refusal.noteNotApplicable(declaration.kind));
		}

		const row = this.store.notes.byAddress(request.symbolId);
		const revision = row?.revision ?? 0;
		if (request.expectedRevision !== revision) {
			return refused(refusal.noteRevisionMoved(request.expectedRevision, revision), {
				current: row === null ? null : this.render(row),
			});
		}

		const refs = this.resolveRefs(values.value);
		if (!refs.ok) return refs.outcome;

		const writer = request.author ?? null;
		const now = this.clock.now();
		return this.store.noteWrite(() => {
			if (row !== null && heldByPerson(row) && !isPerson(writer)) {
				this.store.notes.propose(
					row.subjectId,
					{ ...values.value, baseRevision: row.revision, proposedBy: authorText(writer), proposedAt: now },
					this.claimLinks(refs.value, now),
				);
				return {
					outcome: "proposed",
					note: this.render(this.store.notes.byAddress(request.symbolId) as NoteRow),
				};
			}
			if (allEmpty(values.value)) {
				if (row !== null) this.store.notes.remove(row.subjectId);
				return { outcome: "saved", note: null };
			}

			// The declaration resolved above, so the claim lands.
			const subject = this.store.subjects.claim(request.symbolId, now);
			if (subject === null) return refused(refusal.subjectRefused(request.symbolId, this.store));
			this.store.notes.save(
				subject.subjectId,
				{
					...values.value,
					recordedAs: request.symbolId,
					revision: revision + 1,
					author: row === null ? authorText(writer) : row.author,
					authoredAt: row === null ? now : row.authoredAt,
					editedBy: authorText(writer),
					editedAt: now,
					confirmedBy: null,
					confirmedAt: null,
					sourceDigest: subject.lastDigest,
					doubtBy: null,
					doubtReason: null,
					doubtAt: null,
				},
				this.claimLinks(refs.value, now),
			);
			// A person's own revision supersedes what an agent proposed against the last one.
			if (isPerson(writer)) this.store.notes.dropProposal(subject.subjectId);
			return { outcome: "saved", note: this.render(this.store.notes.byAddress(request.symbolId) as NoteRow) };
		});
	}

	/** Vouches for the standing revision as it reads now: source and refs seen, doubt cleared. */
	confirm(symbolId: string, expectedRevision: number, author?: NoteAuthor): LedgerNoteOutcome {
		const row = this.store.notes.byAddress(symbolId);
		if (row === null) return refused(refusal.noNoteStands(symbolId));
		if (row.revision !== expectedRevision) {
			return refused(refusal.noteRevisionMoved(expectedRevision, row.revision), { current: this.render(row) });
		}
		const now = this.clock.now();
		return this.store.noteWrite(() => {
			const links = this.store.notes.links(row.subjectId).map((link) => ({
				...link,
				targetDigest: link.target.startsWith(MODULE_TARGET) ? null : this.store.notes.digestOf(link.target),
			}));
			this.store.notes.confirm(row.subjectId, authorText(author), now, row.lastDigest, links);
			return { outcome: "saved", note: this.render(this.store.notes.byAddress(symbolId) as NoteRow) };
		});
	}

	/** Someone was misled by this revision. The next save or confirm clears it. */
	doubt(symbolId: string, reason: string, expectedRevision: number, author?: NoteAuthor): LedgerNoteOutcome {
		if (reason.trim() === "") return refused(refusal.doubtNeedsReason());
		const row = this.store.notes.byAddress(symbolId);
		if (row === null) return refused(refusal.noNoteStands(symbolId));
		if (row.revision !== expectedRevision) {
			return refused(refusal.noteRevisionMoved(expectedRevision, row.revision), { current: this.render(row) });
		}
		return this.store.noteWrite(() => {
			this.store.notes.doubt(row.subjectId, authorText(author), reason.trim(), this.clock.now());
			return { outcome: "saved", note: this.render(this.store.notes.byAddress(symbolId) as NoteRow) };
		});
	}

	/** Accepting makes the proposal the next revision, vouched for by whoever accepted it. */
	resolveProposal(
		symbolId: string,
		accept: boolean,
		expectedRevision: number,
		author?: NoteAuthor,
	): LedgerNoteOutcome {
		const row = this.store.notes.byAddress(symbolId);
		if (row === null) return refused(refusal.noNoteStands(symbolId));
		const proposal = this.store.notes.proposal(row.subjectId);
		if (proposal === null) return refused(refusal.noProposalStands(symbolId));
		if (row.revision !== expectedRevision || proposal.baseRevision !== row.revision) {
			return refused(refusal.noteRevisionMoved(expectedRevision, row.revision), { current: this.render(row) });
		}
		if (!accept) {
			return this.store.noteWrite(() => {
				this.store.notes.dropProposal(row.subjectId);
				return { outcome: "saved", note: this.render(this.store.notes.byAddress(symbolId) as NoteRow) };
			});
		}

		// The proposal's refs as its targets stand now, so a rename since resolves to the same symbol.
		const shown = this.proposalOf(proposal, row.subjectId);
		const gone = shown.links.filter((link) => link.state === "broken");
		if (gone.length > 0) {
			return refused(refusal.noteRefsRefused(gone.length), {
				refs: gone.map((link) => ({
					field: link.field,
					ref: link.written,
					problem: refusal.refTargetGone(),
					candidates: [],
				})),
			});
		}
		const values: NoteFieldValues = {
			summary: shown.summary,
			description: shown.description,
			why: shown.why,
			gotchas: shown.gotchas,
		};
		const refs = this.resolveRefs(values);
		if (!refs.ok) return refs.outcome;
		const now = this.clock.now();
		return this.store.noteWrite(() => {
			if (allEmpty(values)) {
				this.store.notes.remove(row.subjectId);
				return { outcome: "saved", note: null };
			}
			this.store.notes.save(
				row.subjectId,
				{
					...values,
					recordedAs: row.symbolId,
					revision: row.revision + 1,
					author: row.author,
					authoredAt: row.authoredAt,
					editedBy: proposal.proposedBy,
					editedAt: now,
					confirmedBy: authorText(author),
					confirmedAt: now,
					sourceDigest: row.lastDigest,
					doubtBy: null,
					doubtReason: null,
					doubtAt: null,
				},
				this.claimLinks(refs.value, now),
			);
			this.store.notes.dropProposal(row.subjectId);
			return { outcome: "saved", note: this.render(this.store.notes.byAddress(symbolId) as NoteRow) };
		});
	}

	/** Declarations by name, then files by path, each with its ref written. Locals are left out. */
	searchRefs(text: string, limit = REFS_SHOWN): SearchRefs {
		const needle = text.trim();
		if (needle === "") return { results: [] };
		const results: RefCandidate[] = [];
		const context = new ReadContext(this.store);
		// Locals are skipped after the read, so pages continue until enough others are found.
		const page = limit * 2;
		for (let offset = 0; results.length < limit && offset < SEARCH_SCANNED; offset += page) {
			const rows = this.store.symbolsNamedLike(needle, Math.min(page, SEARCH_SCANNED - offset), offset);
			for (const row of rows) {
				if (results.length >= limit) break;
				if (isLocalSymbol(row.symbolId)) continue;
				const segments = chainOf(context.heldIn(row.module), row.symbolId);
				if (segments === null) continue;
				results.push({
					ref: formatRef(row.module, segments),
					name: row.name,
					kind: row.kind,
					module: row.module,
					container: segments.slice(0, -1),
					symbolId: row.symbolId,
				});
			}
			if (rows.length < page) break;
		}
		for (const module of this.store.filesNamedLike(needle, FILES_SHOWN)) {
			const name = module.slice(module.lastIndexOf("/") + 1);
			results.push({ ref: formatRef(module, []), name, kind: "file", module, container: [] });
		}
		return { results };
	}

	/** Notes whose refs name a symbol, or a file when `symbolId` is a module path. */
	backlinks(symbolId: string, limit = BACKLINKS_SHOWN): NoteBacklinks {
		const subject = this.store.subjects.forAddress(symbolId);
		if (subject !== null) return this.store.notes.backlinks(subject.subjectId, limit);
		if (this.store.depthOf(symbolId) !== null) return this.store.notes.backlinks(MODULE_TARGET + symbolId, limit);
		return { notes: [], total: 0 };
	}

	////////////////////////////////
	//  Validation

	private fieldValues(request: NoteWrite): Checked<NoteFieldValues> {
		const values: Partial<NoteFieldValues> = {};
		const empty: NoteField[] = [];
		for (const field of NOTE_FIELDS) {
			const trimmed = request[field].trim();
			if (trimmed === "") empty.push(field);
			else values[field] = trimmed.toLowerCase() === NOT_APPLICABLE ? null : trimmed;
		}
		if (empty.length > 0) return { ok: false, outcome: refused(refusal.noteFieldsEmpty(empty)) };

		const summary = values.summary ?? null;
		if (summary !== null && /[\r\n]/.test(summary)) {
			return { ok: false, outcome: refused(refusal.noteSummaryOneLine()) };
		}
		for (const field of NOTE_FIELDS) {
			const text = values[field] ?? null;
			const max = field === "summary" ? SUMMARY_MAX : FIELD_MAX;
			if (text !== null && text.length > max) {
				return { ok: false, outcome: refused(refusal.noteFieldTooLong(field, max, text.length)) };
			}
		}
		return { ok: true, value: values as NoteFieldValues };
	}

	/** Every ref in every field must name one indexed declaration or file. */
	private resolveRefs(values: NoteFieldValues): Checked<ResolvedRef[]> {
		const resolved: ResolvedRef[] = [];
		const problems: NoteRefProblem[] = [];
		const context = new ReadContext(this.store);
		for (const field of NOTE_FIELDS) {
			const text = values[field];
			if (text === null) continue;
			for (const { ref } of findRefs(text)) {
				const found = this.resolveRef(ref, context);
				if (found.ok) resolved.push({ field, written: ref, target: found.target });
				else problems.push({ field, ref, problem: found.problem, candidates: found.candidates });
			}
		}
		if (problems.length > 0) {
			return { ok: false, outcome: refused(refusal.noteRefsRefused(problems.length), { refs: problems }) };
		}
		return { ok: true, value: resolved };
	}

	private resolveRef(
		ref: string,
		context: ReadContext,
	): { ok: true; target: ResolvedRef["target"] } | { ok: false; problem: string; candidates: string[] } {
		const parsed = parseRef(ref);
		if (!parsed.ok) return { ok: false, problem: parsed.problem, candidates: [] };
		const { module, segments } = parsed.ref;
		if (this.store.depthOf(module) === null) {
			return { ok: false, problem: refusal.refModuleNotIndexed(module), candidates: [] };
		}
		if (segments.length === 0) return { ok: true, target: { kind: "module", module } };

		const walk = walkChain(context.heldIn(module), segments);
		switch (walk.kind) {
			case "exact":
				if (walk.candidate.selectionRange === undefined) {
					return { ok: false, problem: refusal.refNamesArguments(), candidates: [] };
				}
				return { ok: true, target: { kind: "symbol", symbolId: walk.candidate.symbolId } };
			case "ambiguous":
				return {
					ok: false,
					problem: refusal.refAmbiguous(walk.candidates.length),
					candidates: walk.candidates
						.slice(0, CANDIDATES_SHOWN)
						.map((candidate) => formatRef(module, candidate.segments)),
				};
			case "none": {
				// Names beneath each path the walk stood on, each as the chain that names it alone.
				const held = context.heldIn(module);
				const paths = walk.matched.containerPaths.length === 0 ? [[]] : walk.matched.containerPaths;
				const candidates = new Set<string>();
				for (const path of paths) {
					for (const name of walk.available) {
						const tried = walkChain(held, [...path, name]);
						const found =
							tried.kind === "exact"
								? [tried.candidate]
								: tried.kind === "ambiguous"
									? tried.candidates
									: [];
						for (const each of found) candidates.add(formatRef(module, each.segments));
					}
				}
				return {
					ok: false,
					problem: refusal.refNamesNothing(module),
					candidates: [...candidates].slice(0, CANDIDATES_SHOWN),
				};
			}
		}
	}

	/** Claims each target's subject, so a ref follows its symbol through renames and moves. */
	private claimLinks(refs: readonly ResolvedRef[], now: number): NoteLinkRow[] {
		return refs.map((ref) => {
			if (ref.target.kind === "module") {
				return {
					field: ref.field,
					written: ref.written,
					target: MODULE_TARGET + ref.target.module,
					targetDigest: null,
				};
			}
			const subject = this.store.subjects.claim(ref.target.symbolId, now);
			return {
				field: ref.field,
				written: ref.written,
				target: subject?.subjectId ?? MODULE_TARGET,
				targetDigest: subject?.lastDigest ?? null,
			};
		});
	}

	////////////////////////////////
	//  Rendering

	/** Each field with its refs at their targets' current addresses. */
	private shown(values: NoteFieldValues, rows: readonly NoteLinkRow[]): NoteFieldValues & { links: NoteLink[] } {
		const context = new ReadContext(this.store);
		const links = rows.map((link) => this.linkNow(link, context));
		const text = (field: NoteField) => {
			const value = values[field];
			const current = new Map(
				links.filter((link) => link.field === field).map((link) => [link.written, link.current]),
			);
			return value === null ? null : rewriteRefs(value, current);
		};
		return {
			summary: text("summary"),
			description: text("description"),
			why: text("why"),
			gotchas: text("gotchas"),
			links,
		};
	}

	private render(row: NoteRow): Note {
		const shown = this.shown(row, this.store.notes.links(row.subjectId));
		const proposal = this.store.notes.proposal(row.subjectId);
		return {
			symbolId: row.symbolId,
			recordedAs: row.recordedAs,
			revision: row.revision,
			summary: shown.summary,
			description: shown.description,
			why: shown.why,
			gotchas: shown.gotchas,
			author: authorOf(row.author),
			authoredAt: row.authoredAt,
			editedBy: authorOf(row.editedBy),
			editedAt: row.editedAt,
			confirmedBy: authorOf(row.confirmedBy),
			confirmedAt: row.confirmedAt,
			doubt:
				row.doubtReason === null || row.doubtAt === null
					? null
					: { by: authorOf(row.doubtBy), reason: row.doubtReason, at: row.doubtAt },
			sourceChanged: row.sourceDigest !== row.lastDigest,
			links: shown.links,
			proposal: proposal === null ? null : this.proposalOf(proposal, row.subjectId),
		};
	}

	private proposalOf(proposal: NoteProposalRow, subjectId: string): NoteProposal {
		return {
			...this.shown(proposal, this.store.notes.proposalLinks(subjectId)),
			baseRevision: proposal.baseRevision,
			by: authorOf(proposal.proposedBy),
			at: proposal.proposedAt,
		};
	}

	/** A link at its target's current address, or broken where the target is gone. */
	private linkNow(link: NoteLinkRow, context: ReadContext): NoteLink {
		const broken: NoteLink = { field: link.field, written: link.written, current: link.written, state: "broken" };
		if (link.target.startsWith(MODULE_TARGET)) {
			const module = link.target.slice(MODULE_TARGET.length);
			return module !== "" && this.store.depthOf(module) !== null
				? { ...broken, kind: "file", state: "ok" }
				: broken;
		}
		const at = this.store.notes.subjectAt(link.target);
		if (at === null || at.state !== "bound") return broken;
		const module = moduleOf(at.symbolId);
		const declarations = module === null ? [] : context.heldIn(module);
		const segments = chainOf(declarations, at.symbolId);
		const declaration = declarations.find((row) => row.symbolId === at.symbolId);
		if (module === null || segments === null || declaration === undefined) return broken;
		return {
			field: link.field,
			written: link.written,
			current: formatRef(module, segments),
			symbolId: at.symbolId,
			kind: declaration.kind,
			state: this.store.notes.digestOf(link.target) === link.targetDigest ? "ok" : "changed",
		};
	}
}
