// Owns GDScript syntax diagnostics and delimiter state.

import { comparePositions, type Diagnostic, type Position, type Range } from "@nyaa-lexicon/protocol";
import type { ReferenceToken, SourceLine } from "./parse-model.js";
import { firstLineToken, isContinuation, isIgnorable, type LexedSource, lastLineToken } from "./tokens.js";

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

/** The line's last token, when it is a block colon. */
function blockHeaderRange(lexed: LexedSource, line: number): Range | null {
	const last = lastLineToken(lexed, line);
	if (last?.kind !== "symbol" || last.value !== ":") return null;
	return pointRange({ line: last.line, character: last.character });
}

function syntaxMeaningful(lexed: LexedSource, line: SourceLine): boolean {
	return line.hasString || !isIgnorable(lexed, line.line);
}

function lineContinues(lexed: LexedSource, line: number): boolean {
	return isContinuation(lastLineToken(lexed, line));
}

function closingDelimiter(value: string): OpenDelimiter["value"] | null {
	if (value === ")") return "(";
	if (value === "]") return "[";
	if (value === "}") return "{";
	return null;
}

export function diagnosticsOf(module: string, lexed: LexedSource): Diagnostic[] {
	if (!module.endsWith(".gd")) return [];
	const diagnostics = [
		...lexed.unterminatedStrings.map((position) =>
			diagnosticAt(module, "String literal has no closing quote.", pointRange(position)),
		),
		...lexed.invalidEscapes.map((position) =>
			diagnosticAt(module, "String literal has an escape Godot refuses.", pointRange(position)),
		),
	];

	const delimiters: OpenDelimiter[] = [];
	const indentationLevels = [0];
	let logicalStart: SourceLine | null = null;
	let pendingHeader: PendingBlockHeader | null = null;
	for (const line of lexed.lines) {
		if (logicalStart === null && syntaxMeaningful(lexed, line)) {
			logicalStart = line;
			const indent = line.indent;
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
							end: { line: line.line, character: firstLineToken(lexed, line.line)?.character ?? 0 },
						}),
					);
					indentationLevels.push(indent);
				}
			}
		}

		for (const index of lexed.lineTokens[line.line] ?? []) {
			const token = lexed.tokens[index] as ReferenceToken;
			if (token.value === "(" || token.value === "[" || token.value === "{") {
				delimiters.push({ value: token.value, position: { line: token.line, character: token.character } });
				continue;
			}
			const opening = closingDelimiter(token.value);
			if (opening !== null && delimiters[delimiters.length - 1]?.value === opening) delimiters.pop();
		}

		const continues = delimiters.length > 0 || line.endsInString || lineContinues(lexed, line.line);
		if (logicalStart !== null && !continues) {
			const headerRange = blockHeaderRange(lexed, line.line);
			if (headerRange !== null) pendingHeader = { indent: logicalStart.indent, range: headerRange };
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
