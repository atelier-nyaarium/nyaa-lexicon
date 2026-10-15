import type { Metrics } from "@nyaa-lexicon/protocol";
import { type Blocks, blockHeader, bodyEndLine, hasCode, headerEndLine } from "./blocks.js";
import { parameterCount } from "./parameters.js";
import type { DeclarationFact, ReferenceToken, SourceLine } from "./parse-model.js";
import { isIgnorable, type LexedSource } from "./tokens.js";

/** A body line: its indent and the code tokens starting on it. */
interface BodyRow {
	indent: number;
	tokens: ReferenceToken[];
}

/** Lines in `start..end` holding code. */
function bodyRows(lexed: LexedSource, start: number, end: number): BodyRow[] {
	const rows: BodyRow[] = [];
	for (let line = start; line < end; line++) {
		if (isIgnorable(lexed, line)) continue;
		rows.push({
			indent: (lexed.lines[line] as SourceLine).indent,
			tokens: (lexed.lineTokens[line] ?? []).map((index) => lexed.tokens[index] as ReferenceToken),
		});
	}
	return rows;
}

const CONTROL_WORDS = new Set(["if", "elif", "else", "for", "while", "match"]);

function wordCount(tokens: ReferenceToken[], words: readonly string[]): number {
	return tokens.filter((token) => token.kind === "identifier" && words.includes(token.value)).length;
}

function controlHeader(tokens: ReferenceToken[]): string | null {
	const first = tokens[0];
	return first?.kind === "identifier" && CONTROL_WORDS.has(first.value) ? first.value : null;
}

function hasTopLevelColon(tokens: ReferenceToken[]): boolean {
	let depth = 0;
	for (const { value } of tokens) {
		if (value === "(" || value === "[" || value === "{") depth++;
		else if (value === ")" || value === "]" || value === "}") depth--;
		else if (value === ":" && depth === 0) return true;
	}
	return false;
}

function matchArmCount(rows: readonly BodyRow[]): number {
	const matches: { indent: number; armIndent: number | null }[] = [];
	let count = 0;
	for (const { indent, tokens } of rows) {
		while (matches.length > 0 && indent <= (matches[matches.length - 1] as { indent: number }).indent)
			matches.pop();
		const current = matches[matches.length - 1];
		if (current !== undefined && indent > current.indent) {
			if (current.armIndent === null) current.armIndent = indent;
			if (indent === current.armIndent && hasTopLevelColon(tokens)) count++;
		}
		if (controlHeader(tokens) === "match") matches.push({ indent, armIndent: null });
	}
	return count;
}

function bodyMetrics(rows: readonly BodyRow[]): Pick<Metrics, "nesting" | "branches"> {
	const controls: number[] = [];
	let nesting = 0;
	let branches = matchArmCount(rows);
	for (const { indent, tokens } of rows) {
		while (controls.length > 0 && indent <= (controls[controls.length - 1] as number)) controls.pop();
		nesting = Math.max(nesting, controls.length);
		const header = controlHeader(tokens);
		if (header !== null) {
			if (header !== "match") branches++;
			controls.push(indent);
			continue;
		}
		// A conditional expression, then each short-circuit.
		if (wordCount(tokens, ["if"]) > 0 && wordCount(tokens, ["else"]) > 0) branches++;
		branches += wordCount(tokens, ["and", "or"]);
	}
	return { nesting, branches: branches + 1 };
}

export function metricsForDeclaration(blocks: Blocks, declaration: DeclarationFact): Metrics {
	const metrics: Metrics = {
		lines: declaration.range.end.line - declaration.range.start.line + 1,
	};
	if (declaration.kind !== "method") return metrics;
	const lexed = blocks.lexed;
	const headerEnd = headerEndLine(blocks, declaration);
	const end = bodyEndLine(blocks, declaration);
	const lastBodyLine = Math.max(headerEnd, end - 1);
	metrics.lines = lastBodyLine - declaration.range.start.line + 1;
	metrics.parameters = parameterCount(lexed, declaration);
	const header = blockHeader(blocks, declaration);
	if (header !== undefined && hasCode(lexed.tokens, header.inline)) {
		const { start, end: stop } = header.inline;
		const tokens = lexed.tokens.slice(start, stop).filter((token) => token.kind !== "newline");
		Object.assign(metrics, bodyMetrics([{ indent: header.statement.indent, tokens }]));
		return metrics;
	}
	const rows = bodyRows(lexed, headerEnd + 1, end);
	if (rows.length > 0) Object.assign(metrics, bodyMetrics(rows));
	return metrics;
}
