// Declarations by recursive descent from each scope: using directives, namespaces, then types and members.

import { defined } from "@nyaa-lexicon/protocol";
import type { CsharpImport, Leading, ModifierInfo, RawDeclaration, Segment } from "./model.js";
import type { CsharpParseContext } from "./parseContext.js";
import { positionRange, type Token } from "./tokens.js";
import { earliest } from "./types.js";
import { isIdentifier, isTrivia, MODIFIERS, RESERVED_WORDS, syntaxValue } from "./words.js";

////////////////////////////////
//  Functions & Helpers

function isTypeDeclarationWord(value: string): boolean {
	return value === "class" || value === "interface" || value === "struct" || value === "enum" || value === "record";
}

function joinTokenValues(tokens: Token[]): string {
	return tokens.map((token) => token.value).join(".");
}

////////////////////////////////
//  Classes

export class CsharpDeclarationParser {
	constructor(private readonly context: CsharpParseContext) {}

	public parseScope(start: number, end: number, parent: RawDeclaration | undefined): void {
		this.context.tokenStream.nested(start, () => this.scopeMembers(start, end, parent));
	}

	private scopeMembers(start: number, end: number, parent: RawDeclaration | undefined): void {
		let index = start;
		let documentationStart: Token | undefined;
		let attributes: number | undefined;
		let lastDocumentationLine = -2;
		while (index < end) {
			const current = this.context.tokenStream.token(index);
			if (current === undefined) return;
			if (current.kind === "doc") {
				if (current.start.line !== lastDocumentationLine + 1) documentationStart = undefined;
				documentationStart ??= current;
				lastDocumentationLine = current.start.line;
				index++;
				continue;
			}
			if (current.kind === "newline") {
				index++;
				continue;
			}
			if (current.kind === "comment" || current.kind === "directive") {
				documentationStart = undefined;
				index++;
				continue;
			}
			if (syntaxValue(current) === "}") return;
			if (syntaxValue(current) === ";") {
				documentationStart = undefined;
				index++;
				continue;
			}
			const section = this.context.attributes.attributeSectionAt(index, end);
			if (section !== undefined) {
				if (section.close < 0) return;
				if (section.attached) attributes ??= section.open;
				index = section.close + 1;
				continue;
			}
			const leadingStart = earliest(
				documentationStart,
				attributes === undefined ? undefined : this.context.tokenStream.token(attributes),
			);
			const parsed = this.parseAt(
				index,
				end,
				parent,
				leadingStart === undefined ? undefined : { start: leadingStart, attributes },
			);
			if (parsed <= index) {
				if (parent === undefined) this.context.recorder.markSkippedFileScope();
				index = this.skipUnknown(index, end);
			} else {
				index = parsed;
			}
			documentationStart = undefined;
			attributes = undefined;
			lastDocumentationLine = -2;
		}
	}

	private modifiersAt(index: number, end: number): ModifierInfo {
		const start = index;
		const modifiers = new Set<string>();
		let current = this.context.tokenStream.nextSignificant(index, end);
		while (current >= 0 && current < end) {
			const item = this.context.tokenStream.token(current);
			if (!isIdentifier(item) || !MODIFIERS.has(syntaxValue(item) as string)) break;
			modifiers.add(item.value);
			current = this.context.tokenStream.nextSignificant(current + 1, end);
		}
		return { index: current < 0 ? end : current, start, modifiers };
	}

	private parseAt(
		index: number,
		end: number,
		parent: RawDeclaration | undefined,
		leading: Leading | undefined,
	): number {
		const first = this.context.tokenStream.nextSignificant(index, end);
		if (first < 0) return end;
		const item = this.context.tokenStream.token(first);
		if (item === undefined) return end;
		const afterGlobal =
			syntaxValue(item) === "global" ? this.context.tokenStream.nextSignificant(first + 1, end) : -1;
		if (this.context.tokenStream.value(afterGlobal) === "using")
			return this.parseUsing(afterGlobal, item, end, true, parent);
		if (syntaxValue(item) === "using") return this.parseUsing(first, item, end, false, parent);
		if (syntaxValue(item) === "namespace") return this.parseNamespace(first, first, end, parent, leading);
		const modifiers = this.modifiersAt(first, end);
		const keyword = this.context.tokenStream.value(modifiers.index);
		if (keyword === "namespace") return this.parseNamespace(modifiers.index, modifiers.start, end, parent, leading);
		if (keyword !== undefined && isTypeDeclarationWord(keyword)) {
			return this.context.types.parseType(
				modifiers.index,
				modifiers.start,
				end,
				parent,
				leading,
				modifiers.modifiers,
			);
		}
		if (keyword === "delegate")
			return this.context.types.parseDelegate(
				modifiers.index,
				modifiers.start,
				end,
				parent,
				leading,
				modifiers.modifiers,
			);
		if (parent?.kind === "class" || parent?.kind === "struct" || parent?.kind === "interface") {
			const extension =
				keyword === "extension" && modifiers.index === first
					? this.context.types.parseExtension(first, end, parent, leading)
					: -1;
			return extension >= 0
				? extension
				: this.context.members.parseMember(first, modifiers, end, parent, leading);
		}
		return -1;
	}

	private parseUsing(
		index: number,
		opener: Token,
		end: number,
		global: boolean,
		scope: RawDeclaration | undefined,
	): number {
		const usingToken = this.context.tokenStream.token(index);
		if (usingToken === undefined) return -1;
		let current = this.context.tokenStream.nextSignificant(index + 1, end);
		let isStatic = false;
		if (this.context.tokenStream.value(current) === "static") {
			isStatic = true;
			current = this.context.tokenStream.nextSignificant(current + 1, end);
		}
		const statementEnd = this.context.tokenStream.findSemicolon(current, end);
		if (statementEnd < 0) {
			this.context.tokenStream.report("Using directive has no terminating semicolon.", usingToken);
			return end;
		}
		const significant: number[] = [];
		for (let cursor = current; cursor < statementEnd; cursor++) {
			if (!isTrivia(this.context.tokenStream.token(cursor))) significant.push(cursor);
		}
		if (significant.length === 0) return statementEnd + 1;
		let aliasIndex = -1;
		for (const candidate of significant) {
			if (this.context.tokenStream.value(candidate) === "=") {
				aliasIndex = candidate;
				break;
			}
		}
		const target = this.usingTarget(aliasIndex < 0 ? current : aliasIndex + 1, statementEnd);
		// The alias and the target's names are no references; its type arguments are type uses.
		for (const candidate of significant) {
			const item = this.context.tokenStream.token(candidate);
			if (item?.kind !== "identifier") continue;
			if (target.lists.some(([open, close]) => candidate > open && candidate < close)) continue;
			this.context.recorder.ignore(item.startOffset);
		}
		for (const [open, close] of target.lists)
			this.context.recorder.addTypeReference(open + 1, close - 1, "typeUse");
		const names = target.names;
		// An alias of a tuple, pointer or predefined type names nothing to import.
		if (names.length === 0) {
			if (aliasIndex < 0) this.context.tokenStream.report("Using directive has no namespace.", usingToken);
			return statementEnd + 1;
		}
		const specifier = joinTokenValues(names);
		const firstName = names[0] as Token;
		const lastName = names[names.length - 1] as Token;
		const aliasToken = aliasIndex < 0 ? undefined : this.context.tokenStream.token(significant[0] as number);
		const directive: CsharpImport = {
			specifier,
			...(aliasToken?.kind === "identifier"
				? { alias: aliasToken.value, aliasRange: positionRange(aliasToken) }
				: {}),
			static: isStatic,
			global,
			target: target.segments,
			...defined({ qualifier: target.qualifier }),
			span: { start: opener.start, end: this.context.tokenStream.token(statementEnd)?.end ?? lastName.end },
			specifierToken: firstName,
			nameToken: lastName,
		};
		this.context.recorder.addImport(directive, scope);
		return statementEnd + 1;
	}

	/**
	 * A using directive's target from `start`: its names, the alias of a `::` opening it aside, each
	 * with the type arguments it takes, and where those argument lists stand.
	 */
	private usingTarget(
		start: number,
		end: number,
	): { names: Token[]; segments: Segment[]; qualifier: string | undefined; lists: [number, number][] } {
		const target = {
			names: [] as Token[],
			segments: [] as Segment[],
			qualifier: undefined as string | undefined,
			lists: [] as [number, number][],
		};
		let current = this.context.tokenStream.nextSignificant(start, end);
		const joint = this.context.tokenStream.nextSignificant(current + 1, end);
		const alias = this.context.tokenStream.token(current);
		if (isIdentifier(alias) && this.context.tokenStream.value(joint) === "::") {
			target.qualifier = alias.value;
			current = this.context.tokenStream.nextSignificant(joint + 1, end);
		}
		while (current >= 0 && current < end) {
			const token = this.context.tokenStream.token(current);
			if (!isIdentifier(token) || RESERVED_WORDS.has(this.context.tokenStream.value(current) ?? "")) break;
			let next = this.context.tokenStream.nextSignificant(current + 1, end);
			const close =
				this.context.tokenStream.value(next) === "<" ? this.context.typeReader.listClose(next, end) : -1;
			const arity =
				close < 0
					? 0
					: this.context.typeReader.commaSegments(
							next + 1,
							close,
							this.context.typeReader.typeAngles(next + 1, close),
						).length;
			if (close >= 0) {
				target.lists.push([next, close]);
				next = this.context.tokenStream.nextSignificant(close + 1, end);
			}
			target.names.push(token);
			target.segments.push({ name: token.value, arity });
			if (this.context.tokenStream.value(next) !== "." && this.context.tokenStream.value(next) !== "::") break;
			current = this.context.tokenStream.nextSignificant(next + 1, end);
		}
		return target;
	}

	private parseNamespace(
		keywordIndex: number,
		codeStartIndex: number,
		end: number,
		parent: RawDeclaration | undefined,
		leading: Leading | undefined,
	): number {
		const keyword = this.context.tokenStream.token(keywordIndex);
		if (keyword === undefined) return -1;
		const names: Token[] = [];
		let current = this.context.tokenStream.nextSignificant(keywordIndex + 1, end);
		while (current >= 0 && current < end) {
			const item = this.context.tokenStream.token(current);
			if (item?.kind === "identifier") {
				names.push(item);
				current = this.context.tokenStream.nextSignificant(current + 1, end);
				if (this.context.tokenStream.value(current) === ".") {
					current = this.context.tokenStream.nextSignificant(current + 1, end);
					continue;
				}
				break;
			}
			break;
		}
		if (names.length === 0) {
			this.context.tokenStream.report("Namespace declaration needs a name.", keyword);
			return -1;
		}
		const namespaceName = joinTokenValues(names);
		const parentNamespace = this.context.recorder.namespaceName(parent);
		const fullName = parentNamespace === "" ? namespaceName : `${parentNamespace}.${namespaceName}`;
		const next = this.context.tokenStream.nextSignificant(current, end);
		const nameStart = names[0] as Token;
		const nameEnd = names[names.length - 1] as Token;
		for (const item of names) this.context.recorder.ignore(item.startOffset);
		if (this.context.tokenStream.value(next) === ";") {
			const namespace = this.context.recorder.addDeclaration({
				kind: "namespace",
				languageKind: "fileScopedNamespace",
				name: namespaceName,
				parent,
				startToken: leading?.start ?? this.context.tokenStream.token(codeStartIndex) ?? keyword,
				endToken: this.context.tokenStream.tokens[this.context.tokenStream.tokens.length - 1] as Token,
				selectionStart: nameStart,
				selectionEnd: nameEnd,
				codeStart: this.context.tokenStream.token(codeStartIndex) ?? keyword,
				visibility: "public",
				exported: true,
				signature: this.context.typeReader.header(codeStartIndex, next),
				memberInsertLine: this.context.tokenStream.lineAfterLast(next, end),
				nameTokenOffsets: names.map((item) => item.startOffset),
			});
			this.context.recorder.markNamespaceName(fullName);
			this.parseScope(next + 1, end, namespace);
			return end;
		}
		if (this.context.tokenStream.value(next) !== "{") {
			this.context.tokenStream.report(
				"Namespace declaration needs a body or semicolon.",
				this.context.tokenStream.token(next) ?? keyword,
			);
			return -1;
		}
		const close = this.context.tokenStream.matching(next, "{", "}", end);
		if (close < 0)
			this.context.tokenStream.report("Namespace body is not closed.", this.context.tokenStream.token(next));
		const bodyEnd = close < 0 ? end : close;
		const namespace = this.context.recorder.addDeclaration({
			kind: "namespace",
			languageKind: "blockNamespace",
			name: namespaceName,
			parent,
			startToken: leading?.start ?? this.context.tokenStream.token(codeStartIndex) ?? keyword,
			endToken: this.context.tokenStream.token(close >= 0 ? close : bodyEnd - 1) ?? keyword,
			selectionStart: nameStart,
			selectionEnd: nameEnd,
			codeStart: this.context.tokenStream.token(codeStartIndex) ?? keyword,
			visibility: "public",
			exported: true,
			signature: this.context.typeReader.header(codeStartIndex, next),
			memberInsertLine: this.context.tokenStream.closerLine(close),
			nameTokenOffsets: names.map((item) => item.startOffset),
		});
		this.context.recorder.markNamespaceName(fullName);
		this.parseScope(next + 1, bodyEnd, namespace);
		return close < 0 ? end : close + 1;
	}

	private skipUnknown(start: number, end: number): number {
		const first = this.context.tokenStream.nextSignificant(start, end);
		if (first < 0) return end;
		const boundary = this.context.members.findMemberBoundary(first, end);
		if (boundary === undefined) return Math.min(end, first + 1);
		return this.context.members.advanceBoundary(boundary, end);
	}
}
