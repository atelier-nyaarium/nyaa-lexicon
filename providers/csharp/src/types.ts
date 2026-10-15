// C# type declarations: classes, structs, interfaces, records, enums, delegates and extension blocks.

import type { Reference, SymbolKind } from "@nyaa-lexicon/protocol";
import { exportedFor, visibilityFor } from "./members.js";
import { type AnglePairs, type Boundary, type Leading, positionKey, type RawDeclaration } from "./model.js";
import type { CsharpParseContext } from "./parseContext.js";
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

export class CsharpTypeParser {
	constructor(private readonly context: CsharpParseContext) {}

	/** A type's or namespace's members, between its braces. */

	/**
	 * `extension<T>(Receiver r) where ... { members }`: a block of extension members for a receiver,
	 * in a static class. -1 when `extension` starts something else.
	 */
	public parseExtension(keyword: number, end: number, parent: RawDeclaration, leading: Leading | undefined): number {
		let open = this.context.tokenStream.nextSignificant(keyword + 1, end);
		const typeParameters = this.context.tokenStream.value(open) === "<" ? open : -1;
		const typeParametersClose = typeParameters < 0 ? -1 : this.context.typeReader.listClose(typeParameters, end);
		if (typeParameters >= 0)
			open =
				typeParametersClose < 0 ? -1 : this.context.tokenStream.nextSignificant(typeParametersClose + 1, end);
		if (open < 0 || this.context.tokenStream.value(open) !== "(") return -1;
		const close = this.context.tokenStream.matching(open, "(", ")", end);
		if (close < 0) return -1;
		let body = this.context.tokenStream.nextSignificant(close + 1, end);
		if (this.context.tokenStream.value(body) === "where") body = this.findTypeBoundary(body, end)?.index ?? -1;
		if (this.context.tokenStream.value(body) !== "{") return -1;
		const bodyClose = this.context.tokenStream.matching(body, "{", "}", end);
		const token = this.context.tokenStream.token(keyword) as Token;
		const block = this.context.recorder.addDeclaration({
			kind: "class",
			languageKind: "extension",
			name: token.value,
			parent,
			startToken: leading?.start ?? token,
			endToken: this.context.tokenStream.token(bodyClose < 0 ? end - 1 : bodyClose) ?? token,
			selectionStart: token,
			selectionEnd: token,
			codeStart: token,
			visibility: "public",
			exported: parent.exported,
			signature: this.context.typeReader.header(leading?.attributes ?? keyword, body),
			bodyStartToken: this.context.tokenStream.token(body),
			bodyEndToken: bodyClose < 0 ? undefined : this.context.tokenStream.token(bodyClose),
			memberInsertLine: this.context.tokenStream.closerLine(bodyClose),
			nameTokenOffsets: [token.startOffset],
		});
		if (typeParameters >= 0) this.context.signatures.markTypeParameters(typeParameters, typeParametersClose, block);
		this.parseReceiver(open, close, block);
		if (!this.context.outline) this.context.signatures.parseTypeConstraints(close + 1, body);
		this.context.declarations.parseScope(body + 1, bodyClose < 0 ? end : bodyClose, block);
		return bodyClose < 0 ? end : bodyClose + 1;
	}

	/** An extension block's receiver: a parameter when named, else a type alone. */
	private parseReceiver(open: number, close: number, block: RawDeclaration): void {
		const first = this.context.tokenStream.nextSignificant(open + 1, close);
		const shape = first < 0 ? undefined : this.context.typeReader.typeShape(first, close);
		if (shape !== undefined && this.context.tokenStream.nextSignificant(shape.end, close) < 0)
			this.context.recorder.addTypeReference(first, shape.end - 1, "typeUse");
		else block.parameterCount = this.context.signatures.parseParameters(open, close, block);
	}

	public parseType(
		keywordIndex: number,
		codeStartIndex: number,
		end: number,
		parent: RawDeclaration | undefined,
		leading: Leading | undefined,
		modifiers: Set<string>,
	): number {
		const firstKeyword = this.context.tokenStream.token(keywordIndex);
		if (firstKeyword === undefined) return -1;
		let kindWord = firstKeyword.value;
		let recordFlavor = "";
		let current = keywordIndex + 1;
		if (kindWord === "record") {
			const possibleFlavor = this.context.tokenStream.nextSignificant(current, end);
			if (
				this.context.tokenStream.value(possibleFlavor) === "class" ||
				this.context.tokenStream.value(possibleFlavor) === "struct"
			) {
				recordFlavor = this.context.tokenStream.value(possibleFlavor) ?? "";
				kindWord = recordFlavor;
				current = possibleFlavor + 1;
			}
		}
		const nameIndex = this.context.tokenStream.nextSignificant(current, end);
		const nameToken = this.context.tokenStream.token(nameIndex);
		if (!isIdentifier(nameToken)) {
			this.context.tokenStream.report("Type declaration needs a name.", firstKeyword);
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
		let afterName = this.context.tokenStream.nextSignificant(nameIndex + 1, end);
		let typeParameterOpen = -1;
		let typeParameterClose = -1;
		if (this.context.tokenStream.value(afterName) === "<") {
			typeParameterOpen = afterName;
			typeParameterClose = this.context.typeReader.listClose(afterName, end);
			if (typeParameterClose < 0)
				this.context.tokenStream.report(
					"Generic type parameter list is not closed.",
					this.context.tokenStream.token(afterName),
				);
			afterName =
				typeParameterClose < 0 ? end : this.context.tokenStream.nextSignificant(typeParameterClose + 1, end);
		}
		const boundary = this.findTypeBoundary(afterName, end);
		if (boundary === undefined)
			this.context.tokenStream.report(
				"Type declaration needs a body or semicolon.",
				this.context.tokenStream.token(end - 1) ?? nameToken,
			);
		const bodyOpen = boundary?.kind === "body" ? boundary.index : -1;
		const bodyClose = bodyOpen < 0 ? -1 : this.context.tokenStream.matching(bodyOpen, "{", "}", end);
		if (bodyOpen >= 0 && bodyClose < 0)
			this.context.tokenStream.report("Type body is not closed.", this.context.tokenStream.token(bodyOpen));
		const endToken =
			this.context.tokenStream.token(bodyClose >= 0 ? bodyClose : (boundary?.index ?? end - 1)) ?? nameToken;
		const codeEnd = boundary?.index ?? end - 1;
		const type = this.context.recorder.addDeclaration({
			kind,
			languageKind: typeLanguageKind,
			name: nameToken.value,
			parent,
			startToken: leading?.start ?? this.context.tokenStream.token(codeStartIndex) ?? firstKeyword,
			endToken,
			selectionStart: nameToken,
			selectionEnd: nameToken,
			codeStart: this.context.tokenStream.token(codeStartIndex) ?? firstKeyword,
			visibility: visibilityFor(modifiers, parent, kind),
			exported: exportedFor(visibilityFor(modifiers, parent, kind), parent),
			isPartial: modifiers.has("partial"),
			signature: this.context.typeReader.header(leading?.attributes ?? codeStartIndex, codeEnd),
			bodyStartToken: bodyOpen < 0 ? undefined : this.context.tokenStream.token(bodyOpen),
			bodyEndToken: bodyClose < 0 ? undefined : this.context.tokenStream.token(bodyClose),
			memberInsertLine: this.context.tokenStream.closerLine(bodyClose),
			nameTokenOffsets: [nameToken.startOffset],
		});
		this.context.signatures.markTypeParameters(typeParameterOpen, typeParameterClose, type);
		const primaryOpen = this.context.tokenStream.value(afterName) === "(" ? afterName : -1;
		const primaryClose = primaryOpen < 0 ? -1 : this.context.tokenStream.matching(primaryOpen, "(", ")", end);
		if (primaryClose >= 0)
			type.parameterCount = this.context.signatures.parseParameters(primaryOpen, primaryClose, type);
		const headerEnd = bodyOpen >= 0 ? bodyOpen : codeEnd;
		const angles = this.context.typeReader.typeAngles(nameIndex, headerEnd);
		this.markBaseTypes(nameIndex, headerEnd, type, angles);
		if (!this.context.outline) this.context.signatures.parseTypeConstraints(nameIndex, headerEnd, angles);
		if (bodyOpen >= 0) {
			if (kind === "enum") this.parseEnumMembers(bodyOpen + 1, bodyClose < 0 ? end : bodyClose, type);
			else this.context.declarations.parseScope(bodyOpen + 1, bodyClose < 0 ? end : bodyClose, type);
		}
		if (bodyClose >= 0) return bodyClose + 1;
		return boundary?.kind === "semicolon" ? boundary.index + 1 : end;
	}

	/** `angles` from a walk starting at the name. */
	private markBaseTypes(start: number, end: number, parent: RawDeclaration, angles: AnglePairs): void {
		const whereIndex = this.context.typeReader.topLevelValue(start + 1, end, "where", angles);
		const bound = whereIndex < 0 ? end : whereIndex;
		const colon = this.context.typeReader.topLevelValue(start + 1, bound, ":", angles);
		if (colon < 0) return;
		let segmentRole: Reference["role"] = parent.kind === "struct" ? "implements" : "extends";
		for (const segment of this.context.typeReader.commaSegments(colon + 1, bound, angles)) {
			this.context.recorder.addTypeReference(segment.start, segment.end - 1, "typeUse");
			for (let current = segment.start; current < segment.end; current++) {
				const item = this.context.tokenStream.token(current);
				if (isIdentifier(item)) this.context.recorder.markBaseListName(positionKey(item.start));
			}
			// The base is its rightmost name: `Base` in `N.Base<T>`.
			const name = this.context.typeReader.typeShape(segment.start, segment.end)?.name;
			if (name !== undefined) this.context.recorder.markRole(name.startOffset, segmentRole);
			segmentRole = parent.kind === "interface" ? "extends" : "implements";
		}
	}

	private parseEnumMembers(start: number, end: number, parent: RawDeclaration): void {
		let current = start;
		let pendingLeading: Token | undefined;
		let pendingAttributes: number | undefined;
		while (current < end) {
			const item = this.context.tokenStream.token(current);
			if (item?.kind === "doc") {
				pendingLeading = earliest(pendingLeading, item);
				current++;
				continue;
			}
			if (isTrivia(item)) {
				current++;
				continue;
			}
			const section = this.context.attributes.attributeSectionAt(current, end);
			if (section !== undefined) {
				if (section.close < 0) return;
				pendingLeading = earliest(pendingLeading, this.context.tokenStream.token(section.open));
				pendingAttributes ??= section.open;
				current = section.close + 1;
				continue;
			}
			const nameIndex = this.context.tokenStream.nextSignificant(current, end);
			if (nameIndex < 0) return;
			const name = this.context.tokenStream.token(nameIndex);
			if (!isIdentifier(name)) return;
			let finish = nameIndex + 1;
			let depth = 0;
			while (finish < end) {
				const value = this.context.tokenStream.value(finish);
				if (value === "(" || value === "[" || value === "{") depth++;
				if (value === ")" || value === "]" || value === "}") depth--;
				if ((value === "," || value === "}") && depth === 0) break;
				finish++;
			}
			const previous = this.context.tokenStream.previousSignificant(finish, nameIndex);
			const endToken = this.context.tokenStream.token(previous >= nameIndex ? previous : nameIndex) ?? name;
			this.context.recorder.ignore(name.startOffset);
			this.context.recorder.addDeclaration({
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
				signature: this.context.typeReader.header(pendingAttributes ?? nameIndex, finish),
				nameTokenOffsets: [name.startOffset],
			});
			pendingLeading = undefined;
			pendingAttributes = undefined;
			current = this.context.tokenStream.value(finish) === "," ? finish + 1 : finish;
		}
	}

	public parseDelegate(
		keywordIndex: number,
		codeStartIndex: number,
		end: number,
		parent: RawDeclaration | undefined,
		leading: Leading | undefined,
		modifiers: Set<string>,
	): number {
		const keyword = this.context.tokenStream.token(keywordIndex);
		if (keyword === undefined) return -1;
		const boundary = this.context.tokenStream.findSemicolon(keywordIndex + 1, end);
		if (boundary < 0)
			this.context.tokenStream.report("Delegate declaration has no terminating semicolon.", keyword);
		const finish = boundary < 0 ? end : boundary;
		const open = this.context.members.findCallParen(keywordIndex + 1, finish);
		const nameIndex =
			open < 0
				? this.context.tokenStream.lastIdentifier(keywordIndex + 1, finish)
				: this.context.members.methodNameIndex(open, keywordIndex + 1);
		const name = this.context.tokenStream.token(nameIndex);
		if (!isIdentifier(name)) {
			this.context.tokenStream.report("Delegate declaration needs a name.", keyword);
			return boundary < 0 ? end : boundary + 1;
		}
		const visibility = visibilityFor(modifiers, parent, "function");
		const delegate = this.context.recorder.addDeclaration({
			kind: "function",
			languageKind: "delegate",
			name: name.value,
			parent,
			startToken: leading?.start ?? this.context.tokenStream.token(codeStartIndex) ?? keyword,
			endToken: this.context.tokenStream.token(boundary >= 0 ? boundary : finish - 1) ?? name,
			selectionStart: name,
			selectionEnd: name,
			codeStart: this.context.tokenStream.token(codeStartIndex) ?? keyword,
			visibility,
			exported: exportedFor(visibility, parent),
			signature: this.context.typeReader.header(
				leading?.attributes ?? codeStartIndex,
				boundary >= 0 ? boundary : finish,
			),
			nameTokenOffsets: [name.startOffset],
		});
		const genericOpen = this.context.tokenStream.nextSignificant(nameIndex + 1, open < 0 ? finish : open);
		if (this.context.tokenStream.value(genericOpen) === "<")
			this.context.signatures.markTypeParameters(
				genericOpen,
				this.context.typeReader.listClose(genericOpen, open < 0 ? finish : open),
				delegate,
			);
		const close = open < 0 ? -1 : this.context.tokenStream.matching(open, "(", ")", finish);
		delegate.parameterCount = close < 0 ? 0 : this.context.signatures.parseParameters(open, close, delegate);
		if (!this.context.outline && close >= 0) this.context.signatures.parseTypeConstraints(close + 1, finish);
		const typeSpan = this.context.typeReader.spanBeforeName(keywordIndex + 1, nameIndex);
		this.context.recorder.recordTypeSpan(typeSpan, delegate);
		return boundary < 0 ? end : boundary + 1;
	}

	/** Undefined when `start` is -1, as past the last token. */
	private findTypeBoundary(start: number, end: number): Boundary | undefined {
		let parentheses = 0;
		let brackets = 0;
		for (let current = start < 0 ? end : start; current < end; current++) {
			const value = this.context.tokenStream.value(current);
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
