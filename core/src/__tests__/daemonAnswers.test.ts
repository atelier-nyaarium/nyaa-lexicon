// Every daemon answer, parsed back through the schema that names it.
//
// Dispatch parses each answer through `DAEMON_METHODS[method].response`, and plain `z.object` strips
// what the schema does not name, so a field core emits that the schema forgot never reaches a client
// and nothing fails. The answer is taken here from the handler map, ahead of that parse, and the
// parsed value must deep-equal it: an unnamed field, a missing nullable or a value outside an enum
// fails this file rather than vanishing on the wire.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
	DAEMON_METHODS,
	type DaemonMethod,
	hashContent,
	methodMutates,
	type RequestOf,
	type ResponseOf,
} from "@nyaa-lexicon/protocol";
import { createDispatch, daemonHandlers, gateOf } from "../dispatch";
import { LexiconService } from "../service";
import { sourceReader } from "../sourceRead";
import type { Gate } from "../stepRunners";
import { IndexStore } from "../store";
import { ProviderSupervisor } from "../supervisor";
import { TransactionManager } from "../transactions";
import { BUILD_VERSION } from "../version";

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

const execFileAsync = promisify(execFile);

/** Throws with git's own stderr, so a machine without git fails here rather than answering emptily. */
async function git(cwd: string, ...args: string[]): Promise<void> {
	await execFileAsync(
		"git",
		["-c", "user.name=lexicon", "-c", "user.email=lexicon@example.invalid", "-c", "commit.gpgsign=false", ...args],
		{ cwd },
	);
}

/** A committed workspace, its providers, and one gate and one journal shared by handlers and dispatcher. */
async function openWorkspace(files: Record<string, string>, providers: string[], commit: string): Promise<Harness> {
	const root = mkdtempSync(path.join(tmpdir(), "lexicon-answers-"));
	const workspace = path.join(root, "workspace");
	mkdirSync(workspace);
	for (const [name, text] of Object.entries(files)) writeFileSync(path.join(workspace, name), text);
	await git(workspace, "init", "-q");
	await git(workspace, "add", "-A");
	await git(workspace, "commit", "-q", "-m", commit);

	const store = IndexStore.open(path.join(root, "index.sqlite")).store;
	const supervisor = new ProviderSupervisor();
	await Promise.all(
		providers.map((main) =>
			supervisor.start({ command: [process.execPath, "run", main], timeoutMs: 60_000 }, workspace),
		),
	);
	const service = new LexiconService(store, supervisor, sourceReader(workspace), workspace);
	const refactor = { transactions: new TransactionManager(store, workspace) };
	await service.indexWorkspace();

	return {
		service,
		handlers: daemonHandlers(service, refactor),
		gate: gateOf(service.gate),
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

const AGENT = { kind: "agent", model: "gpt-6-luna", via: "test", run: null } as const;

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
		const refused = await ask("writeNote", { symbolId: ghost, text: "Nothing.", expectedRevision: 0 });
		expect(refused.outcome === "refused" ? refused.reason : refused.outcome).toBe(diagnosis.reason);
	},
	declarationsIn: async () => {
		expect(await ask("declarationsIn", { module: "cart.ref" })).toHaveLength(2);
	},
	typeHierarchy: () => ask("typeHierarchy", { symbolId: cart }),
	callHierarchy: () => ask("callHierarchy", { symbolId: cart }),
	symbolEdges: () => ask("symbolEdges", { symbolId: cart, limit: 5 }),
	findReferences: () => ask("findReferences", { symbolId: cart, limit: 5, within: cart }),
	usesFrom: () => ask("usesFrom", { symbolId: cart, limit: 5 }),
	resolveImport: async () => {
		expect((await ask("resolveImport", { fromModule: "cart.ref", specifier: "./item" })).status).toBe("unresolved");
	},
	indexStatus: async () => {
		expect((await ask("indexStatus", {})).state).toBe("ready");
		await ask("indexStatus", { concerning: "cart.ref" });
	},
	indexWorkspace: async () => {
		expect((await ask("indexWorkspace", {})).state).toBe("ready");
	},
	findLiterals: async () => {
		expect((await ask("findLiterals", { value: "warning" })).total).toBe(2);
		expect((await ask("findLiterals", { kind: "number", min: 1, max: 5, limit: 10 })).literals).toHaveLength(1);
		const hidden = await ask("findLiterals", { value: "warning", exclude: { hide: ["*.json"] } });
		expect(hidden).toMatchObject({ query: { excluded: true }, total: 1 });
	},
	findComments: async () => {
		expect((await ask("findComments", { text: "until checkout", limit: 10 })).total).toBe(1);
		const hidden = await ask("findComments", { text: "until checkout", exclude: { hide: ["cart.ref"] } });
		expect(hidden).toMatchObject({ query: { excluded: true }, total: 0 });
	},
	findDocs: async () => {
		expect((await ask("findDocs", { text: "until checkout" })).total).toBe(1);
		const fenced = await ask("findDocs", { fenced: true, module: "README.md" });
		expect(fenced.docs[0]?.headingPath).toEqual(["Cart", "Checkout"]);
		const hidden = await ask("findDocs", { text: "until checkout", exclude: { hide: ["**/*.MD"] } });
		expect(hidden).toMatchObject({ query: { excluded: true }, total: 0 });
	},
	sharedLiterals: async () => {
		const shared = await ask("sharedLiterals", { minimumFiles: 2, limit: 10 });
		expect(shared).toEqual([expect.objectContaining({ value: "warning", files: 2 })]);
		const kept = await ask("sharedLiterals", { minimumFiles: 2, exclude: { hide: ["ghost/**"] } });
		expect(kept).toEqual([expect.objectContaining({ value: "warning", files: 2, excluded: true })]);
		expect(await ask("sharedLiterals", { minimumFiles: 2, exclude: { hide: ["*.json"] } })).toEqual([]);
	},
	cycles: () => ask("cycles", { limit: 5 }),
	mostReferenced: () => ask("mostReferenced", { limit: 5 }),
	hubs: () => ask("hubs", { limit: 5 }),
	cacheStats: () => ask("cacheStats", {}),
	searchSymbols: async () => {
		expect((await ask("searchSymbols", { text: "Cart" })).symbols.length).toBeGreaterThan(1);
		const exact = await ask("searchSymbols", { regex: "/^add$/", kind: "function", module: "cart.ref", limit: 5 });
		expect(exact.total).toBe(1);
		const hidden = await ask("searchSymbols", { text: "Cart", exclude: { hide: ["README.md"] } });
		expect(hidden.excluded).toBe(true);
		expect(hidden.symbols.map((symbol) => symbol.module)).toEqual(["cart.ref"]);
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
	admittedModules: async () => {
		expect(await ask("admittedModules", { modules: ["cart.ref", "notes.txt", "ghost.ref"] })).toEqual([
			{ module: "cart.ref", admitted: "discovered" },
			{ module: "notes.txt", admitted: "discovered" },
			{ module: "ghost.ref", admitted: null },
		]);
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
	moduleFacts: async () => {
		const known = await ask("moduleFacts", { module: "cart.ref" });
		if (!known.known) throw new Error("cart.ref should be known");
		expect(known.depth).toBe("full");
		expect(known.declarations.map((declaration) => declaration.kind)).toEqual(["class", "function"]);
		expect(known.references).toEqual([]);
		expect(known.literals).toEqual([]);
		expect(known.comments).toHaveLength(2);
		expect(known.words).toEqual({ keywords: ["class", "const", "export", "function"], builtins: [], literals: [] });
		const declared = await ask("moduleDeclarations", { module: "cart.ref" });
		expect(known.contentHash).toBe(declared.contentHash);

		expect(await ask("moduleFacts", { module: "ghost.ref" })).toEqual({
			module: "ghost.ref",
			known: false,
			reason: "notIndexed",
		});
	},
	parseFacts: async () => {
		const text = "export class Cart {}\nexport class Basket {}\n";
		const parsed = await ask("parseFacts", { module: "cart.ref", text });
		if (!parsed.ok) throw new Error(parsed.reason);
		expect(parsed.depth).toBe("full");
		expect(parsed.declarations.map((declaration) => declaration.kind)).toEqual(["class", "class"]);
		expect(parsed.contentHash).toBe(hashContent(text));

		// Nothing was written: the store still answers the rows it held before the candidate.
		const stillOld = await ask("moduleDeclarations", { module: "cart.ref" });
		expect(stillOld.declarations.map((declaration) => declaration.name)).toEqual(["Cart", "add"]);

		const refused = await ask("parseFacts", { module: "notes.txt", text: "hi" });
		expect(refused.ok).toBe(false);
	},
	previewImport: async () => {
		const asked = (module: string) =>
			ask("previewImport", { module, text: "use(ITEM_LIMIT)\n", name: "ITEM_LIMIT", fromModule: "item.ref" });
		// The fixture's provider writes no imports, and no provider owns notes.txt.
		expect({ declined: await asked("cart.ref"), unowned: await asked("notes.txt") }).toMatchObject({
			declined: { status: "refused", reason: "NotImplemented" },
			unowned: { status: "refused", reason: "NotImplemented" },
		});
	},
	symbolAt: async () => {
		const text = "export class Basket {}\n";
		expect({
			stored: await ask("symbolAt", { module: "cart.ref", position: { line: 1, character: 14 } }),
			handed: await ask("symbolAt", { module: "cart.ref", position: { line: 0, character: 15 }, text }),
			between: await ask("symbolAt", { module: "cart.ref", position: { line: 2, character: 0 } }),
			ghost: await ask("symbolAt", { module: "ghost.ref", position: { line: 0, character: 0 } }),
			unowned: await ask("symbolAt", { module: "notes.txt", position: { line: 0, character: 0 }, text: "hi" }),
		}).toMatchObject({
			stored: { found: true, symbolId: cart, via: "declaration" },
			handed: { found: true, via: "declaration", contentHash: hashContent(text) },
			between: { found: false, reason: "noSymbol" },
			ghost: { found: false, reason: "notIndexed" },
			unowned: { found: false, reason: "unowned" },
		});
	},
	findImports: async () => {
		await ask("findImports", { specifier: "./item", limit: 5 });
		const hidden = await ask("findImports", { specifier: "./item", exclude: { hide: ["cart.ref"] } });
		expect(hidden).toMatchObject({ excluded: true, imports: [] });
	},
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
	scopeSymbols: async () => {
		const file = await ask("scopeSymbols", { module: "cart.ref" });
		expect(file?.symbols.map((entry) => entry.symbol.name)).toEqual(["Cart", "add"]);
		const one = await ask("scopeSymbols", { symbolId: cart, members: true });
		expect(one?.symbols.map((entry) => entry.symbol.name)).toEqual(["Cart"]);
		expect(await ask("scopeSymbols", { symbolId: `${cart}Gone#` })).toBeNull();
	},
	typeOf: async () => {
		expect((await ask("typeOf", { symbolId: cart })).status).toBe("unknown");
	},
	prepareRename: async () => {
		expect((await ask("prepareRename", { symbolId: cart, newName: "Basket" })).oldName).toBe("Cart");
	},
	renameEdits: async () => {
		const planned = await ask("renameEdits", { symbolId: cart, newName: "Basket" });
		if (planned.ok) expect(planned.files.every((file) => file.contentHash.length > 0)).toBe(true);
	},
	planMove: async () => {
		expect((await ask("planMove", { symbolId: cart, toModule: "item.ref" })).ok).toBe(true);
	},
	previewMove: async () => {
		const preview = await ask("previewMove", { symbolId: cart, toModule: "item.ref" });
		expect(Array.isArray(preview.blockers)).toBe(true);
	},
	previewArrange: async () => {
		const preview = await ask("previewArrange", { toModule: "item.ref", placements: [{ symbolId: cart }] });
		// The reference provider refuses arrange edits.
		expect(preview.ok).toBe(false);
	},
	previewInsert: async () => {
		expect((await ask("previewInsert", { module: "item.ref", text: "export const PREVIEW_STEP = 1" })).state).toBe(
			"planned",
		);
	},
	previewReplace: async () => {
		const { contentHash } = await ask("moduleDeclarations", { module: "item.ref" });
		const text = "export const ITEM_LIMIT = 4\n";
		expect({
			planned: await ask("previewReplace", { module: "item.ref", contentHash: contentHash ?? "none", text }),
			stale: await ask("previewReplace", { module: "item.ref", contentHash: "elsewhere", text }),
			written: (await ask("moduleDeclarations", { module: "item.ref" })).contentHash,
		}).toMatchObject({
			// The fixture's provider reports no syntax errors.
			planned: { state: "planned", module: "item.ref", contentHash, issues: [{ kind: "SyntaxUnchecked" }] },
			stale: { state: "refused", stale: true },
			written: contentHash,
		});
	},
	indexFile: async () => {
		const before = (await ask("indexStatus", {})).generation;
		const answer = await ask("indexFile", { module: "cart.ref" });
		// An unchanged file keeps every client's cached facts.
		expect({ cause: answer.cause, generation: (await ask("indexStatus", {})).generation }).toEqual({
			cause: "current",
			generation: before,
		});
	},
	symbolSource: async () => {
		expect((await ask("symbolSource", { symbolId: cart })).found).toBe(true);
		expect((await ask("symbolSource", { symbolId: cart.replace("Cart", "Ghost") })).found).toBe(false);
	},

	writeNote: async () => {
		const note = {
			symbolId: harness.symbol("add", "cart.ref"),
			text: "Adds one item to a [Cart](ref://cart.ref:Cart).",
			expectedRevision: 0,
			author: AGENT,
		};
		const broken = await ask("writeNote", { ...note, text: "Adds to a [cart](ref://cart.ref:Ghost)." });
		expect(broken.outcome === "refused" && broken.refs?.[0]?.candidates).toContain("ref://cart.ref:Cart");
		const saved = await ask("writeNote", note);
		expect(saved.outcome === "saved" && saved.note).toMatchObject({
			revision: 1,
			text: note.text,
			links: [{ state: "ok", symbolId: cart }],
		});
	},
	readNote: async () => {
		expect(await ask("readNote", { symbolId: harness.symbol("add", "cart.ref") })).toMatchObject({ revision: 1 });
		expect(await ask("readNote", { symbolId: cart })).toBeNull();
	},
	doubtNote: async () => {
		const symbolId = harness.symbol("add", "cart.ref");
		const outcome = await ask("doubtNote", { symbolId, reason: "it adds two", expectedRevision: 1 });
		expect(outcome.outcome === "saved" && outcome.note?.doubt?.reason).toBe("it adds two");
	},
	confirmNote: async () => {
		const symbolId = harness.symbol("add", "cart.ref");
		const outcome = await ask("confirmNote", { symbolId, expectedRevision: 1, author: { kind: "person" } });
		expect(outcome.outcome === "saved" && outcome.note).toMatchObject({
			doubt: null,
			confirmedBy: { kind: "person" },
		});
	},
	resolveNoteProposal: async () => {
		const symbolId = harness.symbol("add", "cart.ref");
		const proposed = await ask("writeNote", {
			symbolId,
			text: "Adds one item.",
			expectedRevision: 1,
			author: AGENT,
		});
		expect(proposed.outcome).toBe("proposed");
		const expectedProposal = proposed.outcome === "proposed" ? (proposed.note.proposal?.at ?? -1) : -1;
		const accepted = await ask("resolveNoteProposal", {
			symbolId,
			accept: true,
			expectedRevision: 1,
			expectedProposal,
		});
		expect(accepted.outcome === "saved" && accepted.note).toMatchObject({ revision: 2, text: "Adds one item." });
	},
	searchRefs: async () => {
		const found = await ask("searchRefs", { text: "car", limit: 10 });
		expect(found.results.map((entry) => entry.ref)).toEqual(
			expect.arrayContaining(["ref://cart.ref:Cart", "ref://cart.ref"]),
		);
		expect((await ask("searchRefs", { text: " " })).results).toEqual([]);
	},
	noteBacklinks: async () => {
		const symbolId = harness.symbol("add", "cart.ref");
		const text = "Fills a [Cart](ref://cart.ref:Cart).";
		await ask("writeNote", { symbolId, text, expectedRevision: 2, author: { kind: "person" } });
		const backlinks = await ask("noteBacklinks", { symbolId: cart });
		expect(backlinks.notes.map((entry) => entry.symbolId)).toEqual([symbolId]);
	},

	// Relations: nothing binds in the fixture, so history and the shared file carry the evidence.
	relationsOf: async () => {
		const related = await ask("relationsOf", { symbolId: cart, limit: 5 });
		expect(related.relations.map((relation) => [relation.symbol?.name, relation.kind])).toContainEqual([
			"ITEM_LIMIT",
			"changedTogether",
		]);
		expect(related.unavailable).toEqual([]);
		await ask("relationsOf", { symbolId: cart, kinds: ["sameFile"], intent: "adopt", withDoubted: true });
	},
	relationsBetween: async () => {
		const add = harness.symbol("add", "cart.ref");
		expect((await ask("relationsBetween", { symbolId: cart, otherId: add })).relation?.evidence.sameModule).toBe(
			true,
		);
		const itself = await ask("relationsBetween", { symbolId: cart, otherId: cart });
		expect(itself.relation).toBeNull();
	},
	writeRelation: async () => {
		const pair = { symbolId: cart, otherId: harness.symbol("add", "cart.ref") };
		const proposed = await ask("writeRelation", {
			...pair,
			action: "state",
			why: "add fills a cart",
			expectedRevision: 0,
			author: AGENT,
		});
		expect(proposed.outcome).toBe("proposed");
		const confirmed = await ask("writeRelation", {
			...pair,
			action: "confirm",
			expectedRevision: 1,
			author: { kind: "person" },
		});
		expect(confirmed.outcome === "saved" && confirmed.relation?.stated).toMatchObject({
			provenance: "agent",
			status: "confirmed",
			revision: 2,
		});
		const kept = await ask("writeRelation", {
			...pair,
			action: "state",
			why: "add empties a cart",
			expectedRevision: 2,
			author: AGENT,
		});
		expect(kept.outcome).toBe("kept");
		const stale = await ask("writeRelation", {
			...pair,
			action: "remove",
			expectedRevision: 1,
			author: { kind: "person" },
		});
		expect(stale.outcome === "refused" && stale.current?.stated?.revision).toBe(2);
	},
	relationFeedback: async () => {
		const pairs = [{ symbolId: cart, otherId: harness.symbol("add", "cart.ref") }];
		expect(await ask("relationFeedback", { pairs, intent: "adopt", outcome: "accepted" })).toEqual({ recorded: 1 });
	},
	relationCandidates: async () => {
		expect(await ask("relationCandidates", { module: "item.ref", limit: 5 })).toEqual({
			candidates: [],
			unavailable: [],
		});
		await ask("relationCandidates", { symbolId: cart, intent: "adopt" });
	},
	relationGaps: async () => {
		expect(await ask("relationGaps", { limit: 2 })).toEqual({ gaps: [], total: 0 });
	},
	answerRelationGap: async () => {
		const related = [{ symbolId: harness.symbol("ITEM_LIMIT", "item.ref"), why: "a cart holds at most this many" }];
		const answer = await ask("answerRelationGap", { symbolId: cart, related, author: AGENT });
		expect(answer).toEqual({ proposed: 1, kept: 0, refused: [] });
	},

	// Refactoring, in the order the plan runs it; the three steps this provider cannot do refuse.
	refactorStart: async () => {
		expect((await ask("refactorStart", {})).started).toBe(true);
	},
	refactorStatus: async () => {
		expect((await ask("refactorStatus", {})).open).toBe(true);
	},
	refactorTrack: async () => {
		expect(await ask("refactorTrack", { module: "cart.ref" })).toMatchObject({
			tracked: true,
			refactor: { id: answers.refactorStart?.id as string },
			ledger: { latest: expect.any(Number) },
		});
	},
	refactorNoteWrite: async () => {
		const image = await ask("refactorBeforeImage", { module: "cart.ref" });
		if (!image.tracked || !image.existed) throw new Error("before image has no file hash");
		expect(await ask("refactorNoteWrite", { module: "cart.ref", contentHash: image.contentHash })).toEqual({
			noted: true,
		});
	},
	refactorBeforeImage: async () => {
		expect(await ask("refactorBeforeImage", { module: "cart.ref" })).toMatchObject({
			tracked: true,
			existed: true,
			encoding: "text",
		});
	},
	refactorReplace: async () => {
		const outcome = await ask("refactorReplace", { symbolId: cart, newText: "export class Cart extends Bag" });
		expect(outcome.replaced).toBe(true);
	},
	refactorReplaceSpan: async () => {
		const seen = await ask("symbolSource", { symbolId: cart });
		if (!seen.found || seen.spanHash === undefined) throw new Error("symbolSource answered no span hash");
		const request = { symbolId: cart, newText: seen.text };
		expect(await ask("refactorReplaceSpan", { ...request, expectedSpanHash: "0".repeat(32) })).toMatchObject({
			replaced: false,
			stale: true,
		});
		expect(await ask("refactorReplaceSpan", { ...request, expectedSpanHash: seen.spanHash })).toMatchObject({
			replaced: true,
			transaction: "joined",
		});
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
	refactorArrange: async () => {
		const request = { toModule: "item.ref", placements: [{ symbolId: cart }] };
		const expected = [{ module: "item.ref", base: null, result: "0".repeat(32) }];
		expect((await ask("refactorArrange", { ...request, expect: expected })).moved).toBe(false);
	},
	// A refactor is open here.
	refactorRenameCommitted: async () => {
		const bases = [{ module: "cart.ref", contentHash: null }];
		expect(await ask("refactorRenameCommitted", { symbolId: cart, newName: "Basket", bases })).toMatchObject({
			committed: false,
			openRefactor: { id: answers.refactorStart?.id },
		});
	},
	refactorMoveCommitted: async () => {
		const bases = [{ module: "cart.ref", contentHash: null }];
		expect(await ask("refactorMoveCommitted", { symbolId: cart, toModule: "item.ref", bases })).toMatchObject({
			committed: false,
			openRefactor: { id: answers.refactorStart?.id },
		});
	},
	refactorStepOutcome: async () => {
		const bases = [{ module: "cart.ref", contentHash: null }];
		const named = { symbolId: cart, newName: "Basket", bases, stepId: "sample-step" };
		const first = await ask("refactorRenameCommitted", named);
		expect(await ask("refactorStepOutcome", { stepId: "sample-step" })).toEqual({
			status: "answered",
			answer: first,
		});
		// A retry under the same id is answered, never run again.
		expect(await ask("refactorRenameCommitted", named)).toEqual(first);
		expect(await ask("refactorStepOutcome", { stepId: "never-named" })).toEqual({ status: "unknown" });
	},
	refactorStepCancel: async () => {
		expect(await ask("refactorStepCancel", { stepId: "sample-step" })).toMatchObject({
			cancelled: false,
			outcome: { status: "answered" },
		});
	},
	refactorRevert: async () => {
		const status = await ask("refactorStatus", {});
		expect(
			await ask("refactorRevert", {
				drifted: status.drifted,
				...(status.id === undefined || status.revision === undefined
					? {}
					: { expect: { id: status.id, revision: status.revision } }),
			}),
		).toMatchObject({ reverted: true, modules: ["cart.ref", "item.ref"] });
	},
	refactorCommit: async () => {
		// Reverting closed the transaction, so the plan's order ends on the refusal shape.
		expect((await ask("refactorCommit", {})).committed).toBe(false);
		// A fresh transaction with one step carries an issue this provider cannot check, so force.
		await ask("refactorStart", {});
		await ask("refactorInsert", { module: "item.ref", text: "export const ITEM_STEP = 1" });
		expect((await ask("refactorCommit", { force: true })).committed).toBe(true);
	},
	refactorSettlements: async () => {
		const answer = await ask("refactorSettlements", { after: 0 });
		const last = answer.settlements.at(-1);
		expect(last).toMatchObject({ origin: "explicit", outcome: "committed", files: [{ module: "item.ref" }] });
		expect(answer.ledger.latest).toBe(last?.seq as number);
	},
	refactorSettledImage: async () => {
		const seq = answers.refactorSettlements?.ledger.latest as number;
		const settled = await ask("refactorSettledImage", { seq, module: "item.ref", side: "settled" });
		expect(settled.held && "text" in settled ? settled.text : "").toContain("ITEM_STEP");
		expect(await ask("refactorSettledImage", { seq, module: "cart.ref", side: "opened" })).toEqual({ held: false });
	},
	refactorWriteFile: async () => {
		const content = { encoding: "text" as const, text: "written\n" };
		const created = await ask("refactorWriteFile", { module: "written.ref", content, expect: null });
		expect(created).toMatchObject({ written: true, refactor: null, indexed: true });
		expect(await ask("refactorWriteFile", { module: "written.ref", content, expect: null })).toMatchObject({
			written: false,
			refused: "changed",
		});
		const holds = created.written ? created.contentHash : null;
		const deleted = await ask("refactorWriteFile", { module: "written.ref", content: null, expect: holds });
		expect(deleted).toMatchObject({ written: true, contentHash: null });
	},
};

/** Each later answer depends on an earlier one, so these never run as independent cases. */
const KNOWLEDGE = [
	"writeNote",
	"readNote",
	"doubtNote",
	"confirmNote",
	"resolveNoteProposal",
	"noteBacklinks",
	"relationsOf",
	"relationsBetween",
	"writeRelation",
	"relationFeedback",
	"relationCandidates",
	"relationGaps",
	"answerRelationGap",
] as const satisfies readonly DaemonMethod[];

const REFACTOR = [
	"refactorStart",
	"refactorStatus",
	"refactorTrack",
	"refactorNoteWrite",
	"refactorBeforeImage",
	"refactorReplace",
	"refactorReplaceSpan",
	"refactorUndo",
	"previewInsert",
	"refactorInsert",
	"refactorRename",
	"refactorMove",
	"refactorArrange",
	"refactorRenameCommitted",
	"refactorMoveCommitted",
	"refactorStepOutcome",
	"refactorStepCancel",
	"refactorRevert",
	"refactorCommit",
	"refactorSettlements",
	"refactorSettledImage",
	"refactorWriteFile",
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

	// Read-only access and lost-connection retries trust `mutates`.
	it("marks every method whose handler writes, and none whose handler only reads", () => {
		const methods = Object.keys(DAEMON_METHODS) as DaemonMethod[];
		expect({
			writesUnmarked: methods.filter(
				(method) => harness.handlers[method].effect === "write" && !methodMutates(method),
			),
			readsMarked: methods.filter(
				(method) => harness.handlers[method].effect === "read" && methodMutates(method),
			),
		}).toEqual({ writesUnmarked: [], readsMarked: [] });
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

describe("the scopeSymbols request schema", () => {
	it("refuses both symbolId and module together, and refuses neither", () => {
		expect(DAEMON_METHODS.scopeSymbols.request.safeParse({ symbolId: "a", module: "a.ts" }).success).toBe(false);
		expect(DAEMON_METHODS.scopeSymbols.request.safeParse({}).success).toBe(false);
		expect(DAEMON_METHODS.scopeSymbols.request.safeParse({ symbolId: "a" }).success).toBe(true);
		expect(DAEMON_METHODS.scopeSymbols.request.safeParse({ module: "a.ts" }).success).toBe(true);
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

		const edges = await ask("symbolEdges", { symbolId: ping });
		const peersIn = (groups: typeof edges.incoming.groups) =>
			groups.find((group) => group.role === "call")?.peers.map((peer) => peer.symbol?.symbolId);
		expect({ callers: peersIn(edges.incoming.groups), callees: peersIn(edges.outgoing.groups) }).toEqual({
			callers: expect.arrayContaining([pong]),
			callees: expect.arrayContaining([pong]),
		});
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

	it("commits a rename and a move as refactors of their own", async () => {
		const planned = await ask("renameEdits", { symbolId: pong, newName: "pongAgain" });
		if (!planned.ok) throw new Error(planned.reason);
		const renamed = await ask("refactorRenameCommitted", {
			symbolId: pong,
			newName: "pongAgain",
			bases: planned.files.map((file) => ({ module: file.module, contentHash: file.contentHash })),
		});
		expect(renamed).toMatchObject({ committed: true, kind: "rename", reverse: { newName: "pong" } });

		// Wherever the case above left it.
		const from = harness.service.findByName("helper")[0]?.module ?? "a.ts";
		const toModule = from === "a.ts" ? "c.ts" : "a.ts";
		const moving = harness.symbol("helper", from);
		const preview = await ask("previewMove", { symbolId: moving, toModule });
		if (!preview.ok) throw new Error(preview.reason);
		const moved = await ask("refactorMoveCommitted", {
			symbolId: moving,
			toModule,
			bases: preview.files.map((file) => ({ module: file.module, contentHash: file.contentHash })),
		});
		expect(moved).toMatchObject({ committed: true, kind: "move", reverse: { toModule: from } });
		expect((await ask("refactorStatus", {})).open).toBe(false);
	}, 60_000);
});
