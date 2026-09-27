// Owns GDScript reference extraction.

import { comparePositions, coordinatesOf, type Reference } from "@nyaa-lexicon/protocol";
import { blocksOf, bodyEndLine } from "./blocks.js";
import { extractGdscript, isAccessorHead } from "./declarations.js";
import type { ComposeSymbolId, DeclarationFact, ReferenceBlock, ReferenceToken, SourceLine } from "./parse-model.js";
import { extendsPaths, isLoaderCall, loaderCalls, type PathLiteral } from "./path-syntax.js";
import { scanSource } from "./source-scan.js";
import {
	isIgnorable,
	type LexedSource,
	lexSource,
	matchingReferenceToken,
	nextReferenceToken,
	referenceAssignmentOperators,
	referenceCallKeywords,
	referenceKeywords,
	referenceTokens,
	tokenRange,
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
	const tokens = referenceTokens(scanSource(text));
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

function referenceBlocks(lexed: LexedSource, declarations: DeclarationFact[]): ReferenceBlock[] {
	const lines = lexed.lines;
	const bodies = blocksOf(lexed);
	const blocks: ReferenceBlock[] = [];
	for (const declaration of declarations.slice(1)) {
		if (declaration.kind === "property" && declaration.range.end.line > declaration.range.start.line) {
			let accessorLine = declaration.range.start.line + 1;
			while (accessorLine < lines.length && isIgnorable(lexed, accessorLine)) accessorLine++;
			const accessor = lines[accessorLine] as SourceLine | undefined;
			if (accessor !== undefined && isAccessorHead(lexed, accessorLine)) {
				blocks.push({
					startLine: accessorLine,
					endLine: declaration.range.end.line,
					indent: accessor.indent,
					containerId: declaration.symbolId,
					functionId: declaration.symbolId,
				});
			}
			continue;
		}
		if (declaration.kind !== "method" && declaration.languageKind !== "innerClass") continue;
		const line = lines[declaration.range.start.line] as SourceLine | undefined;
		if (line === undefined) continue;
		const indent = line.indent;
		blocks.push({
			startLine: declaration.range.start.line,
			endLine: bodyEndLine(bodies, declaration) - 1,
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

function referenceIsQualified(tokens: ReferenceToken[], index: number): boolean {
	return tokens[index - 1]?.value === ".";
}

function referenceIsAccessorHead(tokens: ReferenceToken[], index: number): boolean {
	const open = nextReferenceToken(tokens, index);
	if (open < 0 || (tokens[open] as ReferenceToken).value !== "(") return false;
	const close = matchingReferenceToken(tokens, open, "(", ")");
	const after = close < 0 ? -1 : nextReferenceToken(tokens, close);
	return after >= 0 && (tokens[after] as ReferenceToken).value === ":";
}

function extractGdscriptReferences(module: string, text: string, compose: ComposeSymbolId): Reference[] {
	const lexed = lexSource(text);
	const declarations = extractGdscript(module, text, compose);
	const tokens = lexed.tokens;
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

	const blocks = referenceBlocks(lexed, declarations);
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
	const addPathReference = (literal: PathLiteral, role: Reference["role"]): void => {
		const scope = referenceScopeAtLine(blocks, rootId, literal.range.start.line);
		pathReferences.push({
			name: literal.path,
			range: literal.range,
			role,
			binding: referenceBinding(literal.path, scope, localNames, parameterNames),
			fromId: scope.containerId,
			qualified: false,
		});
	};
	for (const literal of extendsPaths(tokens)) addPathReference(literal, "extends");
	for (const call of loaderCalls(tokens, coordinatesOf(text), declarations)) {
		if (call.literal === undefined) continue;
		literalLoaderPositions.add(`${call.range.start.line}:${call.range.start.character}`);
		addPathReference(call.literal, "import");
	}
	pathReferences.sort((left, right) => comparePositions(left.range.start, right.range.start));
	const addReference = (index: number, role: Reference["role"], binding?: Reference["binding"]): void => {
		const token = tokens[index] as ReferenceToken;
		const scope = referenceScopeAtLine(blocks, rootId, token.line);
		references.push({
			name: token.value,
			range: tokenRange(token),
			role,
			binding: binding ?? referenceBinding(token.value, scope, localNames, parameterNames),
			fromId: scope.containerId,
			qualified: referenceIsQualified(tokens, index),
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
			if (next >= 0 && (tokens[next] as ReferenceToken).kind === "identifier") addReference(next, "write");
			continue;
		}
		if (token.value === "extends") {
			let target = nextReferenceToken(tokens, index);
			while (target >= 0 && target < tokens.length && (tokens[target] as ReferenceToken).kind !== "newline") {
				const candidate = tokens[target] as ReferenceToken;
				if (
					candidate.kind === "identifier" &&
					heritagePositions.has(`${candidate.line}:${candidate.character}`)
				) {
					addReference(target, "extends");
					break;
				}
				target++;
			}
			continue;
		}
		if (isLoaderCall(tokens, index)) {
			if (!literalLoaderPositions.has(tokenKey))
				addReference(index, "call", {
					status: "unbound",
					reason: "RuntimeConstructed",
					detail: "the loader path is computed at runtime",
				});
			continue;
		}
		if (token.value === "new" && previous?.value === ".") continue;
		if (heritagePositions.has(tokenKey)) continue;
		if (typePositions.has(tokenKey)) {
			addReference(index, "typeUse");
			continue;
		}
		if (declarationPositions.has(tokenKey) || parameterPositions.has(tokenKey)) continue;
		if (referenceKeywords.has(token.value) || previous?.value === "@") continue;
		if ((token.value === "get" || token.value === "set") && referenceIsAccessorHead(tokens, index)) continue;
		const increment = nextValue === "++" || previous?.value === "++";
		if (increment) {
			addReference(index, "read");
			addReference(index, "write");
			continue;
		}
		if (referenceAssignmentOperators.has(nextValue) && !referenceIsNamedArgument(tokens, index)) {
			if (nextValue !== "=" && nextValue !== ":=") addReference(index, "read");
			addReference(index, "write");
			continue;
		}
		if (nextValue === "(") {
			if (
				!referenceCallKeywords.has(token.value) &&
				token.value !== "new" &&
				!referenceIsAccessorHead(tokens, index)
			) {
				addReference(index, "call");
			}
			continue;
		}
		addReference(index, "read");
	}
	return [...references, ...pathReferences];
}

export function extractReferencesCore(module: string, text: string, compose: ComposeSymbolId): Reference[] {
	return module.endsWith(".gd") ? extractGdscriptReferences(module, text, compose) : [];
}
