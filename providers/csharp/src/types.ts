// C# type declarations: classes, structs, interfaces, records, enums, delegates and extension blocks.

import type { Reference, SymbolKind } from "@nyaa-lexicon/protocol";
import { CsharpMemberParser, exportedFor, visibilityFor } from "./members.js";
import { type AnglePairs, type Boundary, type Leading, positionKey, type RawDeclaration } from "./model.js";
import type { Token } from "./tokens.js";
import { isIdentifier, isTrivia } from "./words.js";

////////////////////////////////
//  Functions & Helpers

export function earliest(left: Token | undefined, right: Token | undefined): Token | undefined {
	if (left === undefined) return right;
	if (right === undefined) return left;
	return left.startOffset <= right.startOffset ? left : right;
}

////////////////////////////////
//  Classes

export abstract class CsharpTypeParser extends CsharpMemberParser {
	/** A type's or namespace's members, between its braces. */
	protected abstract parseScope(start: number, end: number, parent: RawDeclaration | undefined): void;

	/**
	 * `extension<T>(Receiver r) where ... { members }`: a block of extension members for a receiver,
	 * in a static class. -1 when `extension` starts something else.
	 */
	protected parseExtension(
		keyword: number,
		end: number,
		parent: RawDeclaration,
		leading: Leading | undefined,
	): number {
		let open = this.nextSignificant(keyword + 1, end);
		const typeParameters = this.value(open) === "<" ? open : -1;
		const typeParametersClose = typeParameters < 0 ? -1 : this.listClose(typeParameters, end);
		if (typeParameters >= 0)
			open = typeParametersClose < 0 ? -1 : this.nextSignificant(typeParametersClose + 1, end);
		if (open < 0 || this.value(open) !== "(") return -1;
		const close = this.matching(open, "(", ")", end);
		if (close < 0) return -1;
		let body = this.nextSignificant(close + 1, end);
		if (this.value(body) === "where") body = this.findTypeBoundary(body, end)?.index ?? -1;
		if (this.value(body) !== "{") return -1;
		const bodyClose = this.matching(body, "{", "}", end);
		const token = this.token(keyword) as Token;
		const block = this.addDeclaration({
			kind: "class",
			languageKind: "extension",
			name: token.value,
			parent,
			startToken: leading?.start ?? token,
			endToken: this.token(bodyClose < 0 ? end - 1 : bodyClose) ?? token,
			selectionStart: token,
			selectionEnd: token,
			codeStart: token,
			visibility: "public",
			exported: parent.exported,
			signature: this.header(leading?.attributes ?? keyword, body),
			bodyStartToken: this.token(body),
			bodyEndToken: bodyClose < 0 ? undefined : this.token(bodyClose),
			memberInsertLine: this.closerLine(bodyClose),
			nameTokenOffsets: [token.startOffset],
		});
		if (typeParameters >= 0) this.markTypeParameters(typeParameters, typeParametersClose, block);
		this.parseReceiver(open, close, block);
		if (!this.outline) this.parseTypeConstraints(close + 1, body);
		this.parseScope(body + 1, bodyClose < 0 ? end : bodyClose, block);
		return bodyClose < 0 ? end : bodyClose + 1;
	}

	/** An extension block's receiver: a parameter when named, else a type alone. */
	private parseReceiver(open: number, close: number, block: RawDeclaration): void {
		const first = this.nextSignificant(open + 1, close);
		const shape = first < 0 ? undefined : this.typeShape(first, close);
		if (shape !== undefined && this.nextSignificant(shape.end, close) < 0)
			this.addTypeReference(first, shape.end - 1, "typeUse");
		else block.parameterCount = this.parseParameters(open, close, block);
	}

	protected parseType(
		keywordIndex: number,
		codeStartIndex: number,
		end: number,
		parent: RawDeclaration | undefined,
		leading: Leading | undefined,
		modifiers: Set<string>,
	): number {
		const firstKeyword = this.token(keywordIndex);
		if (firstKeyword === undefined) return -1;
		let kindWord = firstKeyword.value;
		let recordFlavor = "";
		let current = keywordIndex + 1;
		if (kindWord === "record") {
			const possibleFlavor = this.nextSignificant(current, end);
			if (this.value(possibleFlavor) === "class" || this.value(possibleFlavor) === "struct") {
				recordFlavor = this.value(possibleFlavor) ?? "";
				kindWord = recordFlavor;
				current = possibleFlavor + 1;
			}
		}
		const nameIndex = this.nextSignificant(current, end);
		const nameToken = this.token(nameIndex);
		if (!isIdentifier(nameToken)) {
			this.report("Type declaration needs a name.", firstKeyword);
			return -1;
		}
		const kind: SymbolKind =
			kindWord === "interface"
				? "interface"
				: kindWord === "struct"
					? "struct"
					: kindWord === "enum"
						? "enum"
						: "class";
		const typeLanguageKind =
			firstKeyword.value === "record" ? (recordFlavor === "struct" ? "recordStruct" : "record") : kindWord;
		let afterName = this.nextSignificant(nameIndex + 1, end);
		let typeParameterOpen = -1;
		let typeParameterClose = -1;
		if (this.value(afterName) === "<") {
			typeParameterOpen = afterName;
			typeParameterClose = this.listClose(afterName, end);
			if (typeParameterClose < 0)
				this.report("Generic type parameter list is not closed.", this.token(afterName));
			afterName = typeParameterClose < 0 ? end : this.nextSignificant(typeParameterClose + 1, end);
		}
		const boundary = this.findTypeBoundary(afterName, end);
		if (boundary === undefined)
			this.report("Type declaration needs a body or semicolon.", this.token(end - 1) ?? nameToken);
		const bodyOpen = boundary?.kind === "body" ? boundary.index : -1;
		const bodyClose = bodyOpen < 0 ? -1 : this.matching(bodyOpen, "{", "}", end);
		if (bodyOpen >= 0 && bodyClose < 0) this.report("Type body is not closed.", this.token(bodyOpen));
		const endToken = this.token(bodyClose >= 0 ? bodyClose : (boundary?.index ?? end - 1)) ?? nameToken;
		const codeEnd = boundary?.index ?? end - 1;
		const type = this.addDeclaration({
			kind,
			languageKind: typeLanguageKind,
			name: nameToken.value,
			parent,
			startToken: leading?.start ?? this.token(codeStartIndex) ?? firstKeyword,
			endToken,
			selectionStart: nameToken,
			selectionEnd: nameToken,
			codeStart: this.token(codeStartIndex) ?? firstKeyword,
			visibility: visibilityFor(modifiers, parent, kind),
			exported: exportedFor(visibilityFor(modifiers, parent, kind), parent),
			isPartial: modifiers.has("partial"),
			signature: this.header(leading?.attributes ?? codeStartIndex, codeEnd),
			bodyStartToken: bodyOpen < 0 ? undefined : this.token(bodyOpen),
			bodyEndToken: bodyClose < 0 ? undefined : this.token(bodyClose),
			memberInsertLine: this.closerLine(bodyClose),
			nameTokenOffsets: [nameToken.startOffset],
		});
		this.markTypeParameters(typeParameterOpen, typeParameterClose, type);
		const primaryOpen = this.value(afterName) === "(" ? afterName : -1;
		const primaryClose = primaryOpen < 0 ? -1 : this.matching(primaryOpen, "(", ")", end);
		if (primaryClose >= 0) type.parameterCount = this.parseParameters(primaryOpen, primaryClose, type);
		const headerEnd = bodyOpen >= 0 ? bodyOpen : codeEnd;
		const angles = this.typeAngles(nameIndex, headerEnd);
		this.markBaseTypes(nameIndex, headerEnd, type, angles);
		if (!this.outline) this.parseTypeConstraints(nameIndex, headerEnd, angles);
		if (bodyOpen >= 0) {
			if (kind === "enum") this.parseEnumMembers(bodyOpen + 1, bodyClose < 0 ? end : bodyClose, type);
			else this.parseScope(bodyOpen + 1, bodyClose < 0 ? end : bodyClose, type);
		}
		if (bodyClose >= 0) return bodyClose + 1;
		return boundary?.kind === "semicolon" ? boundary.index + 1 : end;
	}

	/** `angles` from a walk starting at the name. */
	private markBaseTypes(start: number, end: number, parent: RawDeclaration, angles: AnglePairs): void {
		const whereIndex = this.topLevelValue(start + 1, end, "where", angles);
		const bound = whereIndex < 0 ? end : whereIndex;
		const colon = this.topLevelValue(start + 1, bound, ":", angles);
		if (colon < 0) return;
		let segmentRole: Reference["role"] = parent.kind === "struct" ? "implements" : "extends";
		for (const segment of this.commaSegments(colon + 1, bound, angles)) {
			this.addTypeReference(segment.start, segment.end - 1, "typeUse");
			for (let current = segment.start; current < segment.end; current++) {
				const item = this.token(current);
				if (isIdentifier(item)) this.baseListNames.add(positionKey(item.start));
			}
			// The base is its rightmost name: `Base` in `N.Base<T>`.
			const name = this.typeShape(segment.start, segment.end)?.name;
			if (name !== undefined) this.roleByOffset.set(name.startOffset, segmentRole);
			segmentRole = parent.kind === "interface" ? "extends" : "implements";
		}
	}

	private parseEnumMembers(start: number, end: number, parent: RawDeclaration): void {
		let current = start;
		let pendingLeading: Token | undefined;
		let pendingAttributes: number | undefined;
		while (current < end) {
			const item = this.token(current);
			if (item?.kind === "doc") {
				pendingLeading = earliest(pendingLeading, item);
				current++;
				continue;
			}
			if (isTrivia(item)) {
				current++;
				continue;
			}
			const section = this.attributeSectionAt(current, end);
			if (section !== undefined) {
				if (section.close < 0) return;
				pendingLeading = earliest(pendingLeading, this.token(section.open));
				pendingAttributes ??= section.open;
				current = section.close + 1;
				continue;
			}
			const nameIndex = this.nextSignificant(current, end);
			if (nameIndex < 0) return;
			const name = this.token(nameIndex);
			if (!isIdentifier(name)) return;
			let finish = nameIndex + 1;
			let depth = 0;
			while (finish < end) {
				const value = this.value(finish);
				if (value === "(" || value === "[" || value === "{") depth++;
				if (value === ")" || value === "]" || value === "}") depth--;
				if ((value === "," || value === "}") && depth === 0) break;
				finish++;
			}
			const previous = this.previousSignificant(finish, nameIndex);
			const endToken = this.token(previous >= nameIndex ? previous : nameIndex) ?? name;
			this.ignoredOffsets.add(name.startOffset);
			this.addDeclaration({
				kind: "constant",
				languageKind: "enumMember",
				name: name.value,
				parent,
				startToken: pendingLeading ?? name,
				endToken,
				selectionStart: name,
				selectionEnd: name,
				codeStart: name,
				visibility: "public",
				exported: parent.exported,
				signature: this.header(pendingAttributes ?? nameIndex, finish),
				nameTokenOffsets: [name.startOffset],
			});
			pendingLeading = undefined;
			pendingAttributes = undefined;
			current = this.value(finish) === "," ? finish + 1 : finish;
		}
	}

	protected parseDelegate(
		keywordIndex: number,
		codeStartIndex: number,
		end: number,
		parent: RawDeclaration | undefined,
		leading: Leading | undefined,
		modifiers: Set<string>,
	): number {
		const keyword = this.token(keywordIndex);
		if (keyword === undefined) return -1;
		const boundary = this.findSemicolon(keywordIndex + 1, end);
		if (boundary < 0) this.report("Delegate declaration has no terminating semicolon.", keyword);
		const finish = boundary < 0 ? end : boundary;
		const open = this.findCallParen(keywordIndex + 1, finish);
		const nameIndex =
			open < 0 ? this.lastIdentifier(keywordIndex + 1, finish) : this.methodNameIndex(open, keywordIndex + 1);
		const name = this.token(nameIndex);
		if (!isIdentifier(name)) {
			this.report("Delegate declaration needs a name.", keyword);
			return boundary < 0 ? end : boundary + 1;
		}
		const visibility = visibilityFor(modifiers, parent, "function");
		const delegate = this.addDeclaration({
			kind: "function",
			languageKind: "delegate",
			name: name.value,
			parent,
			startToken: leading?.start ?? this.token(codeStartIndex) ?? keyword,
			endToken: this.token(boundary >= 0 ? boundary : finish - 1) ?? name,
			selectionStart: name,
			selectionEnd: name,
			codeStart: this.token(codeStartIndex) ?? keyword,
			visibility,
			exported: exportedFor(visibility, parent),
			signature: this.header(leading?.attributes ?? codeStartIndex, boundary >= 0 ? boundary : finish),
			nameTokenOffsets: [name.startOffset],
		});
		const genericOpen = this.nextSignificant(nameIndex + 1, open < 0 ? finish : open);
		if (this.value(genericOpen) === "<")
			this.markTypeParameters(genericOpen, this.listClose(genericOpen, open < 0 ? finish : open), delegate);
		const close = open < 0 ? -1 : this.matching(open, "(", ")", finish);
		delegate.parameterCount = close < 0 ? 0 : this.parseParameters(open, close, delegate);
		if (!this.outline && close >= 0) this.parseTypeConstraints(close + 1, finish);
		const typeSpan = this.spanBeforeName(keywordIndex + 1, nameIndex);
		this.recordTypeSpan(typeSpan, delegate);
		return boundary < 0 ? end : boundary + 1;
	}

	/** Undefined when `start` is -1, as past the last token. */
	private findTypeBoundary(start: number, end: number): Boundary | undefined {
		let parentheses = 0;
		let brackets = 0;
		for (let current = start < 0 ? end : start; current < end; current++) {
			const value = this.value(current);
			if (value === "(") parentheses++;
			else if (value === ")") parentheses--;
			else if (value === "[") brackets++;
			else if (value === "]") brackets--;
			else if (parentheses === 0 && brackets === 0 && value === "{") return { kind: "body", index: current };
			else if (parentheses === 0 && brackets === 0 && value === ";") return { kind: "semicolon", index: current };
		}
		return undefined;
	}
}
