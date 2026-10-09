// One module's part of an arrangement, under the same GDScript rules as a move.

import {
	type ArrangeEditsRequest,
	type ArrangeMember,
	comparePositions,
	coordinatesOf,
	type MoveEditsResponse,
	type Position,
	type TextEdit,
} from "@nyaa-lexicon/protocol";
import { GDScriptBindingIndex } from "./binding.js";
import type { GDScriptStore } from "./module.js";
import {
	addImportSiteBlocks,
	addInsertion,
	addRemoval,
	addSiteBlocks,
	admitModule,
	dependencyEdits,
	isClassNameMove,
	type MovePlan,
	sameModule,
	targetCollision,
	validateEdits,
} from "./move.js";

////////////////////////////////
//  Main

export function makeArrangeEdits(request: ArrangeEditsRequest, store: GDScriptStore): MoveEditsResponse {
	const bindings = new GDScriptBindingIndex(store);
	const facts = admitModule(request.module, request.toModule, request.text);
	if ("status" in facts) return facts;
	const coordinates = coordinatesOf(request.text);
	// Only the target's own declarations move: every binding stays.
	const reorder = sameModule(request.fromModule, request.toModule);
	if (request.exists && !reorder && sameModule(request.module, request.toModule)) {
		const arrivals = request.members.flatMap((member) =>
			member.comment || member.insertion === undefined || member.removal !== undefined
				? []
				: [{ name: member.name, text: member.insertion.text }],
		);
		const collision = targetCollision(request.module, request.text, request.toModule, facts.declarations, arrivals);
		if (collision !== undefined) return collision;
	}

	if (
		!request.exists &&
		request.members.every((member) => member.removal === undefined && member.insertion === undefined)
	) {
		return { status: "refused", reason: "NotImplemented", detail: "the target request has no arrange role" };
	}

	const plan: MovePlan = { edits: [], blocked: [] };
	for (const member of request.members) {
		if (member.removal !== undefined) {
			if (member.comment) plan.edits.push({ range: member.removal, newText: "" });
			else addRemoval(plan, coordinates, member.removal);
		}
	}
	addImportSiteBlocks(plan, coordinates, request.importSites);
	for (const member of request.members) {
		addSiteBlocks(
			plan,
			coordinates,
			member.sites,
			() =>
				!member.comment &&
				isClassNameMove(bindings, member.symbolId, member.name, request.toModule, member.insertion?.text),
		);
	}
	if (!reorder) {
		const loaders = dependencyEdits(
			request.fromModule,
			request.text,
			coordinates,
			request.dependencies,
			bindings,
			facts,
		);
		plan.edits.push(...loaders.edits.map((edit) => outsideRemovals(edit, request.members)));
		plan.blocked.push(...loaders.blocked);
	}
	// No export form, so `exported` asks for nothing.
	for (const group of insertionGroups(request.members)) {
		addInsertion(plan, request.text, coordinates, group.position, group.text);
	}
	return validateEdits(coordinates, plan);
}

////////////////////////////////
//  Edits

/** Members sharing a position, joined in member order. */
function insertionGroups(members: readonly ArrangeMember[]): Array<{ position: Position; text: string }> {
	const groups = new Map<string, { position: Position; text: string }>();
	for (const { insertion } of members) {
		if (insertion === undefined) continue;
		const key = `${insertion.position.line}:${insertion.position.character}`;
		const group = groups.get(key);
		if (group === undefined) groups.set(key, { position: insertion.position, text: insertion.text });
		else group.text += insertion.text;
	}
	return [...groups.values()];
}

/** A loader line inside a removed span lands where the span starts. */
function outsideRemovals(edit: TextEdit, members: readonly ArrangeMember[]): TextEdit {
	const point = edit.range.start;
	const removal = members.find(
		({ removal }) =>
			removal !== undefined &&
			comparePositions(removal.start, point) < 0 &&
			comparePositions(point, removal.end) < 0,
	)?.removal;
	return removal === undefined ? edit : { ...edit, range: { start: removal.start, end: removal.start } };
}
