import path from "node:path";
import {
	comparePositions,
	coordinatesOf,
	MOVE_EDIT_CONFLICT,
	type MoveBlockedReason,
	type MoveDependency,
	type MoveEditsRequest,
	type MoveEditsResponse,
	type MoveImportSite,
	planEdits,
	type Range,
	type TextCoordinates,
	type TextEdit,
} from "@nyaa-lexicon/protocol";

////////////////////////////////
//  Interfaces & Types

export interface PythonMoveFacts {
	declarations: Array<{ name: string; containerPath: unknown[] }>;
	diagnostics: Array<{ severity: string; message: string }>;
	importBindings: Array<{ specifier: string; localName: string; scopePath: unknown[]; star: boolean }>;
	importStatements: PythonImportStatement[];
	literals: Array<{ kind: string; range: Range }>;
	moduleDocstring?: Range | null;
}

interface PythonImportAlias {
	name: string;
	localName: string;
	range: Range;
	importedRange?: Range | null;
	localRange?: Range | null;
	star: boolean;
}

interface PythonImportStatement {
	kind: "import" | "from";
	specifier: string;
	range: Range;
	reExport: boolean;
	aliases: PythonImportAlias[];
}

type RenderedSpecifier = { specifier: string } | { reason: MoveBlockedReason; detail: string };

////////////////////////////////
//  Main

export function makeMoveEdits(request: MoveEditsRequest, facts: PythonMoveFacts): MoveEditsResponse {
	const coordinates = coordinatesOf(request.text);
	const syntaxError = facts.diagnostics.find((diagnostic) => diagnostic.severity === "error");
	if (syntaxError !== undefined) {
		return { status: "refused", reason: "ParseError", detail: syntaxError.message };
	}

	if (sameModule(request.module, request.toModule) && request.exists && declaresName(facts, request.name)) {
		return {
			status: "refused",
			reason: "TargetCollision",
			detail: `the target already declares ${request.name}`,
		};
	}

	const blocked: Array<{ range?: Range; reason: MoveBlockedReason; detail: string }> = [];
	const edits: TextEdit[] = [];

	if (request.role.removal !== undefined) {
		if (coordinates.offsetsForRange(request.role.removal) === undefined) {
			blocked.push(blockedSite(request.role.removal, "ParseError", "the removal range is outside the module"));
		} else {
			edits.push({ range: request.role.removal, newText: "" });
		}
	}

	for (const site of request.importSites) {
		const result = rewriteImportSite(request, coordinates, facts, site);
		if (result.blocked !== undefined) blocked.push(result.blocked);
		if (result.edit !== undefined) edits.push(result.edit);
	}

	for (const site of request.sites) {
		const literal = facts.literals.some(
			(candidate) => candidate.kind === "string" && rangeContains(candidate.range, site),
		);
		blocked.push(
			blockedSite(
				site,
				literal ? "StringLiteral" : "NotImplemented",
				literal
					? "the moved symbol occurs inside a string literal"
					: "the moved symbol occurs outside an import statement",
			),
		);
	}

	const pendingImports = new Set<string>();
	for (const dependency of request.dependencies) {
		const result = importForDependency(request, facts, dependency);
		if (result.blocked !== undefined) blocked.push(result.blocked);
		if (result.statement !== undefined) pendingImports.add(result.statement);
	}

	if (pendingImports.size > 0) {
		const position = importInsertionPosition(request.text, coordinates, facts);
		const point = coordinates.positionAt(position);
		if (point === undefined) {
			blocked.push({ reason: "ParseError", detail: "the import insertion point is outside the module" });
		} else {
			const prefix = position > 0 && request.text[position - 1] !== "\n" ? "\n" : "";
			edits.push({
				range: { start: point, end: point },
				newText: `${prefix}${[...pendingImports].join("\n")}\n`,
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
//  Site Rewriting

function rewriteImportSite(
	request: MoveEditsRequest,
	coordinates: TextCoordinates,
	facts: PythonMoveFacts,
	site: MoveImportSite,
): { edit?: TextEdit; blocked?: { range?: Range; reason: MoveBlockedReason; detail: string } } {
	if (site.importKind === "namespace" || site.importKind === "wildcard" || site.importKind === "sideEffect") {
		return {
			blocked: blockedSite(
				site.range,
				"NotImplemented",
				`a ${site.importKind} ${site.reExport ? "re-export" : "import"} binds the whole module`,
			),
		};
	}
	if (site.importKind !== "named") {
		return {
			blocked: blockedSite(site.range, "NotImplemented", `Python does not have a ${site.importKind} import form`),
		};
	}

	const statement = facts.importStatements.find(
		(candidate) =>
			candidate.kind === "from" &&
			candidate.specifier === site.specifier &&
			rangeContains(candidate.range, site.range),
	);
	if (statement === undefined) {
		return {
			blocked: blockedSite(site.range, "ParseError", "the range does not name the requested import"),
		};
	}

	const alias = statement.aliases.find((candidate) => aliasMatches(candidate, site));
	if (alias === undefined || alias.star) {
		return {
			blocked: blockedSite(site.range, "ParseError", "the range does not name a named Python import"),
		};
	}

	const rendered = renderPythonSpecifier(request.module, request.toModule, site.specifier);
	if ("reason" in rendered) return { blocked: blockedSite(site.range, rendered.reason, rendered.detail) };
	if (rendered.specifier === site.specifier) return {};

	const offsets = coordinates.offsetsForRange(statement.range);
	if (offsets === undefined) {
		return { blocked: blockedSite(site.range, "ParseError", "the import statement range is outside the module") };
	}

	if (statement.aliases.length === 1) {
		const raw = request.text.slice(offsets.start, offsets.end);
		const fromIndex = raw.indexOf("from");
		const specifierStart = fromIndex < 0 ? -1 : raw.indexOf(site.specifier, fromIndex + 4);
		if (specifierStart < 0) {
			return { blocked: blockedSite(site.range, "ParseError", "the import statement has no matching specifier") };
		}
		return {
			edit: {
				range: statement.range,
				newText: `${raw.slice(0, specifierStart)}${rendered.specifier}${raw.slice(
					specifierStart + site.specifier.length,
				)}`,
			},
		};
	}

	const remaining = statement.aliases.filter((candidate) => candidate !== alias);
	const indentation = statementIndent(request.text, offsets.start);
	return {
		edit: {
			range: statement.range,
			newText: `${formatFromImport(site.specifier, remaining)}\n${indentation}${formatFromImport(
				rendered.specifier,
				[alias],
			)}`,
		},
	};
}

function aliasMatches(alias: PythonImportAlias, site: MoveImportSite): boolean {
	if (site.importedName !== undefined && site.importedName !== alias.name) return false;
	if (site.localName !== undefined && site.localName !== alias.localName) return false;
	const ranges = [alias.importedRange, alias.localRange, alias.range].filter(
		(range): range is Range => range !== undefined && range !== null,
	);
	return ranges.some((range) => rangeContains(range, site.range) || rangeContains(site.range, range));
}

function formatFromImport(specifier: string, aliases: PythonImportAlias[]): string {
	const names = aliases.map((alias) => {
		if (alias.star || alias.localName === alias.name) return alias.name;
		return `${alias.name} as ${alias.localName}`;
	});
	return `from ${specifier} import ${names.join(", ")}`;
}

////////////////////////////////
//  Dependency Imports

function importForDependency(
	request: MoveEditsRequest,
	facts: PythonMoveFacts,
	dependency: MoveDependency,
): { statement?: string; blocked?: { range?: Range; reason: MoveBlockedReason; detail: string } } {
	const origin = dependency.origin;
	if (origin.kind === "insideClosure") return {};
	if (origin.kind === "unresolved") {
		return { blocked: blockedSite(dependency.range, "DynamicDependency", origin.reason) };
	}
	if (origin.kind === "sourceModule" && origin.exported === false) {
		return {
			blocked: blockedSite(dependency.range, "PrivateSibling", `${origin.name} is not exported`),
		};
	}

	let specifier: string;
	if (origin.kind === "sourceModule") {
		const rendered = renderPythonSpecifier(request.module, request.fromModule);
		if ("reason" in rendered) return { blocked: blockedSite(dependency.range, rendered.reason, rendered.detail) };
		specifier = rendered.specifier;
	} else if (origin.kind === "workspaceModule") {
		const rendered = renderPythonSpecifier(request.module, origin.module, origin.via?.specifier);
		if ("reason" in rendered) return { blocked: blockedSite(dependency.range, rendered.reason, rendered.detail) };
		specifier = rendered.specifier;
	} else {
		specifier = origin.via.specifier;
	}

	if (hasExistingBinding(facts, dependency.name, specifier)) return {};

	const statement = importStatementForDependency(dependency, specifier);
	if (statement === undefined) {
		return {
			blocked: blockedSite(dependency.range, "NotImplemented", "the import form cannot bind a moved dependency"),
		};
	}
	return { statement };
}

function importStatementForDependency(dependency: MoveDependency, specifier: string): string | undefined {
	const origin = dependency.origin;
	const via = origin.kind === "workspaceModule" || origin.kind === "external" ? origin.via : undefined;
	const importKind = via?.importKind ?? "named";
	if (
		importKind === "wildcard" ||
		importKind === "sideEffect" ||
		importKind === "default" ||
		importKind === "typeOnly"
	) {
		return undefined;
	}
	if (importKind === "namespace") {
		if (specifier.startsWith(".")) return undefined;
		const moduleName = specifier.split(".").at(-1) ?? specifier;
		return moduleName === dependency.name ? `import ${specifier}` : `import ${specifier} as ${dependency.name}`;
	}

	const importedName = origin.kind === "sourceModule" ? origin.name : (via?.importedName ?? dependency.name);
	if (importedName === undefined || importedName === "") return undefined;
	const alias = importedName === dependency.name ? "" : ` as ${dependency.name}`;
	return `from ${specifier} import ${importedName}${alias}`;
}

function hasExistingBinding(facts: PythonMoveFacts, name: string, specifier: string): boolean {
	return facts.importBindings.some(
		(binding) => binding.scopePath.length === 0 && binding.localName === name && binding.specifier === specifier,
	);
}

////////////////////////////////
//  Target Checks & Rendering

export function isValidTargetModule(module: string): boolean {
	const normalized = path.posix.normalize(module.replace(/\\/g, "/"));
	return (
		module === normalized &&
		normalized.endsWith(".py") &&
		normalized !== "." &&
		normalized !== ".." &&
		!normalized.startsWith("../") &&
		!normalized.startsWith("/")
	);
}

export function renderPythonSpecifier(
	fromModule: string,
	targetModule: string,
	originalSpecifier?: string,
): RenderedSpecifier {
	const targetParts = moduleParts(targetModule);
	if (targetParts.length === 0) {
		return { reason: "NoImportPath", detail: `no Python import path reaches ${targetModule}` };
	}
	if (originalSpecifier !== undefined && !originalSpecifier.startsWith(".")) {
		return { specifier: targetParts.join(".") };
	}

	const fromPackage = packageParts(fromModule);
	let common = 0;
	while (common < fromPackage.length && common < targetParts.length && fromPackage[common] === targetParts[common]) {
		common += 1;
	}
	const dots = ".".repeat(fromPackage.length - common + 1);
	const remainder = targetParts.slice(common).join(".");
	return { specifier: `${dots}${remainder}` };
}

function moduleParts(module: string): string[] {
	const parts = module.replace(/\\/g, "/").split("/").filter(Boolean);
	const file = parts.pop();
	if (file === undefined) return [];
	if (file === "__init__.py" || file === "__init__.pyi") return parts;
	const stem = file.replace(/\.(?:py|pyi)$/, "");
	return stem === file ? [] : [...parts, stem];
}

function packageParts(module: string): string[] {
	const parts = module.replace(/\\/g, "/").split("/").filter(Boolean);
	const file = parts.pop();
	if (file === "__init__.py" || file === "__init__.pyi") return parts;
	return parts;
}

function declaresName(facts: PythonMoveFacts, name: string): boolean {
	return (
		facts.declarations.some((declaration) => declaration.name === name && declaration.containerPath.length === 0) ||
		facts.importBindings.some((binding) => binding.localName === name && binding.scopePath.length === 0)
	);
}

function sameModule(left: string, right: string): boolean {
	return path.posix.normalize(left.replace(/\\/g, "/")) === path.posix.normalize(right.replace(/\\/g, "/"));
}

////////////////////////////////
//  Insertion & Ranges

function importInsertionPosition(text: string, coordinates: TextCoordinates, facts: PythonMoveFacts): number {
	let position = 0;
	if (text.startsWith("#!")) position = afterLine(text, text.indexOf("\n") < 0 ? text.length : text.indexOf("\n"));
	if (facts.moduleDocstring !== undefined && facts.moduleDocstring !== null) {
		const offsets = coordinates.offsetsForRange(facts.moduleDocstring);
		if (offsets !== undefined) position = Math.max(position, afterLine(text, offsets.end));
	}
	for (const statement of facts.importStatements) {
		if (statement.kind !== "from" || statement.specifier !== "__future__") continue;
		const offsets = coordinates.offsetsForRange(statement.range);
		if (offsets === undefined || !isTopLevel(text, offsets.start)) continue;
		position = Math.max(position, afterLine(text, offsets.end));
	}
	return position;
}

function isTopLevel(text: string, offset: number): boolean {
	const lineStart = text.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
	return text.slice(lineStart, offset) === "";
}

function statementIndent(text: string, offset: number): string {
	const lineStart = text.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
	return text.slice(lineStart, offset).match(/^[ \t]*/)?.[0] ?? "";
}

function afterLine(text: string, offset: number): number {
	const newline = text.indexOf("\n", offset);
	return newline < 0 ? text.length : newline + 1;
}

// Inclusive at both ends.
function rangeContains(outer: Range, inner: Range): boolean {
	return comparePositions(outer.start, inner.start) <= 0 && comparePositions(inner.end, outer.end) <= 0;
}

////////////////////////////////
//  Validation

function validateEdits(
	coordinates: TextCoordinates,
	edits: TextEdit[],
	blocked: Array<{ range?: Range; reason: MoveBlockedReason; detail: string }>,
): MoveEditsResponse {
	const plan = planEdits(coordinates, edits);
	for (const { edit, conflict } of plan.conflicts) {
		const named = MOVE_EDIT_CONFLICT[conflict];
		blocked.push(blockedSite(edit.range, named.reason, named.detail));
	}
	// Joined insertions are deliberate here: collecting several for one point is how a move adds
	// more than one import to a file.
	return { status: "ready", edits: plan.edits, blocked };
}

function blockedSite(
	range: Range | undefined,
	reason: MoveBlockedReason,
	detail: string,
): { range?: Range; reason: MoveBlockedReason; detail: string } {
	return range === undefined ? { reason, detail } : { range, reason, detail };
}
