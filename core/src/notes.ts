// Knowledge notes: one per subject, addressed by its current symbol id.

import {
	chainOf,
	findRefs,
	formatRef,
	isLocalSymbol,
	moduleOf,
	NOTE_MAX,
	type Note,
	type NoteAuthor,
	type NoteBacklinks,
	type NoteLink,
	type NoteOutcome,
	parseRef,
	type RefCandidate,
	type SearchRefs,
	walkChain,
} from "@nyaa-lexicon/protocol";
import { authorOf, authorText } from "./authors.js";
import { type Clock, systemClock } from "./clock.js";
import { MODULE_TARGET, type NoteLinkRow, type NoteRow } from "./noteRows.js";
import { noteOpening, type OpeningBlock } from "./noteText.js";
import { ReadContext } from "./readContext.js";
import type { NoteRefProblem } from "./refusalSlots.js";
import * as refusal from "./refusals.js";
import type { IndexStore } from "./store.js";

////////////////////////////////
//  Interfaces & Types

/** Empty text removes the note. */
export interface NoteWrite {
	symbolId: string;
	text: string;
	/** 0 when no note stands. */
	expectedRevision: number;
	author?: NoteAuthor | undefined;
}

type Refused = Extract<NoteOutcome, { outcome: "refused" }>;

/** The wire shape with its reason slot narrowed to the catalog's brand. */
type LedgerRefused = Omit<Refused, "reason" | "refs"> & {
	reason: refusal.Refusal;
	refs?: NoteRefProblem[] | undefined;
};

export type LedgerNoteOutcome = Exclude<NoteOutcome, Refused> | LedgerRefused;

/** A ref that resolved, not yet claimed. */
type ResolvedTarget = { kind: "symbol"; symbolId: string } | { kind: "module"; module: string };

type ResolvedRef = { written: string; target: ResolvedTarget } | { written: string; existing: NoteLinkRow };

type NoteModuleState = "indexed" | "withheld" | "unindexed";

type Checked<T> = { ok: true; value: T } | { ok: false; outcome: LedgerNoteOutcome };

////////////////////////////////
//  Constants

/** Opening blocks, as refusals name them. */
const BLOCK_NAMES: Record<OpeningBlock, string> = {
	heading: "heading",
	list: "list",
	quote: "quote",
	code: "code block",
	rule: "rule",
	html: "HTML block",
	definition: "link definition",
	block: "block",
};
const BACKLINKS_SHOWN = 50;
const CANDIDATES_SHOWN = 8;
const REFS_SHOWN = 30;
const FILES_SHOWN = 8;
/** Rows a search reads at most while skipping locals. */
const SEARCH_SCANNED = 2000;

////////////////////////////////
//  Functions & Helpers

function refused(
	reason: refusal.Refusal,
	extra: Partial<Omit<Refused, "outcome" | "reason" | "refs">> & { refs?: NoteRefProblem[] | undefined } = {},
): LedgerNoteOutcome {
	return { outcome: "refused", reason, ...extra };
}

/** Each ref at its target's current address, rewritten from the end so indices hold. */
function rewriteRefs(text: string, current: ReadonlyMap<string, string>, project: string): string {
	const replacements: Array<{ from: number; to: number; value: string }> = [];
	for (const found of findRefs(text, { legacy: true }).reverse()) {
		const written = storedRef(found.ref, project);
		const next = current.get(written) ?? (written === found.ref ? undefined : written);
		if (next === undefined || next === found.ref) continue;
		replacements.push({ from: found.index, to: found.index + found.ref.length, value: next });
	}
	let out = text;
	for (const replacement of replacements.sort((left, right) => right.from - left.from)) {
		out = out.slice(0, replacement.from) + replacement.value + out.slice(replacement.to);
	}
	return out;
}

/** Old note rows are interpreted only while they are read from storage. */
function storedRef(ref: string, project: string): string {
	if (!ref.startsWith("ref://") || ref.includes("#")) return ref;
	const converted = `project-ref://${project}/${ref.slice("ref://".length)}`;
	const parsed = parseRef(converted);
	return parsed.ok ? formatRef(parsed.ref.project, parsed.ref.module, parsed.ref.segments) : ref;
}

////////////////////////////////
//  Class

export class NoteLedger {
	constructor(
		private readonly store: IndexStore,
		private readonly project: string,
		private readonly clock: Clock = systemClock,
		private readonly moduleState?: (module: string) => NoteModuleState,
	) {}

	read(symbolId: string): Note | null {
		const row = this.store.notes.byAddress(symbolId);
		return row === null ? null : this.render(row);
	}

	/** Empty text removes the note. */
	write(request: NoteWrite): LedgerNoteOutcome {
		const text = this.checkedText(request.text);
		if (!text.ok) return text.outcome;

		const declaration = this.store.declaration(request.symbolId);
		if (declaration === null) return refused(refusal.subjectRefused(request.symbolId, this.store));
		if (new ReadContext(this.store).isLocal(declaration)) {
			return refused(refusal.noteNotApplicable(declaration.kind));
		}

		const row = this.store.notes.byAddress(request.symbolId);
		const revision = row?.revision ?? 0;
		if (request.expectedRevision !== revision) {
			return refused(refusal.noteRevisionMoved(request.expectedRevision, revision), {
				current: row === null ? null : this.render(row),
			});
		}

		// Offsets into the text as sent.
		const refs = this.resolveRefs(request.text, row === null ? [] : this.store.notes.links(row.subjectId));
		if (!refs.ok) return refs.outcome;

		const writer = request.author ?? null;
		const now = this.clock.now();
		return this.store.noteWrite(() => {
			if (text.value === "") {
				if (row !== null) this.store.notes.remove(row.subjectId);
				return { outcome: "saved", note: null };
			}

			// The declaration resolved above, so the claim lands.
			const subject = this.store.subjects.claim(request.symbolId, now);
			if (subject === null) return refused(refusal.subjectRefused(request.symbolId, this.store));
			this.store.notes.save(
				subject.subjectId,
				{
					text: text.value,
					recordedAs: request.symbolId,
					revision: revision + 1,
					author: row === null ? authorText(writer) : row.author,
					authoredAt: row === null ? now : row.authoredAt,
					editedBy: authorText(writer),
					editedAt: now,
					sourceDigest: subject.lastDigest,
				},
				this.claimLinks(refs.value, now),
			);
			return { outcome: "saved", note: this.render(this.store.notes.byAddress(request.symbolId) as NoteRow) };
		});
	}

	/** Declarations by name, then files by path, each with its ref written. Locals are left out. */
	searchRefs(text: string, limit = REFS_SHOWN, kinds?: readonly string[]): SearchRefs {
		const needle = text.trim();
		if (needle === "") return { results: [] };
		const results: RefCandidate[] = [];
		const context = new ReadContext(this.store);
		// Locals are skipped after the read, so pages continue until enough others are found.
		const page = limit * 2;
		const symbolKinds = kinds?.filter((kind) => kind !== "file");
		for (let offset = 0; results.length < limit && offset < SEARCH_SCANNED; offset += page) {
			const rows = this.store.symbolsNamedLike(
				needle,
				Math.min(page, SEARCH_SCANNED - offset),
				offset,
				symbolKinds,
			);
			for (const row of rows) {
				if (results.length >= limit) break;
				if (isLocalSymbol(row.symbolId)) continue;
				const segments = chainOf(context.heldIn(row.module), row.symbolId);
				if (segments === null) continue;
				results.push({
					ref: formatRef(this.project, row.module, segments),
					name: row.name,
					kind: row.kind,
					module: row.module,
					container: segments.slice(0, -1),
					symbolId: row.symbolId,
				});
			}
			if (rows.length < page) break;
		}
		const files =
			kinds === undefined || kinds.includes("file") ? this.store.filesNamedLike(needle, FILES_SHOWN) : [];
		for (const module of files) {
			const name = module.slice(module.lastIndexOf("/") + 1);
			results.push({ ref: formatRef(this.project, module, []), name, kind: "file", module, container: [] });
		}
		return { results };
	}

	/** Notes whose refs name a symbol, or a file when `symbolId` is a module path. */
	backlinks(symbolId: string, limit = BACKLINKS_SHOWN): NoteBacklinks {
		const subject = this.store.subjects.forAddress(symbolId);
		let target: string | null;
		if (subject === null) {
			const state = this.moduleStateOf(symbolId);
			target = state === "indexed" || state === "withheld" ? MODULE_TARGET + symbolId : null;
		} else target = subject.subjectId;
		if (target === null) return { notes: [], total: 0 };
		const found = this.store.notes.backlinks(target, limit);
		return {
			notes: found.notes.map((note) => ({
				symbolId: note.symbolId,
				summary: this.backlinkSummary(note.subjectId, note.text),
			})),
			total: found.total,
		};
	}

	/** Only the summary's own refs are read at current addresses. */
	private backlinkSummary(subjectId: string, text: string): string | null {
		const opening = noteOpening(text);
		if (opening.kind !== "paragraph") return null;
		const written = new Set(findRefs(opening.summary, { legacy: true }).map((found) => found.ref));
		if (written.size === 0) return opening.summary;
		const links = this.store.notes.links(subjectId).filter((link) => written.has(link.written));
		return this.shown(opening.summary, links).text;
	}

	////////////////////////////////
	//  Validation

	/** Trimmed; empty removes the note. */
	private checkedText(text: string): Checked<string> {
		const trimmed = text.trim();
		if (trimmed.length > NOTE_MAX) {
			return { ok: false, outcome: refused(refusal.noteTooLong(NOTE_MAX, trimmed.length)) };
		}
		// Untrimmed, so an indented code block still reads as one; trimmed, as it is stored.
		for (const read of [text, trimmed]) {
			const opening = noteOpening(read);
			if (opening.kind !== "paragraph" && opening.kind !== "empty") {
				return { ok: false, outcome: refused(refusal.noteOpensWith(BLOCK_NAMES[opening.kind])) };
			}
		}
		return { ok: true, value: trimmed };
	}

	/** Preserves stored refs; resolves submitted ones. */
	private resolveRefs(text: string, existing: readonly NoteLinkRow[]): Checked<ResolvedRef[]> {
		const resolved: ResolvedRef[] = [];
		const problems: NoteRefProblem[] = [];
		let withheld = 0;
		const context = new ReadContext(this.store);
		const prior = new Map<string, NoteLinkRow>();
		for (const link of existing) {
			prior.set(link.written, link);
			prior.set(storedRef(link.written, this.project), link);
			prior.set(this.linkNow(link, context).current, link);
		}
		for (const { ref, index } of findRefs(text, { legacy: true })) {
			const kept = prior.get(ref) ?? prior.get(storedRef(ref, this.project));
			if (kept !== undefined) {
				resolved.push({ written: ref, existing: kept });
				continue;
			}
			const found = this.resolveRef(ref, context);
			if (found.ok) resolved.push({ written: ref, target: found.target });
			else {
				if (found.withheld === true) withheld++;
				problems.push({ ref, at: index, problem: found.problem, candidates: found.candidates });
			}
		}
		if (problems.length > 0) {
			const reason =
				withheld === 0 ? refusal.noteRefsRefused(problems.length) : refusal.noteRefsWithheld(withheld);
			return { ok: false, outcome: refused(reason, { refs: problems }) };
		}
		return { ok: true, value: resolved };
	}

	private resolveRef(
		ref: string,
		context: ReadContext,
	):
		| { ok: true; target: ResolvedTarget }
		| { ok: false; problem: refusal.Refusal; candidates: string[]; withheld?: boolean } {
		const parsed = parseRef(ref);
		if (!parsed.ok) return { ok: false, problem: refusal.refParseFailed(parsed.problem), candidates: [] };
		const { project, module, segments } = parsed.ref;
		if (project !== this.project) {
			return { ok: false, problem: refusal.refProjectMismatch(project, this.project), candidates: [] };
		}
		const state = this.moduleStateOf(module);
		if (state === "withheld") {
			return { ok: false, problem: refusal.refModuleWithheld(module), candidates: [], withheld: true };
		}
		if (state !== "indexed") {
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
						.map((candidate) => formatRef(this.project, module, candidate.segments)),
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
						for (const each of found) candidates.add(formatRef(this.project, module, each.segments));
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
			if ("existing" in ref) return ref.existing;
			const target = ref.target;
			if (target.kind === "module") {
				return { written: ref.written, target: MODULE_TARGET + target.module, targetDigest: null };
			}
			const subject = this.store.subjects.claim(target.symbolId, now);
			return {
				written: ref.written,
				target: subject?.subjectId ?? MODULE_TARGET,
				targetDigest: subject?.lastDigest ?? null,
			};
		});
	}

	////////////////////////////////
	//  Rendering

	/** The text with its refs at their targets' current addresses. */
	private shown(text: string, rows: readonly NoteLinkRow[]): { text: string; links: NoteLink[] } {
		const context = new ReadContext(this.store);
		const links = rows.map((link) => this.linkNow(link, context));
		const current = new Map(links.map((link) => [link.written, link.current]));
		rows.forEach((row, index) => {
			const link = links[index];
			if (link !== undefined) current.set(row.written, link.current);
		});
		return { text: rewriteRefs(text, current, this.project), links };
	}

	private summaryOf(text: string): Pick<Note, "summary" | "restAt"> {
		const opening = noteOpening(text);
		return opening.kind === "paragraph"
			? { summary: opening.summary, restAt: opening.restAt }
			: { summary: null, restAt: 0 };
	}

	private render(row: NoteRow): Note {
		const shown = this.shown(row.text, this.store.notes.links(row.subjectId));
		return {
			symbolId: row.symbolId,
			recordedAs: row.recordedAs,
			revision: row.revision,
			text: shown.text,
			...this.summaryOf(shown.text),
			author: authorOf(row.author),
			authoredAt: row.authoredAt,
			editedBy: authorOf(row.editedBy),
			editedAt: row.editedAt,
			sourceChanged: row.sourceDigest !== row.lastDigest,
			links: shown.links,
		};
	}

	/** Current address, or written text if unavailable. */
	private linkNow(link: NoteLinkRow, context: ReadContext): NoteLink {
		const written = storedRef(link.written, this.project);
		const broken: NoteLink = { written, current: written, state: "broken" };
		if (link.target.startsWith(MODULE_TARGET)) {
			const module = link.target.slice(MODULE_TARGET.length);
			if (module === "") return broken;
			const state = this.moduleStateOf(module);
			if (state === "withheld") return { ...broken, state: "withheld" };
			return state === "indexed" ? { ...broken, kind: "file", state: "ok" } : broken;
		}
		const at = this.store.notes.subjectAt(link.target);
		const module = at === null ? this.moduleFromRef(written) : moduleOf(at.symbolId);
		if (module !== null && this.moduleStateOf(module) === "withheld") return { ...broken, state: "withheld" };
		if (at === null || at.state !== "bound") return broken;
		const declarations = module === null ? [] : context.heldIn(module);
		const segments = chainOf(declarations, at.symbolId);
		const declaration = declarations.find((row) => row.symbolId === at.symbolId);
		if (module === null || segments === null || declaration === undefined) return broken;
		return {
			written,
			current: formatRef(this.project, module, segments),
			symbolId: at.symbolId,
			kind: declaration.kind,
			state: this.store.notes.digestOf(link.target) === link.targetDigest ? "ok" : "changed",
		};
	}

	private moduleStateOf(module: string): NoteModuleState {
		return this.moduleState?.(module) ?? (this.store.depthOf(module) === null ? "unindexed" : "indexed");
	}

	private moduleFromRef(ref: string): string | null {
		const parsed = parseRef(ref);
		return parsed.ok && parsed.ref.project === this.project ? parsed.ref.module : null;
	}
}
