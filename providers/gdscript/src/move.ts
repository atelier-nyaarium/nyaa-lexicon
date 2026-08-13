import {
	type MoveBlockedReason,
	type MoveBlockedSite,
	type MoveDependency,
	type MoveEditsRequest,
	type MoveEditsResponse,
	type MoveImportSite,
	normalizeModulePath,
	type Range,
	type TextEdit,
} from "@nyaa-lexicon/protocol";
import type { GDScriptBindingIndex } from "./binding.js";
import { extractDeclarations, extractFile } from "./extract.js";

////////////////////////////////
//  Types

interface OffsetRange {
	start: number;
	end: number;
}

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
		if (offsetsForRange(request.text, request.role.removal) === undefined) {
			blocked.push(blockedSite(request.role.removal, "ParseError", "the removal range is outside the module"));
		} else if (ownsUnrangedBody(request.text, request.role.removal)) {
			// A GDScript declaration range stops at the header, so removing it would relocate
			// `func add() -> int:` and leave `return a + b` behind. Refuse rather than emit that.
			blocked.push(
				blockedSite(
					request.role.removal,
					"NotImplemented",
					"moving a declaration out of its block body is not implemented for GDScript",
				),
			);
		} else {
			edits.push({ range: request.role.removal, newText: "" });
		}
	}

	for (const site of request.importSites) {
		blocked.push(blockedImportSite(request, site));
	}
	for (const site of request.sites) {
		const offsets = offsetsForRange(request.text, site);
		if (offsets === undefined) {
			blocked.push(blockedSite(site, "ParseError", "the site range is outside the module"));
			continue;
		}
		const siteText = request.text.slice(offsets.start, offsets.end);
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
		const point = positionAt(request.text, position);
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
				: offsetForPosition(request.text, request.role.insertion.position);
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
			const point = positionAt(request.text, position);
			if (point === undefined) {
				blocked.push({ reason: "ParseError", detail: "the insertion position is outside the module" });
			} else {
				edits.push({ range: { start: point, end: point }, newText: request.role.insertion.text });
			}
		}
	}

	return validateEdits(request.text, edits, blocked);
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

function blockedImportSite(request: MoveEditsRequest, site: MoveImportSite): MoveBlockedSite {
	if (offsetsForRange(request.text, site.range) === undefined) {
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

function validateEdits(text: string, edits: TextEdit[], blocked: MoveBlockedSite[]): MoveEditsResponse {
	const unique = new Map<string, TextEdit>();
	for (const edit of edits) {
		const offsets = offsetsForRange(text, edit.range);
		if (offsets === undefined) {
			blocked.push(blockedSite(edit.range, "ParseError", "an edit range is outside the module"));
			continue;
		}
		const key = `${offsets.start}:${offsets.end}`;
		const previous = unique.get(key);
		if (previous === undefined) {
			unique.set(key, edit);
		} else if (previous.newText !== edit.newText && offsets.start === offsets.end) {
			unique.set(key, { range: edit.range, newText: `${previous.newText}${edit.newText}` });
		} else if (previous.newText !== edit.newText) {
			blocked.push(blockedSite(edit.range, "NotImplemented", "the move produces duplicate edits"));
		}
	}

	const sorted = [...unique.values()]
		.map((edit) => ({ edit, ...(offsetsForRange(text, edit.range) as OffsetRange) }))
		.sort((left, right) => left.start - right.start || left.end - right.end);
	const safe: TextEdit[] = [];
	let previousEnd = -1;
	for (const item of sorted) {
		if (item.start < previousEnd) {
			blocked.push(blockedSite(item.edit.range, "NotImplemented", "the move produces overlapping edits"));
			continue;
		}
		safe.push(item.edit);
		previousEnd = Math.max(previousEnd, item.end);
	}
	return { status: "ready", edits: safe, blocked };
}

/**
 * True when the range ends on a block header whose indented body sits outside it.
 *
 * The whole-script root class covers its file and passes; a `func` or inner `class` does not,
 * and taking only its header would split a declaration across two files.
 */
function ownsUnrangedBody(text: string, range: Range): boolean {
	const lines = text.split("\n");
	const header = lines[range.end.line];
	if (header === undefined || !stripComment(header).trimEnd().endsWith(":")) return false;

	const headerIndent = indentWidth(lines[range.start.line] ?? "");
	for (let index = range.end.line + 1; index < lines.length; index++) {
		const line = lines[index] as string;
		if (line.trim() === "") continue;
		return indentWidth(line) > headerIndent;
	}
	return false;
}

function stripComment(line: string): string {
	const hash = line.indexOf("#");
	return hash < 0 ? line : line.slice(0, hash);
}

function indentWidth(line: string): number {
	return (line.match(/^[ \t]*/)?.[0] ?? "").length;
}

function offsetsForRange(text: string, range: Range): OffsetRange | undefined {
	const start = offsetForPosition(text, range.start);
	const end = offsetForPosition(text, range.end);
	return start === undefined || end === undefined || end < start ? undefined : { start, end };
}

function offsetForPosition(text: string, position: Range["start"]): number | undefined {
	if (position.line < 0 || position.character < 0) return undefined;
	const starts = lineStarts(text);
	const lineStart = starts[position.line];
	if (lineStart === undefined) return undefined;
	const nextLineStart = starts[position.line + 1] ?? text.length;
	const lineEnd = nextLineStart > lineStart && text[nextLineStart - 1] === "\n" ? nextLineStart - 1 : nextLineStart;
	return lineStart + position.character <= lineEnd ? lineStart + position.character : undefined;
}

function positionAt(text: string, offset: number): Range["start"] | undefined {
	if (offset < 0 || offset > text.length) return undefined;
	const starts = lineStarts(text);
	let line = starts.length - 1;
	for (let index = 0; index < starts.length; index++) {
		if ((starts[index] as number) > offset) {
			line = index - 1;
			break;
		}
	}
	return { line, character: offset - (starts[line] as number) };
}

function lineStarts(text: string): number[] {
	const starts = [0];
	for (let index = 0; index < text.length; index++) if (text[index] === "\n") starts.push(index + 1);
	return starts;
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
