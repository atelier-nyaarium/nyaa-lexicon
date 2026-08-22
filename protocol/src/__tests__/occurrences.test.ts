import { describe, expect, it } from "vitest";
import { withOccurrences } from "../occurrences";
import type { FileFacts } from "../project";
import { composeSymbolId, type Descriptor } from "../symbolId";
import type { Declaration, Range } from "../symbols";

////////////////////////////////
//  Helpers

const MODULE = "src/a.ts";

function id(...descriptors: Descriptor[]): string {
	return composeSymbolId({ language: "ts", module: MODULE, descriptors });
}

function span(startLine: number, endLine: number): Range {
	return { start: { line: startLine, character: 0 }, end: { line: endLine, character: 1 } };
}

function decl(symbolId: string, range: Range, containerId?: string): Declaration {
	return {
		symbolId,
		name: symbolId.split(" ").at(-1) ?? symbolId,
		kind: "class",
		range,
		selectionRange: range,
		visibility: "public",
		...(containerId === undefined ? {} : { containerId }),
	};
}

function facts(partial: Partial<FileFacts>): FileFacts {
	return {
		module: MODULE,
		contentHash: "h",
		declarations: [],
		references: [],
		imports: [],
		literals: [],
		diagnostics: [],
		...partial,
	};
}

const CART = id({ kind: "type", name: "Cart" });
const CART_2 = id({ kind: "type", name: "Cart", occurrence: 2 });
const A_IN_CART = id({ kind: "type", name: "Cart" }, { kind: "term", name: "a" });
const B_IN_CART = id({ kind: "type", name: "Cart" }, { kind: "term", name: "b" });

////////////////////////////////
//  Tests

describe("settling a name path declared twice", () => {
	it("leaves a file with no repeated id untouched", () => {
		const input = facts({ declarations: [decl(CART, span(0, 2)), decl(A_IN_CART, span(1, 1), CART)] });
		expect(withOccurrences(input)).toBe(input);
	});

	it("gives the second declaration an occurrence and re-parents what it holds, positionally", () => {
		const input = facts({
			declarations: [
				decl(CART, span(0, 2)),
				decl(A_IN_CART, span(1, 1), CART),
				decl(CART, span(3, 5)),
				decl(B_IN_CART, span(4, 4), CART),
			],
			references: [
				{
					name: "a",
					range: span(1, 1),
					role: "read",
					binding: { status: "unbound", reason: "NotImplemented" },
					fromId: CART,
				},
				{
					name: "b",
					range: span(4, 4),
					role: "read",
					binding: { status: "bound", symbolId: CART, provenance: "bound" },
					fromId: CART,
				},
			],
			literals: [
				{ kind: "string", value: "x", range: span(1, 1), containerId: CART },
				{ kind: "string", value: "y", range: span(4, 4), containerId: CART },
			],
		});

		const settled = withOccurrences(input);
		expect(settled.declarations.map((declaration) => declaration.symbolId)).toEqual([
			CART,
			A_IN_CART,
			CART_2,
			id({ kind: "type", name: "Cart", occurrence: 2 }, { kind: "term", name: "b" }),
		]);
		expect(settled.declarations.map((declaration) => declaration.containerId)).toEqual([
			undefined,
			CART,
			undefined,
			CART_2,
		]);
		expect(settled.references.map((reference) => reference.fromId)).toEqual([CART, CART_2]);
		expect(settled.references[1]?.binding).toEqual({ status: "bound", symbolId: CART, provenance: "bound" });
		expect(settled.literals.map((literal) => literal.containerId)).toEqual([CART, CART_2]);
	});

	it("counts in source order whatever order the provider listed them", () => {
		const input = facts({ declarations: [decl(CART, span(3, 5)), decl(CART, span(0, 2))] });
		expect(withOccurrences(input).declarations.map((declaration) => declaration.symbolId)).toEqual([CART_2, CART]);
	});

	it("numbers a third occurrence three, and tells siblings apart under a re-parented second", () => {
		const input = facts({
			declarations: [
				decl(CART, span(0, 0)),
				decl(CART, span(1, 1)),
				decl(CART, span(2, 4)),
				decl(A_IN_CART, span(3, 3), CART),
			],
		});
		const settled = withOccurrences(input).declarations.map((declaration) => declaration.symbolId);
		expect(settled[2]).toBe(id({ kind: "type", name: "Cart", occurrence: 3 }));
		expect(settled[3]).toBe(id({ kind: "type", name: "Cart", occurrence: 3 }, { kind: "term", name: "a" }));
	});

	it("allocates past an occurrence the provider minted itself", () => {
		const cart3 = id({ kind: "type", name: "Cart", occurrence: 3 });
		const minted = facts({
			declarations: [decl(CART, span(0, 0)), decl(CART_2, span(1, 1)), decl(CART, span(2, 2))],
		});
		expect(withOccurrences(minted).declarations.map((declaration) => declaration.symbolId)).toEqual([
			CART,
			CART_2,
			cart3,
		]);

		const twice = facts({ declarations: [decl(CART_2, span(0, 0)), decl(CART_2, span(1, 1))] });
		expect(withOccurrences(twice).declarations.map((declaration) => declaration.symbolId)).toEqual([CART_2, cart3]);
	});

	it("puts the wider declaration first when two start together, whatever order the provider used", () => {
		const listedPointFirst = facts({ declarations: [decl(CART, span(0, 0)), decl(CART, span(0, 2))] });
		const listedWideFirst = facts({ declarations: [decl(CART, span(0, 2)), decl(CART, span(0, 0))] });
		expect(withOccurrences(listedPointFirst).declarations.map((declaration) => declaration.symbolId)).toEqual([
			CART_2,
			CART,
		]);
		expect(withOccurrences(listedWideFirst).declarations.map((declaration) => declaration.symbolId)).toEqual([
			CART,
			CART_2,
		]);
	});

	it("leaves a repeated parameter alone, since its descriptor has no slot", () => {
		const parameter = id({ kind: "method", name: "work" }, { kind: "parameter", name: "x" });
		const input = facts({ declarations: [decl(parameter, span(0, 0)), decl(parameter, span(1, 1))] });
		expect(withOccurrences(input).declarations.map((declaration) => declaration.symbolId)).toEqual([
			parameter,
			parameter,
		]);
	});
});
