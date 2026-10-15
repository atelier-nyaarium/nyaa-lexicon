import type { SymbolSummary } from "@nyaa-lexicon/core";
import { searchTerm } from "@nyaa-lexicon/core";
import { parseSymbolId } from "@nyaa-lexicon/protocol";
import { renderCandidates } from "../render.js";
import type { SymbolArgs, ToolBackend, ToolResult } from "../result.js";
import { textResult as text } from "../result.js";

const WITHIN_NOTE = `Scope: a symbol id from an earlier result, or a declaration name. An ambiguous name is refused with its candidates.`;

////////////////////////////////
//  Functions & Helpers

/** Projects already told their index holds outline facts. */
const toldOutline = new WeakSet<ToolBackend>();

/**
 * Says so when an answer came from an index that is still being built.
 *
 * The daemon serves before its first scan finishes, so that a session gets answers immediately
 * rather than waiting out a whole workspace. That trade is only honest if a partial answer says it
 * is partial: without this line, "no references found" during a scan is indistinguishable from
 * the same sentence once everything has been read.
 *
 * Every ABSENCE goes through here, including "no symbol named X is indexed". That one is the most
 * common answer of all during a cold scan, and the first version of this missed it.
 */
async function withIndexState(backend: ToolBackend, body: string, concerning?: string): Promise<string> {
	// The notes are optional; a status read that fails never costs the answer.
	const status = await backend.indexStatus(concerning).catch(() => null);
	if (status === null) return body;
	const notes: string[] = [];

	// Concerning file first.
	const retry = `Fix what the reason names and save; a changed file is re-read at once, an unchanged one on the next scan.`;
	if (status.concerning !== undefined) {
		notes.push(
			`\`${status.concerning.module}\`, the file this answer concerns, failed to parse: ${oneLine(status.concerning.reason)}. Its facts are missing or predate the failure. ${retry}`,
		);
	}
	const others = status.failures - (status.concerning === undefined ? 0 : 1);
	if (others > 0) {
		const named = status.failed.filter((failure) => failure.module !== status.concerning?.module);
		const more = others - named.length;
		const list =
			named.length === 0
				? ""
				: `: ${named.map((failure) => `\`${failure.module}\` (${oneLine(failure.reason)})`).join(", ")}${more > 0 ? `, and ${more} more` : ""}`;
		notes.push(
			`${others} ${status.concerning === undefined ? "" : `other `}file${others === 1 ? "" : "s"} failed to parse; facts indexed before each failure were kept${list}. \`overview\` lists every one.${status.concerning === undefined ? ` ${retry}` : ""}`,
		);
	}

	// Outline facts make reference and literal counts lower bounds; said once per project per session.
	const outline = status.outlineFiles ?? 0;
	if (outline > 0) {
		if (!toldOutline.has(backend)) {
			toldOutline.add(backend);
			notes.push(
				`${outline} of ${outline + (status.fullFiles ?? 0)} files hold outline facts only (names and imports), so reference and literal counts are lower bounds until the upgrade finishes.`,
			);
		}
	} else if (status.state !== "ready") {
		// A stored index remains usable during a rescan, but edited files may be missing.
		if (status.stored > 0) {
			const progress = status.total > 0 ? ` (${status.done} of ${status.total})` : "";
			notes.push(
				`Answered from an index of ${status.stored} files. A rescan is in progress${progress}, so anything edited since the last scan may not be reflected.`,
			);
		} else if (status.state === "warming" || status.state === "indexing") {
			notes.push(`Still indexing: ${status.done} of ${status.total} files read. This answer may be incomplete.`);
		} else {
			notes.push(`The index has not been built yet, so this answer covers nothing.`);
		}
	}

	return notes.length === 0 ? body : `${body}\n\n${notes.map((note) => `> ${note}`).join("\n")}`;
}

function oneLine(reason: string): string {
	return reason.replace(/\s+/g, " ").trim();
}

/** Refused before the round trip. */
function refusedTerm(...terms: Array<string | undefined>): ToolResult | undefined {
	for (const term of terms) {
		if (term === undefined) continue;
		try {
			searchTerm(term);
		} catch (error) {
			return text(error instanceof Error ? error.message : String(error), true);
		}
	}
	return undefined;
}

/** Symbol id to its file. */
function moduleOf(symbolId: string): string | undefined {
	return parseSymbolId(symbolId)?.module;
}

/**
 * Resolve what the caller gave into one symbol id.
 *
 * Several matches is an answer, not a failure: the caller is told which ones exist so it can pick,
 * rather than being handed a confident description of whichever happened to be first. A supplied id
 * is checked against the index and diagnosed on a miss, so every handler behind here says what a
 * writer says.
 */
async function resolveOne(backend: ToolBackend, args: SymbolArgs): Promise<{ symbolId: string } | { problem: string }> {
	if (args.symbolId) {
		// An id that names nothing is diagnosed once, here, so every handler behind this says the same thing.
		if ((await backend.declarationOf(args.symbolId)) === null)
			return { problem: await diagnosed(backend, args.symbolId) };
		return { symbolId: args.symbolId };
	}
	if (!args.name) return { problem: `Give either \`symbolId\` or \`name\`.` };

	const candidates = await backend.findByName(args.name, args.module);
	if (candidates.length === 0) return { problem: `No symbol named \`${args.name}\` is indexed.` };
	if (candidates.length > 1) return { problem: renderCandidates(args.name, candidates) };
	return { symbolId: (candidates[0] as SymbolSummary).symbolId };
}

/** The one sentence for an id that names nothing, the same one `write_note` composes. */
async function diagnosed(backend: ToolBackend, symbolId: string): Promise<string> {
	return (await backend.diagnoseSubject(symbolId)).reason;
}

export { diagnosed, moduleOf, refusedTerm, resolveOne, WITHIN_NOTE, withIndexState };
