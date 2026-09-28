// A C# signature's parts: type parameters, `where` constraints and parameters.

import { CsharpAttributeReader } from "./attributes.js";
import type { AnglePairs, RawDeclaration } from "./model.js";
import { CONSTRAINT_KEYWORDS, isIdentifier, syntaxValue } from "./words.js";

////////////////////////////////
//  Classes

export abstract class CsharpSignatureReader extends CsharpAttributeReader {
	protected markTypeParameters(start: number, close: number, parent: RawDeclaration): void {
		if (start < 0 || close < 0) return;
		let current = this.nextSignificant(start + 1, close);
		while (current >= 0 && current < close) {
			const section = this.attributeSectionAt(current, close);
			if (section !== undefined) {
				current = section.close < 0 ? -1 : this.nextSignificant(section.close + 1, close);
				continue;
			}
			const item = this.token(current);
			if (isIdentifier(item) && syntaxValue(item) !== "in" && syntaxValue(item) !== "out") {
				this.ignoredOffsets.add(item.startOffset);
				this.addDeclaration({
					kind: "typeParameter",
					languageKind: "typeParameter",
					name: item.value,
					parent,
					startToken: item,
					endToken: item,
					selectionStart: item,
					selectionEnd: item,
					codeStart: item,
					visibility: "local",
					exported: false,
					nameTokenOffsets: [item.startOffset],
				});
			}
			current = this.nextSignificant(current + 1, close);
			if (this.value(current) === ",") current = this.nextSignificant(current + 1, close);
		}
	}

	/** A `where` clause's constrained parameter and its bounds are a type use. */
	protected parseTypeConstraints(start: number, end: number, angles: AnglePairs = this.typeAngles(start, end)): void {
		let clauseStart = this.topLevelValue(start, end, "where", angles);
		while (clauseStart >= 0 && clauseStart < end) {
			const nameIndex = this.nextSignificant(clauseStart + 1, end);
			const colon = nameIndex < 0 ? -1 : this.nextSignificant(nameIndex + 1, end);
			if (colon < 0) return;
			const nextWhere = this.topLevelValue(colon + 1, end, "where", angles);
			const clauseEnd = nextWhere < 0 ? end : nextWhere;
			if (this.value(colon) === ":" && isIdentifier(this.token(nameIndex))) {
				this.addTypeReference(nameIndex, nameIndex, "typeUse");
				this.markConstraintSegments(colon + 1, clauseEnd, angles);
			}
			clauseStart = nextWhere;
		}
	}

	private markConstraintSegments(start: number, end: number, angles: AnglePairs): void {
		for (const segment of this.commaSegments(start, end, angles)) {
			if (
				this.nextSignificant(segment.start, segment.end) >= 0 &&
				!this.isConstraintKeyword(segment.start, segment.end)
			)
				this.addTypeReference(segment.start, segment.end - 1, "typeUse");
		}
	}

	/** A bare constraint keyword names no type. */
	private isConstraintKeyword(start: number, end: number): boolean {
		const first = this.nextSignificant(start, end);
		const token = this.token(first);
		if (token === undefined || !CONSTRAINT_KEYWORDS.has(this.value(first) ?? "")) return false;
		const next = this.nextSignificant(first + 1, end);
		const bareWord = next < 0;
		const newCall = this.value(first) === "new" && this.value(next) === "(";
		if (!bareWord && !newCall) return false;
		this.ignoredOffsets.add(token.startOffset);
		return true;
	}

	protected parseParameters(open: number, close: number, parent: RawDeclaration): number {
		if (open < 0 || close < 0 || close <= open) return 0;
		const angles = this.typeAngles(open + 1, close);
		const segments = this.commaSegments(open + 1, close, angles);
		for (const segment of segments) this.addParameter(segment.start, segment.end, parent, angles);
		parent.parameterCount = segments.filter(
			(segment) => this.findParameterName(segment.start, segment.end, angles) >= 0,
		).length;
		return parent.parameterCount;
	}

	protected findParameterName(start: number, end: number, angles: AnglePairs): number {
		const equals = this.topLevelValue(start, end, "=", angles);
		let last = this.previousSignificant(equals < 0 ? end : equals, start);
		while (last >= start && this.value(last) === "]") last = this.previousSignificant(last, start);
		return last;
	}

	private addParameter(start: number, end: number, parent: RawDeclaration, angles: AnglePairs): void {
		const nameIndex = this.findParameterName(start, end, angles);
		const name = this.token(nameIndex);
		if (!isIdentifier(name)) return;
		const first = this.token(this.nextSignificant(start, end));
		const last = this.token(this.previousSignificant(end, start));
		if (first === undefined || last === undefined) return;
		this.ignoredOffsets.add(name.startOffset);
		const parameter = this.addDeclaration({
			kind: "variable",
			languageKind: "parameter",
			name: name.value,
			parent,
			startToken: first,
			endToken: last,
			selectionStart: name,
			selectionEnd: name,
			codeStart: first,
			visibility: "local",
			exported: false,
			nameTokenOffsets: [name.startOffset],
		});
		const typeSpan = this.spanBeforeName(this.afterAttributeSections(start, nameIndex), nameIndex);
		this.recordTypeSpan(typeSpan, parameter);
	}
}
