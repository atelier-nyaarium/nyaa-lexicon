// The XML document tree and its tokens, with the character classes of XML 1.0 (Fifth Edition).

import { SourceCursor } from "@nyaa-lexicon/protocol";

////////////////////////////////
//  Interfaces & Types

/** Offsets into the parsed text: `pos` inclusive, `end` exclusive. */
export interface XmlSpan {
	pos: number;
	end: number;
}

/** One lexical piece in source order. Only white space falls between two. */
export interface XmlToken extends XmlSpan {
	/** Tags, declarations, instructions and references in a document type. */
	kind: "markup" | "text" | "cdata" | "comment";
	/** Where `pos` sits: zero-based line, UTF-16 column. */
	line: number;
	column: number;
}

/** From the name to the closing quote. */
export interface XmlAttribute extends XmlSpan {
	name: string;
	nameEnd: number;
	/** Normalized, with references replaced. */
	value: string;
	/** The opening quote. */
	valuePos: number;
}

export interface XmlElement extends XmlSpan {
	type: "element";
	name: string;
	attributes: XmlAttribute[];
	/** Past the start tag's `>`. */
	startTagEnd: number;
	/** Where the end tag starts; the start tag's end for an empty element. */
	endTagPos: number;
	children: XmlContent[];
}

/** Character data and the references inside it, one run between two other nodes. */
export interface XmlText extends XmlSpan {
	type: "text";
	/** Line breaks normalized, references replaced. */
	text: string;
}

export interface XmlCdata extends XmlSpan {
	type: "cdata";
	/** Line breaks normalized. */
	text: string;
}

export interface XmlComment extends XmlSpan {
	type: "comment";
}

export interface XmlInstruction extends XmlSpan {
	type: "instruction";
	target: string;
}

export interface XmlDeclaration extends XmlSpan {
	type: "declaration";
	standalone: boolean | undefined;
}

export interface XmlDoctype extends XmlSpan {
	type: "doctype";
	name: string;
}

export type XmlContent = XmlElement | XmlText | XmlCdata | XmlComment | XmlInstruction;

export type XmlNode = XmlContent | XmlDeclaration | XmlDoctype;

export interface XmlDocument {
	children: XmlNode[];
	root: XmlElement;
	tokens: XmlToken[];
}

/** The first well-formedness error; XML 1.0 stops normal processing there. */
export interface XmlProblem {
	message: string;
	pos: number;
}

export type XmlParse = { document: XmlDocument; problem?: undefined } | { document?: undefined; problem: XmlProblem };

////////////////////////////////
//  Functions & Helpers

/** `S`: space, tab, carriage return and line feed. */
export function isSpace(character: string): boolean {
	return character === " " || character === "\t" || character === "\n" || character === "\r";
}

/** Whether `text` holds only XML white space; a no-break space is content. */
export function isWhiteSpace(text: string): boolean {
	const cursor = new SourceCursor(text);
	cursor.readWhile(isSpace);
	return !cursor.good();
}

/** From the first to the last character of `text`, found at `pos`, that is not XML white space. */
export function contentSpan(text: string, pos: number): XmlSpan | undefined {
	const cursor = new SourceCursor(text);
	let first: number | undefined;
	let last = 0;
	let guard = -1;
	while (cursor.good()) {
		if (cursor.offset <= guard) throw new Error("xml content span scan failed to advance");
		guard = cursor.offset;
		cursor.readWhile(isSpace);
		if (!cursor.good()) break;
		first ??= cursor.offset;
		cursor.readWhile((character) => !isSpace(character));
		last = cursor.offset;
	}
	return first === undefined ? undefined : { pos: pos + first, end: pos + last };
}

/** `Char`: any Unicode character, excluding the surrogate blocks, FFFE and FFFF. */
export function isXmlChar(character: string): boolean {
	const point = character.codePointAt(0);
	if (point === undefined) return false;
	return (
		point === 0x9 ||
		point === 0xa ||
		point === 0xd ||
		(point >= 0x20 && point <= 0xd7ff) ||
		(point >= 0xe000 && point <= 0xfffd) ||
		(point >= 0x10000 && point <= 0x10ffff)
	);
}

export function isNameStart(character: string): boolean {
	const point = character.codePointAt(0);
	if (point === undefined) return false;
	return (
		(point >= 0x61 && point <= 0x7a) ||
		(point >= 0x41 && point <= 0x5a) ||
		point === 0x3a ||
		point === 0x5f ||
		(point >= 0xc0 && point <= 0xd6) ||
		(point >= 0xd8 && point <= 0xf6) ||
		(point >= 0xf8 && point <= 0x2ff) ||
		(point >= 0x370 && point <= 0x37d) ||
		(point >= 0x37f && point <= 0x1fff) ||
		point === 0x200c ||
		point === 0x200d ||
		(point >= 0x2070 && point <= 0x218f) ||
		(point >= 0x2c00 && point <= 0x2fef) ||
		(point >= 0x3001 && point <= 0xd7ff) ||
		(point >= 0xf900 && point <= 0xfdcf) ||
		(point >= 0xfdf0 && point <= 0xfffd) ||
		(point >= 0x10000 && point <= 0xeffff)
	);
}

export function isNameCharacter(character: string): boolean {
	const point = character.codePointAt(0);
	if (point === undefined) return false;
	return (
		isNameStart(character) ||
		point === 0x2d ||
		point === 0x2e ||
		(point >= 0x30 && point <= 0x39) ||
		point === 0xb7 ||
		(point >= 0x300 && point <= 0x36f) ||
		point === 0x203f ||
		point === 0x2040
	);
}

/** `PubidChar`. */
export function isPublicIdCharacter(character: string): boolean {
	if (character === " " || character === "\n" || character === "\r") return true;
	if ((character >= "a" && character <= "z") || (character >= "A" && character <= "Z")) return true;
	if (character >= "0" && character <= "9") return true;
	return "-'()+,./:=?;!*#@$_%".includes(character) && character.length === 1;
}
