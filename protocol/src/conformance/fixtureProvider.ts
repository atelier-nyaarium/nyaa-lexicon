// The reference provider with a rename and a move, so a refactor can be driven through the
// daemon's own handlers against a grammar that fits on one line. Run as `bun <this file>`.

import { coordinatesOf } from "../coordinates.js";
import { defined } from "../defined.js";
import type { TextEdit } from "../edits.js";
import type {
	ArrangeEditsRequest,
	ArrangeMember,
	MoveBlockedSite,
	MoveDependency,
	MoveEditsRequest,
	MoveEditsResponse,
} from "../move.js";
import type { BlockedSite, RenameEditsRequest, RenameEditsResponse } from "../rename.js";
import { notImplementedMove, type ProviderHandlers, runProviderOnStdio } from "../serve.js";
import { PROTOCOL_VERSION } from "../version.js";
import {
	extractDeclarations,
	makeReferenceMoveEdits,
	REFERENCE_TIERS,
	REFERENCE_WORDS,
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

/** No import is written, so each blocks. */
function dependencyBlocks(dependencies: readonly MoveDependency[]): MoveBlockedSite[] {
	return dependencies.map((dependency) => ({
		...defined({ range: dependency.range }),
		reason: "NotImplemented" as const,
		detail: `the fixture provider writes no import for ${dependency.name}`,
	}));
}

/** The source loses its removal range, the target gains the insertion; a dependency is blocked, since no import is written. */
export function makeFixtureMoveEdits(request: MoveEditsRequest): MoveEditsResponse {
	const { removal, insertion } = request.role;
	if (removal === undefined && insertion === undefined) return makeReferenceMoveEdits(request);
	if (
		insertion !== undefined &&
		// A reorder's module already holds the moved name.
		request.fromModule !== request.toModule &&
		request.exists &&
		extractDeclarations(request.module, request.text).some((declaration) => declaration.name === request.name)
	) {
		return { status: "refused", reason: "TargetCollision" };
	}

	const blocked = dependencyBlocks(request.dependencies);
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
		const leading =
			insertion.position === undefined && request.text.length > 0 && !request.text.endsWith("\n") ? "\n" : "";
		const trailing = insertion.text.endsWith("\n") ? "" : "\n";
		edits.push({ range: at, newText: `${leading}${insertion.text}${trailing}` });
	}
	return { status: "ready", edits, blocked };
}

/** Each member's import sites repointed as one moved symbol's. */
function repointArrangeImports(request: ArrangeEditsRequest): MoveEditsResponse {
	if (request.members.length === 0) return notImplementedMove("the fixture provider arranges no members");
	const edits: TextEdit[] = [];
	const blocked: MoveBlockedSite[] = [];
	for (const member of request.members) {
		const answer = makeReferenceMoveEdits({
			module: request.module,
			text: request.text,
			exists: request.exists,
			symbolId: member.symbolId,
			name: member.name,
			fromModule: request.fromModule,
			toModule: request.toModule,
			role: {},
			importSites: request.importSites.filter((site) => site.symbolId === member.symbolId),
			dependencies: request.dependencies,
			sites: member.sites,
		});
		if (answer.status === "refused") return answer;
		edits.push(...answer.edits);
		blocked.push(...answer.blocked);
	}
	return { status: "ready", edits, blocked };
}

/**
 * Removals become empty edits, and insertions sharing a position one edit in member order. A module
 * whose members carry neither repoints its imports.
 */
export function makeFixtureArrangeEdits(request: ArrangeEditsRequest): MoveEditsResponse {
	const moving = (member: ArrangeMember) => member.removal !== undefined || member.insertion !== undefined;
	if (!request.members.some(moving)) return repointArrangeImports(request);
	if (request.fromModule !== request.toModule && request.exists) {
		const held = new Set(extractDeclarations(request.module, request.text).map((declaration) => declaration.name));
		// Incoming members carry no removal.
		const collides = request.members.find(
			(member) => member.insertion !== undefined && member.removal === undefined && held.has(member.name),
		);
		if (collides !== undefined) {
			return {
				status: "refused",
				reason: "TargetCollision",
				detail: `${request.module} declares ${collides.name}`,
			};
		}
	}

	const coordinates = coordinatesOf(request.text);
	const edits: TextEdit[] = [];
	const groups = new Map<number, TextEdit>();
	for (const member of request.members) {
		if (member.removal !== undefined) edits.push({ range: member.removal, newText: "" });
		// Toy declarations are always exported.
		const insertion = member.insertion;
		if (insertion === undefined) continue;
		const offset = coordinates.offsetAt(insertion.position);
		const at = offset === undefined ? undefined : coordinates.rangeAt(offset, offset);
		if (offset === undefined || at === undefined) {
			return { status: "refused", reason: "ParseError", detail: "the insertion point is outside the module" };
		}
		const group = groups.get(offset);
		if (group === undefined) groups.set(offset, { range: at, newText: insertion.text });
		else group.newText += insertion.text;
	}
	edits.push(...groups.values());

	const blocked: MoveBlockedSite[] = [
		// Travels with the members.
		...dependencyBlocks(request.dependencies.filter((dependency) => dependency.origin.kind !== "insideClosure")),
		...request.importSites.map((site) => ({
			range: site.range,
			reason: "NotImplemented" as const,
			detail: `the fixture provider removes no import from ${site.specifier}`,
		})),
		...request.members.flatMap((member) =>
			member.sites.map((range) => ({
				range,
				reason: "NotImplemented" as const,
				detail: `the fixture provider rewrites no qualified use of ${member.name}`,
			})),
		),
	];
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
		words: REFERENCE_WORDS,
	}),
	renameEdits: makeFixtureRenameEdits,
	moveEdits: makeFixtureMoveEdits,
	arrangeEdits: makeFixtureArrangeEdits,
};

// `--no-arrange` declines arranging, as most languages do.
if (import.meta.main) {
	runProviderOnStdio(
		process.argv.includes("--no-arrange")
			? { ...fixtureHandlers, arrangeEdits: () => notImplementedMove("this fixture run does not arrange") }
			: fixtureHandlers,
	);
}
