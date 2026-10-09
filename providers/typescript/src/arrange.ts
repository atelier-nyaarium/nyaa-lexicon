// One module's part of an arrangement: what leaves it, what lands or reorders in it, and the
// imports both need.

import type {
	ArrangeEditsRequest,
	ArrangeImportSite,
	MoveBlockedSite,
	MoveEditsResponse,
	OffsetRange,
	TextEdit,
	WorkMeter,
} from "@nyaa-lexicon/protocol";
import type ts from "typescript";
import {
	exportedText,
	exportInPlace,
	moduleScope,
	parseDiagnostics,
	planImports,
	removalOf,
	targetDeclares,
	validateEdits,
} from "./move.js";
import { sameModulePath } from "./move-dependencies.js";
import { blockedSite } from "./move-imports.js";
import { settleBlankLines } from "./move-layout.js";
import { type Leaving, orphanedImports, repointLeavingExports } from "./move-sites.js";
import type { ModuleResolver, SpecifierRenderer } from "./project.js";

////////////////////////////////
//  Main

export function makeArrangeEdits(
	request: ArrangeEditsRequest,
	source: ts.SourceFile,
	checker: ts.TypeChecker | undefined,
	renderSpecifier: SpecifierRenderer,
	resolveModule: ModuleResolver,
	/** The module runs as an ECMAScript module. */
	esm: boolean,
	meter?: WorkMeter,
): MoveEditsResponse {
	if (parseDiagnostics(source).length > 0) {
		return { status: "refused", reason: "ParseError", detail: "the module contains syntax errors" };
	}

	const scope = moduleScope(request.module, source, checker, renderSpecifier, resolveModule, esm, meter);
	const { coordinates } = scope;
	const target = sameModulePath(request.module, request.toModule);
	if (target && request.exists) {
		// Only arriving members lack a removal here.
		const taken = request.members.find(
			(member) =>
				!member.comment &&
				member.removal === undefined &&
				targetDeclares(scope, member.name, request.fromModule),
		);
		if (taken !== undefined) {
			return {
				status: "refused",
				reason: "TargetCollision",
				detail: `the target already declares ${taken.name}`,
			};
		}
	}

	const blocked: MoveBlockedSite[] = [];
	const edits: TextEdit[] = [];
	const leaving: Leaving[] = [];
	for (const member of request.members) {
		if (member.removal === undefined) continue;
		if (member.comment) {
			edits.push({ range: member.removal, newText: "" });
			continue;
		}
		const removal = removalOf(scope, member.removal, member.name);
		if ("blocked" in removal) blocked.push(removal.blocked);
		else {
			leaving.push({ name: member.name, removed: removal.removed });
			edits.push({ range: member.removal, newText: "" });
		}
	}
	const removed = leaving.map((member) => member.removed);
	let repointed: OffsetRange[] = [];
	// The target keeps every import and export.
	if (!target && leaving.length > 0) {
		const exports = repointLeavingExports(
			source,
			coordinates,
			leaving,
			() => scope.render(request.module, request.toModule, undefined, scope.style),
			scope.quote,
		);
		edits.push(...orphanedImports(source, coordinates, removed), ...exports.edits);
		blocked.push(...exports.blocked);
		repointed = exports.spans;
	}

	// Members sharing a point land as one edit, in member order.
	const landings = new Map<number, TextEdit>();
	for (const member of request.members) {
		const insertion = member.insertion;
		if (insertion === undefined) continue;
		const offset = coordinates.offsetAt(insertion.position);
		const point = offset === undefined ? undefined : coordinates.positionAt(offset);
		if (offset === undefined || point === undefined) {
			const at = { start: insertion.position, end: insertion.position };
			blocked.push(blockedSite(at, "ParseError", "the insertion position is outside the module"));
			continue;
		}
		const text = insertion.exported === true ? exportedText(insertion.text, request.module) : insertion.text;
		const landing = landings.get(offset);
		if (landing === undefined) landings.set(offset, { range: { start: point, end: point }, newText: text });
		else landing.newText += text;
	}

	const names = new Map(request.members.map((member) => [member.symbolId, member.name]));
	const importSites: ArrangeImportSite[] = [];
	for (const site of request.importSites) {
		if (names.has(site.symbolId)) importSites.push(site);
		else blocked.push(blockedSite(site.range, "NotImplemented", "the import names no member of the arrangement"));
	}
	planImports(
		scope,
		{
			module: request.module,
			fromModule: request.fromModule,
			toModule: request.toModule,
			nameOf: (site) => names.get(site.symbolId) as string,
			importSites,
			sites: request.members.flatMap((member) => member.sites),
			// The target's own members stay bound.
			removed: target ? [] : [...removed, ...repointed],
			landings: [...landings.values()],
			dependencies: request.dependencies,
		},
		edits,
		blocked,
	);
	// After the imports, which may share a point.
	edits.push(...landings.values());

	const promoted = exportInPlace(source, request.module, request.exportInPlace ?? []);
	edits.push(...promoted.edits);
	return validateEdits(coordinates, settleBlankLines(source.text, coordinates, edits), blocked, promoted.ids);
}
