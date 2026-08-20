import { describe, expect, it } from "vitest";
import {
	commentFactId,
	composeFactId,
	declarationFactId,
	doubtFactId,
	factKindOf,
	factModuleOf,
	importFactId,
	isFactId,
	literalFactId,
	parseFactId,
	referenceFactId,
} from "../factId";
import type { Literal } from "../project";
import type { Declaration, Reference } from "../symbols";

////////////////////////////////
//  Helpers

const DECL: Declaration = {
	symbolId: "lexicon typescript src/a.ts add().",
	name: "add",
	kind: "function",
	visibility: "public",
	range: { start: { line: 1, character: 0 }, end: { line: 3, character: 1 } },
	selectionRange: { start: { line: 1, character: 9 }, end: { line: 1, character: 12 } },
};

const REF: Reference = {
	name: "add",
	role: "call",
	range: { start: { line: 7, character: 2 }, end: { line: 7, character: 5 } },
	binding: { status: "bound", symbolId: "lexicon typescript src/a.ts add().", provenance: "bound" },
};

const LIT: Literal = {
	kind: "string",
	value: "thing_happened",
	range: { start: { line: 4, character: 8 }, end: { line: 4, character: 24 } },
};

////////////////////////////////
//  Tests

describe("the grammar", () => {
	it("round trips through its own parser", () => {
		const id = declarationFactId("src/a.ts", DECL);

		expect(parseFactId(id)).toEqual({ kind: "declaration", module: "src/a.ts", digest: expect.any(String) });
		expect(factModuleOf(id)).toBe("src/a.ts");
		expect(factKindOf(id)).toBe("declaration");
	});

	it("encodes a space in a module path rather than splitting on it", () => {
		const id = literalFactId("my dir/a.ts", LIT);

		expect(id).toContain("my%20dir/a.ts");
		expect(factModuleOf(id)).toBe("my dir/a.ts");
	});

	it("refuses text that is not a fact id, including a symbol id", () => {
		expect(isFactId("lexicon typescript src/a.ts add().")).toBe(false);
		expect(isFactId("lexfact declaration src/a.ts")).toBe(false);
		expect(isFactId("lexfact nonsense src/a.ts 0123456789abcdef")).toBe(false);
		expect(isFactId("lexfact declaration src/a.ts NOTHEX0123456789")).toBe(false);
		expect(isFactId("lexfact declaration src/a.ts 0123456789abcdef trailing")).toBe(false);
	});

	it("refuses a module a symbol id would also refuse, so the two grammars agree", () => {
		expect(() => composeFactId("literal", "../escape.ts", [])).toThrow();
		expect(isFactId("lexfact literal ./src/a.ts 0123456789abcdef")).toBe(false);
	});
});

/**
 * The property the knowledge layer is built on.
 *
 * An answer cites the facts it read and the citation must go stale when one of them changes, so
 * "resolve this id" and "has this fact changed" have to be the same question.
 */
describe("identity is content", () => {
	it("gives the same fact the same id every time", () => {
		expect(declarationFactId("src/a.ts", DECL)).toBe(declarationFactId("src/a.ts", DECL));
	});

	it("gives a changed signature a different id", () => {
		const before = declarationFactId("src/a.ts", DECL);
		const after = declarationFactId("src/a.ts", { ...DECL, signature: "(a: number) => number" });

		expect(after).not.toBe(before);
	});

	it("gives a moved fact a different id, which is the trade this design makes", () => {
		const moved = { ...LIT, range: { start: { line: 9, character: 8 }, end: { line: 9, character: 24 } } };

		expect(literalFactId("src/a.ts", moved)).not.toBe(literalFactId("src/a.ts", LIT));
	});

	it("gives the same fact in another file a different id", () => {
		expect(literalFactId("src/b.ts", LIT)).not.toBe(literalFactId("src/a.ts", LIT));
	});

	// A citation must stale on a reword: the reason comments are facts, not a declaration field.
	it("gives a reworded comment a different id, and a moved one too", () => {
		const comment = { range: LIT.range, text: "// refusal beats clamping" };
		const reworded = { ...comment, text: "// refusal beats guessing" };
		const moved = { ...comment, range: { start: { line: 9, character: 0 }, end: { line: 9, character: 25 } } };

		expect(commentFactId("src/a.ts", comment)).toBe(commentFactId("src/a.ts", comment));
		expect(commentFactId("src/a.ts", reworded)).not.toBe(commentFactId("src/a.ts", comment));
		expect(commentFactId("src/a.ts", moved)).not.toBe(commentFactId("src/a.ts", comment));
		expect(parseFactId(commentFactId("src/a.ts", comment))?.kind).toBe("comment");
	});

	// Absent and empty hash alike only if the encoding lets them, and a tuple slot that can vanish
	// would let one fact's fields slide into the next slot.
	it("separates an absent field from an empty one", () => {
		const absent = declarationFactId("src/a.ts", DECL);
		const empty = declarationFactId("src/a.ts", { ...DECL, docComment: "" });

		expect(empty).not.toBe(absent);
	});

	it("separates two facts differing only past a field containing the separator", () => {
		const one = literalFactId("src/a.ts", { ...LIT, value: "a:=b" });
		const two = literalFactId("src/a.ts", { ...LIT, value: "a", containerId: "b" });

		expect(one).not.toBe(two);
	});
});

describe("what each kind counts as its identity", () => {
	// A call that newly resolves is news. Leaving the binding out would report the same fact id for
	// "we could not resolve this" and "we resolved it", which is the one thing a citation must catch.
	it("treats a reference's binding as part of the fact", () => {
		const unbound = referenceFactId("src/b.ts", { ...REF, binding: { status: "unbound", reason: "NotIndexed" } });

		expect(unbound).not.toBe(referenceFactId("src/b.ts", REF));
	});

	it("separates an unbound reference's reason, so a changed diagnosis is a changed fact", () => {
		const notIndexed = referenceFactId("src/b.ts", {
			...REF,
			binding: { status: "unbound", reason: "NotIndexed" },
		});
		const dynamic = referenceFactId("src/b.ts", {
			...REF,
			binding: { status: "unbound", reason: "DynamicallyTyped" },
		});

		expect(dynamic).not.toBe(notIndexed);
	});

	it("separates the source name of an import from its local alias", () => {
		const source = importFactId("src/b.ts", "./a.js", false, {
			name: "add",
			range: { start: { line: 0, character: 9 }, end: { line: 0, character: 12 } },
		});
		const alias = importFactId("src/b.ts", "./a.js", false, {
			local: "add",
			localRange: { start: { line: 0, character: 9 }, end: { line: 0, character: 12 } },
		});

		expect(alias).not.toBe(source);
	});

	// A bare `import os` names no export and still has to be citable, since it is what carries the
	// edge. Two of them in one file are the same fact stated twice, so one id is the right answer.
	it("gives a nameless import an id, and the same one when it is written twice", () => {
		const first = importFactId("src/b.ts", "os", false);

		expect(isFactId(first)).toBe(true);
		expect(importFactId("src/b.ts", "os", false)).toBe(first);
		expect(importFactId("src/b.ts", "os", true)).not.toBe(first);
	});

	it("separates a number from the string that spells it", () => {
		const numeric = literalFactId("src/a.ts", { ...LIT, kind: "number", value: "255", number: 255 });
		const text = literalFactId("src/a.ts", { ...LIT, kind: "number", value: "0xFF", number: 255 });

		expect(text).not.toBe(numeric);
	});

	// The clear-handshake token. The timestamp is IN the identity so a doubt declared again after a
	// clear mints a fresh id, and a saved-up old token cannot clear the new doubt.
	it("gives a re-declared doubt a fresh id, so an old token cannot clear it", () => {
		const subject = "lexicon ts src/a.ts add().";
		const first = doubtFactId(subject, "describe", "purpose drifted", 1000);

		expect(isFactId(first)).toBe(true);
		expect(factKindOf(first)).toBe("doubt");
		expect(doubtFactId(subject, "describe", "purpose drifted", 1000)).toBe(first);
		expect(doubtFactId(subject, "describe", "purpose drifted", 2000)).not.toBe(first);
		expect(doubtFactId(subject, "why", "purpose drifted", 1000)).not.toBe(first);
	});
});
