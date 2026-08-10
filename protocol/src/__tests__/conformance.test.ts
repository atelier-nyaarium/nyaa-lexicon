import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkFacts, checkImport, checkType, describeIdParts } from "../conformance/check";
import { casesForTier, corpusLanguages, loadCorpus } from "../conformance/corpus";
import { extractDeclarations, REFERENCE_TIERS } from "../conformance/referenceProvider";
import { formatReport, runSuite } from "../conformance/runner";
import type { ConformanceCase } from "../conformance/types";
import type { FileFacts } from "../project";
import { composeSymbolId } from "../symbolId";

////////////////////////////////
//  Helpers

const PROVIDER = path.join(import.meta.dirname, "..", "conformance", "referenceProvider.ts");

function idFor(name: string, kind: "type" | "term" = "term"): string {
	return composeSymbolId({ language: "x", module: "src/a.ts", descriptors: [{ kind, name }] });
}

function facts(partial: Partial<FileFacts>): FileFacts {
	return {
		module: "src/a.ts",
		contentHash: "h1",
		declarations: [],
		references: [],
		imports: [],
		literals: [],
		diagnostics: [],
		...partial,
	};
}

function decl(name: string, extra: Record<string, unknown> = {}) {
	return {
		symbolId: idFor(name),
		kind: "function" as const,
		name,
		range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
		selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
		visibility: "public" as const,
		exported: true,
		...extra,
	};
}

////////////////////////////////
//  Tests

describe("corpus", () => {
	it("validates every case, so a malformed one fails here and not inside a provider run", () => {
		expect(() => loadCorpus()).not.toThrow();
		expect(loadCorpus().length).toBeGreaterThan(0);
	});

	it("gives every case a unique id", () => {
		const ids = loadCorpus().map((c) => c.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("names a subject that exists among each fixture's files", () => {
		for (const testCase of loadCorpus()) {
			for (const [language, fixture] of Object.entries(testCase.fixtures)) {
				expect(Object.keys(fixture.files), `${testCase.id}/${language}`).toContain(fixture.subject);
			}
		}
	});

	it("gives every case a fixture in at least one language", () => {
		for (const testCase of loadCorpus()) {
			expect(Object.keys(testCase.fixtures), testCase.id).not.toHaveLength(0);
		}
	});

	it("speaks the languages its fixtures are written in", () => {
		expect(corpusLanguages()).toContain("typescript");
		expect(corpusLanguages()).toContain("reference");
	});

	it("partitions by tier, which is how a team runs only what it claims", () => {
		expect(casesForTier("declarations").every((c) => c.tier === "declarations")).toBe(true);
		expect(casesForTier("nonexistent")).toEqual([]);
	});
});

describe("checking answers", () => {
	it("reports a declaration the provider never mentioned", () => {
		const testCase = { declarations: [{ name: "Cart" }] } as ConformanceCase;
		expect(checkFacts(testCase, facts({}))).toEqual(["declaration Cart: not reported"]);
	});

	it("passes when the expectation is satisfied, and ignores extras", () => {
		const testCase = { declarations: [{ name: "a", exported: true }] } as ConformanceCase;
		expect(checkFacts(testCase, facts({ declarations: [decl("a"), decl("b")] }))).toEqual([]);
	});

	it("names the mismatch rather than only failing", () => {
		const testCase = { declarations: [{ name: "a", kind: "class" as const }] } as ConformanceCase;
		expect(checkFacts(testCase, facts({ declarations: [decl("a")] }))[0]).toMatch(
			/kind is function, expected class/,
		);
	});

	it("accepts any one of several same-named declarations, since a name cannot pick an overload", () => {
		const testCase = { declarations: [{ name: "a", kind: "class" as const }] } as ConformanceCase;
		const both = facts({ declarations: [decl("a"), decl("a", { kind: "class" })] });
		expect(checkFacts(testCase, both)).toEqual([]);
	});

	it("resolves a binding to the declaration's NAME, so a case never states an id", () => {
		const target = decl("add");
		const reference = {
			name: "add",
			range: { start: { line: 1, character: 0 }, end: { line: 1, character: 3 } },
			role: "call" as const,
			binding: { status: "bound" as const, symbolId: target.symbolId, provenance: "bound" as const },
		};
		const testCase = { references: [{ name: "add", bindsTo: "add" }] } as ConformanceCase;
		expect(checkFacts(testCase, facts({ declarations: [target], references: [reference] }))).toEqual([]);
	});

	it("fails a name-matched binding where the case asked for a bound one", () => {
		const reference = {
			name: "add",
			range: { start: { line: 1, character: 0 }, end: { line: 1, character: 3 } },
			role: "call" as const,
			binding: { status: "unbound" as const, reason: "NotImplemented" as const },
		};
		const testCase = { references: [{ name: "add", bindsTo: "add" }] } as ConformanceCase;
		expect(checkFacts(testCase, facts({ references: [reference] }))[0]).toMatch(/binding is unbound/);
	});

	it("pins WHICH reason an unbound reference carries, not merely that it is unbound", () => {
		const unbound = (reason: "NotIndexed" | "RuntimeConstructed") => ({
			name: "helper",
			range: { start: { line: 1, character: 0 }, end: { line: 1, character: 6 } },
			role: "read" as const,
			binding: { status: "unbound" as const, reason },
		});
		const testCase = { references: [{ name: "helper", reason: "NotIndexed" }] } as ConformanceCase;

		expect(checkFacts(testCase, facts({ references: [unbound("NotIndexed")] }))).toEqual([]);
		// A local reported as "built at runtime" is the exact confident-wrong-answer the suite exists
		// to catch, and before this it passed for being unbound at all.
		expect(checkFacts(testCase, facts({ references: [unbound("RuntimeConstructed")] }))[0]).toMatch(
			/unbound for RuntimeConstructed, expected NotIndexed/,
		);
	});

	it("pins an expected honest Unknown type, which a display-only expectation cannot state", () => {
		const expected = { name: "value", status: "unknown" as const, reason: "DynamicallyTyped" as const };
		expect(checkType(expected, { status: "unknown", reason: "DynamicallyTyped" })).toEqual([]);
		expect(checkType(expected, { status: "unknown", reason: "NotImplemented" })[0]).toMatch(
			/unknown for NotImplemented, expected DynamicallyTyped/,
		);
		expect(checkType(expected, { status: "known", display: "any", provenance: "declared" })[0]).toMatch(
			/status is known, expected unknown/,
		);
	});

	it("separates external from unresolved, which are different answers", () => {
		expect(
			checkImport({ specifier: "zod", status: "external" }, { status: "external", packageName: "zod" }),
		).toEqual([]);
		expect(
			checkImport(
				{ specifier: "zod", status: "external" },
				{ status: "unresolved", reason: "NotImplemented" },
			)[0],
		).toMatch(/resolved as unresolved, expected external/);
	});

	it("reports an unknown type with its reason rather than as a bare mismatch", () => {
		const problem = checkType({ name: "L", display: "number" }, { status: "unknown", reason: "DynamicallyTyped" });
		expect(problem[0]).toMatch(/unknown \(DynamicallyTyped\)/);
	});

	it("states id expectations as parsed parts, never as the wire string", () => {
		expect(describeIdParts(idFor("Cart", "type"))).toEqual(["type:Cart"]);
		expect(describeIdParts("not an id")).toBeNull();
	});
});

describe("the reference provider", () => {
	it("extracts the declarations it claims to", () => {
		const found = extractDeclarations("src/a.ts", "export class Cart {}\nexport function add() {}\n");
		expect(found.map((d) => [d.name, d.kind])).toEqual([
			["Cart", "class"],
			["add", "function"],
		]);
	});

	it("declares the tiers it does not do as false, rather than claiming them", () => {
		expect(REFERENCE_TIERS.declarations).toBe(true);
		expect(REFERENCE_TIERS.types).toBe(false);
		expect(REFERENCE_TIERS.binding).toBe(false);
	});
});

describe("running the suite against a real process", () => {
	it("passes a legitimately partial provider, reporting its undeclared tiers as skipped", async () => {
		const report = await runSuite({ command: ["bun", "run", PROVIDER], cases: loadCorpus(), timeoutMs: 15_000 });

		expect(report.providerId).toBe("reference-provider");
		// The whole tiering claim: undeclared tiers are skipped, and nothing it claims fails.
		expect(report.failed, formatReport(report)).toBe(0);
		expect(report.passed).toBeGreaterThan(0);
		expect(report.skipped).toBeGreaterThan(0);
	}, 30_000);

	it("fails a case the provider genuinely gets wrong, rather than passing vacuously", async () => {
		const wrong: ConformanceCase = {
			id: "impossible",
			tier: "declarations",
			about: "A declaration the reference provider cannot find, to prove the runner can fail.",
			fixtures: { reference: { files: { "src/a.ref": "export class Cart {}\n" }, subject: "src/a.ref" } },
			declarations: [{ name: "NotThere" }],
		};
		const report = await runSuite({ command: ["bun", "run", PROVIDER], cases: [wrong], timeoutMs: 15_000 });

		expect(report.failed).toBe(1);
		expect(report.results[0]?.problems[0]).toMatch(/not reported/);
	}, 30_000);
});
