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
	const confirmed = note.confirmedAt === null ? "" : `, confirmed by ${authorName(note.confirmedBy)}`;
	return `Revision ${note.revision}, written by ${authorName(note.author)}${edited}${confirmed}.`;
}

/** What moved since the revision was written, one bullet each. */
function noteAdvisories(note: Note): string[] {
	const found: string[] = [];
	if (note.sourceChanged) found.push(`- **Source changed; review:** the symbol changed since this revision.`);
	for (const link of note.links.filter((entry) => entry.state === "broken")) {
		found.push(`- **Broken ref:** ${code(link.written)} names nothing now.`);
	}
	const changed = note.links.filter((entry) => entry.state === "changed");
	if (changed.length > 0) {
		found.push(
			`- **Changed refs:** ${changed.map((link) => code(link.current)).join(", ")} changed since this revision.`,
		);
	}
	if (note.doubt !== null) {
		found.push(`- **Doubted** by ${authorName(note.doubt.by)}: ${note.doubt.reason}`);
	}
	if (note.proposal !== null) {
		found.push(`- **Proposal pending:** a replacement from ${authorName(note.proposal.by)} waits on a person.`);
	}
	return found;
}

/** A whole note, or where none stands. */
export function renderNote(symbolId: string, note: Note | null): string {
	if (note === null) return `# Note on ${code(symbolId)}\n\nNo note stands. \`write_note\` writes one.`;

	const lines = [
		`
# Note on ${code(symbolId)}

${provenance(note)}

${note.text}
		`.trim(),
	];
	const advisories = noteAdvisories(note);
	if (advisories.length > 0)
		lines.push(`
## Advisories

${advisories.join("\n")}`);
	return lines.join("\n");
}

/** The note's summary and advisories, for a describe. */
export function renderNoteLine(note: Note | null): string {
	if (note === null) return `## Note\n\nNo note stands.`;

	const more = note.summary === null || note.text.slice(note.restAt).trim() !== "";
	const lead = `${note.summary ?? "No summary."}${more ? " `read_note` shows the rest." : ""}`;
	const lines = [`## Note`, "", lead, "", provenance(note)];
	const advisories = noteAdvisories(note);
	if (advisories.length > 0) lines.push("", ...advisories);
	return lines.join("\n");
}

/** What a write or a doubt did. */
export function renderNoteOutcome(symbolId: string, outcome: NoteOutcome, action: "write" | "doubt"): string {
	if (outcome.outcome === "refused") {
		const reason = /[.!?]$/.test(outcome.reason) ? outcome.reason : `${outcome.reason}.`;
		const lines = [`# ${action === "doubt" ? "Doubt not recorded" : "Note not saved"}`, "", reason];
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
	if (outcome.outcome === "proposed") {
		return `# Proposal saved\n\n**Symbol:** ${code(symbolId)}\n\nA person wrote or confirmed revision ${outcome.note.revision}, so this waits for them.`;
	}
	if (outcome.note === null) return `# No note stands\n\n**Symbol:** ${code(symbolId)}\n\nThe text was empty.`;
	if (action === "doubt") {
		return `# Doubt recorded\n\n**Symbol:** ${code(symbolId)}\n\nOn revision ${outcome.note.revision}. The next save or confirm clears it.`;
	}
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
