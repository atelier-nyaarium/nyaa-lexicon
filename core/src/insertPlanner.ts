import type { FileFacts, Range, TextEdit } from "@nyaa-lexicon/protocol";
import {
	applyEdits,
	comparePositions,
	composeSymbolId,
	coordinatesOf,
	hashContent,
	isWithin,
	parseSymbolId,
	rangeInRange,
	sameRange,
} from "@nyaa-lexicon/protocol";
import { workspaceModule } from "./plannerCommon.js";
import type { ProviderProbe } from "./providerProbe.js";
import { type NestingReads, ReadContext, sentReads } from "./readContext.js";
import type { InsertArgs, InsertPlan } from "./refactorPlanner.js";
import {
	anchorCopiesMoved,
	anchorNotInText,
	candidateDoesNotParse,
	editsRefused,
	moduleChangedReindex,
	moduleNotOnDisk,
	noInsertionPoint,
	noProviderOwns,
	noSingleLineName,
	nothingToInsert,
	oneAnchorOnly,
	type Refusal,
	subjectRefused,
} from "./refusals.js";
import { writableText } from "./sourceRead.js";
import type { SourceWorkspace } from "./sourceWorkspace.js";
import type { IndexStore, StoredDeclaration } from "./store.js";
import type { RefactorIssue } from "./transactions.js";

type ImpactWithin = (context: ReadContext, module: string, candidate: FileFacts) => RefactorIssue[];
type SyntaxUnchecked = (providerId: string, module: string) => RefactorIssue | null;

/** An id without its last occurrence, which every copy of its name path shares. */
function copiesKey(symbolId: string): string {
	const id = parseSymbolId(symbolId);
	const last = id?.descriptors.at(-1);
	if (id === null || id === undefined || last === undefined) return symbolId;
	const { occurrence: _occurrence, ...bare } = last;
	return composeSymbolId({ ...id, descriptors: [...id.descriptors.slice(0, -1), bare] });
}

function contains(outer: Range, inner: Range): boolean {
	return rangeInRange(outer, inner);
}

/** Block lines inside a multiline literal: kept as written, or re-indented with the literal. */
interface LiteralLines {
	kept: Set<number>;
	dedented: Set<number>;
}

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

export class InsertPlanner {
	constructor(
		private readonly store: IndexStore,
		private readonly source: SourceWorkspace,
		private readonly probe: ProviderProbe,
		private readonly impactWithin: ImpactWithin,
		private readonly syntaxUnchecked: SyntaxUnchecked,
	) {}

	/** Owns insertion splice selection for `previewInsert`. See `docs/daemon-protocol.md`. */
	async planInsert(args: InsertArgs): Promise<InsertPlan> {
		const flush = args.text.replace(/\s+$/, "");
		if (flush.trim().length === 0) return { state: "refused", reason: nothingToInsert() };
		if ((args.after === undefined) === (args.module === undefined)) {
			return { state: "refused", reason: oneAnchorOnly() };
		}

		const context = new ReadContext(this.store);
		const sent = args.moduleText;
		let reads: NestingReads = context;
		if (args.after !== undefined && sent !== undefined) {
			const anchor = context.declaration(args.after);
			if (!anchor) return { state: "refused", reason: subjectRefused(args.after, this.store) };
			const parsed = await this.parsedReads(anchor.module, sent);
			if ("refused" in parsed) return { state: "refused", reason: parsed.refused };
			// Copies of a name path number in source order, so one added or removed above shifts the id.
			const key = copiesKey(args.after);
			const copies = (rows: StoredDeclaration[]) => rows.filter((row) => copiesKey(row.symbolId) === key).length;
			const held = parsed.declaration(args.after) !== null;
			if (held && copies(context.heldIn(anchor.module)) !== copies(parsed.heldIn(anchor.module)))
				return { state: "refused", reason: anchorCopiesMoved(args.after, anchor.module) };
			reads = parsed;
		}
		const point =
			args.after !== undefined
				? this.afterPoint(context, reads, args.after, sent)
				: this.endPoint(args.module as string, sent);
		if ("refused" in point) return { state: "refused", reason: point.refused };
		const unwritable = writableText(point.module, args.text);
		if (unwritable !== null) return { state: "refused", reason: unwritable };

		const lines = flush.split("\n");
		const indented = ({ kept, dedented }: LiteralLines) =>
			lines
				.map((line, at) => {
					if (kept.has(at)) return line;
					// Whitespace a dedented literal holds beyond its indent is part of its value.
					if (line.trim().length === 0 && !(dedented.has(at) && line.length > 0)) return "";
					return point.indent + line;
				})
				.join("\n");
		let block = indented({ kept: new Set(), dedented: new Set() });
		// A multiline literal keeps its own lines, unless its language strips their indentation.
		if (point.indent !== "") {
			const literal = await this.literalLines(point, block, lines.length);
			if (literal.kept.size > 0 || literal.dedented.size > 0) block = indented(literal);
		}

		if (this.blockPresent(point, block)) return { state: "present", module: point.module };

		const spliced = this.spliceBlock(point, block);
		if ("problem" in spliced) return { state: "refused", reason: editsRefused(spliced.problem) };
		const candidate = spliced.text;

		const owner = this.probe.owner(point.module);
		if (!owner.owned) return { state: "refused", reason: noProviderOwns(point.module, owner.reason) };

		const parsed = await this.probe.parseCandidate(point.module, candidate);
		if (!parsed.parsed) return { state: "refused", reason: candidateDoesNotParse("insert", parsed.reason) };

		const issues = this.impactWithin(context, point.module, parsed.facts);
		const unchecked = this.syntaxUnchecked(owner.providerId, point.module);
		if (unchecked !== null) issues.push(unchecked);
		issues.push(...this.collisionWarnings(context, point.module, parsed.facts));

		return {
			state: "planned",
			module: point.module,
			created: point.created,
			candidate,
			edits: spliced.edits,
			block,
			baseHash: point.created ? null : hashContent(point.before),
			facts: context.seen(),
			issues,
		};
	}

	/** The block's lines inside a multiline literal, by index, split by whether its language strips their indentation. */
	private async literalLines(point: SplicePoint, block: string, count: number): Promise<LiteralLines> {
		const lines: LiteralLines = { kept: new Set(), dedented: new Set() };
		if (!this.probe.owner(point.module).owned) return lines;
		const spliced = this.spliceBlock(point, block);
		if ("problem" in spliced) return lines;
		const first = spliced.line;
		const parsed = await this.probe.parseCandidate(point.module, spliced.text);
		if (!parsed.parsed) return lines;
		for (const literal of parsed.facts.literals) {
			const into = literal.dedented === true ? lines.dedented : lines.kept;
			for (let line = literal.range.start.line + 1; line <= literal.range.end.line; line++) {
				if (line - first >= 0 && line - first < count) into.add(line - first);
			}
		}
		return lines;
	}

	/** Sent text's own declarations, standing in for the stored rows of its module. */
	private async parsedReads(module: string, text: string): Promise<NestingReads | { refused: Refusal }> {
		const owner = this.probe.owner(module);
		if (!owner.owned) return { refused: noProviderOwns(module, owner.reason) };
		const parsed = await this.probe.parseCandidate(module, text);
		if (!parsed.parsed) return { refused: candidateDoesNotParse("sent text", parsed.reason) };
		return sentReads(module, parsed.facts.declarations);
	}

	/** The splice for a sibling anchor, or an honest refusal where no sound point exists. */
	private afterPoint(
		context: ReadContext,
		reads: NestingReads,
		after: string,
		sent: string | undefined,
	): SplicePoint | { refused: Refusal } {
		const stored = context.declaration(after);
		if (!stored) return { refused: subjectRefused(after, this.store) };
		const module = stored.module;
		const current = this.source.writable(module);
		if ("refused" in current) return current;
		if (current.text === null) return { refused: moduleNotOnDisk(module) };
		const before = sent ?? current.text;

		// The stored ranges address ONE version of the file; a moved file makes them wrong lines.
		const indexed = this.store.contentHashOf(module);
		if (sent === undefined && indexed !== null && indexed !== hashContent(before)) {
			return { refused: moduleChangedReindex(module) };
		}
		const anchor = reads.declaration(after);
		if (!anchor) return { refused: anchorNotInText(after, module) };

		// The name line is the declaration line; the range starts at leading comments, which may
		// legally indent differently.
		if (
			anchor.selectionRange === undefined ||
			anchor.selectionRange.start.line !== anchor.selectionRange.end.line
		) {
			return { refused: noSingleLineName(anchor.name) };
		}
		const coords = coordinatesOf(before);
		const nameLine = coords.lineText(anchor.selectionRange.start.line);
		if (nameLine === undefined) return { refused: moduleChangedReindex(module) };
		const indent = /^[ \t]*/.exec(nameLine)?.[0] ?? "";

		const shared = (who: string) => ({ refused: noInsertionPoint(who) });

		const container = anchor.containerId === undefined ? null : reads.declaration(anchor.containerId);
		if (anchor.containerId !== undefined && !container) {
			return { refused: subjectRefused(anchor.containerId, this.store) };
		}
		// A member written outside its container's body, as a Rust impl method or a C++ out-of-line
		// definition, sits in a block no fact here names.
		if (container && !contains(container.range, anchor.range)) return shared(container.name);

		// Only siblings inside the container's body: a member's follower cannot be top-level or in
		// another block. Declarator and overload groups share ranges and never compete.
		let next: StoredDeclaration | null = null;
		for (const candidate of reads.heldBy(module, anchor.containerId)) {
			if (candidate.symbolId === anchor.symbolId) continue;
			if (isWithin(candidate.symbolId, anchor.symbolId)) continue;
			if (sameRange(candidate.range, anchor.range)) continue;
			if (comparePositions(candidate.range.start, anchor.range.end) < 0) continue;
			if (container && !contains(container.range, candidate.range)) continue;
			if (next === null || comparePositions(candidate.range.start, next.range.start) < 0) next = candidate;
		}

		if (next !== null) {
			if (next.range.start.line === anchor.range.end.line) return shared(next.name);
			return { module, before, created: false, line: next.range.start.line, indent, trailingBlank: true };
		}

		if (!container) return { module, before, created: false, line: null, indent, trailingBlank: false };
		// The provider names the line; the anchor must end before it.
		const line = container.memberInsertLine;
		if (line === undefined || anchor.range.end.line >= line) return shared(container.name);
		return { module, before, created: false, line, indent, trailingBlank: false };
	}

	private endPoint(rawModule: string, sent: string | undefined): SplicePoint | { refused: Refusal } {
		// "Created if absent" must never mean created OUTSIDE the workspace.
		const target = workspaceModule(rawModule);
		if ("refused" in target) return target;
		const module = target.module;
		const current = this.source.writable(module);
		if ("refused" in current) return current;
		// Sent text is an open file's, so one gone from disk is not created.
		if (sent !== undefined && current.text === null) return { refused: moduleNotOnDisk(module) };
		return {
			module,
			before: sent ?? current.text ?? "",
			created: current.text === null,
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

	/** Whole-line splice, framed by blank lines where the neighbors are not already blank. `line` is the block's first. */
	private spliceBlock(
		point: SplicePoint,
		block: string,
	): { text: string; edits: TextEdit[]; line: number } | { problem: string } {
		const splice = this.spliceEdit(point, block);
		if ("problem" in splice) return splice;
		const { edit, lead } = splice;
		const applied = applyEdits(point.before, [edit]);
		return "problem" in applied
			? applied
			: { text: applied.text, edits: [edit], line: edit.range.start.line + lead };
	}

	/** The edit, and how many newlines it writes before the block. */
	private spliceEdit(point: SplicePoint, block: string): { edit: TextEdit; lead: number } | { problem: string } {
		const coords = coordinatesOf(point.before);
		if (point.line !== null) {
			const above = point.line === 0 ? undefined : coords.lineText(point.line - 1);
			const leadingBlank = above !== undefined && above.trim().length > 0 ? "\n" : "";
			const at = { line: point.line, character: 0 };
			return {
				edit: {
					range: { start: at, end: at },
					newText: `${leadingBlank}${block}\n${point.trailingBlank ? "\n" : ""}`,
				},
				lead: leadingBlank.length,
			};
		}

		const end = coords.positionAt(point.before.length);
		if (end === undefined) return { problem: `the end of ${point.module} has no position` };
		const range = { start: end, end };
		if (point.before.length === 0) return { edit: { range, newText: `${block}\n` }, lead: 0 };
		const newline = point.before.endsWith("\n") ? "" : "\n";
		const separator = `${point.before}${newline}`.endsWith("\n\n") ? "" : "\n";
		return {
			edit: { range, newText: `${newline}${separator}${block}\n` },
			lead: newline.length + separator.length,
		};
	}

	/** Insert is rename's mirror: a new binder lands among existing uses. Whether that captures
	 * them is a language question core must not answer, so it is a warning, never a blocker. */
	private collisionWarnings(context: ReadContext, module: string, candidate: FileFacts): RefactorIssue[] {
		const warnings: RefactorIssue[] = [];

		for (const minted of candidate.declarations) {
			if (context.holds(module, minted.symbolId)) continue;
			const declared = context
				.heldBy(module, minted.containerId)
				.filter((existing) => existing.name === minted.name);
			// Imports are module-level, provably not inside a member container.
			const imported =
				minted.containerId === undefined
					? context.importsBinding(minted.name).filter((entry) => entry.module === module)
					: [];
			if (declared.length === 0 && imported.length === 0) continue;
			warnings.push({
				kind: "NameAlreadyBound",
				detail: `${minted.name} is already ${declared.length > 0 ? "declared" : "imported"} here; existing uses of the name may rebind to the inserted declaration`,
				module,
			});
		}
		return warnings;
	}
}
