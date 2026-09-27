// Python's syntax grammar, per the reference manual's "Full Grammar specification", by recursive
// descent over the tokenizer's tokens. Nodes, fields and positions follow CPython's `ast`.

import { isTooDeep, MAX_NESTING, NestingGauge, SourceCursor, TOO_DEEP } from "@nyaa-lexicon/protocol";
import type * as A from "./ast.js";
import { deeperThan } from "./ast.js";
import { decodeBody, numberValue, shapeOf, stringValue } from "./strings.js";
import { type LexError, type Token, tokenize } from "./tokenizer.js";

////////////////////////////////
//  Interfaces & Types

export interface ParseError {
	message: string;
	pos: number;
}

export interface Parsed {
	/** Every token, comments and line breaks included, up to any lexing error. */
	tokens: Token[];
	lexError?: LexError;
	module?: A.Module;
	error?: ParseError;
}

/** Text an interpolated string holds, before adjacent runs merge. */
interface Piece {
	value: string;
	pos: number;
	end: number;
}

////////////////////////////////
//  Constants

const LAYOUT: ReadonlySet<Token["type"]> = new Set(["NEWLINE", "INDENT", "DEDENT", "ENDMARKER"]);

const KEYWORDS: ReadonlySet<string> = new Set([
	"False",
	"None",
	"True",
	"and",
	"as",
	"assert",
	"async",
	"await",
	"break",
	"class",
	"continue",
	"def",
	"del",
	"elif",
	"else",
	"except",
	"finally",
	"for",
	"from",
	"global",
	"if",
	"import",
	"in",
	"is",
	"lambda",
	"nonlocal",
	"not",
	"or",
	"pass",
	"raise",
	"return",
	"try",
	"while",
	"with",
	"yield",
]);

const AUGMENTED: ReadonlyMap<string, A.Operator> = new Map([
	["+=", "Add"],
	["-=", "Sub"],
	["*=", "Mult"],
	["@=", "MatMult"],
	["/=", "Div"],
	["%=", "Mod"],
	["&=", "BitAnd"],
	["|=", "BitOr"],
	["^=", "BitXor"],
	["<<=", "LShift"],
	[">>=", "RShift"],
	["**=", "Pow"],
	["//=", "FloorDiv"],
]);

const COMPARISONS: ReadonlyMap<string, A.ComparisonOperator> = new Map([
	["==", "Eq"],
	["!=", "NotEq"],
	["<", "Lt"],
	["<=", "LtE"],
	[">", "Gt"],
	[">=", "GtE"],
]);

/** Binary levels, loosest first. */
const LEVELS: ReadonlyArray<ReadonlyMap<string, A.Operator>> = [
	new Map([["|", "BitOr"]]),
	new Map([["^", "BitXor"]]),
	new Map([["&", "BitAnd"]]),
	new Map([
		["<<", "LShift"],
		[">>", "RShift"],
	]),
	new Map([
		["+", "Add"],
		["-", "Sub"],
	]),
	new Map([
		["*", "Mult"],
		["/", "Div"],
		["//", "FloorDiv"],
		["%", "Mod"],
		["@", "MatMult"],
	]),
];

const CONVERSIONS: ReadonlyMap<string, number> = new Map([
	["s", 115],
	["r", 114],
	["a", 97],
]);

////////////////////////////////
//  Functions & Helpers

/** `keyword.iskeyword`: a hard keyword, never a soft one. */
export function isKeyword(word: string): boolean {
	return KEYWORDS.has(word);
}

/** `# type: ...`: the text after the prefix. */
function typeCommentBody(comment: string): string | undefined {
	let at = 1;
	const blank = (): void => {
		while (comment[at] === " " || comment[at] === "\t") at++;
	};
	blank();
	if (!comment.startsWith("type:", at)) return undefined;
	at += "type:".length;
	blank();
	return comment.slice(at);
}

/** `type: ignore` ends there or at an ASCII character no name holds. */
function isTypeIgnore(body: string): boolean {
	const after = body.charAt("ignore".length);
	return body.startsWith("ignore") && (after === "" || (after.charCodeAt(0) < 0x80 && !/^[A-Za-z0-9]$/.test(after)));
}

/** `# type: ...`: the text after the prefix, unless it is a `type: ignore`. */
export function typeCommentText(comment: string): string | undefined {
	const body = typeCommentBody(comment);
	return body === undefined || isTypeIgnore(body) ? undefined : body;
}

/** A `# type: ignore` comment's tag, the text after `ignore`. */
export function typeIgnoreTag(comment: string): string | undefined {
	const body = typeCommentBody(comment);
	return body !== undefined && isTypeIgnore(body) ? body.slice("ignore".length) : undefined;
}

////////////////////////////////
//  Classes

class Failure extends Error {
	constructor(readonly error: ParseError) {
		super(error.message);
	}
}

class Parser {
	private readonly tokens: Token[] = [];
	/** Each grammar token's index among all tokens, for the comments beside it. */
	private readonly rawIndex: number[] = [];
	private index = 0;
	private readonly gauge = new NestingGauge();

	constructor(
		private readonly all: readonly Token[],
		private readonly text: string,
	) {
		for (let raw = 0; raw < all.length; raw++) {
			const token = all[raw] as Token;
			if (token.type === "NL" || token.type === "COMMENT") continue;
			this.tokens.push(token);
			this.rawIndex.push(raw);
		}
	}

	module(): A.Module {
		const body: A.Statement[] = [];
		let guard = -1;
		while (!this.atType("ENDMARKER")) {
			if (this.index <= guard) throw new Error("python statement parse failed to advance");
			guard = this.index;
			body.push(...this.statement());
		}
		const typeIgnores: A.TypeIgnore[] = [];
		for (const token of this.all) {
			if (token.type !== "COMMENT") continue;
			const tag = typeIgnoreTag(token.string);
			if (tag !== undefined) typeIgnores.push({ type: "TypeIgnore", pos: token.pos, end: token.end, tag });
		}
		return { type: "Module", pos: 0, end: this.text.length, body, typeIgnores };
	}

	/** `eval` mode: expressions, a tuple when a comma joins them. */
	evaluation(): A.Expression {
		const pos = this.peek().pos;
		let body = this.expression();
		if (this.at(",")) {
			const elts = [body];
			while (this.accept(",")) {
				if (!this.startsExpression() || this.at("*") || this.at("**")) break;
				elts.push(this.expression());
			}
			body = { type: "Tuple", pos, end: this.lastEnd, elts, ctx: "Load" };
		}
		this.finish();
		return body;
	}

	/** `func_type` mode: `(argument types) -> return type`, `*` and `**` types listed plain. */
	functionType(): A.FunctionType {
		this.expect("(");
		const argtypes: A.Expression[] = [];
		let starred = false;
		let guard = -1;
		while (!this.at(")")) {
			if (this.index <= guard) throw new Error("python type list parse failed to advance");
			guard = this.index;
			if (this.accept("**")) {
				argtypes.push(this.expression());
				break;
			}
			if (!starred && this.accept("*")) {
				starred = true;
				argtypes.push(this.expression());
				if (!this.accept(",")) break;
				if (!this.at("**")) this.fail("invalid syntax");
				continue;
			}
			argtypes.push(this.expression());
			if (!this.accept(",")) break;
			if (this.at(")")) this.fail("invalid syntax");
		}
		this.expect(")");
		this.expect("->");
		const returns = this.expression();
		this.finish();
		return { argtypes, returns };
	}

	private finish(): void {
		while (this.atType("NEWLINE")) this.next();
		this.expectType("ENDMARKER");
	}

	////////////////////////////////
	//  Tokens

	private peek(ahead = 0): Token {
		return (this.tokens[this.index + ahead] ?? this.tokens[this.tokens.length - 1]) as Token;
	}

	private previous(): Token {
		return (this.tokens[this.index - 1] ?? this.tokens[0]) as Token;
	}

	private get lastEnd(): number {
		return this.previous().end;
	}

	private next(): Token {
		const token = this.peek();
		if (this.index < this.tokens.length - 1) this.index++;
		return token;
	}

	private atType(type: Token["type"]): boolean {
		return this.peek().type === type;
	}

	/** An operator, or a keyword spelled as a name. */
	private at(text: string, ahead = 0): boolean {
		const token = this.peek(ahead);
		return (token.type === "OP" || token.type === "NAME") && token.string === text;
	}

	private accept(text: string): Token | undefined {
		return this.at(text) ? this.next() : undefined;
	}

	private expect(text: string): Token {
		if (!this.at(text)) this.fail(`expected '${text}'`);
		return this.next();
	}

	private expectType(type: Token["type"]): Token {
		if (!this.atType(type)) this.fail(type === "NEWLINE" ? "invalid syntax" : `expected ${type}`);
		return this.next();
	}

	/** A name that is no keyword. */
	private atName(ahead = 0): boolean {
		const token = this.peek(ahead);
		return token.type === "NAME" && !KEYWORDS.has(token.string);
	}

	private expectName(): Token {
		if (!this.atName()) this.fail("invalid syntax");
		return this.next();
	}

	private fail(message: string, pos = this.peek().pos): never {
		throw new Failure({ message, pos });
	}

	private nested<T>(read: () => T): T {
		try {
			this.gauge.open();
		} catch (error) {
			if (isTooDeep(error)) this.fail(TOO_DEEP);
			throw error;
		}
		try {
			return read();
		} finally {
			this.gauge.close();
		}
	}

	/** The type comment standing right after the token before the cursor, when one does. */
	private typeCommentAfterPrevious(): string | undefined {
		return this.typeCommentTokenAfterPrevious()?.text;
	}

	private typeCommentTokenAfterPrevious(): { text: string; end: number } | undefined {
		const raw = this.rawIndex[this.index - 1];
		if (raw === undefined) return undefined;
		const comment = this.all[raw + 1];
		if (comment?.type !== "COMMENT") return undefined;
		const text = typeCommentText(comment.string);
		return text === undefined ? undefined : { text, end: comment.end };
	}

	////////////////////////////////
	//  Statements

	private statement(): A.Statement[] {
		const compound = this.compoundStatement();
		return compound === undefined ? this.simpleStatements() : [compound];
	}

	private simpleStatements(): A.Statement[] {
		const statements = [this.simpleStatement()];
		let guard = -1;
		while (this.accept(";")) {
			if (this.index <= guard) throw new Error("python simple statement parse failed to advance");
			guard = this.index;
			if (this.atType("NEWLINE")) break;
			statements.push(this.simpleStatement());
		}
		this.expectType("NEWLINE");
		return statements;
	}

	private block(): A.Statement[] {
		return this.nested(() => {
			if (!this.atType("NEWLINE")) return this.simpleStatements();
			this.next();
			if (!this.atType("INDENT")) this.fail("expected an indented block");
			this.next();
			const body: A.Statement[] = [];
			let guard = -1;
			while (!this.atType("DEDENT") && !this.atType("ENDMARKER")) {
				if (this.index <= guard) throw new Error("python block parse failed to advance");
				guard = this.index;
				body.push(...this.statement());
			}
			this.expectType("DEDENT");
			return body;
		});
	}

	private compoundStatement(): A.Statement | undefined {
		const token = this.peek();
		if (token.type === "OP" && token.string === "@") return this.decorated();
		if (token.type !== "NAME") return undefined;
		switch (token.string) {
			case "def":
				return this.functionDef([]);
			case "class":
				return this.classDef([]);
			case "if":
				return this.ifStatement();
			case "while":
				return this.whileStatement();
			case "for":
				return this.forStatement();
			case "with":
				return this.withStatement();
			case "try":
				return this.tryStatement();
			case "async":
				if (this.at("def", 1)) return this.functionDef([]);
				if (this.at("for", 1)) return this.forStatement();
				if (this.at("with", 1)) return this.withStatement();
				return undefined;
			case "match":
				return this.matchStatement();
			default:
				return undefined;
		}
	}

	private decorated(): A.Statement {
		const decorators: A.Expression[] = [];
		let guard = -1;
		while (this.accept("@")) {
			if (this.index <= guard) throw new Error("python decorator parse failed to advance");
			guard = this.index;
			decorators.push(this.namedExpression());
			this.expectType("NEWLINE");
		}
		if (this.at("class")) return this.classDef(decorators);
		if (this.at("def") || (this.at("async") && this.at("def", 1))) return this.functionDef(decorators);
		this.fail("invalid syntax");
	}

	private functionDef(decoratorList: A.Expression[]): A.FunctionDef {
		const pos = this.peek().pos;
		const isAsync = this.accept("async") !== undefined;
		this.expect("def");
		const name = this.expectName().string;
		const typeParams = this.at("[") ? this.typeParams() : [];
		this.expect("(");
		const args = this.parameters(")", true);
		this.expect(")");
		const returns = this.accept("->") ? this.expression() : undefined;
		this.expect(":");
		const typeComment = this.functionTypeComment();
		const body = this.block();
		return {
			type: isAsync ? "AsyncFunctionDef" : "FunctionDef",
			pos,
			end: this.endOf(body),
			name,
			args,
			body,
			decoratorList,
			returns,
			typeComment,
			typeParams,
		};
	}

	/** On the `def` line after its colon, or alone on the body's first line. */
	private functionTypeComment(): string | undefined {
		const onLine = this.typeCommentAfterPrevious();
		if (onLine !== undefined) return onLine;
		if (!this.atType("NEWLINE") || this.peek(1).type !== "INDENT") return undefined;
		const newline = this.rawIndex[this.index] as number;
		const comment = this.all[newline + 1];
		if (comment?.type !== "COMMENT" || this.all[newline + 2]?.type !== "NL") return undefined;
		return typeCommentText(comment.string);
	}

	/** A block ends at its last token past layout, a trailing `;` included. */
	private endOf(statements: readonly A.Span[]): number {
		let index = this.index - 1;
		while (index > 0 && LAYOUT.has((this.tokens[index] as Token).type)) index--;
		return Math.max((statements[statements.length - 1] as A.Span).end, (this.tokens[index] as Token).end);
	}

	private classDef(decoratorList: A.Expression[]): A.ClassDef {
		const pos = this.expect("class").pos;
		const name = this.expectName().string;
		const typeParams = this.at("[") ? this.typeParams() : [];
		let bases: A.Expression[] = [];
		let keywords: A.Keyword[] = [];
		if (this.accept("(")) {
			({ args: bases, keywords } = this.callArguments());
			this.expect(")");
		}
		this.expect(":");
		const body = this.block();
		return { type: "ClassDef", pos, end: this.endOf(body), name, bases, keywords, body, decoratorList, typeParams };
	}

	private typeParams(): A.TypeParam[] {
		this.expect("[");
		const params: A.TypeParam[] = [];
		let guard = -1;
		while (!this.at("]")) {
			if (this.index <= guard) throw new Error("python type parameter parse failed to advance");
			guard = this.index;
			const pos = this.peek().pos;
			const kind = this.accept("**") ? "ParamSpec" : this.accept("*") ? "TypeVarTuple" : "TypeVar";
			const name = this.expectName().string;
			const bound = kind === "TypeVar" && this.accept(":") ? this.expression() : undefined;
			const defaultValue = this.accept("=")
				? kind === "TypeVarTuple"
					? this.starExpression()
					: this.expression()
				: undefined;
			params.push({ type: kind, pos, end: this.lastEnd, name, bound, defaultValue });
			if (!this.accept(",")) break;
		}
		this.expect("]");
		if (params.length === 0) this.fail("type parameter list cannot be empty");
		return params;
	}

	/** An `if` and its `elif` chain, read in a loop and nested from the last clause out. */
	private ifStatement(): A.If {
		const clauses: Array<{ pos: number; test: A.Expression; body: A.Statement[] }> = [];
		let guard = -1;
		do {
			if (this.index <= guard) throw new Error("python elif chain failed to advance");
			guard = this.index;
			const pos = this.next().pos;
			const test = this.namedExpression();
			this.expect(":");
			clauses.push({ pos, test, body: this.block() });
		} while (this.at("elif"));
		let orelse = this.elseBlock();
		let node: A.If | undefined;
		for (let index = clauses.length - 1; index >= 0; index--) {
			const { pos, test, body } = clauses[index] as (typeof clauses)[number];
			node = { type: "If", pos, end: this.endOf(orelse.length > 0 ? orelse : body), test, body, orelse };
			orelse = [node];
		}
		return node as A.If;
	}

	private elseBlock(): A.Statement[] {
		if (!this.accept("else")) return [];
		this.expect(":");
		return this.block();
	}

	private whileStatement(): A.While {
		const pos = this.expect("while").pos;
		const test = this.namedExpression();
		this.expect(":");
		const body = this.block();
		const orelse = this.elseBlock();
		return { type: "While", pos, end: this.endOf(orelse.length > 0 ? orelse : body), test, body, orelse };
	}

	private forStatement(): A.For {
		const pos = this.peek().pos;
		const isAsync = this.accept("async") !== undefined;
		this.expect("for");
		const target = this.targets("Store");
		this.expect("in");
		const iter = this.starExpressions();
		this.expect(":");
		const typeComment = this.typeCommentAfterPrevious();
		const body = this.block();
		const orelse = this.elseBlock();
		return {
			type: isAsync ? "AsyncFor" : "For",
			pos,
			end: this.endOf(orelse.length > 0 ? orelse : body),
			target,
			iter,
			body,
			orelse,
			typeComment,
		};
	}

	private withStatement(): A.With {
		const pos = this.peek().pos;
		const isAsync = this.accept("async") !== undefined;
		this.expect("with");
		const items = this.parenthesizedWithItems() ?? this.withItems();
		this.expect(":");
		const typeComment = this.typeCommentAfterPrevious();
		const body = this.block();
		return { type: isAsync ? "AsyncWith" : "With", pos, end: this.endOf(body), items, body, typeComment };
	}

	/** `with (a as b, c):`, when the parentheses hold the items rather than one expression. */
	private parenthesizedWithItems(): A.WithItem[] | undefined {
		if (!this.at("(")) return undefined;
		const mark = this.index;
		try {
			this.next();
			const items: A.WithItem[] = [];
			let guard = -1;
			while (!this.at(")")) {
				if (this.index <= guard) throw new Error("python with item parse failed to advance");
				guard = this.index;
				items.push(this.withItem());
				if (!this.accept(",")) break;
			}
			if (items.length > 0 && this.accept(")") && this.at(":")) return items;
		} catch (error) {
			if (!(error instanceof Failure)) throw error;
		}
		this.index = mark;
		return undefined;
	}

	private withItems(): A.WithItem[] {
		const items = [this.withItem()];
		let guard = -1;
		while (this.accept(",")) {
			if (this.index <= guard) throw new Error("python with item parse failed to advance");
			guard = this.index;
			items.push(this.withItem());
		}
		return items;
	}

	private withItem(): A.WithItem {
		const contextExpr = this.expression();
		const optionalVars = this.accept("as") ? this.target("Store") : undefined;
		return { type: "withitem", pos: contextExpr.pos, end: this.lastEnd, contextExpr, optionalVars };
	}

	private tryStatement(): A.Try {
		const pos = this.expect("try").pos;
		this.expect(":");
		const body = this.block();
		const handlers: A.ExceptHandler[] = [];
		let star = false;
		let guard = -1;
		while (this.at("except")) {
			if (this.index <= guard) throw new Error("python except parse failed to advance");
			guard = this.index;
			const handlerPos = this.next().pos;
			const starred = this.accept("*") !== undefined;
			if (handlers.length > 0 && starred !== star) {
				this.fail("cannot have both 'except' and 'except*' on the same 'try'", handlerPos);
			}
			star = starred;
			let exceptionType: A.Expression | undefined;
			let name: string | undefined;
			if (!this.at(":")) {
				const typePos = this.peek().pos;
				exceptionType = this.expression();
				if (this.at(",")) {
					// `except A, B:`, a tuple without its parentheses, and so without `as`.
					const elts = [exceptionType];
					while (this.accept(",")) elts.push(this.expression());
					exceptionType = { type: "Tuple", pos: typePos, end: this.lastEnd, elts, ctx: "Load" };
					if (this.at("as")) this.fail("multiple exception types must be parenthesized", typePos);
				}
				if (this.accept("as")) name = this.expectName().string;
			} else if (star) this.fail("expected one or more exception types");
			this.expect(":");
			const handlerBody = this.block();
			handlers.push({
				type: "ExceptHandler",
				pos: handlerPos,
				end: this.endOf(handlerBody),
				exceptionType,
				name,
				body: handlerBody,
			});
		}
		const orelse = handlers.length > 0 ? this.elseBlock() : [];
		let finalbody: A.Statement[] = [];
		if (this.accept("finally")) {
			this.expect(":");
			finalbody = this.block();
		}
		if (handlers.length === 0 && finalbody.length === 0) this.fail("expected 'except' or 'finally' block");
		const last = [finalbody, orelse, handlers, body].find((group) => group.length > 0) as A.Span[];
		return {
			type: star ? "TryStar" : "Try",
			pos,
			end: this.endOf(last),
			body,
			handlers,
			orelse,
			finalbody,
		};
	}

	////////////////////////////////
	//  Pattern matching

	/** `match` opens a statement only as a whole; otherwise the name starts an expression. */
	private matchStatement(): A.Match | undefined {
		const mark = this.index;
		const pos = this.next().pos;
		let subject: A.Expression;
		try {
			subject = this.subject();
			if (!this.at(":") || this.peek(1).type !== "NEWLINE") throw new Failure({ message: "", pos });
		} catch (error) {
			if (!(error instanceof Failure)) throw error;
			this.index = mark;
			return undefined;
		}
		this.expect(":");
		this.expectType("NEWLINE");
		if (!this.atType("INDENT")) this.fail("expected an indented block");
		this.next();
		const cases: A.MatchCase[] = [];
		let guard = -1;
		while (!this.atType("DEDENT")) {
			if (this.index <= guard) throw new Error("python case parse failed to advance");
			guard = this.index;
			cases.push(this.matchCase());
		}
		this.next();
		const last = cases[cases.length - 1];
		if (last === undefined) this.fail("expected 'case'");
		return { type: "Match", pos, end: last.end, subject, cases };
	}

	private subject(): A.Expression {
		const pos = this.peek().pos;
		const first = this.starNamedExpression();
		if (!this.at(",")) {
			if (first.type === "Starred") this.fail("invalid syntax");
			return first;
		}
		const elts = [first];
		while (this.accept(",")) {
			if (this.at(":")) break;
			elts.push(this.starNamedExpression());
		}
		return { type: "Tuple", pos, end: this.lastEnd, elts, ctx: "Load" };
	}

	private matchCase(): A.MatchCase {
		const pos = this.peek().pos;
		if (!this.at("case")) this.fail("expected 'case'");
		this.next();
		const pattern = this.patterns();
		const guard = this.accept("if") ? this.namedExpression() : undefined;
		this.expect(":");
		const body = this.block();
		return { type: "match_case", pos, end: this.endOf(body), pattern, guard, body };
	}

	private patterns(): A.Pattern {
		const pos = this.peek().pos;
		const first = this.maybeStarPattern();
		if (!this.at(",")) {
			if (first.type === "MatchStar") this.fail("invalid syntax");
			return first;
		}
		const patterns = [first];
		while (this.accept(",")) {
			if (this.at(":") || this.at("if")) break;
			patterns.push(this.maybeStarPattern());
		}
		return { type: "MatchSequence", pos, end: this.lastEnd, patterns };
	}

	private maybeStarPattern(): A.Pattern {
		if (!this.at("*")) return this.pattern();
		const pos = this.next().pos;
		const name = this.expectName().string;
		return { type: "MatchStar", pos, end: this.lastEnd, name: name === "_" ? undefined : name };
	}

	private pattern(): A.Pattern {
		const pos = this.peek().pos;
		const pattern = this.orPattern();
		if (!this.accept("as")) return pattern;
		const name = this.expectName().string;
		if (name === "_") this.fail("cannot use '_' as a target");
		return { type: "MatchAs", pos, end: this.lastEnd, pattern, name };
	}

	private orPattern(): A.Pattern {
		const pos = this.peek().pos;
		const first = this.closedPattern();
		if (!this.at("|")) return first;
		const patterns = [first];
		while (this.accept("|")) patterns.push(this.closedPattern());
		return { type: "MatchOr", pos, end: this.lastEnd, patterns };
	}

	private closedPattern(): A.Pattern {
		return this.nested(() => {
			const token = this.peek();
			const pos = token.pos;
			if (this.at("(")) {
				this.next();
				if (this.accept(")")) return { type: "MatchSequence", pos, end: this.lastEnd, patterns: [] };
				const first = this.maybeStarPattern();
				if (this.accept(")")) {
					if (first.type === "MatchStar")
						return { type: "MatchSequence", pos, end: this.lastEnd, patterns: [first] };
					return first;
				}
				const patterns = [first];
				while (this.accept(",")) {
					if (this.at(")")) break;
					patterns.push(this.maybeStarPattern());
				}
				this.expect(")");
				return { type: "MatchSequence", pos, end: this.lastEnd, patterns };
			}
			if (this.at("[")) {
				this.next();
				const patterns: A.Pattern[] = [];
				while (!this.at("]")) {
					patterns.push(this.maybeStarPattern());
					if (!this.accept(",")) break;
				}
				this.expect("]");
				return { type: "MatchSequence", pos, end: this.lastEnd, patterns };
			}
			if (this.at("{")) return this.mappingPattern();
			if (this.at("None") || this.at("True") || this.at("False")) {
				this.next();
				const value: A.PyValue =
					token.string === "None" ? { kind: "None" } : { kind: "bool", value: token.string === "True" };
				return { type: "MatchSingleton", pos, end: this.lastEnd, value };
			}
			if (token.type === "NUMBER" || token.type === "STRING" || token.type === "FSTRING_START" || this.at("-")) {
				const value = this.literalPatternValue();
				return { type: "MatchValue", pos, end: this.lastEnd, value };
			}
			if (!this.atName()) this.fail("invalid syntax");
			let value: A.Expression = this.nameNode(this.next(), "Load");
			while (this.at(".") && this.atName(1)) {
				this.next();
				const attr = this.next();
				value = { type: "Attribute", pos, end: attr.end, value, attr: attr.string, ctx: "Load" };
			}
			if (this.at("(")) return this.classPattern(value);
			if (value.type === "Attribute") return { type: "MatchValue", pos, end: this.lastEnd, value };
			const name = (value as A.Name).id;
			return {
				type: "MatchAs",
				pos,
				end: this.lastEnd,
				pattern: undefined,
				name: name === "_" ? undefined : name,
			};
		});
	}

	/** A number, `-` number, complex sum or string, as a literal pattern spells it. */
	private literalPatternValue(): A.Expression {
		if (this.atType("STRING") || this.atType("FSTRING_START")) return this.strings();
		const pos = this.peek().pos;
		let value: A.Expression = this.signedNumber();
		if (this.at("+") || this.at("-")) {
			const operator = this.next().string === "+" ? "Add" : "Sub";
			const real = value.type === "UnaryOp" ? value.operand : value;
			if (real.type === "Constant" && real.value.kind === "complex") {
				this.fail("real number required in complex literal", real.pos);
			}
			const right = this.number();
			if (right.value.kind !== "complex") this.fail("imaginary number required in complex literal", right.pos);
			value = { type: "BinOp", pos, end: this.lastEnd, left: value, op: operator, right };
		}
		return value;
	}

	private signedNumber(): A.Expression {
		const pos = this.peek().pos;
		if (this.accept("-")) {
			const operand = this.number();
			return { type: "UnaryOp", pos, end: this.lastEnd, op: "USub", operand };
		}
		return this.number();
	}

	private number(): A.Constant {
		const token = this.expectType("NUMBER");
		const value = numberValue(token.string);
		if ("error" in value) this.fail(value.error, token.pos + (value.at ?? 0));
		return { type: "Constant", pos: token.pos, end: token.end, value };
	}

	private mappingPattern(): A.Pattern {
		const pos = this.expect("{").pos;
		const keys: A.Expression[] = [];
		const patterns: A.Pattern[] = [];
		let rest: string | undefined;
		let guard = -1;
		while (!this.at("}")) {
			if (this.index <= guard) throw new Error("python mapping pattern parse failed to advance");
			guard = this.index;
			if (this.accept("**")) {
				rest = this.expectName().string;
				// The rest captures a name, and closes the mapping.
				if (rest === "_") this.fail("invalid syntax", this.previous().pos);
				this.accept(",");
				break;
			} else {
				const keyToken = this.peek();
				let key: A.Expression;
				if (this.atName()) {
					key = this.nameNode(this.next(), "Load");
					// A key is a literal or a dotted value, never a bare name.
					if (!this.at(".")) this.fail("invalid syntax", keyToken.pos);
					while (this.accept(".")) {
						const attr = this.expectName();
						key = {
							type: "Attribute",
							pos: keyToken.pos,
							end: attr.end,
							value: key,
							attr: attr.string,
							ctx: "Load",
						};
					}
				} else if (this.at("None") || this.at("True") || this.at("False")) {
					const token = this.next();
					const value: A.PyValue =
						token.string === "None" ? { kind: "None" } : { kind: "bool", value: token.string === "True" };
					key = { type: "Constant", pos: token.pos, end: token.end, value };
				} else key = this.literalPatternValue();
				this.expect(":");
				keys.push(key);
				patterns.push(this.pattern());
			}
			if (!this.accept(",")) break;
		}
		this.expect("}");
		return { type: "MatchMapping", pos, end: this.lastEnd, keys, patterns, rest };
	}

	private classPattern(cls: A.Expression): A.Pattern {
		this.expect("(");
		const patterns: A.Pattern[] = [];
		const kwdAttrs: string[] = [];
		const kwdPatterns: A.Pattern[] = [];
		let guard = -1;
		while (!this.at(")")) {
			if (this.index <= guard) throw new Error("python class pattern parse failed to advance");
			guard = this.index;
			if (this.atName() && this.at("=", 1)) {
				kwdAttrs.push(this.next().string);
				this.next();
				kwdPatterns.push(this.pattern());
			} else {
				if (kwdAttrs.length > 0) this.fail("positional patterns follow keyword patterns");
				patterns.push(this.pattern());
			}
			if (!this.accept(",")) break;
		}
		this.expect(")");
		return { type: "MatchClass", pos: cls.pos, end: this.lastEnd, cls, patterns, kwdAttrs, kwdPatterns };
	}

	////////////////////////////////
	//  Simple statements

	private simpleStatement(): A.Statement {
		const token = this.peek();
		const pos = token.pos;
		if (token.type === "NAME") {
			switch (token.string) {
				case "pass":
				case "break":
				case "continue":
					this.next();
					return {
						type: token.string === "pass" ? "Pass" : token.string === "break" ? "Break" : "Continue",
						pos,
						end: token.end,
					};
				case "return": {
					this.next();
					const value = this.startsExpression() ? this.starExpressions() : undefined;
					return { type: "Return", pos, end: this.lastEnd, value };
				}
				case "raise": {
					this.next();
					const exc = this.startsExpression() ? this.expression() : undefined;
					const cause = exc !== undefined && this.accept("from") ? this.expression() : undefined;
					return { type: "Raise", pos, end: this.lastEnd, exc, cause };
				}
				case "global":
				case "nonlocal": {
					this.next();
					const names = [this.expectName().string];
					while (this.accept(",")) names.push(this.expectName().string);
					return { type: token.string === "global" ? "Global" : "Nonlocal", pos, end: this.lastEnd, names };
				}
				case "del": {
					this.next();
					if (!this.startsExpression()) this.fail("invalid syntax");
					const targets: A.Expression[] = [];
					let guard = -1;
					do {
						if (this.index <= guard) throw new Error("python del parse failed to advance");
						guard = this.index;
						if (!this.startsExpression()) break;
						targets.push(this.target("Del"));
					} while (this.accept(","));
					return { type: "Delete", pos, end: this.lastEnd, targets };
				}
				case "assert": {
					this.next();
					const test = this.expression();
					const msg = this.accept(",") ? this.expression() : undefined;
					return { type: "Assert", pos, end: this.lastEnd, test, msg };
				}
				case "import":
					return this.importStatement();
				case "from":
					return this.importFrom();
				case "type":
					if (this.atName(1) && (this.at("[", 2) || this.at("=", 2))) return this.typeAlias();
					break;
			}
		}
		return this.expressionStatement();
	}

	private typeAlias(): A.TypeAlias {
		const pos = this.next().pos;
		const nameToken = this.next();
		const name = this.nameNode(nameToken, "Store");
		const typeParams = this.at("[") ? this.typeParams() : [];
		this.expect("=");
		const value = this.expression();
		return { type: "TypeAlias", pos, end: this.lastEnd, name, typeParams, value };
	}

	private dottedName(): { name: string; end: number } {
		const first = this.expectName();
		let name = first.string;
		while (this.at(".") && this.atName(1)) {
			this.next();
			name += `.${this.next().string}`;
		}
		return { name, end: this.lastEnd };
	}

	private importStatement(): A.Import {
		const pos = this.next().pos;
		const names: A.Alias[] = [];
		let guard = -1;
		do {
			if (this.index <= guard) throw new Error("python import parse failed to advance");
			guard = this.index;
			const start = this.peek().pos;
			const { name } = this.dottedName();
			const asname = this.accept("as") ? this.expectName().string : undefined;
			names.push({ type: "alias", pos: start, end: this.lastEnd, name, asname });
		} while (this.accept(","));
		return { type: "Import", pos, end: this.lastEnd, names };
	}

	private importFrom(): A.ImportFrom {
		const pos = this.next().pos;
		let level = 0;
		let guard = -1;
		while (this.at(".") || this.at("...")) {
			if (this.index <= guard) throw new Error("python relative import parse failed to advance");
			guard = this.index;
			level += this.next().string.length;
		}
		const module = this.at("import") ? undefined : this.dottedName().name;
		if (module === undefined && level === 0) this.fail("invalid syntax");
		this.expect("import");
		const names: A.Alias[] = [];
		if (this.at("*")) {
			const star = this.next();
			names.push({ type: "alias", pos: star.pos, end: star.end, name: "*", asname: undefined });
			return { type: "ImportFrom", pos, end: this.lastEnd, module, names, level };
		}
		const parenthesized = this.accept("(") !== undefined;
		let inner = -1;
		do {
			if (this.index <= inner) throw new Error("python import name parse failed to advance");
			inner = this.index;
			if (parenthesized && names.length > 0 && this.at(")")) break;
			const nameToken = this.expectName();
			const asname = this.accept("as") ? this.expectName().string : undefined;
			names.push({ type: "alias", pos: nameToken.pos, end: this.lastEnd, name: nameToken.string, asname });
		} while (this.accept(","));
		if (parenthesized) this.expect(")");
		else if (this.previous().string === ",")
			this.fail("trailing comma not allowed without surrounding parentheses");
		return { type: "ImportFrom", pos, end: this.lastEnd, module, names, level };
	}

	/** An expression, or the assignment, annotated assignment or augmented assignment it opens. */
	private expressionStatement(): A.Statement {
		const startToken = this.peek();
		const pos = startToken.pos;
		const first = this.at("yield") ? this.yieldExpression() : this.starExpressions();
		if (this.at(":")) {
			this.next();
			if (first.type !== "Name" && first.type !== "Attribute" && first.type !== "Subscript")
				this.fail(
					first.type === "Tuple"
						? "only single target (not tuple) can be annotated"
						: "illegal target for annotation",
					first.pos,
				);
			const target = this.store(first, "Store");
			const annotation = this.expression();
			const value = this.accept("=")
				? this.at("yield")
					? this.yieldExpression()
					: this.starExpressions()
				: undefined;
			const simple = first.type === "Name" && !(startToken.type === "OP" && startToken.string === "(");
			return { type: "AnnAssign", pos, end: this.lastEnd, target, annotation, value, simple };
		}
		const augmented = this.peek().type === "OP" ? AUGMENTED.get(this.peek().string) : undefined;
		if (augmented !== undefined) {
			this.next();
			if (first.type !== "Name" && first.type !== "Attribute" && first.type !== "Subscript")
				this.fail("illegal expression for augmented assignment", first.pos);
			const target = this.store(first, "Store");
			const value = this.at("yield") ? this.yieldExpression() : this.starExpressions();
			return { type: "AugAssign", pos, end: this.lastEnd, target, op: augmented, value };
		}
		if (!this.at("=")) return { type: "Expr", pos, end: this.lastEnd, value: first };
		const chain = [first];
		let guard = -1;
		while (this.accept("=")) {
			if (this.index <= guard) throw new Error("python assignment parse failed to advance");
			guard = this.index;
			chain.push(this.at("yield") ? this.yieldExpression() : this.starExpressions());
		}
		const value = chain.pop() as A.Expression;
		const targets = chain.map((target) => this.store(target, "Store"));
		// A type comment is part of the assignment, its span included.
		const typeComment = this.atType("NEWLINE") ? this.typeCommentTokenAfterPrevious() : undefined;
		const end = typeComment?.end ?? this.lastEnd;
		return { type: "Assign", pos, end, targets, value, typeComment: typeComment?.text };
	}

	////////////////////////////////
	//  Targets

	/** Assignment targets; a comma makes a tuple. */
	private targets(ctx: A.Context): A.Expression {
		const pos = this.peek().pos;
		const first = this.target(ctx);
		if (!this.at(",")) return first;
		const elts = [first];
		while (this.accept(",")) {
			if (!this.startsExpression() || this.at("in")) break;
			elts.push(this.target(ctx));
		}
		return { type: "Tuple", pos, end: this.lastEnd, elts, ctx };
	}

	/** One target: a starred one, or a primary; no comparison, so `in` stays unread. */
	private target(ctx: A.Context): A.Expression {
		if (this.at("*")) {
			if (ctx === "Del") this.fail("cannot delete starred");
			const pos = this.next().pos;
			const value = this.target(ctx);
			return { type: "Starred", pos, end: this.lastEnd, value, ctx };
		}
		return this.store(this.bitwiseOr(), ctx);
	}

	/** The expression as a target, its context set throughout. */
	private store(node: A.Expression, ctx: A.Context): A.Expression {
		switch (node.type) {
			case "Name":
			case "Attribute":
			case "Subscript":
				node.ctx = ctx;
				return node;
			case "Starred":
				if (ctx === "Del") this.fail("cannot delete starred", node.pos);
				node.ctx = ctx;
				this.store(node.value, ctx);
				return node;
			case "Tuple":
			case "List":
				node.ctx = ctx;
				for (const element of node.elts) this.store(element, ctx);
				return node;
			default:
				this.fail(`cannot ${ctx === "Del" ? "delete" : "assign to"} ${this.describe(node)}`, node.pos);
		}
	}

	private describe(node: A.Expression): string {
		switch (node.type) {
			case "Constant":
				return "literal";
			case "Call":
				return "function call";
			case "Compare":
				return "comparison";
			default:
				return "expression";
		}
	}

	////////////////////////////////
	//  Expressions

	/** Whether an expression can start at the cursor. */
	private startsExpression(): boolean {
		const token = this.peek();
		switch (token.type) {
			case "NUMBER":
			case "STRING":
			case "FSTRING_START":
			case "TSTRING_START":
				return true;
			case "NAME":
				return (
					!KEYWORDS.has(token.string) ||
					["None", "True", "False", "not", "lambda", "await", "yield"].includes(token.string)
				);
			case "OP":
				return ["(", "[", "{", "-", "+", "~", "*", "...", "**"].includes(token.string);
			default:
				return false;
		}
	}

	private starExpressions(): A.Expression {
		const pos = this.peek().pos;
		const first = this.starExpression();
		if (!this.at(",")) return first;
		const elts = [first];
		while (this.accept(",")) {
			if (!this.startsExpression() || this.at("**")) break;
			elts.push(this.starExpression());
		}
		return { type: "Tuple", pos, end: this.lastEnd, elts, ctx: "Load" };
	}

	private starExpression(): A.Expression {
		if (!this.at("*")) return this.expression();
		const pos = this.next().pos;
		const value = this.bitwiseOr();
		return { type: "Starred", pos, end: this.lastEnd, value, ctx: "Load" };
	}

	private starNamedExpression(): A.Expression {
		if (!this.at("*")) return this.namedExpression();
		const pos = this.next().pos;
		const value = this.bitwiseOr();
		return { type: "Starred", pos, end: this.lastEnd, value, ctx: "Load" };
	}

	private namedExpression(): A.Expression {
		if (this.atName() && this.at(":=", 1)) {
			const nameToken = this.next();
			this.next();
			const value = this.expression();
			const target = this.nameNode(nameToken, "Store");
			return { type: "NamedExpr", pos: nameToken.pos, end: this.lastEnd, target, value };
		}
		return this.expression();
	}

	private expression(): A.Expression {
		return this.nested(() => {
			if (this.at("lambda")) return this.lambda();
			const pos = this.peek().pos;
			const body = this.disjunction();
			if (!this.at("if")) return body;
			this.next();
			const test = this.disjunction();
			this.expect("else");
			const orelse = this.expression();
			return { type: "IfExp", pos, end: this.lastEnd, test, body, orelse };
		});
	}

	private lambda(): A.Lambda {
		const pos = this.expect("lambda").pos;
		const args = this.parameters(":", false);
		this.expect(":");
		const body = this.expression();
		return { type: "Lambda", pos, end: this.lastEnd, args, body };
	}

	private disjunction(): A.Expression {
		const pos = this.peek().pos;
		const first = this.conjunction();
		if (!this.at("or")) return first;
		const values = [first];
		while (this.accept("or")) values.push(this.conjunction());
		return { type: "BoolOp", pos, end: this.lastEnd, op: "Or", values };
	}

	private conjunction(): A.Expression {
		const pos = this.peek().pos;
		const first = this.inversion();
		if (!this.at("and")) return first;
		const values = [first];
		while (this.accept("and")) values.push(this.inversion());
		return { type: "BoolOp", pos, end: this.lastEnd, op: "And", values };
	}

	/** `not` prefixes are read in a loop, so a long run costs no stack. */
	private inversion(): A.Expression {
		const starts: number[] = [];
		while (this.at("not")) starts.push(this.next().pos);
		let operand = this.comparison();
		for (let index = starts.length - 1; index >= 0; index--)
			operand = { type: "UnaryOp", pos: starts[index] as number, end: this.lastEnd, op: "Not", operand };
		return operand;
	}

	private comparison(): A.Expression {
		const pos = this.peek().pos;
		const left = this.bitwiseOr();
		const ops: A.ComparisonOperator[] = [];
		const comparators: A.Expression[] = [];
		for (;;) {
			const operator = this.comparisonOperator();
			if (operator === undefined) break;
			ops.push(operator);
			comparators.push(this.bitwiseOr());
		}
		if (ops.length === 0) return left;
		return { type: "Compare", pos, end: this.lastEnd, left, ops, comparators };
	}

	private comparisonOperator(): A.ComparisonOperator | undefined {
		const token = this.peek();
		if (token.type === "OP") {
			const operator = COMPARISONS.get(token.string);
			if (operator !== undefined) this.next();
			return operator;
		}
		if (this.at("in")) {
			this.next();
			return "In";
		}
		if (this.at("not") && this.at("in", 1)) {
			this.next();
			this.next();
			return "NotIn";
		}
		if (this.at("is")) {
			this.next();
			return this.accept("not") ? "IsNot" : "Is";
		}
		return undefined;
	}

	private bitwiseOr(): A.Expression {
		return this.binary(0);
	}

	private binary(level: number): A.Expression {
		const operators = LEVELS[level];
		if (operators === undefined) return this.factor();
		const pos = this.peek().pos;
		let left = this.binary(level + 1);
		for (;;) {
			const token = this.peek();
			const operator = token.type === "OP" ? operators.get(token.string) : undefined;
			if (operator === undefined) return left;
			this.next();
			const right = this.binary(level + 1);
			left = { type: "BinOp", pos, end: this.lastEnd, left, op: operator, right };
		}
	}

	/** Unary prefixes are read in a loop, so a long run costs no stack. */
	private factor(): A.Expression {
		const prefixes: Array<{ op: A.UnaryOperator; pos: number }> = [];
		for (;;) {
			const token = this.peek();
			const op =
				token.type !== "OP"
					? undefined
					: token.string === "-"
						? "USub"
						: token.string === "+"
							? "UAdd"
							: token.string === "~"
								? "Invert"
								: undefined;
			if (op === undefined) break;
			prefixes.push({ op, pos: this.next().pos });
		}
		let operand = this.power();
		for (let index = prefixes.length - 1; index >= 0; index--) {
			const { op, pos } = prefixes[index] as { op: A.UnaryOperator; pos: number };
			operand = { type: "UnaryOp", pos, end: this.lastEnd, op, operand };
		}
		return operand;
	}

	private power(): A.Expression {
		const pos = this.peek().pos;
		const base = this.awaitPrimary();
		if (!this.accept("**")) return base;
		const exponent = this.nested(() => this.factor());
		return { type: "BinOp", pos, end: this.lastEnd, left: base, op: "Pow", right: exponent };
	}

	private awaitPrimary(): A.Expression {
		if (!this.at("await")) return this.primary();
		const pos = this.next().pos;
		const value = this.primary();
		return { type: "Await", pos, end: this.lastEnd, value };
	}

	private primary(): A.Expression {
		const pos = this.peek().pos;
		let node = this.atom();
		for (;;) {
			if (this.at(".")) {
				this.next();
				const attr = this.expectName();
				node = { type: "Attribute", pos, end: attr.end, value: node, attr: attr.string, ctx: "Load" };
			} else if (this.at("(")) {
				const open = this.next();
				const call = this.nested(() => this.callArguments(open.pos));
				this.expect(")");
				node = { type: "Call", pos, end: this.lastEnd, func: node, args: call.args, keywords: call.keywords };
			} else if (this.at("[")) {
				this.next();
				const slice = this.nested(() => this.slices());
				this.expect("]");
				node = { type: "Subscript", pos, end: this.lastEnd, value: node, slice, ctx: "Load" };
			} else return node;
		}
	}

	/** A call's arguments, up to its `)`; `open` places a lone generator expression. */
	private callArguments(open?: number): { args: A.Expression[]; keywords: A.Keyword[] } {
		const args: A.Expression[] = [];
		const keywords: A.Keyword[] = [];
		let guard = -1;
		while (!this.at(")")) {
			if (this.index <= guard) throw new Error("python argument parse failed to advance");
			guard = this.index;
			const token = this.peek();
			if (this.accept("*")) {
				if (keywords.some((keyword) => keyword.arg === undefined))
					this.fail("iterable argument unpacking follows keyword argument unpacking", token.pos);
				const value = this.expression();
				args.push({ type: "Starred", pos: token.pos, end: this.lastEnd, value, ctx: "Load" });
			} else if (this.accept("**")) {
				const value = this.expression();
				keywords.push({ type: "keyword", pos: token.pos, end: this.lastEnd, arg: undefined, value });
			} else if (this.atName() && this.at("=", 1)) {
				this.next();
				this.next();
				const value = this.expression();
				keywords.push({ type: "keyword", pos: token.pos, end: this.lastEnd, arg: token.string, value });
			} else {
				if (keywords.some((keyword) => keyword.arg === undefined))
					this.fail("positional argument follows keyword argument unpacking");
				if (keywords.length > 0) this.fail("positional argument follows keyword argument");
				const value = this.namedExpression();
				if (this.at("for") || (this.at("async") && this.at("for", 1))) {
					const generators = this.comprehensions();
					if (args.length > 0 || !this.at(")") || open === undefined)
						this.fail("Generator expression must be parenthesized", value.pos);
					args.push({ type: "GeneratorExp", pos: open, end: this.peek().end, elt: value, generators });
					continue;
				}
				args.push(value);
			}
			if (!this.accept(",")) break;
		}
		return { args, keywords };
	}

	private slices(): A.Expression {
		const pos = this.peek().pos;
		const first = this.slice();
		if (!this.at(",")) return first;
		const elts = [first];
		while (this.accept(",")) {
			if (this.at("]")) break;
			elts.push(this.slice());
		}
		return { type: "Tuple", pos, end: this.lastEnd, elts, ctx: "Load" };
	}

	private slice(): A.Expression {
		const pos = this.peek().pos;
		if (this.at("*")) return this.starExpression();
		// A bare walrus is a whole subscript, never a slice bound.
		const walrus = this.atName() && this.at(":=", 1);
		const lower = this.at(":") ? undefined : this.namedExpression();
		if (!this.accept(":")) return lower as A.Expression;
		if (walrus) this.fail("invalid syntax", pos);
		const bound = (): A.Expression | undefined =>
			this.at(":") || this.at(",") || this.at("]") ? undefined : this.expression();
		const upper = bound();
		const step = this.accept(":") ? bound() : undefined;
		return { type: "Slice", pos, end: this.lastEnd, lower, upper, step };
	}

	private yieldExpression(): A.Expression {
		const pos = this.expect("yield").pos;
		if (this.accept("from")) {
			const value = this.expression();
			return { type: "YieldFrom", pos, end: this.lastEnd, value };
		}
		const value = this.startsExpression() ? this.starExpressions() : undefined;
		return { type: "Yield", pos, end: this.lastEnd, value };
	}

	/** The clauses after a comprehension's element, which no `*` may unpack. */
	private comprehended(element: A.Expression): A.Comprehension[] {
		if (element.type === "Starred") this.fail("iterable unpacking cannot be used in comprehension", element.pos);
		return this.comprehensions();
	}

	private comprehensions(): A.Comprehension[] {
		const generators: A.Comprehension[] = [];
		let guard = -1;
		while (this.at("for") || (this.at("async") && this.at("for", 1))) {
			if (this.index <= guard) throw new Error("python comprehension parse failed to advance");
			guard = this.index;
			const pos = this.peek().pos;
			const isAsync = this.accept("async") !== undefined;
			this.expect("for");
			const target = this.targets("Store");
			this.expect("in");
			const iter = this.disjunction();
			const ifs: A.Expression[] = [];
			while (this.accept("if")) ifs.push(this.disjunction());
			generators.push({ type: "comprehension", pos, end: this.lastEnd, target, iter, ifs, isAsync });
		}
		return generators;
	}

	private nameNode(token: Token, ctx: A.Context): A.Name {
		return { type: "Name", pos: token.pos, end: token.end, id: token.string, ctx };
	}

	private atom(): A.Expression {
		const token = this.peek();
		switch (token.type) {
			case "NUMBER":
				return this.number();
			case "STRING":
			case "FSTRING_START":
			case "TSTRING_START":
				return this.strings();
			case "NAME":
				if (token.string === "None" || token.string === "True" || token.string === "False") {
					this.next();
					const value: A.PyValue =
						token.string === "None" ? { kind: "None" } : { kind: "bool", value: token.string === "True" };
					return { type: "Constant", pos: token.pos, end: token.end, value };
				}
				if (KEYWORDS.has(token.string)) this.fail("invalid syntax");
				return this.nameNode(this.next(), "Load");
			case "OP":
				if (token.string === "...") {
					this.next();
					return { type: "Constant", pos: token.pos, end: token.end, value: { kind: "Ellipsis" } };
				}
				if (token.string === "(") return this.nested(() => this.parenthesized());
				if (token.string === "[") return this.nested(() => this.list());
				if (token.string === "{") return this.nested(() => this.braced());
				break;
		}
		this.fail(token.type === "ERRORTOKEN" ? `invalid character '${token.string}'` : "invalid syntax");
	}

	/** A tuple, a generator expression, or an expression in parentheses, which keeps its own span. */
	private parenthesized(): A.Expression {
		const pos = this.expect("(").pos;
		if (this.accept(")")) return { type: "Tuple", pos, end: this.lastEnd, elts: [], ctx: "Load" };
		if (this.at("yield")) {
			const value = this.yieldExpression();
			this.expect(")");
			return value;
		}
		const first = this.starNamedExpression();
		if (this.at("for") || (this.at("async") && this.at("for", 1))) {
			const generators = this.comprehended(first);
			this.expect(")");
			return { type: "GeneratorExp", pos, end: this.lastEnd, elt: first, generators };
		}
		if (!this.at(",")) {
			if (first.type === "Starred") this.fail("cannot use starred expression here", first.pos);
			this.expect(")");
			return first;
		}
		const elts = [first];
		while (this.accept(",")) {
			if (this.at(")")) break;
			elts.push(this.starNamedExpression());
		}
		this.expect(")");
		return { type: "Tuple", pos, end: this.lastEnd, elts, ctx: "Load" };
	}

	private list(): A.Expression {
		const pos = this.expect("[").pos;
		if (this.accept("]")) return { type: "List", pos, end: this.lastEnd, elts: [], ctx: "Load" };
		const first = this.starNamedExpression();
		if (this.at("for") || (this.at("async") && this.at("for", 1))) {
			const generators = this.comprehended(first);
			this.expect("]");
			return { type: "ListComp", pos, end: this.lastEnd, elt: first, generators };
		}
		const elts = [first];
		while (this.accept(",")) {
			if (this.at("]")) break;
			elts.push(this.starNamedExpression());
		}
		this.expect("]");
		return { type: "List", pos, end: this.lastEnd, elts, ctx: "Load" };
	}

	/** A dict, a set, or a comprehension of either. */
	private braced(): A.Expression {
		const pos = this.expect("{").pos;
		if (this.accept("}")) return { type: "Dict", pos, end: this.lastEnd, keys: [], values: [] };
		if (this.at("**")) return this.dict(pos, undefined);
		// A bare walrus may be a set's element, never a dict's key.
		const walrus = this.atName() && this.at(":=", 1);
		const first = this.starNamedExpression();
		if (this.accept(":")) {
			if (first.type === "Starred") this.fail("cannot use a starred expression in a dictionary key", first.pos);
			if (walrus) this.fail("invalid syntax", first.pos);
			const value = this.expression();
			if (this.at("for") || (this.at("async") && this.at("for", 1))) {
				const generators = this.comprehensions();
				this.expect("}");
				return { type: "DictComp", pos, end: this.lastEnd, key: first, value, generators };
			}
			return this.dict(pos, { key: first, value });
		}
		if (this.at("for") || (this.at("async") && this.at("for", 1))) {
			const generators = this.comprehended(first);
			this.expect("}");
			return { type: "SetComp", pos, end: this.lastEnd, elt: first, generators };
		}
		const elts = [first];
		while (this.accept(",")) {
			if (this.at("}")) break;
			elts.push(this.starNamedExpression());
		}
		this.expect("}");
		return { type: "Set", pos, end: this.lastEnd, elts };
	}

	private dict(pos: number, first: { key: A.Expression; value: A.Expression } | undefined): A.Dict {
		const keys: Array<A.Expression | undefined> = [];
		const values: A.Expression[] = [];
		if (first !== undefined) {
			keys.push(first.key);
			values.push(first.value);
			if (!this.accept(",")) {
				this.expect("}");
				return { type: "Dict", pos, end: this.lastEnd, keys, values };
			}
		}
		let guard = -1;
		while (!this.at("}")) {
			if (this.index <= guard) throw new Error("python dict parse failed to advance");
			guard = this.index;
			if (this.accept("**")) {
				keys.push(undefined);
				values.push(this.bitwiseOr());
			} else {
				keys.push(this.expression());
				this.expect(":");
				values.push(this.expression());
			}
			if (!this.accept(",")) break;
		}
		this.expect("}");
		return { type: "Dict", pos, end: this.lastEnd, keys, values };
	}

	////////////////////////////////
	//  Parameters

	/** `def` and `lambda` parameters up to `close`; only `def` takes annotations. */
	private parameters(close: string, annotated: boolean): A.Arguments {
		const pos = this.peek().pos;
		let posonlyargs: A.Arg[] = [];
		const args: A.Arg[] = [];
		const defaults: A.Expression[] = [];
		const kwonlyargs: A.Arg[] = [];
		const kwDefaults: Array<A.Expression | undefined> = [];
		let vararg: A.Arg | undefined;
		let kwarg: A.Arg | undefined;
		let starred = false;
		let guard = -1;
		while (!this.at(close)) {
			if (this.index <= guard) throw new Error("python parameter parse failed to advance");
			guard = this.index;
			if (kwarg !== undefined) this.fail("arguments cannot follow var-keyword argument");
			let current: A.Arg | undefined;
			if (this.accept("/")) {
				if (starred || posonlyargs.length > 0 || args.length === 0) this.fail("invalid syntax");
				posonlyargs = args.splice(0);
			} else if (this.accept("**")) {
				kwarg = this.parameter(annotated, false);
				current = kwarg;
			} else if (this.accept("*")) {
				if (starred) this.fail("* argument may appear only once");
				starred = true;
				if (!this.at(",") && !this.at(close)) vararg = this.parameter(annotated, true);
				current = vararg;
			} else {
				current = this.parameter(annotated, false);
				const value = this.accept("=") ? this.expression() : undefined;
				if (starred) {
					kwonlyargs.push(current);
					kwDefaults.push(value);
				} else {
					args.push(current);
					if (value !== undefined) defaults.push(value);
					else if (defaults.length > 0)
						this.fail("parameter without a default follows parameter with a default", current.pos);
				}
			}
			const more = this.accept(",") !== undefined;
			// A type comment after a parameter, or after its comma, belongs to it.
			if (annotated && current !== undefined) current.typeComment = this.typeCommentAfterPrevious();
			if (!more) break;
		}
		if (starred && vararg === undefined && kwonlyargs.length === 0) this.fail("named arguments must follow bare *");
		return {
			type: "arguments",
			pos,
			end: this.lastEnd,
			posonlyargs,
			args,
			vararg,
			kwonlyargs,
			kwDefaults,
			kwarg,
			defaults,
		};
	}

	private parameter(annotated: boolean, variadic: boolean): A.Arg {
		const token = this.expectName();
		let annotation: A.Expression | undefined;
		if (annotated && this.accept(":")) annotation = variadic ? this.starExpression() : this.expression();
		return {
			type: "arg",
			pos: token.pos,
			end: this.lastEnd,
			arg: token.string,
			annotation,
			typeComment: undefined,
		};
	}

	////////////////////////////////
	//  Strings

	/** Adjacent literals as one: a constant, or an interpolated string holding its fields. */
	private strings(): A.Expression {
		const pos = this.peek().pos;
		const pieces: Array<Piece | A.FormattedValue> = [];
		let interpolated = false;
		let template = false;
		let bytes: boolean | undefined;
		let guard = -1;
		while (this.atType("STRING") || this.atType("FSTRING_START") || this.atType("TSTRING_START")) {
			if (this.index <= guard) throw new Error("python string parse failed to advance");
			guard = this.index;
			const token = this.peek();
			const isBytes = token.type === "STRING" && shapeOf(token.string).bytes;
			if (bytes !== undefined && bytes !== isBytes)
				this.fail("cannot mix bytes and nonbytes literals", token.pos);
			bytes = isBytes;
			if (token.type === "STRING") {
				this.next();
				const decoded = stringValue(token.string);
				if ("error" in decoded) this.fail(decoded.error, token.pos);
				pieces.push({ value: (decoded.value as { value: string }).value, pos: token.pos, end: token.end });
			} else {
				if (token.type === "TSTRING_START") template = true;
				interpolated = true;
				pieces.push(...this.interpolated());
			}
		}
		const end = this.lastEnd;
		if (!interpolated) {
			const value = pieces.map((piece) => (piece as Piece).value).join("");
			return { type: "Constant", pos, end, value: { kind: bytes ? "bytes" : "str", value } };
		}
		return { type: template ? "TemplateStr" : "JoinedStr", pos, end, values: this.merged(pieces) };
	}

	/** Adjacent text runs as one constant spanning them; an empty run is dropped. */
	private merged(pieces: ReadonlyArray<Piece | A.FormattedValue>): Array<A.Constant | A.FormattedValue> {
		const values: Array<A.Constant | A.FormattedValue> = [];
		let run: Piece | undefined;
		const close = (): void => {
			if (run !== undefined && run.value !== "")
				values.push({ type: "Constant", pos: run.pos, end: run.end, value: { kind: "str", value: run.value } });
			run = undefined;
		};
		for (const piece of pieces) {
			if ("type" in piece) {
				close();
				values.push(piece);
				continue;
			}
			if (run === undefined) run = { ...piece };
			else {
				run.value += piece.value;
				run.end = piece.end;
			}
		}
		close();
		return values;
	}

	/** One interpolated string, from its start token to its end token. */
	private interpolated(): Array<Piece | A.FormattedValue> {
		const start = this.next();
		const raw = shapeOf(start.string).raw;
		const pieces: Array<Piece | A.FormattedValue> = [];
		let guard = -1;
		for (;;) {
			if (this.index <= guard) throw new Error("python f-string parse failed to advance");
			guard = this.index;
			const token = this.peek();
			if (token.type === "FSTRING_END" || token.type === "TSTRING_END") {
				this.next();
				return pieces;
			}
			if (token.type === "FSTRING_MIDDLE" || token.type === "TSTRING_MIDDLE") {
				this.next();
				pieces.push({ value: this.middleValue(token, raw), pos: token.pos, end: token.end });
				continue;
			}
			if (this.at("{")) {
				pieces.push(...this.replacementField(raw, start.type === "TSTRING_START"));
				continue;
			}
			this.fail("f-string: expecting '}'");
		}
	}

	/** Text between fields: doubled braces read as one, escapes replaced unless raw. */
	private middleValue(token: Token, raw: boolean): string {
		let value = "";
		let chunk = "";
		const flush = (): void => {
			const decoded = decodeBody(chunk, raw, false);
			if ("error" in decoded) this.fail(decoded.error, token.pos);
			value += decoded.value;
			chunk = "";
		};
		const characters = [...token.string];
		for (let index = 0; index < characters.length; index++) {
			const character = characters[index] as string;
			if ((character === "{" || character === "}") && characters[index + 1] === character) {
				flush();
				value += character;
				index++;
				continue;
			}
			chunk += character;
			// A backslash keeps the character after it in the chunk; a brace after it stays a brace.
			const following = characters[index + 1];
			if (character === "\\" && following !== undefined && following !== "{" && following !== "}") {
				chunk += following;
				index++;
			}
		}
		flush();
		return value;
	}

	/** `{expression=!conversion:spec}`; a `=` adds the expression's text as a constant before it. */
	private replacementField(raw: boolean, template: boolean): Array<Piece | A.FormattedValue> {
		const open = this.expect("{");
		const value = this.nested(() => (this.at("yield") ? this.yieldExpression() : this.starExpressions()));
		const pieces: Array<Piece | A.FormattedValue> = [];
		const debug = this.accept("=") !== undefined;
		if (debug) {
			const debugEnd = this.peek().pos;
			const written = new SourceCursor(this.text, open.end, debugEnd).readWhile(() => true);
			pieces.push({ value: written, pos: open.end, end: debugEnd });
		}
		let conversion: number | undefined;
		const bang = this.accept("!");
		if (bang !== undefined) {
			const name = this.expectName();
			conversion = CONVERSIONS.get(name.string);
			if (conversion === undefined || name.pos !== bang.end)
				this.fail("f-string: invalid conversion character", name.pos);
		}
		let formatSpec: A.JoinedStr | undefined;
		if (this.at(":")) {
			const colon = this.next();
			const specPieces: Array<Piece | A.FormattedValue> = [];
			let guard = -1;
			while (!this.at("}")) {
				if (this.index <= guard) throw new Error("python format spec parse failed to advance");
				guard = this.index;
				const token = this.peek();
				if (token.type === "FSTRING_MIDDLE" || token.type === "TSTRING_MIDDLE") {
					this.next();
					specPieces.push({ value: this.middleValue(token, raw), pos: token.pos, end: token.end });
				} else if (this.at("{")) specPieces.push(...this.replacementField(raw, template));
				else this.fail("f-string: expecting '}'");
			}
			const values = this.merged(specPieces);
			// A spec ending in a nested field ends in an empty constant, as CPython 3.12 builds it.
			const closing = this.peek().pos;
			if (values[values.length - 1]?.type === "FormattedValue")
				values.push({ type: "Constant", pos: closing, end: closing, value: { kind: "str", value: "" } });
			formatSpec = { type: template ? "TemplateStr" : "JoinedStr", pos: colon.pos, end: closing, values };
		}
		const close = this.expect("}");
		pieces.push({
			type: template ? "Interpolation" : "FormattedValue",
			pos: open.pos,
			end: close.end,
			value,
			// A `=` shows the repr unless a conversion or a format spec says otherwise.
			conversion: conversion ?? (debug && formatSpec === undefined ? 114 : -1),
			formatSpec,
		});
		return pieces;
	}
}

////////////////////////////////
//  Main

/** The tokens of `text`, and its module or the first syntax error. */
export function parsePython(text: string): Parsed {
	const lexed = tokenize(text);
	if (lexed.error !== undefined) {
		return {
			tokens: lexed.tokens,
			lexError: lexed.error,
			error: { message: lexed.error.message, pos: lexed.error.pos },
		};
	}
	try {
		const module = new Parser(lexed.tokens, text).module();
		// Walks over the tree recurse; a left-nested chain grows it without nesting the parser.
		if (deeperThan(module, MAX_NESTING)) return { tokens: lexed.tokens, error: { message: TOO_DEEP, pos: 0 } };
		return { tokens: lexed.tokens, module };
	} catch (error) {
		if (error instanceof Failure) return { tokens: lexed.tokens, error: error.error };
		if (isTooDeep(error)) return { tokens: lexed.tokens, error: { message: TOO_DEEP, pos: 0 } };
		throw error;
	}
}

function parsedAs<T extends A.Node | A.FunctionType>(text: string, read: (parser: Parser) => T): T | undefined {
	const lexed = tokenize(text);
	if (lexed.error !== undefined) return undefined;
	try {
		const tree = read(new Parser(lexed.tokens, text));
		const roots: A.Node[] = "argtypes" in tree ? [...tree.argtypes, tree.returns] : [tree as A.Node];
		return roots.some((root) => deeperThan(root, MAX_NESTING)) ? undefined : tree;
	} catch (error) {
		if (error instanceof Failure || isTooDeep(error)) return undefined;
		throw error;
	}
}

/** `text` read as `ast.parse(text, mode="eval")` reads it; undefined when it is no expression. */
export function parseExpression(text: string): A.Expression | undefined {
	return parsedAs(text, (parser) => parser.evaluation());
}

/** `text` read as `ast.parse(text, mode="func_type")` reads it; undefined when it is no signature. */
export function parseFunctionType(text: string): A.FunctionType | undefined {
	return parsedAs(text, (parser) => parser.functionType());
}
