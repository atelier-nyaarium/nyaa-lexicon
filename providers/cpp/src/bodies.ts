// Function bodies by recursive descent: blocks, conditions, loops, handlers and lambdas, each
// declaring locals visible to the end of the statement or block that holds them.

import { bracketDelta } from "./angles.js";
import { CppDeclarationParser } from "./declarations.js";
import type { TokenSpan } from "./header.js";
import type { DraftRecord, Scope } from "./model.js";
import type { Token } from "./tokens.js";
import { isSignificant } from "./tokens.js";
import { matching, significantAfter, significantBefore, statementEnd, tokenAt } from "./tokenWalk.js";
import { draftTypeFor, unknownTemplateType } from "./typeText.js";
import { CLASS_KEYS, isNameToken } from "./words.js";

////////////////////////////////
//  Constants

/** Words a lambda may follow; after any other name a `[` is a subscript. */
const LAMBDA_AFTER_WORDS: ReadonlySet<string> = new Set([
	"return",
	"co_return",
	"co_yield",
	"co_await",
	"throw",
	"case",
	"else",
	"do",
	"and",
	"or",
	"not",
]);

/** A head declaration's visible end until the statement after it is read. */
const PENDING = -1;

/** What follows a lambda's captures. */
const LAMBDA_HEADS: ReadonlySet<string> = new Set([
	"(",
	"{",
	"mutable",
	"constexpr",
	"consteval",
	"noexcept",
	"->",
	"[",
	"requires",
	"static",
]);

////////////////////////////////
//  Classes

export class CppBodyParser extends CppDeclarationParser {
	/** A function body between its braces. Every local, a lambda's included, belongs to `owner`. */
	protected parseBody(start: number, close: number, owner: DraftRecord, templateDependent: boolean): void {
		this.walkStatements(start, close, {
			parent: owner,
			kind: "function",
			defaultVisibility: "local",
			templateDependent,
			blockEnd: close,
		});
	}

	/** The statements of one block, `[start, limit)`. */
	private walkStatements(start: number, limit: number, scope: Scope): void {
		if (!this.enterNesting(start)) return;
		let index = start;
		let guard = -1;
		while (index < limit) {
			if (index <= guard) throw new Error("statement walk failed to advance");
			guard = index;
			index = this.walkStatement(index, limit, scope);
		}
		this.nesting--;
	}

	/** One statement from `index`, by its first word; the index past it. */
	private walkStatement(index: number, limit: number, scope: Scope): number {
		const first = this.codeFrom(index, limit);
		if (first >= limit) return limit;
		const token = tokenAt(this.tokens, first) as Token;
		const value = token.text;
		if (value === ";") return first + 1;
		if (value === "{") return this.walkBlock(first, limit, scope);
		if (token.kind === "identifier") {
			if (value === "if") return this.walkIf(first, limit, scope);
			if (value === "for") return this.walkFor(first, limit, scope);
			if (value === "while" || value === "switch") return this.walkLoop(first, limit, scope);
			if (value === "do") return this.walkDo(first, limit, scope);
			if (value === "try") return this.walkHandlers(this.walkStatement(first + 1, limit, scope), limit, scope);
			if (value === "catch") return this.walkHandlers(first, limit, scope);
			if (value === "else") return this.walkStatement(first + 1, limit, scope);
			if (value === "using" || value === "typedef" || CLASS_KEYS.has(value)) {
				const end = this.parseLocalDeclaration(first, limit, scope);
				if (end !== null) return end;
			}
			if (value === "case" || value === "default") {
				const colon = this.topLevelStop(first, limit, (stop) => stop === ":" || stop === ";");
				return Math.min(limit, colon + 1);
			}
			const next = significantAfter(this.tokens, first, limit);
			if (isNameToken(token) && tokenAt(this.tokens, next)?.text === ":") return next + 1;
		}
		const { end, block } = this.localStatementEnd(first, limit);
		if (block >= 0) {
			this.parseVariableRange(first, block, scope);
			this.walkLambdas(first, block, scope);
			return this.walkBlock(block, limit, scope);
		}
		this.parseVariableRange(first, end + 1, scope);
		this.walkLambdas(first, end, scope);
		return end + 1;
	}

	/** The first code token from `index`, past blank tokens and directive lines; `limit` when none. */
	private codeFrom(index: number, limit: number): number {
		let current = index;
		while (current < limit) {
			const token = tokenAt(this.tokens, current);
			if (token === undefined) return limit;
			if (token.text === "#") current = this.nextLine(current);
			else if (!isSignificant(token)) current++;
			else return current;
		}
		return limit;
	}

	/** A block from its `{`; its declarations are visible to its `}`. */
	private walkBlock(open: number, limit: number, scope: Scope): number {
		const close = matching(this.tokens, open, "{", "}", limit);
		const end = close < 0 ? limit : close;
		this.walkStatements(open + 1, end, { ...scope, blockEnd: end });
		return close < 0 ? limit : close + 1;
	}

	/**
	 * Declares what `declare` reads, in source order ahead of the statement `walk` reads, and makes it
	 * visible to that statement's end.
	 */
	private declaringThrough(scope: Scope, declare: (head: Scope) => void, walk: () => number): number {
		const from = this.drafts.length;
		declare({ ...scope, blockEnd: PENDING });
		const declared = this.drafts.slice(from);
		const end = walk();
		for (const draft of declared) if (draft.visibleEnd === PENDING) draft.visibleEnd = end;
		return end;
	}

	/** `if`, `else if` and `else` as one chain; a condition's declarations are visible to its end. */
	private walkIf(first: number, limit: number, scope: Scope): number {
		const from = this.drafts.length;
		const pending = { ...scope, blockEnd: PENDING };
		let keyword = first;
		let end = first + 1;
		let guard = -1;
		for (;;) {
			if (keyword <= guard) throw new Error("if chain walk failed to advance");
			guard = keyword;
			let open = significantAfter(this.tokens, keyword, limit);
			while (["constexpr", "consteval", "!"].includes(tokenAt(this.tokens, open)?.text ?? ""))
				open = significantAfter(this.tokens, open, limit);
			const close = tokenAt(this.tokens, open)?.text === "(" ? matching(this.tokens, open, "(", ")", limit) : -1;
			if (close >= 0) this.walkCondition(open, close, pending);
			end = this.walkStatement(close >= 0 ? close + 1 : open < 0 ? limit : open, limit, scope);
			const next = this.codeFrom(end, limit);
			if (tokenAt(this.tokens, next)?.text !== "else") break;
			const branch = significantAfter(this.tokens, next, limit);
			if (tokenAt(this.tokens, branch)?.text !== "if") {
				end = this.walkStatement(next + 1, limit, scope);
				break;
			}
			keyword = branch;
		}
		for (const draft of this.drafts.slice(from)) if (draft.visibleEnd === PENDING) draft.visibleEnd = end;
		return end;
	}

	/** `while` or `switch`: a condition, then the statement it governs. */
	private walkLoop(first: number, limit: number, scope: Scope): number {
		const open = significantAfter(this.tokens, first, limit);
		const close = tokenAt(this.tokens, open)?.text === "(" ? matching(this.tokens, open, "(", ")", limit) : -1;
		if (close < 0) return first + 1;
		return this.declaringThrough(
			scope,
			(head) => this.walkCondition(open, close, head),
			() => this.walkStatement(close + 1, limit, scope),
		);
	}

	/** `do` statement `while (...);`. */
	private walkDo(first: number, limit: number, scope: Scope): number {
		const body = this.walkStatement(first + 1, limit, scope);
		const loop = this.codeFrom(body, limit);
		if (tokenAt(this.tokens, loop)?.text !== "while") return body;
		const end = statementEnd(this.tokens, loop, limit);
		this.walkLambdas(loop, end, scope);
		return end + 1;
	}

	/** `for`, counted or ranged; what its head declares is visible through its body. */
	private walkFor(first: number, limit: number, scope: Scope): number {
		const open = significantAfter(this.tokens, first, limit);
		const close = tokenAt(this.tokens, open)?.text === "(" ? matching(this.tokens, open, "(", ")", limit) : -1;
		if (close < 0) return first + 1;
		const declareHead = (head: Scope) => {
			const semicolon = this.topLevelStop(open, close, (stop) => stop === ";");
			if (semicolon < close) {
				this.parseVariableRange(open + 1, semicolon + 1, head);
				const second = this.topLevelStop(semicolon, close, (stop) => stop === ";");
				this.parseConditionDeclaration(semicolon + 1, second, head);
			} else {
				const colon = this.topLevelStop(open, close, (stop) => stop === ":");
				if (colon < close) this.parseVariableRange(open + 1, colon, head, undefined, true);
			}
			this.walkLambdas(open + 1, close, head);
		};
		return this.declaringThrough(scope, declareHead, () => this.walkStatement(close + 1, limit, scope));
	}

	/** A parenthesized condition: an optional init-statement, then a condition that may declare. */
	private walkCondition(open: number, close: number, scope: Scope): void {
		const semicolon = this.topLevelStop(open, close, (stop) => stop === ";");
		if (semicolon < close) {
			this.parseVariableRange(open + 1, semicolon + 1, scope);
			this.parseConditionDeclaration(semicolon + 1, close, scope);
		} else this.parseConditionDeclaration(open + 1, close, scope);
		this.walkLambdas(open + 1, close, scope);
	}

	/** A condition declares only with an initializer, so `a && b` stays an expression. */
	private parseConditionDeclaration(start: number, end: number, scope: Scope): void {
		if (this.topLevelStop(start - 1, end, (stop) => stop === "=" || stop === "{") < end)
			this.parseVariableRange(start, end, scope);
	}

	/** `catch` handlers from `index`; each one's parameter is visible in its block. */
	protected walkHandlers(index: number, limit: number, scope: Scope): number {
		let end = index;
		for (let handler = this.codeFrom(end, limit); tokenAt(this.tokens, handler)?.text === "catch"; ) {
			const open = significantAfter(this.tokens, handler, limit);
			const close = tokenAt(this.tokens, open)?.text === "(" ? matching(this.tokens, open, "(", ")", limit) : -1;
			if (close < 0) return handler + 1;
			end = this.declaringThrough(
				scope,
				(head) => this.parseVariableRange(open + 1, close, head, undefined, true),
				() => this.walkStatement(close + 1, limit, scope),
			);
			handler = this.codeFrom(end, limit);
		}
		return end;
	}

	/**
	 * Where an expression or declaration statement ends: its `;`, or the `{` of a block after it when
	 * a macro stands for the statement's head, as `SECTION("name") { ... }`. A brace list inside the
	 * statement, an initializer or a lambda's body, is followed by more of it.
	 */
	private localStatementEnd(first: number, limit: number): { end: number; block: number } {
		let depth = 0;
		for (let index = first; index < limit; index++) {
			if (this.directiveTokens.has(index)) continue;
			const value = tokenAt(this.tokens, index)?.text;
			if (value === "(" || value === "[") depth++;
			else if (value === ")" || value === "]") depth = Math.max(0, depth - 1);
			if (depth > 0) continue;
			if (value === ";" || value === "}") return { end: index, block: -1 };
			if (value !== "{") continue;
			const close = matching(this.tokens, index, "{", "}", limit);
			if (close < 0) return { end: limit - 1, block: -1 };
			const after = tokenAt(this.tokens, this.codeAfter(close, limit));
			if (after?.kind === "punctuation" && after.text !== "{" && after.text !== "}") index = close;
			else return { end: index, block: index };
		}
		return { end: limit - 1, block: -1 };
	}

	/** Every lambda in `[start, end)`: its captures and parameters as locals, its body as a block. */
	protected walkLambdas(start: number, end: number, scope: Scope): void {
		for (let index = start; index < end; index++) {
			if (tokenAt(this.tokens, index)?.text !== "[" || !this.opensLambda(index, end)) continue;
			index = this.walkLambda(index, end, scope) - 1;
		}
	}

	/** A `[` introducing a lambda: not a subscript, not an attribute, and a lambda's parts after it. */
	private opensLambda(open: number, limit: number): boolean {
		if (tokenAt(this.tokens, significantAfter(this.tokens, open, limit))?.text === "[") return false;
		const before = tokenAt(this.tokens, significantBefore(this.tokens, open));
		if (before !== undefined) {
			if (before.kind === "number" || before.kind === "string" || before.kind === "character") return false;
			if (before.kind === "identifier" && !LAMBDA_AFTER_WORDS.has(before.value)) return false;
			if (before.text === ")" || before.text === "]" || bracketDelta(before, this.angles) < 0) return false;
		}
		const close = matching(this.tokens, open, "[", "]", limit);
		if (close < 0) return false;
		const after = tokenAt(this.tokens, significantAfter(this.tokens, close, limit));
		return after !== undefined && (LAMBDA_HEADS.has(after.text) || bracketDelta(after, this.angles) > 0);
	}

	/** A lambda from its `[`; the index past its body, or past the `]` when it has none. */
	private walkLambda(open: number, limit: number, scope: Scope): number {
		const close = matching(this.tokens, open, "[", "]", limit);
		let index = significantAfter(this.tokens, close, limit);
		if (bracketDelta(tokenAt(this.tokens, index), this.angles) > 0) {
			const templateClose = this.angleClose(index, limit);
			if (templateClose < 0) return close + 1;
			index = significantAfter(this.tokens, templateClose, limit);
		}
		let parameters: TokenSpan | null = null;
		if (tokenAt(this.tokens, index)?.text === "(") {
			const parametersClose = matching(this.tokens, index, "(", ")", limit);
			if (parametersClose < 0) return close + 1;
			parameters = { start: index, end: parametersClose };
			index = significantAfter(this.tokens, parametersClose, limit);
		}
		const body = index < 0 ? -1 : this.topLevelStop(index - 1, limit, (stop) => stop === "{" || stop === ";");
		const bodyClose = tokenAt(this.tokens, body)?.text === "{" ? matching(this.tokens, body, "{", "}", limit) : -1;
		if (bodyClose < 0) return close + 1;
		const arrow = this.topLevelStop(index - 1, body, (stop) => stop === "->");
		if (arrow < body) this.trailingReturnArrows.add(arrow);
		const inner: Scope = { ...scope, blockEnd: bodyClose };
		this.addCaptures(open, close, body, inner);
		if (parameters !== null) this.parseParameters(parameters.start + 1, parameters.end, inner.parent, inner);
		this.walkStatements(body + 1, bodyClose, inner);
		return bodyClose + 1;
	}

	/** A lambda's init-captures, `[total = 0, &ref = x]`, each a local its body sees, not an initializer. */
	private addCaptures(open: number, close: number, body: number, scope: Scope): void {
		for (const segment of this.declaratorSegments(open + 1, close)) {
			const tokens = this.significantIndexes(segment.start, segment.end);
			let at = 0;
			while (["&", "..."].includes(tokenAt(this.tokens, tokens[at] ?? -1)?.text ?? "")) at++;
			const nameIndex = tokens[at];
			const after = tokens[at + 1];
			const initializer = tokenAt(this.tokens, after ?? -1)?.text ?? "";
			if (nameIndex === undefined || after === undefined || !isNameToken(tokenAt(this.tokens, nameIndex)))
				continue;
			if (initializer !== "=" && initializer !== "{" && initializer !== "(") continue;
			const name = tokenAt(this.tokens, nameIndex)?.value ?? "capture";
			const start = tokens[0] as number;
			const end = (tokens.at(-1) as number) + 1;
			this.addDraft({
				parent: scope.parent,
				own: { kind: "term", name },
				kind: "variable",
				name,
				visibility: "local",
				languageKind: "capture",
				exported: false,
				startIndex: start,
				endIndex: end,
				nameStartIndex: nameIndex,
				nameEndIndex: nameIndex + 1,
				signature: this.header(start, end, "value"),
				metrics: this.metrics.of(start, end),
				type:
					scope.templateDependent &&
					this.dependentType(this.significantIndexes(after, end), this.templateNamesIn(scope.parent))
						? unknownTemplateType("template-dependent variable type is not resolved")
						: draftTypeFor("auto", this.tokens, initializer === "=" ? after + 1 : end, end),
				templateDependent: scope.templateDependent,
				parameterNames: new Set(),
				...this.visibleScope(scope),
				visibleFrom: body,
			});
		}
	}
}
