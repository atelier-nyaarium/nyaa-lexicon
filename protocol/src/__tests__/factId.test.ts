import { describe, expect, it } from "bun:test";
import {
	answerFactId,
	commentFactId,
	declarationFactId,
	docFactId,
	doubtFactId,
	factKindOf,
	factModuleOf,
	importFactId,
	isFactId,
	literalFactId,
	type OwnerStarts,
	ownerStarts,
	parseFactId,
	referenceFactId,
} from "../factId";
import type { Literal } from "../project";
import type { Declaration, Range, Reference } from "../symbols";

////////////////////////////////
//  Helpers

const ADD_ID = "lexicon typescript src/a.ts add().";

const DECL: Declaration = {
	symbolId: ADD_ID,
	name: "add",
	kind: "function",
	visibility: "public",
	range: { start: { line: 1, character: 0 }, end: { line: 3, character: 1 } },
	selectionRange: { start: { line: 1, character: 9 }, end: { line: 1, character: 12 } },
};

const OWNERS = ownerStarts([DECL]);
const NO_OWNERS: OwnerStarts = new Map();

const REF: Reference = {
	name: "add",
	role: "call",
	range: { start: { line: 7, character: 2 }, end: { line: 7, character: 5 } },
	binding: { status: "bound", symbolId: ADD_ID, provenance: "bound" },
};

const LIT: Literal = {
	kind: "string",
	value: "thing_happened",
	range: { start: { line: 4, character: 8 }, end: { line: 4, character: 24 } },
};

function shifted(range: Range, lines: number, characters = 0): Range {
	return {
		start: { line: range.start.line + lines, character: range.start.character + characters },
		end: { line: range.end.line + lines, character: range.end.character + characters },
	};
}

/** Moves the owner's start. */
function movedOwners(lines: number, characters = 0): OwnerStarts {
	return ownerStarts([{ ...DECL, range: shifted(DECL.range, lines, characters) }]);
}

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
		const id = literalFactId("my dir/a.ts", LIT, NO_OWNERS);

		expect(id).toContain("my%20dir/a.ts");
		expect(factModuleOf(id)).toBe("my dir/a.ts");
	});

	it("refuses text that is not a fact id, including a symbol id", () => {
		expect(isFactId(ADD_ID)).toBe(false);
		expect(isFactId("lexfact declaration src/a.ts")).toBe(false);
		expect(isFactId("lexfact nonsense src/a.ts 0123456789abcdef")).toBe(false);
		expect(isFactId("lexfact declaration src/a.ts NOTHEX0123456789")).toBe(false);
		expect(isFactId("lexfact declaration src/a.ts 0123456789abcdef trailing")).toBe(false);
	});

	it("refuses a module a symbol id would also refuse, so the two grammars agree", () => {
		expect(() => literalFactId("../escape.ts", LIT, NO_OWNERS)).toThrow();
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

	// Omitted fields add no digest slot.
	it("keeps the pre-relative id of an unmarked declaration at the start of its file", () => {
		const atStart = {
			...DECL,
			range: { start: { line: 0, character: 0 }, end: { line: 3, character: 1 } },
			selectionRange: { start: { line: 0, character: 9 }, end: { line: 0, character: 12 } },
		};

		expect(declarationFactId("src/a.ts", atStart)).toBe("lexfact declaration src/a.ts 8e748c8b5d9b5372");
	});

	it("separates a marked declaration from an unmarked one", () => {
		expect(declarationFactId("src/a.ts", { ...DECL, kind: "constant", contains: "locals" })).not.toBe(
			declarationFactId("src/a.ts", { ...DECL, kind: "constant" }),
		);
	});

	it("gives the same fact in another file a different id", () => {
		expect(literalFactId("src/b.ts", LIT, NO_OWNERS)).not.toBe(literalFactId("src/a.ts", LIT, NO_OWNERS));
	});

	// A citation must stale on a reword: the reason comments are facts, not a declaration field.
	it("gives a reworded comment a different id", () => {
		const comment = { range: LIT.range, text: "// refusal beats clamping", anchorId: null };
		const reworded = { ...comment, text: "// refusal beats guessing" };

		expect(commentFactId("src/a.ts", comment, NO_OWNERS)).toBe(commentFactId("src/a.ts", comment, NO_OWNERS));
		expect(commentFactId("src/a.ts", reworded, NO_OWNERS)).not.toBe(commentFactId("src/a.ts", comment, NO_OWNERS));
		expect(parseFactId(commentFactId("src/a.ts", comment, NO_OWNERS))?.kind).toBe("comment");
	});

	// The same words as prose and as a shell command are not the same fact, so fenced is in the id.
	it("separates a doc region from the same text inside a fence", () => {
		const prose = { range: LIT.range, text: "bun run build", fenced: false };
		const fenced = { ...prose, fenced: true };

		expect(docFactId("a.md", prose, NO_OWNERS)).toBe(docFactId("a.md", prose, NO_OWNERS));
		expect(docFactId("a.md", fenced, NO_OWNERS)).not.toBe(docFactId("a.md", prose, NO_OWNERS));
		expect(parseFactId(docFactId("a.md", prose, NO_OWNERS))?.kind).toBe("doc");
	});

	// Absent and empty hash alike only if the encoding lets them, and a tuple slot that can vanish
	// would let one fact's fields slide into the next slot.
	it("separates an absent field from an empty one", () => {
		const absent = declarationFactId("src/a.ts", DECL);
		const empty = declarationFactId("src/a.ts", { ...DECL, signature: "" });

		expect(empty).not.toBe(absent);
	});

	it("separates two facts differing only past a field containing the separator", () => {
		const one = literalFactId("src/a.ts", { ...LIT, value: "a:=b" }, NO_OWNERS);
		const two = literalFactId("src/a.ts", { ...LIT, value: "a", containerId: ADD_ID }, OWNERS);

		expect(one).not.toBe(two);
	});
});

/** Owned citations survive owner moves. */
describe("position is relative to the owner", () => {
	const owned: Reference = { ...REF, fromId: ADD_ID };

	it("keeps a declaration's id when it moves within its file", () => {
		const moved = {
			...DECL,
			range: shifted(DECL.range, 10),
			selectionRange: shifted(DECL.selectionRange as Range, 10),
		};

		expect(declarationFactId("src/a.ts", moved)).toBe(declarationFactId("src/a.ts", DECL));
	});

	it("keeps every owned fact's id when its owner moves", () => {
		const comment = {
			range: { start: { line: 0, character: 0 }, end: { line: 0, character: 9 } },
			text: "// adds.",
		};
		const region = { range: shifted(LIT.range, 1), text: "Adds.", fenced: false };
		const moved = movedOwners(10);

		expect(referenceFactId("src/a.ts", { ...owned, range: shifted(owned.range, 10) }, moved)).toBe(
			referenceFactId("src/a.ts", owned, OWNERS),
		);
		expect(literalFactId("src/a.ts", { ...LIT, containerId: ADD_ID, range: shifted(LIT.range, 10) }, moved)).toBe(
			literalFactId("src/a.ts", { ...LIT, containerId: ADD_ID }, OWNERS),
		);
		expect(
			commentFactId("src/a.ts", { ...comment, anchorId: ADD_ID, range: shifted(comment.range, 10) }, moved),
		).toBe(commentFactId("src/a.ts", { ...comment, anchorId: ADD_ID }, OWNERS));
		expect(docFactId("a.md", { ...region, anchorId: ADD_ID, range: shifted(region.range, 10) }, moved)).toBe(
			docFactId("a.md", { ...region, anchorId: ADD_ID }, OWNERS),
		);
	});

	it("changes an unowned fact's id when it moves", () => {
		expect(referenceFactId("src/a.ts", { ...REF, range: shifted(REF.range, 10) }, NO_OWNERS)).not.toBe(
			referenceFactId("src/a.ts", REF, NO_OWNERS),
		);
	});

	it("changes an owned fact's id when it moves inside its owner", () => {
		expect(referenceFactId("src/a.ts", { ...owned, range: shifted(owned.range, 1) }, OWNERS)).not.toBe(
			referenceFactId("src/a.ts", owned, OWNERS),
		);
	});

	// First-line columns are owner-relative.
	it("keeps ids through re-indenting the owner's first line, not through re-indenting its body", () => {
		const firstLine: Reference = {
			...owned,
			range: { start: { line: 1, character: 9 }, end: { line: 1, character: 12 } },
		};
		const indented = movedOwners(0, 4);

		expect(referenceFactId("src/a.ts", { ...firstLine, range: shifted(firstLine.range, 0, 4) }, indented)).toBe(
			referenceFactId("src/a.ts", firstLine, OWNERS),
		);
		expect(referenceFactId("src/a.ts", owned, indented)).toBe(referenceFactId("src/a.ts", owned, OWNERS));
		expect(referenceFactId("src/a.ts", { ...owned, range: shifted(owned.range, 0, 4) }, indented)).not.toBe(
			referenceFactId("src/a.ts", owned, OWNERS),
		);
	});

	it("changes a comment's id when it is re-attached to another declaration", () => {
		const other = { ...DECL, symbolId: "lexicon typescript src/a.ts sub().", name: "sub" };
		const both = ownerStarts([DECL, other]);
		const comment = {
			range: { start: { line: 0, character: 0 }, end: { line: 0, character: 9 } },
			text: "// adds.",
		};

		expect(commentFactId("src/a.ts", { ...comment, anchorId: other.symbolId }, both)).not.toBe(
			commentFactId("src/a.ts", { ...comment, anchorId: ADD_ID }, both),
		);
	});

	// Same range, different origins.
	it("separates an owned fact from the same fact unowned", () => {
		const atOrigin = ownerStarts([{ ...DECL, range: { start: { line: 0, character: 0 }, end: DECL.range.end } }]);

		expect(referenceFactId("src/a.ts", owned, atOrigin)).not.toBe(referenceFactId("src/a.ts", REF, atOrigin));
	});

	it("refuses an owner not declared in the file", () => {
		expect(() => referenceFactId("src/a.ts", owned, NO_OWNERS)).toThrow();
	});
});

describe("what each kind counts as its identity", () => {
	// A call that newly resolves is news. Leaving the binding out would report the same fact id for
	// "we could not resolve this" and "we resolved it", which is the one thing a citation must catch.
	it("treats a reference's binding as part of the fact", () => {
		const unbound = referenceFactId(
			"src/b.ts",
			{ ...REF, binding: { status: "unbound", reason: "NotIndexed" } },
			NO_OWNERS,
		);

		expect(unbound).not.toBe(referenceFactId("src/b.ts", REF, NO_OWNERS));
	});

	it("separates an unbound reference's reason, so a changed diagnosis is a changed fact", () => {
		const notIndexed = referenceFactId(
			"src/b.ts",
			{ ...REF, binding: { status: "unbound", reason: "NotIndexed" } },
			NO_OWNERS,
		);
		const dynamic = referenceFactId(
			"src/b.ts",
			{ ...REF, binding: { status: "unbound", reason: "DynamicallyTyped" } },
			NO_OWNERS,
		);

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
		const numeric = literalFactId("src/a.ts", { ...LIT, kind: "number", value: "255", number: 255 }, NO_OWNERS);
		const text = literalFactId("src/a.ts", { ...LIT, kind: "number", value: "0xFF", number: 255 }, NO_OWNERS);

		expect(text).not.toBe(numeric);
	});

	// The clear-handshake token. The timestamp is IN the identity so a doubt declared again after a
	// clear mints a fresh id, and a saved-up old token cannot clear the new doubt.
	it("gives a re-declared doubt a fresh id, so an old token cannot clear it", () => {
		const address = "lexicon ts src/a.ts add().";
		const first = doubtFactId("s1", address, "describe", "purpose drifted", 1000);

		expect(isFactId(first)).toBe(true);
		expect(factKindOf(first)).toBe("doubt");
		expect(doubtFactId("s1", address, "describe", "purpose drifted", 1000)).toBe(first);
		expect(doubtFactId("s1", address, "describe", "purpose drifted", 2000)).not.toBe(first);
		expect(doubtFactId("s1", address, "why", "purpose drifted", 1000)).not.toBe(first);
		expect(doubtFactId("s2", address, "describe", "purpose drifted", 1000)).not.toBe(first);
	});

	// The subject is in the identity, so an address a subject vacated and another took cannot mint
	// the id the first one holds.
	it("separates two subjects recording the same prose at one address", () => {
		const address = "lexicon ts src/a.ts add().";
		const first = answerFactId("s1", address, "describe", "Adds.", [
			"lexfact declaration src/a.ts 0000000000000000",
		]);
		const second = answerFactId("s2", address, "describe", "Adds.", [
			"lexfact declaration src/a.ts 0000000000000000",
		]);

		expect(isFactId(first)).toBe(true);
		expect(second).not.toBe(first);
	});
});
