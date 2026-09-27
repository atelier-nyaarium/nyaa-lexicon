// The one reading of which `<` and `>` tokens are type brackets, for every angle depth and header.

import { KEYWORDS, OPERAND_WORDS, type RustToken } from "./tokens.js";

////////////////////////////////
//  Interfaces & Types

/** A type or pattern reads every `<` as a bracket; an expression only a turbofish's or a path's. */
type Mode = "type" | "expression";

/** What the `{` after an item's header opens; the rest hold no body. */
type Item = "fn" | "struct" | "enum" | "items" | "macro" | "value" | "alias" | "use";

type Kind =
	/** A file, or a module, trait, impl or extern body. */
	| "items"
	/** A struct, union or struct variant body. */
	| "fields"
	| "variants"
	/** Statements, and every other brace. */
	| "block"
	/** Parentheses or square brackets. */
	| "group"
	| "angle"
	/** A closure's parameters. */
	| "closure"
	/** An `as` or `->` type, ended by the first token that cannot continue it. */
	| "cast"
	/** An item before its body. */
	| "header"
	| "let"
	| "discriminant";

interface Frame {
	kind: Kind;
	mode: Mode;
	closer: "" | ")" | "]" | "}" | ">" | "|";
	item?: Item;
	/** A condition's `let`, which the body's `{` ends. */
	condition?: boolean;
	/** A cast awaiting a type segment rather than a joiner. */
	expecting?: boolean;
}

export interface TypeBrackets {
	/** Net angle depth change at a token index; absent is zero. */
	deltas: ReadonlyMap<number, number>;
	/** Each bracket's offset, ascending; a `>>` closing two lists is two. */
	offsets: readonly number[];
}

////////////////////////////////
//  Constants

const ANGLE_TOKENS = new Set(["<", "<<", "<=", "<<=", ">", ">>", ">=", ">>="]);

/** Words a type segment still follows. */
const TYPE_PREFIX_WORDS = new Set(["mut", "const", "dyn", "impl", "fn", "unsafe", "extern", "for"]);

/** A `let` after one of these is a condition. */
const CONDITION_WORDS = new Set(["if", "while", "&&", "||"]);

/** Frames an item keyword starts an item in. */
const ITEM_HOLDERS = new Set<Kind>(["items", "fields", "block"]);

const ITEM_WORDS = new Map<string, Item>([
	["fn", "fn"],
	["struct", "struct"],
	["enum", "enum"],
	["trait", "items"],
	["impl", "items"],
	["mod", "items"],
	["static", "value"],
	["type", "alias"],
	["use", "use"],
]);

////////////////////////////////
//  Functions & Helpers

function frame(kind: Kind, mode: Mode, closer: Frame["closer"] = ""): Frame {
	return { kind, mode, closer };
}

function isSymbol(token: RustToken | undefined, value: string): boolean {
	return token?.kind === "symbol" && token.value === value;
}

/** A keyword as written, never a raw identifier spelling it. */
function isWord(token: RustToken | undefined, word: string): boolean {
	return token?.kind === "identifier" && token.raw === word;
}

/** The body that replaces a header at its `{`; none keeps the header and opens a block. */
function bodyOf(item: Item | undefined): Frame | undefined {
	if (item === "fn" || item === "macro") return frame("block", "expression", "}");
	if (item === "struct") return frame("fields", "type", "}");
	if (item === "enum") return frame("variants", "type", "}");
	if (item === "items") return frame("items", "type", "}");
	return undefined;
}

export function typeBrackets(tokens: readonly RustToken[]): TypeBrackets {
	return new BracketReader(tokens).read();
}

////////////////////////////////
//  Classes

class BracketReader {
	private readonly deltas = new Map<number, number>();
	private readonly offsets: number[] = [];
	private readonly frames: Frame[] = [frame("items", "type")];
	private previous: RustToken | undefined;
	/** The previous token closed a bracket, so it ended an operand. */
	private previousClosed = false;

	constructor(private readonly tokens: readonly RustToken[]) {}

	read(): TypeBrackets {
		for (let index = 0; index < this.tokens.length; index++) {
			const token = this.tokens[index] as RustToken;
			this.endCasts(token);
			this.endCondition(token);
			const angle = token.kind === "symbol" && ANGLE_TOKENS.has(token.value);
			const closed = angle && this.angles(index, token);
			if (!angle) this.other(index, token);
			this.previous = token;
			this.previousClosed = closed;
		}
		return { deltas: this.deltas, offsets: this.offsets };
	}

	private top(): Frame {
		return this.frames.at(-1) as Frame;
	}

	/** Each piece of `<<` or `>>` in turn; true when the last one closed a bracket. */
	private angles(index: number, token: RustToken): boolean {
		let closed = false;
		let delta = 0;
		for (let at = 0; at < token.value.length; at++) {
			const piece = token.value[at];
			const top = this.top();
			if (piece === "<") {
				// An operator's first piece makes the rest of it operator too.
				if (top.mode === "expression" && !(at === 0 && this.opensPath(token))) break;
				this.frames.push(frame("angle", "type", ">"));
				delta++;
				closed = false;
			} else if (piece === ">" && top.kind === "angle") {
				this.pop();
				delta--;
				closed = true;
			} else {
				break;
			}
			this.offsets.push(token.startOffset + at);
		}
		if (delta !== 0) this.deltas.set(index, delta);
		return closed;
	}

	private other(index: number, token: RustToken): void {
		const top = this.top();
		const value = token.kind === "symbol" ? token.value : "";
		if (value === ")" || value === "]" || value === "}") this.closeGroup(value);
		else if (value === "(" || value === "[") this.frames.push(this.group(index, value, top));
		else if (value === "{") this.brace(index, top);
		else if (value === ";") this.semicolon();
		else if (value === "=") this.equals(top);
		else if (value === "," && top.kind === "discriminant") this.pop();
		else if (value === "|" && top.kind === "closure") this.pop();
		else if (value === "|" && top.mode === "expression" && !this.endsOperand()) {
			this.frames.push(frame("closure", "type", "|"));
		} else if (value === "->" && top.mode === "expression") this.pushCast();
		else if (token.kind === "identifier") this.word(index, token, top);
	}

	private word(index: number, token: RustToken, top: Frame): void {
		const item = ITEM_HOLDERS.has(top.kind) ? this.itemAt(index, token) : undefined;
		if (item !== undefined) {
			this.frames.push({ ...frame("header", "type"), item });
			return;
		}
		if (top.mode !== "expression") return;
		if (isWord(token, "let")) {
			const condition = [...CONDITION_WORDS].some(
				(word) => isWord(this.previous, word) || isSymbol(this.previous, word),
			);
			this.frames.push({ ...frame("let", "type"), condition });
		} else if (isWord(token, "as")) {
			this.pushCast();
		}
	}

	/** The item a keyword starts; contextual ones only before a name. */
	private itemAt(index: number, token: RustToken): Item | undefined {
		if (token.raw !== token.value) return undefined;
		const next = this.tokens[index + 1];
		const named = next?.kind === "identifier" && !KEYWORDS.has(next.value);
		if (token.value === "const") return named ? "value" : undefined;
		if (token.value === "union") return named ? "struct" : undefined;
		if (token.value === "macro_rules") return isSymbol(next, "!") ? "macro" : undefined;
		if (token.value === "extern") return isWord(next, "crate") ? "use" : undefined;
		return ITEM_WORDS.get(token.value);
	}

	/** Attributes and macro arguments hold expressions; other groups keep the mode. */
	private group(index: number, value: "(" | "[", top: Frame): Frame {
		const before = this.tokens[index - 1];
		const attribute =
			value === "[" &&
			(isSymbol(before, "#") || (isSymbol(before, "!") && isSymbol(this.tokens[index - 2], "#")));
		const expression = attribute || this.isMacroCall(index) || (top.kind === "header" && top.item === "macro");
		return frame("group", expression ? "expression" : top.mode, value === "(" ? ")" : "]");
	}

	private brace(index: number, top: Frame): void {
		const body = top.kind === "header" ? bodyOf(top.item) : undefined;
		if (body !== undefined) {
			this.frames.pop();
			this.frames.push(body);
		} else if (top.kind === "variants") {
			this.frames.push(frame("fields", "type", "}"));
		} else if (top.kind === "items" && !this.isMacroCall(index)) {
			this.frames.push(frame("items", "type", "}"));
		} else {
			this.frames.push(frame("block", "expression", "}"));
		}
	}

	private isMacroCall(index: number): boolean {
		return isSymbol(this.tokens[index - 1], "!") && this.tokens[index - 2]?.kind === "identifier";
	}

	private semicolon(): void {
		// A `;` never sits inside a bracket list or a closure's parameters.
		while (this.top().kind === "angle" || this.top().kind === "closure") this.frames.pop();
		const top = this.top();
		// An array type's length.
		if (top.kind === "group" && top.closer === "]" && top.mode === "type") top.mode = "expression";
		else if (top.kind === "header" || top.kind === "let") this.pop();
	}

	private equals(top: Frame): void {
		if (top.kind === "let" || (top.kind === "header" && top.item === "value")) top.mode = "expression";
		else if (top.kind === "variants") this.frames.push(frame("discriminant", "expression"));
	}

	/** Pops through the group `closer` ends; a stray closer changes nothing. */
	private closeGroup(closer: string): void {
		for (let depth = this.frames.length - 1; depth > 0; depth--) {
			if ((this.frames[depth] as Frame).closer !== closer) continue;
			this.frames.length = depth + 1;
			this.pop();
			return;
		}
	}

	private pop(): void {
		if (this.frames.length > 1) this.frames.pop();
		const top = this.top();
		if (top.kind === "cast") top.expecting = false;
	}

	private pushCast(): void {
		this.frames.push({ ...frame("cast", "type"), expecting: true });
	}

	/** Ends every cast `token` cannot continue. */
	private endCasts(token: RustToken): void {
		while (this.top().kind === "cast" && !this.continuesCast(this.top(), token)) this.frames.pop();
	}

	/** A condition's `let` ends at its body, or at the next condition joined to it. */
	private endCondition(token: RustToken): void {
		const top = this.top();
		if (top.kind !== "let" || top.condition !== true || top.mode !== "expression") return;
		if (isSymbol(token, "{") || isSymbol(token, "&&") || isSymbol(token, "||")) this.frames.pop();
	}

	private continuesCast(cast: Frame, token: RustToken): boolean {
		const value = token.value;
		if (token.kind === "identifier") {
			if (cast.expecting !== true) return false;
			cast.expecting = TYPE_PREFIX_WORDS.has(value);
			return true;
		}
		if (token.kind === "lifetime") return cast.expecting === true;
		if (token.kind !== "symbol") return false;
		if (value === "<" || value === "<<") return true;
		if (value === "::" || value === "->") {
			cast.expecting = true;
			return true;
		}
		if (cast.expecting !== true) return false;
		// The never type.
		if (value === "!") cast.expecting = false;
		return value === "!" || value === "&" || value === "&&" || value === "*" || value === "(" || value === "[";
	}

	/** A turbofish, or a qualified path where an operand starts; `<=` never opens. */
	private opensPath(token: RustToken): boolean {
		if (token.value !== "<" && token.value !== "<<") return false;
		return isSymbol(this.previous, "::") || !this.endsOperand();
	}

	private endsOperand(): boolean {
		const token = this.previous;
		if (token === undefined) return false;
		if (token.kind === "number" || token.kind === "string" || token.kind === "char") return true;
		if (token.kind === "identifier") return !KEYWORDS.has(token.value) || OPERAND_WORDS.has(token.value);
		if (token.kind === "lifetime") return false;
		return this.previousClosed || [")", "]", "}", "?"].includes(token.value);
	}
}
