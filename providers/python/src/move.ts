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
	comments: Array<{ range: Range }>;
	declarations: Array<{ name: string; containerPath: unknown[] }>;
	diagnostics: Array<{ severity: string; message: string }>;
	importBindings: Array<{ specifier: string; localName: string; scopePath: unknown[]; star: boolean }>;
	importStatements: PythonImportStatement[];
	literals: Array<{ kind: string; range: Range }>;
	prologueEnd: Range["start"] | null;
}

export interface PythonImportAlias {
	name: string;
	localName: string;
	range: Range;
	importedRange?: Range | null;
	localRange?: Range | null;
	star: boolean;
}

export interface PythonImportStatement {
	kind: "import" | "from";
	specifier: string;
	range: Range;
	moduleRange: Range | null;
	indent: string | null;
	aliases: PythonImportAlias[];
}

export type BlockedSite = { range?: Range; reason: MoveBlockedReason; detail: string };

/** An import a dependency needs, before it is written. */
export type PlannedImport =
	| { form: "import"; specifier: string; localName: string }
	| { form: "from"; specifier: string; importedName: string; localName: string };

type ImportBinding = PythonMoveFacts["importBindings"][number];

type RenderedSpecifier = { specifier: string } | { reason: MoveBlockedReason; detail: string };

////////////////////////////////
//  Main

export function makeMoveEdits(request: MoveEditsRequest, facts: PythonMoveFacts): MoveEditsResponse {
	const coordinates = coordinatesOf(request.text);
	const syntaxError = facts.diagnostics.find((diagnostic) => diagnostic.severity === "error");
	if (syntaxError !== undefined) {
		return { status: "refused", reason: "ParseError", detail: syntaxError.message };
	}

	// A reorder's module already declares the moved name.
	const reorder = sameModule(request.fromModule, request.toModule);
	if (
		!reorder &&
		sameModule(request.module, request.toModule) &&
		request.exists &&
		declaresName(facts, request.name)
	) {
		return {
			status: "refused",
			reason: "TargetCollision",
			detail: `the target already declares ${request.name}`,
		};
	}

	const blocked: BlockedSite[] = [];
	const edits: TextEdit[] = [];

	if (request.role.removal !== undefined) {
		if (coordinates.offsetsForRange(request.role.removal) === undefined) {
			blocked.push(blockedSite(request.role.removal, "ParseError", "the removal range is outside the module"));
		} else {
			edits.push({ range: request.role.removal, newText: "" });
		}
	}

	// A reorder keeps every binding.
	if (!reorder) {
		const rebound = rebindEdits(request, coordinates, facts);
		edits.push(...rebound.edits);
		blocked.push(...rebound.blocked);
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

/** Binding edits for a move to another module. */
function rebindEdits(
	request: MoveEditsRequest,
	coordinates: TextCoordinates,
	facts: PythonMoveFacts,
): { edits: TextEdit[]; blocked: BlockedSite[] } {
	const blocked: BlockedSite[] = [];
	const edits: TextEdit[] = [];

	for (const site of request.importSites) {
		const located = locateImportSite(facts, site);
		const result: { edit?: TextEdit; blocked?: BlockedSite } =
			"blocked" in located
				? located
				: repointStatement(
						request.module,
						request.toModule,
						coordinates,
						facts,
						located.statement,
						[located.alias],
						site.range,
					);
		if (result.blocked !== undefined) blocked.push(result.blocked);
		if (result.edit !== undefined) edits.push(result.edit);
	}

	blocked.push(...useSiteBlocks(facts, request.sites));

	const pendingImports = new Set<string>();
	for (const dependency of request.dependencies) {
		const result = plannedImportFor(request, facts, dependency);
		if (result.blocked !== undefined) blocked.push(result.blocked);
		if (result.planned !== undefined) pendingImports.add(importLine(result.planned));
	}

	const inserted = importInsertion(coordinates, facts, [...pendingImports]);
	if (inserted.blocked !== undefined) blocked.push(inserted.blocked);
	if (inserted.edit !== undefined) edits.push(inserted.edit);

	return { edits, blocked };
}

/** Imports written at the end of the prologue. */
export function importInsertion(
	coordinates: TextCoordinates,
	facts: PythonMoveFacts,
	statements: string[],
): { edit?: TextEdit; blocked?: BlockedSite } {
	if (statements.length === 0) return {};
	const point = facts.prologueEnd;
	if (point === null || coordinates.offsetAt(point) === undefined) {
		return { blocked: { reason: "ParseError", detail: "the import insertion point is outside the module" } };
	}
	// End an unterminated prologue line first.
	const prefix = point.character > 0 ? "\n" : "";
	return { edit: { range: { start: point, end: point }, newText: `${prefix}${statements.join("\n")}\n` } };
}

/** Uses outside import statements, which no import rewrite repairs. */
export function useSiteBlocks(facts: PythonMoveFacts, sites: Range[]): BlockedSite[] {
	return sites.map((site) => {
		const literal = facts.literals.some(
			(candidate) => candidate.kind === "string" && rangeContains(candidate.range, site),
		);
		return blockedSite(
			site,
			literal ? "StringLiteral" : "NotImplemented",
			literal
				? "the moved symbol occurs inside a string literal"
				: "the moved symbol occurs outside an import statement",
		);
	});
}

////////////////////////////////
//  Site Rewriting

/** The named `from` import a site points into. */
export function locateImportSite(
	facts: PythonMoveFacts,
	site: MoveImportSite,
): { statement: PythonImportStatement; alias: PythonImportAlias } | { blocked: BlockedSite } {
	if (site.importKind === "namespace" || site.importKind === "wildcard" || site.importKind === "sideEffect") {
		return {
			blocked: blockedSite(site.range, "NotImplemented", `a ${site.importKind} import binds the whole module`),
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
	return { statement, alias };
}

/** One statement with its `moved` aliases importing from `toModule`, split when others stay. */
export function repointStatement(
	module: string,
	toModule: string,
	coordinates: TextCoordinates,
	facts: PythonMoveFacts,
	statement: PythonImportStatement,
	moved: PythonImportAlias[],
	siteRange: Range,
): { edit?: TextEdit; blocked?: BlockedSite } {
	const rendered = renderPythonSpecifier(module, toModule, statement.specifier);
	if ("reason" in rendered) return { blocked: blockedSite(siteRange, rendered.reason, rendered.detail) };
	if (rendered.specifier === statement.specifier) return {};

	if (coordinates.offsetsForRange(statement.range) === undefined) {
		return { blocked: blockedSite(siteRange, "ParseError", "the import statement range is outside the module") };
	}

	const kept = statement.aliases.filter((candidate) => !moved.includes(candidate));
	if (kept.length === 0) {
		if (statement.moduleRange === null) {
			return { blocked: blockedSite(siteRange, "ParseError", "the import statement has no module name") };
		}
		return { edit: { range: statement.moduleRange, newText: rendered.specifier } };
	}

	const moving = statement.aliases.filter((candidate) => moved.includes(candidate));
	return rewriteStatement(
		facts,
		statement,
		[
			{ specifier: statement.specifier, aliases: kept },
			{ specifier: rendered.specifier, aliases: moving },
		],
		siteRange,
	);
}

/** `statement` replaced by one `from` import per group, unless that drops a comment. */
export function rewriteStatement(
	facts: PythonMoveFacts,
	statement: PythonImportStatement,
	groups: Array<{ specifier: string; aliases: PythonImportAlias[] }>,
	blockedRange: Range,
): { edit?: TextEdit; blocked?: BlockedSite } {
	if (facts.comments.some((comment) => rangeContains(statement.range, comment.range))) {
		return {
			blocked: blockedSite(blockedRange, "NotImplemented", "the import holds a comment the rewrite would drop"),
		};
	}
	// Keep a semicolon when the import shares a line.
	const separator = statement.indent === null ? "; " : `\n${statement.indent}`;
	const newText = groups.map((group) => formatFromImport(group.specifier, group.aliases)).join(separator);
	return { edit: { range: statement.range, newText } };
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

/** The import a dependency needs in `request.module`, or none when it is already bound. */
export function plannedImportFor(
	request: Pick<MoveEditsRequest, "module" | "fromModule">,
	facts: PythonMoveFacts,
	dependency: MoveDependency,
): { planned?: PlannedImport; blocked?: BlockedSite } {
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

	const planned = plannedImport(dependency, specifier);
	if (planned === undefined) {
		return {
			blocked: blockedSite(dependency.range, "NotImplemented", "the import form cannot bind a moved dependency"),
		};
	}
	return { planned };
}

function plannedImport(dependency: MoveDependency, specifier: string): PlannedImport | undefined {
	const origin = dependency.origin;
	const via = origin.kind === "workspaceModule" || origin.kind === "external" ? origin.via : undefined;
	const importKind = via?.importKind ?? "named";
	if (
		importKind === "wildcard" ||
		importKind === "sideEffect" ||
		importKind === "default" ||
		importKind === "require" ||
		via?.typeOnly === true
	) {
		return undefined;
	}
	if (importKind === "namespace") {
		if (specifier.startsWith(".")) return undefined;
		return { form: "import", specifier, localName: dependency.name };
	}

	const importedName = origin.kind === "sourceModule" ? origin.name : (via?.importedName ?? dependency.name);
	if (importedName === undefined || importedName === "") return undefined;
	return { form: "from", specifier, importedName, localName: dependency.name };
}

/** One planned import as its own statement. */
export function importLine(planned: PlannedImport): string {
	if (planned.form === "import") {
		const moduleName = planned.specifier.split(".").at(-1) ?? planned.specifier;
		return moduleName === planned.localName
			? `import ${planned.specifier}`
			: `import ${planned.specifier} as ${planned.localName}`;
	}
	const alias = planned.importedName === planned.localName ? "" : ` as ${planned.localName}`;
	return `from ${planned.specifier} import ${planned.importedName}${alias}`;
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

/** Bound at module level, except by imports `exempt` names. */
export function declaresName(
	facts: PythonMoveFacts,
	name: string,
	exempt: (binding: ImportBinding) => boolean = () => false,
): boolean {
	return (
		facts.declarations.some((declaration) => declaration.name === name && declaration.containerPath.length === 0) ||
		facts.importBindings.some(
			(binding) => binding.localName === name && binding.scopePath.length === 0 && !exempt(binding),
		)
	);
}

export function sameModule(left: string, right: string): boolean {
	return path.posix.normalize(left.replace(/\\/g, "/")) === path.posix.normalize(right.replace(/\\/g, "/"));
}

////////////////////////////////
//  Ranges

// Inclusive at both ends.
function rangeContains(outer: Range, inner: Range): boolean {
	return comparePositions(outer.start, inner.start) <= 0 && comparePositions(inner.end, outer.end) <= 0;
}

////////////////////////////////
//  Validation

export function validateEdits(
	coordinates: TextCoordinates,
	edits: TextEdit[],
	blocked: BlockedSite[],
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

export function blockedSite(range: Range | undefined, reason: MoveBlockedReason, detail: string): BlockedSite {
	return range === undefined ? { reason, detail } : { range, reason, detail };
}
