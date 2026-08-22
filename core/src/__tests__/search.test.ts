import { describe, expect, it } from "vitest";
import { compileSearchRegex, SEARCH_TERM_LIMIT, searchTerm } from "../search";

describe("compiling a caller's regex", () => {
	it("matches anywhere in the text, honouring the flags that change a match", () => {
		expect(compileSearchRegex("/cycle/i").test("the Cycle turns")).toBe(true);
		expect(compileSearchRegex("/^cycle/").test("the cycle")).toBe(false);
		expect(compileSearchRegex("/^cycle/m").test("the\ncycle")).toBe(true);
		expect(compileSearchRegex("/a.b/s").test("a\nb")).toBe(true);
		expect(compileSearchRegex("/a.b/").test("a\nb")).toBe(false);
	});

	it("refuses what is not /pattern/flags, an unknown flag, and what RE2 has no reading of", () => {
		expect(() => compileSearchRegex("cycle")).toThrow(/expected \/pattern\/flags/);
		expect(() => compileSearchRegex("/cycle/x")).toThrow(/unsupported flag/);
		expect(() => compileSearchRegex("/(a)\\1/")).toThrow(/RE2 syntax/);
		expect(() => compileSearchRegex("/(?<=a)b/")).toThrow(/RE2 syntax/);
		expect(() => compileSearchRegex("/(unclosed/")).toThrow(/Regex failed to compile/);
	});

	// The pattern that hung the daemon at sixty letters.
	it("answers a catastrophic pattern in bounded time", () => {
		const pattern = compileSearchRegex("/(a+)+b/");
		const started = Date.now();
		expect(pattern.test("a".repeat(20_000))).toBe(false);
		expect(Date.now() - started).toBeLessThan(5000);
	});

	it("keeps a compiled pattern reusable across calls, with no position carried over", () => {
		const pattern = compileSearchRegex("/b/g");
		expect(pattern.test("ab")).toBe(true);
		expect(pattern.test("ab")).toBe(true);
	});
});

describe("checking a search term", () => {
	it("returns an ordinary term unchanged", () => {
		expect(searchTerm("100% sure_")).toBe("100% sure_");
	});

	// LIKE stops at a NUL.
	it("refuses a NUL rather than matching everything", () => {
		expect(() => searchTerm("a\0b")).toThrow(/NUL/);
	});

	it("refuses a term past the limit with the limit in the message", () => {
		expect(searchTerm("x".repeat(SEARCH_TERM_LIMIT))).toHaveLength(SEARCH_TERM_LIMIT);
		expect(() => searchTerm("x".repeat(SEARCH_TERM_LIMIT + 1))).toThrow(String(SEARCH_TERM_LIMIT));
	});
});
