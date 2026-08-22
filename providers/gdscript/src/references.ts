// Owns GDScript reference extraction and shared token spans.

import type { Reference, TextCoordinates } from "@nyaa-lexicon/protocol";
import { extractGdscript, headerEndLine, isAccessorHead } from "./declarations.js";
import { indentOf, isIgnorable } from "./line-syntax.js";
import type { ComposeSymbolId, DeclarationFact, ReferenceBlock, ReferenceToken, SourceLine } from "./parse-model.js";
import { pathSyntax } from "./path-syntax.js";
import { readLines } from "./source-scan.js";
import {
	matchingReferenceToken,
	nextReferenceToken,
	referenceAssignmentOperators,
	referenceCallKeywords,
	referenceKeywords,
	referenceTokens,
} from "./tokens.js";

//////// References

function addReferenceTypeExpression(
	tokens: ReferenceToken[],
	start: number,
	stops: Set<string>,
	typePositions: Set<string>,
	heritagePositions?: Set<string>,
): void {
	let parentheses = 0;
	let brackets = 0;
	let braces = 0;
	for (let index = start; index < tokens.length; index++) {
		const token = tokens[index] as ReferenceToken;
		if (token.kind === "newline" && parentheses === 0 && brackets === 0 && braces === 0) break;
		if (parentheses === 0 && brackets === 0 && braces === 0 && stops.has(token.value)) break;
		if (token.value === "(") parentheses++;
		else if (token.value === ")") {
			if (parentheses === 0) break;
			parentheses--;
		} else if (token.value === "[") brackets++;
		else if (token.value === "]") brackets--;
		else if (token.value === "{") braces++;
		else if (token.value === "}") {
			if (braces === 0) break;
			braces--;
		} else if (token.kind === "identifier") {
			(heritagePositions ?? typePositions).add(`${token.line}:${token.character}`);
		}
	}
}

function addReferenceParameters(
	tokens: ReferenceToken[],
	start: number,
	end: number,
	parameterPositions: Set<string>,
): void {
	let segmentStart = start;
	let parentheses = 0;
	let brackets = 0;
	let braces = 0;
	const addSegment = (from: number, to: number): void => {
		for (let index = from; index < to; index++) {
			const token = tokens[index] as ReferenceToken;
			if (token.kind === "identifier") {
				parameterPositions.add(`${token.line}:${token.character}`);
				return;
			}
		}
	};
	for (let index = start; index < end; index++) {
		const value = (tokens[index] as ReferenceToken).value;
		if (value === "(") parentheses++;
		else if (value === ")") parentheses--;
		else if (value === "[") brackets++;
		else if (value === "]") brackets--;
		else if (value === "{") braces++;
		else if (value === "}") braces--;
		else if (value === "," && parentheses === 0 && brackets === 0 && braces === 0) {
			addSegment(segmentStart, index);
			segmentStart = index + 1;
		}
	}
	addSegment(segmentStart, end);
}

export function extractGdscriptParameterNames(text: string): Set<string> {
	const tokens = referenceTokens(readLines(text));
	const parameterPositions = new Set<string>();
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index] as ReferenceToken;
		if (token.kind !== "identifier" || token.value !== "func") continue;
		let open = nextReferenceToken(tokens, index);
		while (open >= 0 && (tokens[open] as ReferenceToken).value !== "(") open = nextReferenceToken(tokens, open);
		if (open < 0) continue;
		const close = matchingReferenceToken(tokens, open, "(", ")");
		if (close >= 0) addReferenceParameters(tokens, open + 1, close, parameterPositions);
	}
	return new Set(
		tokens
			.filter(
				(token) => token.kind === "identifier" && parameterPositions.has(`${token.line}:${token.character}`),
			)
			.map((token) => token.value),
	);
}

function referenceBlockEnd(lines: SourceLine[], headerEndLine: number, indent: number): number {
	for (let index = headerEndLine + 1; index < lines.length; index++) {
		const line = lines[index] as SourceLine;
		if (!isIgnorable(line) && indentOf(line.text) <= indent) return index - 1;
	}
	return lines.length - 1;
}

function referenceBlocks(lines: SourceLine[], declarations: DeclarationFact[]): ReferenceBlock[] {
	const blocks: ReferenceBlock[] = [];
	for (const declaration of declarations.slice(1)) {
		if (declaration.kind === "property" && declaration.range.end.line > declaration.range.start.line) {
			let accessorLine = declaration.range.start.line + 1;
			while (accessorLine < lines.length && isIgnorable(lines[accessorLine] as SourceLine)) accessorLine++;
			const accessor = lines[accessorLine] as SourceLine | undefined;
			if (accessor !== undefined && isAccessorHead(accessor)) {
				blocks.push({
					startLine: accessorLine,
					endLine: declaration.range.end.line,
					indent: indentOf(accessor.text),
					containerId: declaration.symbolId,
					functionId: declaration.symbolId,
				});
			}
			continue;
		}
		if (declaration.kind !== "method" && declaration.languageKind !== "innerClass") continue;
		const line = lines[declaration.range.start.line] as SourceLine | undefined;
		if (line === undefined) continue;
		const indent = indentOf(line.text);
		blocks.push({
			startLine: declaration.range.start.line,
			endLine: referenceBlockEnd(lines, headerEndLine(lines, declaration), indent),
			indent,
			containerId: declaration.symbolId,
			...(declaration.kind === "method" ? { functionId: declaration.symbolId } : {}),
		});
	}
	return blocks;
}

function referenceScopeAtLine(blocks: ReferenceBlock[], rootId: string, line: number): ReferenceBlock {
	let selected: ReferenceBlock = { startLine: -1, endLine: Number.MAX_SAFE_INTEGER, indent: -1, containerId: rootId };
	for (const block of blocks) {
		if (line >= block.startLine && line <= block.endLine && block.startLine >= selected.startLine) selected = block;
	}
	return selected;
}

export function referenceRange(token: ReferenceToken) {
	return {
		start: { line: token.line, character: token.character },
		end: { line: token.line, character: token.character + token.value.length },
	};
}

function referenceBinding(
	name: string,
	scope: ReferenceBlock,
	localNames: Map<string, Set<string>>,
	parameterNames: Map<string, Set<string>>,
): Reference["binding"] {
	const functionNames = localNames.get(scope.functionId ?? "");
	const functionParameters = parameterNames.get(scope.functionId ?? scope.containerId);
	if (functionNames?.has(name) || functionParameters?.has(name)) {
		return { status: "unbound", reason: "NotIndexed", detail: "the declaration is not in the symbol index" };
	}
	return { status: "unbound", reason: "NotImplemented", detail: "GDScript binding is not implemented" };
}

function referenceIsNamedArgument(tokens: ReferenceToken[], assignmentIndex: number): boolean {
	let previous = assignmentIndex - 1;
	while (previous >= 0 && (tokens[previous] as ReferenceToken).kind === "newline") previous--;
	if (previous < 0 || (tokens[previous] as ReferenceToken).kind !== "identifier") return false;
	let parentheses = 0;
	for (let index = previous - 1; index >= 0; index--) {
		const value = (tokens[index] as ReferenceToken).value;
		if (value === ")") parentheses++;
		if (value === "(") {
			if (parentheses > 0) {
				parentheses--;
				continue;
			}
			let before = index - 1;
			while (before >= 0 && (tokens[before] as ReferenceToken).kind === "newline") before--;
			const token = tokens[before] as ReferenceToken | undefined;
			return token?.kind === "identifier" && !referenceCallKeywords.has(token.value);
		}
	}
	return false;
}

function referenceIsAccessorHead(tokens: ReferenceToken[], index: number): boolean {
	const open = nextReferenceToken(tokens, index);
	if (open < 0 || (tokens[open] as ReferenceToken).value !== "(") return false;
	const close = matchingReferenceToken(tokens, open, "(", ")");
	const after = close < 0 ? -1 : nextReferenceToken(tokens, close);
	return after >= 0 && (tokens[after] as ReferenceToken).value === ":";
}

function extractGdscriptReferences(module: string, text: string, compose: ComposeSymbolId): Reference[] {
	const lines = readLines(text);
	const declarations = extractGdscript(module, text, compose);
	const tokens = referenceTokens(lines);
	// Every declaration this provider extracts has its name in the source.
	const declarationPositions = new Set(
		declarations.map((declaration) =>
			declaration.selectionRange === undefined
				? undefined
				: `${declaration.selectionRange.start.line}:${declaration.selectionRange.start.character}`,
		),
	);
	const parameterPositions = new Set<string>();
	const typePositions = new Set<string>();
	const heritagePositions = new Set<string>();
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index] as ReferenceToken;
		if (token.value === "->") {
			addReferenceTypeExpression(tokens, index + 1, new Set([":"]), typePositions);
			continue;
		}
		if (token.kind !== "identifier") continue;
		if (
			token.value === "func" ||
			token.value === "signal" ||
			((token.value === "get" || token.value === "set") && referenceIsAccessorHead(tokens, index))
		) {
			let open = nextReferenceToken(tokens, index);
			while (open >= 0 && (tokens[open] as ReferenceToken).value !== "(") open = nextReferenceToken(tokens, open);
			if (open >= 0 && (tokens[open] as ReferenceToken).value === "(") {
				const close = matchingReferenceToken(tokens, open, "(", ")");
				if (close >= 0) addReferenceParameters(tokens, open + 1, close, parameterPositions);
			}
		}
		if (token.value === "as" || token.value === "is") {
			addReferenceTypeExpression(tokens, index + 1, new Set([",", ")", "]", "=", ":", "in"]), typePositions);
		}
		if (token.value === "extends") {
			addReferenceTypeExpression(tokens, index + 1, new Set([":"]), typePositions, heritagePositions);
		}
	}
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index] as ReferenceToken;
		if (token.kind !== "identifier") continue;
		const next = nextReferenceToken(tokens, index);
		if (
			(declarationPositions.has(`${token.line}:${token.character}`) ||
				parameterPositions.has(`${token.line}:${token.character}`)) &&
			next >= 0 &&
			(tokens[next] as ReferenceToken).value === ":"
		) {
			addReferenceTypeExpression(tokens, next + 1, new Set(["=", ",", ")", "in", ":"]), typePositions);
		}
	}

	const blocks = referenceBlocks(lines, declarations);
	const rootId = (declarations[0] as DeclarationFact).symbolId;
	const localNames = new Map<string, Set<string>>();
	for (const declaration of declarations) {
		if (declaration.visibility !== "local" || declaration.containerId === undefined) continue;
		const names = localNames.get(declaration.containerId) ?? new Set<string>();
		names.add(declaration.name);
		localNames.set(declaration.containerId, names);
	}
	const parameterNames = new Map<string, Set<string>>();
	for (const token of tokens) {
		if (token.kind !== "identifier" || !parameterPositions.has(`${token.line}:${token.character}`)) continue;
		const scope = referenceScopeAtLine(blocks, rootId, token.line);
		const ownerId = scope.functionId ?? scope.containerId;
		const names = parameterNames.get(ownerId) ?? new Set<string>();
		names.add(token.value);
		parameterNames.set(ownerId, names);
	}

	const references: Reference[] = [];
	const pathReferences: Reference[] = [];
	const literalLoaderPositions = new Set<string>();
	const addPathReference = (line: SourceLine, name: string, start: number, role: Reference["role"]): void => {
		const scope = referenceScopeAtLine(blocks, rootId, line.line);
		pathReferences.push({
			name,
			range: {
				start: { line: line.line, character: start },
				end: { line: line.line, character: start + name.length },
			},
			role,
			binding: referenceBinding(name, scope, localNames, parameterNames),
			fromId: scope.containerId,
		});
	};
	for (const line of lines) {
		for (const path of pathSyntax(line)) {
			if (path.kind === "extends") {
				addPathReference(line, path.path, path.pathStart, "extends");
				continue;
			}
			literalLoaderPositions.add(`${line.line}:${path.loaderStart}`);
			addPathReference(line, path.path, path.pathStart, "import");
		}
	}
	const addReference = (
		token: ReferenceToken,
		role: Reference["role"],
		binding = referenceBinding(
			token.value,
			referenceScopeAtLine(blocks, rootId, token.line),
			localNames,
			parameterNames,
		),
	): void => {
		const scope = referenceScopeAtLine(blocks, rootId, token.line);
		references.push({
			name: token.value,
			range: referenceRange(token),
			role,
			binding,
			fromId: scope.containerId,
		});
	};
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index] as ReferenceToken;
		if (token.kind !== "identifier") continue;
		const tokenKey = `${token.line}:${token.character}`;
		const next = nextReferenceToken(tokens, index);
		const nextValue = next < 0 ? "" : (tokens[next] as ReferenceToken).value;
		const previous = index > 0 ? (tokens[index - 1] as ReferenceToken) : undefined;
		if (token.value === "for") {
			if (next >= 0 && (tokens[next] as ReferenceToken).kind === "identifier")
				addReference(tokens[next] as ReferenceToken, "write");
			continue;
		}
		if (token.value === "extends") {
			let target = nextReferenceToken(tokens, index);
			while (target >= 0 && (tokens[target] as ReferenceToken).kind !== "newline") {
				const candidate = tokens[target] as ReferenceToken;
				if (
					candidate.kind === "identifier" &&
					heritagePositions.has(`${candidate.line}:${candidate.character}`)
				) {
					addReference(candidate, "extends");
					break;
				}
				target++;
			}
			continue;
		}
		if (token.value === "preload" || token.value === "load") {
			if (!literalLoaderPositions.has(tokenKey) && next >= 0 && nextValue === "(")
				addReference(token, "call", {
					status: "unbound",
					reason: "RuntimeConstructed",
					detail: "the loader path is computed at runtime",
				});
			continue;
		}
		if (token.value === "new" && previous?.value === ".") continue;
		if (heritagePositions.has(tokenKey)) continue;
		if (typePositions.has(tokenKey)) {
			addReference(token, "typeUse");
			continue;
		}
		if (declarationPositions.has(tokenKey) || parameterPositions.has(tokenKey)) continue;
		if (referenceKeywords.has(token.value) || previous?.value === "@") continue;
		if ((token.value === "get" || token.value === "set") && referenceIsAccessorHead(tokens, index)) continue;
		const increment = nextValue === "++" || previous?.value === "++";
		if (increment) {
			addReference(token, "read");
			addReference(token, "write");
			continue;
		}
		if (referenceAssignmentOperators.has(nextValue) && !referenceIsNamedArgument(tokens, index)) {
			if (nextValue !== "=" && nextValue !== ":=") addReference(token, "read");
			addReference(token, "write");
			continue;
		}
		if (nextValue === "(") {
			if (
				!referenceCallKeywords.has(token.value) &&
				token.value !== "new" &&
				!referenceIsAccessorHead(tokens, index)
			) {
				addReference(token, "call");
			}
			continue;
		}
		addReference(token, "read");
	}
	return [...references, ...pathReferences];
}

export function sourceBetween(
	coordinates: TextCoordinates,
	start: ReferenceToken,
	end: ReferenceToken,
): string | undefined {
	return coordinates.sliceRange({
		start: { line: start.line, character: start.character },
		end: { line: end.line, character: end.character + end.value.length },
	});
}

export function extractReferencesCore(module: string, text: string, compose: ComposeSymbolId): Reference[] {
	return module.endsWith(".gd") ? extractGdscriptReferences(module, text, compose) : [];
}
