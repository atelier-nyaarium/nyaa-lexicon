import { code } from "./shared/markdown.js";
import type { Note, NoteAuthor, NoteBacklinks, NoteOutcome } from "./shared/types.js";

/** Who, as the harness attested it. */
function authorName(author: NoteAuthor | null): string {
	if (author === null) return "unattributed";
	switch (author.kind) {
		case "person":
			return "a person";
		case "agent":
			return author.model ?? "an agent";
		case "client":
			return author.version === null ? author.name : `${author.name} ${author.version}`;
	}
}

/** Revision and who touched it, one line. */
function provenance(note: Note): string {
	const edited = note.revision > 1 ? `, last edited by ${authorName(note.editedBy)}` : "";
	return `Revision ${note.revision}, written by ${authorName(note.author)}${edited}.`;
}

/** What moved since the revision was written, one bullet each. */
function noteAdvisories(note: Note): string[] {
	const found: string[] = [];
	if (note.sourceChanged) found.push(`- **Source changed; review:** the symbol changed since this revision.`);
	for (const link of note.links.filter((entry) => entry.state === "broken")) {
		found.push(`- **Broken ref:** ${code(link.written)} names nothing now.`);
	}
	for (const link of note.links.filter((entry) => entry.state === "withheld")) {
		found.push(`- **Withheld ref:** ${code(link.written)} names a file withheld from the index.`);
	}
	const changed = note.links.filter((entry) => entry.state === "changed");
	if (changed.length > 0) {
		found.push(
			`- **Changed refs:** ${changed.map((link) => code(link.current)).join(", ")} changed since this revision.`,
		);
	}
	return found;
}

/** A symbol's whole note and advisories, as a section of a direct read. */
export function renderNoteSection(note: Note | null): string {
	if (note === null) return `## Note\n\nNo note stands. \`write_note\` writes one.`;

	const lines = [`## Note`, "", provenance(note), "", note.text];
	const advisories = noteAdvisories(note);
	if (advisories.length > 0) lines.push("", "### Advisories", "", ...advisories);
	return lines.join("\n");
}

/** What a write did. */
export function renderNoteOutcome(symbolId: string, outcome: NoteOutcome): string {
	if (outcome.outcome === "refused") {
		const reason = /[.!?]$/.test(outcome.reason) ? outcome.reason : `${outcome.reason}.`;
		const lines = [`# Note not saved`, "", reason];
		const refs = outcome.refs ?? [];
		if (refs.length > 0) lines.push("");
		for (const problem of refs) {
			const candidates =
				problem.candidates.length === 0
					? ""
					: ` Candidates: ${problem.candidates.map((candidate) => code(candidate)).join(", ")}.`;
			lines.push(`- ${code(problem.ref)} at offset ${problem.at}: ${problem.problem}.${candidates}`);
		}
		if (outcome.current !== undefined && outcome.current !== null) {
			lines.push("", `**Current revision:** ${outcome.current.revision}`);
		}
		return lines.join("\n");
	}
	if (outcome.note === null) return `# No note stands\n\n**Symbol:** ${code(symbolId)}\n\nThe text was empty.`;
	return `# Note saved\n\n**Symbol:** ${code(symbolId)}\n\nRevision ${outcome.note.revision}.`;
}

/** Notes whose refs name a symbol or file. */
export function renderNoteBacklinks(target: string, result: NoteBacklinks): string {
	if (result.notes.length === 0) return `# Notes naming ${code(target)}\n\nNo note names it.`;

	const lines = [`# Notes naming ${code(target)}`, ""];
	for (const entry of result.notes) {
		const summary = entry.summary === null ? "" : `: ${entry.summary}`;
		lines.push(`- ${code(entry.symbolId)}${summary}`);
	}
	if (result.total > result.notes.length)
		lines.push(`
> ${result.total - result.notes.length} more not shown. Raise \`limit\`.`);
	return lines.join("\n");
}
