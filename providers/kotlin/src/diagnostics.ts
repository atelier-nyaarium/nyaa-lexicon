import type { Diagnostic } from "@nyaa-lexicon/protocol";
import type { LineTable } from "./tree.js";

export interface SyntaxProblem {
	message: string;
	start: number;
	end: number;
}

/** The parser follows the specification, so every problem is text no valid source produces. */
export function syntaxDiagnostics(module: string, problems: readonly SyntaxProblem[], lines: LineTable): Diagnostic[] {
	return problems.map((problem) => ({
		severity: "error",
		message: `${problem.message.charAt(0).toUpperCase()}${problem.message.slice(1)}.`,
		range: lines.range(problem.start, problem.end),
		path: module,
	}));
}
