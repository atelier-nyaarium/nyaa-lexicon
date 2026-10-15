import { describe, expect, test } from "bun:test";
import { decodeEscapedLiteral } from "../escapedLiteral.js";

describe("decodeEscapedLiteral", () => {
	test("decodes simple, octal, hexadecimal, and universal escapes", () => {
		expect(decodeEscapedLiteral("a\\n\\1234\\0x\\x41z\\u00e9\\U0001F600", "c")).toBe(
			`a\nS4\0xAz${String.fromCodePoint(0xe9)}${String.fromCodePoint(0x1f600)}`,
		);
	});

	test("keeps invalid numeric and unknown escapes spelled", () => {
		expect(decodeEscapedLiteral("\\u12 \\xFFFFFFFFF \\q", "cpp")).toBe("\\u12 \\xFFFFFFFFF \\q");
	});

	test("applies C's escape extension without treating it as a C++ escape", () => {
		expect(decodeEscapedLiteral("\\e", "c")).toBe("\x1b");
		expect(decodeEscapedLiteral("\\e", "cpp")).toBe("\\e");
	});
});
