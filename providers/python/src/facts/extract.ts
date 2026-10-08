// One Python file's facts: parsed in-house, then analyzed; comments and blank lines come from the
// tokens, so a file the parser refuses still has them.

import { TOO_DEEP, type WorkMeter } from "@nyaa-lexicon/protocol";
import { parsePython } from "../syntax/parser.js";
import { Analyzer } from "./analyzer.js";
import { Source } from "./source.js";
import { blankLines, commentSpans } from "./trivia.js";
import type { RawFacts } from "./types.js";

export function extractFacts(module: string, text: string, meter?: WorkMeter): RawFacts {
	const parsed = parsePython(Source.parsedText(text));
	const source = new Source(text, parsed.tokens);
	const comments = commentSpans(source);
	const blank = blankLines(source, parsed.lexError === undefined);
	if (parsed.module === undefined) {
		const error = parsed.error ?? { message: "invalid syntax", pos: 0 };
		const message =
			error.message === TOO_DEEP
				? TOO_DEEP
				: `parse error: ${error.message} (${module}, line ${source.line(Math.min(error.pos, source.parsed.length)) + 1})`;
		return {
			declarations: [],
			references: [],
			imports: [],
			exports: null,
			allList: null,
			importStatements: [],
			role: { kind: "unknown", reason: "ParseError" },
			prologueEnd: null,
			importBindings: [],
			scopeInfos: [],
			typeAnnotations: [],
			inferredTypes: [],
			literals: [],
			comments,
			blankLines: blank,
			diagnostics: [{ severity: "error", message }],
		};
	}
	return { ...new Analyzer(source, parsed.module, meter).analyze(), comments, blankLines: blank };
}
