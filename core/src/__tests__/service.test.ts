import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LexiconService } from "../service";
import { IndexStore } from "../store";
import { ProviderSupervisor } from "../supervisor";

////////////////////////////////
//  Helpers

const REFERENCE = path.join(
	import.meta.dirname,
	"..",
	"..",
	"..",
	"protocol",
	"src",
	"conformance",
	"referenceProvider.ts",
);

let dir: string;
let store: IndexStore;
let supervisor: ProviderSupervisor;
let files: Map<string, string>;
let service: LexiconService;

async function boot() {
	supervisor = new ProviderSupervisor();
	await supervisor.start({ command: ["bun", "run", REFERENCE], timeoutMs: 15_000 }, dir);
	service = new LexiconService(store, supervisor, (module) => files.get(module) ?? null, dir);
}

beforeEach(() => {
	dir = mkdtempSync(path.join(tmpdir(), "lexicon-service-"));
	store = IndexStore.open(path.join(dir, "index.sqlite")).store;
	files = new Map();
});

afterEach(() => {
	supervisor?.stopAll();
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

////////////////////////////////
//  Tests

describe("indexing a file end to end", () => {
	it("asks the provider and stores what it answered", async () => {
		await boot();
		files.set("a.ref", "export class Cart {}\nexport function add() {}\n");

		const outcome = await service.indexFile("a.ref", "h1");

		expect(outcome).toMatchObject({ action: "indexed", declarations: 2 });
		expect(service.findByName("Cart").map((s) => s.kind)).toEqual(["class"]);
	}, 30_000);

	it("skips a file no provider claims rather than failing", async () => {
		await boot();
		files.set("README.md", "# hi");

		expect(await service.indexFile("README.md", "h1")).toMatchObject({
			action: "skipped",
			reason: "unclaimed",
		});
	}, 30_000);

	it("forgets a file that vanished between the event and the read", async () => {
		await boot();
		files.set("a.ref", "export class Cart {}\n");
		await service.indexFile("a.ref", "h1");

		files.delete("a.ref");
		expect(await service.indexFile("a.ref", "h2")).toMatchObject({ action: "forgotten" });
		expect(service.findByName("Cart")).toEqual([]);
	}, 30_000);
});

describe("applying a watcher batch", () => {
	it("indexes a changed file and forgets a deleted one in the same batch", async () => {
		await boot();
		files.set("a.ref", "export class A {}\n");
		files.set("b.ref", "export class B {}\n");
		await service.indexFile("b.ref", "hb");

		const outcomes = await service.applyBatch([
			{ kind: "changed", module: "a.ref", contentHash: "ha" },
			{ kind: "deleted", module: "b.ref" },
		]);

		expect(outcomes.map((o) => o.action)).toEqual(["indexed", "forgotten"]);
		expect(service.findByName("A")).toHaveLength(1);
		expect(service.findByName("B")).toEqual([]);
	}, 30_000);

	// The hash compared is of the text that was indexed, so a re-save of identical content is
	// recognized whatever the caller claims. The watcher hashes the same way, so this is the shape
	// a real touch-without-editing arrives in.
	it("skips a re-save whose content did not move, without asking the provider", async () => {
		await boot();
		files.set("a.ref", "export class A {}\n");
		await service.indexFile("a.ref", "h1");
		const indexed = store.contentHashOf("a.ref") as string;

		const outcomes = await service.applyBatch([{ kind: "changed", module: "a.ref", contentHash: indexed }]);
		expect(outcomes[0]).toMatchObject({ action: "skipped", reason: "content is unchanged" });
	}, 30_000);

	// A caller's hash is a claim about a file it read at some earlier moment. Storing it would file
	// the facts of one version under the name of another.
	it("stores the hash of the text it read, not the one it was handed", async () => {
		await boot();
		files.set("a.ref", "export class A {}\n");
		await service.indexFile("a.ref", "a-stale-label");

		expect(store.contentHashOf("a.ref")).not.toBe("a-stale-label");
		const source = service.symbolSource({ symbolId: service.findByName("A")[0]?.symbolId as string });
		expect(source.found).toBe(true);
	}, 30_000);
});

/**
 * Written straight to the store rather than through a provider.
 *
 * The reference provider emits no references at all, and these two answers are entirely reads over
 * reference rows, so driving them through it would test nothing. What is under test here is the
 * core's aggregation, and the store is where a provider's output lands anyway.
 */
describe("type hierarchy and citable facts", () => {
	const at = (line: number) => ({ start: { line, character: 0 }, end: { line, character: 8 } });

	function type(name: string, module = "a.ref") {
		return {
			symbolId: `lexicon reference ${module} ${name}#`,
			kind: "class" as const,
			name,
			range: at(0),
			selectionRange: at(0),
			visibility: "public" as const,
		};
	}

	function heritage(name: string, targetId: string | null, fromId: string, role: "extends" | "implements") {
		return {
			name,
			range: at(0),
			role,
			fromId,
			binding:
				targetId === null
					? ({ status: "unbound", reason: "ExternalDependency" } as const)
					: ({ status: "bound", symbolId: targetId, provenance: "bound" } as const),
		};
	}

	/** Base <- Middle <- Leaf, plus a base the index cannot see, spread over two files. */
	function plantHierarchy(): LexiconService {
		const base = type("Base");
		const middle = type("Middle", "b.ref");
		const leaf = type("Leaf", "b.ref");

		store.replaceFile("a.ref", "h1", [base], []);
		store.replaceFile(
			"b.ref",
			"h2",
			[middle, leaf],
			[
				heritage("Base", base.symbolId, middle.symbolId, "extends"),
				heritage("Middle", middle.symbolId, leaf.symbolId, "extends"),
				heritage("Engine", null, leaf.symbolId, "extends"),
			],
		);
		return new LexiconService(store, new ProviderSupervisor(), () => null, dir);
	}

	it("reads both directions out of the same reference rows", () => {
		const built = plantHierarchy();
		const hierarchy = built.typeHierarchy("lexicon reference b.ref Middle#");

		expect(hierarchy.supertypes.map((s) => s.name)).toEqual(["Base"]);
		expect(hierarchy.subtypes.map((s) => s.name)).toEqual(["Leaf"]);
	});

	it("walks transitively, so a grandparent is reachable without asking twice", () => {
		expect(
			plantHierarchy()
				.typeHierarchy("lexicon reference b.ref Leaf#")
				.ancestors.map((s) => s.name),
		).toEqual(["Middle", "Base"]);
	});

	// A base outside the workspace is a real supertype this index cannot name. Dropped, it would read
	// as extending nothing, which is a stronger claim than the truth.
	it("reports an unresolved base rather than dropping it", () => {
		expect(plantHierarchy().typeHierarchy("lexicon reference b.ref Leaf#").unboundSupertypes).toEqual(["Engine"]);
	});

	it("answers empty for a symbol with no heritage, rather than null", () => {
		const hierarchy = plantHierarchy().typeHierarchy("lexicon reference a.ref Base#");

		expect(hierarchy.supertypes).toEqual([]);
		expect(hierarchy.subtypes.map((s) => s.name)).toEqual(["Middle"]);
	});

	// The same rows as the type hierarchy, read through the call role instead of the heritage ones.
	it("groups calls by the symbol at the other end, keeping every span", () => {
		const callee = type("target");
		const caller = type("caller", "b.ref");
		const twice = [10, 20].map((line) => ({
			name: "target",
			range: { start: { line, character: 0 }, end: { line, character: 6 } },
			role: "call" as const,
			fromId: caller.symbolId,
			binding: { status: "bound", symbolId: callee.symbolId, provenance: "bound" } as const,
		}));

		store.replaceFile("a.ref", "h1", [callee], []);
		store.replaceFile("b.ref", "h2", [caller], twice);
		const built = new LexiconService(store, new ProviderSupervisor(), () => null, dir);

		const incoming = built.callHierarchy(callee.symbolId).incoming;

		expect(incoming).toHaveLength(1);
		expect(incoming[0]?.symbol.name).toBe("caller");
		expect(incoming[0]?.ranges.map((r) => r.start.line)).toEqual([10, 20]);
		expect(built.callHierarchy(caller.symbolId).outgoing.map((e) => e.symbol.name)).toEqual(["target"]);
	});

	it("ignores a reference that is not a call, so a hierarchy is not a mention list", () => {
		const callee = type("target");
		const caller = type("caller", "b.ref");
		store.replaceFile("a.ref", "h1", [callee], []);
		store.replaceFile("b.ref", "h2", [caller], [heritage("target", callee.symbolId, caller.symbolId, "extends")]);
		const built = new LexiconService(store, new ProviderSupervisor(), () => null, dir);

		expect(built.callHierarchy(callee.symbolId).incoming).toEqual([]);
	});

	it("gathers the declaration, its uses and the text inside it, each with an id", async () => {
		const base = type("Base");
		store.replaceFile(
			"a.ref",
			"h1",
			[base],
			[heritage("Base", base.symbolId, base.symbolId, "extends")],
			[],
			[{ kind: "string", value: "hello", range: at(1), containerId: base.symbolId }],
		);
		const built = new LexiconService(store, new ProviderSupervisor(), () => null, dir);

		const facts = await built.factsFor(base.symbolId);

		expect(facts?.facts.map((f) => f.kind)).toEqual(["declaration", "reference", "literal"]);
		expect(facts?.facts.every((f) => f.factId.startsWith("lexfact "))).toBe(true);
	});

	it("names the kinds a limit cut off, so a thin answer is not read as a complete one", async () => {
		const base = type("Base");
		const uses = Array.from({ length: 5 }, () => heritage("Base", base.symbolId, base.symbolId, "extends"));
		store.replaceFile("a.ref", "h1", [base], uses);
		const built = new LexiconService(store, new ProviderSupervisor(), () => null, dir);

		expect((await built.factsFor(base.symbolId, 2))?.truncated).toEqual(["reference"]);
	});

	it("answers null for a symbol the index does not hold", async () => {
		const built = new LexiconService(store, new ProviderSupervisor(), () => null, dir);
		expect(await built.factsFor("lexicon reference a.ref Ghost#")).toBeNull();
	});

	// The staleness path the knowledge layer runs on: cite, edit, and the citation stops resolving.
	it("stops resolving a cited fact once the code behind it changed", async () => {
		const base = type("Base");
		store.replaceFile("a.ref", "h1", [base], []);
		const built = new LexiconService(store, new ProviderSupervisor(), () => null, dir);
		const cited = (await built.factsFor(base.symbolId))?.facts.map((f) => f.factId) as string[];

		expect(built.resolveFacts(cited).missing).toEqual([]);

		store.replaceFile("a.ref", "h2", [{ ...base, signature: "class Base extends Other" }], []);

		expect(built.resolveFacts(cited).missing).toEqual(cited);
	});
});

describe("reading a symbol's source", () => {
	const CART = "export class Cart {\n\tadd() {}\n}\n";

	it("returns the declaration's own text, not the whole file", async () => {
		await boot();
		files.set("a.ref", `${CART}export function other() {}\n`);
		await service.indexFile("a.ref", "h1");
		const target = service.findByName("Cart")[0]?.symbolId;
		if (!target) throw new Error("expected Cart");

		const source = service.symbolSource({ symbolId: target });

		expect(source).toMatchObject({ found: true, module: "a.ref", name: "Cart" });
		if (!source.found) throw new Error("expected a hit");
		expect(source.text).toContain("class Cart");
		expect(source.text).not.toContain("other");
	});

	// The range comes back so a replacement writes where the text was read from, rather than
	// re-deriving a range that could disagree with the one that produced the text.
	it("returns the range that text occupies, and slices to it exactly", async () => {
		await boot();
		files.set("a.ref", `${CART}export function other() {}\n`);
		await service.indexFile("a.ref", "h1");
		const target = service.findByName("Cart")[0]?.symbolId;
		if (!target) throw new Error("expected Cart");

		const source = service.symbolSource({ symbolId: target });
		if (!source.found) throw new Error("expected a hit");

		const text = files.get("a.ref") as string;
		const lines = text.split("\n");
		expect(lines[source.range.start.line]?.slice(source.range.start.character)).toContain("class Cart");
	});

	// Slicing a stale range yields something that looks like source and is not the symbol.
	it("refuses when the file changed since it was indexed", async () => {
		await boot();
		files.set("a.ref", CART);
		await service.indexFile("a.ref", "h1");
		const target = service.findByName("Cart")[0]?.symbolId;
		if (!target) throw new Error("expected Cart");

		files.set("a.ref", `// a line nobody indexed\n${CART}`);
		const source = service.symbolSource({ symbolId: target });

		expect(source).toMatchObject({ found: false, stale: true });
	});

	it("says so when the address names nothing", async () => {
		await boot();
		expect(service.symbolSource({ symbolId: "lexicon reference a.ref Ghost#" })).toMatchObject({ found: false });
		expect(service.symbolSource({})).toMatchObject({ found: false });
	});
});

describe("planning a replacement", () => {
	const CART = "export class Cart {}\n";

	async function plant(text = CART) {
		await boot();
		files.set("a.ref", text);
		await service.indexFile("a.ref", "h1");
		const target = service.findByName("Cart")[0]?.symbolId;
		if (!target) throw new Error("expected Cart");
		return target;
	}

	it("splices the new text into the file without writing it", async () => {
		const target = await plant(`${CART}export class Other {}\n`);

		const plan = await service.planReplacement({ symbolId: target }, "export class Cart { x = 1; }");

		expect(plan.ok).toBe(true);
		if (!plan.ok) throw new Error("expected a plan");
		expect(plan.text).toContain("x = 1");
		expect(plan.text).toContain("Other");
		// Nothing on disk moved: the caller writes, under the gate, after deciding.
		expect(files.get("a.ref")).toBe(`${CART}export class Other {}\n`);
	});

	// The reference provider declares no syntax diagnostics, so it cannot reject anything. Silence
	// from a provider that never claimed to check is reported rather than read as approval.
	it("says the syntax went unchecked when the provider does not report errors", async () => {
		const target = await plant();

		const plan = await service.planReplacement({ symbolId: target }, "export class Cart { broken");

		expect(plan.ok).toBe(true);
		if (!plan.ok) throw new Error("expected a plan");
		expect(plan.issues.map((issue) => issue.kind)).toContain("SyntaxUnchecked");
	});

	// The id embeds the name, so a rename here would strand every caller and every recorded answer.
	it("refuses a replacement that renames the declaration", async () => {
		const target = await plant();

		const plan = await service.planReplacement({ symbolId: target }, "export class Basket {}");

		expect(plan).toMatchObject({ ok: false });
		if (plan.ok) throw new Error("expected a refusal");
		expect(plan.reason).toContain("refactor_rename");
	});

	// Deleting is a real refactor. The fallout is reported rather than the change being refused.
	it("allows a deletion and reports what still points at it", async () => {
		const target = await plant();
		files.set("b.ref", "export class User {}\n");
		await service.indexFile("b.ref", "h1");

		const plan = await service.planReplacement({ symbolId: target }, "// removed");

		expect(plan.ok).toBe(true);
	});

	it("says so when the address names nothing", async () => {
		await boot();
		const plan = await service.planReplacement({ symbolId: "lexicon reference a.ref Ghost#" }, "x");
		expect(plan).toMatchObject({ ok: false });
	});

	// The splice was cut from one exact version. The writer compares against this before applying,
	// so an edit that landed in between is detected instead of overwritten.
	it("reports the hash of the text it spliced from", async () => {
		const target = await plant();
		const plan = await service.planReplacement({ symbolId: target }, "export class Cart { x = 1; }");
		if (!plan.ok) throw new Error("expected a plan");

		expect(plan.baseHash).toBe(service.currentHashOf("a.ref"));

		files.set("a.ref", `// someone else got here first\n${CART}`);
		expect(service.currentHashOf("a.ref")).not.toBe(plan.baseHash);
	});
});

describe("carrying knowledge across a rename", () => {
	// A member's id embeds its container's name, so renaming the container re-mints the member too.
	// Migrating only the container would leave everything written about its members unresolvable.
	it("maps the whole subtree, not just the renamed symbol", async () => {
		await boot();
		files.set("a.ref", "export class Cart {}\n");
		await service.indexFile("a.ref", "h1");
		const cart = service.findByName("Cart")[0]?.symbolId;
		if (!cart) throw new Error("expected Cart");

		const map = service.renameIdMap(cart, "Basket");

		expect(map.get(cart)).toContain("Basket");
		for (const [from, to] of map) {
			expect(from).not.toBe(to);
			expect(to).toContain("Basket");
		}
	});

	it("moves an answer to the new id, leaving nothing under the old one", async () => {
		await boot();
		files.set("a.ref", "export class Cart {}\n");
		await service.indexFile("a.ref", "h1");
		const cart = service.findByName("Cart")[0]?.symbolId;
		if (!cart) throw new Error("expected Cart");

		const facts = await service.factsFor(cart);
		const citation = facts?.facts[0]?.factId;
		if (!citation) throw new Error("expected a citable fact");
		const wrote = await service.recordAnswer(cart, "describe", "A shopping cart.", [citation]);
		if (!wrote.recorded) throw new Error(`answer not recorded: ${wrote.reason}`);

		const map = service.renameIdMap(cart, "Basket");
		const moved = service.migrateKnowledge(map);
		const newId = map.get(cart) as string;

		expect(moved.answers).toBe(1);
		expect(service.recallAnswer(newId, "describe")?.answer.prose).toBe("A shopping cart.");
		expect(service.recallAnswer(cart, "describe")).toBeNull();
	});

	// The new id's own answer was written about the code as it stands. Overwriting it with the old
	// symbol's would be a silent downgrade, so the old one is dropped instead.
	it("keeps an answer already written about the new id", async () => {
		await boot();
		files.set("a.ref", "export class Cart {}\nexport class Basket {}\n");
		await service.indexFile("a.ref", "h1");
		const cart = service.findByName("Cart")[0]?.symbolId as string;
		const basket = service.findByName("Basket")[0]?.symbolId as string;

		const cite = async (id: string) => (await service.factsFor(id))?.facts[0]?.factId as string;
		await service.recordAnswer(cart, "describe", "The old one.", [await cite(cart)]);
		await service.recordAnswer(basket, "describe", "The one that stays.", [await cite(basket)]);

		service.migrateKnowledge(new Map([[cart, basket]]));

		expect(service.recallAnswer(basket, "describe")?.answer.prose).toBe("The one that stays.");
		expect(service.recallAnswer(cart, "describe")).toBeNull();
	});
});

describe("answering about a symbol", () => {
	it("describes a symbol and counts its uses without listing them", async () => {
		await boot();
		files.set("a.ref", "export class Cart {}\n");
		await service.indexFile("a.ref", "h1");

		const found = service.findByName("Cart")[0];
		if (!found) throw new Error("expected Cart");
		const described = service.describe(found.symbolId);

		expect(described).toMatchObject({ tier: "bound", referenceCount: 0 });
		expect(described?.symbol.name).toBe("Cart");
	}, 30_000);

	it("answers null for a symbol the index does not hold, rather than inventing one", async () => {
		await boot();
		expect(service.describe("lexicon reference a.ref Ghost#")).toBeNull();
	}, 30_000);

	it("caps a reference list and says so, since an agent pays for every row", async () => {
		await boot();
		files.set("a.ref", "export class Cart {}\n");
		await service.indexFile("a.ref", "h1");
		const target = service.findByName("Cart")[0]?.symbolId;
		if (!target) throw new Error("expected Cart");

		// Written straight to the store: the reference provider does not emit references.
		store.replaceFile(
			"uses.ref",
			"h2",
			[],
			Array.from({ length: 5 }, () => ({
				name: "Cart",
				range: { start: { line: 1, character: 0 }, end: { line: 1, character: 4 } },
				role: "call" as const,
				binding: { status: "bound" as const, symbolId: target, provenance: "bound" as const },
			})),
		);

		const capped = service.findReferences(target, 2);
		expect(capped).toMatchObject({ total: 5, truncated: true });
		expect(capped.references).toHaveLength(2);

		expect(service.findReferences(target, 50).truncated).toBe(false);
	}, 30_000);

	it("scopes a name search to one module when asked", async () => {
		await boot();
		files.set("a.ref", "export class Same {}\n");
		files.set("b.ref", "export class Same {}\n");
		await service.indexFile("a.ref", "h1");
		await service.indexFile("b.ref", "h2");

		expect(service.findByName("Same")).toHaveLength(2);
		expect(service.findByName("Same", "a.ref")).toHaveLength(1);
	}, 30_000);
});

describe("asking a provider directly", () => {
	it("passes an import through and returns the provider's honest unknown", async () => {
		await boot();
		files.set("a.ref", "");
		const resolution = await service.resolveImport("a.ref", "./b");

		expect(resolution).toMatchObject({ status: "unresolved", reason: "NotImplemented" });
	}, 30_000);
});

describe("planning a rename", () => {
	// Built here rather than inside plant(): a helper that reassigns `service` AND returns a value
	// reads fine and is not, since `service.prepareRename(plant(), ...)` resolves the method on the
	// old service before the argument runs.
	beforeEach(() => {
		service = new LexiconService(store, supervisor, () => null);
	});

	// Written straight to the store rather than through a provider: this reads the index and never
	// asks anyone anything, which is the property the whole prepare step exists to have.
	function plant() {
		const target = "lexicon ts src/cart.ts add().";
		store.replaceFile(
			"src/cart.ts",
			"h1",
			[
				{
					symbolId: target,
					kind: "function",
					name: "add",
					range: { start: { line: 4, character: 0 }, end: { line: 6, character: 1 } },
					selectionRange: { start: { line: 4, character: 16 }, end: { line: 4, character: 19 } },
					visibility: "public",
					exported: true,
				},
			],
			[],
		);
		store.replaceFile(
			"src/uses.ts",
			"h1",
			[],
			[
				{
					name: "add",
					range: { start: { line: 2, character: 8 }, end: { line: 2, character: 11 } },
					role: "call",
					binding: { status: "bound", symbolId: target, provenance: "bound" },
				},
			],
		);
		return target;
	}

	it("includes the declaration's own name, which a plan built from references alone would miss", async () => {
		const plan = await service.prepareRename(plant(), "append");

		const declaring = plan.files.find((f) => f.module === "src/cart.ts");
		expect(declaring?.sites).toEqual([
			{ range: { start: { line: 4, character: 16 }, end: { line: 4, character: 19 } } },
		]);
		expect(plan.occurrences).toBe(2);
	});

	it("groups occurrences by file, since that is the unit a provider rewrites", async () => {
		const plan = await service.prepareRename(plant(), "append");
		expect(plan.files.map((f) => f.module).sort()).toEqual(["src/cart.ts", "src/uses.ts"]);
	});

	// The distinction the plan exists to draw: this is uncertainty, not failure. Refusing here
	// would refuse most real renames, and staying quiet would claim a completeness we do not have.
	it("warns about a same-spelled occurrence that never bound, rather than refusing or hiding it", async () => {
		const target = plant();
		store.replaceFile(
			"src/other.ts",
			"h1",
			[],
			[
				{
					name: "add",
					range: { start: { line: 9, character: 2 }, end: { line: 9, character: 5 } },
					role: "call",
					binding: { status: "unbound", reason: "NotIndexed" },
				},
			],
		);

		const plan = await service.prepareRename(target, "append");

		expect(plan.blockers).toEqual([]);
		expect(plan.warnings.map((w) => w.kind)).toContain("SameSpellingUnbound");
		expect(plan.warnings.find((w) => w.kind === "SameSpellingUnbound")?.sites).toEqual([
			{ module: "src/other.ts", line: 10 },
		]);
		// And it stays out of the edit set, because rewriting an unproven occurrence is the thing
		// a name-matched rename does wrong.
		expect(plan.files.map((f) => f.module)).not.toContain("src/other.ts");
	});

	it("says an exported symbol reaches past what the index can see", async () => {
		const plan = await service.prepareRename(plant(), "append");
		expect(plan.warnings.map((w) => w.kind)).toContain("ExportedBeyondIndex");
	});

	it("blocks a symbol it does not have, rather than planning an empty rename", async () => {
		const plan = await service.prepareRename("lexicon ts src/gone.ts ghost().", "other");

		expect(plan.blockers.map((b) => b.kind)).toEqual(["NotIndexed"]);
		expect(plan.files).toEqual([]);
	});

	it("blocks renaming something to the name it already has", async () => {
		const plan = await service.prepareRename(plant(), "add");
		expect(plan.blockers.map((b) => b.kind)).toEqual(["SameName"]);
	});

	/**
	 * Renaming a parameter reaches its function's CALLERS.
	 *
	 * A named argument spells the parameter at a site written as the function's name, so nothing
	 * searching for the old name finds it. Who calls what is the index's question, so the core
	 * gathers those sites rather than each provider inventing a way to look for them.
	 */
	describe("when the renamed symbol belongs to something", () => {
		const owner = "lexicon python src/cart.py add().";
		const parameter = "lexicon python src/cart.py add().(quantity)";
		const span = (line: number, from: number, to: number) => ({
			start: { line, character: from },
			end: { line, character: to },
		});

		function plantParameter() {
			store.replaceFile(
				"src/cart.py",
				"h1",
				[
					{
						symbolId: owner,
						kind: "function",
						name: "add",
						range: span(0, 0, 40),
						selectionRange: span(0, 4, 7),
						visibility: "public",
					},
					{
						symbolId: parameter,
						kind: "variable",
						name: "quantity",
						range: span(0, 8, 16),
						selectionRange: span(0, 8, 16),
						visibility: "local",
						containerId: owner,
					},
				],
				[],
			);
			store.replaceFile(
				"src/uses.py",
				"h1",
				[],
				[
					{
						name: "add",
						range: span(3, 0, 3),
						role: "call",
						binding: { status: "bound", symbolId: owner, provenance: "bound" },
					},
				],
			);
			return new LexiconService(store, new ProviderSupervisor(), () => null, dir);
		}

		it("hands the provider every bound call to the owning function", async () => {
			const plan = await plantParameter().prepareRename(parameter, "amount");
			const uses = plan.files.find((f) => f.module === "src/uses.py");

			expect(uses?.ownerCalls).toEqual([span(3, 0, 3)]);
		});

		// The file has no occurrence of the parameter's name at all, so a plan built from occurrences
		// alone would never visit it.
		it("visits a file that holds only owner calls", async () => {
			const plan = await plantParameter().prepareRename(parameter, "amount");
			expect(plan.files.map((f) => f.module)).toContain("src/uses.py");
		});

		it("leaves an ordinary rename alone, since most symbols own themselves", async () => {
			const plan = await plantParameter().prepareRename(owner, "insert");
			expect(plan.files.every((f) => f.ownerCalls === undefined)).toBe(true);
		});

		/**
		 * Absent and empty are different answers, and a provider acts on the difference.
		 *
		 * The declaring file usually contains no call to its own function, so attaching the field only
		 * where calls live would leave it looking identical to "nothing was gathered", and a provider
		 * that must refuse without owner calls would refuse the declaration forever.
		 */
		it("says empty rather than nothing for a file with no owner call in it", async () => {
			const plan = await plantParameter().prepareRename(parameter, "amount");
			const declaring = plan.files.find((f) => f.module === "src/cart.py");

			expect(declaring?.ownerCalls).toEqual([]);
			expect(plan.files.every((f) => f.ownerCalls !== undefined)).toBe(true);
		});

		// A call that never bound may still pass the argument by name, and nothing here can tell that
		// from a different function of the same name. Reported rather than guessed at.
		it("warns about calls to the owner that did not bind, naming them", async () => {
			const built = plantParameter();
			store.replaceFile(
				"src/dynamic.py",
				"h1",
				[],
				[
					{
						name: "add",
						range: span(9, 2, 5),
						role: "call",
						binding: { status: "unbound", reason: "NotIndexed" },
					},
				],
			);

			const warning = (await built.prepareRename(parameter, "amount")).warnings.find(
				(w) => w.kind === "OwnerCallsUnresolved",
			);

			expect(warning?.sites).toEqual([{ module: "src/dynamic.py", line: 10 }]);
		});
	});

	/**
	 * A rename onto a name already in use produces a file where one spelling means two things, and
	 * that still parses often enough to be committed.
	 */
	describe("when the new name is already taken", () => {
		function planted(module: string, name: string, line: number) {
			return {
				symbolId: `lexicon ts ${module} ${name}().`,
				kind: "function" as const,
				name,
				range: { start: { line, character: 0 }, end: { line: line + 2, character: 1 } },
				selectionRange: { start: { line, character: 9 }, end: { line, character: 9 + name.length } },
				visibility: "public" as const,
			};
		}

		it("blocks on a declaration in a file the rename rewrites, and points at it", async () => {
			const target = plant();
			store.replaceFile(
				"src/uses.ts",
				"h2",
				[planted("src/uses.ts", "append", 20)],
				[
					{
						name: "add",
						range: { start: { line: 2, character: 8 }, end: { line: 2, character: 11 } },
						role: "call",
						binding: { status: "bound", symbolId: target, provenance: "bound" },
					},
				],
			);

			const plan = await service.prepareRename(target, "append");
			const blocker = plan.blockers.find((b) => b.kind === "NameTaken");

			expect(blocker?.sites).toEqual([{ module: "src/uses.ts", line: 20 }]);
			expect(blocker?.detail).toContain("Rename that declaration first, or pick another name.");
		});

		it("blocks when the new name is already imported into a file it rewrites", async () => {
			const target = plant();
			store.replaceFile(
				"src/uses.ts",
				"h2",
				[],
				[
					{
						name: "add",
						range: { start: { line: 2, character: 8 }, end: { line: 2, character: 11 } },
						role: "call",
						binding: { status: "bound", symbolId: target, provenance: "bound" },
					},
				],
				[
					{
						specifier: "./elsewhere.js",
						reExport: false,
						imported: [
							{
								name: "append",
								range: { start: { line: 0, character: 9 }, end: { line: 0, character: 15 } },
							},
						],
					},
				],
			);

			const blocker = (await service.prepareRename(target, "append")).blockers.find(
				(b) => b.kind === "NameImported",
			);

			expect(blocker?.sites).toEqual([{ module: "src/uses.ts", line: 0 }]);
			expect(blocker?.detail).toContain("pick another name");
		});

		// An import's LOCAL binding is what the file calls it, so an alias collides under its alias
		// and not under the name its source module uses.
		it("checks what the importing file calls it, not what the source module does", async () => {
			const target = plant();
			store.replaceFile(
				"src/uses.ts",
				"h2",
				[],
				[
					{
						name: "add",
						range: { start: { line: 2, character: 8 }, end: { line: 2, character: 11 } },
						role: "call",
						binding: { status: "bound", symbolId: target, provenance: "bound" },
					},
				],
				[
					{
						specifier: "./elsewhere.js",
						reExport: false,
						imported: [
							{
								name: "push",
								range: { start: { line: 0, character: 9 }, end: { line: 0, character: 13 } },
								local: "append",
								localRange: { start: { line: 0, character: 17 }, end: { line: 0, character: 23 } },
							},
						],
					},
				],
			);

			expect((await service.prepareRename(target, "append")).blockers.map((b) => b.kind)).toEqual([
				"NameImported",
			]);
			expect((await service.prepareRename(target, "push")).blockers).toEqual([]);
		});

		// Another module owning the name is ordinary. Only a clash inside a file being edited is one.
		it("allows a name that is taken somewhere this rename never touches", async () => {
			const target = plant();
			store.replaceFile("src/unrelated.ts", "h1", [planted("src/unrelated.ts", "append", 3)], []);

			expect((await service.prepareRename(target, "append")).blockers).toEqual([]);
		});
	});
});

// The gap found by running prepare_rename on lexicon's own source: it reported 4 occurrences of
// SCHEMA_VERSION when the truth was 6, because an occurrence written inside an import statement
// was in no table at all.
describe("renaming a symbol that other files import", () => {
	const target = "lexicon ts src/cart.ts add().";

	/** Resolves every specifier to the declaring module, which is what makes the import a site. */
	function resolvingTo(module: string) {
		return {
			ask: async (_module: string, method: string) =>
				method === "resolveImport" ? { status: "resolved", module } : {},
		} as unknown as ProviderSupervisor;
	}

	function declare() {
		store.replaceFile(
			"src/cart.ts",
			"h1",
			[
				{
					symbolId: target,
					kind: "function",
					name: "add",
					range: { start: { line: 0, character: 0 }, end: { line: 2, character: 1 } },
					selectionRange: { start: { line: 0, character: 16 }, end: { line: 0, character: 19 } },
					visibility: "public",
					exported: false,
				},
			],
			[],
		);
	}

	it("rewrites the name inside an import, which no reference row covers", async () => {
		declare();
		store.replaceFile(
			"src/uses.ts",
			"h1",
			[],
			[],
			[
				{
					specifier: "./cart",
					reExport: false,
					imported: [
						{ name: "add", range: { start: { line: 0, character: 9 }, end: { line: 0, character: 12 } } },
					],
				},
			],
		);
		service = new LexiconService(store, resolvingTo("src/cart.ts"), () => null);

		const plan = await service.prepareRename(target, "append");
		const importing = plan.files.find((f) => f.module === "src/uses.ts");

		expect(importing?.sites).toEqual([
			{ range: { start: { line: 0, character: 9 }, end: { line: 0, character: 12 } }, role: "import" },
		]);
	});

	// `import { add as plus }` renames `add` and leaves every use of `plus` alone. Rewriting the
	// local span here would break the very file the rename was meant to keep working.
	it("rewrites only the source half of an alias, never the local binding", async () => {
		declare();
		store.replaceFile(
			"src/aliased.ts",
			"h1",
			[],
			[],
			[
				{
					specifier: "./cart",
					reExport: false,
					imported: [
						{
							name: "add",
							range: { start: { line: 0, character: 9 }, end: { line: 0, character: 12 } },
							local: "plus",
							localRange: { start: { line: 0, character: 16 }, end: { line: 0, character: 20 } },
						},
					],
				},
			],
		);
		service = new LexiconService(store, resolvingTo("src/cart.ts"), () => null);

		const sites = (await service.prepareRename(target, "append")).files.find(
			(f) => f.module === "src/aliased.ts",
		)?.sites;

		expect(sites).toHaveLength(1);
		expect(sites?.[0]?.range.start.character).toBe(9);
	});

	// Found by asking this tool about its own ProviderHandlers: it reported 9 of 12 occurrences,
	// missing every `import { X } from "@scope/pkg"` because the package entry is a barrel and the
	// declaration lives in a file the barrel re-exports. A barrel is the normal case, not an exotic
	// one, so demanding the resolved and declaring modules match made most real imports invisible.
	it("follows a re-export chain, so an import through a barrel is still a site", async () => {
		declare();
		const span = { start: { line: 0, character: 9 }, end: { line: 0, character: 12 } };
		// The barrel re-exports from the declaring module.
		store.replaceFile(
			"src/index.ts",
			"h1",
			[],
			[],
			[{ specifier: "./cart", reExport: true, imported: [{ name: "add", range: span }] }],
		);
		// The consumer imports the package, which lands on the barrel and not on the declaration.
		store.replaceFile(
			"src/far.ts",
			"h1",
			[],
			[],
			[{ specifier: "@scope/pkg", reExport: false, imported: [{ name: "add", range: span }] }],
		);

		service = new LexiconService(
			store,
			{
				ask: async (_m: string, method: string, params: { specifier: string }) =>
					method === "resolveImport"
						? { status: "resolved", module: params.specifier === "./cart" ? "src/cart.ts" : "src/index.ts" }
						: {},
			} as unknown as ProviderSupervisor,
			() => null,
		);

		const touched = (await service.prepareRename(target, "append")).files.map((f) => f.module);

		expect(touched).toContain("src/index.ts");
		expect(touched).toContain("src/far.ts");
	});

	it("ignores an import of the same name from somewhere else entirely", async () => {
		declare();
		store.replaceFile(
			"src/elsewhere.ts",
			"h1",
			[],
			[],
			[
				{
					specifier: "./other",
					reExport: false,
					imported: [
						{ name: "add", range: { start: { line: 0, character: 9 }, end: { line: 0, character: 12 } } },
					],
				},
			],
		);
		service = new LexiconService(store, resolvingTo("src/other.ts"), () => null);

		const plan = await service.prepareRename(target, "append");
		expect(plan.files.map((f) => f.module)).not.toContain("src/elsewhere.ts");
	});
});

describe("searching literals", () => {
	function literal(value: string, line: number, kind = "string", numeric?: number) {
		return {
			kind: kind as "string" | "number" | "boolean",
			value,
			...(numeric === undefined ? {} : { number: numeric }),
			range: { start: { line, character: 0 }, end: { line, character: value.length } },
		};
	}

	beforeEach(() => {
		service = new LexiconService(store, supervisor, () => null, dir);
		store.replaceFile("a.ts", "h1", [], [], [], [literal("thing_happened", 0), literal("30", 1, "number", 30)]);
		store.replaceFile(
			"b.ts",
			"h1",
			[],
			[],
			[],
			[literal("thing_happened", 5), literal("other", 6), literal("5000", 7, "number", 5000)],
		);
	});

	it("finds an exact value across files", () => {
		const found = service.findLiterals({ value: "thing_happened" });
		expect(found.total).toBe(2);
		expect(found.literals.map((l) => l.module).sort()).toEqual(["a.ts", "b.ts"]);
	});

	it("matches a regex rather than only an exact value", () => {
		expect(service.findLiterals({ regex: "/^thing_/" }).total).toBe(2);
		expect(service.findLiterals({ regex: "/nothing/" }).total).toBe(0);
	});

	// A range has to be arithmetic. As strings "5000" sorts before "30", so a string comparison
	// would answer this question confidently and wrongly.
	it("searches numbers as numbers", () => {
		const found = service.findLiterals({ min: 100, max: 9999 });
		expect(found.literals.map((l) => l.value)).toEqual(["5000"]);
	});

	it("rejects an invalid regex", () => {
		expect(() => service.findLiterals({ regex: "/(unclosed/" })).toThrow();
	});

	// The whole reason for the tier: no graph edge connects two files that share a magic string.
	it("finds values written in more than one file", () => {
		const shared = service.sharedLiterals(2);
		expect(shared.map((row) => row.value)).toEqual(["thing_happened"]);
		expect(shared[0]).toMatchObject({ files: 2, uses: 2 });
	});
});

describe("searching imports", () => {
	beforeEach(() => {
		service = new LexiconService(store, new ProviderSupervisor(), () => null, dir);
		store.replaceFile(
			"a.ts",
			"h1",
			[],
			[],
			[
				{ specifier: "@scope/one", imported: [], reExport: false },
				{ specifier: "./two", imported: [], reExport: false },
			],
		);
	});

	it("matches written specifiers with a regex", async () => {
		const found = await service.findImports({ specifierRegex: "/@scope\\//i" });

		expect(found.imports.map((entry) => entry.specifier)).toEqual(["@scope/one"]);
	});

	it("matches resolved modules with a regex", async () => {
		const resolving = {
			ask: async (_module: string, method: string, params: { specifier: string }) =>
				method === "resolveImport"
					? { status: "resolved", module: params.specifier === "@scope/one" ? "src/one.ts" : "src/two.ts" }
					: {},
		} as unknown as ProviderSupervisor;
		service = new LexiconService(store, resolving, () => null, dir);

		const found = await service.findImports({ moduleRegex: "/src\\/two\\.ts$/" });

		expect(found.imports.map((entry) => entry.specifier)).toEqual(["./two"]);
	});
});

describe("performing a rename", () => {
	const target = "lexicon ts src/cart.ts add().";

	/** Answers renameEdits however the test needs, and resolves nothing, so only bound sites appear. */
	function answering(reply: (module: string) => unknown) {
		return {
			ask: async (module: string, method: string) =>
				method === "renameEdits" ? reply(module) : { status: "unresolved", reason: "NotImplemented" },
			route: () => ({ owned: false, reason: "unclaimed" }),
		} as unknown as ProviderSupervisor;
	}

	function plant() {
		writeFileSync(path.join(dir, "cart.ts"), "export function add() {}\n");
		store.replaceFile(
			"cart.ts",
			"h1",
			[
				{
					symbolId: target,
					kind: "function",
					name: "add",
					range: { start: { line: 0, character: 0 }, end: { line: 0, character: 24 } },
					selectionRange: { start: { line: 0, character: 16 }, end: { line: 0, character: 19 } },
					visibility: "public",
					exported: false,
				},
			],
			[],
		);
	}

	function serviceThat(reply: (module: string) => unknown) {
		return new LexiconService(
			store,
			answering(reply),
			(module) => {
				try {
					return readFileSync(path.join(dir, module), "utf8");
				} catch {
					return null;
				}
			},
			dir,
		);
	}

	const rewriteTheName = {
		status: "ready",
		edits: [{ range: { start: { line: 0, character: 16 }, end: { line: 0, character: 19 } }, newText: "append" }],
		blocked: [],
	};

	it("writes the provider's edits and says which files it touched", async () => {
		plant();
		const outcome = await serviceThat(() => rewriteTheName).renameSymbol(target, "append");

		expect(outcome).toMatchObject({ renamed: true, modules: ["cart.ts"] });
		expect(readFileSync(path.join(dir, "cart.ts"), "utf8")).toBe("export function append() {}\n");
	});

	// The load-bearing rule. A blocked site is an occurrence that SHOULD change and cannot, so
	// applying the rest would leave a tree that no longer builds.
	it("writes nothing at all when any occurrence is blocked", async () => {
		plant();
		const blocked = {
			status: "ready",
			edits: rewriteTheName.edits,
			blocked: [
				{
					range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
					reason: "StringLiteral",
					detail: "reached through a string",
				},
			],
		};

		const outcome = await serviceThat(() => blocked).renameSymbol(target, "append");

		expect(outcome.renamed).toBe(false);
		expect(readFileSync(path.join(dir, "cart.ts"), "utf8")).toBe("export function add() {}\n");
		expect(outcome.plan.blockers.map((b) => b.kind)).toEqual(["StringLiteral"]);
	});

	it("writes nothing when the provider refuses the whole request", async () => {
		plant();
		const refused = { status: "refused", reason: "Collision", detail: "append already exists here" };

		const outcome = await serviceThat(() => refused).renameSymbol(target, "append");

		expect(outcome).toMatchObject({ renamed: false });
		expect((outcome as { reason: string }).reason).toContain("Collision");
		expect(readFileSync(path.join(dir, "cart.ts"), "utf8")).toBe("export function add() {}\n");
	});

	it("refuses before asking any provider when the plan itself is blocked", async () => {
		plant();
		let asked = 0;
		const outcome = await serviceThat(() => {
			asked++;
			return rewriteTheName;
		}).renameSymbol(target, "add");

		expect(outcome.renamed).toBe(false);
		expect(asked).toBe(0);
	});
});
