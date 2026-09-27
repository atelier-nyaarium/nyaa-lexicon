// Declarations by recursive descent: includes, macros, functions, aggregates, enums and variables.

import { composeSymbolId, type Descriptor, defined, type Metrics } from "@nyaa-lexicon/protocol";
import { type TokenSpan, tokenHeader } from "./header.js";
import {
	type AggregateInfo,
	type Candidate,
	type CDeclaration,
	type CImportFact,
	type CTypeAnswer,
	type DeclaratorName,
	type DescriptorPath,
	type Directive,
	type FunctionCandidate,
	LANGUAGE,
	type QualifiedName,
	type ScopeContext,
	type Statement,
} from "./model.js";
import { CStructure } from "./structure.js";
import { type CToken, syntaxValue, tokenRange } from "./tokens.js";
import {
	declarationRangeStart,
	descriptorKey,
	hasTopLevelValue,
	lineCount,
	nextCode,
	previousCode,
	qualifiedNameForIdentifier,
	rangeForTokens,
	tokenValue,
} from "./tokenWalk.js";
import {
	ALIGNMENT_SPECIFIERS,
	ARGUMENT_SPECIFIERS,
	ASM_LABELS,
	ASSIGNMENT_OPERATORS,
	BUILTIN_TYPES,
	C_KEYWORDS,
	CALLING_CONVENTIONS,
	COMMA,
	isIdentifierToken,
	isSpecifierWord,
	isTypeToken,
	joinSpelling,
	TYPE_OPERATORS,
	TYPE_QUALIFIERS,
	typeWords,
	UNSPELLED_WORDS,
	wordLike,
} from "./words.js";

////////////////////////////////
//  Classes

export class CDeclarationParser extends CStructure {
	protected readonly declarationNameIndices = new Set<number>();

	protected readonly qualifiedNameIndices = new Set<number>();

	protected readonly typeUseIndices = new Set<number>();

	protected readonly declarations: CDeclaration[] = [];

	protected readonly imports: CImportFact[] = [];

	protected readonly typeAnswers = new Map<string, CTypeAnswer>();

	private readonly canonicalDeclarations = new Map<string, CDeclaration>();

	protected readonly typeNames = new Set<string>();

	private readonly descriptorCounts = new Map<string, number>();

	protected extractIncludesAndMacros(): void {
		for (const [index, directive] of this.directives) {
			if (directive.keyword === "include" || directive.keyword === "include_next")
				this.extractInclude(index, directive);
			if (directive.keyword === "define") this.extractMacro(index, directive);
		}
	}

	private extractInclude(index: number, directive: Directive): void {
		let cursor = nextCode(this.tokens, directive.keywordIndex + 1, directive.end);
		if (cursor >= directive.end) return;
		const first = this.tokens[cursor] as CToken;
		let specifier = "";
		let kind: "quoted" | "angle";
		let pathStart = cursor;
		let pathEnd = cursor;
		if (first.kind === "string") {
			specifier = first.value;
			kind = "quoted";
			this.includePathTokens.add(cursor);
			pathEnd = cursor;
		} else if (syntaxValue(first) === "<") {
			kind = "angle";
			cursor++;
			pathStart = cursor;
			const pieces: string[] = [];
			while (cursor < directive.end && tokenValue(this.tokens, cursor) !== ">") {
				const token = this.tokens[cursor] as CToken;
				if (token.kind !== "comment" && token.kind !== "newline") {
					pieces.push(token.raw);
					this.includePathTokens.add(cursor);
					pathEnd = cursor;
				}
				cursor++;
			}
			specifier = pieces.join("");
		} else {
			return;
		}
		if (specifier === "") return;
		const firstPath = this.tokens[pathStart];
		const lastPath = this.tokens[pathEnd];
		const pathRange =
			firstPath === undefined || lastPath === undefined
				? undefined
				: { start: firstPath.start, end: lastPath.end };
		this.imports.push({
			specifier,
			imported: [],
			reExport: false,
			kind,
			...defined({ range: pathRange }),
		});
	}

	private extractMacro(index: number, directive: Directive): void {
		const nameIndex = nextCode(this.tokens, directive.keywordIndex + 1, directive.end);
		const nameToken = this.tokens[nameIndex];
		if (!isIdentifierToken(nameToken)) return;
		const next = nextCode(this.tokens, nameIndex + 1, directive.end);
		const functionLike =
			tokenValue(this.tokens, next) === "(" && this.tokens[next]?.startOffset === nameToken.endOffset;
		const last = previousCode(this.tokens, directive.end);
		const rangeStartIndex = declarationRangeStart(this.tokens, index);
		const declaration = this.addCandidate({
			name: nameToken.value,
			declarationKind: functionLike ? "function" : "constant",
			descriptorKind: functionLike ? "method" : "term",
			languageKind: "macro",
			rangeStartIndex,
			rangeEndIndex: last < index ? index : last,
			selectionIndex: nameIndex,
			parentPath: [],
			visibility: "public",
			exported: true,
			signature: this.header(index, Math.max(index, last)),
			conditionalKey: this.conditionalByIndex.get(index) ?? "",
			conditionalGroup: this.conditionalGroupByIndex.get(index) ?? "",
		});
		if (declaration === undefined) return;
		this.declarationNameIndices.add(nameIndex);
		for (let member = index; member < directive.end; member++) this.directiveTokens.add(member);
	}

	private extractAggregateInfo(start: number, end: number): AggregateInfo | undefined {
		let keywordIndex = nextCode(this.tokens, start, end);
		if (tokenValue(this.tokens, keywordIndex) === "typedef")
			keywordIndex = nextCode(this.tokens, keywordIndex + 1, end);
		const keyword = tokenValue(this.tokens, keywordIndex);
		if (keyword !== "struct" && keyword !== "union" && keyword !== "enum") return undefined;
		const possibleTag = nextCode(this.tokens, keywordIndex + 1, end);
		const tagIndex =
			isIdentifierToken(this.tokens[possibleTag]) && tokenValue(this.tokens, possibleTag) !== "{"
				? possibleTag
				: -1;
		let bodyOpen =
			tagIndex < 0 ? nextCode(this.tokens, keywordIndex + 1, end) : nextCode(this.tokens, tagIndex + 1, end);
		if (tokenValue(this.tokens, bodyOpen) !== "{") bodyOpen = -1;
		const bodyClose = bodyOpen < 0 ? -1 : (this.pairs.get(bodyOpen) ?? -1);
		return { keyword, keywordIndex, tagIndex, bodyOpen, bodyClose };
	}

	protected parseScope(start: number, end: number, context: ScopeContext): void {
		let index = start;
		let guard = -1;
		while (index < end) {
			if (index <= guard) throw new Error("C parser failed to advance");
			guard = index;
			index = nextCode(this.tokens, index, end);
			if (index >= end) return;
			if (this.directiveTokens.has(index)) {
				index = this.directiveEndByToken.get(index) ?? index + 1;
				continue;
			}
			// Transparent in every scope, so the pairing pass and this one agree on what the brace is.
			const linkageOpen = this.linkageBlockOpen(index, end);
			if (linkageOpen >= 0) {
				const linkageClose = this.pairs.get(linkageOpen);
				if (linkageClose === undefined) {
					this.addDiagnostic("Linkage block is not closed.", linkageOpen);
					this.parseScope(linkageOpen + 1, end, context);
					return;
				}
				this.parseScope(linkageOpen + 1, linkageClose, context);
				index = linkageClose + 1;
				continue;
			}
			if (tokenValue(this.tokens, index) === "}") return;
			const statement = this.findStatement(index, end);
			if (statement === undefined || statement.next <= index) {
				index++;
				continue;
			}
			this.parseStatement(statement, context);
			index = statement.next;
		}
	}

	private linkageBlockOpen(start: number, end: number): number {
		if (tokenValue(this.tokens, start) !== "extern") return -1;
		const linkage = nextCode(this.tokens, start + 1, end);
		if (!this.isLinkageString(linkage)) return -1;
		const open = nextCode(this.tokens, linkage + 1, end);
		return tokenValue(this.tokens, open) === "{" ? open : -1;
	}

	private findStatement(start: number, end: number): Statement | undefined {
		let parentheses = 0;
		let brackets = 0;
		let braces = 0;
		const conditionals: Array<{ parentheses: number; brackets: number; braces: number }> = [];
		let index = start;
		while (index < end) {
			const directive = this.directives.get(index);
			if (directive !== undefined) {
				if (["if", "ifdef", "ifndef"].includes(directive.keyword)) {
					conditionals.push({ parentheses, brackets, braces });
				} else if (["elif", "else"].includes(directive.keyword)) {
					const frame = conditionals.at(-1);
					parentheses = frame?.parentheses ?? 0;
					brackets = frame?.brackets ?? 0;
					braces = frame?.braces ?? 0;
				} else if (directive.keyword === "endif") {
					conditionals.pop();
				}
				index = directive.end;
				continue;
			}
			if (this.directiveTokens.has(index)) {
				index = this.directiveEndByToken.get(index) ?? index + 1;
				continue;
			}
			const token = this.tokens[index] as CToken;
			if (token.kind === "comment" || token.kind === "newline") {
				index++;
				continue;
			}
			const value = syntaxValue(token);
			if (value === "(") parentheses++;
			else if (value === ")") parentheses = Math.max(0, parentheses - 1);
			else if (value === "[") brackets++;
			else if (value === "]") brackets = Math.max(0, brackets - 1);
			else if (value === "{") {
				if (parentheses === 0 && brackets === 0 && braces === 0) {
					const functionCandidate = this.findFunctionCandidate(start, index);
					if (functionCandidate !== undefined) {
						const close = this.pairs.get(index) ?? end - 1;
						return {
							start,
							last: close,
							next: Math.min(end, close + 1),
							terminator: "body",
							bodyOpen: index,
							bodyClose: close,
						};
					}
				}
				braces++;
			} else if (value === "}") {
				if (braces === 0 && parentheses === 0 && brackets === 0)
					return { start, last: index - 1, next: index, terminator: "eof" };
				braces--;
			} else if (value === ";" && parentheses === 0 && brackets === 0 && braces === 0) {
				return { start, last: index, next: index + 1, terminator: "semicolon" };
			}
			index++;
		}
		return start < end ? { start, last: Math.max(start, end - 1), next: end, terminator: "eof" } : undefined;
	}

	private findFunctionCandidate(start: number, beforeBody: number): FunctionCandidate | undefined {
		let parentheses = 0;
		let brackets = 0;
		for (let index = start; index < beforeBody; index++) {
			const token = this.tokens[index] as CToken;
			if (token.kind === "comment" || token.kind === "newline" || this.directiveTokens.has(index)) continue;
			const argumentsClose = this.argumentsClose(index, beforeBody);
			if (argumentsClose >= 0) {
				index = argumentsClose;
				continue;
			}
			const value = syntaxValue(token);
			if (value === "[") {
				brackets++;
				continue;
			}
			if (value === "]") {
				brackets = Math.max(0, brackets - 1);
				continue;
			}
			if (value === "(") {
				if (parentheses !== 0 || brackets !== 0) {
					parentheses++;
					continue;
				}
				const close = this.pairs.get(index);
				const previous = previousCode(this.tokens, index);
				const name = this.tokens[previous];
				const qualified =
					previous < 0 ? undefined : qualifiedNameForIdentifier(this.tokens, previous, beforeBody);
				if (
					close === undefined ||
					close >= beforeBody ||
					!isIdentifierToken(name) ||
					C_KEYWORDS.has(name.value) ||
					qualified === undefined
				)
					continue;
				if (hasTopLevelValue(this.tokens, start, index, "=")) continue;
				return {
					nameIndex: qualified.startIndex,
					nameEndIndex: qualified.endIndex,
					name: qualified.name,
					open: index,
					close,
				};
			}
			if (value === ")") parentheses = Math.max(0, parentheses - 1);
		}
		return undefined;
	}

	private parseStatement(statement: Statement, context: ScopeContext): void {
		const contentEnd = statement.terminator === "semicolon" ? statement.last : statement.last + 1;
		const first = this.skipLabels(nextCode(this.tokens, statement.start, contentEnd), contentEnd);
		if (first >= contentEnd || this.directiveTokens.has(first)) return;
		const aggregate = this.extractAggregateInfo(first, contentEnd);
		if (aggregate !== undefined) {
			this.parseAggregate(statement, aggregate, context);
			return;
		}
		const functionCandidate = this.findFunctionCandidate(first, contentEnd);
		if (
			functionCandidate !== undefined &&
			(context.kind === "file" || this.looksLikeDeclaration(first, contentEnd))
		) {
			this.parseFunction(statement, functionCandidate, context, first, contentEnd);
			return;
		}
		if (context.kind === "function" && !this.looksLikeDeclaration(first, contentEnd)) {
			this.parseControlHeaderDeclarations(context, first, contentEnd);
			return;
		}
		this.parseVariables(statement, context, first, contentEnd);
		if (statement.terminator === "eof" && context.kind === "file" && this.looksLikeDeclaration(first, contentEnd)) {
			this.addDiagnostic("Declaration has no terminating semicolon.", first);
		}
	}

	private skipLabels(start: number, end: number): number {
		let index = start;
		while (index < end && isIdentifierToken(this.tokens[index])) {
			const colon = nextCode(this.tokens, index + 1, end);
			if (tokenValue(this.tokens, colon) !== ":") return index;
			index = nextCode(this.tokens, colon + 1, end);
		}
		return index;
	}

	private parseControlHeaderDeclarations(context: ScopeContext, start: number, end: number): void {
		if (tokenValue(this.tokens, start) !== "for") return;
		const open = nextCode(this.tokens, start + 1, end);
		if (tokenValue(this.tokens, open) !== "(") return;
		const close = this.pairs.get(open);
		if (close === undefined || close <= open) return;
		const first = nextCode(this.tokens, open + 1, close);
		const separator = this.topLevelIndex(first, close, new Set([";"]));
		if (separator < 0 || !this.looksLikeDeclaration(first, separator)) return;
		this.parseVariables(
			{ start: first, last: separator, next: separator + 1, terminator: "semicolon" },
			context,
			first,
			separator,
		);
	}

	private looksLikeDeclaration(start: number, end: number): boolean {
		const token = this.tokens[start];
		if (token === undefined) return false;
		if (token.kind !== "identifier") return false;
		if (token.value === "struct" || token.value === "union" || token.value === "enum" || token.value === "typedef")
			return true;
		if (isSpecifierWord(token.value)) return true;
		if (C_KEYWORDS.has(token.value)) return false;
		const next = nextCode(this.tokens, start + 1, end);
		return isIdentifierToken(this.tokens[next]) || tokenValue(this.tokens, next) === "*";
	}

	private parseFunction(
		statement: Statement,
		candidate: FunctionCandidate,
		context: ScopeContext,
		first: number,
		contentEnd: number,
	): void {
		const rangeStartIndex = declarationRangeStart(this.tokens, statement.start);
		const endIndex = statement.terminator === "body" ? (statement.bodyClose ?? statement.last) : statement.last;
		const returnType = this.typeTextBefore(statement.start, candidate.nameIndex);
		const visibility =
			context.kind === "file"
				? hasTopLevelValue(this.tokens, statement.start, candidate.nameIndex, "static")
					? "fileLocal"
					: "public"
				: "local";
		const exported = context.kind === "file" ? visibility === "public" : false;
		const body = statement.terminator === "body" && statement.bodyOpen !== undefined;
		const laterDeclarator = body ? -1 : this.topLevelIndex(candidate.close + 1, contentEnd, COMMA);
		const headerEnd = body ? (statement.bodyOpen as number) : laterDeclarator < 0 ? contentEnd : laterDeclarator;
		const metrics = body
			? this.functionMetrics(
					statement.bodyOpen as number,
					statement.bodyClose ?? statement.last,
					candidate.open,
					candidate.close,
				)
			: {
					lines: lineCount(this.tokens[rangeStartIndex] as CToken, this.tokens[endIndex] as CToken),
					parameters: this.parameterCount(candidate.open, candidate.close),
				};
		const declaration = this.addCandidate({
			name: candidate.name,
			declarationKind: "function",
			descriptorKind: "method",
			...(body ? {} : { languageKind: "prototype" }),
			rangeStartIndex,
			rangeEndIndex: endIndex,
			selectionIndex: candidate.nameIndex,
			selectionEndIndex: candidate.nameEndIndex,
			parentPath: context.parentPath,
			visibility,
			exported,
			signature: this.header(first, previousCode(this.tokens, headerEnd)),
			metrics,
			typeText: returnType.text,
			typeStartIndex: returnType.start,
			typeEndIndex: returnType.end,
			...defined({ typeName: returnType.typeName }),
			conditionalKey: this.conditionalByIndex.get(statement.start) ?? "",
			conditionalGroup: this.conditionalGroupByIndex.get(statement.start) ?? "",
			isDefinition: body,
		});
		if (declaration === undefined) return;
		this.markQualifiedName(candidate.nameIndex, candidate.nameEndIndex);
		this.markTypeRange(returnType.start, returnType.end);
		this.parseParameters(candidate.open, candidate.close, declaration);
		if (body && statement.bodyOpen !== undefined && statement.bodyClose !== undefined) {
			this.parseScope(statement.bodyOpen + 1, statement.bodyClose, {
				kind: "function",
				parentPath: declaration.descriptorPath,
				containerId: declaration.symbolId,
			});
			this.parseNestedBlocks(statement.bodyOpen + 1, statement.bodyClose, declaration);
		}
	}

	private parseNestedBlocks(start: number, end: number, declaration: CDeclaration): void {
		let index = start;
		while (index < end) {
			if (syntaxValue(this.tokens[index]) !== "{") {
				index++;
				continue;
			}
			const close = this.pairs.get(index);
			if (close === undefined || close > end) {
				index++;
				continue;
			}
			if (!this.aggregateBrace(index, start)) {
				const control = this.controlHeaderBeforeBrace(index, start);
				if (control >= 0)
					this.parseControlHeaderDeclarations(
						{ kind: "function", parentPath: declaration.descriptorPath, containerId: declaration.symbolId },
						control,
						index,
					);
				this.parseScope(index + 1, close, {
					kind: "function",
					parentPath: declaration.descriptorPath,
					containerId: declaration.symbolId,
				});
				this.parseNestedBlocks(index + 1, close, declaration);
			}
			index = close + 1;
		}
	}

	private controlHeaderBeforeBrace(brace: number, scopeStart: number): number {
		let previous = previousCode(this.tokens, brace);
		let steps = 0;
		while (previous >= scopeStart && steps < 32) {
			if (tokenValue(this.tokens, previous) === "for") return previous;
			if (["{", "}"].includes(tokenValue(this.tokens, previous))) return -1;
			previous = previousCode(this.tokens, previous);
			steps++;
		}
		return -1;
	}

	private aggregateBrace(index: number, scopeStart: number): boolean {
		let previous = previousCode(this.tokens, index);
		let steps = 0;
		while (previous >= scopeStart && steps < 8) {
			const value = tokenValue(this.tokens, previous);
			if (value === "struct" || value === "union" || value === "enum") return true;
			if (value === ";" || value === "{" || value === "}") return false;
			previous = previousCode(this.tokens, previous);
			steps++;
		}
		return false;
	}

	private parseParameters(open: number, close: number, functionDeclaration: CDeclaration): void {
		for (const segment of this.splitSegments(open + 1, close)) {
			const first = nextCode(this.tokens, segment.start, segment.end);
			if (first >= segment.end || tokenValue(this.tokens, first) === "void") continue;
			const declarator = this.declaratorNames(segment.start, segment.end)[0];
			if (declarator === undefined) {
				this.markTypeRange(segment.start, segment.end);
				continue;
			}
			const nameIndex = declarator.nameIndex;
			const last = previousCode(this.tokens, segment.end);
			if (last < segment.start) continue;
			const rangeStart = nameIndex;
			const candidate = this.addCandidate({
				name: declarator.name,
				declarationKind: "variable",
				descriptorKind: "parameter",
				languageKind: "parameter",
				rangeStartIndex: rangeStart,
				rangeEndIndex: last,
				selectionIndex: nameIndex,
				selectionEndIndex: declarator.nameEndIndex,
				parentPath: functionDeclaration.descriptorPath,
				visibility: "local",
				exported: false,
				typeText: declarator.typeText,
				typeStartIndex: declarator.typeStart,
				typeEndIndex: declarator.typeEnd,
				...defined({ typeName: declarator.typeName }),
				conditionalKey: this.conditionalByIndex.get(nameIndex) ?? "",
				conditionalGroup: this.conditionalGroupByIndex.get(nameIndex) ?? "",
			});
			if (candidate !== undefined) this.markQualifiedName(nameIndex, declarator.nameEndIndex);
			this.markTypeRange(declarator.typeStart, declarator.typeEnd);
		}
	}

	private parameterCount(open: number, close: number): number {
		return this.splitSegments(open + 1, close).filter((segment) => {
			const first = nextCode(this.tokens, segment.start, segment.end);
			const afterFirst = nextCode(this.tokens, first + 1, segment.end);
			return first < segment.end && !(tokenValue(this.tokens, first) === "void" && afterFirst >= segment.end);
		}).length;
	}

	private functionMetrics(
		bodyOpen: number,
		bodyClose: number,
		parameterOpen: number,
		parameterClose: number,
	): Metrics {
		const first = this.tokens[bodyOpen];
		const last = this.tokens[bodyClose];
		if (first === undefined || last === undefined)
			return { parameters: this.parameterCount(parameterOpen, parameterClose) };
		const metrics: Metrics = {
			lines: lineCount(first, last),
			parameters: this.parameterCount(parameterOpen, parameterClose),
			branches: 1,
			nesting: 0,
		};
		let depth = 0;
		for (let index = bodyOpen + 1; index < bodyClose; index++) {
			const token = this.tokens[index] as CToken;
			const value = syntaxValue(token);
			if (value === "{") {
				depth++;
				metrics.nesting = Math.max(metrics.nesting ?? 0, depth);
			}
			if (value === "}") depth = Math.max(0, depth - 1);
			if (token.kind === "identifier" && ["if", "for", "while", "case", "default"].includes(value))
				metrics.branches = (metrics.branches ?? 0) + 1;
			if (value === "?") metrics.branches = (metrics.branches ?? 0) + 1;
		}
		return metrics;
	}

	private parseVariables(statement: Statement, context: ScopeContext, start: number, end: number): void {
		const names = this.declaratorNames(start, end);
		if (names.length === 0) {
			if (context.kind === "file" && this.looksLikeDeclaration(start, end))
				this.addDiagnostic("Declaration has no declarator name.", start);
			return;
		}
		const rangeStartIndex = declarationRangeStart(this.tokens, statement.start);
		const isTypedef = hasTopLevelValue(this.tokens, start, end, "typedef");
		const isConstant = hasTopLevelValue(this.tokens, start, end, "const");
		const isStatic = hasTopLevelValue(this.tokens, start, end, "static");
		for (const declarator of names) {
			const declaration = this.addCandidate({
				name: declarator.name,
				declarationKind: isTypedef
					? "class"
					: isConstant
						? "constant"
						: context.kind === "file"
							? "variable"
							: "variable",
				descriptorKind: isTypedef ? "type" : "term",
				...(isTypedef ? { languageKind: "typedef" } : {}),
				rangeStartIndex,
				rangeEndIndex: statement.last,
				selectionIndex: declarator.nameIndex,
				selectionEndIndex: declarator.nameEndIndex,
				parentPath: context.parentPath,
				visibility: context.kind === "file" ? (isStatic ? "fileLocal" : "public") : "local",
				exported: context.kind === "file" ? !isStatic : false,
				signature: this.declaratorHeader(start, declarator),
				typeText: declarator.typeText,
				typeStartIndex: declarator.typeStart,
				typeEndIndex: declarator.typeEnd,
				...defined({ typeName: declarator.typeName }),
				conditionalKey: this.conditionalByIndex.get(statement.start) ?? "",
				conditionalGroup: this.conditionalGroupByIndex.get(statement.start) ?? "",
			});
			if (declaration !== undefined) this.markQualifiedName(declarator.nameIndex, declarator.nameEndIndex);
			this.markTypeRange(declarator.typeStart, declarator.typeEnd);
			this.checkInitializer(declarator.nameIndex, end);
		}
	}

	private checkInitializer(nameIndex: number, end: number): void {
		let index = nextCode(this.tokens, nameIndex + 1, end);
		if (!ASSIGNMENT_OPERATORS.has(tokenValue(this.tokens, index))) return;
		index = nextCode(this.tokens, index + 1, end);
		if (index >= end || tokenValue(this.tokens, index) === "," || tokenValue(this.tokens, index) === ";")
			this.addDiagnostic("Initializer has no expression.", nameIndex);
	}

	private parseAggregate(statement: Statement, aggregate: AggregateInfo, context: ScopeContext): void {
		const isTypedef =
			tokenValue(this.tokens, nextCode(this.tokens, statement.start, statement.last + 1)) === "typedef";
		const contentEnd = statement.terminator === "semicolon" ? statement.last : statement.last + 1;
		const first = this.skipLabels(nextCode(this.tokens, statement.start, contentEnd), contentEnd);
		const tagName = aggregate.tagIndex < 0 ? undefined : tokenValue(this.tokens, aggregate.tagIndex);
		const rangeStartIndex = declarationRangeStart(this.tokens, statement.start);
		const names =
			aggregate.bodyClose >= 0
				? this.aggregateDeclaratorNames(aggregate, aggregate.bodyClose + 1, contentEnd, isTypedef)
				: this.declaratorNames(statement.start, contentEnd);
		let typeDeclaration: CDeclaration | undefined;
		if (tagName !== undefined && (aggregate.bodyOpen >= 0 || names.length === 0)) {
			typeDeclaration = this.addCandidate({
				name: tagName,
				declarationKind: aggregate.keyword === "enum" ? "enum" : "struct",
				descriptorKind: "type",
				...(aggregate.keyword === "union" ? { languageKind: "union" } : {}),
				rangeStartIndex,
				rangeEndIndex: statement.last,
				selectionIndex: aggregate.tagIndex,
				parentPath: context.parentPath,
				visibility: context.kind === "file" ? "public" : "local",
				exported: context.kind === "file",
				// Leading specifiers belong to declarators.
				signature: this.header(
					aggregate.keywordIndex,
					previousCode(this.tokens, this.aggregateHeaderEnd(aggregate, contentEnd)),
				),
				typeText: `${aggregate.keyword} ${tagName}`,
				typeStartIndex: aggregate.keywordIndex,
				typeEndIndex: aggregate.tagIndex,
				typeName: tagName,
				conditionalKey: this.conditionalByIndex.get(statement.start) ?? "",
				conditionalGroup: this.conditionalGroupByIndex.get(statement.start) ?? "",
				isDefinition: aggregate.bodyOpen >= 0,
			});
		}
		if (typeDeclaration !== undefined) {
			if (aggregate.bodyOpen >= 0 || names.length === 0) this.declarationNameIndices.add(aggregate.tagIndex);
			else this.typeUseIndices.add(aggregate.tagIndex);
		} else if (aggregate.tagIndex >= 0) {
			this.typeUseIndices.add(aggregate.tagIndex);
		}
		if (isTypedef) {
			for (const declarator of names) {
				const alias = this.addCandidate({
					name: declarator.name,
					declarationKind: "class",
					descriptorKind: "type",
					languageKind: "typedef",
					rangeStartIndex,
					rangeEndIndex: statement.last,
					selectionIndex: declarator.nameIndex,
					selectionEndIndex: declarator.nameEndIndex,
					parentPath: context.parentPath,
					visibility: context.kind === "file" ? "public" : "local",
					exported: context.kind === "file",
					signature: this.declaratorHeader(first, declarator),
					typeText:
						declarator.typeText ||
						(tagName === undefined ? aggregate.keyword : `${aggregate.keyword} ${tagName}`),
					typeStartIndex: declarator.typeStart,
					typeEndIndex: declarator.typeEnd,
					...defined({ typeName: tagName }),
					conditionalKey: this.conditionalByIndex.get(statement.start) ?? "",
					conditionalGroup: this.conditionalGroupByIndex.get(statement.start) ?? "",
				});
				if (alias !== undefined) this.markQualifiedName(declarator.nameIndex, declarator.nameEndIndex);
				this.markTypeRange(declarator.typeStart, declarator.typeEnd);
			}
		} else {
			for (const declarator of this.declaratorNames(statement.start, contentEnd)) {
				if (aggregate.tagIndex >= 0 && declarator.nameIndex === aggregate.tagIndex) continue;
				const variable = this.addCandidate({
					name: declarator.name,
					declarationKind: "variable",
					descriptorKind: "term",
					rangeStartIndex,
					rangeEndIndex: statement.last,
					selectionIndex: declarator.nameIndex,
					selectionEndIndex: declarator.nameEndIndex,
					parentPath: context.parentPath,
					visibility: context.kind === "file" ? "public" : "local",
					exported: context.kind === "file",
					signature: this.declaratorHeader(first, declarator),
					typeText: declarator.typeText,
					typeStartIndex: declarator.typeStart,
					typeEndIndex: declarator.typeEnd,
					...defined({ typeName: declarator.typeName }),
					conditionalKey: this.conditionalByIndex.get(statement.start) ?? "",
					conditionalGroup: this.conditionalGroupByIndex.get(statement.start) ?? "",
				});
				if (variable !== undefined) this.markQualifiedName(declarator.nameIndex, declarator.nameEndIndex);
				this.markTypeRange(declarator.typeStart, declarator.typeEnd);
			}
		}
		if (typeDeclaration === undefined && isTypedef && names.length > 0) typeDeclaration = this.declarations.at(-1);
		if (aggregate.bodyOpen >= 0 && aggregate.bodyClose > aggregate.bodyOpen && typeDeclaration !== undefined) {
			const closer = this.tokens[aggregate.bodyClose] as CToken;
			if (closer.lineStart) typeDeclaration.memberInsertLine = closer.start.line;
			if (aggregate.keyword === "enum")
				this.parseEnumMembers(aggregate.bodyOpen + 1, aggregate.bodyClose, typeDeclaration);
			else this.parseStructMembers(aggregate.bodyOpen + 1, aggregate.bodyClose, typeDeclaration);
		}
		if (statement.terminator === "eof" && aggregate.bodyClose >= 0)
			this.addDiagnostic("Aggregate declaration has no terminating semicolon.", aggregate.bodyClose);
	}

	private parseStructMembers(start: number, end: number, container: CDeclaration): void {
		let memberStart = start;
		let parentheses = 0;
		let brackets = 0;
		let braces = 0;
		for (let index = start; index <= end; index++) {
			const value = tokenValue(this.tokens, index);
			if (value === "(") parentheses++;
			else if (value === ")") parentheses = Math.max(0, parentheses - 1);
			else if (value === "[") brackets++;
			else if (value === "]") brackets = Math.max(0, brackets - 1);
			else if (value === "{") braces++;
			else if (value === "}") braces = Math.max(0, braces - 1);
			if ((value === ";" && parentheses === 0 && brackets === 0 && braces === 0) || index === end) {
				const memberEnd = value === ";" ? index : index - 1;
				this.parseMemberStatement(memberStart, memberEnd, container);
				memberStart = index + 1;
			}
		}
	}

	private parseMemberStatement(start: number, end: number, container: CDeclaration): void {
		const first = nextCode(this.tokens, start, end);
		if (first >= end) return;
		const aggregate = this.extractAggregateInfo(first, end);
		if (aggregate !== undefined) {
			const statement: Statement = { start: first, last: end, next: end + 1, terminator: "semicolon" };
			this.parseAggregate(statement, aggregate, {
				kind: "function",
				parentPath: container.descriptorPath,
				containerId: container.symbolId,
			});
			if (aggregate.bodyOpen >= 0 && aggregate.bodyClose > aggregate.bodyOpen && aggregate.tagIndex < 0) {
				if (aggregate.keyword === "enum")
					this.parseEnumMembers(aggregate.bodyOpen + 1, aggregate.bodyClose, container);
				else this.parseStructMembers(aggregate.bodyOpen + 1, aggregate.bodyClose, container);
			}
			return;
		}
		for (const declarator of this.declaratorNames(first, end)) {
			const rangeStartIndex = declarationRangeStart(this.tokens, first);
			const field = this.addCandidate({
				name: declarator.name,
				declarationKind: "field",
				descriptorKind: "term",
				rangeStartIndex,
				rangeEndIndex: end,
				selectionIndex: declarator.nameIndex,
				selectionEndIndex: declarator.nameEndIndex,
				parentPath: container.descriptorPath,
				visibility: "public",
				signature: this.declaratorHeader(this.headerStart(first, end), declarator),
				typeText: declarator.typeText,
				typeStartIndex: declarator.typeStart,
				typeEndIndex: declarator.typeEnd,
				...defined({ typeName: declarator.typeName }),
				conditionalKey: this.conditionalByIndex.get(first) ?? "",
				conditionalGroup: this.conditionalGroupByIndex.get(first) ?? "",
			});
			if (field !== undefined) this.markQualifiedName(declarator.nameIndex, declarator.nameEndIndex);
			this.markTypeRange(declarator.typeStart, declarator.typeEnd);
		}
	}

	private parseEnumMembers(start: number, end: number, container: CDeclaration): void {
		for (const segment of this.splitSegments(start, end)) {
			const nameIndex = this.findDeclaratorName(segment.start, segment.end);
			if (nameIndex < 0) continue;
			const token = this.tokens[nameIndex] as CToken;
			const last = previousCode(this.tokens, segment.end);
			if (last < nameIndex) continue;
			const member = this.addCandidate({
				name: token.value,
				declarationKind: "constant",
				descriptorKind: "term",
				rangeStartIndex: declarationRangeStart(this.tokens, segment.start),
				rangeEndIndex: last,
				selectionIndex: nameIndex,
				parentPath: container.descriptorPath,
				visibility: "public",
				signature: this.header(this.headerStart(segment.start, segment.end), last),
				typeText: container.name,
				conditionalKey: this.conditionalByIndex.get(nameIndex) ?? "",
				conditionalGroup: this.conditionalGroupByIndex.get(nameIndex) ?? "",
			});
			if (member !== undefined) this.declarationNameIndices.add(nameIndex);
		}
	}

	private splitSegments(start: number, end: number): Array<{ start: number; end: number }> {
		const segments: Array<{ start: number; end: number }> = [];
		let segmentStart = start;
		let parentheses = 0;
		let brackets = 0;
		let braces = 0;
		for (let index = start; index < end; index++) {
			const value = tokenValue(this.tokens, index);
			if (value === "(") parentheses++;
			else if (value === ")") parentheses = Math.max(0, parentheses - 1);
			else if (value === "[") brackets++;
			else if (value === "]") brackets = Math.max(0, brackets - 1);
			else if (value === "{") braces++;
			else if (value === "}") braces = Math.max(0, braces - 1);
			else if (value === "," && parentheses === 0 && brackets === 0 && braces === 0) {
				segments.push({ start: segmentStart, end: index });
				segmentStart = index + 1;
			}
		}
		segments.push({ start: segmentStart, end });
		return segments;
	}

	private findDeclaratorName(start: number, end: number, allowKeywordName = false): number {
		const equals = this.topLevelIndex(start, end, ASSIGNMENT_OPERATORS);
		const limit = equals < 0 ? end : equals;
		for (let index = start; index < limit; index++) {
			const argumentsClose = this.argumentsClose(index, limit);
			if (argumentsClose >= 0) {
				index = argumentsClose;
				continue;
			}
			const token = this.tokens[index] as CToken;
			if (
				!isIdentifierToken(token) ||
				(C_KEYWORDS.has(token.value) && !(allowKeywordName && ["bool", "_Bool"].includes(token.value))) ||
				CALLING_CONVENTIONS.has(token.value) ||
				TYPE_QUALIFIERS.has(token.value)
			)
				continue;
			const previous = previousCode(this.tokens, index);
			if (previous >= start && [".", "->", "#"].includes(tokenValue(this.tokens, previous))) continue;
			return index;
		}
		return -1;
	}

	/** Close of the `(...)` an argument-taking word opens, or -1. */
	private argumentsClose(index: number, end: number): number {
		const token = this.tokens[index];
		if (
			!isIdentifierToken(token) ||
			!(ARGUMENT_SPECIFIERS.has(token.value) || TYPE_OPERATORS.has(token.value) || ASM_LABELS.has(token.value))
		)
			return -1;
		const open = nextCode(this.tokens, index + 1, end);
		if (tokenValue(this.tokens, open) !== "(") return -1;
		return this.pairs.get(open) ?? -1;
	}

	/** The first code token from `start`, past directives when code follows them. */
	private headerStart(start: number, end: number): number {
		const first = nextCode(this.tokens, start, end);
		let index = first;
		while (index < end && this.directiveTokens.has(index)) index = nextCode(this.tokens, index + 1, end);
		return index < end ? index : first;
	}

	private header(first: number, last: number, lead?: TokenSpan): string | undefined {
		if (first < 0 || last < first) return undefined;
		return tokenHeader(this.text, this.tokens, this.pairs, { first, last, ...defined({ lead }) });
	}

	/** Its `{`, even past a tag the parser could not read. */
	private aggregateHeaderEnd(aggregate: AggregateInfo, end: number): number {
		if (aggregate.bodyOpen >= 0) return aggregate.bodyOpen;
		for (let index = aggregate.keywordIndex; index < end; index++) {
			if (!this.directiveTokens.has(index) && tokenValue(this.tokens, index) === "{") return index;
		}
		return end;
	}

	/** Specifiers from `first`, then this declarator alone. */
	private declaratorHeader(first: number, declarator: DeclaratorName): string | undefined {
		const listFirst = this.headerStart(declarator.listStart, declarator.segmentEnd);
		const own = this.headerStart(declarator.segmentStart, declarator.segmentEnd);
		const last = previousCode(this.tokens, declarator.segmentEnd);
		if (own <= listFirst) return this.header(first, last);
		const specifiers = previousCode(this.tokens, listFirst);
		return this.header(own, last, specifiers < first ? undefined : { first, last: specifiers });
	}

	private topLevelIndex(start: number, end: number, wanted: ReadonlySet<string>): number {
		let parentheses = 0;
		let brackets = 0;
		let braces = 0;
		for (let index = start; index < end; index++) {
			const value = tokenValue(this.tokens, index);
			if (value === "(") parentheses++;
			else if (value === ")") parentheses = Math.max(0, parentheses - 1);
			else if (value === "[") brackets++;
			else if (value === "]") brackets = Math.max(0, brackets - 1);
			else if (value === "{") braces++;
			else if (value === "}") braces = Math.max(0, braces - 1);
			else if (parentheses === 0 && brackets === 0 && braces === 0 && wanted.has(value)) return index;
		}
		return -1;
	}

	private declaratorNames(start: number, end: number): DeclaratorName[] {
		let cursor = nextCode(this.tokens, start, end);
		if (tokenValue(this.tokens, cursor) === "extern") {
			const linkage = nextCode(this.tokens, cursor + 1, end);
			if (this.tokens[linkage]?.kind === "string") cursor = nextCode(this.tokens, linkage + 1, end);
		}
		let sawType = false;
		while (cursor < end) {
			const token = this.tokens[cursor] as CToken;
			if (token.kind !== "identifier") break;
			if (token.value === "struct" || token.value === "union" || token.value === "enum") {
				sawType = true;
				cursor = nextCode(this.tokens, cursor + 1, end);
				if (isIdentifierToken(this.tokens[cursor])) cursor = nextCode(this.tokens, cursor + 1, end);
				if (tokenValue(this.tokens, cursor) === "{") {
					const close = this.pairs.get(cursor);
					cursor = close === undefined ? end : nextCode(this.tokens, close + 1, end);
				}
				continue;
			}
			const argumentsClose = this.argumentsClose(cursor, end);
			if (argumentsClose >= 0) {
				sawType = sawType || TYPE_OPERATORS.has(token.value);
				cursor = nextCode(this.tokens, argumentsClose + 1, end);
				continue;
			}
			if (isSpecifierWord(token.value)) {
				const next = nextCode(this.tokens, cursor + 1, end);
				if (sawType && (next >= end || [",", ";", "="].includes(tokenValue(this.tokens, next)))) break;
				sawType =
					sawType ||
					BUILTIN_TYPES.has(token.value) ||
					token.value === "const" ||
					token.value === "signed" ||
					token.value === "unsigned";
				cursor = nextCode(this.tokens, cursor + 1, end);
				continue;
			}
			if (!sawType) {
				sawType = true;
				cursor = nextCode(this.tokens, cursor + 1, end);
				continue;
			}
			break;
		}
		if (cursor >= end) return [];
		const names: DeclaratorName[] = [];
		const allowKeywordName = hasTopLevelValue(this.tokens, start, end, "typedef");
		for (const segment of this.splitSegments(cursor, end)) {
			const nameIndex = this.findDeclaratorName(segment.start, segment.end, allowKeywordName);
			if (nameIndex < 0) continue;
			const qualified = qualifiedNameForIdentifier(this.tokens, nameIndex, segment.end);
			if (qualified === undefined) continue;
			const typeText = this.typeTextForDeclarator(start, cursor, segment.start, nameIndex);
			const typeName = this.typeNameForRange(start, cursor);
			names.push({
				nameIndex,
				nameEndIndex: qualified.endIndex,
				name: qualified.name,
				typeStart: start,
				typeEnd: cursor,
				typeText,
				...defined({ typeName }),
				listStart: cursor,
				segmentStart: segment.start,
				segmentEnd: segment.end,
			});
		}
		return names;
	}

	private aggregateDeclaratorNames(
		aggregate: AggregateInfo,
		start: number,
		end: number,
		allowKeywordName = false,
	): DeclaratorName[] {
		const tag = aggregate.tagIndex < 0 ? "" : ` ${tokenValue(this.tokens, aggregate.tagIndex)}`;
		const typeStart = aggregate.keywordIndex;
		const typeEnd = aggregate.bodyClose;
		const names: DeclaratorName[] = [];
		for (const segment of this.splitSegments(start, end)) {
			const nameIndex = this.findDeclaratorName(segment.start, segment.end, allowKeywordName);
			if (nameIndex < 0) continue;
			const qualified = qualifiedNameForIdentifier(this.tokens, nameIndex, segment.end);
			if (qualified === undefined) continue;
			const typeText = joinSpelling(
				`${aggregate.keyword}${tag}`,
				this.typeSpelling(segment.start, nameIndex, nameIndex),
			);
			names.push({
				nameIndex,
				nameEndIndex: qualified.endIndex,
				name: qualified.name,
				typeStart,
				typeEnd,
				typeText,
				...(aggregate.tagIndex < 0 ? {} : { typeName: tokenValue(this.tokens, aggregate.tagIndex) }),
				listStart: start,
				segmentStart: segment.start,
				segmentEnd: segment.end,
			});
		}
		return names;
	}

	private typeTextForDeclarator(start: number, specEnd: number, segmentStart: number, nameIndex: number): string {
		return joinSpelling(
			this.typeSpelling(start, specEnd, nameIndex),
			this.typeSpelling(segmentStart, nameIndex, nameIndex),
		);
	}

	private typeTextBefore(
		start: number,
		nameIndex: number,
	): { text: string; start: number; end: number; typeName?: string } {
		const end = nameIndex;
		const text = this.typeSpelling(start, end, nameIndex);
		const typeName = this.typeNameForRange(start, end);
		return { text, start, end: Math.max(start, end - 1), ...defined({ typeName }) };
	}

	/** Type spelling of `[start, end)`. */
	private typeSpelling(start: number, end: number, name: number): string {
		const parts: string[] = [];
		let spaced = false;
		let previous: CToken | undefined;
		let kept: CToken | undefined;
		for (let index = start; index < end; index++) {
			const token = this.tokens[index] as CToken;
			if (token.kind === "comment" || token.kind === "newline") continue;
			// Omitted words still separate.
			if (previous !== undefined && wordLike(previous) && wordLike(token)) spaced = true;
			const omitted = this.omittedThrough(index, end, name);
			if (omitted >= 0) {
				previous = this.tokens[omitted];
				index = omitted;
				continue;
			}
			if (kept !== undefined && (spaced || (wordLike(kept) && wordLike(token)))) parts.push(" ");
			parts.push(token.raw);
			spaced = false;
			previous = token;
			kept = token;
		}
		return parts.join("");
	}

	/** Last token of an unspelled run at `index`, or -1. */
	private omittedThrough(index: number, end: number, name: number): number {
		const token = this.tokens[index] as CToken;
		if (token.kind === "symbol") {
			// Declarator grouping.
			const close = token.value === "(" ? this.pairs.get(index) : undefined;
			return close !== undefined && close > name ? index : -1;
		}
		if (token.kind !== "identifier") return -1;
		if (ALIGNMENT_SPECIFIERS.has(token.value)) return this.argumentsClose(index, end);
		if (!UNSPELLED_WORDS.has(token.value)) return -1;
		if (token.value !== "extern") return index;
		const linkage = nextCode(this.tokens, index + 1, end);
		return this.tokens[linkage]?.kind === "string" ? linkage : index;
	}

	private typeNameForRange(start: number, end: number): string | undefined {
		let previous = "";
		for (let index = start; index < end; index++) {
			const token = this.tokens[index] as CToken;
			if (!isIdentifierToken(token) || TYPE_OPERATORS.has(token.value)) continue;
			// Attribute arguments name no type.
			const argumentsClose = this.argumentsClose(index, end);
			if (argumentsClose >= 0) {
				index = argumentsClose;
				continue;
			}
			if (token.value === "struct" || token.value === "union" || token.value === "enum") {
				previous = token.value;
				continue;
			}
			if (previous === "struct" || previous === "union" || previous === "enum") return token.value;
			if (!typeWords(token.value)) return token.value;
		}
		return undefined;
	}

	private markTypeRange(start: number, end: number): void {
		if (end < start) return;
		for (let index = start; index <= end; index++) {
			const token = this.tokens[index];
			if (isTypeToken(token)) this.typeUseIndices.add(index);
		}
	}

	private addCandidate(candidate: Candidate): CDeclaration | undefined {
		const canonicalKey = `${candidate.declarationKind}|${descriptorKey(candidate.parentPath)}|${candidate.name}`;
		const existing = candidate.conditionalKey === "" ? this.canonicalDeclarations.get(canonicalKey) : undefined;
		if (
			existing !== undefined &&
			(candidate.declarationKind === "function" ||
				candidate.declarationKind === "struct" ||
				candidate.declarationKind === "enum")
		) {
			if (candidate.isDefinition === true && existing.isDefinition !== true) {
				const position = this.declarations.indexOf(existing);
				for (let index = this.declarations.length - 1; index >= 0; index--) {
					const child = this.declarations[index];
					if (child?.containerId !== existing.symbolId) continue;
					const descriptor = child.descriptorPath.at(-1);
					if (descriptor !== undefined)
						this.descriptorCounts.set(
							`${descriptorKey(existing.descriptorPath)}|${descriptor.kind}|${child.name}`,
							0,
						);
					this.declarations.splice(index, 1);
				}
				const replacement = this.makeDeclaration(candidate, existing.descriptorPath, false);
				if (position >= 0) this.declarations[position] = replacement;
				this.canonicalDeclarations.set(canonicalKey, replacement);
				this.typeAnswers.delete(existing.symbolId);
				this.addTypeAnswer(replacement);
				return replacement;
			}
			if (candidate.isDefinition !== true && existing.isDefinition !== true) return existing;
			if (candidate.isDefinition !== true && existing.isDefinition === true) return existing;
		}
		const countKey = `${descriptorKey(candidate.parentPath)}|${candidate.descriptorKind}|${candidate.name}`;
		const ordinal = this.descriptorCounts.get(countKey) ?? 0;
		this.descriptorCounts.set(countKey, ordinal + 1);
		const descriptorName =
			ordinal === 0 || candidate.descriptorKind === "method" ? candidate.name : `${candidate.name}#${ordinal}`;
		const descriptor: Descriptor =
			candidate.descriptorKind === "method" && ordinal > 0
				? { kind: "method", name: candidate.name, disambiguator: String(ordinal) }
				: { kind: candidate.descriptorKind, name: descriptorName };
		const declaration = this.makeDeclaration(candidate, [...candidate.parentPath, descriptor]);
		if (candidate.conditionalKey === "") this.canonicalDeclarations.set(canonicalKey, declaration);
		return declaration;
	}

	private markQualifiedName(start: number, end: number): void {
		for (let index = start; index <= end; index++) {
			if (isIdentifierToken(this.tokens[index])) this.declarationNameIndices.add(index);
		}
	}

	protected markQualifiedReference(name: QualifiedName): void {
		for (const index of name.identifierIndices) this.qualifiedNameIndices.add(index);
	}

	private makeDeclaration(candidate: Candidate, descriptorPath: DescriptorPath, append = true): CDeclaration {
		const first = this.tokens[candidate.rangeStartIndex] as CToken;
		const last = this.tokens[candidate.rangeEndIndex] as CToken;
		const selectionRange =
			rangeForTokens(
				this.tokens,
				candidate.selectionIndex,
				candidate.selectionEndIndex ?? candidate.selectionIndex,
			) ?? tokenRange(this.tokens[candidate.selectionIndex] as CToken);
		const symbolId = composeSymbolId({ language: LANGUAGE, module: this.module, descriptors: descriptorPath });
		const containerId =
			descriptorPath.length <= 1
				? undefined
				: composeSymbolId({
						language: LANGUAGE,
						module: this.module,
						descriptors: descriptorPath.slice(0, -1),
					});
		const typeRange =
			candidate.typeStartIndex === undefined || candidate.typeEndIndex === undefined
				? undefined
				: rangeForTokens(this.tokens, candidate.typeStartIndex, candidate.typeEndIndex);
		const declaration: CDeclaration = {
			symbolId,
			kind: candidate.declarationKind,
			name: candidate.name,
			range: { start: first.start, end: last.end },
			selectionRange,
			visibility: candidate.visibility,
			...defined({
				languageKind: candidate.languageKind,
				exported: candidate.exported,
				signature: candidate.signature,
				containerId,
				metrics: candidate.metrics,
			}),
			descriptorPath,
			startOffset: first.startOffset,
			endOffset: last.endOffset,
			selectionIndex: candidate.selectionIndex,
			conditionalKey: candidate.conditionalKey,
			conditionalGroup: candidate.conditionalGroup,
			...defined({ isDefinition: candidate.isDefinition }),
			...(candidate.typeText === undefined || candidate.typeText === "" ? {} : { typeText: candidate.typeText }),
			...defined({ typeRange }),
		};
		if (append) this.declarations.push(declaration);
		this.addTypeAnswer(declaration, candidate.typeName);
		return declaration;
	}

	private addTypeAnswer(declaration: CDeclaration, typeName?: string): void {
		if (declaration.typeText === undefined || declaration.typeText === "") return;
		this.typeAnswers.set(declaration.symbolId, {
			display: declaration.typeText,
			...defined({ typeName }),
		});
	}
}
