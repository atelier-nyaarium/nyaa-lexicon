import { expect, test } from "bun:test";
import {
	isAsciiDigit,
	isHexDigit,
	isIdentifierPart,
	isIdentifierStart,
	isUppercase,
	isWhitespace,
} from "../characters.js";

test("classifies identifiers by XID and whitespace by Pattern_White_Space", () => {
	const character = (point: number) => String.fromCodePoint(point);

	expect(isIdentifierStart("_")).toBe(true);
	expect(isIdentifierStart(character(0xe9))).toBe(true);
	expect(isIdentifierStart("7")).toBe(false);
	expect(isIdentifierPart("7")).toBe(true);
	expect(isIdentifierPart("-")).toBe(false);
	expect(isAsciiDigit("0")).toBe(true);
	expect(isAsciiDigit(character(0xff19))).toBe(false);
	expect(isHexDigit("F")).toBe(true);
	expect(isHexDigit("g")).toBe(false);
	expect([0x09, 0x0b, 0x85, 0x200e, 0x2028].every((point) => isWhitespace(character(point)))).toBe(true);
	expect(isWhitespace(character(0xa0))).toBe(false);
	expect(isWhitespace(character(0xfeff))).toBe(false);
	expect(isUppercase("N")).toBe(true);
	expect(isUppercase("n")).toBe(false);
});
