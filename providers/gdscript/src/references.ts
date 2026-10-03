// Owns GDScript reference extraction.

import { comparePositions, type Reference, type ReferenceOrigin, sameRange } from "@nyaa-lexicon/protocol";
import { type Blocks, bodyEndLine } from "./blocks.js";
import { isAccessorHead } from "./declarations.js";
import type { LogicalLine } from "./expression.js";
import type { DeclarationFact, ReferenceBlock, ReferenceToken, SourceLine } from "./parse-model.js";
import {
	extendsPaths,
	isLoaderCall,
	type LoaderCall,
	loaderCalls,
	nodePathNames,
	type PathLiteral,
} from "./path-syntax.js";
import { sameFileCandidates } from "./same-file.js";
import type { ParsedScript } from "./script.js";
import {
	isIgnorable,
	type LexedSource,
	matchingReferenceToken,
	nextReferenceToken,
	referenceAssignmentOperators,
	referenceCallKeywords,
	referenceKeywords,
	tokenAt,
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

export function parameterNamesOf(tokens: ReferenceToken[]): Set<string> {
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

function referenceBlocks(lexed: LexedSource, bodies: Blocks, declarations: DeclarationFact[]): ReferenceBlock[] {
	const lines = lexed.lines;
	const blocks: ReferenceBlock[] = [];
	for (const declaration of declarations.slice(1)) {
		// From the name line: annotations above read in the enclosing scope.
		const head = declaration.selectionRange.start.line;
		// Accessors or a lambda's block.
		if (declaration.kind === "property" && declaration.range.end.line > head) {
			let bodyLine = head + 1;
			while (bodyLine < lines.length && isIgnorable(lexed, bodyLine)) bodyLine++;
			const body = lines[bodyLine] as SourceLine | undefined;
			if (body === undefined) continue;
			// A lambda's parameters sit on the header line.
			blocks.push({
				startLine: isAccessorHead(lexed, bodyLine) ? bodyLine : head,
				endLine: declaration.range.end.line,
				indent: body.indent,
				containerId: declaration.symbolId,
				functionId: declaration.symbolId,
			});
			continue;
		}
		if (declaration.kind !== "method" && declaration.languageKind !== "innerClass") continue;
		const line = lines[head] as SourceLine | undefined;
		if (line === undefined) continue;
		const indent = line.indent;
		blocks.push({
			startLine: head,
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
	qualified = false,
): Reference["binding"] {
	const functionNames = localNames.get(scope.functionId ?? "");
	const functionParameters = parameterNames.get(scope.functionId ?? scope.containerId);
	// A member read through a receiver never names a local.
	if (!qualified && (functionNames?.has(name) || functionParameters?.has(name))) {
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

/** Its parentheses, then a colon. */
function opensParameterBlock(tokens: ReferenceToken[], index: number): boolean {
	const open = nextReferenceToken(tokens, index);
	if (open < 0 || (tokens[open] as ReferenceToken).value !== "(") return false;
	const close = matchingReferenceToken(tokens, open, "(", ")");
	const after = close < 0 ? -1 : nextReferenceToken(tokens, close);
	return after >= 0 && (tokens[after] as ReferenceToken).value === ":";
}

/** Lines from a property's name through its accessors. */
function accessorLinesOf(declarations: readonly DeclarationFact[]): Set<number> {
	const lines = new Set<number>();
	for (const declaration of declarations) {
		if (declaration.kind !== "property") continue;
		const head = declaration.selectionRange.start.line;
		for (let line = head; line <= declaration.range.end.line; line++) lines.add(line);
	}
	return lines;
}

/** `get:`, `set(value):` or `get = fn`, leading a property's accessor. */
function isAccessorKeyword(tokens: ReferenceToken[], index: number, accessorLines: Set<number>): boolean {
	const token = tokens[index] as ReferenceToken;
	if ((token.value !== "get" && token.value !== "set") || !accessorLines.has(token.line)) return false;
	const previous = tokens[index - 1];
	if (previous !== undefined && previous.kind !== "newline" && previous.value !== "," && previous.value !== ":")
		return false;
	const next = tokens[nextReferenceToken(tokens, index)]?.value;
	return next === ":" || next === "=" || opensParameterBlock(tokens, index);
}

/** A cast or test's type, `not` skipped: `Name`, `A.B` or `Array[T]`. */
function addCastType(tokens: ReferenceToken[], keyword: number, typePositions: Set<string>): void {
	const mark = (index: number): void => {
		const token = tokens[index] as ReferenceToken;
		typePositions.add(`${token.line}:${token.character}`);
	};
	let at = nextReferenceToken(tokens, keyword);
	if (tokens[at]?.value === "not") at = nextReferenceToken(tokens, at);
	if (tokens[at]?.kind !== "identifier") return;
	mark(at);
	for (let dot = nextReferenceToken(tokens, at); tokens[dot]?.value === "."; dot = nextReferenceToken(tokens, at)) {
		if (tokens[dot + 1]?.kind !== "identifier") return;
		at = dot + 1;
		mark(at);
	}
	const open = nextReferenceToken(tokens, at);
	if (tokens[open]?.value !== "[") return;
	const close = matchingReferenceToken(tokens, open, "[", "]");
	for (let index = open + 1; index < close; index++) if (tokens[index]?.kind === "identifier") mark(index);
}

/** A member read through a receiver, by its token index. */
interface QualifiedUse {
	index: number;
	reference: Reference;
}

/** The declaration a receiver token reads, by its token index. */
type ReceiverDeclaration = (receiver: Reference, index: number) => DeclarationFact | undefined;

/** The token a dotted chain starts from, and the member names after it through `index`. */
function memberChain(tokens: ReferenceToken[], index: number): { receiver: number; path: string[] } | undefined {
	const path = [(tokens[index] as ReferenceToken).value];
	let at = index;
	while (tokens[at - 1]?.value === ".") {
		at -= 2;
		const segment = tokens[at];
		if (segment?.kind !== "identifier") return undefined;
		if (tokens[at - 1]?.value !== ".") return { receiver: at, path };
		path.unshift(segment.value);
	}
	return undefined;
}

/** The function's one local of the receiver's name, declared in an earlier statement whose block holds the read. */
function visibleLocal(
	script: ParsedScript,
	receiver: Reference,
	index: number,
	parameters: ReadonlySet<string> | undefined,
): DeclarationFact | undefined {
	if (parameters?.has(receiver.name)) return undefined;
	const [local, ...others] = script.declarations.filter(
		(declaration) =>
			declaration.visibility === "local" &&
			declaration.containerId === receiver.fromId &&
			declaration.name === receiver.name,
	);
	if (local === undefined || others.length > 0) return undefined;
	const { blocks, lexed } = script;
	const { start } = local.selectionRange;
	const declared = blocks.owner[tokenAt(lexed, start.line, start.character)] ?? -1;
	const read = blocks.owner[index] ?? -1;
	const statement = blocks.statements[declared];
	// Its own statement, not an inline block's body.
	if (statement === undefined || read <= declared || lexed.tokens[statement.start]?.value !== "const")
		return undefined;
	for (let at = declared + 1; at <= read; at++) {
		if ((blocks.statements[at] as LogicalLine).indent < statement.indent) return undefined;
	}
	return local;
}

/** `X.a.b` where X binds to a const preload: that edge's span, and the members after X. */
function preloadOrigins(
	tokens: ReferenceToken[],
	members: readonly QualifiedUse[],
	receivers: ReadonlyMap<number, Reference>,
	receiverDeclaration: ReceiverDeclaration,
	calls: readonly LoaderCall[],
): Map<Reference, ReferenceOrigin> {
	const origins = new Map<Reference, ReferenceOrigin>();
	for (const { index, reference } of members) {
		const chain = memberChain(tokens, index);
		const receiver = chain === undefined ? undefined : receivers.get(chain.receiver);
		if (chain === undefined || receiver === undefined) continue;
		const declaration = receiverDeclaration(receiver, chain.receiver);
		if (declaration === undefined) continue;
		const call = calls.find(
			(candidate) =>
				candidate.loader === "preload" &&
				candidate.literal !== undefined &&
				candidate.binding?.keyword === "const" &&
				candidate.binding.whole &&
				sameRange(candidate.binding.range, declaration.selectionRange),
		);
		if (call !== undefined) origins.set(reference, { kind: "import", span: call.span, path: chain.path });
	}
	return origins;
}

function extractGdscriptReferences(script: ParsedScript): Reference[] {
	const { lexed, declarations } = script;
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
	const accessorLines = accessorLinesOf(declarations);
	const nodePaths = nodePathNames(tokens);
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index] as ReferenceToken;
		if (token.value === "->") {
			addReferenceTypeExpression(tokens, index + 1, new Set([":"]), typePositions);
			continue;
		}
		if (token.kind !== "identifier") continue;
		const accessor = isAccessorKeyword(tokens, index, accessorLines);
		if (token.value === "func" || token.value === "signal" || (accessor && opensParameterBlock(tokens, index))) {
			let open = nextReferenceToken(tokens, index);
			while (open >= 0 && (tokens[open] as ReferenceToken).value !== "(") open = nextReferenceToken(tokens, open);
			if (open >= 0 && (tokens[open] as ReferenceToken).value === "(") {
				const close = matchingReferenceToken(tokens, open, "(", ")");
				if (close >= 0) addReferenceParameters(tokens, open + 1, close, parameterPositions);
			}
		}
		if (token.value === "as" || token.value === "is") addCastType(tokens, index, typePositions);
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

	const blocks = referenceBlocks(lexed, script.blocks, declarations);
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
	const calls = loaderCalls(tokens, script.coordinates, declarations);
	for (const call of calls) {
		if (call.literal === undefined) continue;
		literalLoaderPositions.add(`${call.range.start.line}:${call.range.start.character}`);
		addPathReference(call.literal, "import");
	}
	pathReferences.sort((left, right) => comparePositions(left.range.start, right.range.start));
	const receivers = new Map<number, Reference>();
	const members: QualifiedUse[] = [];
	const addReference = (index: number, role: Reference["role"], binding?: Reference["binding"]): void => {
		const token = tokens[index] as ReferenceToken;
		const scope = referenceScopeAtLine(blocks, rootId, token.line);
		const qualified = referenceIsQualified(tokens, index);
		const reference: Reference = {
			name: token.value,
			range: tokenRange(token),
			role,
			binding: binding ?? referenceBinding(token.value, scope, localNames, parameterNames, qualified),
			fromId: scope.containerId,
			qualified,
		};
		references.push(reference);
		if (role === "read" || role === "typeUse") receivers.set(index, reference);
		if (qualified) members.push({ index, reference });
	};
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index] as ReferenceToken;
		// A lone `_` is Godot's wildcard, not a name.
		if (token.kind !== "identifier" || token.value === "_" || nodePaths.has(index)) continue;
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
		if (isAccessorKeyword(tokens, index, accessorLines)) continue;
		if (referenceAssignmentOperators.has(nextValue) && !referenceIsNamedArgument(tokens, index)) {
			if (nextValue !== "=" && nextValue !== ":=") addReference(index, "read");
			addReference(index, "write");
			continue;
		}
		if (nextValue === "(") {
			if (!referenceCallKeywords.has(token.value) && token.value !== "new") addReference(index, "call");
			continue;
		}
		addReference(index, "read");
	}
	const receiverDeclaration: ReceiverDeclaration = (receiver, index) => {
		if (receiver.binding.status !== "unbound") return undefined;
		if (receiver.binding.reason === "NotIndexed") {
			const scope = referenceScopeAtLine(blocks, rootId, receiver.range.start.line);
			const parameters = parameterNames.get(scope.functionId ?? scope.containerId);
			return visibleLocal(script, receiver, index, parameters);
		}
		if (receiver.binding.reason !== "NotImplemented") return undefined;
		// A type position names the constant as a read does.
		const [declaration, ...others] = sameFileCandidates(declarations, { ...receiver, role: "read" });
		return others.length > 0 ? undefined : declaration;
	};
	const origins = preloadOrigins(tokens, members, receivers, receiverDeclaration, calls);
	const traced = references.map((reference) => {
		const origin = origins.get(reference);
		return origin === undefined ? reference : { ...reference, origin };
	});
	return [...traced, ...pathReferences];
}

export function referencesOf(script: ParsedScript): Reference[] {
	return script.module.endsWith(".gd") ? extractGdscriptReferences(script) : [];
}
