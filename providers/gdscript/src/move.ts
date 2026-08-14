import {
	coordinatesOf,
	MOVE_EDIT_CONFLICT,
	type MoveBlockedReason,
	type MoveBlockedSite,
	type MoveDependency,
	type MoveEditsRequest,
	type MoveEditsResponse,
	type MoveImportSite,
	normalizeModulePath,
	planEdits,
	type Range,
	type TextCoordinates,
	type TextEdit,
} from "@nyaa-lexicon/protocol";
import type { GDScriptBindingIndex } from "./binding.js";
import { extractDeclarations, extractFile } from "./extract.js";

////////////////////////////////
//  Main

export function makeMoveEdits(request: MoveEditsRequest, bindings: GDScriptBindingIndex): MoveEditsResponse {
	if (!isValidModule(request.module) || !isValidModule(request.toModule)) {
		return {
			status: "refused",
			reason: "InvalidTarget",
			detail: "GDScript move targets must be workspace-relative .gd modules",
		};
	}
	const coordinates = coordinatesOf(request.text);

	const facts = extractFile(request.module, request.text);
	if (facts.diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
		return { status: "refused", reason: "ParseError", detail: "the module contains syntax errors" };
	}
	bindings.registerFile(request.module, facts.declarations, facts.references, request.text);

	const insertionText = request.role.insertion?.text;
	const carriesClassName =
		insertionText === undefined ? false : hasClassNameDeclaration(request.toModule, insertionText);
	if (request.exists && sameModule(request.module, request.toModule)) {
		const targetDeclarations = facts.declarations;
		if (carriesClassName && hasClassNameDeclaration(request.module, request.text)) {
			return {
				status: "refused",
				reason: "TargetCollision",
				detail: "a GDScript file can register only one class_name",
			};
		}
		if (targetDeclarations.some((declaration) => declaration.name === request.name)) {
			return {
				status: "refused",
				reason: "TargetCollision",
				detail: `the target already declares ${request.name}`,
			};
		}
	}

	if (!request.exists && request.role.removal === undefined && request.role.insertion === undefined) {
		return { status: "refused", reason: "NotImplemented", detail: "the target request has no move role" };
	}

	const blocked: MoveBlockedSite[] = [];
	const edits: TextEdit[] = [];
	if (request.role.removal !== undefined) {
		if (coordinates.offsetsForRange(request.role.removal) === undefined) {
			blocked.push(blockedSite(request.role.removal, "ParseError", "the removal range is outside the module"));
		} else {
			edits.push({ range: request.role.removal, newText: "" });
		}
	}

	for (const site of request.importSites) {
		blocked.push(blockedImportSite(request, site, coordinates));
	}
	for (const site of request.sites) {
		const offsets = coordinates.offsetsForRange(site);
		if (offsets === undefined) {
			blocked.push(blockedSite(site, "ParseError", "the site range is outside the module"));
			continue;
		}
		const siteText = coordinates.sliceRange(site);
		if (siteText === undefined) {
			blocked.push(blockedSite(site, "ParseError", "the site range is outside the module"));
			continue;
		}
		const pathReason = resourceReason(siteText);
		if (pathReason !== undefined) {
			blocked.push(
				blockedSite(site, pathReason, "the moved site is a resource path outside GDScript name binding"),
			);
		} else if (!isClassNameMove(request, bindings)) {
			blocked.push(blockedSite(site, "NoImportPath", "GDScript has no import form for this moved name"));
		}
	}

	const dependencyInsertions: string[] = [];
	const seenDependencyInsertions = new Set<string>();
	for (const dependency of request.dependencies) {
		const result = dependencyPlan(request, dependency, bindings);
		if (result.blocked !== undefined) blocked.push(result.blocked);
		if (result.insertion !== undefined && !seenDependencyInsertions.has(result.insertion)) {
			seenDependencyInsertions.add(result.insertion);
			dependencyInsertions.push(result.insertion);
		}
	}
	if (dependencyInsertions.length > 0) {
		const position = dependencyInsertionPosition(request.text);
		const point = coordinates.positionAt(position);
		if (point === undefined) {
			blocked.push({ reason: "ParseError", detail: "the dependency insertion point is outside the module" });
		} else {
			edits.push({
				range: { start: point, end: point },
				newText: `${dependencyInsertions.join(newlineFor(request.text))}${newlineFor(request.text)}`,
			});
		}
	}

	if (request.role.insertion !== undefined) {
		const position =
			request.role.insertion.position === undefined
				? request.text.length
				: coordinates.offsetAt(request.role.insertion.position);
		if (position === undefined) {
			blocked.push(
				blockedSite(
					request.role.insertion.position === undefined
						? undefined
						: { start: request.role.insertion.position, end: request.role.insertion.position },
					"ParseError",
					"the insertion position is outside the module",
				),
			);
		} else {
			const point = coordinates.positionAt(position);
			if (point === undefined) {
				blocked.push({ reason: "ParseError", detail: "the insertion position is outside the module" });
			} else {
				edits.push({ range: { start: point, end: point }, newText: request.role.insertion.text });
			}
		}
	}

	return validateEdits(coordinates, edits, blocked);
}

////////////////////////////////
//  Dependencies

function dependencyPlan(
	request: MoveEditsRequest,
	dependency: MoveDependency,
	bindings: GDScriptBindingIndex,
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
		return workspaceDependencyPlan(request, dependency, bindings);
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
	request: MoveEditsRequest,
	dependency: MoveDependency,
	bindings: GDScriptBindingIndex,
): { insertion?: string; blocked?: MoveBlockedSite } {
	const origin = dependency.origin;
	if (origin.kind !== "workspaceModule") return {};
	const via = origin.via;
	const indexed = bindings.loaderBinding(request.fromModule, dependency.name, origin.module);
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
	if (!isIdentifier(localName) || hasLoaderBinding(request.text, localName, indexed.specifier)) {
		return hasLoaderBinding(request.text, localName, indexed.specifier)
			? {}
			: {
					blocked: blockedSite(
						dependency.range,
						"NoImportPath",
						"the loader binding name is not a GDScript identifier",
					),
				};
	}
	if (hasLocalDeclaration(request.text, localName)) {
		return {
			blocked: blockedSite(dependency.range, "NoImportPath", `${localName} already has another target binding`),
		};
	}
	const quote = quoteString(indexed.specifier);
	if (quote === undefined) {
		return { blocked: blockedSite(dependency.range, "StringLiteral", "the loader path cannot be rendered safely") };
	}
	return { insertion: `const ${localName} = ${indexed.loader}(${quote})` };
}

////////////////////////////////
//  Site Classification

function blockedImportSite(
	request: MoveEditsRequest,
	site: MoveImportSite,
	coordinates: TextCoordinates,
): MoveBlockedSite {
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

function resourceReason(text: string): MoveBlockedReason | undefined {
	if (/\.(?:tscn|tres)(?:$|[?#])/u.test(text)) return "ExternalContract";
	if (/res:\/\/|\.gd(?:$|[?#])/u.test(text)) return "StringLiteral";
	return undefined;
}

function isClassNameMove(request: MoveEditsRequest, bindings: GDScriptBindingIndex): boolean {
	if (bindings.isRegisteredClassNameSymbol(request.symbolId)) return true;
	return request.role.insertion === undefined
		? false
		: hasClassNameDeclaration(request.toModule, request.role.insertion.text, request.name);
}

////////////////////////////////
//  Ranges & Edits

function validateEdits(coordinates: TextCoordinates, edits: TextEdit[], blocked: MoveBlockedSite[]): MoveEditsResponse {
	const plan = planEdits(coordinates, edits);
	for (const { edit, conflict } of plan.conflicts) {
		const named = MOVE_EDIT_CONFLICT[conflict];
		blocked.push(blockedSite(edit.range, named.reason, named.detail));
	}
	// Joined insertions are deliberate here: collecting several for one point is how a move adds
	// more than one dependency to a file.
	return { status: "ready", edits: plan.edits, blocked };
}

function dependencyInsertionPosition(text: string): number {
	let offset = 0;
	let position = 0;
	for (const line of text.matchAll(/[^\n]*(?:\n|$)/gu)) {
		const full = line[0] as string;
		if (full === "") break;
		const trimmed = full.replace(/\r?\n$/u, "").trim();
		if (
			trimmed === "" ||
			trimmed.startsWith("#") ||
			trimmed.startsWith("@") ||
			/^(?:class_name|extends)\b/u.test(trimmed)
		) {
			offset += full.length;
			position = offset;
			continue;
		}
		break;
	}
	return position;
}

function hasClassNameDeclaration(module: string, text: string, name?: string): boolean {
	return extractDeclarations(module, text).some(
		(declaration) => declaration.languageKind === "class_name" && (name === undefined || declaration.name === name),
	);
}

function hasLoaderBinding(text: string, localName: string, specifier: string): boolean {
	const escapedName = escapeRegExp(localName);
	const escapedSpecifier = escapeRegExp(specifier);
	return new RegExp(
		`^\\s*const\\s+${escapedName}\\s*=\\s*(?:preload|load)\\s*\\(\\s*&?\\s*["']${escapedSpecifier}["']\\s*\\)`,
		"mu",
	).test(text);
}

function hasLocalDeclaration(text: string, name: string): boolean {
	const escaped = escapeRegExp(name);
	return new RegExp(`^\\s*(?:const|var|signal|enum|class|func)\\s+${escaped}\\b`, "mu").test(text);
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function quoteString(text: string): string | undefined {
	if (/[\0\n\r]/u.test(text)) return undefined;
	return `"${text.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
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

function sameModule(left: string, right: string): boolean {
	try {
		return normalizeModulePath(left) === normalizeModulePath(right);
	} catch {
		return left === right;
	}
}

function isIdentifier(name: string): boolean {
	return /^[_\p{L}][\p{L}\p{M}\p{N}_]*$/u.test(name);
}
