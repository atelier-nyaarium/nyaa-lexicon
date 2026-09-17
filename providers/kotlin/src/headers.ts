import { composeSymbolId, type Declaration, type Descriptor, type ImportedName } from "@nyaa-lexicon/protocol";
import { identifiers } from "./declarationShape.js";
import { type ImportInfo, LANGUAGE } from "./facts.js";
import { childOfType, type LineTable, nameText, type SyntaxNode } from "./tree.js";

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

export function importDirectiveOf(text: string, lines: LineTable, node: SyntaxNode): ImportDirective | undefined {
	const path = identifiers(childOfType(node, "qualified_identifier"));
	const source = path.at(-1);
	if (source === undefined) return undefined;
	const star = childOfType(node, "*");
	const alias = identifiers(node)[0];
	const segments = path.map((item) => nameText(text, item));
	const specifier = `${segments.join(".")}${star === undefined ? "" : ".*"}`;
	const sourceName = nameText(text, source);
	const imported: ImportedName[] =
		star === undefined
			? [
					{
						name: sourceName,
						range: lines.range(source.start, source.end),
						local: nameText(text, alias ?? source),
						localRange: lines.range((alias ?? source).start, (alias ?? source).end),
					},
				]
			: [{ name: "*", range: lines.range(star.start, star.end) }];
	const info: ImportInfo = {
		specifier,
		imported,
		reExport: false,
		star: star !== undefined,
		...(star === undefined ? { importedName: sourceName, localName: nameText(text, alias ?? source) } : {}),
	};
	return star === undefined ? { info, source } : { info };
}
