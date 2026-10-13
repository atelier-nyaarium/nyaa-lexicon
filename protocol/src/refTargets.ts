import { z } from "zod";
import { comparePositions, coordinatesOf } from "./coordinates.js";
import { ModulePathSchema } from "./modulePath.js";
import { formatRef, parseRef, validProjectId } from "./noteRefs.js";
import type { Range } from "./symbols.js";

export interface RefTarget {
	project: string;
	module: string;
	segments: string[];
	lines?: { start: number; end: number };
	range?: Range;
}

const PositiveSafe = z.number().int().positive().safe();
const OneBasedRangeSchema = z.object({
	start: z.object({
		line: PositiveSafe.describe(`One-based line.`),
		column: PositiveSafe.describe(`One-based UTF-16 column.`),
	}),
	end: z.object({
		line: PositiveSafe.describe(`One-based line.`),
		column: PositiveSafe.describe(`One-based UTF-16 column.`),
	}),
});
export const BuildRefInputSchema = z
	.object({
		project: z.string().min(1).refine(validProjectId, `Invalid project id.`).describe(`Workspace key.`),
		module: z.string().min(1).describe(`Raw, unencoded workspace-relative path.`),
		segments: z.array(z.string().min(1)).optional().describe(`Raw names, outermost first.`),
		lines: z
			.object({
				start: PositiveSafe.describe(`First one-based line.`),
				end: PositiveSafe.describe(`Last one-based line, inclusive.`),
			})
			.optional()
			.describe(`Inclusive one-based lines; omit range.`),
		range: OneBasedRangeSchema.optional().describe(
			`One-based positions; UTF-16 columns, exclusive end. Omit lines.`,
		),
	})
	.refine((value) => !(value.lines && value.range), {
		message: `Use lines or range, not both.`,
	})
	.describe(`Lines and range are mutually exclusive.`);

type Result<T> = ({ ok: true } & T) | { ok: false; problem: string };
const failure = (problem: string) => ({ ok: false as const, problem });

function normalizeEnds<T>(start: T, end: T, compare: (a: T, b: T) => number): [T, T] {
	return compare(start, end) <= 0 ? [start, end] : [end, start];
}

function encodeFragment(target: RefTarget): string {
	if (target.lines) return `#${target.lines.start}..${target.lines.end}`;
	if (target.range) {
		const start = `${target.range.start.line + 1},${target.range.start.character + 1}`;
		const end = `${target.range.end.line + 1},${target.range.end.character + 1}`;
		return `#L${start}${start === end ? "" : `-L${end}`}`;
	}
	return "";
}

export function formatRefTarget(target: RefTarget): string {
	return `${formatRef(target.project, target.module, target.segments)}${encodeFragment(target)}`;
}

export function buildRef(input: unknown): Result<{ ref: string; target: RefTarget }> {
	const parsed = BuildRefInputSchema.safeParse(input);
	if (!parsed.success) return failure(parsed.error.issues[0]?.message ?? "invalid ref target");
	const path = ModulePathSchema.safeParse(parsed.data.module);
	if (!path.success) return failure(path.error.issues[0]?.message ?? "invalid module path");
	const target: RefTarget = { project: parsed.data.project, module: path.data, segments: parsed.data.segments ?? [] };
	if (parsed.data.lines) {
		const [start, end] = normalizeEnds(parsed.data.lines.start, parsed.data.lines.end, (a, b) => a - b);
		target.lines = { start, end };
	}
	if (parsed.data.range) {
		const convert = ({ line, column }: { line: number; column: number }) => ({
			line: line - 1,
			character: column - 1,
		});
		const [start, end] = normalizeEnds(
			convert(parsed.data.range.start),
			convert(parsed.data.range.end),
			comparePositions,
		);
		target.range = { start, end };
	}
	try {
		return { ok: true, ref: formatRefTarget(target), target };
	} catch {
		return failure("ref target contains invalid Unicode");
	}
}

const integer = "([1-9][0-9]*)";
const lineSelection = new RegExp(`^${integer}(?:\\.\\.${integer})?$`);
const coordinateSpan = new RegExp(`^L?${integer}(?:,${integer})?(?:-L?${integer}(?:,${integer})?)?$`);
const lineSpan = new RegExp(`^L?${integer}(?:-L?${integer})?$`);

function positive(value: string): number | undefined {
	const number = Number(value);
	return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

function parseFragment(fragment: string): Pick<RefTarget, "lines" | "range"> | { problem: string } | undefined {
	if (fragment === "") return {};
	const lines = lineSelection.exec(fragment);
	if (lines) {
		const start = positive(lines[1] ?? "");
		const end = positive(lines[2] ?? lines[1] ?? "");
		if (!start || !end) return { problem: "selection coordinates must be positive safe integers" };
		const [first, last] = normalizeEnds(start, end, (a, b) => a - b);
		return { lines: { start: first, end: last } };
	}
	const coords = coordinateSpan.exec(fragment);
	if (coords && (/^L/i.test(fragment) || fragment.includes(",") || fragment.includes("-"))) {
		const values = fragment.replace(/^L/, "").split(/-L?/);
		const parsePoint = (value: string | undefined) => {
			if (!value) return undefined;
			const [rawLine, rawColumn] = value.split(",");
			const line = positive(rawLine ?? "");
			const column = positive(rawColumn ?? "1");
			return line && column ? { line: line - 1, character: column - 1 } : undefined;
		};
		const start = parsePoint(values[0]);
		const end = parsePoint(values[1]);
		if (!start || (values[1] && !end)) return { problem: "selection coordinates must be positive safe integers" };
		const [first, last] = normalizeEnds(start, end ?? start, comparePositions);
		return { range: { start: first, end: last } };
	}
	if (lineSpan.test(fragment)) {
		const values = fragment.replace(/^L/, "").split(/-L?/).map(positive);
		if (values.some((value) => value === undefined))
			return { problem: "selection coordinates must be positive safe integers" };
		const [first, last] = normalizeEnds(values[0] as number, (values[1] ?? values[0]) as number, (a, b) => a - b);
		const start = { line: first - 1, character: 0 };
		const end = values.length === 1 ? start : { line: last - 1, character: 0 };
		return { range: { start, end } };
	}
	return { problem: "selection fragment is invalid" };
}

export function parseRefTarget(uri: string): Result<{ target: RefTarget }> {
	if (typeof uri !== "string" || !uri.startsWith("project-ref://"))
		return failure("a ref starts with project-ref://");
	const hash = uri.indexOf("#");
	if (hash >= 0 && hash === uri.length - 1) return failure("selection fragment is invalid");
	const base = hash < 0 ? uri : uri.slice(0, hash);
	const selection = hash < 0 ? "" : uri.slice(hash + 1);
	const parsed = parseRef(base);
	if (!parsed.ok) return failure(parsed.problem);
	const fragment = parseFragment(selection);
	if (!fragment) return failure("selection fragment is invalid");
	if ("problem" in fragment) return failure(fragment.problem);
	return { ok: true, target: { ...parsed.ref, ...fragment } };
}

export function selectionWithin(target: RefTarget, bounds: Range): boolean {
	if (target.lines) {
		const lastBoundLine = bounds.end.character === 0 ? bounds.end.line : bounds.end.line + 1;
		return target.lines.start >= bounds.start.line + 1 && target.lines.end <= lastBoundLine;
	}
	if (target.range)
		return (
			comparePositions(target.range.start, bounds.start) >= 0 &&
			comparePositions(target.range.end, bounds.end) <= 0
		);
	return true;
}

export function refSelection(target: RefTarget, text: string): Result<{ range: Range | null }> {
	if (target.lines) {
		const coordinates = coordinatesOf(text);
		const startLine = target.lines.start - 1;
		const endLine = target.lines.end - 1;
		if (startLine < 0 || endLine >= coordinates.lineCount()) return failure("selection is outside the text");
		const start = { line: startLine, character: 0 };
		const end = { line: endLine, character: (coordinates.lineText(endLine) ?? "").length };
		return { ok: true, range: { start, end } };
	}
	if (target.range)
		return coordinatesOf(text).offsetsForRange(target.range)
			? { ok: true, range: target.range }
			: failure("selection is outside the text");
	return { ok: true, range: null };
}
