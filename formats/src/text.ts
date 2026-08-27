import { Cursor, type Diagnostic, type DocRegion, type TextCoordinates } from "@nyaa-lexicon/protocol";

export interface TextContext {
	language: string;
	module: string;
	text: string;
	offset: number;
	coordinates: TextCoordinates;
}

export interface TextFacts {
	docs: DocRegion[];
	diagnostics: Diagnostic[];
}

// 16 KiB bounds regions in a 4 MiB file.
const MAX_REGION_BYTES = 16 * 1024;
// 10,000 bounds one-line paragraphs in a 4 MiB file.
const MAX_REGIONS = 10_000;

interface Line {
	start: number;
	end: number;
}

function linesOf(text: string): Line[] {
	const cursor = new Cursor(text);
	const lines: Line[] = [];
	let start = 0;
	while (cursor.good()) {
		const at = cursor.offset;
		if (cursor.next() !== "\n") continue;
		lines.push({ start, end: text.slice(at - 1, at) === "\r" ? at - 1 : at });
		start = cursor.offset;
	}
	lines.push({ start, end: text.length });
	return lines;
}

function paragraphRanges(text: string): Array<{ start: number; end: number }> {
	const lines = linesOf(text);
	const ranges: Array<{ start: number; end: number }> = [];
	let start: number | undefined;
	let end = 0;
	for (const line of lines) {
		if (text.slice(line.start, line.end).trim() === "") {
			if (start !== undefined) ranges.push({ start, end });
			start = undefined;
			continue;
		}
		start ??= line.start;
		end = line.end;
	}
	if (start !== undefined) ranges.push({ start, end });
	return ranges;
}

/** Cut at line ends, so a part ends where a line does and a lone long line stays one part. */
function splitParagraph(text: string, start: number, end: number): Array<{ start: number; end: number }> {
	const result: Array<{ start: number; end: number }> = [];
	let part = start;
	let previousEnd = start;
	for (const line of linesOf(text.slice(start, end))) {
		const lineStart = start + line.start;
		const lineEnd = start + line.end;
		if (lineEnd - part > MAX_REGION_BYTES && previousEnd > part) {
			result.push({ start: part, end: previousEnd });
			part = lineStart;
		}
		previousEnd = lineEnd;
	}
	if (part < end) result.push({ start: part, end });
	return result;
}

export function readText(context: TextContext): TextFacts {
	const docs: DocRegion[] = [];
	const diagnostics: Diagnostic[] = [];
	let omitted = 0;
	for (const paragraph of paragraphRanges(context.text)) {
		const parts = splitParagraph(context.text, paragraph.start, paragraph.end);
		if (docs.length + parts.length > MAX_REGIONS) {
			omitted += 1;
			continue;
		}
		for (const part of parts) {
			const range = context.coordinates.rangeAt(context.offset + part.start, context.offset + part.end);
			if (range === undefined) continue;
			docs.push({ text: context.text.slice(part.start, part.end), range, fenced: false });
		}
	}
	if (omitted > 0) {
		diagnostics.push({
			severity: "info",
			message: `omitted ${omitted} paragraphs after the ${MAX_REGIONS} region limit`,
			path: context.module,
		});
	}
	return { docs, diagnostics };
}
