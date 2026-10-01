import {
	coordinatesOf,
	type Declaration,
	MOVE_EDIT_CONFLICT,
	type MoveBlockedReason,
	type MoveBlockedSite,
	type MoveDependency,
	type MoveEditsRequest,
	type MoveEditsResponse,
	type MoveImportSite,
	normalizeModulePath,
	type Position,
	planEdits,
	type Range,
	SourceCursor,
	type TextCoordinates,
	type TextEdit,
} from "@nyaa-lexicon/protocol";
import { GDScriptBindingIndex } from "./binding.js";
import { isGdscriptIdentifier } from "./characters.js";
import { extractDeclarations, extractFile, type FileFacts } from "./extract.js";
import type { LoaderCall } from "./extractCore.js";
import { quoteGdscriptString } from "./lexer.js";
import { annotationLine, parseLineHeads } from "./line-syntax.js";
import type { GDScriptStore } from "./module.js";
import { isIgnorable, type LexedSource, lexSource } from "./tokens.js";

////////////////////////////////
//  Interfaces & Types

/** Edits and blocked sites, in the order found. */
export interface MovePlan {
	edits: TextEdit[];
	blocked: MoveBlockedSite[];
}

/** The target's own facts. */
export interface TargetFacts {
	declarations: Declaration[];
	loaders: LoaderCall[];
}

/** A name landing in the target, with its text when known. */
export interface Arrival {
	name: string;
	text: string | undefined;
}

////////////////////////////////
//  Main

export function makeMoveEdits(request: MoveEditsRequest, store: GDScriptStore): MoveEditsResponse {
	const bindings = new GDScriptBindingIndex(store);
	const facts = admitModule(request.module, request.toModule, request.text);
	if ("status" in facts) return facts;
	const coordinates = coordinatesOf(request.text);
	// Source and target at once: every binding stays.
	const reorder = sameModule(request.module, request.fromModule) && sameModule(request.module, request.toModule);
	if (request.exists && !reorder && sameModule(request.module, request.toModule)) {
		const collision = targetCollision(request.module, request.text, request.toModule, facts.declarations, [
			{ name: request.name, text: request.role.insertion?.text },
		]);
		if (collision !== undefined) return collision;
	}

	if (!request.exists && request.role.removal === undefined && request.role.insertion === undefined) {
		return { status: "refused", reason: "NotImplemented", detail: "the target request has no move role" };
	}

	const plan: MovePlan = { edits: [], blocked: [] };
	if (request.role.removal !== undefined) addRemoval(plan, coordinates, request.role.removal);
	addImportSiteBlocks(plan, coordinates, request.importSites);
	addSiteBlocks(plan, coordinates, request.sites, () =>
		isClassNameMove(bindings, request.symbolId, request.name, request.toModule, request.role.insertion?.text),
	);
	if (!reorder) {
		const loaders = dependencyEdits(
			request.fromModule,
			request.text,
			coordinates,
			request.dependencies,
			bindings,
			facts,
		);
		plan.edits.push(...loaders.edits);
		plan.blocked.push(...loaders.blocked);
	}
	if (request.role.insertion !== undefined) {
		addInsertion(plan, request.text, coordinates, request.role.insertion.position, request.role.insertion.text);
	}
	return validateEdits(coordinates, plan);
}

////////////////////////////////
//  Request

/** The module's facts, or the whole-request refusal. */
export function admitModule(module: string, toModule: string, text: string): FileFacts | MoveEditsResponse {
	if (!isValidModule(module) || !isValidModule(toModule)) {
		return {
			status: "refused",
			reason: "InvalidTarget",
			detail: "GDScript move targets must be workspace-relative .gd modules",
		};
	}
	const facts = extractFile(module, text);
	if (facts.diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
		return { status: "refused", reason: "ParseError", detail: "the module contains syntax errors" };
	}
	return facts;
}

/** Refused when the target already binds a landing name, or would register two class_names. */
export function targetCollision(
	module: string,
	text: string,
	toModule: string,
	declarations: readonly Declaration[],
	arrivals: readonly Arrival[],
): MoveEditsResponse | undefined {
	const registrations = arrivals.filter(
		(arrival) => arrival.text !== undefined && hasClassNameDeclaration(toModule, arrival.text),
	).length;
	if (registrations > 1 || (registrations === 1 && hasClassNameDeclaration(module, text))) {
		return {
			status: "refused",
			reason: "TargetCollision",
			detail: "a GDScript file can register only one class_name",
		};
	}
	const held = arrivals.find((arrival) => declarations.some((declaration) => declaration.name === arrival.name));
	if (held !== undefined) {
		return {
			status: "refused",
			reason: "TargetCollision",
			detail: `the target already declares ${held.name}`,
		};
	}
	return undefined;
}

////////////////////////////////
//  Dependencies

/** Loader lines the dependencies need, as one edit after the header lines. */
export function dependencyEdits(
	fromModule: string,
	text: string,
	coordinates: TextCoordinates,
	dependencies: readonly MoveDependency[],
	bindings: GDScriptBindingIndex,
	target: TargetFacts,
): MovePlan {
	const plan: MovePlan = { edits: [], blocked: [] };
	const insertions: string[] = [];
	for (const dependency of dependencies) {
		const result = dependencyPlan(fromModule, dependency, bindings, target);
		if (result.blocked !== undefined) plan.blocked.push(result.blocked);
		if (result.insertion !== undefined && !insertions.includes(result.insertion)) insertions.push(result.insertion);
	}
	if (insertions.length === 0) return plan;
	const lexed = lexSource(text);
	const line = dependencyInsertionLine(lexed);
	const point = line < lexed.lines.length ? { line, character: 0 } : coordinates.positionAt(text.length);
	if (point === undefined) {
		plan.blocked.push({ reason: "ParseError", detail: "the dependency insertion point is outside the module" });
	} else {
		const newline = newlineFor(text);
		plan.edits.push({ range: { start: point, end: point }, newText: `${insertions.join(newline)}${newline}` });
	}
	return plan;
}

function dependencyPlan(
	fromModule: string,
	dependency: MoveDependency,
	bindings: GDScriptBindingIndex,
	target: TargetFacts,
): { insertion?: string; blocked?: MoveBlockedSite } {
	const origin = dependency.origin;
	if (origin.kind === "insideClosure") return {};
	if (origin.kind === "sourceModule") {
		if (bindings.isRegisteredClassNameSymbol(origin.symbolId)) return {};
		return {
			blocked: blockedSite(
				dependency.range,
				"PrivateSibling",
				`${origin.name} stays in the source file and GDScript has no import form for it`,
			),
		};
	}
	if (origin.kind === "workspaceModule") {
		if (bindings.isRegisteredClassNameSymbol(origin.symbolId)) return {};
		return workspaceDependencyPlan(fromModule, dependency, bindings, target);
	}
	if (origin.kind === "external") {
		return {
			blocked: blockedSite(
				dependency.range,
				"ExternalContract",
				"the dependency is outside the indexed GDScript workspace",
			),
		};
	}
	return {
		blocked: blockedSite(
			dependency.range,
			"DynamicDependency",
			"the index could not place this GDScript dependency",
		),
	};
}

function workspaceDependencyPlan(
	fromModule: string,
	dependency: MoveDependency,
	bindings: GDScriptBindingIndex,
	target: TargetFacts,
): { insertion?: string; blocked?: MoveBlockedSite } {
	const origin = dependency.origin;
	if (origin.kind !== "workspaceModule") return {};
	const via = origin.via;
	const indexed = bindings.loaderBinding(fromModule, dependency.name, origin.module);
	if (indexed === undefined || !indexed.specifier.startsWith("res://")) {
		return {
			blocked: blockedSite(
				dependency.range,
				"StringLiteral",
				"the source has no unique absolute loader for this dependency",
			),
		};
	}
	if (
		via !== undefined &&
		(via.specifier !== indexed.specifier || (via.localName !== undefined && via.localName !== indexed.localName))
	) {
		return {
			blocked: blockedSite(
				dependency.range,
				"StringLiteral",
				"the indexed loader does not match the dependency origin",
			),
		};
	}
	const localName = indexed.localName;
	if (hasLoaderBinding(target.loaders, localName, indexed.specifier)) return {};
	if (!isGdscriptIdentifier(localName)) {
		return {
			blocked: blockedSite(
				dependency.range,
				"NoImportPath",
				"the loader binding name is not a GDScript identifier",
			),
		};
	}
	if (hasLocalDeclaration(target.declarations, localName)) {
		return {
			blocked: blockedSite(
				dependency.range,
				"TargetCollision",
				`${localName} already has another target binding`,
			),
		};
	}
	return { insertion: `const ${localName} = ${indexed.loader}(${quoteGdscriptString(indexed.specifier)})` };
}

////////////////////////////////
//  Site Classification

export function addImportSiteBlocks(
	plan: MovePlan,
	coordinates: TextCoordinates,
	sites: readonly MoveImportSite[],
): void {
	for (const site of sites) plan.blocked.push(blockedImportSite(site, coordinates));
}

/** Uses outside import statements; a class_name move needs no edit. */
export function addSiteBlocks(
	plan: MovePlan,
	coordinates: TextCoordinates,
	sites: readonly Range[],
	classNameMove: () => boolean,
): void {
	for (const site of sites) {
		const offsets = coordinates.offsetsForRange(site);
		if (offsets === undefined) {
			plan.blocked.push(blockedSite(site, "ParseError", "the site range is outside the module"));
			continue;
		}
		const siteText = coordinates.sliceRange(site);
		if (siteText === undefined) {
			plan.blocked.push(blockedSite(site, "ParseError", "the site range is outside the module"));
			continue;
		}
		const pathReason = resourceReason(siteText);
		if (pathReason !== undefined) {
			plan.blocked.push(
				blockedSite(site, pathReason, "the moved site is a resource path outside GDScript name binding"),
			);
		} else if (!classNameMove()) {
			plan.blocked.push(blockedSite(site, "NoImportPath", "GDScript has no import form for this moved name"));
		}
	}
}

function blockedImportSite(site: MoveImportSite, coordinates: TextCoordinates): MoveBlockedSite {
	if (coordinates.offsetsForRange(site.range) === undefined) {
		return blockedSite(site.range, "ParseError", "the import site range is outside the module");
	}
	const reason = resourceReason(site.specifier);
	return blockedSite(
		site.range,
		reason ?? "StringLiteral",
		reason === "ExternalContract"
			? "the import site names a scene or resource outside GDScript"
			: "GDScript loader paths are string literals and are not rewritten by this provider",
	);
}

/** From the path before any query or fragment. */
function resourceReason(text: string): MoveBlockedReason | undefined {
	const path = new SourceCursor(text).readWhile((character) => character !== "?" && character !== "#");
	if (path.endsWith(".tscn") || path.endsWith(".tres")) return "ExternalContract";
	if (path.startsWith("res://") || path.endsWith(".gd")) return "StringLiteral";
	return undefined;
}

export function isClassNameMove(
	bindings: GDScriptBindingIndex,
	symbolId: string,
	name: string,
	toModule: string,
	insertionText: string | undefined,
): boolean {
	if (bindings.isRegisteredClassNameSymbol(symbolId)) return true;
	return insertionText === undefined ? false : hasClassNameDeclaration(toModule, insertionText, name);
}

////////////////////////////////
//  Ranges & Edits

export function addRemoval(plan: MovePlan, coordinates: TextCoordinates, range: Range): void {
	if (coordinates.offsetsForRange(range) === undefined) {
		plan.blocked.push(blockedSite(range, "ParseError", "the removal range is outside the module"));
	} else {
		plan.edits.push({ range, newText: "" });
	}
}

/** At the end of the text when no position is given. */
export function addInsertion(
	plan: MovePlan,
	text: string,
	coordinates: TextCoordinates,
	position: Position | undefined,
	newText: string,
): void {
	const offset = position === undefined ? text.length : coordinates.offsetAt(position);
	if (offset === undefined) {
		plan.blocked.push(
			blockedSite(
				position === undefined ? undefined : { start: position, end: position },
				"ParseError",
				"the insertion position is outside the module",
			),
		);
		return;
	}
	const point = coordinates.positionAt(offset);
	if (point === undefined) {
		plan.blocked.push({ reason: "ParseError", detail: "the insertion position is outside the module" });
		return;
	}
	plan.edits.push({ range: { start: point, end: point }, newText });
}

export function validateEdits(coordinates: TextCoordinates, plan: MovePlan): MoveEditsResponse {
	const planned = planEdits(coordinates, plan.edits);
	const blocked = [...plan.blocked];
	for (const { edit, conflict } of planned.conflicts) {
		const named = MOVE_EDIT_CONFLICT[conflict];
		blocked.push(blockedSite(edit.range, named.reason, named.detail));
	}
	// Joined insertions are deliberate here: collecting several for one point is how a move adds
	// more than one dependency to a file.
	return { status: "ready", edits: planned.edits, blocked };
}

/** The line after the file's header lines. */
function dependencyInsertionLine(lexed: LexedSource): number {
	const lines = lexed.lines;
	let insertion = 0;
	for (const line of lines) {
		// Opens inside a string.
		if (lines[line.line - 1]?.endsInString === true) break;
		const annotations = annotationLine(lexed, line.line);
		const heads = parseLineHeads(lexed, line.line);
		const header =
			(isIgnorable(lexed, line.line) && !line.hasString) ||
			annotations?.head === null ||
			(heads.length > 0 && heads.every((head) => head.keyword === "class_name" || head.keyword === "extends"));
		if (!header || line.endsInString) break;
		insertion = line.line + 1;
	}
	return insertion;
}

function hasClassNameDeclaration(module: string, text: string, name?: string): boolean {
	return extractDeclarations(module, text).some(
		(declaration) => declaration.languageKind === "class_name" && (name === undefined || declaration.name === name),
	);
}

function hasLoaderBinding(loaders: LoaderCall[], localName: string, specifier: string): boolean {
	return loaders.some(
		(call) =>
			call.binding?.keyword === "const" && call.binding.name === localName && call.literal?.path === specifier,
	);
}

function hasLocalDeclaration(declarations: readonly Declaration[], name: string): boolean {
	return declarations.some(
		(declaration) =>
			declaration.name === name &&
			declaration.languageKind !== "parameter" &&
			declaration.languageKind !== "script",
	);
}

function newlineFor(text: string): string {
	return text.includes("\r\n") ? "\r\n" : "\n";
}

function blockedSite(range: Range | undefined, reason: MoveBlockedReason, detail: string): MoveBlockedSite {
	return range === undefined ? { reason, detail } : { range, reason, detail };
}

function isValidModule(module: string): boolean {
	try {
		return module.endsWith(".gd") && normalizeModulePath(module) === module;
	} catch {
		return false;
	}
}

export function sameModule(left: string, right: string): boolean {
	try {
		return normalizeModulePath(left) === normalizeModulePath(right);
	} catch {
		return left === right;
	}
}
