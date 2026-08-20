import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkFacts, checkImport, checkType, describeIdParts } from "../conformance/check";
import { casesForTier, corpusLanguages, loadCorpus } from "../conformance/corpus";
import { loadMoveCases } from "../conformance/moveCorpus";
import { extractComments, extractDeclarations, REFERENCE_TIERS } from "../conformance/referenceProvider";
import { formatReport, runSuite } from "../conformance/runner";
import type { ConformanceCase, MoveCase } from "../conformance/types";
import { coordinatesOf } from "../coordinates";
import type { MoveEditsRequest } from "../move";
import type { FileFacts } from "../project";
import { composeSymbolId } from "../symbolId";
import type { Range } from "../symbols";

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

function rangeForText(text: string, value: string): Range {
	const start = text.indexOf(value);
	if (start === -1) throw new Error(`missing test text: ${value}`);
	const range = coordinatesOf(text).rangeAt(start, start + value.length);
	if (range === undefined) throw new Error(`unaddressable test range: ${value}`);
	return range;
}

function referenceNamedMove(id: string, expectedSpecifier: string): MoveCase {
	const text = 'import { add } from "./cart";\nadd(1, 2);\n';
	return {
		id,
		about: "A simple named import repoint for the reference provider.",
		fixtures: {
			reference: {
				files: {
					"src/cart.ref": "export function add() {}\n",
					"src/items.ref": "",
					"src/use.ref": text,
				},
				request: {
					module: "src/use.ref",
					text,
					exists: true,
					symbolId: "lexicon reference src/cart.ref add.",
					name: "add",
					fromModule: "src/cart.ref",
					toModule: "src/items.ref",
					role: {},
					importSites: [
						{
							range: rangeForText(text, "add"),
							specifier: "./cart",
							importKind: "named",
							importedName: "add",
							localName: "add",
							reExport: false,
						},
					],
					dependencies: [],
					sites: [],
				},
				expect: {
					kind: "ready",
					files: {
						"src/use.ref": `import { add } from "${expectedSpecifier}";\nadd(1, 2);\n`,
					},
				},
			},
		},
	};
}

function referenceUnsupportedMove(): MoveCase {
	const request: MoveEditsRequest = {
		module: "src/items.ref",
		text: "",
		exists: false,
		symbolId: "lexicon reference src/cart.ref add.",
		name: "add",
		fromModule: "src/cart.ref",
		toModule: "src/items.ref",
		role: { insertion: { text: "export function add() {}\n" } },
		importSites: [],
		dependencies: [],
		sites: [],
	};
	return {
		id: "move/reference-not-implemented",
		about: "An unsupported move proves NotImplemented is a skip.",
		fixtures: {
			reference: {
				files: { "src/cart.ref": "export function add() {}\n" },
				request,
				expect: { kind: "ready", files: { "src/items.ref": "export function add() {}\n" } },
			},
		},
	};
}

function referenceCollisionMove(): MoveCase {
	const text = "export const add = 1;\n";
	return {
		id: "move/reference-target-collision",
		about: "A target collision proves refusal expectations pass.",
		fixtures: {
			reference: {
				files: { "src/cart.ref": "export function add() {}\n", "src/items.ref": text },
				request: {
					module: "src/items.ref",
					text,
					exists: true,
					symbolId: "lexicon reference src/cart.ref add.",
					name: "add",
					fromModule: "src/cart.ref",
					toModule: "src/items.ref",
					role: {},
					importSites: [],
					dependencies: [],
					sites: [],
				},
				expect: { kind: "refused", reason: "TargetCollision" },
			},
		},
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

	it("validates the complete move case table", () => {
		expect(loadMoveCases().map((testCase) => testCase.id)).toEqual([
			"move/importer-named-import-repointed",
			"move/importer-aliased-import-keeps-alias",
			"move/importer-type-only-stays-type-only",
			"move/importer-namespace-import-blocks",
			"move/target-imports-exported-sibling-back",
			"move/target-private-sibling-blocks",
			"move/target-carries-external-import",
			"move/target-builtin-needs-nothing",
			"move/target-rerenders-relative-specifier",
			"move/target-new-file",
			"move/target-existing-appends",
			"move/target-collision-refuses",
			"move/source-removal-and-self-import",
			"move/barrel-named-reexport-repointed",
			"move/barrel-star-reexport-blocks",
			"move/dynamic-dependency-blocks",
			"move/tsconfig-alias-specifier",
		]);
	});

	it("keeps each existing move request's text equal to its workspace file", () => {
		for (const testCase of loadMoveCases()) {
			for (const fixture of Object.values(testCase.fixtures)) {
				if (fixture.request.exists) {
					expect(fixture.request.text, testCase.id).toBe(fixture.files[fixture.request.module]);
				} else {
					expect(fixture.request.text, testCase.id).toBe("");
					expect(fixture.files[fixture.request.module], testCase.id).toBeUndefined();
				}
			}
		}
	});

	it("names the requested module in every ready post-state", () => {
		for (const testCase of loadMoveCases()) {
			for (const fixture of Object.values(testCase.fixtures)) {
				if (fixture.expect.kind === "ready") {
					expect(fixture.expect.files, testCase.id).toHaveProperty(fixture.request.module);
				}
			}
		}
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

	// Comments are the one expectation checked EXACTLY, because the failure worth catching is a
	// lexer reporting a marker inside a string as prose.
	describe("comments, where an extra is a failure", () => {
		const span = (text: string, line = 0) => ({
			range: { start: { line, character: 0 }, end: { line, character: text.length } },
			text,
		});
		const withComments = (texts: string[]) => facts({ comments: texts.map((text, index) => span(text, index)) });

		it("passes on the exact set, in any order", () => {
			const testCase = { comments: ["// b", "// a"] } as ConformanceCase;
			expect(checkFacts(testCase, withComments(["// a", "// b"]))).toEqual([]);
		});

		it("reports a comment the provider invented", () => {
			const testCase = { comments: ["// a"] } as ConformanceCase;
			expect(checkFacts(testCase, withComments(["// a", "/* not a comment */"]))).toEqual([
				'comment "/* not a comment */": reported but not a comment here',
			]);
		});

		it("reports a comment the provider missed", () => {
			const testCase = { comments: ["// a", "// b"] } as ConformanceCase;
			expect(checkFacts(testCase, withComments(["// a"]))).toEqual(['comment "// b": not reported']);
		});

		// Two identical comments are two facts; a set would silently accept one of them vanishing.
		it("counts duplicates rather than collapsing them", () => {
			const testCase = { comments: ["// same", "// same"] } as ConformanceCase;
			expect(checkFacts(testCase, withComments(["// same", "// same"]))).toEqual([]);
			expect(checkFacts(testCase, withComments(["// same"]))).toEqual(['comment "// same": not reported']);
		});

		it("says nothing when a case states no comment expectation", () => {
			expect(checkFacts({} as ConformanceCase, withComments(["// anything"]))).toEqual([]);
		});

		// Comment text IS syntax: a hash language can never satisfy a slash expectation, so the
		// fixture's list replaces the case's rather than adding to it.
		it("lets a fixture state its own syntax instead of the case's", () => {
			const testCase = {
				comments: ["// shared"],
				fixtures: { python: { files: {}, subject: "x.py", comments: ["# mine"] } },
			} as unknown as ConformanceCase;

			expect(checkFacts(testCase, withComments(["# mine"]), "python")).toEqual([]);
			expect(checkFacts(testCase, withComments(["// shared"]), "python")).toEqual([
				'comment "# mine": not reported',
				'comment "// shared": reported but not a comment here',
			]);
		});

		// Verbatim, not trimmed: a span reaching past its own marker is the bug this catches.
		it("compares text as written, so a span with extra whitespace fails", () => {
			const testCase = { comments: ["// a"] } as ConformanceCase;
			expect(checkFacts(testCase, withComments(["  // a  "]))).toHaveLength(2);
		});

		// Right text under a lying range attaches to the wrong symbol, and no expectation sees it.
		describe("ranges, checked against the source whenever the caller has it", () => {
			const source = "// a\nlet x = 1;\n";
			const at = (text: string, line: number, from: number, to: number) => ({
				range: { start: { line, character: from }, end: { line, character: to } },
				text,
			});

			it("passes when every range cuts its own text back out", () => {
				const facts = withComments([]);
				facts.comments = [at("// a", 0, 0, 4)];
				expect(checkFacts({} as ConformanceCase, facts, undefined, source)).toEqual([]);
			});

			it("catches a range that covers something else", () => {
				const facts = withComments([]);
				facts.comments = [at("// a", 1, 0, 4)];
				expect(checkFacts({} as ConformanceCase, facts, undefined, source)).toEqual([
					'comment "// a": range covers "let " instead',
				]);
			});

			it("catches a range that runs off the file", () => {
				const facts = withComments([]);
				facts.comments = [at("// a", 9, 0, 4)];
				expect(checkFacts({} as ConformanceCase, facts, undefined, source)).toEqual([
					'comment "// a": range is outside the file',
				]);
			});

			// The expectation list and the range check are independent: an unexpected span is still
			// range-checked, which is how a provider inventing spans gets caught twice.
			it("checks spans the case never mentioned", () => {
				const facts = withComments([]);
				facts.comments = [at("// a", 1, 0, 4)];
				expect(checkFacts({} as ConformanceCase, facts, undefined, source)).toHaveLength(1);
			});
		});
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

	// This provider is the suite's own yardstick, so its line endings have to be right for the
	// cases it grades to mean anything.
	describe("ends a line comment where the line ends", () => {
		const textsOf = (source: string) => extractComments(source).map((comment) => comment.text);

		it("leaves a CRLF carriage return out of the text", () => {
			expect(textsOf("// a\r\n// b\r\n")).toEqual(["// a", "// b"]);
		});

		it("keeps a lone carriage return, which terminates nothing", () => {
			expect(textsOf("// a\rb\n")).toEqual(["// a\rb"]);
			expect(textsOf("// a\r")).toEqual(["// a\r"]);
		});

		it("runs an unterminated comment to the end of the file", () => {
			expect(textsOf("// a")).toEqual(["// a"]);
		});

		it("reports every span at a range that cuts its own text back out", () => {
			const source = "// a\r\nlet x = 1; // b\r\n";
			const coordinates = coordinatesOf(source);
			for (const comment of extractComments(source)) {
				expect(coordinates.sliceRange(comment.range)).toBe(comment.text);
			}
		});
	});
});

describe("running the suite against a real process", () => {
	it("passes a legitimately partial provider, reporting its undeclared tiers as skipped", async () => {
		const report = await runSuite({
			command: ["bun", "run", PROVIDER],
			cases: loadCorpus(),
			moveCases: loadMoveCases(),
			timeoutMs: 15_000,
		});

		expect(report.providerId).toBe("reference-provider");
		// The whole tiering claim: undeclared tiers are skipped, and nothing it claims fails.
		expect(report.failed, formatReport(report)).toBe(0);
		expect(report.passed).toBeGreaterThan(0);
		expect(report.skipped).toBeGreaterThan(0);
		expect(report.results.find((result) => result.caseId === "move/importer-named-import-repointed")).toMatchObject(
			{
				outcome: "skipped",
				problems: ["no reference fixture"],
			},
		);
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
		expect(report.results.find((result) => result.outcome === "failed")?.problems[0]).toMatch(/not reported/);
	}, 30_000);

	it("makes move cases pass, fail, and skip through provider responses", async () => {
		const moveCases = [
			referenceNamedMove("move/reference-pass", "./items"),
			referenceNamedMove("move/reference-fail", "./wrong"),
			referenceUnsupportedMove(),
			referenceCollisionMove(),
		];
		const report = await runSuite({
			command: ["bun", "run", PROVIDER],
			cases: [],
			moveCases,
			timeoutMs: 15_000,
		});
		const outcome = (id: string) => report.results.find((result) => result.caseId === id);

		expect(outcome("move/reference-pass")).toMatchObject({ outcome: "passed", problems: [] });
		expect(outcome("move/reference-fail")).toMatchObject({ outcome: "failed" });
		expect(outcome("move/reference-fail")?.problems[0]).toMatch(/post-state/);
		expect(outcome("move/reference-not-implemented")).toMatchObject({ outcome: "skipped" });
		expect(outcome("move/reference-not-implemented")?.problems[0]).toMatch(/NotImplemented/);
		expect(outcome("move/reference-target-collision")).toMatchObject({ outcome: "passed", problems: [] });
	}, 30_000);
});
