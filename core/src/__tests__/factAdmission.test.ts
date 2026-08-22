import {
	composeSymbolId,
	type Declaration,
	type DocRegion,
	type Literal,
	type Reference,
} from "@nyaa-lexicon/protocol";
import { describe, expect, it } from "vitest";
import { admitFacts, FactAdmissionError, notCanonical, type ProviderFacts } from "../factAdmission";

////////////////////////////////
//  Helpers

const MODULE = "src/a.ts";
const POINT = { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } };

function idOf(name: string, module = MODULE, kind: "class" | "heading" = "class"): string {
	return composeSymbolId({
		language: "ts",
		module,
		descriptors: [{ kind: kind === "class" ? "type" : "namespace", name }],
	});
}

function declaration(name: string, extra: Partial<Declaration> = {}): Declaration {
	return {
		symbolId: idOf(name),
		kind: "class",
		name,
		range: POINT,
		selectionRange: POINT,
		visibility: "public",
		...extra,
	};
}

function reference(extra: Partial<Reference> = {}): Reference {
	return {
		name: "x",
		range: POINT,
		role: "call",
		binding: { status: "unbound", reason: "NotImplemented" },
		...extra,
	};
}

function literal(containerId?: string): Literal {
	return { kind: "string", value: "v", range: POINT, ...(containerId === undefined ? {} : { containerId }) };
}

function region(anchorId?: string): DocRegion {
	return { range: POINT, text: "prose", fenced: false, ...(anchorId === undefined ? {} : { anchorId }) };
}

function facts(partial: Partial<ProviderFacts>): ProviderFacts {
	return { declarations: [], references: [], literals: [], docs: [], ...partial };
}

const admit = (partial: Partial<ProviderFacts>) => () => admitFacts(MODULE, facts(partial));

////////////////////////////////
//  Tests

describe("spelling", () => {
	it("accepts exactly what the composer emits, for every descriptor shape", () => {
		const shapes = [
			{ descriptors: [{ kind: "type" as const, name: "Cart" }] },
			{
				descriptors: [
					{ kind: "namespace" as const, name: "shop" },
					{ kind: "term" as const, name: "weird name" },
				],
			},
			{
				descriptors: [
					{ kind: "type" as const, name: "back`tick" },
					{ kind: "method" as const, name: "add" },
				],
			},
			{ descriptors: [{ kind: "method" as const, name: "add", disambiguator: "2" }] },
			{
				descriptors: [
					{ kind: "type" as const, name: "Cart" },
					{ kind: "parameter" as const, name: "x" },
				],
			},
			{
				descriptors: [
					{ kind: "type" as const, name: "Cart" },
					{ kind: "typeParameter" as const, name: "T" },
				],
			},
			{ descriptors: [{ kind: "meta" as const, name: "doc" }] },
			{ descriptors: [{ kind: "namespace" as const, name: "shop", disambiguator: "v2" }] },
			{ descriptors: [{ kind: "type" as const, name: "Cart", disambiguator: "1" }] },
			{ descriptors: [{ kind: "meta" as const, name: "doc", disambiguator: "a-b" }] },
			{ descriptors: [{ kind: "term" as const, name: "a#b(c).d:e/f[g]" }] },
			{ descriptors: [], local: 3 },
		];
		for (const shape of shapes) {
			const id = composeSymbolId({ language: "ts", module: "src/a b/c.ts", ...shape });
			expect(notCanonical(id), id).toBeNull();
		}
	});

	it("refuses a second spelling of one symbol, so one symbol has one id", () => {
		expect(notCanonical("lexicon ts src/%2F.md Cart#")).not.toBeNull();
		expect(notCanonical("lexicon ts src//a.ts Cart#")).not.toBeNull();
		expect(notCanonical("lexicon ts src/a.ts `Cart`#")).not.toBeNull();
		expect(notCanonical("not an id")).not.toBeNull();
	});
});

describe("what each id must mean", () => {
	it("passes a file whose ids all mean what their fields say", () => {
		const cart = declaration("Cart");
		const add = declaration("add", {
			symbolId: `${cart.symbolId}add().`,
			kind: "method",
			containerId: cart.symbolId,
		});
		expect(
			admit({
				declarations: [cart, add],
				references: [
					reference({
						fromId: add.symbolId,
						binding: { status: "bound", symbolId: idOf("Money", "src/money.ts"), provenance: "bound" },
					}),
				],
				literals: [literal(add.symbolId)],
			}),
		).not.toThrow();
	});

	it("refuses a declaration naming another module, or one that is not an id", () => {
		expect(admit({ declarations: [declaration("Cart", { symbolId: idOf("Cart", "src/b.ts") })] })).toThrow(
			FactAdmissionError,
		);
		expect(admit({ declarations: [declaration("Cart", { symbolId: "lexicon ts src/%2F.ts Cart#" })] })).toThrow(
			/canonical/,
		);
	});

	it("refuses a container that is not declared in this parse, or is the declaration itself", () => {
		expect(admit({ declarations: [declaration("Cart", { containerId: idOf("Shop") })] })).toThrow(
			/not declared in this file/,
		);
		expect(admit({ declarations: [declaration("Cart", { containerId: idOf("Shop", "src/b.ts") })] })).toThrow(
			/not declared/,
		);
		expect(admit({ declarations: [declaration("Cart", { containerId: idOf("Cart") })] })).toThrow(
			/contains itself/,
		);
		expect(admit({ declarations: [declaration("Cart", { containerId: "lexicon ts src/a.ts `Shop`#" })] })).toThrow(
			/container .* canonical/,
		);
	});

	it("refuses a reference owner or a literal container that is not declared in this parse", () => {
		const cart = declaration("Cart");
		expect(admit({ declarations: [cart], references: [reference({ fromId: idOf("Ghost") })] })).toThrow(
			/reference owner/,
		);
		expect(admit({ declarations: [cart], literals: [literal(idOf("Ghost"))] })).toThrow(/literal container/);
		expect(
			admit({
				declarations: [cart],
				references: [reference({ fromId: cart.symbolId })],
				literals: [literal(cart.symbolId)],
			}),
		).not.toThrow();
	});

	it("lets a binding target live anywhere, but refuses one that is not an id", () => {
		const bound = (symbolId: string) => reference({ binding: { status: "bound", symbolId, provenance: "bound" } });
		expect(admit({ references: [bound(idOf("Ghost", "other/far.ts"))] })).not.toThrow();
		expect(admit({ references: [bound("lexicon ts src/%2F.ts Ghost#")] })).toThrow(/binding target/);
	});

	it("refuses a document anchor that is not a heading declared in this parse", () => {
		const heading = declaration("Guide", { symbolId: idOf("Guide", MODULE, "heading"), kind: "heading" });
		expect(admit({ declarations: [heading], docs: [region(heading.symbolId)] })).not.toThrow();
		expect(admit({ declarations: [declaration("Cart")], docs: [region(idOf("Cart"))] })).toThrow(/not a heading/);
		expect(admit({ declarations: [heading], docs: [region(idOf("Guide", "docs/other.md", "heading"))] })).toThrow(
			/not declared/,
		);
	});

	// The store holds one row per id, so a second declaration would replace the first in silence.
	it("refuses a name path declared twice", () => {
		const heading = declaration("Guide", { symbolId: idOf("Guide", MODULE, "heading"), kind: "heading" });
		expect(admit({ declarations: [heading, { ...heading, kind: "property" }] })).toThrow(/declared twice/);
	});
});
