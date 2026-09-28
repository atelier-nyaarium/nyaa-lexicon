import { type OffsetRange, SourceCursor } from "@nyaa-lexicon/protocol";
import { isUppercase } from "./characters.js";
import type { DeclarationInput } from "./declarations.js";
import { isSymbolIn } from "./delimiters.js";
import type { RawDeclaration } from "./model.js";
import { isKeyword, isNameToken, isValueToken, type RustToken } from "./tokens.js";
import { TypePaths } from "./typePaths.js";

////////////////////////////////
//  Constants

export const STATEMENT_END = new Set([";"]);

const BRACE = new Set(["{"]);

const LET_BOUNDARY = new Set(["=", ":", ";"]);

const LOOP_BOUNDARY = new Set(["in", ";"]);

/** A `let` after one of these is a condition. */
const CONDITION_WORDS = ["if", "while", "&&"];

const CONDITION_END = new Set(["{", "&&", "||", ";"]);

/** A name before one of these, in a pattern, binds nothing. */
const PATTERN_NAME_ENDS = new Set(["::", "(", "{", "!", ":"]);

const RANGE_SYMBOLS = new Set(["..", "..=", "..."]);

/** Arm bodies that end at their block, so their comma is optional. */
const BLOCK_LIKE = new Set(["{", "if", "match", "loop", "while", "for", "unsafe"]);

////////////////////////////////
//  Classes

/** A body's statements: their patterns, and the locals each binds. */
export abstract class Statements extends TypePaths {
	/** An or-pattern's later sites of a binding, each to that binding, which they write too. */
	protected readonly bindingSites = new Map<number, string>();

	////////////////////////////////
	//  Bodies

	/** An item or `use` a statement declared is visible in the block holding it. */
	protected confineToBlock(index: number, owner: RawDeclaration, declared: number, imported: number): void {
		let open = this.enclosing[index] ?? -1;
		while (open >= 0 && !isValueToken(this.tokens[open], "{")) open = this.enclosing[open] ?? -1;
		const close = open >= 0 ? this.matchingIndex(open) : -1;
		if (close < 0) return;
		const block = this.scopeOf(open, close);
		const ownerId = owner.declaration.symbolId;
		for (const raw of this.rawDeclarations.slice(declared))
			if (raw.declaration.containerId === ownerId) raw.block = block;
		for (const binding of this.importBindings.slice(imported))
			if (binding.containerId === ownerId) binding.block = block;
	}

	/** A statement's first token, in no macro invocation's arguments. */
	protected startsStatement(index: number, bodyStart: number): boolean {
		const previous = this.tokens[index - 1];
		const boundary =
			index === bodyStart ||
			this.attributeTokens.has(index - 1) ||
			isValueToken(previous, ";") ||
			isValueToken(previous, "{") ||
			isValueToken(previous, "}");
		if (!boundary) return false;
		for (let open = this.enclosing[index] ?? -1; open >= bodyStart; open = this.enclosing[open] ?? -1) {
			if (isValueToken(this.tokens[open - 1], "!") && this.tokens[open - 2]?.kind === "identifier") return false;
		}
		return true;
	}

	/** Declares what the token at `index` binds; the next token to read. */
	protected bodyToken(index: number, end: number, owner: RawDeclaration): number {
		const token = this.tokens[index] as RustToken;
		if (isValueToken(token, "let")) return this.parseLet(index, end, owner);
		if (isValueToken(token, "for") && !isValueToken(this.tokens[index + 1], "<"))
			return this.parseForLoop(index, end, owner);
		if (isValueToken(token, "match")) this.parseMatch(index, end, owner);
		const close = this.brackets.closures.get(index);
		if (close !== undefined && close < end) {
			this.parseClosure(index, close, end, owner);
			return close + 1;
		}
		return index + 1;
	}

	/** Binding sites in a pattern: never a path segment, constructor, field label or range bound. */
	protected patternNames(start: number, end: number, refutable: boolean): number[] {
		const names: number[] = [];
		let angles = 0;
		for (let index = start; index < end; index++) {
			angles = Math.max(0, angles + this.angleDeltaAt(index));
			const token = this.tokens[index];
			if (angles > 0 || !isNameToken(token) || isKeyword(token) || token.value === "_") continue;
			const previous = this.tokens[index - 1];
			const next = index + 1 < end ? this.tokens[index + 1] : undefined;
			if (isValueToken(previous, "::") || isValueToken(previous, ".")) continue;
			if (isSymbolIn(next, PATTERN_NAME_ENDS) || isSymbolIn(previous, RANGE_SYMBOLS)) continue;
			if (isSymbolIn(next, RANGE_SYMBOLS)) continue;
			// A constant or unit constructor, by convention.
			if (refutable && !isValueToken(next, "@") && isUppercase(new SourceCursor(token.value).peek())) continue;
			names.push(index);
		}
		return names;
	}

	/** One local per name; an or-pattern's later sites of it bind it again. */
	private declareLocals(
		names: readonly number[],
		owner: RawDeclaration,
		languageKind: string,
		scope: OffsetRange,
		shape: (
			nameIndex: number,
		) => Pick<DeclarationInput, "end" | "signature" | "typeDisplay" | "typeName" | "valueType" | "initializer">,
	): RawDeclaration[] {
		const context = this.within(owner, "function");
		const declared = new Map<string, RawDeclaration>();
		for (const nameIndex of names) {
			const name = this.tokens[nameIndex] as RustToken;
			const first = declared.get(name.value);
			if (first !== undefined) {
				this.bindingSites.set(nameIndex, first.declaration.symbolId);
				continue;
			}
			declared.set(
				name.value,
				this.addRawDeclaration({
					nameIndex,
					start: name,
					context,
					descriptor: { kind: "term", name: name.value },
					kind: "variable",
					languageKind,
					visibility: "local",
					exported: false,
					local: true,
					scope,
					...shape(nameIndex),
				}),
			);
		}
		return [...declared.values()];
	}

	private scopeOf(first: number, last: number): OffsetRange {
		return {
			start: (this.tokens[first] as RustToken).startOffset,
			end: (this.tokens[last] as RustToken).endOffset,
		};
	}

	/** A `let` statement or condition; reading continues past its pattern, so its initializer is read too. */
	private parseLet(index: number, end: number, owner: RawDeclaration): number {
		const condition = CONDITION_WORDS.some((word) => isValueToken(this.tokens[index - 1], word));
		const block = this.blockEnd(index, end);
		const boundary = this.topLevelStop(index + 1, block, LET_BOUNDARY);
		const colon = !condition && isValueToken(this.tokens[boundary], ":") ? boundary : -1;
		const patternEnd = colon >= 0 ? colon : boundary;
		let equal: number;
		let initializerEnd: number;
		let scope: OffsetRange;
		let refutable = condition;
		if (condition) {
			equal = isValueToken(this.tokens[boundary], "=") ? boundary : -1;
			initializerEnd = equal >= 0 ? this.topLevelStop(equal + 1, block, CONDITION_END) : -1;
			const body = this.topLevelStop(Math.max(equal, index) + 1, block, BRACE);
			const bodyEnd = body < block ? this.matchingIndex(body) : -1;
			scope = this.scopeOf(
				Math.min(initializerEnd >= 0 ? initializerEnd : patternEnd, block - 1),
				bodyEnd >= 0 ? bodyEnd : block - 1,
			);
		} else {
			const statement = this.statementEnd(index, block);
			equal = this.topLevelToken(patternEnd, statement, "=");
			const elseIndex = equal >= 0 ? this.letElse(equal + 1, statement) : -1;
			refutable = elseIndex >= 0;
			initializerEnd = equal >= 0 ? (elseIndex >= 0 ? elseIndex : statement) : -1;
			scope = this.scopeOf(statement, Math.max(statement, block - 1));
		}
		const names = this.patternNames(index + 1, patternEnd, refutable);
		const typeEnd = colon >= 0 ? (equal >= 0 ? equal : this.statementEnd(index, block)) : -1;
		const typeDisplay = colon >= 0 ? this.textOfTokens(colon + 1, typeEnd) : undefined;
		const typeName = colon >= 0 ? this.simpleTypeName(colon + 1, typeEnd) : undefined;
		// An annotation outranks the literal.
		const initializer = colon < 0 && equal >= 0 ? this.literalInitializer(equal + 1, initializerEnd) : undefined;
		// Siblings share only `let`, so each header stays its own size.
		const single = new Set(names.map((nameIndex) => (this.tokens[nameIndex] as RustToken).value)).size === 1;
		const shared = single ? this.letHeader(index, patternEnd, end, condition) : undefined;
		const lastIndex = (initializerEnd >= 0 ? initializerEnd : patternEnd) - 1;
		const built = colon < 0 && equal >= 0 && !refutable ? this.builtPath(equal + 1, initializerEnd) : undefined;
		const declared = this.declareLocals(names, owner, "let", scope, (nameIndex) => {
			const plain = this.plainBinding(index + 1, nameIndex, patternEnd);
			return {
				end: this.tokens[Math.max(nameIndex, lastIndex)] as RustToken,
				signature: shared ?? this.headers.renderAfter(index, this.bindingStart(nameIndex), nameIndex + 1),
				typeDisplay: initializer?.display ?? typeDisplay,
				typeName: initializer === undefined ? typeName : undefined,
				valueType: !plain ? undefined : colon >= 0 ? this.valueType(colon + 1, typeEnd) : built?.literal,
				initializer: plain ? built?.call : undefined,
			};
		});
		if (initializer !== undefined)
			for (const raw of declared)
				this.typeAnswers.set(raw.declaration.symbolId, {
					status: "inferred",
					display: initializer.display,
					basis: initializer.basis,
				});
		return Math.max(index + 1, patternEnd);
	}

	/** A `let` to its `;`, or to its block when it is a condition. */
	private letHeader(letIndex: number, patternEnd: number, end: number, condition: boolean): string | undefined {
		if (condition && isValueToken(this.tokens[patternEnd], "=")) {
			return this.headers.render(letIndex, this.headers.stop(patternEnd + 1, end, CONDITION_END), patternEnd + 1);
		}
		const stop = this.headers.stop(patternEnd, end, STATEMENT_END);
		const equal = this.topLevelToken(patternEnd, stop, "=");
		return this.headers.render(letIndex, stop, equal >= 0 ? equal + 1 : undefined);
	}

	/** The `else` of a let-else in an initializer, or -1; an `if` chain's own `else`s are passed. */
	private letElse(start: number, end: number): number {
		let index = start;
		let guard = -1;
		while (index < end) {
			if (index <= guard) throw new Error("let-else scan failed to advance");
			guard = index;
			const token = this.tokens[index];
			if (isValueToken(token, "else")) return index;
			index = isValueToken(token, "if") ? this.pastIf(index, end) : this.past(index);
		}
		return -1;
	}

	/** Past `if .. { } else if .. { } else { }`. */
	private pastIf(index: number, end: number): number {
		let at = index;
		let guard = -1;
		while (at < end) {
			if (at <= guard) throw new Error("if chain scan failed to advance");
			guard = at;
			const brace = this.topLevelStop(at + 1, end, BRACE);
			const close = brace < end ? this.matchingIndex(brace) : -1;
			if (close < 0) return end;
			if (!isValueToken(this.tokens[close + 1], "else")) return close + 1;
			if (isValueToken(this.tokens[close + 2], "if")) {
				at = close + 2;
				continue;
			}
			const last = isValueToken(this.tokens[close + 2], "{") ? this.matchingIndex(close + 2) : -1;
			return last >= 0 ? last + 1 : close + 1;
		}
		return end;
	}

	/** Whether a pattern is one binding alone, its `ref` and `mut` aside. */
	protected plainBinding(start: number, nameIndex: number, end: number): boolean {
		return this.bindingStart(nameIndex) === start && nameIndex + 1 === end;
	}

	/** A pattern binding's own `ref` and `mut`, then its name. */
	private bindingStart(nameIndex: number): number {
		let start = nameIndex;
		while (
			(isValueToken(this.tokens[start - 1], "mut") || isValueToken(this.tokens[start - 1], "ref")) &&
			!isValueToken(this.tokens[start - 2], "&")
		)
			start--;
		return start;
	}

	/** `for PAT in EXPR { .. }`: the bindings live in the loop body. */
	private parseForLoop(index: number, end: number, owner: RawDeclaration): number {
		const block = this.blockEnd(index, end);
		const inIndex = this.topLevelStop(index + 1, block, LOOP_BOUNDARY);
		if (!isValueToken(this.tokens[inIndex], "in")) return index + 1;
		const body = this.topLevelStop(inIndex + 1, block, BRACE);
		const bodyEnd = body < block ? this.matchingIndex(body) : -1;
		if (bodyEnd < 0) return inIndex;
		const names = this.patternNames(index + 1, inIndex, false);
		this.declareLocals(names, owner, "forBinding", this.scopeOf(body, bodyEnd), (nameIndex) => ({
			end: this.tokens[nameIndex] as RustToken,
		}));
		return inIndex;
	}

	/** Each arm's bindings, scoped to that arm. */
	private parseMatch(index: number, end: number, owner: RawDeclaration): void {
		const block = this.blockEnd(index, end);
		const open = this.topLevelStop(index + 1, block, BRACE);
		const close = open < block ? this.matchingIndex(open) : -1;
		if (close < 0) return;
		let armStart = open + 1;
		let guard = -1;
		while (armStart < close) {
			if (armStart <= guard) throw new Error("match arm parser failed to advance");
			guard = armStart;
			const first = this.skipAttributes(armStart, close);
			const arrow = this.topLevelToken(first, close, "=>");
			if (arrow < 0) return;
			const armGuard = this.topLevelToken(first, arrow, "if");
			const armEnd = this.armEnd(arrow, close);
			const names = this.patternNames(first, armGuard >= 0 ? armGuard : arrow, true);
			this.declareLocals(names, owner, "matchBinding", this.scopeOf(first, armEnd), (nameIndex) => ({
				end: this.tokens[nameIndex] as RustToken,
			}));
			armStart = isValueToken(this.tokens[armEnd + 1], ",") ? armEnd + 2 : armEnd + 1;
		}
	}

	/** The last token of an arm's body; a block-like body ends at its block. */
	private armEnd(arrow: number, close: number): number {
		let index = arrow + 1;
		const head = this.tokens[index];
		const labeled = head?.kind === "lifetime" && isValueToken(this.tokens[index + 1], ":");
		if (!labeled && !BLOCK_LIKE.has(head?.raw ?? "")) return this.expressionEnd(index, close);
		let guard = -1;
		while (index < close) {
			if (index <= guard) throw new Error("arm body parser failed to advance");
			guard = index;
			const brace = this.topLevelStop(index, close, BRACE);
			const blockClose = brace < close ? this.matchingIndex(brace) : -1;
			if (blockClose < 0) return this.expressionEnd(arrow + 1, close);
			if (!isValueToken(this.tokens[blockClose + 1], "else")) return blockClose;
			index = blockClose + 2;
		}
		return close - 1;
	}

	/** A closure's parameters, local to its body. */
	private parseClosure(open: number, close: number, end: number, owner: RawDeclaration): void {
		const bodyStart = close + 1;
		const typed = isValueToken(this.tokens[bodyStart], "->");
		const brace = typed ? this.topLevelStop(bodyStart + 1, end, BRACE) : bodyStart;
		const bodyEnd = isValueToken(this.tokens[brace], "{")
			? this.matchingIndex(brace)
			: this.expressionEnd(bodyStart, end);
		const scope = this.scopeOf(open, Math.max(close, bodyEnd));
		for (const [from, to] of this.segments(open + 1, close)) {
			const first = this.skipAttributes(from, to);
			const colon = this.topLevelToken(first, to, ":");
			const patternEnd = colon >= 0 ? colon : to;
			const names = this.patternNames(first, patternEnd, false);
			this.declareLocals(names, owner, "closureParameter", scope, (nameIndex) => ({
				end: this.tokens[Math.max(nameIndex, to - 1)] as RustToken,
				typeDisplay: colon >= 0 ? this.textOfTokens(colon + 1, to) : undefined,
				typeName: colon >= 0 ? this.simpleTypeName(colon + 1, to) : undefined,
				valueType:
					colon >= 0 && this.plainBinding(first, nameIndex, patternEnd)
						? this.valueType(colon + 1, to)
						: undefined,
			}));
		}
	}
}
