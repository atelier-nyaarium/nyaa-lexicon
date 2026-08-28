import { expect, test } from "bun:test";
import { Cursor, isAsciiDigit, isIdentifierPart, isIdentifierStart, sourceRange } from "../cursor.js";

test("tracks UTF-16 columns while iterating Unicode text", () => {
	const cursor = new Cursor("a😀b\nc");

	expect(cursor.peek()).toBe("a");
	expect(cursor.next()).toBe("a");
	expect(cursor.column).toBe(1);
	expect(cursor.next()).toBe("😀");
	expect(cursor.column).toBe(3);
	expect(cursor.next()).toBe("b");
	expect(cursor.column).toBe(4);
	expect(cursor.next()).toBe("\n");
	expect(cursor.line).toBe(1);
	expect(cursor.column).toBe(0);
	expect(cursor.next()).toBe("c");
	expect(cursor.column).toBe(1);
	expect(cursor.good()).toBe(false);
});

test("rewinds to a mark without losing line and column state", () => {
	const cursor = new Cursor("one\ntwo");

	cursor.next();
	const mark = cursor.mark();
	cursor.next();
	cursor.next();
	cursor.next();
	expect(cursor.line).toBe(1);
	expect(cursor.column).toBe(0);
	cursor.rewind(mark);
	expect(cursor.offset).toBe(1);
	expect(cursor.line).toBe(0);
	expect(cursor.column).toBe(1);
	expect(cursor.peek()).toBe("n");
});

test("reads only characters accepted by a delimiter predicate", () => {
	const cursor = new Cursor("abc;def");

	expect(cursor.readWhile((character) => character !== ";")).toBe("abc");
	expect(cursor.peek()).toBe(";");
	cursor.next();
	expect(cursor.readWhile((character) => character !== ";")).toBe("def");
});

test("reads lines and consumes exactly one line break", () => {
	const cursor = new Cursor("first\nsecond");

	expect(cursor.readLine()).toEqual({ line: 0, text: "first" });
	expect(cursor.line).toBe(1);
	expect(cursor.column).toBe(0);
	expect(cursor.readLine()).toEqual({ line: 1, text: "second" });
	expect(cursor.readLine()).toBeNull();
});

test("creates source ranges in offsets and positions", () => {
	const cursor = new Cursor("😀ab");

	const mark = cursor.mark();
	cursor.next();
	cursor.next();
	expect(cursor.span(mark)).toEqual({
		startOffset: 0,
		endOffset: 3,
		start: { line: 0, character: 0 },
		end: { line: 0, character: 3 },
	});
	expect(sourceRange("😀ab", 2, 3)).toBe("a");
});

test("classifies identifier and ASCII digit boundaries", () => {
	expect(isIdentifierStart("_")).toBe(true);
	expect(isIdentifierStart("é")).toBe(true);
	expect(isIdentifierStart("7")).toBe(false);
	expect(isIdentifierPart("7")).toBe(true);
	expect(isIdentifierPart("-")).toBe(false);
	expect(isAsciiDigit("0")).toBe(true);
	expect(isAsciiDigit("９")).toBe(false);
});
