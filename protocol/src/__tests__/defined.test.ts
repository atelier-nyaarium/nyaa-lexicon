import { describe, expect, it } from "bun:test";
import { defined } from "../defined";

////////////////////////////////
//  Tests

describe("dropping undefined fields", () => {
	it("keeps a field that has a value", () => {
		expect(defined({ a: 1, b: "x" })).toEqual({ a: 1, b: "x" });
	});

	// Absent, not present-and-undefined: the whole reason this exists. `toEqual` treats the two
	// alike, so the key list is what carries the claim.
	it("leaves an undefined field ABSENT rather than present", () => {
		const built = defined({ a: 1, b: undefined });
		expect(Object.keys(built)).toEqual(["a"]);
		expect("b" in built).toBe(false);
	});

	it("keeps a falsy value, which is a value", () => {
		const built = defined({ zero: 0, empty: "", no: false, nothing: null });
		expect(Object.keys(built).sort()).toEqual(["empty", "no", "nothing", "zero"]);
	});

	it("answers an empty object when every field is undefined", () => {
		expect(Object.keys(defined({ a: undefined, b: undefined }))).toEqual([]);
	});

	it("answers an empty object for an empty one", () => {
		expect(defined({})).toEqual({});
	});

	// The composed shape is what call sites actually write.
	it("spreads into a literal, supplying only what survived", () => {
		const range = { line: 1 };
		const composed = { name: "a", ...defined({ range, container: undefined }) };
		expect(composed).toEqual({ name: "a", range });
		expect("container" in composed).toBe(false);
	});

	it("copies rather than aliasing the argument, so a caller's object is not the result", () => {
		const fields = { a: 1 };
		expect(defined(fields)).not.toBe(fields);
	});

	// Own enumerable keys only, which is what a fact is built from.
	it("ignores an inherited property", () => {
		const parent = { inherited: "x" };
		const child = Object.create(parent) as { inherited: string; own?: number };
		child.own = 1;
		expect(Object.keys(defined(child))).toEqual(["own"]);
	});
});
