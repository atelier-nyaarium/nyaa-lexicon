import { defined, type NoteAuthor } from "@nyaa-lexicon/protocol";
import { z } from "zod";
import { renderNote, renderNoteBacklinks, renderNoteOutcome } from "../render.js";
import type { SymbolArgs, ToolBackend, ToolResult } from "../result.js";
import { textResult as text } from "../result.js";
import { moduleOf, resolveOne, withIndexState } from "./shared.js";

////////////////////////////////
//  Schemas

const NOTE_SUBJECT = {
	name: z.string().min(1).optional().describe(`Symbol name. Add \`module\` when needed.`),
	symbolId: z.string().min(1).optional().describe(`Exact \`symbolId\` from an earlier result.`),
	module: z.string().min(1).optional().describe(`Workspace-relative module path.`),
};

export const ReadNoteInput = NOTE_SUBJECT;

// Core caps the length.
export const WriteNoteInput = {
	...NOTE_SUBJECT,
	text: z.string().describe(`Markdown for the note. Empty removes it.`),
	expectedRevision: z
		.number()
		.int()
		.nonnegative()
		.describe(`The revision \`read_note\` showed. \`0\` when none stands.`),
};

export const NoteBacklinksInput = {
	name: z.string().min(1).optional().describe(`Symbol name. Add \`module\` when needed.`),
	symbolId: z.string().min(1).optional().describe(`Exact \`symbolId\` from an earlier result.`),
	module: z
		.string()
		.min(1)
		.optional()
		.describe(`Workspace-relative path. Alone: notes naming that file. With \`name\`: which \`name\`.`),
	limit: z.number().int().positive().max(200).optional().describe(`Maximum notes. Default: \`50\`.`),
};

////////////////////////////////
//  Constants

export const READ_NOTE_DESCRIPTION = `
# Read Note

Show a symbol's note: its text, revision and advisories.

Refs read at their targets' current addresses. Advisories report source changes and broken or changed refs.
`.trim();

export const WRITE_NOTE_DESCRIPTION = `
# Write Note

Write or replace a symbol's note. Read it first; pass its revision as \`expectedRevision\`, \`0\`
when none stands.

Describe this symbol in 1 short sentence.

Include additional notes like related symbols, configs, traps, known pain points, or whatever.

Use this project's workspace key from \`list_projects\`: \`[label](project-ref://<workspace-key>/path:Scope:Name)\` for a symbol or \`[label](project-ref://<workspace-key>/path)\` for a file. Notes only link within their own project; broken or foreign-project refs are refused.
`.trim();

export const NOTE_BACKLINKS_DESCRIPTION = `
# Note Backlinks

List notes whose refs name a symbol, or a file given as \`module\` alone.
`.trim();

////////////////////////////////
//  Handlers

export async function readNote(backend: ToolBackend, args: SymbolArgs): Promise<ToolResult> {
	const resolved = await resolveOne(backend, args);
	if ("problem" in resolved) return text(await withIndexState(backend, resolved.problem, args.module), true);

	const note = await backend.readNote(resolved.symbolId);
	const body = renderNote(resolved.symbolId, note);
	return text(note === null ? await withIndexState(backend, body, moduleOf(resolved.symbolId)) : body);
}

export async function writeNote(
	backend: ToolBackend,
	args: SymbolArgs & { text: string; expectedRevision: number; author?: NoteAuthor | undefined },
): Promise<ToolResult> {
	const resolved = await resolveOne(backend, args);
	if ("problem" in resolved) return text(await withIndexState(backend, resolved.problem, args.module), true);

	const outcome = await backend.writeNote({
		symbolId: resolved.symbolId,
		text: args.text,
		expectedRevision: args.expectedRevision,
		...defined({ author: args.author }),
	});
	return text(renderNoteOutcome(resolved.symbolId, outcome), outcome.outcome === "refused");
}

/** A module given alone names the file itself. */
export async function noteBacklinks(
	backend: ToolBackend,
	args: SymbolArgs & { limit?: number | undefined },
): Promise<ToolResult> {
	let target: string;
	if (args.symbolId === undefined && args.name === undefined && args.module !== undefined) {
		target = args.module;
	} else {
		const resolved = await resolveOne(backend, args);
		if ("problem" in resolved) return text(await withIndexState(backend, resolved.problem, args.module), true);
		target = resolved.symbolId;
	}

	const found = await backend.noteBacklinks(target, args.limit);
	const body = renderNoteBacklinks(target, found);
	return text(found.total === 0 ? await withIndexState(backend, body, moduleOf(target) ?? target) : body);
}
