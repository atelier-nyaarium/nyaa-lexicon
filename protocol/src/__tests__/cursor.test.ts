import { describe, expect, it } from "bun:test";
import { Cursor, formatFailure } from "../cursor";

describe("Cursor", () => {
	it("reads through text and reports exhaustion", () => {
		const c = new Cursor("ab");
		expect(c.good()).toBe(true);
		expect(c.next()).toBe("a");
		expect(c.next()).toBe("b");
		expect(c.good()).toBe(false);
	});

	it("answers empty past the end rather than making callers bounds-check", () => {
		const c = new Cursor("a");
		c.next();
		expect(c.peek()).toBe("");
		expect(c.next()).toBe("");
	});

	it("peeks without consuming, at an offset", () => {
		const c = new Cursor("abc");
		expect(c.peek()).toBe("a");
		expect(c.peek(2)).toBe("c");
		expect(c.offset).toBe(0);
	});

	it("tracks line and column across newlines", () => {
		const c = new Cursor("a\nbc");
		c.next();
		c.next();
		expect(c.line).toBe(2);
		expect(c.column).toBe(1);
		c.next();
		expect(c.column).toBe(2);
	});

	it("takeWhile stops at the first character failing the predicate", () => {
		const c = new Cursor("abc123");
		expect(c.takeWhile((ch) => /[a-z]/.test(ch))).toBe("abc");
		expect(c.peek()).toBe("1");
	});

	it("takeWhile at the end returns empty rather than hanging", () => {
		const c = new Cursor("");
		expect(c.takeWhile(() => true)).toBe("");
	});

	it("brackets the marked token in a failure's context", () => {
		const c = new Cursor("aaa BAD bbb");
		for (let i = 0; i < 4; i++) c.next();
		c.mark();
		for (let i = 0; i < 3; i++) c.next();
		const f = c.fail("nope");
		expect(f.context).toBe("aaa [BAD] bbb");
		expect(f.offset).toBe(7);
	});

	it("renders a failure with position and context on one line", () => {
		const c = new Cursor("xy");
		c.next();
		expect(formatFailure(c.fail("boom"))).toContain("boom at 1:2 (offset 1)");
	});
});
