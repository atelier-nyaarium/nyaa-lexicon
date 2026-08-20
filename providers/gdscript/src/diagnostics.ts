// Owns GDScript syntax diagnostics and delimiter state.

import { comparePositions, type Diagnostic, type Position, type Range } from "@nyaa-lexicon/protocol";
import { indentationEnd, indentOf, isIgnorable } from "./line-syntax.js";
import type { ReferenceToken, SourceLine } from "./parse-model.js";
import { scanSource } from "./source-scan.js";
import { referenceTokens } from "./tokens.js";

//////// Diagnostics

interface OpenDelimiter {
	value: "(" | "[" | "{";
	position: Position;
}

interface PendingBlockHeader {
	indent: number;
	range: Range;
}

function diagnosticAt(module: string, message: string, range: Range): Diagnostic {
	return { severity: "error", message, range, path: module };
}

function pointRange(position: Position, length = 1): Range {
	return {
		start: position,
		end: { line: position.line, character: position.character + length },
	};
}

function blockHeaderRange(line: SourceLine): Range | null {
	const end = line.code.trimEnd().length;
	if (end === 0 || line.code[end - 1] !== ":") return null;
	if (line.stringStarts.some((start) => start >= end)) return null;
	return {
		start: { line: line.line, character: end - 1 },
		end: { line: line.line, character: end },
	};
}

function syntaxMeaningful(line: SourceLine): boolean {
	return line.hasString || !isIgnorable(line);
}

function lineContinues(line: SourceLine): boolean {
	return line.code.trimEnd().endsWith("\\");
}

function closingDelimiter(value: string): OpenDelimiter["value"] | null {
	if (value === ")") return "(";
	if (value === "]") return "[";
	if (value === "}") return "{";
	return null;
}

export function extractDiagnosticsCore(module: string, text: string): Diagnostic[] {
	if (!module.endsWith(".gd")) return [];
	const scanned = scanSource(text);
	const diagnostics = scanned.unterminatedStrings.map((position) =>
		diagnosticAt(module, "String literal has no closing quote.", pointRange(position)),
	);
	const tokensByLine = new Map<number, ReferenceToken[]>();
	for (const token of referenceTokens(scanned.lines)) {
		const lineTokens = tokensByLine.get(token.line) ?? [];
		lineTokens.push(token);
		tokensByLine.set(token.line, lineTokens);
	}

	const delimiters: OpenDelimiter[] = [];
	const indentationLevels = [0];
	let logicalStart: SourceLine | null = null;
	let pendingHeader: PendingBlockHeader | null = null;
	for (const line of scanned.lines) {
		if (logicalStart === null && syntaxMeaningful(line)) {
			logicalStart = line;
			const indent = indentOf(line.text);
			const currentIndent = indentationLevels[indentationLevels.length - 1] as number;
			const opensBody = pendingHeader !== null && indent > pendingHeader.indent;
			if (pendingHeader !== null && !opensBody) {
				diagnostics.push(diagnosticAt(module, "Block header has no indented body.", pendingHeader.range));
			}
			pendingHeader = null;
			if (opensBody && indent > currentIndent) {
				indentationLevels.push(indent);
			} else if (indent < currentIndent) {
				while (
					indentationLevels.length > 1 &&
					indent < (indentationLevels[indentationLevels.length - 1] as number)
				) {
					indentationLevels.pop();
				}
				if (indent !== indentationLevels[indentationLevels.length - 1]) {
					diagnostics.push(
						diagnosticAt(module, "Indentation dedents to a level that was not opened.", {
							start: { line: line.line, character: 0 },
							end: { line: line.line, character: indentationEnd(line.text) },
						}),
					);
					indentationLevels.push(indent);
				}
			}
		}

		for (const token of tokensByLine.get(line.line) ?? []) {
			if (token.value === "(" || token.value === "[" || token.value === "{") {
				delimiters.push({ value: token.value, position: { line: token.line, character: token.character } });
				continue;
			}
			const opening = closingDelimiter(token.value);
			if (opening !== null && delimiters[delimiters.length - 1]?.value === opening) delimiters.pop();
		}

		const continues = delimiters.length > 0 || line.endsInString || lineContinues(line);
		if (logicalStart !== null && !continues) {
			const headerRange = blockHeaderRange(line);
			if (headerRange !== null) pendingHeader = { indent: indentOf(logicalStart.text), range: headerRange };
			logicalStart = null;
		}
	}

	if (pendingHeader !== null) {
		diagnostics.push(diagnosticAt(module, "Block header has no indented body.", pendingHeader.range));
	}
	for (const delimiter of delimiters) {
		diagnostics.push(
			diagnosticAt(
				module,
				`Opening ${JSON.stringify(delimiter.value)} is not closed before end of file.`,
				pointRange(delimiter.position),
			),
		);
	}
	return diagnostics.sort((left, right) => {
		const leftStart = left.range?.start ?? { line: Number.MAX_SAFE_INTEGER, character: Number.MAX_SAFE_INTEGER };
		const rightStart = right.range?.start ?? { line: Number.MAX_SAFE_INTEGER, character: Number.MAX_SAFE_INTEGER };
		return comparePositions(leftStart, rightStart);
	});
}
