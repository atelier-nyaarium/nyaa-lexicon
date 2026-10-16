import { code } from "./markdown.js";
import type { SymbolSummary } from "./types.js";

function line(summary: SymbolSummary): string {
	// Three states, not two. A language with no notion of module export renders its visibility
	// without implying the answer was no.
	const exported = summary.exported === true ? "" : ` (${summary.visibility})`;
	const valueStatus = summary.valueStatus === undefined ? "" : ` (${summary.valueStatus})`;
	const signature = summary.signature === undefined ? "" : `: ${code(summary.signature)}`;
	return `**${summary.kind}** ${code(summary.name)}${valueStatus}${exported}${signature}`;
}

function symbolBullet(summary: SymbolSummary): string {
	return `- ${line(summary)}`;
}

export { line, symbolBullet };
