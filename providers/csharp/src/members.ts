// C# type members: methods, operators, properties, indexers, events, fields, and their accessors.

import { defined, type SymbolKind } from "@nyaa-lexicon/protocol";
import type {
	AnglePairs,
	Boundary,
	Declarator,
	Leading,
	ModifierInfo,
	RawDeclaration,
	TypeSpan,
	Visibility,
} from "./model.js";
import type { CsharpParseContext } from "./parseContext.js";
import type { Token } from "./tokens.js";
import { ACCESSOR_KEYWORDS, isIdentifier, isTrivia, MEMBER_OPERATORS, MODIFIERS, syntaxValue } from "./words.js";

////////////////////////////////
//  Functions & Helpers

export function visibilityFor(
	modifiers: Set<string>,
	parent: RawDeclaration | undefined,
	kind: SymbolKind,
): Visibility {
	if (modifiers.has("public")) return "public";
	if (modifiers.has("protected")) return "protected";
	if (modifiers.has("private")) return "private";
	if (modifiers.has("internal")) return "internal";
	if (modifiers.has("file")) return "fileLocal";
	if (kind === "namespace") return "public";
	if (parent === undefined) return "internal";
	if (parent.kind === "namespace") return "internal";
	if (parent.languageKind === "interface" || parent.kind === "interface") return "public";
	if (parent.kind === "enum") return "public";
	if (kind === "constructor" && parent.kind === "struct") return "public";
	if (kind === "typeParameter" || kind === "variable") return "local";
	return "private";
}

export function exportedFor(visibility: Visibility, parent: RawDeclaration | undefined): boolean {
	if (visibility !== "public" && visibility !== "internal") return false;
	if (parent === undefined) return true;
	return parent.exported;
}

////////////////////////////////
//  Classes

export class CsharpMemberParser {
	constructor(private readonly context: CsharpParseContext) {}

	/** A block body's statements, between its braces. */

	/** An expression body, after its arrow. */

	/** An accessor's attributes and body belong to its property, indexer or event. */
	private parseAccessors(start: number, end: number, owner: RawDeclaration): void {
		let current = this.context.tokenStream.nextSignificant(start, end);
		let guard = -1;
		while (current >= 0 && current < end) {
			if (current <= guard) throw new Error("accessor walk failed to advance");
			guard = current;
			const section = this.context.attributes.attributeSectionAt(current, end);
			if (section !== undefined) {
				current = section.close < 0 ? end : this.context.tokenStream.nextSignificant(section.close + 1, end);
				continue;
			}
			const item = this.context.tokenStream.token(current);
			if (isIdentifier(item) && MODIFIERS.has(syntaxValue(item) as string)) {
				current = this.context.tokenStream.nextSignificant(current + 1, end);
				continue;
			}
			if (isIdentifier(item) && ACCESSOR_KEYWORDS.has(syntaxValue(item) as string)) {
				const next = this.context.tokenStream.nextSignificant(current + 1, end);
				const nextValue = this.context.tokenStream.value(next);
				// A setter's `value` is its implicit parameter, which nothing declares.
				const takesValue = syntaxValue(item) !== "get";
				if (nextValue === "{") {
					const close = this.context.tokenStream.matching(next, "{", "}", end);
					const openToken = this.context.tokenStream.token(next);
					const closeToken = close < 0 ? undefined : this.context.tokenStream.token(close);
					if (openToken !== undefined && closeToken !== undefined)
						this.context.recorder.addAccessorBodyRange({
							start: openToken.endOffset,
							end: closeToken.startOffset,
						});
					if (takesValue) this.markKeyword(next + 1, close < 0 ? end : close, "value");
					this.context.statements.parseBody(next + 1, close < 0 ? end : close, owner);
					current = this.context.tokenStream.nextSignificant(close < 0 ? end : close + 1, end);
				} else if (nextValue === "=>") {
					const semicolon = this.context.tokenStream.findSemicolon(next + 1, end);
					if (takesValue) this.markKeyword(next + 1, semicolon < 0 ? end : semicolon, "value");
					this.context.statements.parseExpressionBody(next + 1, semicolon < 0 ? end : semicolon, owner);
					current = this.context.tokenStream.nextSignificant(semicolon < 0 ? end : semicolon + 1, end);
				} else {
					if (nextValue !== ";")
						this.context.tokenStream.report("An accessor needs a body or a semicolon.", item);
					current = next < 0 ? end : next;
				}
				continue;
			}
			current = this.context.tokenStream.nextSignificant(current + 1, end);
		}
	}

	public parseMember(
		index: number,
		modifiers: ModifierInfo,
		end: number,
		parent: RawDeclaration,
		leading: Leading | undefined,
	): number {
		const start = modifiers.index < end ? modifiers.index : index;
		if (this.context.tokenStream.value(start) === "event")
			return this.parseEvent(start, modifiers.start, end, parent, leading, modifiers.modifiers);
		const boundary = this.findMemberBoundary(start, end);
		if (boundary === undefined) {
			this.context.tokenStream.report(
				"Member declaration needs a terminating delimiter.",
				this.context.tokenStream.token(start),
			);
			return -1;
		}
		const open = this.findCallParen(start, boundary.index);
		if (open >= 0)
			return this.parseMethod(start, modifiers.start, boundary, open, end, parent, leading, modifiers.modifiers);
		const arrow = this.expressionBodyArrow(start, boundary.index);
		if (boundary.kind === "body" || arrow >= 0) {
			const nameIndex = this.propertyName(start, arrow >= 0 ? arrow : boundary.index);
			if (nameIndex >= 0)
				return this.parseProperty(
					start,
					modifiers.start,
					boundary,
					arrow >= 0 ? arrow : boundary.index,
					nameIndex,
					end,
					parent,
					leading,
					modifiers.modifiers,
				);
		}
		return this.parseField(start, modifiers.start, boundary, end, parent, leading, modifiers.modifiers);
	}

	private parseMethod(
		start: number,
		codeStartIndex: number,
		boundary: Boundary,
		open: number,
		end: number,
		parent: RawDeclaration,
		leading: Leading | undefined,
		modifiers: Set<string>,
	): number {
		const operator = this.operatorName(start, open);
		const angles = this.context.typeReader.typeAngles(start, open);
		const nameIndex = operator?.end ?? this.methodNameIndex(open, start, angles);
		const name = this.context.tokenStream.token(nameIndex);
		// A finalizer, `~C()`, is named with its tilde.
		const tilde = operator === undefined ? this.context.tokenStream.previousSignificant(nameIndex, start) : -1;
		const finalizer = tilde >= start && this.context.tokenStream.value(tilde) === "~" && isIdentifier(name);
		const declarationName =
			operator?.name ?? (isIdentifier(name) ? (finalizer ? `~${name.value}` : name.value) : undefined);
		if (declarationName === undefined) {
			this.context.tokenStream.report("Method declaration needs a name.", this.context.tokenStream.token(open));
			return this.advanceBoundary(boundary, end);
		}
		const isConstructor = operator === undefined && declarationName === parent.name;
		const qualifier = operator === undefined ? this.explicitInterfaceQualifier(start, nameIndex, angles) : [];
		const kind: SymbolKind = operator === undefined ? (isConstructor ? "constructor" : "method") : "operator";
		const selectionStart =
			operator === undefined
				? this.context.tokenStream.token(finalizer ? tilde : nameIndex)
				: this.context.tokenStream.token(operator.start);
		const selectionEnd = operator === undefined ? name : this.context.tokenStream.token(operator.end);
		if (selectionStart === undefined || selectionEnd === undefined) return this.advanceBoundary(boundary, end);
		const nameTokenOffsets =
			operator === undefined
				? [selectionEnd.startOffset]
				: this.context.tokenStream.tokens
						.slice(operator.start, operator.end + 1)
						.filter((item) => item.kind === "identifier")
						.map((item) => item.startOffset);
		const visibility = visibilityFor(modifiers, parent, kind);
		const bodyClose =
			boundary.kind === "body" ? this.context.tokenStream.matching(boundary.index, "{", "}", end) : -1;
		if (boundary.kind === "body" && bodyClose < 0)
			this.context.tokenStream.report(
				"Method body is not closed.",
				this.context.tokenStream.token(boundary.index),
			);
		const close = this.context.tokenStream.matching(open, "(", ")", end);
		if (close < 0)
			this.context.tokenStream.report("Parameter list is not closed.", this.context.tokenStream.token(open));
		const arrow = close < 0 ? -1 : this.context.tokenStream.findTopLevelValue(close + 1, boundary.index, "=>");
		const endIndex = bodyClose >= 0 ? bodyClose : boundary.kind === "semicolon" ? boundary.index : end - 1;
		const method = this.context.recorder.addDeclaration({
			kind,
			...(qualifier.length === 0 ? {} : { qualifier }),
			languageKind:
				operator !== undefined
					? operator.conversion
						? "conversionOperator"
						: "operator"
					: isConstructor
						? "constructor"
						: finalizer
							? "finalizer"
							: modifiers.has("static") && this.context.tokenStream.value(open + 1) === "this"
								? "method extensionMethod"
								: "method",
			name: declarationName,
			parent,
			startToken: leading?.start ?? this.context.tokenStream.token(codeStartIndex) ?? selectionStart,
			endToken: this.context.tokenStream.token(endIndex) ?? selectionEnd,
			selectionStart,
			selectionEnd,
			codeStart: this.context.tokenStream.token(codeStartIndex) ?? selectionStart,
			visibility,
			exported: exportedFor(visibility, parent),
			signature: this.context.typeReader.header(
				leading?.attributes ?? codeStartIndex,
				arrow >= 0 ? arrow : boundary.index,
			),
			bodyStartToken: boundary.kind === "body" ? this.context.tokenStream.token(boundary.index) : undefined,
			bodyEndToken: bodyClose >= 0 ? this.context.tokenStream.token(bodyClose) : undefined,
			nameTokenOffsets,
			isStatic: modifiers.has("static"),
		});
		const conversion = modifiers.has("implicit") || modifiers.has("explicit");
		const typeSpan =
			operator === undefined
				? isConstructor || finalizer
					? undefined
					: this.context.typeReader.spanBeforeName(start, nameIndex)
				: conversion
					? { start: operator.start + 1, end: operator.end + 1 }
					: this.context.typeReader.spanBeforeName(start, operator.start);
		this.context.recorder.recordTypeSpan(typeSpan, method);
		const genericOpen = this.context.tokenStream.nextSignificant(nameIndex + 1, open);
		const genericClose = angles.get(genericOpen);
		if (genericClose !== undefined) this.context.signatures.markTypeParameters(genericOpen, genericClose, method);
		method.parameterCount = close < 0 ? 0 : this.context.signatures.parseParameters(open, close, method);
		if (!this.context.outline && close >= 0)
			this.context.signatures.parseTypeConstraints(close + 1, boundary.index);
		if (boundary.kind === "body")
			this.context.statements.parseBody(boundary.index + 1, bodyClose < 0 ? end : bodyClose, method);
		else if (arrow >= 0) this.context.statements.parseExpressionBody(arrow + 1, boundary.index, method);
		return this.advanceBoundary(boundary, end, bodyClose);
	}

	private parseProperty(
		start: number,
		codeStartIndex: number,
		boundary: Boundary,
		headerEnd: number,
		nameIndex: number,
		end: number,
		parent: RawDeclaration,
		leading: Leading | undefined,
		modifiers: Set<string>,
	): number {
		const name = this.context.tokenStream.token(nameIndex);
		if (!isIdentifier(name)) return this.advanceBoundary(boundary, end);
		if (syntaxValue(name) === "this") {
			const bracketOpen = this.context.tokenStream.nextSignificant(nameIndex + 1, end);
			if (this.context.tokenStream.value(bracketOpen) === "[") {
				const bracketClose = this.context.tokenStream.matching(bracketOpen, "[", "]", end);
				if (bracketClose >= 0) this.context.attributes.walkAttributeSections(bracketOpen + 1, bracketClose);
			}
		}
		const close = boundary.kind === "body" ? this.context.tokenStream.matching(boundary.index, "{", "}", end) : -1;
		if (boundary.kind === "body" && close < 0)
			this.context.tokenStream.report(
				"Property body is not closed.",
				this.context.tokenStream.token(boundary.index),
			);
		const visibility = visibilityFor(modifiers, parent, "property");
		const qualifier = this.explicitInterfaceQualifier(start, nameIndex);
		const property = this.context.recorder.addDeclaration({
			kind: "property",
			...(qualifier.length === 0 ? {} : { qualifier }),
			languageKind: "property",
			name: name.value,
			parent,
			startToken: leading?.start ?? this.context.tokenStream.token(codeStartIndex) ?? name,
			endToken: this.context.tokenStream.token(close >= 0 ? close : boundary.index) ?? name,
			selectionStart: name,
			selectionEnd: name,
			codeStart: this.context.tokenStream.token(codeStartIndex) ?? name,
			visibility,
			exported: exportedFor(visibility, parent),
			signature: this.context.typeReader.header(leading?.attributes ?? codeStartIndex, headerEnd),
			nameTokenOffsets: [name.startOffset],
			isStatic: modifiers.has("static"),
		});
		this.context.recorder.recordTypeSpan(this.context.typeReader.spanBeforeName(start, nameIndex), property);
		const indexer = syntaxValue(name) === "this";
		// `field` in a property's accessors is its backing field's keyword.
		if (close >= 0) {
			if (!indexer) this.markKeyword(boundary.index + 1, close, "field");
			this.parseAccessors(boundary.index + 1, close, property);
			const afterBody = this.context.tokenStream.nextSignificant(close + 1, end);
			if (this.context.tokenStream.value(afterBody) === "=") {
				const semicolon = this.context.tokenStream.findSemicolon(afterBody + 1, end);
				this.context.statements.parseExpressionBody(afterBody + 1, semicolon < 0 ? end : semicolon, property);
				return semicolon < 0 ? end : semicolon + 1;
			}
		} else if (this.context.tokenStream.value(headerEnd) === "=>") {
			if (!indexer) this.markKeyword(headerEnd + 1, boundary.index, "field");
			this.context.statements.parseExpressionBody(headerEnd + 1, boundary.index, property);
		}
		return this.advanceBoundary(boundary, end, close);
	}

	/** A contextual keyword in `[start, end)` names nothing, unless reached through a member operator. */
	private markKeyword(start: number, end: number, word: string): void {
		for (let index = start; index < end; index++) {
			if (this.context.tokenStream.value(index) !== word) continue;
			const before = this.context.tokenStream.value(this.context.tokenStream.previousSignificant(index, start));
			if (before === undefined || !MEMBER_OPERATORS.has(before))
				this.context.recorder.ignore((this.context.tokenStream.token(index) as Token).startOffset);
		}
	}

	private parseEvent(
		start: number,
		codeStartIndex: number,
		end: number,
		parent: RawDeclaration,
		leading: Leading | undefined,
		modifiers: Set<string>,
	): number {
		const boundary = this.findMemberBoundary(start, end);
		if (boundary === undefined) {
			this.context.tokenStream.report(
				"Event declaration needs a terminating delimiter.",
				this.context.tokenStream.token(start),
			);
			return -1;
		}
		const finish = boundary.index;
		const angles = this.context.typeReader.typeAngles(start + 1, finish);
		const segments = this.context.typeReader.commaSegments(start + 1, finish, angles);
		const firstSegment = segments[0];
		const firstNameIndex =
			firstSegment === undefined
				? -1
				: this.context.typeReader.firstDeclaratorName(firstSegment.start, firstSegment.end, angles);
		const firstName = this.context.tokenStream.token(firstNameIndex);
		if (!isIdentifier(firstName)) {
			this.context.tokenStream.report("Event declaration needs a name.", this.context.tokenStream.token(start));
			return this.advanceBoundary(boundary, end);
		}
		const close = boundary.kind === "body" ? this.context.tokenStream.matching(boundary.index, "{", "}", end) : -1;
		const visibility = visibilityFor(modifiers, parent, "event");
		const type = this.context.typeReader.declaredType(
			this.context.typeReader.spanBeforeName(start + 1, firstNameIndex),
		);
		const qualifier = this.explicitInterfaceQualifier(start + 1, firstNameIndex, angles);
		const declared: Declarator[] = [];
		for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex++) {
			const segment = segments[segmentIndex] as TypeSpan;
			const nameIndex =
				segmentIndex === 0
					? firstNameIndex
					: this.context.typeReader.findDeclaratorName(segment.start, segment.end, angles);
			const name = this.context.tokenStream.token(nameIndex);
			if (!isIdentifier(name)) continue;
			this.context.recorder.ignore(name.startOffset);
			const event = this.context.recorder.addDeclaration({
				kind: "event",
				...(qualifier.length === 0 ? {} : { qualifier }),
				languageKind: "event",
				name: name.value,
				parent,
				startToken: leading?.start ?? this.context.tokenStream.token(codeStartIndex) ?? name,
				endToken: this.context.tokenStream.token(close >= 0 ? close : boundary.index) ?? name,
				selectionStart: name,
				selectionEnd: name,
				codeStart: this.context.tokenStream.token(codeStartIndex) ?? name,
				visibility,
				exported: exportedFor(visibility, parent),
				signature: this.context.typeReader.header(
					leading?.attributes ?? codeStartIndex,
					segment.end,
					segmentIndex === 0 ? undefined : { from: firstNameIndex, to: nameIndex },
				),
				...type,
				nameTokenOffsets: [name.startOffset],
				isStatic: modifiers.has("static"),
			});
			this.context.recorder.recordTypeSpan(
				segmentIndex === 0 ? this.context.typeReader.spanBeforeName(start + 1, nameIndex) : undefined,
				event,
			);
			const first = segmentIndex === 0 ? (leading?.attributes ?? codeStartIndex) : nameIndex;
			declared.push({
				declaration: event,
				start: first,
				end: this.context.tokenStream.previousSignificant(segment.end, first),
			});
			this.parseInitializer(nameIndex, segment.end, event);
		}
		this.context.recorder.ownDeclarators(declared);
		const owner = declared[0]?.declaration;
		if (close >= 0 && owner !== undefined) this.parseAccessors(boundary.index + 1, close, owner);
		return this.advanceBoundary(boundary, end, close);
	}

	/** A declarator's `= value` after its name, up to `end`, read for what it declares. */
	private parseInitializer(nameIndex: number, end: number, owner: RawDeclaration): void {
		const equals = this.context.tokenStream.nextSignificant(nameIndex + 1, end);
		if (this.context.tokenStream.value(equals) === "=")
			this.context.statements.parseExpressionBody(equals + 1, end, owner);
	}

	private parseField(
		start: number,
		codeStartIndex: number,
		boundary: Boundary,
		end: number,
		parent: RawDeclaration,
		leading: Leading | undefined,
		modifiers: Set<string>,
	): number {
		const finish = boundary.kind === "semicolon" ? boundary.index : this.advanceBoundary(boundary, end);
		const angles = this.context.typeReader.typeAngles(start, finish);
		const segments = this.context.typeReader.commaSegments(start, finish, angles);
		const firstName = this.context.typeReader.firstDeclaratorName(
			segments[0]?.start ?? start,
			segments[0]?.end ?? finish,
			angles,
		);
		const firstNameToken = this.context.tokenStream.token(firstName);
		if (!isIdentifier(firstNameToken)) {
			this.context.tokenStream.report("Field declaration needs a name.", this.context.tokenStream.token(start));
			return this.advanceBoundary(boundary, end);
		}
		const type = this.context.typeReader.declaredType(this.context.typeReader.spanBeforeName(start, firstName));
		const kind: SymbolKind = modifiers.has("const") ? "constant" : "field";
		const visibility = visibilityFor(modifiers, parent, kind);
		const declared: Declarator[] = [];
		for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex++) {
			const segment = segments[segmentIndex] as TypeSpan;
			const nameIndex =
				segmentIndex === 0
					? firstName
					: this.context.typeReader.findDeclaratorName(segment.start, segment.end, angles);
			const name = this.context.tokenStream.token(nameIndex);
			if (!isIdentifier(name)) continue;
			this.context.recorder.ignore(name.startOffset);
			const inferredType =
				!this.context.outline && type.typeText === undefined
					? this.context.recorder.initializerType(segment.end, nameIndex)
					: undefined;
			const field = this.context.recorder.addDeclaration({
				kind,
				languageKind: kind === "constant" ? "const" : "field",
				name: name.value,
				parent,
				startToken: leading?.start ?? this.context.tokenStream.token(codeStartIndex) ?? name,
				endToken: this.context.tokenStream.token(boundary.index) ?? name,
				selectionStart: name,
				selectionEnd: name,
				codeStart: this.context.tokenStream.token(codeStartIndex) ?? name,
				visibility,
				exported: exportedFor(visibility, parent),
				signature: this.context.typeReader.header(
					leading?.attributes ?? codeStartIndex,
					segment.end,
					segmentIndex === 0 ? undefined : { from: firstName, to: nameIndex },
				),
				...type,
				...defined({ inferredType }),
				nameTokenOffsets: [name.startOffset],
				isStatic: modifiers.has("static"),
			});
			this.context.recorder.recordTypeSpan(
				segmentIndex === 0 ? this.context.typeReader.spanBeforeName(start, nameIndex) : undefined,
				field,
			);
			const first = segmentIndex === 0 ? (leading?.attributes ?? codeStartIndex) : nameIndex;
			declared.push({
				declaration: field,
				start: first,
				end: this.context.tokenStream.previousSignificant(segment.end, first),
			});
			this.parseInitializer(nameIndex, segment.end, field);
		}
		this.context.recorder.ownDeclarators(declared);
		return this.advanceBoundary(boundary, end);
	}

	public findMemberBoundary(start: number, end: number): Boundary | undefined {
		let parentheses = 0;
		let brackets = 0;
		let braces = 0;
		let initializer = false;
		for (let current = start; current < end; current++) {
			const value = this.context.tokenStream.value(current);
			if (value === "(") parentheses++;
			else if (value === ")") parentheses--;
			else if (value === "[") brackets++;
			else if (value === "]") brackets--;
			else if (value === "=>" && parentheses === 0 && brackets === 0 && braces === 0) initializer = true;
			else if (value === "=" && parentheses === 0 && brackets === 0 && braces === 0) initializer = true;
			else if (value === "{" && parentheses === 0 && brackets === 0 && braces === 0) {
				if (!initializer) return { kind: "body", index: current };
				braces++;
			} else if (value === "{" && braces > 0) braces++;
			else if (value === "}" && braces > 0) braces--;
			else if (value === ";" && parentheses === 0 && brackets === 0 && braces === 0)
				return { kind: "semicolon", index: current };
		}
		return undefined;
	}

	/** Skips a leading or conversion tuple type, and an operator's symbol. */
	public findCallParen(start: number, end: number): number {
		let typePosition = true;
		let afterOperator = false;
		let previous = -1;
		for (let current = start; current < end; current++) {
			const item = this.context.tokenStream.token(current);
			if (isTrivia(item)) continue;
			const value = syntaxValue(item);
			if (value === "(" && typePosition) {
				const tuple = this.context.typeReader.typeShape(current, end);
				if (tuple !== undefined) {
					current = tuple.end - 1;
					previous = current;
					typePosition = false;
					afterOperator = false;
					continue;
				}
			}
			// `>>>` is two tokens.
			const symbol: boolean = afterOperator && item?.kind === "punctuation" && value !== "(";
			afterOperator = value === "operator" || symbol;
			typePosition = value === "operator";
			if (symbol) continue;
			if (value === "=" || value === "=>") return -1;
			if (value === "(") return current;
			// Before its parameters a member holds types and names only.
			if (
				value === "[" ||
				(value === "<" && this.context.typeReader.opensTypeList(previous, current, end, true, 0))
			) {
				const close =
					value === "["
						? this.context.tokenStream.matching(current, "[", "]", end)
						: this.context.typeReader.listClose(current, end);
				if (close < 0) return -1;
				current = close;
			}
			previous = current;
		}
		return -1;
	}

	public methodNameIndex(
		open: number,
		start: number,
		angles: AnglePairs = this.context.typeReader.typeAngles(start, open),
	): number {
		const nameIndex = this.context.tokenStream.previousSignificant(open, start);
		const list = this.context.typeReader.listEndingAt(nameIndex, angles);
		return list < 0 ? nameIndex : this.context.tokenStream.previousSignificant(list, start);
	}

	/** The written interface of an explicit implementation, as names; kinds are settled once the parse is whole. */
	private explicitInterfaceQualifier(
		start: number,
		nameIndex: number,
		angles: AnglePairs = this.context.typeReader.typeAngles(start, nameIndex),
	): string[] {
		const names: string[] = [];
		let current = this.context.tokenStream.previousSignificant(nameIndex, start);
		while (current >= start && this.context.tokenStream.value(current) === ".") {
			const qualifier = this.context.tokenStream.previousSignificant(current, start);
			const segment = this.genericInterfaceBefore(qualifier, start, angles);
			if (segment === null) break;
			names.unshift(segment.name);
			current = this.context.tokenStream.previousSignificant(segment.start, start);
		}
		return names;
	}

	private genericInterfaceBefore(
		index: number,
		start: number,
		angles: AnglePairs,
	): { name: string; start: number } | null {
		const token = this.context.tokenStream.token(index);
		if (isIdentifier(token)) return { name: token.value, start: index };
		const list = this.context.typeReader.listEndingAt(index, angles);
		const nameIndex = list < 0 ? -1 : this.context.tokenStream.previousSignificant(list, start);
		const name = this.context.tokenStream.token(nameIndex);
		return isIdentifier(name) ? { name: name.value, start: nameIndex } : null;
	}

	private operatorName(
		start: number,
		open: number,
	): { name: string; start: number; end: number; conversion: boolean } | undefined {
		const operatorIndex = this.context.tokenStream.findTopLevelValue(start, open, "operator");
		if (operatorIndex < 0) return undefined;
		const targetStart = this.context.tokenStream.nextSignificant(operatorIndex + 1, open);
		const targetEnd = this.context.tokenStream.previousSignificant(open, targetStart);
		const first = this.context.tokenStream.token(targetStart);
		if (first === undefined || targetEnd < targetStart) return undefined;
		const target = this.context.tokenStream.tokens
			.slice(targetStart, targetEnd + 1)
			.filter((item) => !isTrivia(item))
			.map((item) => item.value)
			.join("");
		if (target === "") return undefined;
		const keyword = this.context.tokenStream.value(
			this.context.tokenStream.previousSignificant(operatorIndex, start),
		);
		return {
			name: first.kind === "identifier" ? `operator ${target}` : `operator${target}`,
			start: operatorIndex,
			end: targetEnd,
			conversion: keyword === "implicit" || keyword === "explicit",
		};
	}

	private propertyName(start: number, end: number): number {
		const thisIndex = this.context.tokenStream.findTopLevelValue(start, end, "this");
		if (thisIndex >= 0) return thisIndex;
		return this.context.tokenStream.lastIdentifier(start, end);
	}

	/** Arrow after `=` is a lambda, not a body. */
	private expressionBodyArrow(start: number, end: number): number {
		const arrow = this.context.tokenStream.findTopLevelValue(start, end, "=>");
		return arrow >= 0 && this.context.tokenStream.findTopLevelValue(start, arrow, "=") < 0 ? arrow : -1;
	}

	public advanceBoundary(boundary: Boundary, end: number, bodyClose = -1): number {
		if (boundary.kind === "semicolon") return boundary.index + 1;
		if (bodyClose >= 0) return bodyClose + 1;
		const close = this.context.tokenStream.matching(boundary.index, "{", "}", end);
		return close >= 0 ? close + 1 : end;
	}
}
