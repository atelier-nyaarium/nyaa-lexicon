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
import { CsharpSignatureReader } from "./signatures.js";
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

export abstract class CsharpMemberParser extends CsharpSignatureReader {
	/** A block body's statements, between its braces. */
	protected abstract parseBody(start: number, end: number, owner: RawDeclaration): void;

	/** An expression body, after its arrow. */
	protected abstract parseExpressionBody(start: number, end: number, owner: RawDeclaration): void;

	/** An accessor's attributes and body belong to its property, indexer or event. */
	private parseAccessors(start: number, end: number, owner: RawDeclaration): void {
		let current = this.nextSignificant(start, end);
		let guard = -1;
		while (current >= 0 && current < end) {
			if (current <= guard) throw new Error("accessor walk failed to advance");
			guard = current;
			const section = this.attributeSectionAt(current, end);
			if (section !== undefined) {
				current = section.close < 0 ? end : this.nextSignificant(section.close + 1, end);
				continue;
			}
			const item = this.token(current);
			if (isIdentifier(item) && MODIFIERS.has(syntaxValue(item) as string)) {
				current = this.nextSignificant(current + 1, end);
				continue;
			}
			if (isIdentifier(item) && ACCESSOR_KEYWORDS.has(syntaxValue(item) as string)) {
				const next = this.nextSignificant(current + 1, end);
				const nextValue = this.value(next);
				// A setter's `value` is its implicit parameter, which nothing declares.
				const takesValue = syntaxValue(item) !== "get";
				if (nextValue === "{") {
					const close = this.matching(next, "{", "}", end);
					const openToken = this.token(next);
					const closeToken = close < 0 ? undefined : this.token(close);
					if (openToken !== undefined && closeToken !== undefined)
						this.accessorBodyRanges.push({ start: openToken.endOffset, end: closeToken.startOffset });
					if (takesValue) this.markKeyword(next + 1, close < 0 ? end : close, "value");
					this.parseBody(next + 1, close < 0 ? end : close, owner);
					current = this.nextSignificant(close < 0 ? end : close + 1, end);
				} else if (nextValue === "=>") {
					const semicolon = this.findSemicolon(next + 1, end);
					if (takesValue) this.markKeyword(next + 1, semicolon < 0 ? end : semicolon, "value");
					this.parseExpressionBody(next + 1, semicolon < 0 ? end : semicolon, owner);
					current = this.nextSignificant(semicolon < 0 ? end : semicolon + 1, end);
				} else {
					if (nextValue !== ";") this.report("An accessor needs a body or a semicolon.", item);
					current = next < 0 ? end : next;
				}
				continue;
			}
			current = this.nextSignificant(current + 1, end);
		}
	}

	protected parseMember(
		index: number,
		modifiers: ModifierInfo,
		end: number,
		parent: RawDeclaration,
		leading: Leading | undefined,
	): number {
		const start = modifiers.index < end ? modifiers.index : index;
		if (this.value(start) === "event")
			return this.parseEvent(start, modifiers.start, end, parent, leading, modifiers.modifiers);
		const boundary = this.findMemberBoundary(start, end);
		if (boundary === undefined) {
			this.report("Member declaration needs a terminating delimiter.", this.token(start));
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
		const angles = this.typeAngles(start, open);
		const nameIndex = operator?.end ?? this.methodNameIndex(open, start, angles);
		const name = this.token(nameIndex);
		// A finalizer, `~C()`, is named with its tilde.
		const tilde = operator === undefined ? this.previousSignificant(nameIndex, start) : -1;
		const finalizer = tilde >= start && this.value(tilde) === "~" && isIdentifier(name);
		const declarationName =
			operator?.name ?? (isIdentifier(name) ? (finalizer ? `~${name.value}` : name.value) : undefined);
		if (declarationName === undefined) {
			this.report("Method declaration needs a name.", this.token(open));
			return this.advanceBoundary(boundary, end);
		}
		const isConstructor = operator === undefined && declarationName === parent.name;
		const qualifier = operator === undefined ? this.explicitInterfaceQualifier(start, nameIndex, angles) : [];
		const kind: SymbolKind = operator === undefined ? (isConstructor ? "constructor" : "method") : "operator";
		const selectionStart =
			operator === undefined ? this.token(finalizer ? tilde : nameIndex) : this.token(operator.start);
		const selectionEnd = operator === undefined ? name : this.token(operator.end);
		if (selectionStart === undefined || selectionEnd === undefined) return this.advanceBoundary(boundary, end);
		const nameTokenOffsets =
			operator === undefined
				? [selectionEnd.startOffset]
				: this.tokens
						.slice(operator.start, operator.end + 1)
						.filter((item) => item.kind === "identifier")
						.map((item) => item.startOffset);
		const visibility = visibilityFor(modifiers, parent, kind);
		const bodyClose = boundary.kind === "body" ? this.matching(boundary.index, "{", "}", end) : -1;
		if (boundary.kind === "body" && bodyClose < 0)
			this.report("Method body is not closed.", this.token(boundary.index));
		const close = this.matching(open, "(", ")", end);
		if (close < 0) this.report("Parameter list is not closed.", this.token(open));
		const arrow = close < 0 ? -1 : this.findTopLevelValue(close + 1, boundary.index, "=>");
		const endIndex = bodyClose >= 0 ? bodyClose : boundary.kind === "semicolon" ? boundary.index : end - 1;
		const method = this.addDeclaration({
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
							: modifiers.has("static") && this.value(open + 1) === "this"
								? "method extensionMethod"
								: "method",
			name: declarationName,
			parent,
			startToken: leading?.start ?? this.token(codeStartIndex) ?? selectionStart,
			endToken: this.token(endIndex) ?? selectionEnd,
			selectionStart,
			selectionEnd,
			codeStart: this.token(codeStartIndex) ?? selectionStart,
			visibility,
			exported: exportedFor(visibility, parent),
			signature: this.header(leading?.attributes ?? codeStartIndex, arrow >= 0 ? arrow : boundary.index),
			bodyStartToken: boundary.kind === "body" ? this.token(boundary.index) : undefined,
			bodyEndToken: bodyClose >= 0 ? this.token(bodyClose) : undefined,
			nameTokenOffsets,
			isStatic: modifiers.has("static"),
		});
		const conversion = modifiers.has("implicit") || modifiers.has("explicit");
		const typeSpan =
			operator === undefined
				? isConstructor || finalizer
					? undefined
					: this.spanBeforeName(start, nameIndex)
				: conversion
					? { start: operator.start + 1, end: operator.end + 1 }
					: this.spanBeforeName(start, operator.start);
		this.recordTypeSpan(typeSpan, method);
		const genericOpen = this.nextSignificant(nameIndex + 1, open);
		const genericClose = angles.get(genericOpen);
		if (genericClose !== undefined) this.markTypeParameters(genericOpen, genericClose, method);
		method.parameterCount = close < 0 ? 0 : this.parseParameters(open, close, method);
		if (!this.outline && close >= 0) this.parseTypeConstraints(close + 1, boundary.index);
		if (boundary.kind === "body") this.parseBody(boundary.index + 1, bodyClose < 0 ? end : bodyClose, method);
		else if (arrow >= 0) this.parseExpressionBody(arrow + 1, boundary.index, method);
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
		const name = this.token(nameIndex);
		if (!isIdentifier(name)) return this.advanceBoundary(boundary, end);
		if (syntaxValue(name) === "this") {
			const bracketOpen = this.nextSignificant(nameIndex + 1, end);
			if (this.value(bracketOpen) === "[") {
				const bracketClose = this.matching(bracketOpen, "[", "]", end);
				if (bracketClose >= 0) this.walkAttributeSections(bracketOpen + 1, bracketClose);
			}
		}
		const close = boundary.kind === "body" ? this.matching(boundary.index, "{", "}", end) : -1;
		if (boundary.kind === "body" && close < 0)
			this.report("Property body is not closed.", this.token(boundary.index));
		const visibility = visibilityFor(modifiers, parent, "property");
		const qualifier = this.explicitInterfaceQualifier(start, nameIndex);
		const property = this.addDeclaration({
			kind: "property",
			...(qualifier.length === 0 ? {} : { qualifier }),
			languageKind: "property",
			name: name.value,
			parent,
			startToken: leading?.start ?? this.token(codeStartIndex) ?? name,
			endToken: this.token(close >= 0 ? close : boundary.index) ?? name,
			selectionStart: name,
			selectionEnd: name,
			codeStart: this.token(codeStartIndex) ?? name,
			visibility,
			exported: exportedFor(visibility, parent),
			signature: this.header(leading?.attributes ?? codeStartIndex, headerEnd),
			nameTokenOffsets: [name.startOffset],
		});
		this.recordTypeSpan(this.spanBeforeName(start, nameIndex), property);
		const indexer = syntaxValue(name) === "this";
		// `field` in a property's accessors is its backing field's keyword.
		if (close >= 0) {
			if (!indexer) this.markKeyword(boundary.index + 1, close, "field");
			this.parseAccessors(boundary.index + 1, close, property);
			const afterBody = this.nextSignificant(close + 1, end);
			if (this.value(afterBody) === "=") {
				const semicolon = this.findSemicolon(afterBody + 1, end);
				this.parseExpressionBody(afterBody + 1, semicolon < 0 ? end : semicolon, property);
				return semicolon < 0 ? end : semicolon + 1;
			}
		} else if (this.value(headerEnd) === "=>") {
			if (!indexer) this.markKeyword(headerEnd + 1, boundary.index, "field");
			this.parseExpressionBody(headerEnd + 1, boundary.index, property);
		}
		return this.advanceBoundary(boundary, end, close);
	}

	/** A contextual keyword in `[start, end)` names nothing, unless reached through a member operator. */
	private markKeyword(start: number, end: number, word: string): void {
		for (let index = start; index < end; index++) {
			if (this.value(index) !== word) continue;
			const before = this.value(this.previousSignificant(index, start));
			if (before === undefined || !MEMBER_OPERATORS.has(before))
				this.ignoredOffsets.add((this.token(index) as Token).startOffset);
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
			this.report("Event declaration needs a terminating delimiter.", this.token(start));
			return -1;
		}
		const finish = boundary.index;
		const angles = this.typeAngles(start + 1, finish);
		const segments = this.commaSegments(start + 1, finish, angles);
		const firstSegment = segments[0];
		const firstNameIndex =
			firstSegment === undefined ? -1 : this.firstDeclaratorName(firstSegment.start, firstSegment.end, angles);
		const firstName = this.token(firstNameIndex);
		if (!isIdentifier(firstName)) {
			this.report("Event declaration needs a name.", this.token(start));
			return this.advanceBoundary(boundary, end);
		}
		const close = boundary.kind === "body" ? this.matching(boundary.index, "{", "}", end) : -1;
		const visibility = visibilityFor(modifiers, parent, "event");
		const type = this.declaredType(this.spanBeforeName(start + 1, firstNameIndex));
		const qualifier = this.explicitInterfaceQualifier(start + 1, firstNameIndex, angles);
		const declared: Declarator[] = [];
		for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex++) {
			const segment = segments[segmentIndex] as TypeSpan;
			const nameIndex =
				segmentIndex === 0 ? firstNameIndex : this.findDeclaratorName(segment.start, segment.end, angles);
			const name = this.token(nameIndex);
			if (!isIdentifier(name)) continue;
			this.ignoredOffsets.add(name.startOffset);
			const event = this.addDeclaration({
				kind: "event",
				...(qualifier.length === 0 ? {} : { qualifier }),
				languageKind: "event",
				name: name.value,
				parent,
				startToken: leading?.start ?? this.token(codeStartIndex) ?? name,
				endToken: this.token(close >= 0 ? close : boundary.index) ?? name,
				selectionStart: name,
				selectionEnd: name,
				codeStart: this.token(codeStartIndex) ?? name,
				visibility,
				exported: exportedFor(visibility, parent),
				signature: this.header(
					leading?.attributes ?? codeStartIndex,
					segment.end,
					segmentIndex === 0 ? undefined : { from: firstNameIndex, to: nameIndex },
				),
				...type,
				nameTokenOffsets: [name.startOffset],
			});
			this.recordTypeSpan(segmentIndex === 0 ? this.spanBeforeName(start + 1, nameIndex) : undefined, event);
			const first = segmentIndex === 0 ? (leading?.attributes ?? codeStartIndex) : nameIndex;
			declared.push({ declaration: event, start: first, end: this.previousSignificant(segment.end, first) });
			this.parseInitializer(nameIndex, segment.end, event);
		}
		this.ownDeclarators(declared);
		const owner = declared[0]?.declaration;
		if (close >= 0 && owner !== undefined) this.parseAccessors(boundary.index + 1, close, owner);
		return this.advanceBoundary(boundary, end, close);
	}

	/** A declarator's `= value` after its name, up to `end`, read for what it declares. */
	private parseInitializer(nameIndex: number, end: number, owner: RawDeclaration): void {
		const equals = this.nextSignificant(nameIndex + 1, end);
		if (this.value(equals) === "=") this.parseExpressionBody(equals + 1, end, owner);
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
		const angles = this.typeAngles(start, finish);
		const segments = this.commaSegments(start, finish, angles);
		const firstName = this.firstDeclaratorName(segments[0]?.start ?? start, segments[0]?.end ?? finish, angles);
		const firstNameToken = this.token(firstName);
		if (!isIdentifier(firstNameToken)) {
			this.report("Field declaration needs a name.", this.token(start));
			return this.advanceBoundary(boundary, end);
		}
		const type = this.declaredType(this.spanBeforeName(start, firstName));
		const kind: SymbolKind = modifiers.has("const") ? "constant" : "field";
		const visibility = visibilityFor(modifiers, parent, kind);
		const declared: Declarator[] = [];
		for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex++) {
			const segment = segments[segmentIndex] as TypeSpan;
			const nameIndex =
				segmentIndex === 0 ? firstName : this.findDeclaratorName(segment.start, segment.end, angles);
			const name = this.token(nameIndex);
			if (!isIdentifier(name)) continue;
			this.ignoredOffsets.add(name.startOffset);
			const inferredType =
				!this.outline && type.typeText === undefined ? this.initializerType(segment.end, nameIndex) : undefined;
			const field = this.addDeclaration({
				kind,
				languageKind: kind === "constant" ? "const" : "field",
				name: name.value,
				parent,
				startToken: leading?.start ?? this.token(codeStartIndex) ?? name,
				endToken: this.token(boundary.index) ?? name,
				selectionStart: name,
				selectionEnd: name,
				codeStart: this.token(codeStartIndex) ?? name,
				visibility,
				exported: exportedFor(visibility, parent),
				signature: this.header(
					leading?.attributes ?? codeStartIndex,
					segment.end,
					segmentIndex === 0 ? undefined : { from: firstName, to: nameIndex },
				),
				...type,
				...defined({ inferredType }),
				nameTokenOffsets: [name.startOffset],
			});
			this.recordTypeSpan(segmentIndex === 0 ? this.spanBeforeName(start, nameIndex) : undefined, field);
			const first = segmentIndex === 0 ? (leading?.attributes ?? codeStartIndex) : nameIndex;
			declared.push({ declaration: field, start: first, end: this.previousSignificant(segment.end, first) });
			this.parseInitializer(nameIndex, segment.end, field);
		}
		this.ownDeclarators(declared);
		return this.advanceBoundary(boundary, end);
	}

	protected findMemberBoundary(start: number, end: number): Boundary | undefined {
		let parentheses = 0;
		let brackets = 0;
		let braces = 0;
		let initializer = false;
		for (let current = start; current < end; current++) {
			const value = this.value(current);
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
	protected findCallParen(start: number, end: number): number {
		let typePosition = true;
		let afterOperator = false;
		let previous = -1;
		for (let current = start; current < end; current++) {
			const item = this.token(current);
			if (isTrivia(item)) continue;
			const value = syntaxValue(item);
			if (value === "(" && typePosition) {
				const tuple = this.typeShape(current, end);
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
			if (value === "[" || (value === "<" && this.opensTypeList(previous, current, end, true, 0))) {
				const close = value === "[" ? this.matching(current, "[", "]", end) : this.listClose(current, end);
				if (close < 0) return -1;
				current = close;
			}
			previous = current;
		}
		return -1;
	}

	protected methodNameIndex(open: number, start: number, angles: AnglePairs = this.typeAngles(start, open)): number {
		const nameIndex = this.previousSignificant(open, start);
		const list = this.listEndingAt(nameIndex, angles);
		return list < 0 ? nameIndex : this.previousSignificant(list, start);
	}

	/** The written interface of an explicit implementation, as names; kinds are settled once the parse is whole. */
	private explicitInterfaceQualifier(
		start: number,
		nameIndex: number,
		angles: AnglePairs = this.typeAngles(start, nameIndex),
	): string[] {
		const names: string[] = [];
		let current = this.previousSignificant(nameIndex, start);
		while (current >= start && this.value(current) === ".") {
			const qualifier = this.previousSignificant(current, start);
			const segment = this.genericInterfaceBefore(qualifier, start, angles);
			if (segment === null) break;
			names.unshift(segment.name);
			current = this.previousSignificant(segment.start, start);
		}
		return names;
	}

	private genericInterfaceBefore(
		index: number,
		start: number,
		angles: AnglePairs,
	): { name: string; start: number } | null {
		const token = this.token(index);
		if (isIdentifier(token)) return { name: token.value, start: index };
		const list = this.listEndingAt(index, angles);
		const nameIndex = list < 0 ? -1 : this.previousSignificant(list, start);
		const name = this.token(nameIndex);
		return isIdentifier(name) ? { name: name.value, start: nameIndex } : null;
	}

	private operatorName(
		start: number,
		open: number,
	): { name: string; start: number; end: number; conversion: boolean } | undefined {
		const operatorIndex = this.findTopLevelValue(start, open, "operator");
		if (operatorIndex < 0) return undefined;
		const targetStart = this.nextSignificant(operatorIndex + 1, open);
		const targetEnd = this.previousSignificant(open, targetStart);
		const first = this.token(targetStart);
		if (first === undefined || targetEnd < targetStart) return undefined;
		const target = this.tokens
			.slice(targetStart, targetEnd + 1)
			.filter((item) => !isTrivia(item))
			.map((item) => item.value)
			.join("");
		if (target === "") return undefined;
		const keyword = this.value(this.previousSignificant(operatorIndex, start));
		return {
			name: first.kind === "identifier" ? `operator ${target}` : `operator${target}`,
			start: operatorIndex,
			end: targetEnd,
			conversion: keyword === "implicit" || keyword === "explicit",
		};
	}

	private propertyName(start: number, end: number): number {
		const thisIndex = this.findTopLevelValue(start, end, "this");
		if (thisIndex >= 0) return thisIndex;
		return this.lastIdentifier(start, end);
	}

	/** Arrow after `=` is a lambda, not a body. */
	private expressionBodyArrow(start: number, end: number): number {
		const arrow = this.findTopLevelValue(start, end, "=>");
		return arrow >= 0 && this.findTopLevelValue(start, arrow, "=") < 0 ? arrow : -1;
	}

	protected advanceBoundary(boundary: Boundary, end: number, bodyClose = -1): number {
		if (boundary.kind === "semicolon") return boundary.index + 1;
		if (bodyClose >= 0) return bodyClose + 1;
		const close = this.matching(boundary.index, "{", "}", end);
		return close >= 0 ? close + 1 : end;
	}
}
