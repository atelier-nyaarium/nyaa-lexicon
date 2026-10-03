import {
	type Certainty,
	type Conflict,
	composeSymbolId,
	type Declaration,
	type Descriptor,
	type ImportEdge,
} from "@nyaa-lexicon/protocol";
import { identifiers } from "./declarationShape.js";
import { type ImportInfo, LANGUAGE } from "./facts.js";
import { childOfType, type LineTable, nameText, type SyntaxNode } from "./tree.js";

const KNOWN: Certainty = { status: "known" };

/** Explicit imports outrank star imports; two of one rank bringing a name leave it ambiguous. */
const EXPLICIT: Conflict = { priority: 1, amongTransfers: "exclude", againstLocal: "localWins" };

const STARRED: Conflict = { priority: 0, amongTransfers: "exclude", againstLocal: "localWins" };

export interface PackageHeader {
	name: string;
	declaration: Declaration;
}

export interface ImportDirective {
	info: ImportInfo;
	/** The source name node, absent for a star import. */
	source?: SyntaxNode;
}

export function packageHeaderOf(
	module: string,
	text: string,
	lines: LineTable,
	node: SyntaxNode,
): PackageHeader | undefined {
	const names = identifiers(childOfType(node, "qualified_identifier"));
	const last = names.at(-1);
	if (last === undefined) return undefined;
	const name = names.map((item) => nameText(text, item)).join(".");
	const descriptors: Descriptor[] = [{ kind: "namespace", name }];
	const range = lines.range(node.start, node.end);
	return {
		name,
		declaration: {
			symbolId: composeSymbolId({ language: LANGUAGE, module, descriptors }),
			kind: "package",
			languageKind: "package",
			name,
			range,
			selectionRange: lines.range(last.start, last.end),
			visibility: "public",
			exported: true,
			metrics: { lines: range.end.line - range.start.line + 1 },
		},
	};
}

/** `order` is the directive's place among the file's imports. */
export function importDirectiveOf(
	text: string,
	lines: LineTable,
	node: SyntaxNode,
	order: number,
): ImportDirective | undefined {
	const path = identifiers(childOfType(node, "qualified_identifier"));
	const first = path[0];
	const source = path.at(-1);
	if (first === undefined || source === undefined) return undefined;
	const star = childOfType(node, "*");
	const segments = path.map((item) => nameText(text, item));
	if (star !== undefined) {
		const edge: ImportEdge = {
			kind: "wildcard",
			span: lines.range(first.start, star.end),
			bindsLocally: true,
			selector: { kind: "visible" },
			conflict: STARRED,
			certainty: KNOWN,
			order,
		};
		return { info: { specifier: `${segments.join(".")}.*`, edge, star: true } };
	}
	const local = identifiers(node)[0] ?? source;
	const localName = nameText(text, local);
	const edge: ImportEdge = {
		kind: "named",
		span: lines.range(first.start, local.end),
		name: nameText(text, source),
		range: lines.range(source.start, source.end),
		local: localName,
		localRange: lines.range(local.start, local.end),
		bindsLocally: true,
		conflict: EXPLICIT,
		certainty: KNOWN,
		order,
	};
	return { info: { specifier: segments.join("."), edge, star: false, localName }, source };
}
