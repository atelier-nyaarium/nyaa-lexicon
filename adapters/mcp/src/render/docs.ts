import { countLabel, pagingNotes, renderGroupedModules } from "./shared/grouping.js";
import { code, indent } from "./shared/markdown.js";
import type { CommentsResult, DocsResult, LiteralsResult } from "./shared/types.js";

export function renderComments(result: CommentsResult): string {
	if (result.count.count === 0) {
		return `# Comments\n\nNo comment matched.\n\n> Searches normalized prose, so markers and line wrapping are not matched.${pagingNotes(result.count, 0, "comment")}`;
	}

	const byModule = new Map<string, string[]>();
	for (const comment of result.comments) {
		const rows = byModule.get(comment.module) ?? [];
		// The anchor is the hop from prose back to structure, which is the whole reason a comment is
		// a fact rather than a grep hit.
		const about =
			comment.anchor === null
				? `${comment.form} (module)`
				: `${comment.form} ${code(comment.anchor.name)} (${comment.anchor.kind})`;
		rows.push(
			`- Line ${comment.range.start.line + 1}: ${about}\n  ${code(comment.factId)}\n${indent(comment.raw)}`,
		);
		byModule.set(comment.module, rows);
	}

	const body = renderGroupedModules(countLabel(result.count, "comment"), byModule);
	return body + pagingNotes(result.count, result.comments.length, "comment");
}

export function renderDocs(result: DocsResult): string {
	if (result.count.count === 0) {
		return `# Documentation\n\nNo documentation matched.\n\n> Searches normalized text, so line wrapping is not matched.${pagingNotes(result.count, 0, "region")}`;
	}

	const byModule = new Map<string, string[]>();
	for (const region of result.docs) {
		const rows = byModule.get(region.module) ?? [];
		// The heading path is the hop from prose back to structure, and the whole reason this answers
		// differently from a comment search.
		const under = region.headingPath.length === 0 ? "(no heading)" : region.headingPath.join(" > ");
		const where = region.fenced ? `${under}  [in a code block]` : under;
		const location =
			region.hit === undefined
				? `Line ${region.range.start.line + 1}`
				: `Line ${region.hit.line + 1}:${region.hit.character + 1}`;
		rows.push(`- ${location}: ${where}\n  ${code(region.factId)}\n${indent(region.raw)}`);
		byModule.set(region.module, rows);
	}

	const body = renderGroupedModules(countLabel(result.count, "region"), byModule);
	return body + pagingNotes(result.count, result.docs.length, "region");
}

/** Literal hits, grouped by file. */
export function renderLiterals(result: LiteralsResult): string {
	if (result.count.count === 0) {
		return `# Literals\n\nNo literal matched.\n\n> Searches decoded values, not source text.${pagingNotes(result.count, 0, "literal")}`;
	}

	const byModule = new Map<string, string[]>();
	for (const literal of result.literals) {
		const rows = byModule.get(literal.module) ?? [];
		const shown = literal.value.length > 60 ? `${literal.value.slice(0, 60)}...` : literal.value;
		// The containing declaration is the hop from text to structure, and it matters most where
		// names are mangled: the literal is then the only readable thing pointing at its symbol. The
		// module prefix is dropped because the row already sits under its module header.
		const container =
			literal.containerName === undefined
				? literal.containerId === null
					? ""
					: `  in ${code(literal.containerId.split(" ").slice(3).join(" "))}`
				: `  in ${literal.containerKind ?? "declaration"} ${code(literal.containerName)}`;
		rows.push(`- Line ${literal.range.start.line + 1}: **${literal.kind}** ${JSON.stringify(shown)}${container}`);
		byModule.set(literal.module, rows);
	}

	const body = renderGroupedModules(countLabel(result.count, "literal"), byModule);
	return body + pagingNotes(result.count, result.literals.length, "literal");
}
