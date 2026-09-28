// Running bodies by statement: locals, local functions, and what patterns, `out`, deconstruction,
// lambdas and queries declare, each scoped where the language makes it visible.

import { CsharpExpressionReader } from "./expressions.js";
import type { Declared, LocalHead } from "./locals.js";
import type { Declarator, RawDeclaration, Scope } from "./model.js";
import type { Token } from "./tokens.js";
import { isIdentifier } from "./words.js";

////////////////////////////////
//  Constants

/** Take a parenthesized header. */
const HEADED_STATEMENTS: ReadonlySet<string> = new Set([
	"fixed",
	"for",
	"foreach",
	"if",
	"lock",
	"switch",
	"using",
	"while",
]);

////////////////////////////////
//  Classes

export abstract class CsharpStatementParser extends CsharpExpressionReader {
	protected parseBody(start: number, end: number, owner: RawDeclaration): void {
		this.statements(start, end, owner, { from: start - 1, to: end });
	}

	protected parseExpressionBody(start: number, end: number, owner: RawDeclaration): void {
		this.scanExpression(start, end, owner, { from: start, to: end });
	}

	protected statements(start: number, end: number, owner: RawDeclaration, scope: Scope): void {
		let current = this.nextSignificant(start, end);
		while (current >= 0 && current < end) {
			const past = this.statement(current, end, owner, scope);
			current = this.nextSignificant(Math.max(past, current + 1), end);
		}
	}

	/** One statement at a significant `index`; answers the index past it. */
	private statement(index: number, end: number, owner: RawDeclaration, scope: Scope): number {
		return this.nested(index, () => this.readStatement(index, end, owner, scope));
	}

	private readStatement(index: number, end: number, owner: RawDeclaration, scope: Scope): number {
		const value = this.value(index) ?? "";
		const next = this.nextSignificant(index + 1, end);
		const nextValue = this.value(next);
		if (HEADED_STATEMENTS.has(value) && nextValue === "(") return this.headed(index, next, end, owner, scope);
		switch (value) {
			case "{":
				return this.block(index, end, owner);
			case ";":
				return index + 1;
			case "do":
				return this.doWhile(index, end, owner, scope);
			case "else":
				return this.embedded(index + 1, end, owner);
			case "try":
			case "finally":
				return nextValue === "{" ? this.block(next, end, owner) : index + 1;
			case "checked":
			case "unchecked":
			case "unsafe":
				if (nextValue === "{") return this.block(next, end, owner);
				break;
			case "catch":
				return this.catchClause(index, end, owner);
			case "case":
				return this.caseLabel(index, end, owner, scope);
			case "default":
				if (nextValue === ":") return next + 1;
				break;
			case "await":
				if (
					nextValue === "foreach" ||
					(nextValue === "using" && this.value(this.nextSignificant(next + 1, end)) === "(")
				)
					return this.statement(next, end, owner, scope);
				break;
			case "[": {
				const head = this.localHead(this.bracketedSectionsEnd(index, end), end);
				const declared = head === undefined ? -1 : this.localFunction(head, index, end, owner, scope);
				if (declared >= 0) return declared;
				break;
			}
		}
		// A label.
		if (isIdentifier(this.token(index)) && nextValue === ":") {
			const at = this.nextSignificant(next + 1, end);
			return at < 0 ? end : this.statement(at, end, owner, scope);
		}
		const declared = this.declarationStatement(index, end, owner, scope);
		return declared >= 0 ? declared : this.expressionStatement(index, end, owner, scope);
	}

	/** A statement under `if`, `else` or a loop header, scoped to itself. */
	private embedded(from: number, end: number, owner: RawDeclaration): number {
		const at = this.nextSignificant(from, end);
		if (at < 0) return end;
		const scope: Scope = { from: at, to: end };
		const past = this.statement(at, end, owner, scope);
		scope.to = this.lastBefore(past, at);
		return past;
	}

	private block(open: number, end: number, owner: RawDeclaration): number {
		const close = this.matching(open, "{", "}", end);
		const stop = close < 0 ? end : close;
		this.statements(open + 1, stop, owner, { from: open, to: stop });
		return close < 0 ? end : close + 1;
	}

	private expressionStatement(index: number, end: number, owner: RawDeclaration, scope: Scope): number {
		const semicolon = this.findSemicolon(index, end);
		this.scanExpression(index, semicolon < 0 ? end : semicolon, owner, scope);
		return semicolon < 0 ? end : semicolon + 1;
	}

	/** `keyword (...) statement`, or a block after `switch`; what the header declares lives in the statement. */
	private headed(keyword: number, open: number, end: number, owner: RawDeclaration, scope: Scope): number {
		const value = this.value(keyword);
		if (value === "if") return this.ifChain(keyword, open, end, owner, scope);
		const close = this.matching(open, "(", ")", end);
		if (close < 0) return this.expressionStatement(keyword, end, owner, scope);
		const own: Scope = { from: keyword, to: end };
		const body: Scope = { from: close + 1, to: end };
		if (value === "for") this.forHeader(open, close, owner, own);
		else if (value === "foreach") this.foreachHeader(open, close, owner, own, body);
		else if ((value !== "using" && value !== "fixed") || !this.resource(open, close, owner, own))
			this.scanExpression(open + 1, close, owner, own);
		let past: number;
		if (value === "switch") {
			const block = this.nextSignificant(close + 1, end);
			past = this.value(block) === "{" ? this.switchBlock(block, end, owner) : close + 1;
		} else {
			past = this.embedded(close + 1, end, owner);
		}
		own.to = this.lastBefore(past, keyword);
		body.to = own.to;
		return past;
	}

	/**
	 * `if ... else if ... else ...`, read as a loop. The first condition's variables live in the
	 * enclosing block; each `else if` condition's, in the rest of the chain.
	 */
	private ifChain(keyword: number, open: number, end: number, owner: RawDeclaration, scope: Scope): number {
		const nested: Scope[] = [];
		let condition = scope;
		let current = keyword;
		let at = open;
		let past = end;
		for (;;) {
			const close = this.matching(at, "(", ")", end);
			if (close < 0) {
				past = this.expressionStatement(current, end, owner, condition);
				break;
			}
			this.scanExpression(at + 1, close, owner, condition);
			past = this.embedded(close + 1, end, owner);
			const alternative = this.nextSignificant(past, end);
			if (this.value(alternative) !== "else") break;
			const next = this.nextSignificant(alternative + 1, end);
			at = this.nextSignificant(next + 1, end);
			if (this.value(next) !== "if" || this.value(at) !== "(") {
				past = this.embedded(alternative + 1, end, owner);
				break;
			}
			condition = { from: next, to: end };
			nested.push(condition);
			current = next;
		}
		for (const item of nested) item.to = this.lastBefore(past, item.from);
		return past;
	}

	/** A switch statement's block: its locals span the block, a case pattern's variables its section. */
	private switchBlock(open: number, end: number, owner: RawDeclaration): number {
		const close = this.matching(open, "{", "}", end);
		const stop = close < 0 ? end : close;
		const block: Scope = { from: open, to: stop };
		let section: Scope = { from: open, to: stop };
		let labelled = false;
		let current = this.nextSignificant(open + 1, stop);
		while (current >= 0 && current < stop) {
			const value = this.value(current);
			const label =
				value === "case" ||
				(value === "default" && this.value(this.nextSignificant(current + 1, stop)) === ":");
			if (label && !labelled) {
				section.to = this.lastBefore(current, section.from);
				section = { from: current, to: stop };
			}
			labelled = label;
			const past = label
				? this.caseLabel(current, stop, owner, section)
				: this.statement(current, stop, owner, block);
			current = this.nextSignificant(Math.max(past, current + 1), stop);
		}
		return close < 0 ? end : close + 1;
	}

	private doWhile(index: number, end: number, owner: RawDeclaration, scope: Scope): number {
		const past = this.embedded(index + 1, end, owner);
		const keyword = this.nextSignificant(past, end);
		if (this.value(keyword) !== "while") return past;
		const open = this.nextSignificant(keyword + 1, end);
		const close = this.value(open) === "(" ? this.matching(open, "(", ")", end) : -1;
		if (close < 0) return keyword + 1;
		this.scanExpression(open + 1, close, owner, scope);
		const semicolon = this.nextSignificant(close + 1, end);
		return this.value(semicolon) === ";" ? semicolon + 1 : close + 1;
	}

	private catchClause(index: number, end: number, owner: RawDeclaration): number {
		const scope: Scope = { from: index, to: end };
		let current = this.nextSignificant(index + 1, end);
		if (this.value(current) === "(") {
			const close = this.matching(current, "(", ")", end);
			if (close < 0) return end;
			this.catchVariable(current + 1, close, owner, scope);
			current = this.nextSignificant(close + 1, end);
		}
		if (this.value(current) === "when") {
			const open = this.nextSignificant(current + 1, end);
			const close = this.value(open) === "(" ? this.matching(open, "(", ")", end) : -1;
			if (close < 0) return end;
			this.scanExpression(open + 1, close, owner, scope);
			current = this.nextSignificant(close + 1, end);
		}
		const past = current < 0 ? end : this.value(current) === "{" ? this.block(current, end, owner) : current;
		scope.to = this.lastBefore(past, index);
		return past;
	}

	/** `Exception e`, or a bare type. */
	private catchVariable(start: number, close: number, owner: RawDeclaration, scope: Scope): void {
		const first = this.nextSignificant(start, close);
		const shape = first < 0 ? undefined : this.typeShape(first, close);
		if (shape === undefined) return;
		const name = this.nextSignificant(shape.end, close);
		if (name < 0) {
			this.addTypeReference(first, shape.end - 1, "typeUse");
			return;
		}
		if (!this.isName(name) || this.nextSignificant(name + 1, close) >= 0) return;
		this.declareLocal(name, first, name, owner, { start: first, end: name }, this.header(first, name + 1), scope);
	}

	/** `case pattern [when condition]:` or `default:` */
	private caseLabel(index: number, end: number, owner: RawDeclaration, scope: Scope): number {
		if (this.value(index) === "default") return this.nextSignificant(index + 1, end) + 1;
		const past = this.readPattern(index + 1, end, owner, scope);
		let colon = this.nextSignificant(past, end);
		if (this.value(colon) === "when") {
			const condition = colon + 1;
			colon = this.findTopLevelValue(condition, end, ":");
			if (colon < 0) return end;
			this.scanExpression(condition, colon, owner, scope);
		} else if (this.value(colon) !== ":") {
			colon = this.findTopLevelValue(past, end, ":");
		}
		return colon < 0 ? end : colon + 1;
	}

	private forHeader(open: number, close: number, owner: RawDeclaration, scope: Scope): void {
		const first = this.findSemicolon(open + 1, close);
		if (first < 0) {
			this.scanExpression(open + 1, close, owner, scope);
			return;
		}
		const head = this.localHead(open + 1, first);
		if (head !== undefined && this.namesLocals(head, first))
			this.declareDeclarators(head, first, first, owner, scope);
		else this.scanExpression(open + 1, first, owner, scope);
		const second = this.findSemicolon(first + 1, close);
		this.scanExpression(first + 1, second < 0 ? close : second, owner, scope);
		if (second >= 0) this.scanExpression(second + 1, close, owner, scope);
	}

	/** The iteration variable lives in `body`, never in the collection it walks. */
	private foreachHeader(open: number, close: number, owner: RawDeclaration, scope: Scope, body: Scope): void {
		const keyword = this.findTopLevelValue(open + 1, close, "in");
		if (keyword < 0) {
			this.scanExpression(open + 1, close, owner, scope);
			return;
		}
		this.iterationVariable(open + 1, keyword, owner, body);
		this.scanExpression(keyword + 1, close, owner, scope);
	}

	/** `T x`, `var (a, b)` or `(T a, var b)` before `in`. */
	private iterationVariable(start: number, limit: number, owner: RawDeclaration, scope: Scope): void {
		const first = this.nextSignificant(start, limit);
		if (first < 0) return;
		const value = this.value(first);
		const next = this.nextSignificant(first + 1, limit);
		if (value === "var" && this.value(next) === "(") {
			for (const name of this.designationNames(next, limit))
				this.declareLocal(
					name,
					first,
					name,
					owner,
					undefined,
					this.header(first, name + 1, this.skipTo(next, name)),
					scope,
				);
			return;
		}
		if (value === "(") {
			const close = this.matching(first, "(", ")", limit);
			if (close >= 0 && this.nextSignificant(close + 1, limit) < 0) {
				this.declareAll(this.tupleDeclarations(first, close), undefined, owner, scope);
				return;
			}
		}
		const head = this.localHead(first, limit);
		if (head === undefined || this.nextSignificant(head.name + 1, limit) >= 0) return;
		const typeSpan = this.isVar(head) ? undefined : { start: head.type, end: head.name };
		this.declareLocal(
			head.name,
			head.first,
			head.name,
			owner,
			typeSpan,
			this.header(head.first, head.name + 1),
			scope,
		);
	}

	/** `using` or `fixed` resources that declare; false when the header is an expression. */
	private resource(open: number, close: number, owner: RawDeclaration, scope: Scope): boolean {
		const head = this.localHead(open + 1, close);
		if (head === undefined || !this.namesLocals(head, close)) return false;
		this.declareDeclarators(head, close, this.previousSignificant(close, open), owner, scope);
		return true;
	}

	/** A local declaration, deconstruction or local function; -1 when none starts here. */
	private declarationStatement(index: number, end: number, owner: RawDeclaration, scope: Scope): number {
		const value = this.value(index);
		const next = this.nextSignificant(index + 1, end);
		if (value === "var" && this.value(next) === "(") return this.deconstruction(index, next, end, owner, scope);
		if (value === "(") {
			const declared = this.deconstruction(index, index, end, owner, scope);
			if (declared >= 0) return declared;
		}
		const head = this.localHead(index, end);
		if (head === undefined) return -1;
		const follower = this.value(this.nextSignificant(head.name + 1, end));
		if (follower === "(" || follower === "<") return this.localFunction(head, undefined, end, owner, scope);
		if (follower !== "=" && follower !== "," && follower !== ";") return -1;
		const semicolon = this.findSemicolon(head.name, end);
		const limit = semicolon < 0 ? end : semicolon;
		this.declareDeclarators(head, limit, semicolon < 0 ? head.name : semicolon, owner, scope);
		return semicolon < 0 ? end : semicolon + 1;
	}

	/** `var (a, b) = x;` from `var`, or `(T a, var b) = x;` from its `(`; -1 when it declares nothing. */
	private deconstruction(first: number, open: number, end: number, owner: RawDeclaration, scope: Scope): number {
		const close = this.matching(open, "(", ")", end);
		if (close < 0) return -1;
		const equals = this.nextSignificant(close + 1, end);
		if (this.value(equals) !== "=") return -1;
		const declared: Declared[] =
			first === open
				? this.tupleDeclarations(open, close)
				: this.designationNames(open, end).map((name) => ({
						first,
						name,
						type: undefined,
						skip: this.skipTo(open, name),
					}));
		if (declared.length === 0) return -1;
		const semicolon = this.findSemicolon(equals + 1, end);
		this.declareAll(declared, semicolon < 0 ? undefined : semicolon, owner, scope);
		this.scanExpression(equals + 1, semicolon < 0 ? end : semicolon, owner, scope);
		return semicolon < 0 ? end : semicolon + 1;
	}

	/** Every declarator from the head's name to `limit`; each spans the head through `last`. */
	private declareDeclarators(
		head: LocalHead,
		limit: number,
		last: number,
		owner: RawDeclaration,
		scope: Scope,
	): void {
		const inferred = this.isVar(head);
		const typeSpan = inferred ? undefined : { start: head.type, end: head.name };
		const type = this.declaredType(typeSpan);
		const declared: Declarator[] = [];
		let name = head.name;
		for (let index = 0; name >= 0 && name < limit && this.isName(name); index++) {
			const equals = this.nextSignificant(name + 1, limit);
			const initialized = this.value(equals) === "=";
			const stop = initialized ? this.expressionEnd(equals + 1, limit) : equals < 0 ? limit : equals;
			const start = index === 0 ? head.first : name;
			const inferredType = !this.outline && inferred ? this.initializerType(stop, name) : undefined;
			const nameToken = this.token(name) as Token;
			const local = this.addDeclaration({
				kind: "variable",
				languageKind: "local",
				name: nameToken.value,
				parent: owner,
				startToken: this.token(head.first) as Token,
				endToken: this.token(last) as Token,
				selectionStart: nameToken,
				selectionEnd: nameToken,
				codeStart: this.token(head.first) as Token,
				visibility: "local",
				exported: false,
				signature: this.header(head.first, stop, index === 0 ? undefined : { from: head.name, to: name }),
				...type,
				...(inferredType === undefined ? {} : { inferredType }),
				scope,
				nameTokenOffsets: [nameToken.startOffset],
			});
			if (index === 0) this.recordTypeSpan(typeSpan, local);
			declared.push({ declaration: local, start, end: this.lastBefore(stop, start) });
			if (initialized) this.scanExpression(equals + 1, stop, owner, scope);
			if (this.value(stop) !== ",") break;
			name = this.nextSignificant(stop + 1, limit);
		}
		this.ownDeclarators(declared);
	}

	/** `[attributes] [modifiers] T Name<U>(...) [where ...] { ... }` or `=> ...;`; -1 when not one. */
	private localFunction(
		head: LocalHead,
		attributes: number | undefined,
		end: number,
		owner: RawDeclaration,
		scope: Scope,
	): number {
		let open = this.nextSignificant(head.name + 1, end);
		const typeParameters = this.value(open) === "<" ? open : -1;
		const typeParametersClose = typeParameters < 0 ? -1 : this.listClose(typeParameters, end);
		if (typeParameters >= 0) {
			if (typeParametersClose < 0) return -1;
			open = this.nextSignificant(typeParametersClose + 1, end);
		}
		if (this.value(open) !== "(") return -1;
		const close = this.matching(open, "(", ")", end);
		if (close < 0) return -1;
		let body = this.nextSignificant(close + 1, end);
		if (this.value(body) === "where") {
			while (body >= 0 && this.value(body) !== "{" && this.value(body) !== "=>" && this.value(body) !== ";") {
				const closer = this.value(body) === "(" ? this.matching(body, "(", ")", end) : body;
				if (closer < 0) return -1;
				body = this.nextSignificant(closer + 1, end);
			}
		}
		const block = this.value(body) === "{";
		if (!block && this.value(body) !== "=>") return -1;
		const last = block ? this.matching(body, "{", "}", end) : this.findSemicolon(body + 1, end);
		if (last < 0) return -1;
		const nameToken = this.token(head.name) as Token;
		const first = attributes ?? head.first;
		const local = this.addDeclaration({
			kind: "function",
			languageKind: "localFunction",
			name: nameToken.value,
			parent: owner,
			startToken: this.token(first) as Token,
			endToken: this.token(last) as Token,
			selectionStart: nameToken,
			selectionEnd: nameToken,
			codeStart: this.token(head.first) as Token,
			visibility: "local",
			exported: false,
			signature: this.header(first, body),
			bodyStartToken: block ? this.token(body) : undefined,
			bodyEndToken: block ? this.token(last) : undefined,
			isStatic: head.modifiers.has("static"),
			scope,
			nameTokenOffsets: [nameToken.startOffset],
		});
		this.recordTypeSpan(this.spanBeforeName(head.type, head.name), local);
		if (typeParameters >= 0) this.markTypeParameters(typeParameters, typeParametersClose, local);
		local.parameterCount = this.parseParameters(open, close, local);
		if (!this.outline) this.parseTypeConstraints(close + 1, body);
		if (block) this.statements(body + 1, last, local, { from: body, to: last });
		else this.scanExpression(body + 1, last, local, { from: body, to: last });
		return last + 1;
	}
}
