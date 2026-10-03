// Bash by recursive descent over the grammar in the Bash reference manual's "Shell Syntax" chapter.
//
// Reserved words count only where a command starts, and here-document bodies are read at the line
// break that ends the line opening them, so the parser drives the scanner rather than a token list.

import { type CursorMark, isTooDeep, NestingGauge, SourceCursor, TOO_DEEP } from "@nyaa-lexicon/protocol";
import { ArithmeticReader } from "./arithmetic.js";
import type {
	ArithmeticExpression,
	AssignmentPrefix,
	CaseItem,
	CaseTerminator,
	Command,
	CompoundList,
	If,
	LogicalOperator,
	Node,
	PipeOperator,
	Redirect,
	RedirectOperator,
	Script,
	Statement,
	Token,
	Word,
	WordPart,
} from "./ast.js";
import { ConditionalReader } from "./conditional.js";
import { isBlank, isDigit, isMeta, isNameCharacter, isNameStart, type PendingHeredoc, Scanner } from "./scanner.js";
import { type Nested, WordReader } from "./words.js";

////////////////////////////////
//  Interfaces & Types

export interface Parsed {
	script: Script;
	/** Every lexical piece in source order: code, comments, continuations and here-documents. */
	tokens: Token[];
}

/** What ends a list: reserved words, `)`, or a case item's terminator. */
type Closers = ReadonlySet<string>;

////////////////////////////////
//  Constants

const RESERVED: ReadonlySet<string> = new Set([
	"if",
	"then",
	"elif",
	"else",
	"fi",
	"case",
	"esac",
	"for",
	"select",
	"while",
	"until",
	"do",
	"done",
	"in",
	"function",
	"time",
	"coproc",
	"{",
	"}",
	"!",
	"[[",
	"]]",
]);

/** Longest first. */
const REDIRECT_OPERATORS: readonly RedirectOperator[] = [
	"&>>",
	"<<<",
	"<<-",
	"&>",
	">>",
	">|",
	">&",
	"<<",
	"<>",
	"<&",
	">",
	"<",
];

/** Builtins whose `NAME=(...)` arguments are array assignments. */
const DECLARATIONS: ReadonlySet<string> = new Set(["declare", "typeset", "local", "export", "readonly"]);

const CASE_TERMINATORS: readonly CaseTerminator[] = [";;&", ";;", ";&"];
const QUOTING: ReadonlySet<string> = new Set(["SingleQuoted", "DoubleQuoted", "AnsiCQuoted", "LocaleString"]);

const NONE: Closers = new Set();
const PAREN: Closers = new Set([")"]);
const BRACE: Closers = new Set(["}"]);
const THEN: Closers = new Set(["then"]);
const IF_BODY: Closers = new Set(["elif", "else", "fi"]);
const FI: Closers = new Set(["fi"]);
const DO: Closers = new Set(["do"]);
const DONE: Closers = new Set(["done"]);
const CASE_BODY: Closers = new Set([";;", ";&", ";;&", "esac"]);

////////////////////////////////
//  Functions & Helpers

/** A line ending in an unescaped backslash, which joins it to the next. */
function endsInContinuation(line: string): boolean {
	const cursor = new SourceCursor(line);
	let run = 0;
	let guard = -1;
	while (cursor.good()) {
		if (cursor.offset <= guard) throw new Error("bash continuation scan failed to advance");
		guard = cursor.offset;
		run = cursor.next() === "\\" ? run + 1 : 0;
	}
	return run % 2 === 1;
}

////////////////////////////////
//  Classes

class BashParser implements Nested {
	readonly scanner: Scanner;
	private readonly words: WordReader;
	private readonly arithmeticReader: ArithmeticReader;
	private readonly conditional: ConditionalReader;
	/** Open `$(`, `<(` and `>(` around the cursor. */
	private substitutions = 0;

	constructor(
		text: string,
		private readonly gauge: NestingGauge,
	) {
		this.scanner = new Scanner(text, gauge);
		this.words = new WordReader(this.scanner, this);
		this.arithmeticReader = new ArithmeticReader(this.scanner, this.words);
		this.conditional = new ConditionalReader(this.scanner, this.words);
	}

	parse(): Parsed {
		const pos = this.scanner.offset;
		const shebang = this.shebang();
		let commands: Statement[] = [];
		try {
			commands = this.list(NONE);
			this.linebreak();
			while (!this.scanner.done) {
				this.scanner.error(`unexpected ${this.scanner.peek()}`);
				this.recover();
				commands.push(...this.list(NONE));
				this.linebreak();
			}
		} catch (error) {
			if (!isTooDeep(error)) throw error;
			this.scanner.error(TOO_DEEP);
		}
		this.bodies();
		const script: Script = {
			type: "Script",
			pos,
			end: this.scanner.size,
			...(shebang === undefined ? {} : { shebang }),
			commands,
			errors: this.scanner.errors,
		};
		return { script, tokens: this.scanner.tokens() };
	}

	/** The `#!` line, read ahead; the list reads it again as the comment it is. */
	private shebang(): string | undefined {
		if (!this.scanner.startsWith("#!")) return undefined;
		const cursor = this.scanner.cursor;
		const mark = cursor.mark();
		cursor.readWhile((character) => character !== "\n");
		const line = cursor.textSince(mark);
		cursor.rewind(mark);
		return line;
	}

	////////////////////////////////
	//  Nested

	subscript(): Script {
		return this.scanner.nested(() => {
			this.substitutions++;
			try {
				const pos = this.scanner.offset;
				const commands = this.list(PAREN);
				this.linebreak();
				return { type: "Script", pos, end: this.scanner.offset, commands, errors: [] };
			} finally {
				this.substitutions--;
			}
		});
	}

	arithmetic(close: string): ArithmeticExpression | undefined {
		return this.scanner.nested(() => this.arithmeticReader.read(close));
	}

	decoded(text: string, source: (offset: number) => number): Parsed {
		const parsed = new BashParser(text, this.gauge).parse();
		for (const error of parsed.script.errors) this.scanner.error(error.message, source(error.pos));
		return parsed;
	}

	////////////////////////////////
	//  Spacing

	/** Blanks, comments and line breaks; each line break reads the here-documents its line opened. */
	private linebreak(): void {
		let guard = -1;
		for (;;) {
			if (this.scanner.offset <= guard) throw new Error("bash line break scan failed to advance");
			guard = this.scanner.offset;
			this.scanner.skipSpace();
			if (this.scanner.peek() !== "\n") return;
			this.newline();
		}
	}

	private newline(): void {
		this.scanner.skip();
		this.bodies();
	}

	/** Past the rest of a line the parser could not read. */
	private recover(): void {
		let guard = -1;
		while (!this.scanner.done && this.scanner.peek() !== "\n") {
			if (this.scanner.offset <= guard) throw new Error("bash recovery failed to advance");
			guard = this.scanner.offset;
			if (this.scanner.atContinuation()) this.scanner.continuation();
			else this.scanner.code();
		}
	}

	////////////////////////////////
	//  Lookahead

	/** `word` spelled at the cursor and ending there, as a reserved word stands. */
	private reserved(word: string): boolean {
		if (!this.scanner.startsWith(word)) return false;
		const after = this.scanner.peekAfter(word);
		if (word === "{" || word === "}" || word === "!")
			return after === "" || isBlank(after) || after === "\n" || after === ";" || (word === "}" && isMeta(after));
		return isMeta(after);
	}

	/** The reserved word at the cursor, if one stands there. */
	private reservedHere(): string | null {
		for (const word of RESERVED) if (this.reserved(word)) return word;
		return null;
	}

	/** Where the list stops: a closing reserved word, `)`, or a case terminator. */
	private closes(closers: Closers): boolean {
		if (this.scanner.done) return true;
		if (closers.has(")") && this.scanner.peek() === ")") return true;
		for (const terminator of CASE_TERMINATORS)
			if (closers.has(terminator) && this.scanner.startsWith(terminator)) return true;
		for (const word of closers) if (word !== ")" && !word.startsWith(";") && this.reserved(word)) return true;
		return false;
	}

	/** `name ()` defines a function; `name=()` assigns an empty array. */
	private functionAhead(): boolean {
		if (this.assignmentAhead()) return false;
		const cursor = this.scanner.cursor;
		const mark = cursor.mark();
		try {
			const name = cursor.readWhile(
				(character) =>
					!isMeta(character) &&
					character !== "'" &&
					character !== '"' &&
					character !== "$" &&
					character !== "`" &&
					character !== "\\",
			);
			if (name === "" || RESERVED.has(name)) return false;
			// Blanks and line continuations, which bash removes before reading.
			const gap = (): void => {
				do cursor.readWhile(isBlank);
				while (cursor.take("\\\n"));
			};
			gap();
			if (!cursor.take("(")) return false;
			gap();
			return cursor.take(")");
		} finally {
			cursor.rewind(mark);
		}
	}

	/** `NAME=`, `NAME+=` or `NAME[...]=` at the cursor. */
	private assignmentAhead(): boolean {
		const cursor = this.scanner.cursor;
		const mark = cursor.mark();
		try {
			if (!isNameStart(cursor.peek())) return false;
			do cursor.readWhile(isNameCharacter);
			while (cursor.take("\\\n"));
			if (cursor.peek() === "[") {
				let depth = 0;
				let guard = -1;
				while (cursor.good()) {
					if (cursor.offset <= guard) throw new Error("bash subscript lookahead failed to advance");
					guard = cursor.offset;
					const character = cursor.next();
					if (character === "[") depth++;
					if (character === "]" && --depth === 0) break;
					if (character === "\n") return false;
					// A quoted `]` closes nothing.
					if (character === "'") cursor.readWhile((quoted) => quoted !== "'");
					if (character === '"') cursor.readWhile((quoted) => quoted !== '"');
					if ((character === "'" || character === '"') && !cursor.take(character)) return false;
					if (character === "\\") cursor.next();
				}
				if (depth !== 0) return false;
			}
			cursor.take("+");
			return cursor.peek() === "=";
		} finally {
			cursor.rewind(mark);
		}
	}

	/** A redirection operator, with its descriptor or `{name}`, at the cursor. */
	private redirectAhead(): boolean {
		const cursor = this.scanner.cursor;
		const mark = cursor.mark();
		try {
			if (isDigit(cursor.peek())) cursor.readWhile(isDigit);
			else if (cursor.peek() === "{") {
				cursor.next();
				if (!isNameStart(cursor.peek())) return false;
				cursor.readWhile(isNameCharacter);
				if (!cursor.take("}")) return false;
			}
			if ((cursor.peek() === "<" || cursor.peek() === ">") && cursor.peek(1) === "(") return false;
			return REDIRECT_OPERATORS.some((operator) => cursor.startsWith(operator));
		} finally {
			cursor.rewind(mark);
		}
	}

	////////////////////////////////
	//  Lists

	/** Statements up to a closer, which is left unread. */
	private list(closers: Closers): Statement[] {
		const statements: Statement[] = [];
		let guard = -1;
		for (;;) {
			if (this.scanner.offset <= guard) throw new Error("bash statement list failed to advance");
			guard = this.scanner.offset;
			this.linebreak();
			if (this.closes(closers)) return statements;
			const statement = this.statement(closers);
			if (statement === null) {
				if (closers !== NONE) return statements;
				this.scanner.error(`unexpected ${this.scanner.peek()}`);
				this.scanner.code();
				continue;
			}
			statements.push(statement);
		}
	}

	private compound(closers: Closers): CompoundList {
		const start = this.scanner.offset;
		const commands = this.list(closers);
		const first = commands[0];
		const last = commands.at(-1);
		return {
			type: "CompoundList",
			pos: first?.pos ?? start,
			end: last?.end ?? start,
			commands,
		};
	}

	/** One and-or list with its `;` or `&`; null when nothing starts a command here. */
	private statement(closers: Closers): Statement | null {
		const pos = this.scanner.offset;
		const node = this.andOr();
		if (node === null) return null;
		const wrapped = node.type === "Statement" ? node : null;
		const statement: Statement = {
			type: "Statement",
			pos,
			end: node.end,
			command: wrapped?.command ?? node,
			background: undefined,
			redirects: wrapped?.redirects ?? [],
		};
		this.scanner.skipSpace();
		const character = this.scanner.peek();
		if (character === "&" && this.scanner.peek(1) !== "&" && this.scanner.peek(1) !== ">") {
			this.scanner.code();
			statement.background = true;
			statement.end = this.scanner.offset;
		} else if (character === ";" && !CASE_TERMINATORS.some((terminator) => this.scanner.startsWith(terminator))) {
			this.scanner.code();
		} else if (character !== "\n" && !this.scanner.done && !this.closes(closers) && !this.closes(CASE_BODY)) {
			this.scanner.error(`unexpected ${character}`);
			this.recover();
		}
		return statement;
	}

	private andOr(): Node | null {
		const first = this.pipeline();
		if (first === null) return null;
		const commands: Node[] = [first];
		const operators: LogicalOperator[] = [];
		for (;;) {
			this.scanner.skipSpace();
			const operator = this.scanner.startsWith("&&") ? "&&" : this.scanner.startsWith("||") ? "||" : null;
			if (operator === null) break;
			this.scanner.codeText(operator);
			this.linebreak();
			const next = this.pipeline();
			if (next === null) {
				this.scanner.error(`nothing follows ${operator}`);
				break;
			}
			commands.push(next);
			operators.push(operator);
		}
		if (commands.length === 1) return first;
		return { type: "AndOr", pos: first.pos, end: (commands.at(-1) as Node).end, commands, operators };
	}

	private pipeline(): Node | null {
		this.scanner.skipSpace();
		const pos = this.scanner.offset;
		let time: boolean | undefined;
		let negated: boolean | undefined;
		if (this.reserved("time")) {
			this.scanner.codeText("time");
			time = true;
			this.scanner.skipSpace();
			if (this.scanner.startsWith("-p") && isMeta(this.scanner.peek(2))) this.scanner.codeText("-p");
			this.scanner.skipSpace();
		}
		while (this.reserved("!") && this.scanner.codeText("!")) {
			negated = negated === true ? undefined : true;
			this.scanner.skipSpace();
		}
		const first = this.command();
		if (first === null) {
			if (time === undefined && negated === undefined) return null;
			this.scanner.error("a pipeline holds no command", pos);
			return null;
		}
		const commands: Node[] = [first];
		const operators: PipeOperator[] = [];
		for (;;) {
			this.scanner.skipSpace();
			const operator = this.scanner.startsWith("|&")
				? "|&"
				: this.scanner.peek() === "|" && this.scanner.peek(1) !== "|"
					? "|"
					: null;
			if (operator === null) break;
			this.scanner.codeText(operator);
			this.linebreak();
			const next = this.command();
			if (next === null) {
				this.scanner.error(`nothing follows ${operator}`);
				break;
			}
			commands.push(next);
			operators.push(operator);
		}
		if (commands.length === 1 && time === undefined && negated === undefined) return first;
		const pipeline: Node = {
			type: "Pipeline",
			pos,
			end: (commands.at(-1) as Node).end,
			commands,
			negated,
			operators,
			time,
		};
		return pipeline;
	}

	////////////////////////////////
	//  Commands

	private command(): Node | null {
		this.scanner.skipSpace();
		if (this.scanner.done) return null;
		return this.scanner.nested(() => {
			const compound = this.compoundCommand();
			if (compound === undefined) return this.simpleCommand();
			if (compound === null) return null;
			return this.redirected(compound);
		});
	}

	/** A compound command's trailing redirections wrap it in a statement. */
	private redirected(node: Node): Node {
		const redirects = this.redirects();
		if (redirects.length === 0) return node;
		return {
			type: "Statement",
			pos: node.pos,
			end: (redirects.at(-1) as Redirect).end,
			command: node,
			background: undefined,
			redirects,
		};
	}

	/** A compound command or function definition; undefined when a simple command starts here, null when nothing does. */
	private compoundCommand(): Node | null | undefined {
		const word = this.reservedHere();
		switch (word) {
			case "if":
				return this.ifClause("if");
			case "for":
				return this.forClause();
			case "select":
				return this.selectClause();
			case "while":
			case "until":
				return this.whileClause(word);
			case "case":
				return this.caseClause();
			case "function":
				return this.functionKeyword();
			case "{":
				return this.braceGroup();
			case "[[":
				return this.testCommand();
			case "coproc":
				return this.coproc();
			case "then":
			case "elif":
			case "else":
			case "fi":
			case "do":
			case "done":
			case "esac":
			case "}":
			case "in":
			case "]]":
				return null;
		}
		if (this.scanner.startsWith("((")) return this.arithmeticCommand();
		if (this.scanner.peek() === "(") return this.subshell();
		if (this.scanner.peek() === ")") return null;
		if (this.functionAhead()) return this.functionDefinition(this.scanner.offset);
		return undefined;
	}

	private keyword(word: string): boolean {
		this.linebreak();
		if (!this.reserved(word)) {
			this.scanner.error(`${word} was expected`);
			return false;
		}
		this.scanner.codeText(word);
		return true;
	}

	private ifClause(opener: "if" | "elif"): If {
		const pos = this.scanner.offset;
		this.scanner.codeText(opener);
		const clause = this.compound(THEN);
		this.keyword("then");
		const then = this.compound(IF_BODY);
		this.linebreak();
		let otherwise: If | CompoundList | undefined;
		if (this.reserved("elif")) {
			otherwise = this.scanner.nested(() => this.ifClause("elif"));
			return { type: "If", pos, end: otherwise.end, clause, then, else: otherwise };
		}
		if (this.reserved("else")) {
			this.scanner.codeText("else");
			otherwise = this.compound(FI);
		}
		this.keyword("fi");
		return { type: "If", pos, end: this.scanner.offset, clause, then, else: otherwise };
	}

	private whileClause(kind: "while" | "until"): Node {
		const pos = this.scanner.offset;
		this.scanner.codeText(kind);
		const clause = this.compound(DO);
		const body = this.doGroup();
		return { type: "While", pos, end: this.scanner.offset, kind, clause, body };
	}

	/** `do ... done`, or the `{ ... }` bash also takes after a `for` header. */
	private doGroup(): CompoundList {
		this.linebreak();
		if (this.reserved("{")) {
			this.scanner.code();
			const body = this.compound(BRACE);
			this.keyword("}");
			return body;
		}
		this.keyword("do");
		const body = this.compound(DONE);
		this.keyword("done");
		return body;
	}

	private forClause(): Node {
		const pos = this.scanner.offset;
		this.scanner.codeText("for");
		this.scanner.skipSpace();
		if (this.scanner.startsWith("((")) return this.arithmeticFor(pos);
		const name = this.words.word();
		const wordlist = this.wordlist();
		const body = this.doGroup();
		return { type: "For", pos, end: this.scanner.offset, name, wordlist, body };
	}

	private selectClause(): Node {
		const pos = this.scanner.offset;
		this.scanner.codeText("select");
		this.scanner.skipSpace();
		const name = this.words.word();
		const wordlist = this.wordlist();
		const body = this.doGroup();
		return { type: "Select", pos, end: this.scanner.offset, name, wordlist, body };
	}

	/** `in words` up to `;` or a line break; none when `in` is absent. */
	private wordlist(): Word[] {
		this.linebreak();
		const words: Word[] = [];
		if (this.reserved("in")) {
			this.scanner.codeText("in");
			for (;;) {
				this.scanner.skipSpace();
				if (!this.words.startsWord()) break;
				words.push(this.words.word());
			}
		}
		this.scanner.skipSpace();
		if (this.scanner.peek() === ";") this.scanner.code();
		return words;
	}

	private arithmeticFor(pos: number): Node {
		this.scanner.codeText("((");
		const initialize = this.arithmetic(";");
		this.scanner.codeText(";");
		const test = this.arithmetic(";");
		this.scanner.codeText(";");
		const update = this.arithmetic("))");
		if (!this.scanner.codeText("))")) this.scanner.error("the for (( has no closing ))", pos);
		this.scanner.skipSpace();
		if (this.scanner.peek() === ";") this.scanner.code();
		const body = this.doGroup();
		return { type: "ArithmeticFor", pos, end: this.scanner.offset, initialize, test, update, body };
	}

	private caseClause(): Node {
		const pos = this.scanner.offset;
		this.scanner.codeText("case");
		this.scanner.skipSpace();
		const word = this.words.word();
		this.keyword("in");
		const items: CaseItem[] = [];
		let guard = -1;
		for (;;) {
			if (this.scanner.offset <= guard) throw new Error("bash case items failed to advance");
			guard = this.scanner.offset;
			this.linebreak();
			if (this.scanner.done || this.reserved("esac")) break;
			const item = this.caseItem();
			if (item === null) break;
			items.push(item);
		}
		this.keyword("esac");
		return { type: "Case", pos, end: this.scanner.offset, word, items };
	}

	private caseItem(): CaseItem | null {
		const pos = this.scanner.offset;
		if (this.scanner.peek() === "(") this.scanner.code();
		const pattern: Word[] = [];
		for (;;) {
			this.scanner.skipSpace();
			if (!this.words.startsWord()) break;
			pattern.push(this.words.word());
			this.scanner.skipSpace();
			if (this.scanner.peek() !== "|" || !this.scanner.codeText("|")) break;
		}
		this.scanner.skipSpace();
		if (pattern.length === 0 || !this.scanner.codeText(")")) {
			this.scanner.error("a case item has no pattern and )", pos);
			this.recover();
			return null;
		}
		const patternEnd = this.scanner.offset;
		const body = this.compound(CASE_BODY);
		const terminator = CASE_TERMINATORS.find((candidate) => this.scanner.startsWith(candidate));
		if (terminator !== undefined) this.scanner.codeText(terminator);
		// An item `esac` closes ends at its last command, not at the space before `esac`.
		const end = terminator !== undefined ? this.scanner.offset : body.commands.length > 0 ? body.end : patternEnd;
		return {
			type: "CaseItem",
			pos,
			end,
			pattern,
			body: body.commands.length === 0 ? { ...body, pos: end, end } : body,
			terminator,
		};
	}

	private braceGroup(): Node {
		const pos = this.scanner.offset;
		this.scanner.code();
		const body = this.compound(BRACE);
		this.keyword("}");
		return { type: "BraceGroup", pos, end: this.scanner.offset, body };
	}

	private subshell(): Node {
		const pos = this.scanner.offset;
		this.scanner.code();
		const body = this.compound(PAREN);
		this.linebreak();
		if (!this.scanner.codeText(")")) this.scanner.error("the ( has no closing )", pos);
		return { type: "Subshell", pos, end: this.scanner.offset, body };
	}

	private arithmeticCommand(): Node {
		const pos = this.scanner.offset;
		this.scanner.codeText("((");
		const bodyPos = this.scanner.offset;
		const expression = this.arithmetic("))");
		const body = this.scanner.textOf(bodyPos);
		if (!this.scanner.codeText("))")) this.scanner.error("the (( has no closing ))", pos);
		return { type: "ArithmeticCommand", pos, end: this.scanner.offset, expression, body };
	}

	private testCommand(): Node {
		const pos = this.scanner.offset;
		this.scanner.codeText("[[");
		const expression = this.conditional.read();
		this.linebreak();
		if (!this.conditional.closing()) {
			this.scanner.error("the [[ has no closing ]]", pos);
			this.recover();
		} else this.scanner.codeText("]]");
		if (expression === undefined) {
			const empty: Word = { pos, end: pos, text: "", value: "" };
			return {
				type: "TestCommand",
				pos,
				end: this.scanner.offset,
				expression: { type: "TestUnary", pos, end: pos, operator: "-n", operand: empty },
			};
		}
		return { type: "TestCommand", pos, end: this.scanner.offset, expression };
	}

	private coproc(): Node {
		const pos = this.scanner.offset;
		this.scanner.codeText("coproc");
		this.scanner.skipSpace();
		let name: Word | undefined;
		const bodyAhead = this.reservedHere() !== null || this.scanner.peek() === "(";
		if (!bodyAhead && isNameStart(this.scanner.peek())) {
			const mark = this.scanner.cursor.mark();
			const plainName = this.scanner.cursor.readWhile(isNameCharacter);
			this.scanner.cursor.readWhile(isBlank);
			const compoundNext =
				this.scanner.peek() === "{" ||
				this.scanner.peek() === "(" ||
				["while", "until", "if", "for", "case", "select", "[["].some((word) => this.reserved(word));
			this.scanner.cursor.rewind(mark);
			if (compoundNext && plainName !== "") name = this.words.word();
		}
		const body = this.command();
		if (body === null) {
			this.scanner.error("coproc runs no command", pos);
			const empty: Node = { type: "CompoundList", pos, end: pos, commands: [] };
			return { type: "Coproc", pos, end: this.scanner.offset, name, body: empty, redirects: [] };
		}
		const inner = body.type === "Statement" ? body.command : body;
		const redirects = body.type === "Statement" ? body.redirects : [];
		return { type: "Coproc", pos, end: body.end, name, body: inner, redirects };
	}

	private functionKeyword(): Node {
		const pos = this.scanner.offset;
		this.scanner.codeText("function");
		this.scanner.skipSpace();
		return this.functionDefinition(pos);
	}

	private functionDefinition(pos: number): Node {
		const name = this.words.word();
		this.scanner.skipSpace();
		if (this.scanner.peek() === "(") {
			this.scanner.code();
			this.scanner.skipSpace();
			if (!this.scanner.codeText(")")) this.scanner.error("the function name has ( with no )", pos);
		}
		this.linebreak();
		const body = this.command();
		if (body === null) {
			this.scanner.error(`function ${name.value} has no body`, pos);
			const empty: Node = {
				type: "CompoundList",
				pos: this.scanner.offset,
				end: this.scanner.offset,
				commands: [],
			};
			return { type: "Function", pos, end: this.scanner.offset, name, body: empty, redirects: [] };
		}
		const inner = body.type === "Statement" ? body.command : body;
		const redirects = body.type === "Statement" ? body.redirects : [];
		return { type: "Function", pos, end: body.end, name, body: inner, redirects };
	}

	private simpleCommand(): Command | null {
		const pos = this.scanner.offset;
		const prefix: AssignmentPrefix[] = [];
		const suffix: Word[] = [];
		const redirects: Redirect[] = [];
		let name: Word | undefined;
		let guard = -1;
		for (;;) {
			if (this.scanner.offset <= guard) throw new Error("bash simple command failed to advance");
			guard = this.scanner.offset;
			this.scanner.skipSpace();
			if (this.scanner.done) break;
			if (this.redirectAhead()) {
				redirects.push(this.redirect());
				continue;
			}
			if (!this.words.startsWord()) break;
			if (name === undefined && this.assignmentAhead()) {
				prefix.push(this.assignment());
				continue;
			}
			if (name === undefined) {
				name = this.words.word();
				continue;
			}
			suffix.push(this.words.word({ arrayValue: DECLARATIONS.has(name.value) }));
		}
		if (name === undefined && prefix.length === 0 && redirects.length === 0) return null;
		const ends = [name?.end, suffix.at(-1)?.end, prefix.at(-1)?.end, redirects.at(-1)?.end].filter(
			(end) => end !== undefined,
		) as number[];
		return { type: "Command", pos, end: Math.max(pos, ...ends), name, prefix, suffix, redirects };
	}

	private assignment(): AssignmentPrefix {
		const pos = this.scanner.offset;
		let name = this.scanner.codeWhile(isNameCharacter);
		// Bash removes a line continuation before it reads the name.
		let guard = -1;
		while (this.scanner.atContinuation()) {
			if (this.scanner.offset <= guard) throw new Error("bash assignment name failed to advance");
			guard = this.scanner.offset;
			this.scanner.continuation();
			name += this.scanner.codeWhile(isNameCharacter);
		}
		const assignment: AssignmentPrefix = {
			type: "Assignment",
			pos,
			end: pos,
			text: "",
			name,
			value: undefined,
			append: undefined,
			index: undefined,
			array: undefined,
		};
		if (this.scanner.peek() === "[") this.assignmentIndex(assignment);
		if (this.scanner.peek() === "+") {
			this.scanner.code();
			assignment.append = true;
		}
		this.scanner.code();
		if (this.scanner.peek() === "(") {
			const open = this.scanner.offset;
			const array = this.arrayValue();
			if (this.words.startsWord()) assignment.value = this.listWord(open, array);
			else assignment.array = array;
		} else if (this.words.startsWord() && !this.redirectAhead()) assignment.value = this.words.word();
		else assignment.value = { pos: this.scanner.offset, end: this.scanner.offset, text: "", value: "" };
		assignment.end = this.scanner.offset;
		assignment.text = this.scanner.textOf(pos, assignment.end);
		return assignment;
	}

	/** `NAME[...]` in an assignment: the subscript's text, and its parts when it expands. */
	private assignmentIndex(assignment: AssignmentPrefix): void {
		const open = this.scanner.offset;
		this.scanner.code();
		const pos = this.scanner.offset;
		const parts: WordPart[] = [];
		let depth = 1;
		let guard = -1;
		while (!this.scanner.done) {
			if (this.scanner.offset <= guard) throw new Error("bash assignment subscript failed to advance");
			guard = this.scanner.offset;
			const character = this.scanner.peek();
			if (character === "[") depth++;
			if (character === "]" && --depth === 0) break;
			if (character === "$" || character === "`" || character === "'" || character === '"') {
				const word = this.words.word({ only: new Set(["]", "[", "\n", ""]), plainGlobs: true });
				parts.push(...(word.parts ?? []));
				continue;
			}
			this.scanner.code();
		}
		assignment.index = this.scanner.textOf(pos);
		if (parts.some((part) => part.type !== "Literal")) assignment.indexParts = parts;
		if (!this.scanner.codeText("]")) this.scanner.error("the subscript has no closing ]", open);
	}

	/** `(elements...)`: words, with line breaks and comments between them. */
	private arrayValue(): Word[] {
		const pos = this.scanner.offset;
		this.scanner.code();
		const elements: Word[] = [];
		let guard = -1;
		for (;;) {
			if (this.scanner.offset <= guard) throw new Error("bash array value failed to advance");
			guard = this.scanner.offset;
			this.linebreak();
			if (this.scanner.done) {
				this.scanner.error("the array value has no closing )", pos);
				break;
			}
			if (this.scanner.codeText(")")) break;
			if (!this.words.startsWord()) {
				this.scanner.error(`unexpected ${this.scanner.peek()} in an array value`);
				this.scanner.code();
				continue;
			}
			elements.push(this.words.word());
		}
		return elements;
	}

	/** `NAME=(...)x` assigns no array: bash reads the list and what follows as one word. */
	private listWord(pos: number, elements: Word[]): Word {
		const rest = this.words.word();
		const text = this.scanner.textOf(pos, rest.end);
		const parts = [...elements, rest].flatMap((word) => word.parts ?? []).filter((part) => part.type !== "Literal");
		const word: Word = { pos, end: rest.end, text, value: text };
		if (parts.length > 0) word.parts = parts;
		return word;
	}

	private redirects(): Redirect[] {
		const redirects: Redirect[] = [];
		for (;;) {
			this.scanner.skipSpace();
			if (!this.redirectAhead()) return redirects;
			redirects.push(this.redirect());
		}
	}

	private redirect(): Redirect {
		const pos = this.scanner.offset;
		let fileDescriptor: number | undefined;
		let variableName: string | undefined;
		if (isDigit(this.scanner.peek())) {
			fileDescriptor = Number(this.scanner.codeWhile(isDigit));
		} else if (this.scanner.peek() === "{") {
			this.scanner.code();
			variableName = this.scanner.codeWhile(isNameCharacter);
			this.scanner.code();
		}
		const operator = REDIRECT_OPERATORS.find((candidate) => this.scanner.startsWith(candidate)) as RedirectOperator;
		this.scanner.codeText(operator);
		this.scanner.skipBlanks();
		const target = this.words.startsWord() ? this.words.word() : undefined;
		if (target === undefined) this.scanner.error(`${operator} has no target`, pos);
		const redirect: Redirect = {
			pos,
			end: this.scanner.offset,
			operator,
			target,
			fileDescriptor,
			variableName,
			content: target?.value,
			heredocQuoted: undefined,
			body: undefined,
			closing: undefined,
		};
		if ((operator === "<<" || operator === "<<-") && target !== undefined) {
			// Quotes or escapes in the delimiter keep the body literal; an expansion there is only text.
			const quoted =
				target.parts === undefined
					? target.text !== target.value
					: target.parts.some(
							(part) => QUOTING.has(part.type) || (part.type === "Literal" && part.text !== part.value),
						);
			redirect.heredocQuoted = quoted ? true : undefined;
			redirect.content = "";
			this.scanner.heredocs.push({ redirect, delimiter: target.value, strip: operator === "<<-" });
		}
		return redirect;
	}

	////////////////////////////////
	//  Here-documents

	/** Reads every pending here-document body, in the order their lines opened them. */
	private bodies(): void {
		const pending = this.scanner.heredocs.splice(0);
		for (const heredoc of pending) {
			const cursor = this.scanner.cursor;
			const start = cursor.mark();
			let end = cursor.offset;
			let delimiter: { pos: number; end: number; line: boolean } | undefined;
			let guard = -1;
			while (cursor.good()) {
				if (cursor.offset <= guard) throw new Error("bash here-document scan failed to advance");
				guard = cursor.offset;
				const lineStart = cursor.mark();
				if (heredoc.strip) cursor.readWhile((character) => character === "\t");
				const at = cursor.offset;
				let line = cursor.readWhile((character) => character !== "\n");
				// An unquoted delimiter is matched after bash removes line continuations.
				let joined = false;
				while (heredoc.redirect.heredocQuoted !== true && endsInContinuation(line) && cursor.peek() === "\n") {
					cursor.next();
					line = line.slice(0, -1) + cursor.readWhile((character) => character !== "\n");
					joined = true;
				}
				const whole = line === heredoc.delimiter;
				// In a substitution, bash also ends the body where `)` follows the delimiter, as at end-of-file.
				const early =
					!joined &&
					this.substitutions > 0 &&
					line.startsWith(heredoc.delimiter) &&
					line.charAt(heredoc.delimiter.length) === ")";
				if (whole || early) {
					end = lineStart.offset;
					delimiter = {
						pos: lineStart.offset,
						end: whole ? cursor.offset : at + heredoc.delimiter.length,
						line: whole,
					};
					cursor.rewind(lineStart);
					break;
				}
				cursor.take("\n");
				end = cursor.offset;
			}
			// Found by a raw scan; read again through the word reader from the body's start.
			cursor.rewind(start);
			this.readBody(heredoc, start, end);
			if (delimiter !== undefined) {
				this.scanner.takeTo("delimiter", delimiter.end);
				if (delimiter.line && this.scanner.peek() === "\n") this.scanner.skip();
			}
			heredoc.redirect.closing =
				delimiter?.line === true ? { pos: delimiter.pos, end: delimiter.end } : undefined;
		}
	}

	/** The body from `start` to `end`, placed as one here-document token. */
	private readBody(heredoc: PendingHeredoc, start: CursorMark, end: number): void {
		this.scanner.hush();
		const pos = start.offset;
		let body: Word;
		if (heredoc.redirect.heredocQuoted === true) {
			let value = "";
			let guard = -1;
			while (this.scanner.offset < end) {
				if (this.scanner.offset <= guard) throw new Error("bash here-document read failed to advance");
				guard = this.scanner.offset;
				if (heredoc.strip) this.scanner.codeWhile((character) => character === "\t");
				value += this.scanner.codeWhile((character) => character !== "\n");
				if (this.scanner.offset < end) value += this.scanner.code();
			}
			body = { pos, end, text: this.scanner.textOf(pos, end), value };
		} else {
			body = this.words.heredocBody(end, heredoc.strip);
		}
		this.scanner.loud();
		if (end > pos) this.scanner.placeToken({ kind: "heredoc", pos, end, line: start.line, column: start.column });
		heredoc.redirect.content = body.text;
		heredoc.redirect.body = body;
	}
}

////////////////////////////////
//  Functions

/** A script with every token placed; errors ride the script. */
export function parseBashScript(text: string): Parsed {
	return new BashParser(text, new NestingGauge()).parse();
}

/** Arithmetic in `text`, as though it sat at `at`: `let` operands and array subscripts. */
export function parseArithmeticAt(text: string, at: number): ArithmeticExpression | undefined {
	const parser = new BashParser(`((${text}))`, new NestingGauge());
	parser.scanner.codeText("((");
	const expression = parser.arithmetic("))");
	if (
		parser.scanner.errors.length > 0 ||
		!parser.scanner.startsWith("))") ||
		parser.scanner.offset !== text.length + 2
	)
		return undefined;
	return expression === undefined ? undefined : shifted(expression, at - 2);
}

function shifted(expression: ArithmeticExpression, by: number): ArithmeticExpression {
	const stack: unknown[] = [expression];
	const seen = new Set<object>();
	while (stack.length > 0) {
		const current = stack.pop();
		if (current === null || typeof current !== "object" || seen.has(current)) continue;
		seen.add(current);
		const record = current as Record<string, unknown>;
		if (typeof record["pos"] === "number" && typeof record["end"] === "number") {
			record["pos"] = (record["pos"] as number) + by;
			record["end"] = (record["end"] as number) + by;
		}
		for (const value of Object.values(record)) if (value !== null && typeof value === "object") stack.push(value);
	}
	return expression;
}
