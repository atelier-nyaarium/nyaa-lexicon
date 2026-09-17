import { describe, expect, it } from "bun:test";
import { composeSymbolId, type FileFacts, hashContent, type Range } from "@nyaa-lexicon/protocol";
import type { ImportResolver } from "../imports";
import type { CandidateParse, ProviderProbe } from "../providerProbe";
import { RefactorPlanner } from "../refactorPlanner";
import type { SourceWorkspace } from "../sourceWorkspace";
import type { IndexStore, StoredDeclaration } from "../store";

////////////////////////////////
//  Helpers

const MODULE = "src/mod.ts";
const OTHER = "src/other.ts";

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

interface Fake {
	name: string;
	container?: string;
	kind?: StoredDeclaration["kind"];
	range: Range;
}

function declarationOf(fake: Fake): StoredDeclaration {
	const symbolId = id(fake.name, fake.container);
	return {
		factId: `decl:${symbolId}`,
		module: MODULE,
		symbolId,
		kind: fake.kind ?? (fake.container === undefined ? "function" : "method"),
		name: fake.name,
		range: fake.range,
		selectionRange: range(fake.range.start.line, 0, fake.range.start.line, fake.name.length),
		visibility: "public",
		...(fake.container === undefined ? {} : { containerId: id(fake.container) }),
	} as StoredDeclaration;
}

/** The candidate's declarations, minted as the stored ones would be. */
function facts(...fakes: Fake[]): FileFacts {
	return {
		module: MODULE,
		contentHash: "candidate",
		declarations: fakes.map((fake) => {
			const stored = declarationOf(fake);
			return {
				symbolId: stored.symbolId,
				kind: stored.kind,
				name: stored.name,
				range: stored.range,
				selectionRange: stored.selectionRange,
				visibility: "public",
				...(stored.containerId === undefined ? {} : { containerId: stored.containerId }),
			};
		}),
		references: [],
		imports: [],
		literals: [],
		diagnostics: [],
	} as FileFacts;
}

function sliced(text: string, span: Range): string {
	const lines = text.split("\n");
	const first = (lines[span.start.line] ?? "").slice(span.start.character);
	if (span.start.line === span.end.line) return first.slice(0, span.end.character - span.start.character);
	const last = (lines[span.end.line] ?? "").slice(0, span.end.character);
	return [first, ...lines.slice(span.start.line + 1, span.end.line), last].join("\n");
}

interface World {
	text: string;
	declarations: StoredDeclaration[];
	/** Modules holding a reference to each id. */
	users?: Record<string, string[]>;
	parse: (candidate: string) => CandidateParse;
}

function plannerFor(world: World): RefactorPlanner {
	const store = {
		declaration: (symbolId: string) => world.declarations.find((d) => d.symbolId === symbolId) ?? null,
		declarationsIn: (module: string) => world.declarations.filter((d) => d.module === module),
		declarationsNamed: (name: string) => world.declarations.filter((d) => d.name === name),
		importsBinding: () => [],
		referencesTo: (symbolId: string) => (world.users?.[symbolId] ?? []).map((module) => ({ module })),
		referencesIn: () => [],
		contentHashOf: () => null,
	} as unknown as IndexStore;

	const probe: ProviderProbe = {
		owner: () => ({ owned: true, providerId: "test" }),
		declares: () => true,
		parseCandidate: async (_module, candidate) => world.parse(candidate),
		renameEdits: () => Promise.reject(new Error("not asked")),
		moveEdits: () => Promise.reject(new Error("not asked")),
	};

	const source = {
		symbolSourceRead: (address: { symbolId?: string }) => {
			const found = world.declarations.find((d) => d.symbolId === address.symbolId);
			if (found === undefined) throw new Error(`the world declares no ${address.symbolId}`);
			const text = sliced(world.text, found.range);
			return {
				found: true,
				module: MODULE,
				name: found.name,
				kind: found.kind,
				range: found.range,
				text,
				contentHash: hashContent(world.text),
				spanHash: hashContent(text),
				fileText: world.text,
			};
		},
	};

	return new RefactorPlanner(store, {} as unknown as ImportResolver, source as unknown as SourceWorkspace, probe);
}

////////////////////////////////
//  Tests

describe("refusing a replacement before it is parsed", () => {
	it("refuses a subject whose span a sibling declarator shares", async () => {
		const world: World = {
			text: "const a = 1, b = 2;\n",
			declarations: [
				declarationOf({ name: "a", range: range(0, 0, 0, 19) }),
				declarationOf({ name: "b", range: range(0, 0, 0, 19) }),
			],
			parse: () => ({ parsed: true, facts: facts() }),
		};

		const plan = await plannerFor(world).planReplacement({ symbolId: id("a") }, "const a = 3, b = 2;");

		expect(plan).toMatchObject({ ok: false });
		if (plan.ok) return;
		expect(plan.reason).toMatch(/shares its span with b/);
	});
});

describe("reading a candidate against what the module holds", () => {
	const text = ["class C {", "\tfirst() {}", "\tsecond() {}", "}", ""].join("\n");
	const declarations = [
		declarationOf({ name: "C", kind: "class", range: range(0, 0, 3, 1) }),
		declarationOf({ name: "first", container: "C", range: range(1, 1, 1, 11) }),
		declarationOf({ name: "second", container: "C", range: range(2, 1, 2, 12) }),
	];
	const kept = { name: "C", kind: "class" as const, range: range(0, 0, 3, 1) };

	it("refuses a member replacement that renames it, keyed by kind and container", async () => {
		const world: World = {
			text,
			declarations,
			parse: () =>
				({
					parsed: true,
					facts: facts(
						kept,
						{ name: "renamed", container: "C", range: range(1, 1, 1, 13) },
						{ name: "second", container: "C", range: range(2, 1, 2, 12) },
					),
				}) as CandidateParse,
		};

		const plan = await plannerFor(world).planReplacement({ symbolId: id("first", "C") }, "renamed() {}");

		expect(plan).toMatchObject({ ok: false });
		if (plan.ok) return;
		expect(plan.reason).toMatch(/renames first to renamed/);
	});

	it("reads a new member of another container as a deletion, not the rename", async () => {
		const world: World = {
			text,
			declarations,
			parse: () =>
				({
					parsed: true,
					facts: facts(
						kept,
						{ name: "second", container: "C", range: range(2, 1, 2, 12) },
						{ name: "D", kind: "class", range: range(5, 0, 7, 1) },
						{ name: "first", container: "D", range: range(6, 1, 6, 11) },
					),
				}) as CandidateParse,
		};

		const plan = await plannerFor(world).planReplacement({ symbolId: id("first", "C") }, "");

		expect(plan.ok).toBe(true);
	});

	it("allows deleting a member and names the modules still using it", async () => {
		const world: World = {
			text,
			declarations,
			users: { [id("first", "C")]: [OTHER, MODULE] },
			parse: () =>
				({
					parsed: true,
					facts: facts(kept, { name: "second", container: "C", range: range(2, 1, 2, 12) }),
				}) as CandidateParse,
		};

		const plan = await plannerFor(world).planReplacement({ symbolId: id("first", "C") }, "");

		expect(plan.ok).toBe(true);
		if (!plan.ok) return;
		expect(plan.issues).toEqual([
			{ kind: "OrphanedReference", detail: expect.stringMatching(/first .*src\/other\.ts/), module: MODULE },
		]);
	});
});
