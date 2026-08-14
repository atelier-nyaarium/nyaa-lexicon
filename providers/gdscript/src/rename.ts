import {
	applyEdits,
	type BlockedSite,
	coordinatesOf,
	type Declaration,
	type Range,
	type RenameEditsRequest,
	type RenameEditsResponse,
	type TextCoordinates,
	type TextEdit,
} from "@nyaa-lexicon/protocol";
import { extractFile } from "./extract.js";
import { extractGdscriptParameterNames, isGdscriptIdentifier } from "./extractCore.js";

type StringSpan = { start: number; end: number; contentStart: number; contentEnd: number };

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

function positionCompare(left: Range["start"], right: Range["start"]): number {
	return left.line - right.line || left.character - right.character;
}

function sameRange(left: Range, right: Range): boolean {
	return (
		left.start.line === right.start.line &&
		left.start.character === right.start.character &&
		left.end.line === right.end.line &&
		left.end.character === right.end.character
	);
}

function stringSpans(text: string): StringSpan[] {
	const spans: StringSpan[] = [];
	let index = 0;
	let lineStart = true;
	while (index < text.length) {
		const character = text[index];
		if (character === "\n") {
			lineStart = true;
			index++;
			continue;
		}
		if (lineStart && (character === " " || character === "\t" || character === "\r")) {
			index++;
			continue;
		}
		lineStart = false;
		if (character === "#") {
			const newline = text.indexOf("\n", index);
			index = newline < 0 ? text.length : newline;
			continue;
		}
		if (character !== "'" && character !== '"') {
			index++;
			continue;
		}
		const quote = character;
		const triple = text.startsWith(quote.repeat(3), index);
		const delimiterLength = triple ? 3 : 1;
		const contentStart = index + delimiterLength;
		let cursor = contentStart;
		let close = text.length;
		while (cursor < text.length) {
			if (text[cursor] === "\\") {
				cursor += 2;
				continue;
			}
			if (text.startsWith(quote.repeat(delimiterLength), cursor)) {
				close = cursor;
				break;
			}
			cursor++;
		}
		const end = close === text.length ? text.length : close + delimiterLength;
		spans.push({ start: index, end, contentStart, contentEnd: close });
		index = end;
	}
	return spans;
}

function stringSpanFor(spans: StringSpan[], start: number, end: number): StringSpan | undefined {
	return spans.find((span) => start >= span.contentStart && end <= span.contentEnd);
}

function lineText(text: string, line: number): string {
	return text.split(/\r?\n/u)[line] ?? "";
}

function declarationAt(declarations: Declaration[], range: Range): Declaration | undefined {
	return declarations.find((declaration) => sameRange(declaration.selectionRange, range));
}

function isExportedProperty(text: string, declaration: Declaration): boolean {
	const line = lineText(text, declaration.selectionRange.start.line);
	return /^\s*@export(?:\b|_)/.test(line);
}

function isClassNameLine(coordinates: TextCoordinates, range: Range): boolean {
	const before = coordinates.sliceRange({
		start: { line: range.start.line, character: 0 },
		end: range.start,
	});
	return before !== undefined && /\bclass_name\s*$/.test(before);
}

function isLoaderLocal(coordinates: TextCoordinates, text: string, range: Range): boolean {
	const line = lineText(text, range.start.line);
	const before = coordinates.sliceRange({
		start: { line: range.start.line, character: 0 },
		end: range.start,
	});
	const after = coordinates.sliceRange({
		start: range.end,
		end: { line: range.end.line, character: line.length },
	});
	return (
		before !== undefined &&
		after !== undefined &&
		/\b(?:const|var)\s*$/.test(before) &&
		/^\s*(?::[^=]*)?=\s*(?:preload|load)\s*\(/.test(after)
	);
}

function isDynamicLoaderCall(
	coordinates: TextCoordinates,
	text: string,
	range: Range,
	role: string | undefined,
): boolean {
	if (role !== "call" && role !== "import") return false;
	const current = coordinates.sliceRange(range);
	if (current !== "load" && current !== "preload") return false;
	const line = lineText(text, range.start.line);
	return /\b(?:preload|load)\s*\(\s*(?!["'])/.test(line);
}

function blocked(range: Range, reason: BlockedSite["reason"], detail: string): BlockedSite {
	return { range, reason, detail };
}

function refused(reason: "InvalidName" | "ReservedWord" | "Collision" | "ParseError", detail: string) {
	return { status: "refused", reason, detail } as const;
}

export function renameGdscript(
	params: RenameEditsRequest,
	hasRegisteredClassName: (name: string) => boolean,
): RenameEditsResponse {
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
	if (hasRegisteredClassName(params.newName))
		return refused("Collision", "the new name is already a registered class_name");

	const coordinates = coordinatesOf(params.text);
	const spans = stringSpans(params.text);
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
		const stringSpan = stringSpanFor(spans, offsets.start, offsets.end);
		let block: BlockedSite | undefined;
		if (stringSpan !== undefined) {
			const prefix = params.text.slice(Math.max(0, stringSpan.start - 160), stringSpan.start);
			block = blocked(
				site.range,
				/\b(?:connect|emit_signal)\s*\(\s*$/.test(prefix) ? "StringLiteral" : "ExternalContract",
				"the site is a string literal whose consumer is outside identifier syntax",
			);
		} else {
			const declaration = declarationAt(facts.declarations, site.range);
			if (declaration?.languageKind === "class_name" || isClassNameLine(coordinates, site.range)) {
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
			} else if (declaration !== undefined && isExportedProperty(params.text, declaration)) {
				block = blocked(site.range, "ExternalContract", "@export property names are stored in scene files");
			} else if (site.role === "import" && isLoaderLocal(coordinates, params.text, site.range)) {
				block = blocked(
					site.range,
					"ExternalContract",
					"the local import binding is not the source export name",
				);
			} else if (isDynamicLoaderCall(coordinates, params.text, site.range, site.role)) {
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

	edits.sort((left, right) => positionCompare(right.range.start, left.range.start));
	for (let index = 1; index < edits.length; index++) {
		const previous = edits[index - 1] as TextEdit;
		const current = edits[index] as TextEdit;
		const previousOffsets = coordinates.offsetsForRange(previous.range);
		const currentOffsets = coordinates.offsetsForRange(current.range);
		if (
			previousOffsets === undefined ||
			currentOffsets === undefined ||
			currentOffsets.end > previousOffsets.start
		) {
			return refused("ParseError", "rename sites overlap");
		}
	}
	const rewritten = applyEdits(params.text, edits);
	if ("problem" in rewritten) return refused("ParseError", "the proposed edits do not produce parseable GDScript");
	try {
		extractFile(params.module, rewritten.text);
	} catch {
		return refused("ParseError", "the proposed edits do not produce parseable GDScript");
	}
	return { status: "ready", edits, blocked: blockedSites };
}
