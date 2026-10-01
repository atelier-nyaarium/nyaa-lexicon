// Where an arrangement's removals and insertions fall in one module, worked out once against its
// original text: whole-line removals, each blank separator owned once, and the insertions landing
// at one point framed as one group.

import { coordinatesOf, type Position, type Range } from "@nyaa-lexicon/protocol";

////////////////////////////////
//  Interfaces & Types

/** Before a line of the original text, or after its last. */
export type Landing = { line: number } | "end";

export interface LayoutSlot {
	landing: Landing;
	/** In landing order. */
	members: ReadonlyArray<{ symbolId: string; text: string }>;
}

export interface Layout {
	removals: Map<string, Range>;
	/** Framed so that the members at one position, joined in `order`, read as one group. */
	insertions: Map<string, { text: string; position: Position }>;
	/** Inserted members as they land. */
	order: string[];
}

/** Whole lines `start` to `end`, end exclusive, split among the members they remove. */
interface Span {
	start: number;
	end: number;
	members: Array<{ symbolId: string; start: number }>;
}

////////////////////////////////
//  Functions & Helpers

/** One module's removals and slots. Slots come in document order; a later slot at the same point lands after. */
export function layoutModule(text: string, removals: ReadonlyMap<string, Range>, slots: readonly LayoutSlot[]): Layout {
	const coords = coordinatesOf(text);
	const ended = text.endsWith("\n");
	const count = text === "" ? 0 : coords.lineCount() - (ended ? 1 : 0);
	const eol = text.includes("\r\n") ? "\r\n" : "\n";
	const filled = (line: number) => line >= 0 && line < count && (coords.lineText(line) ?? "").trim() !== "";
	const blank = (line: number) => line >= 0 && line < count && !filled(line);
	const textEnd = coords.positionAt(text.length) ?? { line: count, character: 0 };
	const lineStart = (line: number): Position => (line < count ? { line, character: 0 } : textEnd);
	const layout: Layout = { removals: new Map(), insertions: new Map(), order: [] };

	// A declaration sharing a line keeps its own range and owns no separator.
	const whole: Array<{ symbolId: string; start: number; end: number }> = [];
	for (const [symbolId, range] of removals) {
		const toLineStart = range.end.character === 0 && range.end.line > range.start.line;
		const before = coords.lineText(range.start.line)?.slice(0, range.start.character);
		const after = toLineStart ? "" : coords.lineText(range.end.line)?.slice(range.end.character);
		if (before?.trim() === "" && after?.trim() === "") {
			whole.push({ symbolId, start: range.start.line, end: toLineStart ? range.end.line : range.end.line + 1 });
		} else layout.removals.set(symbolId, range);
	}

	// Removals with only blank lines between them leave as one span.
	const spans: Span[] = [];
	for (const each of whole.sort((left, right) => left.start - right.start)) {
		const last = spans.at(-1);
		let between = last?.end ?? 0;
		while (last !== undefined && between < each.start && blank(between)) between += 1;
		if (last !== undefined && between >= each.start) {
			last.end = Math.max(last.end, each.end);
			last.members.push({ symbolId: each.symbolId, start: each.start });
		} else {
			spans.push({ start: each.start, end: each.end, members: [{ symbolId: each.symbolId, start: each.start }] });
		}
	}

	// A span takes the blank lines below it when the line above is blank or absent, and at the end those above.
	for (const span of spans) {
		const top = span.start === 0;
		if (span.end < count && blank(span.end) && (top || blank(span.start - 1))) {
			while (blank(span.end)) span.end += 1;
		}
		if (span.end >= count && !top) {
			while (blank(span.start - 1)) span.start -= 1;
		}
		for (const [index, member] of span.members.entries()) {
			const from = index === 0 ? span.start : member.start;
			const to = span.members[index + 1]?.start ?? span.end;
			layout.removals.set(member.symbolId, { start: lineStart(from), end: lineStart(to) });
		}
	}

	const kept = (line: number) => !spans.some((span) => span.start <= line && line < span.end);
	// A point inside or just past a span lands where the span starts.
	const pointOf = (landing: Landing): number => {
		const line = landing === "end" ? count : Math.min(landing.line, count);
		return spans.find((span) => span.start <= line && line <= span.end)?.start ?? line;
	};

	const groups = new Map<number, Array<{ symbolId: string; text: string }>>();
	for (const slot of slots) {
		const point = pointOf(slot.landing);
		groups.set(point, [...(groups.get(point) ?? []), ...slot.members]);
	}
	for (const [point, members] of [...groups].sort(([left], [right]) => left - right)) {
		let above = point - 1;
		while (above >= 0 && !kept(above)) above -= 1;
		let below = point;
		while (below < count && !kept(below)) below += 1;
		// Past an unended last line, the group ends that line first.
		const leading = `${point >= count && !ended && count > 0 ? eol : ""}${filled(above) ? eol : ""}`;
		const trailing = filled(below) ? eol : "";
		for (const [index, member] of members.entries()) {
			const body = member.text.replace(/\r?\n/g, eol);
			const lines = body.endsWith(eol) ? body : `${body}${eol}`;
			const framed = `${index === 0 ? leading : eol}${lines}${index === members.length - 1 ? trailing : ""}`;
			layout.insertions.set(member.symbolId, { text: framed, position: lineStart(point) });
			layout.order.push(member.symbolId);
		}
	}
	return layout;
}
