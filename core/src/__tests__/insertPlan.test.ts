import { composeSymbolId, type FileFacts, type Range } from "@nyaa-lexicon/protocol";
import { describe, expect, it } from "vitest";
import type { ImportResolver } from "../imports";
import type { CandidateParse, ProviderProbe } from "../providerProbe";
import { type InsertArgs, RefactorPlanner } from "../refactorPlanner";
import type { SourceWorkspace } from "../sourceWorkspace";
import type { IndexStore, StoredDeclaration } from "../store";

////////////////////////////////
//  Helpers

const MODULE = "src/mod.ts";

function id(name: string, container?: string): string {
	return composeSymbolId({
		language: "test",
		module: MODULE,
		descriptors:
			container === undefined
				? [{ kind: "term", name }]
				: [
						{ kind: "type", name: container },
						{ kind: "method", name },
					],
	});
}

function range(startLine: number, startCharacter: number, endLine: number, endCharacter: number): Range {
	return { start: { line: startLine, character: startCharacter }, end: { line: endLine, character: endCharacter } };
}

function facts(declarations: FileFacts["declarations"]): FileFacts {
	return {
		module: MODULE,
		contentHash: "candidate",
		declarations,
		references: [],
		imports: [],
		literals: [],
		diagnostics: [],
	};
}

interface FakeDeclaration {
	name: string;
	container?: string;
	range: Range;
	/** Defaults to a single-line span at the range start line. */
	selection?: Range;
}

function declarationOf(fake: FakeDeclaration): StoredDeclaration {
	const symbolId = id(fake.name, fake.container);
	return {
		factId: `decl:${symbolId}`,
		module: MODULE,
		symbolId,
		kind: "function",
		name: fake.name,
		range: fake.range,
		selectionRange: fake.selection ?? range(fake.range.start.line, 0, fake.range.start.line, fake.name.length),
		visibility: "public",
	} as StoredDeclaration;
}

/** containerId is the container's own stored symbolId. */
function member(fake: FakeDeclaration & { container: string }): StoredDeclaration {
	return { ...declarationOf(fake), containerId: id(fake.container) };
}

interface World {
	text: string;
	declarations: StoredDeclaration[];
	imports?: string[];
	parse?: (candidate: string) => CandidateParse;
	/** Overrides the stored content hash; default matches the text on disk. */
	indexedHash?: string | null;
	syntaxDiagnostics?: boolean;
}

function plannerFor(world: World) {
	const store = {
		declaration: (symbolId: string) => world.declarations.find((d) => d.symbolId === symbolId) ?? null,
		declarationsIn: (module: string) => world.declarations.filter((d) => d.module === module),
		importsBinding: (name: string) =>
			(world.imports ?? []).filter((bound) => bound === name).map(() => ({ module: MODULE })),
		referencesTo: () => [],
		referencesIn: () => [],
		contentHashOf: () => (world.indexedHash === undefined ? null : world.indexedHash),
	} as unknown as IndexStore;

	const probe: ProviderProbe = {
		owner: () => ({ owned: true, providerId: "test" }),
		declares: () => world.syntaxDiagnostics ?? true,
		parseCandidate: async (_module, candidate) => world.parse?.(candidate) ?? { parsed: true, facts: facts([]) },
		renameEdits: () => Promise.reject(new Error("not asked")),
		moveEdits: () => Promise.reject(new Error("not asked")),
	};

	return new RefactorPlanner(
		store,
		{} as unknown as ImportResolver,
		{} as unknown as SourceWorkspace,
		probe,
		(module) => (module === MODULE ? world.text : null),
	);
}

async function plan(world: World, args: InsertArgs) {
	return plannerFor(world).planInsert(args);
}

////////////////////////////////
//  Tests

describe("choosing the splice point", () => {
	it("lands between the anchor and its next sibling, above the sibling's leading comment", async () => {
		const world: World = {
			text: ["function alpha() {}", "", "// beta's doc", "function beta() {}", ""].join("\n"),
			declarations: [
				declarationOf({ name: "alpha", range: range(0, 0, 0, 19) }),
				// The provider starts beta's range at its attached comment.
				declarationOf({ name: "beta", range: range(2, 0, 3, 18) }),
			],
		};

		const outcome = await plan(world, { after: id("alpha"), text: "function inserted() {}" });

		expect(outcome.state).toBe("planned");
		if (outcome.state !== "planned") return;
		expect(outcome.candidate).toBe(
			["function alpha() {}", "", "function inserted() {}", "", "// beta's doc", "function beta() {}", ""].join(
				"\n",
			),
		);
	});

	it("appends after a last top-level anchor", async () => {
		const world: World = {
			text: "function alpha() {}\n",
			declarations: [declarationOf({ name: "alpha", range: range(0, 0, 0, 19) })],
		};

		const outcome = await plan(world, { after: id("alpha"), text: "function omega() {}" });

		expect(outcome.state).toBe("planned");
		if (outcome.state !== "planned") return;
		expect(outcome.candidate).toBe("function alpha() {}\n\nfunction omega() {}\n");
	});

	it("indents a member insert from the anchor's NAME line, not its comment line", async () => {
		const world: World = {
			text: ["class C {", "\t// documented", "\tfirst() {}", "", "\tsecond() {}", "}", ""].join("\n"),
			declarations: [
				declarationOf({ name: "C", range: range(0, 0, 5, 1) }),
				member({ name: "first", container: "C", range: range(1, 1, 2, 11), selection: range(2, 1, 2, 6) }),
				member({ name: "second", container: "C", range: range(4, 1, 4, 12), selection: range(4, 1, 4, 7) }),
			],
		};

		const outcome = await plan(world, { after: id("first", "C"), text: "between() {}" });

		expect(outcome.state).toBe("planned");
		if (outcome.state !== "planned") return;
		expect(outcome.candidate).toContain("\tfirst() {}\n\n\tbetween() {}\n\n\tsecond() {}");
	});

	it("puts a last member's follower above the container's closing brace", async () => {
		const world: World = {
			text: ["class C {", "\tonly() {}", "}", ""].join("\n"),
			declarations: [
				declarationOf({ name: "C", range: range(0, 0, 2, 1) }),
				member({ name: "only", container: "C", range: range(1, 1, 1, 10), selection: range(1, 1, 1, 5) }),
			],
		};

		const outcome = await plan(world, { after: id("only", "C"), text: "added() {}" });

		expect(outcome.state).toBe("planned");
		if (outcome.state !== "planned") return;
		expect(outcome.candidate).toBe(["class C {", "\tonly() {}", "", "\tadded() {}", "}", ""].join("\n"));
	});

	// The audit's escape: without a container-scope filter, the "next sibling" of a last member was
	// the next TOP-LEVEL declaration, splicing member-indented text outside the container.
	it("keeps a last member's insert inside its container when another class follows", async () => {
		const world: World = {
			text: ["class A {", "\tm() {}", "}", "", "class B {}", ""].join("\n"),
			declarations: [
				declarationOf({ name: "A", range: range(0, 0, 2, 1) }),
				member({ name: "m", container: "A", range: range(1, 1, 1, 8), selection: range(1, 1, 1, 2) }),
				declarationOf({ name: "B", range: range(4, 0, 4, 10) }),
			],
		};

		const outcome = await plan(world, { after: id("m", "A"), text: "added() {}" });

		expect(outcome.state).toBe("planned");
		if (outcome.state !== "planned") return;
		expect(outcome.candidate).toBe(
			["class A {", "\tm() {}", "", "\tadded() {}", "}", "", "class B {}", ""].join("\n"),
		);
	});

	// C and C++ ranges end after "};", so the pre-delimiter char is ";" with "}" ahead of it.
	it("accepts a container that terminates in closers beyond the brace", async () => {
		const world: World = {
			text: ["struct S {", "\tint x;", "};", ""].join("\n"),
			declarations: [
				declarationOf({ name: "S", range: range(0, 0, 2, 2) }),
				member({ name: "x", container: "S", range: range(1, 1, 1, 7), selection: range(1, 5, 1, 6) }),
			],
		};

		const outcome = await plan(world, { after: id("x", "S"), text: "int y;" });

		expect(outcome.state).toBe("planned");
		if (outcome.state !== "planned") return;
		expect(outcome.candidate).toBe(["struct S {", "\tint x;", "", "\tint y;", "};", ""].join("\n"));
	});
});

// Refusal beats guessing: every layout without a sound whole-line point says so.
describe("refusing what has no sound splice point", () => {
	it("refuses an anchor whose next sibling shares its line", async () => {
		const world: World = {
			text: "const a = 1; const b = 2;\n",
			declarations: [
				declarationOf({ name: "a", range: range(0, 0, 0, 12), selection: range(0, 6, 0, 7) }),
				declarationOf({ name: "b", range: range(0, 13, 0, 25), selection: range(0, 19, 0, 20) }),
			],
		};

		const outcome = await plan(world, { after: id("a"), text: "const c = 3;" });

		expect(outcome).toMatchObject({ state: "refused" });
		expect(outcome.state === "refused" && outcome.reason).toMatch(/no whole-line insertion point/);
	});

	it("refuses a last member of a single-line container", async () => {
		const world: World = {
			text: "class C { only() {} }\n",
			declarations: [
				declarationOf({ name: "C", range: range(0, 0, 0, 21) }),
				member({ name: "only", container: "C", range: range(0, 10, 0, 19), selection: range(0, 10, 0, 14) }),
			],
		};

		const outcome = await plan(world, { after: id("only", "C"), text: "added() {}" });

		expect(outcome).toMatchObject({ state: "refused" });
	});

	it("refuses an anchor whose name span is not a single line", async () => {
		const world: World = {
			text: "function alpha() {}\n",
			declarations: [declarationOf({ name: "alpha", range: range(0, 0, 0, 19), selection: range(0, 0, 1, 0) })],
		};

		const outcome = await plan(world, { after: id("alpha"), text: "function added() {}" });

		expect(outcome).toMatchObject({ state: "refused" });
	});

	it("refuses a candidate the provider cannot parse, before anything touches disk", async () => {
		const world: World = {
			text: "function alpha() {}\n",
			declarations: [declarationOf({ name: "alpha", range: range(0, 0, 0, 19) })],
			parse: () => ({ parsed: false, reason: "'}' expected." }),
		};

		const outcome = await plan(world, { after: id("alpha"), text: "function broken( {}" });

		expect(outcome).toMatchObject({ state: "refused" });
		expect(outcome.state === "refused" && outcome.reason).toMatch(/does not parse/);
	});

	it("refuses an empty insert and an ambiguous anchor pair", async () => {
		const world: World = { text: "\n", declarations: [] };

		const ambiguous = await plan(world, { after: id("a"), module: MODULE, text: "x" });
		expect(ambiguous.state === "refused" && ambiguous.reason).toMatch(/exactly one/);
		expect(await plan(world, { module: MODULE, text: "   \n " })).toMatchObject({ state: "refused" });
	});

	// The stored ranges address one version of the file; a moved file makes them wrong lines, and a
	// wrong line is a silent misplacement, not an error.
	it("refuses an anchor in a module the index no longer describes", async () => {
		const world: World = {
			text: "function alpha() {}\n",
			declarations: [declarationOf({ name: "alpha", range: range(0, 0, 0, 19) })],
			indexedHash: "some-older-version",
		};

		const outcome = await plan(world, { after: id("alpha"), text: "function added() {}" });

		expect(outcome).toMatchObject({ state: "refused" });
		expect(outcome.state === "refused" && outcome.reason).toMatch(/changed since it was indexed/);
	});

	it("refuses a module path that leaves the workspace", async () => {
		const world: World = { text: "", declarations: [] };

		expect(await plannerFor(world).planInsert({ module: "../evil.ts", text: "const x = 1;" })).toMatchObject({
			state: "refused",
		});
		expect(await plannerFor(world).planInsert({ module: "/etc/evil.ts", text: "const x = 1;" })).toMatchObject({
			state: "refused",
		});
	});
});

// The retry answer: a timeout-and-retry must never duplicate the block.
describe("answering already-inserted on a retry", () => {
	it("recognizes its own block at a sibling splice point", async () => {
		const inserted = ["function alpha() {}", "", "function added() {}", "", "function beta() {}", ""].join("\n");
		const world: World = {
			text: inserted,
			declarations: [
				declarationOf({ name: "alpha", range: range(0, 0, 0, 19) }),
				declarationOf({ name: "added", range: range(2, 0, 2, 19) }),
				declarationOf({ name: "beta", range: range(4, 0, 4, 18) }),
			],
		};

		const outcome = await plan(world, { after: id("alpha"), text: "function added() {}" });

		expect(outcome).toEqual({ state: "present", module: MODULE });
	});

	it("recognizes its own block as a module suffix", async () => {
		const world: World = {
			text: "function alpha() {}\n\nfunction added() {}\n",
			declarations: [declarationOf({ name: "alpha", range: range(0, 0, 0, 19) })],
		};

		const outcome = await plan(world, { module: MODULE, text: "function added() {}" });

		expect(outcome).toEqual({ state: "present", module: MODULE });
	});

	// The dangerous direction: answering present over DIFFERENT code skips a write the caller is
	// told already landed.
	it("does not mistake a near-miss at the splice point for its own block", async () => {
		const world: World = {
			text: ["function alpha() {}", "", "function addedButLonger() {}", "", "function beta() {}", ""].join("\n"),
			declarations: [
				declarationOf({ name: "alpha", range: range(0, 0, 0, 19) }),
				declarationOf({ name: "addedButLonger", range: range(2, 0, 2, 28) }),
				declarationOf({ name: "beta", range: range(4, 0, 4, 18) }),
			],
		};

		const outcome = await plan(world, { after: id("alpha"), text: "function added() {}" });

		expect(outcome.state).toBe("planned");
	});
});

describe("appending to a module", () => {
	it("creates an absent module from just the block", async () => {
		const world: World = { text: "", declarations: [] };
		const planner = plannerFor(world);

		const outcome = await planner.planInsert({ module: "src/fresh.ts", text: "export const a = 1;" });

		expect(outcome.state).toBe("planned");
		if (outcome.state !== "planned") return;
		expect(outcome.created).toBe(true);
		expect(outcome.candidate).toBe("export const a = 1;\n");
		expect(outcome.baseHash).toBeNull();
	});

	it("separates the appended block from a file that does not end blank", async () => {
		const world: World = {
			text: "function alpha() {}\n",
			declarations: [declarationOf({ name: "alpha", range: range(0, 0, 0, 19) })],
		};

		const outcome = await plan(world, { module: MODULE, text: "function omega() {}" });

		expect(outcome.state).toBe("planned");
		if (outcome.state !== "planned") return;
		expect(outcome.candidate).toBe("function alpha() {}\n\nfunction omega() {}\n");
	});
});

// Insert is rename's mirror: a new binder lands among existing uses. Language scoping decides
// whether that captures, so it is stated, never refused.
describe("warning about a name already bound", () => {
	const minted = (name: string, container?: string): FileFacts =>
		facts([
			{
				symbolId: id(name, container),
				kind: "function",
				name,
				range: range(90, 0, 90, 10),
				selectionRange: range(90, 0, 90, name.length),
				visibility: "public",
				...(container === undefined ? {} : { containerId: id(container) }),
			},
		]);

	it("warns when the module already imports the name at top level", async () => {
		const world: World = {
			text: "function alpha() {}\n",
			declarations: [declarationOf({ name: "alpha", range: range(0, 0, 0, 19) })],
			imports: ["assert"],
			parse: () => ({ parsed: true, facts: minted("assert") }),
		};

		const outcome = await plan(world, { after: id("alpha"), text: "function assert() {}" });

		expect(outcome.state).toBe("planned");
		if (outcome.state !== "planned") return;
		expect(outcome.issues.map((issue) => issue.kind)).toContain("NameAlreadyBound");
	});

	// A real provider parses the WHOLE candidate and echoes existing declarations back; only the
	// minted ones may warn, or every insert would warn about the file's own contents.
	it("warns once, not per pre-existing declaration echoed by the candidate", async () => {
		const alpha = declarationOf({ name: "alpha", range: range(0, 0, 0, 19) });
		const world: World = {
			text: "function alpha() {}\n",
			declarations: [alpha],
			imports: ["assert"],
			parse: () => {
				const echoed = minted("assert");
				echoed.declarations.push({
					symbolId: alpha.symbolId,
					kind: "function",
					name: "alpha",
					range: alpha.range,
					selectionRange: alpha.selectionRange,
					visibility: "public",
				});
				return { parsed: true, facts: echoed };
			},
		};

		const outcome = await plan(world, { after: id("alpha"), text: "function assert() {}" });

		expect(outcome.state).toBe("planned");
		if (outcome.state !== "planned") return;
		expect(outcome.issues.filter((issue) => issue.kind === "NameAlreadyBound")).toHaveLength(1);
	});

	it("rides a SyntaxUnchecked warning when the provider cannot check syntax", async () => {
		const world: World = {
			text: "function alpha() {}\n",
			declarations: [declarationOf({ name: "alpha", range: range(0, 0, 0, 19) })],
			syntaxDiagnostics: false,
		};

		const outcome = await plan(world, { after: id("alpha"), text: "function added() {}" });

		expect(outcome.state).toBe("planned");
		if (outcome.state !== "planned") return;
		expect(outcome.issues.map((issue) => issue.kind)).toContain("SyntaxUnchecked");
	});

	it("says nothing when a member shares its name with a top-level symbol", async () => {
		const world: World = {
			text: ["class C {", "\trun() {}", "", "\tother() {}", "}", "", "function run() {}", ""].join("\n"),
			declarations: [
				declarationOf({ name: "C", range: range(0, 0, 4, 1) }),
				member({ name: "run", container: "C", range: range(1, 1, 1, 9), selection: range(1, 1, 1, 4) }),
				member({ name: "other", container: "C", range: range(3, 1, 3, 11), selection: range(3, 1, 3, 6) }),
				declarationOf({ name: "run", range: range(6, 0, 6, 17), selection: range(6, 9, 6, 12) }),
			],
			imports: ["helper"],
			parse: () => ({ parsed: true, facts: minted("helper", "C") }),
		};

		const outcome = await plan(world, { after: id("other", "C"), text: "helper() {}" });

		expect(outcome.state).toBe("planned");
		if (outcome.state !== "planned") return;
		expect(outcome.issues.map((issue) => issue.kind)).not.toContain("NameAlreadyBound");
	});
});
