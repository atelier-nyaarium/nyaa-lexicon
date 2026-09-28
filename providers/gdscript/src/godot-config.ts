// Owns Godot's text resource format (`project.godot`, `.tscn`), as its VariantParser reads it.

import { type CursorMark, isTooDeep, NestingGauge, type Position, SourceCursor } from "@nyaa-lexicon/protocol";
import { isDigit, isHexDigit } from "./characters.js";

////////////////////////////////
//  Interfaces & Types

export type ConfigValue =
	| { kind: "string"; value: string }
	| { kind: "number"; text: string }
	| { kind: "color"; text: string }
	/** `true`, `null`, `inf` and the like. */
	| { kind: "word"; name: string }
	/** `ExtResource("1")`, `Vector2(0, 1)`; a typed container's parameters come first. */
	| { kind: "call"; name: string; arguments: ConfigValue[] }
	| { kind: "array"; items: ConfigValue[] }
	| { kind: "dictionary"; entries: Array<readonly [ConfigValue, ConfigValue]> };

export interface ConfigSection {
	/** Empty before the first tag. */
	name: string;
	/** A scene tag's own fields, as in `[node name="Root" type="Node2D"]`. */
	fields: ReadonlyMap<string, ConfigValue>;
	/** The `key = value` lines under the tag. */
	properties: ReadonlyMap<string, ConfigValue>;
}

export interface ConfigProblem {
	position: Position;
	message: string;
}

export interface ConfigRead {
	sections: ConfigSection[];
	/** The first error; sections before it stand, as Godot keeps them. */
	problem?: ConfigProblem;
}

interface MutableSection {
	name: string;
	fields: Map<string, ConfigValue>;
	properties: Map<string, ConfigValue>;
}

export interface ConfigOptions {
	/** A tag is its raw name, as project settings read it. */
	simpleTags?: boolean;
	/** Stop at the end of this many tags. */
	tags?: number;
	/** Skip a leading byte order mark, as Godot's scene loader does. */
	skipByteOrderMark?: boolean;
}

////////////////////////////////
//  Constants

const ESCAPES: Readonly<Record<string, string>> = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r" };

const LITERAL_WORDS = new Set(["true", "false", "null", "nil", "inf", "inf_neg", "nan"]);

const BYTE_ORDER_MARK = String.fromCodePoint(0xfeff);

////////////////////////////////
//  Functions & Helpers

/** VariantParser's identifier: ASCII only. */
function isWordStart(character: string): boolean {
	return character === "_" || (character >= "a" && character <= "z") || (character >= "A" && character <= "Z");
}

function isWordPart(character: string): boolean {
	return isWordStart(character) || isDigit(character);
}

/** Every control character and the space separate tokens. */
function isSpace(character: string): boolean {
	return character !== "" && character.charCodeAt(0) <= 0x20;
}

class ConfigError extends Error {
	constructor(
		readonly position: Position,
		message: string,
	) {
		super(message);
	}
}

////////////////////////////////
//  Reader

class ConfigReader {
	private readonly cursor: SourceCursor;
	private readonly gauge = new NestingGauge();
	private readonly sections: MutableSection[] = [];

	constructor(
		text: string,
		private readonly options: ConfigOptions,
	) {
		this.cursor = new SourceCursor(text);
	}

	read(): ConfigRead {
		let section: MutableSection = { name: "", fields: new Map(), properties: new Map() };
		this.sections.push(section);
		const tags = this.options.tags ?? Number.POSITIVE_INFINITY;
		if (this.options.skipByteOrderMark === true) this.cursor.take(BYTE_ORDER_MARK);
		try {
			for (let guard = -1; ; guard = this.advanced(guard)) {
				this.skipTrivia();
				if (!this.cursor.good()) break;
				if (this.cursor.peek() === "[") {
					section = this.tag();
					this.sections.push(section);
					if (this.sections.length > tags) break;
				} else {
					const key = this.key();
					section.properties.set(key, this.value());
				}
			}
		} catch (failure) {
			const problem =
				failure instanceof ConfigError
					? { position: failure.position, message: failure.message }
					: isTooDeep(failure)
						? { position: this.cursor.position, message: "nested too deeply" }
						: undefined;
			if (problem === undefined) throw failure;
			return { sections: this.sections, problem };
		}
		return { sections: this.sections };
	}

	private error(message: string, at: Position = this.cursor.position): ConfigError {
		return new ConfigError(at, message);
	}

	/** Throws unless the cursor moved past `guard`; the next guard. */
	private advanced(guard: number): number {
		if (this.cursor.offset <= guard) throw new Error("Godot config reader failed to advance");
		return this.cursor.offset;
	}

	/** Blanks, line breaks and `;` comments. */
	private skipTrivia(): void {
		const cursor = this.cursor;
		for (let guard = -1; ; guard = this.advanced(guard)) {
			cursor.readWhile(isSpace);
			if (cursor.peek() !== ";") return;
			cursor.readWhile((character) => character !== "\n");
		}
	}

	////////////////////////////////
	//  Sections

	private tag(): MutableSection {
		const cursor = this.cursor;
		const open = cursor.position;
		cursor.next();
		if (this.options.simpleTags === true)
			return { name: this.simpleTagName(open), fields: new Map(), properties: new Map() };
		this.skipTrivia();
		let name = this.word();
		for (let guard = -1; cursor.peek() === "." || cursor.peek() === ":"; guard = this.advanced(guard))
			name += cursor.next() + this.word();
		const fields = new Map<string, ConfigValue>();
		for (let guard = -1; ; guard = this.advanced(guard)) {
			this.skipTrivia();
			if (cursor.take("]")) break;
			if (!cursor.good()) throw this.error(`tag ${name} is not closed`, open);
			const field = this.word();
			this.skipTrivia();
			if (!cursor.take("=")) throw this.error("expected '=' after a tag field");
			fields.set(field, this.value());
		}
		return { name, fields, properties: new Map() };
	}

	/** To an unescaped `]`, trimmed. */
	private simpleTagName(open: Position): string {
		const cursor = this.cursor;
		const start = cursor.mark();
		let escaping = false;
		for (let guard = -1; ; guard = this.advanced(guard)) {
			const character = cursor.peek();
			if (character === "") throw this.error("tag is not closed", open);
			if (character === "]") {
				if (!escaping) break;
				escaping = false;
			} else {
				escaping = character === "\\";
			}
			cursor.next();
		}
		const name = cursor.textSince(start).trim();
		cursor.next();
		return name;
	}

	/** Up to `=`: its text less blanks, or one quoted string. */
	private key(): string {
		const cursor = this.cursor;
		let key = "";
		for (let guard = -1; ; guard = this.advanced(guard)) {
			this.skipTrivia();
			const character = cursor.peek();
			if (character === "") throw this.error("expected '=' after a key");
			if (character === "=") {
				cursor.next();
				return key;
			}
			if (character === '"') key = this.string();
			else key += cursor.next();
		}
	}

	////////////////////////////////
	//  Values

	private value(): ConfigValue {
		const cursor = this.cursor;
		this.skipTrivia();
		const character = cursor.peek();
		if (character === '"') return { kind: "string", value: this.string() };
		if ((character === "&" || character === "@") && cursor.peek(1) === '"') {
			cursor.next();
			return { kind: "string", value: this.string() };
		}
		if (character === "#") return { kind: "color", text: this.color() };
		if (isDigit(character) || (character === "-" && isDigit(cursor.peek(1)))) return this.number();
		if (character === "-" && isWordStart(cursor.peek(1))) {
			cursor.next();
			return { kind: "word", name: `-${this.word()}` };
		}
		if (character === "[") return { kind: "array", items: this.list("[", "]") };
		if (character === "{") return this.dictionary();
		if (isWordStart(character)) return this.named();
		throw this.error(character === "" ? "expected a value" : `unexpected character ${JSON.stringify(character)}`);
	}

	/** At the opening quote; to the closing one, escapes decoded. */
	private string(): string {
		const cursor = this.cursor;
		const open = cursor.position;
		cursor.next();
		let value = "";
		for (let guard = -1; ; guard = this.advanced(guard)) {
			const character = cursor.next();
			if (character === "") throw this.error("string is not closed", open);
			if (character === '"') return value;
			if (character !== "\\") {
				value += character;
				continue;
			}
			const code = cursor.next();
			if (code === "") throw this.error("string is not closed", open);
			if (code === "u" || code === "U") value += this.hexEscape(code === "u" ? 4 : 6);
			else value += ESCAPES[code] ?? code;
		}
	}

	/** One UTF-16 unit for `\u`, so two spell a pair. */
	private hexEscape(width: number): string {
		let digits = "";
		for (let guard = -1; digits.length < width; guard = this.advanced(guard)) {
			const digit = this.cursor.next();
			if (!isHexDigit(digit)) throw this.error("malformed hex escape in a string");
			digits += digit;
		}
		const point = Number.parseInt(digits, 16);
		if (width === 4) return String.fromCharCode(point);
		if (point > 0x10ffff) throw this.error("hex escape is past the last code point");
		return String.fromCodePoint(point);
	}

	private color(): string {
		const start = this.cursor.mark();
		this.cursor.next();
		this.cursor.readWhile(isHexDigit);
		return this.cursor.textSince(start);
	}

	private number(): ConfigValue {
		const cursor = this.cursor;
		const start: CursorMark = cursor.mark();
		cursor.take("-");
		cursor.readWhile(isDigit);
		if (cursor.take(".")) cursor.readWhile(isDigit);
		const exponent = cursor.peek();
		if (exponent === "e" || exponent === "E") {
			cursor.next();
			if (cursor.peek() === "+" || cursor.peek() === "-") cursor.next();
			cursor.readWhile(isDigit);
		}
		return { kind: "number", text: cursor.textSince(start) };
	}

	private word(): string {
		if (!isWordStart(this.cursor.peek())) throw this.error("expected an identifier");
		return this.cursor.readWhile(isWordPart);
	}

	/** A word or a constructor, as in `Array[int]([1])`. */
	private named(): ConfigValue {
		const cursor = this.cursor;
		const name = this.word();
		if (LITERAL_WORDS.has(name)) return { kind: "word", name };
		this.skipTrivia();
		const typed = (name === "Array" || name === "Dictionary") && cursor.peek() === "[";
		const parameters = typed ? this.list("[", "]") : [];
		this.skipTrivia();
		if (cursor.peek() === "(") return { kind: "call", name, arguments: [...parameters, ...this.list("(", ")")] };
		if (typed) throw this.error(`expected '(' after ${name}'s type parameters`);
		return { kind: "word", name };
	}

	/** Comma-separated; `key: value` is a one-entry dictionary. */
	private list(open: string, close: string): ConfigValue[] {
		const cursor = this.cursor;
		const at = cursor.position;
		cursor.take(open);
		this.gauge.open();
		const items: ConfigValue[] = [];
		for (let guard = -1; ; guard = this.advanced(guard)) {
			this.skipTrivia();
			if (cursor.take(close)) break;
			if (!cursor.good()) throw this.error(`'${open}' is not closed`, at);
			if (items.length > 0 && !cursor.take(",")) throw this.error(`expected ',' or '${close}'`);
			this.skipTrivia();
			if (cursor.take(close)) break;
			const item = this.value();
			this.skipTrivia();
			items.push(cursor.take(":") ? { kind: "dictionary", entries: [[item, this.value()]] } : item);
		}
		this.gauge.close();
		return items;
	}

	private dictionary(): ConfigValue {
		const cursor = this.cursor;
		const at = cursor.position;
		cursor.take("{");
		this.gauge.open();
		const entries: Array<readonly [ConfigValue, ConfigValue]> = [];
		for (let guard = -1; ; guard = this.advanced(guard)) {
			this.skipTrivia();
			if (cursor.take("}")) break;
			if (!cursor.good()) throw this.error("'{' is not closed", at);
			if (entries.length > 0 && !cursor.take(",")) throw this.error("expected ',' or '}'");
			this.skipTrivia();
			if (cursor.take("}")) break;
			const key = this.value();
			this.skipTrivia();
			if (!cursor.take(":")) throw this.error("expected ':' after a dictionary key");
			entries.push([key, this.value()]);
		}
		this.gauge.close();
		return { kind: "dictionary", entries };
	}
}

////////////////////////////////
//  Functions

/** The sections read, and the first problem. */
export function readConfigResult(text: string, options: ConfigOptions = {}): ConfigRead {
	return new ConfigReader(text, options).read();
}

/** Null on any problem. */
export function readConfig(text: string, options: ConfigOptions = {}): ConfigSection[] | null {
	const read = readConfigResult(text, options);
	return read.problem === undefined ? read.sections : null;
}

/** A value's string, when it is one. */
export function stringOf(value: ConfigValue | undefined): string | undefined {
	return value?.kind === "string" ? value.value : undefined;
}

/** The id an `ExtResource(...)` names; Godot 3 wrote a number. */
export function extResourceOf(value: ConfigValue | undefined): string | undefined {
	if (value?.kind !== "call" || value.name !== "ExtResource") return undefined;
	const [id] = value.arguments;
	return id?.kind === "string" ? id.value : id?.kind === "number" ? id.text : undefined;
}
