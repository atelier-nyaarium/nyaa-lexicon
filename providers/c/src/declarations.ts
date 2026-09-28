// Declarations by recursive descent: includes, macros, functions, aggregates, enums and variables.

import { defined, type Metrics } from "@nyaa-lexicon/protocol";
import { tokenHeader } from "./header.js";
import type {
	AggregateInfo,
	BlockScope,
	CDeclaration,
	CImportFact,
	DeclarationHead,
	DeclaratorName,
	Directive,
	FunctionCandidate,
	ScopeContext,
	Statement,
} from "./model.js";
import { scopeKey, visibleAt } from "./scopes.js";
import { CStatementParser, SEMICOLON } from "./statements.js";
import type { CToken } from "./tokens.js";
import {
	declarationRangeStart,
	lineCount,
	nextCode,
	previousCode,
	spelledName,
	syntaxValue,
	tokenValue,
} from "./tokenWalk.js";
import { ASSIGNMENT_OPERATORS, isIdentifierToken } from "./words.js";

////////////////////////////////
//  Constants

const STATIC_WORDS: ReadonlySet<string> = new Set(["static"]);

/** What ends a declarator's suffixes: its initializer or its bit-field width. */
const SUFFIX_ENDS: ReadonlySet<string> = new Set([...ASSIGNMENT_OPERATORS, ":"]);

const CONST_WORDS: ReadonlySet<string> = new Set(["const", "__const", "__const__"]);

////////////////////////////////
//  Classes

export class CDeclarationParser extends CStatementParser {
	protected readonly imports: CImportFact[] = [];

	/** A block's first use of a tag nothing in scope declared, by block and name: where its definition's scope starts. */
	private readonly incompleteTags = new Map<string, number>();

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
					pieces.push(token.value);
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
		// Only a `(` touching the name opens a parameter list; a comment or a space between does not.
		const next = nextCode(this.tokens, nameIndex + 1, directive.end);
		const functionLike =
			next === nameIndex + 1 && tokenValue(this.tokens, next) === "(" && this.tokens[next]?.touching === true;
		const last = Math.max(index, previousCode(this.tokens, directive.end));
		const declaration = this.addCandidate({
			name: nameToken.value,
			declarationKind: functionLike ? "function" : "constant",
			descriptorKind: functionLike ? "method" : "term",
			languageKind: "macro",
			rangeStartIndex: declarationRangeStart(this.tokens, index),
			rangeEndIndex: last,
			selectionIndex: nameIndex,
			parentPath: [],
			visibility: "public",
			exported: true,
			// Its own directive, so no directive is left out.
			signature: tokenHeader(this.text, this.tokens, this.pairs, { first: index, last }),
			conditionalKey: this.conditionalByIndex.get(index) ?? "",
			conditionalGroup: this.conditionalGroupByIndex.get(index) ?? "",
		});
		if (declaration === undefined) return;
		this.declarationNameIndices.add(nameIndex);
		for (let member = index; member < directive.end; member++) this.directiveTokens.add(member);
	}

	/** Every declaration in the file. */
	protected parseFile(): void {
		this.parseScope(0, this.tokens.length, { kind: "file", parentPath: [] });
		if (this.replaced.size === 0) return;
		const kept = this.declarations.filter((declaration) => !this.replaced.has(declaration));
		this.declarations.length = 0;
		for (const declaration of kept) this.declarations.push(declaration);
	}

	////////////////////////////////
	//  Declarations

	/** One declaration: its aggregate, then each declarator, then the aggregate's members. */
	protected parseDeclaration(statement: Statement, context: ScopeContext, first: number, listEnd: number): void {
		const head = this.readHead(first, listEnd, context.kind !== "function");
		const declarators = this.declarators(head, listEnd);
		const aggregate = head.aggregate;
		const body = statement.terminator === "body" ? statement : undefined;
		const typeDeclaration =
			aggregate === undefined
				? undefined
				: this.declareAggregate(statement, context, aggregate, declarators.length);
		const unspecified = body === undefined && head.listStart === head.first;
		const objects: CDeclaration[] = [];
		let bodied = false;
		declarators.forEach((declarator, position) => {
			const candidate = declarator.function;
			// A call with no specifiers is a macro's use: in a body always, at file scope unless it declares parameters.
			if (candidate !== undefined && unspecified && !head.typedef) {
				if (context.kind === "member") return;
				if (context.kind === "file" && !this.declaresParameters(candidate)) return;
			}
			if (candidate === undefined || head.typedef || context.kind === "member") {
				const object = this.declareObject(statement, context, head, declarator);
				if (object !== undefined) objects.push(object);
				return;
			}
			const owns = body !== undefined && position === declarators.length - 1;
			bodied ||= owns;
			this.declareFunction(statement, context, head, declarator, candidate, owns);
		});
		if (body !== undefined && !bodied) {
			const candidate = this.findFunctionCandidate(first, listEnd);
			if (candidate !== undefined)
				this.declareFunction(
					statement,
					context,
					head,
					this.candidateDeclarator(head, candidate),
					candidate,
					true,
				);
		}
		if (aggregate !== undefined && aggregate.bodyOpen >= 0 && aggregate.bodyClose > aggregate.bodyOpen)
			this.parseAggregateBody(
				aggregate,
				context,
				head.typedef ? (typeDeclaration ?? objects[0]) : typeDeclaration,
				objects,
			);
		if (context.kind !== "file") return;
		if (aggregate !== undefined) {
			if (statement.terminator === "eof" && aggregate.bodyClose >= 0)
				this.addDiagnostic("Aggregate declaration has no terminating semicolon.", aggregate.bodyClose);
			return;
		}
		if (body !== undefined || declarators.some((declarator) => declarator.function !== undefined)) return;
		if (!this.looksLikeDeclaration(head.first, listEnd)) return;
		if (declarators.length === 0) this.addDiagnostic("Declaration has no declarator name.", head.first);
		if (statement.terminator === "eof") this.addDiagnostic("Declaration has no terminating semicolon.", head.first);
	}

	/** Whether each argument declares a parameter, or there are none. */
	private declaresParameters(candidate: FunctionCandidate): boolean {
		return this.splitSegments(candidate.open + 1, candidate.close).every((segment) => {
			const first = this.code(segment.start, segment.end);
			return (
				first >= segment.end ||
				["void", "..."].includes(tokenValue(this.tokens, first)) ||
				this.looksLikeDeclaration(first, segment.end)
			);
		});
	}

	private declareAggregate(
		statement: Statement,
		context: ScopeContext,
		aggregate: AggregateInfo,
		declaratorCount: number,
	): CDeclaration | undefined {
		if (aggregate.tagIndex < 0) return undefined;
		const tagName = spelledName(this.tokens, aggregate.tagIndex, aggregate.tagEndIndex);
		const incomplete = `${context.block?.open ?? ""}|${scopeKey(context.containerId, tagName)}`;
		if (aggregate.bodyOpen < 0 && declaratorCount > 0) {
			this.typeUseIndices.add(aggregate.tagIndex);
			// `struct T *p;` with no T in scope declares T in this block; a later definition here completes it.
			if (
				context.block !== undefined &&
				!this.incompleteTags.has(incomplete) &&
				!this.tagInScope(tagName, context.containerId, aggregate.tagIndex)
			)
				this.incompleteTags.set(incomplete, aggregate.tagIndex);
			return undefined;
		}
		const declaration = this.addCandidate({
			name: tagName,
			declarationKind: aggregate.keyword === "enum" ? "enum" : "struct",
			descriptorKind: "type",
			...(aggregate.keyword === "union" ? { languageKind: "union" } : {}),
			rangeStartIndex: declarationRangeStart(this.tokens, statement.start),
			rangeEndIndex: statement.last,
			selectionIndex: aggregate.tagIndex,
			selectionEndIndex: aggregate.tagEndIndex,
			parentPath: context.parentPath,
			// A tag in an aggregate's body belongs to the scope around the aggregate.
			visibility: context.local === true ? "local" : "public",
			exported: context.local !== true,
			// Leading specifiers belong to declarators.
			signature: this.header(
				aggregate.keywordIndex,
				this.codeBefore(this.aggregateHeaderEnd(aggregate, statement)),
			),
			typeText: `${aggregate.keyword} ${tagName}`,
			typeStartIndex: aggregate.keywordIndex,
			typeEndIndex: aggregate.tagEndIndex,
			typeName: { name: tagName, tag: true },
			conditionalKey: this.conditionalByIndex.get(statement.start) ?? "",
			conditionalGroup: this.conditionalGroupByIndex.get(statement.start) ?? "",
			isDefinition: aggregate.bodyOpen >= 0,
			...this.blockScope(
				context,
				Math.min(aggregate.tagEndIndex + 1, this.incompleteTags.get(incomplete) ?? Infinity),
			),
		});
		this.markQualifiedName(aggregate.tagIndex, aggregate.tagEndIndex);
		const open = this.tokens[aggregate.bodyOpen];
		const close = this.tokens[aggregate.bodyClose];
		if (
			declaration !== undefined &&
			open !== undefined &&
			close !== undefined &&
			aggregate.bodyClose > aggregate.bodyOpen
		)
			declaration.body = { start: open.startOffset, end: close.endOffset };
		return declaration;
	}

	/** Whether a tag `name` declared so far is in scope at token `at`, in `containerId`'s blocks or the file. */
	private tagInScope(name: string, containerId: string | undefined, at: number): boolean {
		return [containerId, undefined].some((scope) =>
			(this.scoped.get(scopeKey(scope, name)) ?? []).some(
				(declaration) =>
					(declaration.kind === "struct" || declaration.kind === "enum") &&
					!this.replaced.has(declaration) &&
					visibleAt(declaration, at),
			),
		);
	}

	/** Its `{`, even past a tag the parser could not read. */
	private aggregateHeaderEnd(aggregate: AggregateInfo, statement: Statement): number {
		if (aggregate.bodyOpen >= 0) return aggregate.bodyOpen;
		const end = statement.terminator === "semicolon" ? statement.last : statement.last + 1;
		for (let index = aggregate.keywordIndex; index < end; index++) {
			if (!this.directiveTokens.has(index) && tokenValue(this.tokens, index) === "{") return index;
		}
		return end;
	}

	/** Members under `container`, or under the first declarator or the enclosing scope when the body is anonymous. */
	private parseAggregateBody(
		aggregate: AggregateInfo,
		context: ScopeContext,
		container: CDeclaration | undefined,
		objects: CDeclaration[],
	): void {
		const owner = container ?? (aggregate.keyword === "enum" ? undefined : objects[0]);
		if (owner !== undefined) {
			for (const object of objects) {
				const answer = this.typeAnswers.get(object.symbolId);
				if (object !== owner && answer !== undefined && answer.typeName === undefined)
					answer.fieldsOf = owner.symbolId;
			}
			const closer = this.tokens[aggregate.bodyClose] as CToken;
			if (closer.lineStart) owner.memberInsertLine = closer.start.line;
			// An anonymous body's owner holds its braces, not the initializer after them.
			owner.body ??= { start: (this.tokens[aggregate.bodyOpen] as CToken).startOffset, end: closer.endOffset };
			this.parseMembers(
				aggregate,
				{
					kind: "member",
					parentPath: owner.descriptorPath,
					containerId: owner.symbolId,
					// Enumerators are names of the block around their enum.
					...(aggregate.keyword === "enum" && context.block !== undefined ? { block: context.block } : {}),
					...(context.local === true ? { local: true as const } : {}),
				},
				owner.name,
			);
			return;
		}
		// Anonymous enumerators and C11 anonymous members belong to the enclosing scope.
		if (aggregate.keyword === "enum") this.parseMembers(aggregate, context, "int");
		else if (context.kind === "member") this.parseMembers(aggregate, context, "");
	}

	private parseMembers(aggregate: AggregateInfo, context: ScopeContext, typeText: string): void {
		const start = aggregate.bodyOpen + 1;
		if (aggregate.keyword === "enum") this.parseEnumMembers(start, aggregate.bodyClose, context, typeText);
		else this.nested(start, () => this.parseStructMembers(start, aggregate.bodyClose, context));
	}

	private parseStructMembers(start: number, end: number, context: ScopeContext): void {
		let memberStart = start;
		let parentheses = 0;
		let brackets = 0;
		let braces = 0;
		for (let index = start; index <= end; index++) {
			const value = this.directiveTokens.has(index) ? "" : tokenValue(this.tokens, index);
			const close = value === "{" && index < end ? this.pairs.get(index) : undefined;
			if (close !== undefined && close > index && close < end) {
				index = close;
				continue;
			}
			if (value === "(") parentheses++;
			else if (value === ")") parentheses = Math.max(0, parentheses - 1);
			else if (value === "[") brackets++;
			else if (value === "]") brackets = Math.max(0, brackets - 1);
			else if (value === "{") braces++;
			else if (value === "}") braces = Math.max(0, braces - 1);
			const terminated = value === ";" && parentheses === 0 && brackets === 0 && braces === 0;
			if (terminated || index === end) {
				const first = this.code(memberStart, index);
				if (first < index) {
					const last = terminated ? index : this.codeBefore(index);
					this.parseDeclaration(
						{ start: first, last, next: index + 1, terminator: "semicolon" },
						context,
						first,
						index,
					);
				}
				memberStart = index + 1;
			}
		}
	}

	private parseEnumMembers(start: number, end: number, context: ScopeContext, typeText: string): void {
		for (const segment of this.splitSegments(start, end)) {
			const first = this.code(segment.start, segment.end);
			const nameIndex = first < segment.end ? this.findDeclaratorName(first, segment.end) : -1;
			if (nameIndex < 0) continue;
			const token = this.tokens[nameIndex] as CToken;
			const last = this.codeBefore(segment.end);
			if (last < nameIndex) continue;
			const member = this.addCandidate({
				name: token.value,
				declarationKind: "constant",
				descriptorKind: "term",
				rangeStartIndex: declarationRangeStart(this.tokens, first),
				rangeEndIndex: last,
				selectionIndex: nameIndex,
				parentPath: context.parentPath,
				visibility: context.local === true ? "local" : "public",
				signature: this.header(first, last),
				typeText,
				conditionalKey: this.conditionalByIndex.get(nameIndex) ?? "",
				conditionalGroup: this.conditionalGroupByIndex.get(nameIndex) ?? "",
				...this.blockScope(context, segment.end),
			});
			if (member !== undefined) this.declarationNameIndices.add(nameIndex);
		}
	}

	private declareObject(
		statement: Statement,
		context: ScopeContext,
		head: DeclarationHead,
		declarator: DeclaratorName,
	): CDeclaration | undefined {
		const member = context.kind === "member";
		const typedef = head.typedef && !member;
		const isStatic = context.kind === "file" && this.headHas(head, STATIC_WORDS);
		// Its initializer already sees it; its declarator's own brackets do not.
		const initializer = this.topLevelIndex(declarator.nameEndIndex + 1, declarator.segmentEnd, SUFFIX_ENDS);
		const declaration = this.addCandidate({
			name: declarator.name,
			declarationKind: member
				? "field"
				: typedef
					? "class"
					: this.isConstantObject(head, declarator)
						? "constant"
						: "variable",
			descriptorKind: typedef ? "type" : "term",
			...(typedef ? { languageKind: "typedef" } : {}),
			rangeStartIndex: declarationRangeStart(this.tokens, statement.start),
			rangeEndIndex: statement.last,
			selectionIndex: declarator.nameIndex,
			selectionEndIndex: declarator.nameEndIndex,
			parentPath: context.parentPath,
			visibility: member ? "public" : context.kind === "file" ? (isStatic ? "fileLocal" : "public") : "local",
			...(member ? {} : { exported: context.kind === "file" && !isStatic }),
			signature: this.declaratorHeader(head.first, declarator),
			typeText: declarator.typeText,
			typeStartIndex: declarator.typeStart,
			typeEndIndex: declarator.typeEnd,
			...defined({ typeName: declarator.typeName }),
			conditionalKey: this.conditionalByIndex.get(statement.start) ?? "",
			conditionalGroup: this.conditionalGroupByIndex.get(statement.start) ?? "",
			...this.blockScope(context, initializer < 0 ? declarator.segmentEnd : initializer),
		});
		if (declaration !== undefined) this.markQualifiedName(declarator.nameIndex, declarator.nameEndIndex);
		this.markTypeRange(declarator.typeStart, declarator.typeEnd);
		this.markSuffixParameters(declarator);
		if (!member) this.checkInitializer(declarator.nameIndex, declarator.segmentEnd);
		return declaration;
	}

	/** Types and names in the parameter lists after a declarator's name, as `(*handler)(int code)` holds. */
	private markSuffixParameters(declarator: DeclaratorName): void {
		const initializer = this.topLevelIndex(declarator.nameEndIndex + 1, declarator.segmentEnd, SUFFIX_ENDS);
		const end = initializer < 0 ? declarator.segmentEnd : initializer;
		for (let index = declarator.nameEndIndex + 1; index < end; index++) {
			const value = this.directiveTokens.has(index) ? "" : tokenValue(this.tokens, index);
			const close = value === "(" || value === "[" ? this.pairs.get(index) : undefined;
			if (close === undefined || close >= end) continue;
			if (value === "(") this.markParameters(index, close);
			index = close;
		}
	}

	/** Types and names in a parameter list that declares nothing. */
	private markParameters(open: number, close: number): void {
		for (const segment of this.splitSegments(open + 1, close)) {
			const first = this.code(segment.start, segment.end);
			if (first >= segment.end) continue;
			const parameter = this.declarators(this.readHead(first, segment.end), segment.end)[0];
			if (parameter === undefined) {
				this.markTypeRange(segment.start, segment.end);
				continue;
			}
			this.markQualifiedName(parameter.nameIndex, parameter.nameEndIndex);
			this.markTypeRange(parameter.typeStart, parameter.typeEnd);
			this.nested(parameter.nameIndex, () => this.markSuffixParameters(parameter));
		}
	}

	/** Whether the object itself is `const`: its last pointer's qualifiers say, else its specifiers. */
	private isConstantObject(head: DeclarationHead, declarator: DeclaratorName): boolean {
		let pointer = -1;
		for (let index = declarator.segmentStart; index < declarator.nameIndex; index++) {
			if (!this.directiveTokens.has(index) && tokenValue(this.tokens, index) === "*") pointer = index;
		}
		if (pointer < 0) return this.headHas(head, CONST_WORDS);
		for (let index = pointer + 1; index < declarator.nameIndex; index++) {
			if (!this.directiveTokens.has(index) && CONST_WORDS.has(tokenValue(this.tokens, index))) return true;
		}
		return false;
	}

	private checkInitializer(nameIndex: number, end: number): void {
		let index = this.code(nameIndex + 1, end);
		if (!ASSIGNMENT_OPERATORS.has(tokenValue(this.tokens, index))) return;
		index = this.code(index + 1, end);
		if (index >= end || tokenValue(this.tokens, index) === "," || tokenValue(this.tokens, index) === ";")
			this.addDiagnostic("Initializer has no expression.", nameIndex);
	}

	private declareFunction(
		statement: Statement,
		context: ScopeContext,
		head: DeclarationHead,
		declarator: DeclaratorName,
		candidate: FunctionCandidate,
		owned: boolean,
	): void {
		const rangeStartIndex = declarationRangeStart(this.tokens, statement.start);
		const bodyOpen = owned ? statement.bodyOpen : undefined;
		const bodyClose = owned ? (statement.bodyClose ?? statement.last) : undefined;
		const endIndex = bodyClose ?? statement.last;
		const visibility =
			context.kind === "file" ? (this.headHas(head, STATIC_WORDS) ? "fileLocal" : "public") : "local";
		const metrics =
			bodyOpen !== undefined && bodyClose !== undefined
				? this.functionMetrics(bodyOpen, bodyClose, candidate.open, candidate.close)
				: {
						lines: lineCount(this.tokens[rangeStartIndex] as CToken, this.tokens[endIndex] as CToken),
						parameters: this.parameterCount(candidate.open, candidate.close),
					};
		const declaration = this.addCandidate({
			name: candidate.name,
			declarationKind: "function",
			descriptorKind: "method",
			...(owned ? {} : { languageKind: "prototype" }),
			rangeStartIndex,
			rangeEndIndex: endIndex,
			selectionIndex: candidate.nameIndex,
			selectionEndIndex: candidate.nameEndIndex,
			parentPath: context.parentPath,
			visibility,
			exported: context.kind === "file" ? visibility === "public" : false,
			signature: this.declaratorHeader(head.first, declarator),
			metrics,
			typeText: declarator.typeText,
			typeStartIndex: declarator.typeStart,
			typeEndIndex: declarator.typeEnd,
			...defined({ typeName: declarator.typeName }),
			conditionalKey: this.conditionalByIndex.get(statement.start) ?? "",
			conditionalGroup: this.conditionalGroupByIndex.get(statement.start) ?? "",
			isDefinition: owned,
			...this.blockScope(context, candidate.close + 1),
		});
		if (declaration === undefined) return;
		this.markQualifiedName(candidate.nameIndex, candidate.nameEndIndex);
		this.markTypeRange(declarator.typeStart, declarator.typeEnd);
		// Parameters are in scope through the body, or through their list without one.
		const parameters = { open: candidate.open, close: bodyClose ?? candidate.close };
		// A repeated prototype's parameters are its first one's.
		if (declaration.selectionIndex !== candidate.nameIndex) this.markParameters(candidate.open, candidate.close);
		else if (owned && statement.parameterDeclarations !== undefined && bodyOpen !== undefined)
			this.parseOldStyleParameters(candidate, declaration, statement.parameterDeclarations, bodyOpen, parameters);
		else this.parseParameters(candidate.open, candidate.close, declaration, parameters);
		if (bodyOpen !== undefined && bodyClose !== undefined)
			this.parseScope(bodyOpen + 1, bodyClose, {
				kind: "function",
				parentPath: declaration.descriptorPath,
				containerId: declaration.symbolId,
				block: { open: bodyOpen, close: bodyClose },
				local: true,
			});
	}

	private parseParameters(
		open: number,
		close: number,
		functionDeclaration: CDeclaration,
		block: { open: number; close: number },
	): void {
		for (const segment of this.splitSegments(open + 1, close)) {
			const first = this.code(segment.start, segment.end);
			if (first >= segment.end) continue;
			if (tokenValue(this.tokens, first) === "void" && this.code(first + 1, segment.end) >= segment.end) continue;
			const declarator = this.declarators(this.readHead(first, segment.end), segment.end)[0];
			if (declarator === undefined) {
				this.markTypeRange(segment.start, segment.end);
				continue;
			}
			const last = this.codeBefore(segment.end);
			if (last < segment.start) continue;
			const scope = { ...block, from: segment.end };
			this.declareParameter(
				functionDeclaration,
				declarator.nameIndex,
				declarator.nameEndIndex,
				last,
				scope,
				declarator,
			);
			this.markTypeRange(declarator.typeStart, declarator.typeEnd);
			this.markSuffixParameters(declarator);
		}
	}

	/** An identifier list's parameters, typed by the declarations from `from` to the body. */
	private parseOldStyleParameters(
		candidate: FunctionCandidate,
		functionDeclaration: CDeclaration,
		from: number,
		bodyOpen: number,
		block: { open: number; close: number },
	): void {
		const typed = new Map<string, DeclaratorName>();
		for (let index = this.code(from, bodyOpen); index < bodyOpen; ) {
			const end = this.topLevelIndex(index, bodyOpen, SEMICOLON);
			if (end < 0) break;
			for (const declarator of this.declarators(this.readHead(index, end), end)) {
				typed.set(declarator.name, declarator);
				this.markQualifiedName(declarator.nameIndex, declarator.nameEndIndex);
				this.markTypeRange(declarator.typeStart, declarator.typeEnd);
			}
			index = this.code(end + 1, bodyOpen);
		}
		for (const segment of this.splitSegments(candidate.open + 1, candidate.close)) {
			const nameIndex = this.code(segment.start, segment.end);
			if (!isIdentifierToken(this.tokens[nameIndex])) continue;
			const declarator = typed.get(tokenValue(this.tokens, nameIndex));
			const scope = { ...block, from: segment.end };
			this.declareParameter(functionDeclaration, nameIndex, nameIndex, nameIndex, scope, declarator);
		}
	}

	private declareParameter(
		functionDeclaration: CDeclaration,
		nameIndex: number,
		nameEndIndex: number,
		last: number,
		scope: BlockScope,
		declarator: DeclaratorName | undefined,
	): void {
		const parameter = this.addCandidate({
			name: declarator?.name ?? tokenValue(this.tokens, nameIndex),
			declarationKind: "variable",
			descriptorKind: "parameter",
			languageKind: "parameter",
			rangeStartIndex: nameIndex,
			rangeEndIndex: last,
			selectionIndex: nameIndex,
			selectionEndIndex: nameEndIndex,
			parentPath: functionDeclaration.descriptorPath,
			visibility: "local",
			exported: false,
			...(declarator === undefined
				? {}
				: {
						typeText: declarator.typeText,
						typeStartIndex: declarator.typeStart,
						typeEndIndex: declarator.typeEnd,
						...defined({ typeName: declarator.typeName }),
					}),
			conditionalKey: this.conditionalByIndex.get(nameIndex) ?? "",
			conditionalGroup: this.conditionalGroupByIndex.get(nameIndex) ?? "",
			scope,
		});
		if (parameter !== undefined) this.markQualifiedName(nameIndex, nameEndIndex);
	}

	private parameterCount(open: number, close: number): number {
		return this.splitSegments(open + 1, close).filter((segment) => {
			const first = this.code(segment.start, segment.end);
			const afterFirst = this.code(first + 1, segment.end);
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
			if (this.directiveTokens.has(index)) continue;
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
}
