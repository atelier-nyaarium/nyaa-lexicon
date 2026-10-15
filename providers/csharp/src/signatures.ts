// A C# signature's parts: type parameters, `where` constraints and parameters.

import type { AnglePairs, RawDeclaration } from "./model.js";
import type { CsharpParseContext } from "./parseContext.js";
import { CONSTRAINT_KEYWORDS, isIdentifier, syntaxValue } from "./words.js";

////////////////////////////////
//  Classes

export class CsharpSignatureReader {
	constructor(private readonly context: CsharpParseContext) {}

	public markTypeParameters(start: number, close: number, parent: RawDeclaration): void {
		if (start < 0 || close < 0) return;
		let current = this.context.tokenStream.nextSignificant(start + 1, close);
		while (current >= 0 && current < close) {
			const section = this.context.attributes.attributeSectionAt(current, close);
			if (section !== undefined) {
				current = section.close < 0 ? -1 : this.context.tokenStream.nextSignificant(section.close + 1, close);
				continue;
			}
			const item = this.context.tokenStream.token(current);
			if (isIdentifier(item) && syntaxValue(item) !== "in" && syntaxValue(item) !== "out") {
				this.context.recorder.ignore(item.startOffset);
				this.context.recorder.addDeclaration({
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
			current = this.context.tokenStream.nextSignificant(current + 1, close);
			if (this.context.tokenStream.value(current) === ",")
				current = this.context.tokenStream.nextSignificant(current + 1, close);
		}
	}

	/** A `where` clause's constrained parameter and its bounds are a type use. */
	public parseTypeConstraints(
		start: number,
		end: number,
		angles: AnglePairs = this.context.typeReader.typeAngles(start, end),
	): void {
		let clauseStart = this.context.typeReader.topLevelValue(start, end, "where", angles);
		while (clauseStart >= 0 && clauseStart < end) {
			const nameIndex = this.context.tokenStream.nextSignificant(clauseStart + 1, end);
			const colon = nameIndex < 0 ? -1 : this.context.tokenStream.nextSignificant(nameIndex + 1, end);
			if (colon < 0) return;
			const nextWhere = this.context.typeReader.topLevelValue(colon + 1, end, "where", angles);
			const clauseEnd = nextWhere < 0 ? end : nextWhere;
			if (
				this.context.tokenStream.value(colon) === ":" &&
				isIdentifier(this.context.tokenStream.token(nameIndex))
			) {
				this.context.recorder.addTypeReference(nameIndex, nameIndex, "typeUse");
				this.markConstraintSegments(colon + 1, clauseEnd, angles);
			}
			clauseStart = nextWhere;
		}
	}

	private markConstraintSegments(start: number, end: number, angles: AnglePairs): void {
		for (const segment of this.context.typeReader.commaSegments(start, end, angles)) {
			if (
				this.context.tokenStream.nextSignificant(segment.start, segment.end) >= 0 &&
				!this.isConstraintKeyword(segment.start, segment.end)
			)
				this.context.recorder.addTypeReference(segment.start, segment.end - 1, "typeUse");
		}
	}

	/** A bare constraint keyword names no type. */
	private isConstraintKeyword(start: number, end: number): boolean {
		const first = this.context.tokenStream.nextSignificant(start, end);
		const token = this.context.tokenStream.token(first);
		if (token === undefined || !CONSTRAINT_KEYWORDS.has(this.context.tokenStream.value(first) ?? "")) return false;
		const next = this.context.tokenStream.nextSignificant(first + 1, end);
		const bareWord = next < 0;
		const newCall = this.context.tokenStream.value(first) === "new" && this.context.tokenStream.value(next) === "(";
		if (!bareWord && !newCall) return false;
		this.context.recorder.ignore(token.startOffset);
		return true;
	}

	public parseParameters(open: number, close: number, parent: RawDeclaration): number {
		if (open < 0 || close < 0 || close <= open) return 0;
		const angles = this.context.typeReader.typeAngles(open + 1, close);
		const segments = this.context.typeReader.commaSegments(open + 1, close, angles);
		for (const segment of segments) this.addParameter(segment.start, segment.end, parent, angles);
		parent.parameterCount = segments.filter(
			(segment) => this.findParameterName(segment.start, segment.end, angles) >= 0,
		).length;
		return parent.parameterCount;
	}

	public findParameterName(start: number, end: number, angles: AnglePairs): number {
		const equals = this.context.typeReader.topLevelValue(start, end, "=", angles);
		let last = this.context.tokenStream.previousSignificant(equals < 0 ? end : equals, start);
		while (last >= start && this.context.tokenStream.value(last) === "]")
			last = this.context.tokenStream.previousSignificant(last, start);
		return last;
	}

	private addParameter(start: number, end: number, parent: RawDeclaration, angles: AnglePairs): void {
		const nameIndex = this.findParameterName(start, end, angles);
		const name = this.context.tokenStream.token(nameIndex);
		if (!isIdentifier(name)) return;
		const first = this.context.tokenStream.token(this.context.tokenStream.nextSignificant(start, end));
		const last = this.context.tokenStream.token(this.context.tokenStream.previousSignificant(end, start));
		if (first === undefined || last === undefined) return;
		this.context.recorder.ignore(name.startOffset);
		const parameter = this.context.recorder.addDeclaration({
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
		const typeSpan = this.context.typeReader.spanBeforeName(
			this.context.attributes.afterAttributeSections(start, nameIndex),
			nameIndex,
		);
		this.context.recorder.recordTypeSpan(typeSpan, parameter);
	}
}
