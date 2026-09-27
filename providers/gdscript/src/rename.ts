import {
	applyEdits,
	type BlockedSite,
	coordinatesOf,
	type Declaration,
	planEdits,
	type Range,
	RENAME_EDIT_CONFLICT,
	type RenameEditsRequest,
	type RenameEditsResponse,
	sameRange,
	type TextCoordinates,
	type TextEdit,
} from "@nyaa-lexicon/protocol";
import { extractFile } from "./extract.js";
import { extractGdscriptParameterNames, isGdscriptIdentifier, type LoaderCall } from "./extractCore.js";
import { annotationsAbove, parseLineHeads } from "./line-syntax.js";
import type { GDScriptStore } from "./module.js";
import type { ParsedLine, ReferenceToken } from "./parse-model.js";
import { type LexedSource, lexSource, previousReferenceToken } from "./tokens.js";

const GDSCRIPT_KEYWORDS = new Set([
	"and",
	"as",
	"assert",
	"await",
	"break",
	"breakpoint",
	"class",
	"class_name",
	"const",
	"continue",
	"elif",
	"else",
	"enum",
	"extends",
	"false",
	"for",
	"func",
	"if",
	"in",
	"is",
	"match",
	"not",
	"null",
	"or",
	"pass",
	"preload",
	"return",
	"self",
	"signal",
	"static",
	"super",
	"true",
	"var",
	"void",
	"when",
	"while",
	"yield",
]);

/** Content offsets of a string token. */
interface StringContent {
	index: number;
	start: number;
	end: number;
}

function stringContents(tokens: ReferenceToken[], coordinates: TextCoordinates): StringContent[] {
	const contents: StringContent[] = [];
	tokens.forEach((token, index) => {
		const span = token.string;
		const start = span === undefined ? undefined : coordinates.offsetAt(span.start);
		const end = span === undefined ? undefined : coordinates.offsetAt(span.end);
		if (span === undefined || start === undefined || end === undefined) return;
		const quotes = span.triple ? 3 : 1;
		contents.push({ index, start: start + span.prefix.length + quotes, end: end - quotes });
	});
	return contents;
}

/** Opens `connect(` or `emit_signal(`. */
function isSignalArgument(tokens: ReferenceToken[], index: number): boolean {
	const open = previousReferenceToken(tokens, index);
	const callee = tokens[previousReferenceToken(tokens, open)];
	return (
		tokens[open]?.value === "(" &&
		callee?.kind === "identifier" &&
		(callee.value === "connect" || callee.value === "emit_signal")
	);
}

function declarationAt(declarations: Declaration[], range: Range): Declaration | undefined {
	return declarations.find(
		(declaration) => declaration.selectionRange !== undefined && sameRange(declaration.selectionRange, range),
	);
}

function headAt(lexed: LexedSource, position: Range["start"]): ParsedLine | undefined {
	return parseLineHeads(lexed, position.line).find((head) => head.name?.start === position.character);
}

function isExportedProperty(lexed: LexedSource, declaration: Declaration): boolean {
	const start = (declaration.selectionRange ?? declaration.range).start;
	const head = headAt(lexed, start);
	if (head === undefined) return false;
	const above = head.leading ? annotationsAbove(lexed, start.line).names : [];
	return [...above, ...head.annotations].some((name) => name === "export" || name.startsWith("export_"));
}

function isClassNameSite(lexed: LexedSource, range: Range): boolean {
	return headAt(lexed, range.start)?.keyword === "class_name";
}

function isLoaderLocal(loaders: LoaderCall[], range: Range): boolean {
	return loaders.some((call) => call.binding !== undefined && sameRange(call.binding.range, range));
}

function isDynamicLoaderCall(loaders: LoaderCall[], range: Range, role: string | undefined): boolean {
	if (role !== "call" && role !== "import") return false;
	return loaders.some((call) => call.literal === undefined && sameRange(call.range, range));
}

function blocked(range: Range, reason: BlockedSite["reason"], detail: string): BlockedSite {
	return { range, reason, detail };
}

function refused(
	reason: "InvalidName" | "ReservedWord" | "Collision" | "ParseError" | "NotImplemented",
	detail: string,
) {
	return { status: "refused", reason, detail } as const;
}

export function renameGdscript(params: RenameEditsRequest, store: GDScriptStore): RenameEditsResponse {
	if (!params.module.endsWith(".gd")) return refused("ParseError", "the module is not a GDScript file");
	if (!isGdscriptIdentifier(params.newName))
		return refused("InvalidName", "the new name is not a legal GDScript identifier");
	if (GDSCRIPT_KEYWORDS.has(params.newName)) return refused("ReservedWord", "the new name is a GDScript keyword");
	if (params.oldName === params.newName) return { status: "ready", edits: [], blocked: [] };

	let facts: ReturnType<typeof extractFile>;
	try {
		facts = extractFile(params.module, params.text);
	} catch {
		return refused("ParseError", "the supplied GDScript text could not be parsed");
	}
	if (extractGdscriptParameterNames(params.text).has(params.newName)) {
		return refused("Collision", "the new name already exists as a function parameter");
	}
	if (facts.declarations.some((declaration) => declaration.name === params.newName)) {
		return refused("Collision", "the new name already exists in this GDScript file");
	}
	if (store.get(`name:${params.newName}`).length > 0)
		return refused("Collision", "the new name is already a registered class_name");

	const coordinates = coordinatesOf(params.text);
	const lexed = lexSource(params.text);
	const tokens = lexed.tokens;
	const strings = stringContents(tokens, coordinates);
	const edits: TextEdit[] = [];
	const blockedSites: BlockedSite[] = [];
	const seenEdits = new Set<string>();
	const seenBlocked = new Set<string>();
	for (const site of params.sites) {
		const offsets = coordinates.offsetsForRange(site.range);
		if (offsets === undefined) return refused("ParseError", "a rename site has an invalid range");
		const current = coordinates.sliceRange(site.range);
		if (current === undefined) return refused("ParseError", "a rename site has an invalid range");
		if (current === params.newName) continue;
		const string = strings.find((content) => offsets.start >= content.start && offsets.end <= content.end);
		let block: BlockedSite | undefined;
		if (string !== undefined) {
			block = blocked(
				site.range,
				isSignalArgument(tokens, string.index) ? "StringLiteral" : "ExternalContract",
				"the site is a string literal whose consumer is outside identifier syntax",
			);
		} else {
			const declaration = declarationAt(facts.declarations, site.range);
			if (declaration?.languageKind === "class_name" || isClassNameSite(lexed, site.range)) {
				block = blocked(
					site.range,
					"ExternalContract",
					"class_name is also referenced by scenes and resources",
				);
			} else if (declaration?.kind === "event") {
				block = blocked(
					site.range,
					"StringLiteral",
					"signal names can be referenced by connect and emit_signal strings",
				);
			} else if (declaration !== undefined && isExportedProperty(lexed, declaration)) {
				block = blocked(site.range, "ExternalContract", "@export property names are stored in scene files");
			} else if (site.role === "import" && isLoaderLocal(facts.loaders, site.range)) {
				block = blocked(
					site.range,
					"ExternalContract",
					"the local import binding is not the source export name",
				);
			} else if (isDynamicLoaderCall(facts.loaders, site.range, site.role)) {
				block = blocked(site.range, "NotImplemented", "computed loader paths are not safely renameable");
			} else if (current !== params.oldName) {
				block = blocked(site.range, "NotImplemented", "the site is not an identifier span");
			}
		}
		if (block !== undefined) {
			const key = `${block.range.start.line}:${block.range.start.character}:${block.range.end.line}:${block.range.end.character}:${block.reason}`;
			if (!seenBlocked.has(key)) {
				seenBlocked.add(key);
				blockedSites.push(block);
			}
			continue;
		}
		if (current !== params.oldName) continue;
		const key = `${site.range.start.line}:${site.range.start.character}:${site.range.end.line}:${site.range.end.character}`;
		if (!seenEdits.has(key)) {
			seenEdits.add(key);
			edits.push({ range: site.range, newText: params.newName });
		}
	}

	// The shared analysis, not a sixth hand-rolled overlap check. This one refuses the whole request
	// where the TypeScript side blocks the site, which comes to the same thing: core aborts a rename
	// with any blocked site anyway. Refusing keeps this provider's existing contract.
	const plan = planEdits(coordinates, edits);
	const conflict = plan.conflicts[0];
	if (conflict !== undefined) {
		const named = RENAME_EDIT_CONFLICT[conflict.conflict];
		return refused(named.reason, named.detail);
	}

	const rewritten = applyEdits(params.text, plan.edits);
	if ("problem" in rewritten) return refused("ParseError", "the proposed edits do not produce parseable GDScript");
	try {
		extractFile(params.module, rewritten.text);
	} catch {
		return refused("ParseError", "the proposed edits do not produce parseable GDScript");
	}
	return { status: "ready", edits, blocked: blockedSites };
}
