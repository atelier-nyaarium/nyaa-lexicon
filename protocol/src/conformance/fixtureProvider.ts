// The reference provider with a rename and a move, so a refactor can be driven through the
// daemon's own handlers against a grammar that fits on one line. Run as `bun <this file>`.

import { coordinatesOf } from "../coordinates.js";
import type { TextEdit } from "../edits.js";
import type { MoveBlockedSite, MoveEditsRequest, MoveEditsResponse } from "../move.js";
import type { BlockedSite, RenameEditsRequest, RenameEditsResponse } from "../rename.js";
import { type ProviderHandlers, runProviderOnStdio } from "../serve.js";
import { PROTOCOL_VERSION } from "../version.js";
import {
	extractDeclarations,
	makeReferenceMoveEdits,
	REFERENCE_TIERS,
	referenceHandlers,
} from "./referenceProvider.js";

////////////////////////////////
//  Constants

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

////////////////////////////////
//  Functions & Helpers

/** Every site that spells the old name is rewritten; one that does not is blocked, never guessed at. */
export function makeFixtureRenameEdits(request: RenameEditsRequest): RenameEditsResponse {
	if (!IDENTIFIER.test(request.newName)) {
		return { status: "refused", reason: "InvalidName", detail: `${request.newName} is not an identifier` };
	}
	// The grammar owns no parameters, so absent means unowned; a call handed over is one it cannot rewrite.
	if (request.ownerCalls !== undefined && request.ownerCalls.length > 0) {
		return { status: "refused", reason: "NotImplemented", detail: "the fixture provider rewrites no owner call" };
	}
	const coordinates = coordinatesOf(request.text);
	const edits: TextEdit[] = [];
	const blocked: BlockedSite[] = [];
	for (const site of request.sites) {
		const start = coordinates.offsetAt(site.range.start);
		const end = coordinates.offsetAt(site.range.end);
		if (start === undefined || end === undefined || request.text.slice(start, end) !== request.oldName) {
			blocked.push({
				range: site.range,
				reason: "ParseError",
				detail: `the site does not spell ${request.oldName}`,
			});
			continue;
		}
		edits.push({ range: site.range, newText: request.newName });
	}
	return { status: "ready", edits, blocked };
}

/** The source loses its removal range, the target gains the insertion; a dependency is blocked, since no import is written. */
export function makeFixtureMoveEdits(request: MoveEditsRequest): MoveEditsResponse {
	const { removal, insertion } = request.role;
	if (removal === undefined && insertion === undefined) return makeReferenceMoveEdits(request);
	if (
		insertion !== undefined &&
		request.exists &&
		extractDeclarations(request.module, request.text).some((declaration) => declaration.name === request.name)
	) {
		return { status: "refused", reason: "TargetCollision" };
	}

	const blocked: MoveBlockedSite[] = request.dependencies.map((dependency) => ({
		...(dependency.range === undefined ? {} : { range: dependency.range }),
		reason: "NotImplemented" as const,
		detail: `the fixture provider writes no import for ${dependency.name}`,
	}));
	const edits: TextEdit[] = [];
	if (removal !== undefined) edits.push({ range: removal, newText: "" });
	if (insertion !== undefined) {
		const coordinates = coordinatesOf(request.text);
		const offset =
			insertion.position === undefined ? request.text.length : coordinates.offsetAt(insertion.position);
		const at = offset === undefined ? undefined : coordinates.rangeAt(offset, offset);
		if (at === undefined) {
			return { status: "refused", reason: "ParseError", detail: "the insertion point is outside the module" };
		}
		const leading = request.text.length > 0 && !request.text.endsWith("\n") ? "\n" : "";
		const trailing = insertion.text.endsWith("\n") ? "" : "\n";
		edits.push({ range: at, newText: `${leading}${insertion.text}${trailing}` });
	}
	return { status: "ready", edits, blocked };
}

////////////////////////////////
//  Main

export const fixtureHandlers: ProviderHandlers = {
	...referenceHandlers,
	initialize: () => ({
		providerId: "fixture-provider",
		language: "reference",
		extensions: [".ref"],
		protocolVersion: PROTOCOL_VERSION,
		tiers: REFERENCE_TIERS,
	}),
	renameEdits: makeFixtureRenameEdits,
	moveEdits: makeFixtureMoveEdits,
};

if (import.meta.main) runProviderOnStdio(fixtureHandlers);
