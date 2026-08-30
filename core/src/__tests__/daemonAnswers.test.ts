// Every daemon answer, parsed back through the schema that names it.
//
// Dispatch parses each answer through `DAEMON_METHODS[method].response`, and plain `z.object` strips
// what the schema does not name, so a field core emits that the schema forgot never reaches a client
// and nothing fails. The answer is taken here from the handler map, ahead of that parse, and the
// parsed value must deep-equal it: an unnamed field, a missing nullable or a value outside an enum
// fails this file rather than vanishing on the wire.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DAEMON_METHODS, type DaemonMethod, type RequestOf, type ResponseOf } from "@nyaa-lexicon/protocol";
import { createDispatch, daemonHandlers, type Gate, gateOf } from "../dispatch";
import { LexiconService } from "../service";
import { sourceReader } from "../sourceRead";
import { IndexStore } from "../store";
import { ProviderSupervisor } from "../supervisor";
import { TransactionManager } from "../transactions";
import { BUILD_VERSION } from "../version";
import { WorkspaceGate } from "../workspaceGate";

////////////////////////////////
//  Harness

const ROOT = path.join(import.meta.dirname, "..", "..", "..");

/** Providers run from source under bun. */
const REFERENCE = path.join(ROOT, "protocol", "src", "conformance", "referenceProvider.ts");
const MARKDOWN = path.join(ROOT, "providers", "markdown", "src", "main.ts");
const JSON_PROVIDER = path.join(ROOT, "providers", "json", "src", "main.ts");
const TYPESCRIPT = path.join(ROOT, "providers", "typescript", "src", "main.ts");

interface Harness {
	service: LexiconService;
	handlers: ReturnType<typeof daemonHandlers>;
	gate: Gate;
	dispatch: (method: string, params: unknown) => Promise<unknown>;
	symbol: (name: string, module: string) => string;
	close: () => void;
}

/** Throws with git's own stderr, so a machine without git fails here rather than answering emptily. */
function git(cwd: string, ...args: string[]): void {
	execFileSync(
		"git",
		["-c", "user.name=lexicon", "-c", "user.email=lexicon@example.invalid", "-c", "commit.gpgsign=false", ...args],
		{ cwd, stdio: "pipe" },
	);
}

/** A committed workspace, its providers, and one gate and one journal shared by handlers and dispatcher. */
async function openWorkspace(files: Record<string, string>, providers: string[], commit: string): Promise<Harness> {
	const root = mkdtempSync(path.join(tmpdir(), "lexicon-answers-"));
	const workspace = path.join(root, "workspace");
	mkdirSync(workspace);
	for (const [name, text] of Object.entries(files)) writeFileSync(path.join(workspace, name), text);
	git(workspace, "init", "-q");
	git(workspace, "add", "-A");
	git(workspace, "commit", "-q", "-m", commit);

	const store = IndexStore.open(path.join(root, "index.sqlite")).store;
	const supervisor = new ProviderSupervisor();
	await Promise.all(
		providers.map((main) =>
			supervisor.start({ command: [process.execPath, "run", main], timeoutMs: 60_000 }, workspace),
		),
	);
	const service = new LexiconService(store, supervisor, sourceReader(workspace), workspace);
	const refactor = { gate: new WorkspaceGate(), transactions: new TransactionManager(store, workspace) };
	await service.indexWorkspace();

	return {
		service,
		handlers: daemonHandlers(service, refactor),
		gate: gateOf(refactor),
		dispatch: createDispatch(service, refactor),
		symbol: (name, module) => {
			const found = service.findByName(name, module)[0];
			if (found === undefined) throw new Error(`${module} declares no ${name}`);
			return found.symbolId;
		},
		close: () => {
			supervisor.stopAll();
			store.close();
			rmSync(root, { recursive: true, force: true });
		},
	};
}

/** The workspace the current describe opened. */
let harness: Harness;

////////////////////////////////
//  The proof

/** Raw answers by method, so a later call in a sequence can build on an earlier one. */
const answers: { [M in DaemonMethod]?: ResponseOf<M> } = {};

/** Methods the running sample asked, so a sample cannot satisfy its slot by asking another. */
const asked = new Set<DaemonMethod>();

/**
 * One call, with both directions proven against the table.
 *
 * The request goes through the table's parse as dispatch would send it. The handler's answer is
 * taken raw, because the value dispatch returns is already parsed and parsing it again proves
 * nothing; that raw value is what must survive the schema intact.
 */
async function ask<M extends DaemonMethod>(method: M, params: RequestOf<M>): Promise<ResponseOf<M>> {
	const entry = DAEMON_METHODS[method];
	const args = entry.request.parse(params);
	expect(args, `${method} request`).toEqual(params);

	const raw: unknown = await harness.handlers[method].run(args as never, harness.gate);
	const parsed = entry.response.parse(raw);
	expect(raw, `${method} answer`).toEqual(parsed);

	(answers as Record<string, unknown>)[method] = raw;
	asked.add(method);
	return raw as ResponseOf<M>;
}

////////////////////////////////
//  Every method, over a mixed fixture

const MIXED_FILES: Record<string, string> = {
	// Code through the reference provider: two declarations, each with a comment; nothing bound.
	"cart.ref": "// Holds items until checkout.\nexport class Cart {}\n\n// Adds one item.\nexport function add() {}\n",
	// A second code module, so a move and an insert have a target inside the workspace.
	"item.ref": "export const ITEM_LIMIT = 3\n",
	// Prose: nested headings as symbols, a paragraph and a fence as docs, frontmatter as a literal.
	"README.md":
		"---\nseverity: warning\n---\n\n# Cart\n\nThe cart holds items until checkout.\n\n## Checkout\n\n```sh\nbun run cart\n```\n",
	// Data: keys as symbols, values as literals, one value shared with the frontmatter.
	"config.json": '{\n\t"severity": "warning",\n\t"limit": 3\n}\n',
	// On disk and in history, owned by no provider.
	"notes.txt": "plain text nobody claims\n",
};

/** The class in cart.ref and the heading in README.md, which share a name on purpose. */
let cart: string;
let heading: string;

function fact(kind: "declaration" | "comment"): string {
	const found = answers.factsFor?.facts.find((entry) => entry.kind === kind);
	if (found === undefined) throw new Error(`factsFor produced no ${kind} fact`);
	return found.factId;
}

function recordedAnswerId(): string {
	const outcome = answers.recordAnswer;
	if (outcome?.recorded !== true) throw new Error("no answer was recorded");
	return outcome.answer.factId;
}

let doubtToken = "";

/** One per method. Each asks its own method at least once and asserts what the fixture makes true. */
const SAMPLES: { [M in DaemonMethod]: () => Promise<unknown> | unknown } = {
	findByName: async () => {
		const both = await ask("findByName", { name: "Cart" });
		expect(both.map((symbol) => symbol.module).sort()).toEqual(["README.md", "cart.ref"]);
		expect(await ask("findByName", { name: "Cart", module: "cart.ref" })).toHaveLength(1);
	},
	describe: async () => {
		const code = await ask("describe", { symbolId: cart });
		expect(code?.symbol.docComment).toBe("Holds items until checkout.");
		const section = await ask("describe", { symbolId: heading });
		expect(section?.prose?.length).toBeGreaterThan(0);
	},
	declarationOf: async () => {
		expect(await ask("declarationOf", { symbolId: cart })).not.toBeNull();
	},
	diagnoseSubject: async () => {
		const ghost = "lexicon reference cart.ref Ghost#";
		const diagnosis = await ask("diagnoseSubject", { symbolId: ghost });
		expect(diagnosis.kind).toBe("unminted");
		expect(diagnosis.candidates).toContain(cart);
		const refused = await ask("recordAnswer", {
			symbolId: ghost,
			question: "describe",
			prose: "Nothing.",
			citations: [],
		});
		expect(refused.recorded ? "recorded" : refused.reason).toBe(diagnosis.reason);
	},
	declarationsIn: async () => {
		expect(await ask("declarationsIn", { module: "cart.ref" })).toHaveLength(2);
	},
	typeHierarchy: () => ask("typeHierarchy", { symbolId: cart }),
	callHierarchy: () => ask("callHierarchy", { symbolId: cart }),
	findReferences: () => ask("findReferences", { symbolId: cart, limit: 5, within: cart }),
	resolveImport: async () => {
		expect((await ask("resolveImport", { fromModule: "cart.ref", specifier: "./item" })).status).toBe("unresolved");
	},
	indexStatus: async () => {
		expect((await ask("indexStatus", {})).state).toBe("ready");
		await ask("indexStatus", { concerning: "cart.ref" });
	},
	findLiterals: async () => {
		expect((await ask("findLiterals", { value: "warning" })).total).toBe(2);
		expect((await ask("findLiterals", { kind: "number", min: 1, max: 5, limit: 10 })).literals).toHaveLength(1);
	},
	findComments: async () => {
		expect((await ask("findComments", { text: "until checkout", limit: 10 })).total).toBe(1);
	},
	findDocs: async () => {
		expect((await ask("findDocs", { text: "until checkout" })).total).toBe(1);
		const fenced = await ask("findDocs", { fenced: true, module: "README.md" });
		expect(fenced.docs[0]?.headingPath).toEqual(["Cart", "Checkout"]);
	},
	sharedLiterals: async () => {
		const shared = await ask("sharedLiterals", { minimumFiles: 2, limit: 10 });
		expect(shared).toEqual([expect.objectContaining({ value: "warning", files: 2 })]);
	},
	cycles: () => ask("cycles", { limit: 5 }),
	mostReferenced: () => ask("mostReferenced", { limit: 5 }),
	hubs: () => ask("hubs", { limit: 5 }),
	cacheStats: () => ask("cacheStats", {}),
	searchSymbols: async () => {
		expect((await ask("searchSymbols", { text: "Cart" })).symbols.length).toBeGreaterThan(1);
		const exact = await ask("searchSymbols", { regex: "/^add$/", kind: "function", module: "cart.ref", limit: 5 });
		expect(exact.total).toBe(1);
	},
	outlineModule: async () => {
		const outline = await ask("outlineModule", { module: "README.md" });
		expect(outline.some((symbol) => symbol.containerId !== undefined)).toBe(true);
	},
	fileNotes: async () => {
		expect((await ask("fileNotes", { module: "config.json" })).known).toBe(true);
		expect((await ask("fileNotes", { module: "ghost.ref" })).known).toBe(false);
	},
	moduleStatus: async () => {
		expect(await ask("moduleStatus", { module: "cart.ref" })).toMatchObject({
			exists: true,
			claimed: true,
			indexed: true,
			depth: "full",
		});
		expect(await ask("moduleStatus", { module: "ghost.ref" })).toMatchObject({ exists: false, indexed: false });
		expect(await ask("moduleStatus", { module: "notes.txt" })).toMatchObject({
			exists: true,
			claimed: false,
			unclaimedReason: "unclaimed",
			indexed: false,
		});
	},
	moduleDeclarations: async () => {
		const held = await ask("moduleDeclarations", { module: "cart.ref" });
		expect(held).toMatchObject({ exists: true, claimed: true, indexed: true, read: { kind: "text" } });
		expect(held.diskHash).toBe(held.contentHash);
		expect(held.declarations.map((row) => row.name)).toEqual(["Cart", "add"]);
		expect(await ask("moduleDeclarations", { module: "ghost.ref" })).toMatchObject({
			exists: false,
			read: { kind: "missing" },
			contentHash: null,
			diskHash: null,
			declarations: [],
		});
	},
	findImports: () => ask("findImports", { specifier: "./item", limit: 5 }),
	overview: async () => {
		const overview = await ask("overview", {});
		expect(overview.files).toBe(4);
		expect(overview.scan).toBeDefined();
	},
	coChangedWith: async () => {
		const together = await ask("coChangedWith", { module: "cart.ref", limit: 5 });
		expect(together.commits).toBe(1);
		expect(together.partners).toHaveLength(4);
	},
	fileHistory: async () => {
		expect((await ask("fileHistory", { module: "cart.ref" })).commits).toBe(1);
	},
	commitsMentioning: async () => {
		expect((await ask("commitsMentioning", { name: "Cart", limit: 5 })).mentions).toHaveLength(1);
	},
	knowledgeGaps: async () => {
		await ask("knowledgeGaps", {});
		expect((await ask("knowledgeGaps", { module: "cart.ref", question: "why", limit: 5 })).scope).toBeDefined();
	},
	typeOf: async () => {
		expect((await ask("typeOf", { symbolId: cart })).status).toBe("unknown");
	},
	prepareRename: async () => {
		expect((await ask("prepareRename", { symbolId: cart, newName: "Basket" })).oldName).toBe("Cart");
	},
	renameEdits: () => ask("renameEdits", { symbolId: cart, newName: "Basket" }),
	planMove: async () => {
		expect((await ask("planMove", { symbolId: cart, toModule: "item.ref" })).ok).toBe(true);
	},
	indexFile: async () => {
		expect((await ask("indexFile", { module: "cart.ref" })).action).toBe("indexed");
	},
	symbolSource: async () => {
		expect((await ask("symbolSource", { symbolId: cart })).found).toBe(true);
		expect((await ask("symbolSource", { symbolId: cart.replace("Cart", "Ghost") })).found).toBe(false);
	},

	// Knowledge, in the order the plan runs it.
	factsFor: async () => {
		const facts = await ask("factsFor", { symbolId: cart, limit: 10 });
		expect(facts?.facts.map((entry) => entry.kind)).toEqual(expect.arrayContaining(["declaration", "comment"]));
	},
	recordAnswer: async () => {
		const outcome = await ask("recordAnswer", {
			symbolId: cart,
			question: "describe",
			prose: "Holds the items of one checkout.",
			citations: [fact("declaration"), fact("comment")],
			model: "test",
		});
		expect(outcome.recorded).toBe(true);
	},
	invalidateAnswer: async () => {
		const outcome = await ask("invalidateAnswer", {
			symbolId: cart,
			reason: "checkout was rewritten",
			question: "describe",
			by: "test",
		});
		expect(outcome.doubted).toHaveLength(1);
	},
	recallAnswer: async () => {
		const one = await ask("recallAnswer", { symbolId: cart, question: "describe" });
		if (one === null || Array.isArray(one)) throw new Error("recalling one question answered the other shape");
		doubtToken = one.answer.doubt?.factId ?? "";
		expect(doubtToken).not.toBe("");
		expect(await ask("recallAnswer", { symbolId: cart })).toHaveLength(1);
	},
	reaffirmAnswer: async () => {
		const outcome = await ask("reaffirmAnswer", {
			symbolId: cart,
			question: "describe",
			resolvesDoubt: doubtToken,
			model: "test",
		});
		expect(outcome.recorded).toBe(true);
	},
	resolveFacts: async () => {
		const outcome = await ask("resolveFacts", { factIds: [fact("declaration"), recordedAnswerId(), "ghost"] });
		expect(outcome.resolved.map((entry) => entry.fact)).toEqual(["declaration", "answer"]);
		expect(outcome.missing).toEqual(["ghost"]);
	},

	// Refactoring, in the order the plan runs it; the three steps this provider cannot do refuse.
	refactorStart: async () => {
		expect((await ask("refactorStart", {})).started).toBe(true);
	},
	refactorStatus: async () => {
		expect((await ask("refactorStatus", {})).open).toBe(true);
	},
	refactorTrack: async () => {
		expect((await ask("refactorTrack", { module: "cart.ref" })).tracked).toBe(true);
	},
	refactorReplace: async () => {
		const outcome = await ask("refactorReplace", { symbolId: cart, newText: "export class Cart extends Bag" });
		expect(outcome.replaced).toBe(true);
	},
	refactorUndo: async () => {
		expect(await ask("refactorUndo", {})).toMatchObject({ undone: true, modules: ["cart.ref"] });
	},
	refactorInsert: async () => {
		const outcome = await ask("refactorInsert", { module: "item.ref", text: "export const ITEM_STEP = 1" });
		expect(outcome.inserted).toBe(true);
		expect(outcome.symbolIds).toHaveLength(1);
	},
	refactorRename: async () => {
		expect((await ask("refactorRename", { symbolId: cart, newName: "Basket" })).renamed).toBe(false);
	},
	refactorMove: async () => {
		expect((await ask("refactorMove", { symbolId: cart, toModule: "item.ref" })).moved).toBe(false);
	},
	refactorRevert: async () => {
		expect(await ask("refactorRevert", {})).toMatchObject({ reverted: true, modules: ["cart.ref", "item.ref"] });
	},
	refactorCommit: async () => {
		// Reverting closed the transaction, so the plan's order ends on the refusal shape.
		expect((await ask("refactorCommit", {})).committed).toBe(false);
		// A fresh transaction with one step carries an issue this provider cannot check, so force.
		await ask("refactorStart", {});
		await ask("refactorInsert", { module: "item.ref", text: "export const ITEM_STEP = 1" });
		expect((await ask("refactorCommit", { force: true })).committed).toBe(true);
	},
};

/** Each later answer depends on an earlier one, so these never run as independent cases. */
const KNOWLEDGE = [
	"factsFor",
	"recordAnswer",
	"invalidateAnswer",
	"recallAnswer",
	"reaffirmAnswer",
	"resolveFacts",
] as const satisfies readonly DaemonMethod[];

const REFACTOR = [
	"refactorStart",
	"refactorStatus",
	"refactorTrack",
	"refactorReplace",
	"refactorUndo",
	"refactorInsert",
	"refactorRename",
	"refactorMove",
	"refactorRevert",
	"refactorCommit",
] as const satisfies readonly DaemonMethod[];

const SEQUENCED = new Set<DaemonMethod>([...KNOWLEDGE, ...REFACTOR]);

const INDEPENDENT = (Object.keys(DAEMON_METHODS) as DaemonMethod[]).filter((method) => !SEQUENCED.has(method));

async function run(method: DaemonMethod): Promise<void> {
	asked.clear();
	await SAMPLES[method]();
	expect([...asked], `the ${method} sample never asked ${method}`).toContain(method);
}

describe("every daemon answer parses back to itself", () => {
	beforeAll(async () => {
		harness = await openWorkspace(MIXED_FILES, [REFERENCE, MARKDOWN, JSON_PROVIDER], "Add Cart with its README");
		// The reference provider discovers no files, so its modules are indexed by name.
		for (const module of ["cart.ref", "item.ref"]) {
			const outcome = await harness.service.indexFile(module);
			if (outcome.action !== "indexed") throw new Error(`${module}: ${outcome.action} ${outcome.reason ?? ""}`);
		}
		cart = harness.symbol("Cart", "cart.ref");
		heading = harness.symbol("Cart", "README.md");
	}, 120_000);

	afterAll(() => harness?.close());

	// The mapped type makes a missing sample a compile error; this holds even if someone weakens it.
	it("holds one sample per method in the table, and nothing else", () => {
		expect(Object.keys(SAMPLES).sort()).toEqual(Object.keys(DAEMON_METHODS).sort());
		expect(INDEPENDENT.length + SEQUENCED.size).toBe(Object.keys(DAEMON_METHODS).length);
	});

	it.each(INDEPENDENT)("%s", (method) => run(method), 30_000);

	it("answers the knowledge sequence in order", async () => {
		for (const method of KNOWLEDGE) await run(method);
	}, 30_000);

	it("answers the refactor sequence in order", async () => {
		for (const method of REFACTOR) await run(method);
	}, 60_000);

	// The one dispatcher behaviour a stale client reads: the exact text, with the build named.
	it("refuses an unknown method through the dispatcher, naming the build", async () => {
		const failure: unknown = await harness.dispatch("noSuchMethod", {}).then(
			() => null,
			(error: unknown) => error,
		);
		expect(failure).toBeInstanceOf(Error);
		expect((failure as Error).message).toBe(`unknown method: noSuchMethod (this daemon runs ${BUILD_VERSION})`);
	});
});

////////////////////////////////
//  The populated arms, through the TypeScript provider

const TYPESCRIPT_FILES: Record<string, string> = {
	// Project-model driven: without an include list the provider enumerates nothing.
	"tsconfig.json": `${JSON.stringify(
		{
			compilerOptions: { module: "esnext", target: "es2022", moduleResolution: "bundler", strict: true },
			include: ["a.ts", "b.ts", "c.ts"],
		},
		null,
		"\t",
	)}\n`,
	// Base for b.ts to extend, ping for the cycle, helper as the move candidate (unused here).
	"a.ts": [
		'import { pong } from "./b";',
		"",
		"export class Base {",
		"\tlabel(): string {",
		'\t\treturn "base";',
		"\t}",
		"}",
		"",
		"export function ping(n: number): number {",
		"\treturn n <= 0 ? 0 : pong(n - 1);",
		"}",
		"",
		"export function helper(): number {",
		"\treturn 1;",
		"}",
		"",
	].join("\n"),
	// Imports and calls a.ts, extends its class; helper sits in its own statement so a move re-points it alone.
	"b.ts": [
		'import { Base, ping } from "./a";',
		'import { helper } from "./a";',
		"",
		"export class Derived extends Base {",
		"\tlabel(): string {",
		'\t\treturn "derived " + helper();',
		"\t}",
		"}",
		"",
		"export function pong(n: number): number {",
		"\treturn ping(n - 1);",
		"}",
		"",
	].join("\n"),
	// The repeated name, and the move target.
	"c.ts": 'export function label(): string {\n\treturn "loose";\n}\n',
};

describe("populated answers parse back to themselves", () => {
	let base: string;
	let derived: string;
	let ping: string;
	let pong: string;
	let helper: string;

	beforeAll(async () => {
		harness = await openWorkspace(TYPESCRIPT_FILES, [TYPESCRIPT], "Add the ping pong pair");
		base = harness.symbol("Base", "a.ts");
		derived = harness.symbol("Derived", "b.ts");
		ping = harness.symbol("ping", "a.ts");
		pong = harness.symbol("pong", "b.ts");
		helper = harness.symbol("helper", "a.ts");
	}, 120_000);

	afterAll(() => harness?.close());

	it("binds references, imports and calls", async () => {
		const references = await ask("findReferences", { symbolId: base, limit: 10 });
		expect(references.references.some((reference) => reference.targetId === base)).toBe(true);

		const imports = await ask("findImports", { specifier: "./a", limit: 10 });
		expect(imports.imports.map((statement) => statement.name).sort()).toEqual(["Base", "helper", "ping"]);
		expect(imports.imports.every((statement) => statement.range !== undefined)).toBe(true);

		const calls = await ask("callHierarchy", { symbolId: ping });
		expect(calls.incoming.find((edge) => edge.symbol.symbolId === pong)?.ranges.length).toBeGreaterThan(0);
		expect(calls.outgoing.some((edge) => edge.symbol.symbolId === pong)).toBe(true);
	}, 60_000);

	it("reads the hierarchy, the hubs, the cycle and a repeated name", async () => {
		expect((await ask("typeHierarchy", { symbolId: base })).subtypes.map((s) => s.symbolId)).toEqual([derived]);
		expect((await ask("typeHierarchy", { symbolId: derived })).supertypes.map((s) => s.symbolId)).toEqual([base]);

		const hubs = await ask("mostReferenced", { limit: 5 });
		expect(hubs.length).toBeGreaterThan(0);
		expect(hubs[0]?.declaration).not.toBeNull();

		const cycles = await ask("cycles", { limit: 5 });
		expect(cycles.some((cycle) => cycle.members.includes(ping) && cycle.members.includes(pong))).toBe(true);

		expect(await ask("findByName", { name: "label" })).toHaveLength(3);
	}, 60_000);

	it("resolves reference and import facts", async () => {
		const reference = answers.findReferences?.references[0]?.factId;
		const statement = answers.findImports?.imports[0]?.factId;
		if (reference === undefined || statement === undefined) throw new Error("the binding case left no facts");

		const outcome = await ask("resolveFacts", { factIds: [reference, statement] });
		expect(outcome.resolved.map((entry) => entry.fact)).toEqual(["reference", "import"]);
		expect(outcome.missing).toEqual([]);
	}, 60_000);

	it("renames and moves across modules", async () => {
		const planned = await ask("renameEdits", { symbolId: ping, newName: "pingAgain" });
		expect(planned.ok).toBe(true);
		if (planned.ok) expect(planned.files.map((file) => file.module).sort()).toEqual(["a.ts", "b.ts"]);

		expect((await ask("refactorStart", {})).started).toBe(true);

		const renamed = await ask("refactorRename", { symbolId: ping, newName: "pingAgain" });
		expect(renamed.renamed).toBe(true);
		expect(renamed.modules).toEqual(expect.arrayContaining(["a.ts", "b.ts"]));

		const moved = await ask("refactorMove", { symbolId: helper, toModule: "c.ts" });
		expect(moved.moved).toBe(true);
		expect(moved.modules).toEqual(expect.arrayContaining(["a.ts", "b.ts", "c.ts"]));

		expect((await ask("refactorCommit", { force: true })).committed).toBe(true);
	}, 60_000);
});
