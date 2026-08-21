import { describe, expect, it } from "vitest";
import {
	composeSymbolId,
	isLocalSymbol,
	isParameterSymbol,
	isSymbolId,
	isWithin,
	moduleOf,
	normalizeModulePath,
	ownerOf,
	parseSymbolId,
	parseSymbolIdResult,
	quoteName,
	rebaseSymbolId,
	type SymbolId,
} from "../symbolId";

////////////////////////////////
//  Helpers

function roundTrip(id: SymbolId): SymbolId | null {
	return parseSymbolId(composeSymbolId(id));
}

const CART: SymbolId = {
	language: "typescript",
	module: "src/cart.ts",
	descriptors: [
		{ kind: "type", name: "Cart" },
		{ kind: "method", name: "add" },
	],
};

////////////////////////////////
//  Tests

describe("normalizeModulePath", () => {
	it("is the cross-platform contract: a Windows path and its POSIX twin are the same module", () => {
		expect(normalizeModulePath("src\\cart.ts")).toBe(normalizeModulePath("src/cart.ts"));
		expect(normalizeModulePath("a\\b\\c.ts")).toBe("a/b/c.ts");
	});

	it("collapses redundant separators and single dots", () => {
		expect(normalizeModulePath("./src//cart.ts")).toBe("src/cart.ts");
		expect(normalizeModulePath("src/./cart.ts")).toBe("src/cart.ts");
	});

	it("refuses an absolute POSIX path, which embeds a machine's layout", () => {
		expect(() => normalizeModulePath("/home/me/src/cart.ts")).toThrow(/workspace-relative/);
	});

	it("refuses a Windows drive path, the case a colon separator would have silently mangled", () => {
		expect(() => normalizeModulePath("C:\\proj\\src\\cart.ts")).toThrow(/workspace-relative/);
		expect(() => normalizeModulePath("C:/proj/src/cart.ts")).toThrow(/workspace-relative/);
	});

	it("refuses escaping the workspace rather than resolving it, so two files cannot share an id", () => {
		expect(() => normalizeModulePath("../other/cart.ts")).toThrow(/escape the workspace/);
		expect(() => normalizeModulePath("src/../../cart.ts")).toThrow(/escape the workspace/);
	});

	it("refuses an empty path", () => {
		expect(() => normalizeModulePath("")).toThrow(/empty/);
		expect(() => normalizeModulePath("./")).toThrow(/empty/);
	});
});

describe("composeSymbolId", () => {
	it("produces the documented shape", () => {
		expect(composeSymbolId(CART)).toBe("lexicon typescript src/cart.ts Cart#add().");
	});

	it("normalizes the module itself, so a provider cannot mint a host-dependent id by forgetting", () => {
		const windows = composeSymbolId({ ...CART, module: "src\\cart.ts" });
		expect(windows).toBe(composeSymbolId(CART));
	});

	it("encodes each descriptor kind with its own suffix", () => {
		const id = composeSymbolId({
			language: "csharp",
			module: "Svc.cs",
			descriptors: [
				{ kind: "namespace", name: "Acme" },
				{ kind: "type", name: "Service" },
				{ kind: "method", name: "Compute", disambiguator: "2" },
				{ kind: "parameter", name: "qty" },
			],
		});
		expect(id).toBe("lexicon csharp Svc.cs Acme/Service#Compute(2).(qty)");
	});

	it("refuses a non-local symbol with no descriptors", () => {
		expect(() => composeSymbolId({ ...CART, descriptors: [] })).toThrow(/at least one descriptor/);
	});

	it("refuses a language containing whitespace, which would break the field count", () => {
		expect(() => composeSymbolId({ ...CART, language: "type script" })).toThrow(/slug/);
		expect(() => composeSymbolId({ ...CART, language: "" })).toThrow(/slug/);
	});

	it("refuses a negative or fractional local ordinal", () => {
		expect(() => composeSymbolId({ ...CART, descriptors: [], local: -1 })).toThrow(/non-negative integer/);
		expect(() => composeSymbolId({ ...CART, descriptors: [], local: 1.5 })).toThrow(/non-negative integer/);
	});
});

describe("round trip", () => {
	it("preserves a plain method", () => {
		expect(roundTrip(CART)).toEqual({ ...CART, module: "src/cart.ts" });
	});

	it("preserves every descriptor kind", () => {
		const id: SymbolId = {
			language: "python",
			module: "pkg/mod.py",
			descriptors: [
				{ kind: "namespace", name: "pkg" },
				{ kind: "type", name: "Klass" },
				{ kind: "term", name: "field" },
				{ kind: "meta", name: "note" },
				{ kind: "typeParameter", name: "T" },
			],
		};
		expect(roundTrip(id)).toEqual(id);
	});

	it("preserves a method disambiguator, which is what separates two overloads", () => {
		const one: SymbolId = { ...CART, descriptors: [{ kind: "method", name: "add", disambiguator: "1" }] };
		const two: SymbolId = { ...CART, descriptors: [{ kind: "method", name: "add", disambiguator: "2" }] };
		expect(composeSymbolId(one)).not.toBe(composeSymbolId(two));
		expect(roundTrip(one)).toEqual(one);
	});

	it("tells two same-named siblings apart for any kind that has room for it", () => {
		// Repeated heading text is ordinary in a document, so a namespace needs the slot a method has.
		for (const kind of ["namespace", "type", "meta"] as const) {
			const first: SymbolId = { ...CART, descriptors: [{ kind, name: "Notes" }] };
			const second: SymbolId = { ...CART, descriptors: [{ kind, name: "Notes", disambiguator: "2" }] };
			expect(composeSymbolId(first)).not.toBe(composeSymbolId(second));
			expect(roundTrip(second)).toEqual(second);
		}
	});

	it("keeps one spelling per symbol, so an empty slot stays method-only", () => {
		// `Notes()/` would name the same symbol as `Notes/`, and two spellings is two ids.
		expect(parseSymbolId("lexicon markdown a.md Notes()/")).toBeNull();
		expect(parseSymbolId("lexicon markdown a.md Notes()#")).toBeNull();
		// The method form is exactly where empty parens carry meaning.
		expect(parseSymbolId("lexicon typescript a.ts add().")?.descriptors[0]).toEqual({
			kind: "method",
			name: "add",
		});
	});

	it("refuses a disambiguator on a kind with nowhere to render it", () => {
		// A term's dot is the suffix the method form claims, so `x(2).` could only read back wrong.
		for (const kind of ["parameter", "typeParameter", "term"] as const) {
			const bad = { ...CART, descriptors: [{ kind, name: "value", disambiguator: "2" }] };
			expect(() => composeSymbolId(bad)).toThrow(/no slot/);
		}
	});

	it("preserves a local ordinal, so two same-named locals stay distinct symbols", () => {
		const a = composeSymbolId({ ...CART, descriptors: [], local: 0 });
		const b = composeSymbolId({ ...CART, descriptors: [], local: 1 });
		expect(a).not.toBe(b);
		expect(parseSymbolId(a)?.local).toBe(0);
		expect(isLocalSymbol(a)).toBe(true);
		expect(isLocalSymbol(composeSymbolId(CART))).toBe(false);
	});
});

describe("quoting", () => {
	it("leaves an ordinary name bare", () => {
		expect(quoteName("add")).toBe("add");
	});

	it("quotes a name containing a structural character", () => {
		for (const ch of [" ", "/", "#", ".", ":", "(", ")", "[", "]"]) {
			expect(quoteName(`a${ch}b`)).toBe(`\`a${ch}b\``);
		}
	});

	it("doubles an embedded backtick so the quote cannot be closed early", () => {
		expect(quoteName("a`b")).toBe("`a``b`");
	});

	it("round-trips a name with a space, which would otherwise split the id's fields", () => {
		const id: SymbolId = { ...CART, descriptors: [{ kind: "term", name: "my field" }] };
		expect(roundTrip(id)).toEqual(id);
	});

	it("round-trips a name made entirely of structural characters", () => {
		const id: SymbolId = { ...CART, descriptors: [{ kind: "term", name: "#.()" }] };
		expect(roundTrip(id)).toEqual(id);
	});

	it("round-trips a name containing backticks", () => {
		const id: SymbolId = { ...CART, descriptors: [{ kind: "term", name: "a`b``c" }] };
		expect(roundTrip(id)).toEqual(id);
	});

	it("refuses an empty descriptor name", () => {
		expect(() => quoteName("")).toThrow(/cannot be empty/);
	});
});

describe("distinctness", () => {
	it("separates a term from a method of the same name", () => {
		const term = composeSymbolId({ ...CART, descriptors: [{ kind: "term", name: "add" }] });
		const method = composeSymbolId({ ...CART, descriptors: [{ kind: "method", name: "add" }] });
		expect(term).not.toBe(method);
	});

	it("separates a nested member from a top-level one with the same name", () => {
		const nested = composeSymbolId({
			...CART,
			descriptors: [
				{ kind: "type", name: "Cart" },
				{ kind: "term", name: "id" },
			],
		});
		const top = composeSymbolId({ ...CART, descriptors: [{ kind: "term", name: "id" }] });
		expect(nested).not.toBe(top);
	});

	it("separates the same symbol name in two modules", () => {
		const a = composeSymbolId({ ...CART, module: "src/a.ts" });
		const b = composeSymbolId({ ...CART, module: "src/b.ts" });
		expect(a).not.toBe(b);
	});

	it("does not confuse a quoted name with the bare text it contains", () => {
		const quoted = composeSymbolId({ ...CART, descriptors: [{ kind: "term", name: "Cart#add" }] });
		const structural = composeSymbolId({
			...CART,
			descriptors: [
				{ kind: "type", name: "Cart" },
				{ kind: "term", name: "add" },
			],
		});
		expect(quoted).not.toBe(structural);
		expect(parseSymbolId(quoted)).not.toEqual(parseSymbolId(structural));
	});
});

describe("parseSymbolId rejects malformed input", () => {
	it("answers null rather than throwing, since bad ids arrive from providers and from disk", () => {
		for (const bad of [
			"",
			"lexicon",
			"lexicon typescript",
			"lexicon typescript src/cart.ts",
			"other typescript src/cart.ts Cart#",
			"lexicon  src/cart.ts Cart#",
			"lexicon typescript src/cart.ts Cart",
			"lexicon typescript src/cart.ts `unterminated",
			"lexicon typescript src/cart.ts (unclosed",
			"lexicon typescript src/cart.ts add(1)",
			"lexicon typescript src/cart.ts #",
		]) {
			expect(parseSymbolId(bad), bad).toBeNull();
			expect(isSymbolId(bad), bad).toBe(false);
		}
	});

	it("accepts a local ordinal only in its exact form", () => {
		expect(parseSymbolId("lexicon typescript src/cart.ts local7")?.local).toBe(7);
		expect(parseSymbolId("lexicon typescript src/cart.ts localx")).toBeNull();
	});
});

describe("audit findings", () => {
	it("refuses a disambiguator that could close the parens early", () => {
		const bad = { ...CART, descriptors: [{ kind: "method" as const, name: "m", disambiguator: "x).foo(" }] };
		expect(() => composeSymbolId(bad)).toThrow(/disambiguator/);
		expect(() =>
			composeSymbolId({ ...CART, descriptors: [{ kind: "method", name: "m", disambiguator: ")" }] }),
		).toThrow();
	});

	// Dropping one collapsed two symbols the caller meant to keep apart onto a single id, which
	// looks exactly like a correct answer.
	it("refuses a disambiguator on a kind that cannot render one", () => {
		for (const kind of ["term", "parameter", "typeParameter"] as const) {
			expect(() =>
				composeSymbolId({ ...CART, descriptors: [{ kind, name: "Thing", disambiguator: "1" }] }),
			).toThrow(/no slot for a disambiguator/);
		}
	});

	it("still composes those kinds when no disambiguator is set", () => {
		expect(composeSymbolId({ ...CART, descriptors: [{ kind: "type", name: "Thing" }] })).toContain("Thing#");
		expect(composeSymbolId({ ...CART, descriptors: [{ kind: "term", name: "thing" }] })).toContain("thing.");
	});

	it("does not let a crafted disambiguator impersonate a longer descriptor chain", () => {
		const chain = composeSymbolId({
			...CART,
			descriptors: [
				{ kind: "method", name: "m", disambiguator: "x" },
				{ kind: "method", name: "foo" },
			],
		});
		expect(chain).toBe("lexicon typescript src/cart.ts m(x).foo().");
		expect(parseSymbolId(chain)?.descriptors).toHaveLength(2);
	});

	it("refuses a local that also carries descriptors, rather than dropping them", () => {
		expect(() => composeSymbolId({ ...CART, local: 0 })).toThrow(/cannot also carry descriptors/);
	});

	it("carries a space in a module through a round trip, since real paths have them", () => {
		const id: SymbolId = { ...CART, module: "src/my file.ts" };
		expect(composeSymbolId(id)).toBe("lexicon typescript src/my%20file.ts Cart#add().");
		expect(roundTrip(id)).toEqual(id);
	});

	it("round-trips a literal percent in a module without double-decoding", () => {
		const id: SymbolId = { ...CART, module: "src/100%25 done.ts" };
		expect(roundTrip(id)).toEqual(id);
	});

	it("refuses control characters in a module", () => {
		expect(() => normalizeModulePath("src/a\tb.ts")).toThrow(/control characters/);
		expect(() => normalizeModulePath("src/a\nb.ts")).toThrow(/control characters/);
	});

	it("refuses a local ordinal past the safe integer range, which would merge two symbols", () => {
		expect(() => composeSymbolId({ ...CART, descriptors: [], local: Number.MAX_VALUE })).toThrow(/safe/);
		expect(parseSymbolId("lexicon typescript src/cart.ts local9007199254740993")).toBeNull();
		expect(parseSymbolId("lexicon typescript src/cart.ts local007")).toBeNull();
	});

	it("parses only modules the composer would emit, so the two cannot disagree", () => {
		expect(parseSymbolId("lexicon typescript /home/me/cart.ts Cart#")).toBeNull();
		expect(parseSymbolId("lexicon typescript src\\cart.ts Cart#")).toBeNull();
		expect(parseSymbolId("lexicon typescript src/../cart.ts Cart#")).toBeNull();
		expect(parseSymbolId("lexicon typescript C:/proj/cart.ts Cart#")).toBeNull();
	});

	it("refuses an empty quoted name, which compose can never produce", () => {
		expect(parseSymbolId("lexicon typescript src/cart.ts ``.")).toBeNull();
	});

	it("gives one id to a decomposed and a composed filename, since macOS and Linux differ", () => {
		const nfc = composeSymbolId({ ...CART, module: "src/caf\u00e9.ts" });
		const nfd = composeSymbolId({ ...CART, module: "src/cafe\u0301.ts" });
		expect(nfd).toBe(nfc);
	});

	it("gives one id to a decomposed and a composed symbol name", () => {
		const nfc = composeSymbolId({ ...CART, descriptors: [{ kind: "term", name: "caf\u00e9" }] });
		const nfd = composeSymbolId({ ...CART, descriptors: [{ kind: "term", name: "cafe\u0301" }] });
		expect(nfd).toBe(nfc);
	});

	it("keeps case significant, because collapsing it would collide on case-sensitive hosts", () => {
		const upper = composeSymbolId({ ...CART, module: "src/Cart.ts" });
		const lower = composeSymbolId({ ...CART, module: "src/cart.ts" });
		expect(upper).not.toBe(lower);
	});
});

describe("failure diagnoses", () => {
	function failure(text: string) {
		const r = parseSymbolIdResult(text);
		if (r.ok) throw new Error(`expected a failure for ${JSON.stringify(text)}`);
		return r.failure;
	}

	it("names the offending token and where it sits, not just that parsing failed", () => {
		const f = failure("lexicon typescript src/cart.ts Cart");
		expect(f.message).toMatch(/descriptor suffix/);
		expect(f.offset).toBe(35);
		expect(f.context).toContain("[Cart]");
	});

	it("points at the module when it is not canonical", () => {
		const f = failure("lexicon typescript /abs/cart.ts Cart#");
		expect(f.message).toMatch(/canonical/);
		expect(f.context).toContain("[/abs/cart.ts]");
	});

	it("distinguishes a wrong scheme from a missing field", () => {
		expect(failure("other typescript src/cart.ts Cart#").message).toMatch(/scheme/);
		expect(failure("lexicon").message).toMatch(/expected a space after the scheme/);
	});

	it("says which delimiter it wanted after a disambiguator", () => {
		expect(failure("lexicon typescript src/cart.ts add(1").message).toMatch(/\) to close/);
		expect(failure("lexicon typescript src/cart.ts add(1)x").message).toMatch(/descriptor suffix/);
	});

	it("reports an unsafe local ordinal as such rather than as a bad descriptor", () => {
		expect(failure("lexicon typescript src/cart.ts local9007199254740993").message).toMatch(/safe integer/);
	});

	it("agrees with the null-returning shim on every rejection", () => {
		for (const bad of ["", "lexicon", "other x y z.", "lexicon typescript /abs.ts A#"]) {
			expect(parseSymbolId(bad)).toBeNull();
			expect(parseSymbolIdResult(bad).ok).toBe(false);
		}
	});
});

describe("moduleOf", () => {
	it("answers the module, which is what invalidation keys on", () => {
		expect(moduleOf(composeSymbolId(CART))).toBe("src/cart.ts");
	});

	it("answers null for a malformed id instead of a plausible wrong module", () => {
		expect(moduleOf("nonsense")).toBeNull();
	});
});

/**
 * Ownership read out of the id itself, which is what keeps it language-neutral.
 *
 * Renaming a parameter has to rewrite the argument naming it at every call site, and those spell the
 * FUNCTION's name rather than the parameter's. Finding the function is a question the grammar
 * already answers, so the core needs no store lookup and no knowledge of any language to ask it.
 */
describe("who a symbol belongs to", () => {
	const parameter = {
		language: "python",
		module: "src/cart.py",
		descriptors: [
			{ kind: "method" as const, name: "add" },
			{ kind: "parameter" as const, name: "quantity" },
		],
	};

	it("gives a parameter its function by dropping the last descriptor", () => {
		expect(ownerOf(composeSymbolId(parameter))).toBe(
			composeSymbolId({ ...parameter, descriptors: parameter.descriptors.slice(0, 1) }),
		);
	});

	it("gives a member its type, since the same relationship spells the same way", () => {
		const method = {
			language: "typescript",
			module: "src/cart.ts",
			descriptors: [
				{ kind: "type" as const, name: "Cart" },
				{ kind: "method" as const, name: "add" },
			],
		};
		expect(ownerOf(composeSymbolId(method))).toBe(
			composeSymbolId({ ...method, descriptors: method.descriptors.slice(0, 1) }),
		);
	});

	it("answers null for a top-level symbol, which owns itself", () => {
		const top = {
			language: "typescript",
			module: "src/cart.ts",
			descriptors: [{ kind: "type" as const, name: "Cart" }],
		};
		expect(ownerOf(composeSymbolId(top))).toBeNull();
	});

	// A local's ordinal names no chain, so there is nothing to drop and nothing to own it.
	it("answers null for a local and for anything malformed", () => {
		expect(ownerOf(composeSymbolId({ language: "ts", module: "src/a.ts", descriptors: [], local: 3 }))).toBeNull();
		expect(ownerOf("nonsense")).toBeNull();
	});

	it("recognizes a parameter, which is the case whose rename reaches its owner's callers", () => {
		expect(isParameterSymbol(composeSymbolId(parameter))).toBe(true);
		expect(isParameterSymbol(composeSymbolId(CART))).toBe(false);
		expect(isParameterSymbol("nonsense")).toBe(false);
	});
});

describe("re-minting a subtree when its container is renamed or its module moves", () => {
	const cartClass = composeSymbolId({
		language: "typescript",
		module: "src/cart.ts",
		descriptors: [{ kind: "type", name: "Cart" }],
	});
	const addMethod = composeSymbolId(CART);
	const addQuantity = composeSymbolId({
		...CART,
		descriptors: [...CART.descriptors, { kind: "parameter", name: "quantity" }],
	});

	const basketClass = composeSymbolId({
		language: "typescript",
		module: "src/cart.ts",
		descriptors: [{ kind: "type", name: "Basket" }],
	});
	const movedClass = composeSymbolId({
		language: "typescript",
		module: "src/basket/index.ts",
		descriptors: [{ kind: "type", name: "Cart" }],
	});

	// A member's id carries its container's descriptors, so renaming a class re-mints every id
	// beneath it and migrating only the class strands them.
	it("carries a rename down to members and their parameters", () => {
		expect(rebaseSymbolId(cartClass, cartClass, basketClass)).toBe(basketClass);
		expect(rebaseSymbolId(addMethod, cartClass, basketClass)).toBe(
			composeSymbolId({ ...CART, descriptors: [{ kind: "type", name: "Basket" }, CART.descriptors[1] as never] }),
		);
		expect(rebaseSymbolId(addQuantity, cartClass, basketClass)).toBe(
			composeSymbolId({
				...CART,
				descriptors: [
					{ kind: "type", name: "Basket" },
					{ kind: "method", name: "add" },
					{ kind: "parameter", name: "quantity" },
				],
			}),
		);
	});

	it("carries a move down the same way, since only the module field differs", () => {
		expect(rebaseSymbolId(addMethod, cartClass, movedClass)).toBe(
			composeSymbolId({ ...CART, module: "src/basket/index.ts" }),
		);
		expect(moduleOf(rebaseSymbolId(addQuantity, cartClass, movedClass) as string)).toBe("src/basket/index.ts");
	});

	it("leaves anything outside the subtree alone", () => {
		const sibling = composeSymbolId({
			language: "typescript",
			module: "src/cart.ts",
			descriptors: [{ kind: "type", name: "Item" }],
		});
		const otherModule = composeSymbolId({
			language: "typescript",
			module: "src/other.ts",
			descriptors: [{ kind: "type", name: "Cart" }],
		});

		expect(rebaseSymbolId(sibling, cartClass, basketClass)).toBeNull();
		expect(rebaseSymbolId(otherModule, cartClass, basketClass)).toBeNull();
	});

	// A name is not a prefix of a longer name that starts with it, or renaming Cart would drag
	// CartItem along with it.
	it("matches whole descriptors rather than name prefixes", () => {
		const cartItem = composeSymbolId({
			language: "typescript",
			module: "src/cart.ts",
			descriptors: [{ kind: "type", name: "CartItem" }],
		});
		expect(rebaseSymbolId(cartItem, cartClass, basketClass)).toBeNull();
	});

	// A term and a type of the same name are different symbols, so one's rename is not the other's.
	it("distinguishes descriptors that differ only by kind", () => {
		const cartTerm = composeSymbolId({
			language: "typescript",
			module: "src/cart.ts",
			descriptors: [{ kind: "term", name: "Cart" }],
		});
		expect(rebaseSymbolId(cartTerm, cartClass, basketClass)).toBeNull();
	});

	it("reports a local as unrebaseable, since its ordinal names no chain", () => {
		const local = composeSymbolId({ language: "typescript", module: "src/cart.ts", descriptors: [], local: 2 });

		expect(rebaseSymbolId(local, cartClass, basketClass)).toBeNull();
		expect(isWithin(local, cartClass)).toBe(false);
	});

	it("answers null for malformed input rather than throwing", () => {
		expect(rebaseSymbolId("nonsense", cartClass, basketClass)).toBeNull();
		expect(rebaseSymbolId(addMethod, "nonsense", basketClass)).toBeNull();
		expect(rebaseSymbolId(addMethod, cartClass, "nonsense")).toBeNull();
	});

	it("reads containment straight off the chain", () => {
		expect(isWithin(addQuantity, cartClass)).toBe(true);
		expect(isWithin(cartClass, cartClass)).toBe(true);
		expect(isWithin(cartClass, addMethod)).toBe(false);
	});
});
