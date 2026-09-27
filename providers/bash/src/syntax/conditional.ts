// `[[ ]]`: conditional expressions, where `<`, `>`, `(` and `)` are operators rather than redirections.

import type { TestExpression, Word } from "./ast.js";
import { isBlank, type Scanner } from "./scanner.js";
import type { WordReader } from "./words.js";

////////////////////////////////
//  Constants

const UNARY: ReadonlySet<string> = new Set([
	"-a",
	"-b",
	"-c",
	"-d",
	"-e",
	"-f",
	"-g",
	"-h",
	"-k",
	"-p",
	"-r",
	"-s",
	"-t",
	"-u",
	"-w",
	"-x",
	"-G",
	"-L",
	"-N",
	"-O",
	"-S",
	"-z",
	"-n",
	"-o",
	"-v",
	"-R",
]);

const BINARY: ReadonlySet<string> = new Set([
	"==",
	"=",
	"!=",
	"=~",
	"<",
	">",
	"-eq",
	"-ne",
	"-lt",
	"-le",
	"-gt",
	"-ge",
	"-nt",
	"-ot",
	"-ef",
]);

/** An operand ends at a blank or any operator character. */
const OPERAND_ENDS: ReadonlySet<string> = new Set([" ", "\t", "\n", "&", "|", "(", ")", "<", ">", ";", ""]);

/** A regular expression after `=~` keeps its parentheses and bars. */
const REGEX_ENDS: ReadonlySet<string> = new Set([" ", "\t", "\n", "&", ";", "<", ">", ""]);

////////////////////////////////
//  Classes

export class ConditionalReader {
	constructor(
		private readonly scanner: Scanner,
		private readonly words: WordReader,
	) {}

	/** The expression inside `[[ ]]`; the closing `]]` is left unread. */
	read(): TestExpression | undefined {
		this.space();
		if (this.closing()) {
			this.scanner.error("the [[ holds no expression");
			return undefined;
		}
		return this.or();
	}

	/** At `]]` standing as a word of its own. */
	closing(): boolean {
		return this.scanner.startsWith("]]") && this.ended(2);
	}

	private ended(ahead: number): boolean {
		const character = this.scanner.peek(ahead);
		return (
			character === "" ||
			isBlank(character) ||
			character === "\n" ||
			character === ";" ||
			character === "&" ||
			character === "|" ||
			character === ")"
		);
	}

	private space(): void {
		let guard = -1;
		for (;;) {
			if (this.scanner.offset <= guard) throw new Error("bash conditional space failed to advance");
			guard = this.scanner.offset;
			const character = this.scanner.peek();
			if (isBlank(character) || character === "\n") this.scanner.skip();
			else if (this.scanner.atContinuation()) this.scanner.continuation();
			// Between words, `#` starts a comment here too.
			else if (character === "#") this.scanner.takeWhile("comment", (commented) => commented !== "\n");
			else return;
		}
	}

	private or(): TestExpression | undefined {
		return this.logical("||", () => this.and());
	}

	private and(): TestExpression | undefined {
		return this.logical("&&", () => this.not());
	}

	private logical(operator: "||" | "&&", operand: () => TestExpression | undefined): TestExpression | undefined {
		let left = operand();
		this.scanner.chain(() => {
			this.space();
			if (left === undefined || !this.scanner.codeText(operator)) return false;
			const right = operand();
			left =
				right === undefined
					? undefined
					: { type: "TestLogical", pos: left.pos, end: right.end, operator, left, right };
			return left !== undefined;
		});
		return left;
	}

	/** `!` prefixes are read in a loop, so a long run costs no stack, but each counts a level. */
	private not(): TestExpression | undefined {
		const negations: number[] = [];
		let operand: TestExpression | undefined;
		this.scanner.chain(() => {
			this.space();
			const pos = this.scanner.offset;
			if (!this.ended(1) || !this.scanner.codeText("!")) return false;
			negations.push(pos);
			return true;
		});
		operand = this.primary();
		for (let index = negations.length - 1; index >= 0 && operand !== undefined; index--) {
			operand = { type: "TestNot", pos: negations[index] as number, end: operand.end, operand };
		}
		return operand;
	}

	private primary(): TestExpression | undefined {
		this.space();
		const pos = this.scanner.offset;
		if (this.scanner.peek() === "(") {
			this.scanner.code();
			const expression = this.scanner.nested(() => this.or());
			this.space();
			if (expression === undefined || !this.scanner.codeText(")")) {
				this.scanner.error("the ( in [[ has no closing )", pos);
				return undefined;
			}
			return { type: "TestGroup", pos, end: this.scanner.offset, expression };
		}
		if (this.closing() || this.scanner.done) {
			this.scanner.error("the [[ expression ends early", pos);
			return undefined;
		}
		const first = this.operand();
		if (UNARY.has(first.text)) {
			this.space();
			if (
				!this.closing() &&
				!this.scanner.startsWith("&&") &&
				!this.scanner.startsWith("||") &&
				this.scanner.peek() !== ")"
			) {
				const operand = this.operand();
				return { type: "TestUnary", pos: first.pos, end: operand.end, operator: first.text, operand };
			}
		}
		this.space();
		const operator = this.binaryOperator();
		if (operator === null)
			return { type: "TestUnary", pos: first.pos, end: first.end, operator: "-n", operand: first };
		this.space();
		const right = operator === "=~" ? this.words.word({ only: REGEX_ENDS, plainGlobs: true }) : this.operand();
		return { type: "TestBinary", pos: first.pos, end: right.end, operator, left: first, right };
	}

	private binaryOperator(): string | null {
		for (const operator of ["=~", "==", "!=", "<", ">", "="]) {
			if (this.scanner.startsWith(operator) && operator.length > 0) {
				this.scanner.codeText(operator);
				return operator;
			}
		}
		if (this.scanner.peek() !== "-") return null;
		const mark = this.scanner.cursor.mark();
		const text = this.scanner.cursor.readWhile((character) => !OPERAND_ENDS.has(character));
		this.scanner.cursor.rewind(mark);
		if (!BINARY.has(text)) return null;
		this.scanner.codeText(text);
		return text;
	}

	private operand(): Word {
		return this.words.word({ only: OPERAND_ENDS });
	}
}
