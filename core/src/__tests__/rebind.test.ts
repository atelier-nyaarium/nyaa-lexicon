import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	type Binding,
	type Declaration,
	hashContent,
	type Range,
	type ScopeContribution,
} from "@nyaa-lexicon/protocol";
import type { Clock } from "../clock";
import { type IndexOutcome, REBIND_CAP, RESOLVE_RETRY_MS } from "../indexer";
import type { MethodRequest, MethodResponse } from "../providerPort";
import { journaledStep } from "../refactorStep";
import type { ProviderClaims } from "../routing";
import { LexiconService } from "../service";
import { sourceReader } from "../sourceRead";
import { IndexStore } from "../store";
import { ProviderUnavailableError } from "../supervisor";
import { TransactionManager } from "../transactions";
import { fakeClock } from "./fakeClock";
import { fakeImports, fakeReExports, fakeUses } from "./fakeGrammar";
import { fakeSupervisor, parseClasses, parseFake, rangesOf, resolveFake } from "./fakeProvider";
import { gitInit } from "./gitFixture";
import { direct, forward, landed } from "./importEdges";

////////////////////////////////
//  Helpers

let root: string;
let store: IndexStore;
let service: LexiconService;

const claims: ProviderClaims = { providerId: "fake", language: "fake", extensions: [".fake"] };
const dataClaims: ProviderClaims = {
	providerId: "fakedata",
	language: "fakedata",
	extensions: [".fdata"],
	content: "data",
};
/** Claims `.fakeh` only where a `.fake` exists, the way a C++ provider claims `.h`. */
const headerClaims: ProviderClaims = {
	providerId: "fakeheader",
	language: "fake",
	extensions: [],
	sharedExtensions: [{ extension: ".fakeh", beside: [".fake"] }],
};
const plainHeaderClaims: ProviderClaims = { providerId: "fakeplain", language: "fake", extensions: [".fakeh"] };

function put(module: string, text: string): void {
	const full = path.join(root, module);
	mkdirSync(path.dirname(full), { recursive: true });
	writeFileSync(full, text);
}

/** Each `use Name`, as a use of that name. */
function usesIn(text: string): Array<{ name: string; range: Range }> {
	const rangeOf = rangesOf(text);
	return fakeUses(text).map(({ name, start, end }) => ({ name, range: rangeOf(start, end) }));
}

/** Each `reexport Name from "specifier"`. */
function reExportsIn(text: string): Array<{ name: string; specifier: string; range: Range }> {
	const rangeOf = rangesOf(text);
	return fakeReExports(text).map(({ name, specifier, start, end }) => ({
		name,
		specifier,
		range: rangeOf(start, end),
	}));
}

/** Where a relative specifier written in `from` lands. */
const joined = (from: string, specifier: string) =>
	path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));

/** The bytes on disk, or nothing for a file that is gone. */
function onDisk(module: string): string {
	try {
		return readFileSync(path.join(root, module), "utf8");
	} catch {
		return "";
	}
}

/** Lands `lib` on x.fake once new.fake exists, else on old.fake. */
function turningOver(from: string, specifier: string): string {
	if (specifier !== "lib") return joined(from, specifier);
	return onDisk("new.fake") === "" ? "old.fake" : "x.fake";
}

/** Lands `lib` on old.fake while that file exists, else on new.fake. */
function fallingBack(from: string, specifier: string): string {
	if (specifier !== "lib") return joined(from, specifier);
	return onDisk("old.fake") === "" ? "new.fake" : "old.fake";
}

interface BindingOptions {
	running?: ProviderClaims[];
	/** What a provider reads a file to declare; `providerId` is the one answering. */
	declares?: (request: MethodRequest<"parseFile">, providerId: string) => Declaration[];
	/** Parses that find the provider gone. */
	down?: (request: MethodRequest<"parseFile">) => boolean;
	/** Modules whose parse the provider refuses. */
	refusing?: ReadonlySet<string>;
	/** Where a specifier lands, when not the default join. */
	resolves?: (
		request: MethodRequest<"resolveImport">,
	) => MethodResponse<"resolveImport"> | Promise<MethodResponse<"resolveImport">>;
	/** Where a specifier lands for resolution and binding alike, when not the default join. */
	lands?: (from: string, specifier: string) => string;
	/** Whether resolving a specifier finds the provider gone. */
	unresolvable?: () => boolean;
	/** Runs once a parse has bound, before the provider answers it. */
	afterParse?: (module: string) => void;
	/** Which spawn of the provider answers; a test advances it to restart the provider. */
	incarnation?: { current: number };
	/** Filled in with a respawn that restarts the provider and says so. */
	respawns?: { respawn?: (providerId: string) => void };
	clock?: Clock;
	/** The index it writes, when not the test's own. */
	over?: IndexStore;
	/** The scopes each module contributes to. */
	scopes?: (module: string) => ScopeContribution[];
}

/**
 * A provider binding each `use Name` to a module an import reaches that declares it, or through a
 * `reexport` one holds, else to whichever file on disk declares the name, as a namespace-wide
 * language binds: one declaration binds, two leave
 * the use ambiguous. A file it parsed reads as that parse said; one it never parsed, as the disk
 * does. An outline binds nothing.
 */
function bindingService(parses: string[] = [], options: BindingOptions = {}): LexiconService {
	const {
		running = [claims],
		declares = (request) => parseFake(request).declarations,
		down,
		refusing,
		resolves,
		lands,
		unresolvable,
		afterParse,
		incarnation,
		respawns,
		clock,
		over = store,
		scopes,
	} = options;
	const declared = new Map<string, Declaration[]>();
	const reExported = new Map<string, Array<{ name: string; specifier: string }>>();
	const heldBy = (module: string) => declared.get(module) ?? parseClasses(module, onDisk(module));
	const reExportsOf = (module: string) => reExported.get(module) ?? reExportsIn(onDisk(module));
	const landing = lands ?? joined;
	const bindingOf = (name: string, from: string, text: string): Binding => {
		for (const { specifier } of fakeImports(text)) {
			const via = landing(from, specifier);
			const declared = heldBy(via).find((found) => found.name === name);
			if (declared !== undefined) return { status: "bound", symbolId: declared.symbolId, provenance: "bound" };
			const entry = reExportsOf(via).find((found) => found.name === name);
			const target = entry === undefined ? undefined : landing(via, entry.specifier);
			if (target !== undefined && heldBy(target).some((found) => found.name === name)) {
				return { status: "bound", symbolId: `lexicon fake ${target} ${name}#`, provenance: "bound" };
			}
		}
		const files = readdirSync(root, { recursive: true, encoding: "utf8" }).filter((file) => file.includes(".fake"));
		const owners = files.flatMap((module) =>
			heldBy(module)
				.filter((found) => found.name === name)
				.map((found) => found.symbolId),
		);
		const [only] = owners;
		if (only === undefined) return { status: "unbound", reason: "NotIndexed" };
		if (owners.length === 1) return { status: "bound", symbolId: only, provenance: "bound" };
		return { status: "ambiguous", candidates: owners, provenance: "bound" };
	};
	const port = fakeSupervisor({
		claims: running,
		...(incarnation === undefined ? {} : { incarnation }),
		...(respawns === undefined ? {} : { respawns }),
		answers: {
			resolveImport: (request) => {
				if (unresolvable?.() === true) throw new ProviderUnavailableError("provider is gone");
				if (resolves !== undefined) return resolves(request);
				if (lands === undefined) return resolveFake(request);
				return landed(lands(request.fromModule, request.specifier));
			},
			parseFile: (request, providerId) => {
				if (down?.(request) === true) throw new ProviderUnavailableError("provider is gone");
				parses.push(request.module);
				const reExports = reExportsIn(request.text);
				const parsed = parseFake(request);
				const declarations = declares(request, providerId);
				const forwards = reExports.map(({ name, specifier, range }, at) =>
					forward(specifier, name, range, parsed.imports.length + at),
				);
				const facts = {
					...parsed,
					declarations,
					imports: [...parsed.imports, ...forwards.flatMap((each) => each.imports)],
					// Stated exports replace the declarations' own flags, so each exported class states one.
					exports: [
						...declarations.filter((each) => each.exported === true).map((each) => direct(each)),
						...forwards.flatMap((each) => each.exports),
					],
					scopeContributions: scopes?.(request.module) ?? [],
				};
				if (refusing?.has(request.module) === true) {
					return { ...facts, diagnostics: [{ severity: "error" as const, message: "refused" }] };
				}
				declared.set(request.module, facts.declarations);
				reExported.set(request.module, reExports);
				if (request.depth === "outline") return facts;
				const references = usesIn(request.text).map(({ name, range }) => ({
					name,
					range,
					role: "read" as const,
					binding: bindingOf(name, request.module, request.text),
				}));
				afterParse?.(request.module);
				return { ...facts, references };
			},
		},
	});
	return new LexiconService(over, port, sourceReader(root), root, clock);
}

/** Waits for background work to reach `done`, starting none itself. */
async function eventually(done: () => boolean): Promise<boolean> {
	for (let tries = 0; tries < 200 && !done(); tries++) await Bun.sleep(5);
	return done();
}

const targetOf = (module: string, from = store) => from.referencesIn(module)[0]?.targetId;

/** What a batch parsed itself, not what the pump paid meanwhile. */
const parsedIn = (outcomes: readonly IndexOutcome[]) =>
	outcomes
		.filter((outcome) => outcome.action === "indexed")
		.map((outcome) => outcome.module)
		.sort();

/** Outlines that leave out every `Late*` class, as a provider whose outline skips members does. */
const lateInFull = (request: MethodRequest<"parseFile">) =>
	parseFake(request).declarations.filter((found) => request.depth !== "outline" || !found.name.startsWith("Late"));

beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), "lexicon-rebind-"));
	store = IndexStore.open(path.join(root, "index.sqlite")).store;
});

afterEach(async () => {
	// The pump may still be paying debt a test left owed; one over a store a test closed ends faulted.
	await service?.upgradeRemaining().catch(() => {});
	store.close();
	rmSync(root, { recursive: true, force: true });
});

////////////////////////////////
//  Tests

describe("a batch that moves a module's surface", () => {
	// The importer's own bytes never change, so only the module it binds against can say it owes a parse.
	it("parses again whoever imports or binds into a moved surface, leaves an unresolved use to the pump, and parses nobody for a body edit", async () => {
		await gitInit(root);
		put("x.fake", "export class Base {}\n");
		put("importer.fake", 'import "./x.fake";\nuse Foo\n');
		put("loose.fake", "use Foo\n");
		put("plain.fake", 'import "./x.fake";\n');
		put("bystander.fake", "export class Other {}\n");
		const parses: string[] = [];
		service = bindingService(parses);
		await service.indexWorkspace();
		const edit = async (text: string) => {
			put("x.fake", text);
			const outcomes = await service.applyBatch([{ kind: "changed", module: "x.fake", contentHash: text }]);
			const batch = parsedIn(outcomes);
			await service.upgradeRemaining();
			return { batch, importer: targetOf("importer.fake"), loose: targetOf("loose.fake") };
		};
		const foo = "lexicon fake x.fake Foo#";

		const unbound = { importer: targetOf("importer.fake"), loose: targetOf("loose.fake") };
		const gained = await edit("export class Base {}\nexport class Foo {}\n");
		const body = await edit("export class Base { edited }\nexport class Foo {}\n");
		const lost = await edit("export class Base { edited }\n");

		expect({ unbound, gained, body, lost }).toEqual({
			unbound: { importer: null, loose: null },
			gained: { batch: ["importer.fake", "plain.fake", "x.fake"], importer: foo, loose: foo },
			body: { batch: ["x.fake"], importer: foo, loose: foo },
			// Bound into what x.fake lost, so the batch parses it.
			lost: { batch: ["importer.fake", "loose.fake", "plain.fake", "x.fake"], importer: null, loose: null },
		});
	});

	// An ambiguous use binds to nothing, so only the names a module lost can find it.
	it("rebinds a use left ambiguous once a module loses, or its file deletes, a name it shared", async () => {
		await gitInit(root);
		put("x.fake", "export class Foo {}\n");
		put("y.fake", "export class Foo {}\n");
		put("z.fake", "export class Foo {}\n");
		put("user.fake", "use Foo\n");
		const parses: string[] = [];
		service = bindingService(parses);
		// The second scan reads each module against what the first saw every module declare.
		await service.indexWorkspace();
		await service.indexWorkspace();
		const ambiguous = targetOf("user.fake");

		parses.length = 0;
		put("z.fake", "export class Other {}\n");
		const batch = parsedIn(await service.applyBatch([{ kind: "changed", module: "z.fake", contentHash: "z-2" }]));
		await service.upgradeRemaining();
		const paid = parses.filter((module) => !batch.includes(module));
		rmSync(path.join(root, "y.fake"));
		await service.applyBatch([{ kind: "deleted", module: "y.fake" }]);
		await service.upgradeRemaining();

		expect({ ambiguous, batch, paid, deleted: targetOf("user.fake") }).toEqual({
			ambiguous: null,
			batch: ["z.fake"],
			paid: ["user.fake"],
			deleted: "lexicon fake x.fake Foo#",
		});
	});

	// A widely imported module can have more importers than one batch should hold the gate for.
	it("parses at most REBIND_CAP dependents in the batch and leaves the rest to the background pump", async () => {
		await gitInit(root);
		put("x.fake", "export class Base {}\n");
		const users = Array.from({ length: REBIND_CAP + 6 }, (_, at) => `user${at}.fake`);
		for (const user of users) put(user, 'import "./x.fake";\nuse Foo\n');
		service = bindingService();
		await service.indexWorkspace();

		put("x.fake", "export class Base {}\nexport class Foo {}\n");
		const outcomes = await service.applyBatch([{ kind: "changed", module: "x.fake", contentHash: "x-2" }]);
		const inBatch = outcomes.filter((outcome) => users.includes(outcome.module) && outcome.action === "indexed");
		await service.upgradeRemaining();
		const bound = users.filter((user) => targetOf(user) === "lexicon fake x.fake Foo#");

		expect({ inBatch: inBatch.length, bound: bound.length }).toEqual({ inBatch: REBIND_CAP, bound: users.length });
	});

	// The new owner's parse cannot see what the old owner's rows held once they are dropped.
	it("unbinds the users of a header whose new owner declares nothing there", async () => {
		await gitInit(root);
		put("e.fakeh", "export class Foo {}\n");
		// Not a `.fake`, so only `e.fake` arriving shares the header's claim.
		put("user.fdata", "use Foo\n");
		service = bindingService([], {
			running: [claims, dataClaims, headerClaims, plainHeaderClaims],
			declares: (request, providerId) => (providerId === "fakeheader" ? [] : parseFake(request).declarations),
		});
		await service.indexWorkspace();
		await service.indexWorkspace();
		const plain = targetOf("user.fdata");

		put("e.fake", "export class Source {}\n");
		await service.applyBatch([{ kind: "changed", module: "e.fake", contentHash: "e-1" }]);

		expect({ plain, shared: targetOf("user.fdata"), writer: store.writerOf("e.fakeh") }).toEqual({
			plain: "lexicon fake e.fakeh Foo#",
			shared: null,
			writer: "fakeheader",
		});
	});
});

describe("a road that does not ask who binds against its writes", () => {
	// A direct index and a refactor step each let go before anyone asks, so the pump does.
	it("rebinds the users of a module a direct index or a refactor step rewrote", async () => {
		await gitInit(root);
		put("x.fake", "export class Base {}\n");
		put("direct.fake", "use Foo\n");
		put("stepped.fake", "use Bar\n");
		service = bindingService();
		await service.indexWorkspace();

		put("x.fake", "export class Base {}\nexport class Foo {}\n");
		await service.gate.exclusive(() => service.indexFile("x.fake"));
		await service.upgradeRemaining();
		const direct = targetOf("direct.fake");

		const before = "export class Base {}\nexport class Foo {}\n";
		const step = await journaledStep<{ ok: boolean }>(
			{
				service,
				transactions: new TransactionManager(store, root),
				write: (work) => service.gate.exclusive(async () => work()),
			},
			{
				kind: "replace",
				hold: "joinOrOwn",
				refuse: () => ({ ok: false }),
				succeed: () => ({ ok: true }),
				plan: async () => ({
					planned: {
						modules: ["x.fake"],
						writes: [
							{ module: "x.fake", base: hashContent(before), text: `${before}export class Bar {}\n` },
						],
						stale: () => null,
						reindex: ["x.fake"],
						issues: [],
					},
				}),
			},
		);
		await service.upgradeRemaining();

		expect({ step, direct, stepped: targetOf("stepped.fake") }).toEqual({
			step: { ok: true },
			direct: "lexicon fake x.fake Foo#",
			stepped: "lexicon fake x.fake Bar#",
		});
	});

	// A module edited while no daemon watched is read first by the warm scan.
	it("rebinds the unchanged users of a module edited while the daemon was down", async () => {
		await gitInit(root);
		put("x.fake", "export class Base {}\n");
		put("user.fake", "use Foo\n");
		service = bindingService();
		await service.indexWorkspace();

		put("x.fake", "export class Base {}\nexport class Foo {}\n");
		const parses: string[] = [];
		service = bindingService(parses);
		await service.warmupWorkspace();
		await service.upgradeRemaining();

		expect({
			user: parses.filter((module) => module === "user.fake").length,
			bound: targetOf("user.fake"),
		}).toEqual({
			user: 1,
			bound: "lexicon fake x.fake Foo#",
		});
	});

	// Users upgraded before the module they bind into read its outline, which may declare less.
	it("rebinds the users of a declaration only a module's full parse reads", async () => {
		await gitInit(root);
		put("x.fake", "export class Base {}\nexport class LateFoo {}\n");
		put("user.fake", "use LateFoo\n");
		service = bindingService([], { declares: lateInFull });

		await service.warmupWorkspace();
		await service.upgradeRemaining();

		expect(targetOf("user.fake")).toBe("lexicon fake x.fake LateFoo#");
	});
});

describe("rebind debt", () => {
	// A batch cut short by a stopping daemon never asked; the store keeps the question for the next.
	it("rebinds after a restart what a batch abandoned before it asked", async () => {
		await gitInit(root);
		put("x.fake", "export class Base {}\n");
		put("user.fake", "use Foo\n");
		service = bindingService();
		await service.indexWorkspace();

		put("x.fake", "export class Base {}\nexport class Foo {}\n");
		let checks = 0;
		await service.applyBatch([{ kind: "changed", module: "x.fake", contentHash: "x-2" }], () => ++checks > 1);
		const abandoned = targetOf("user.fake");
		service = bindingService();
		await service.warmupWorkspace();
		await service.upgradeRemaining();

		expect({ abandoned, restarted: targetOf("user.fake") }).toEqual({
			abandoned: null,
			restarted: "lexicon fake x.fake Foo#",
		});
	});

	// An outage is no answer, so the debt stands until the provider answers again.
	it("keeps a rebind an outage cut short owed, inline and in the pump, until the provider answers", async () => {
		await gitInit(root);
		put("x.fake", "export class Base {}\n");
		put("inline.fake", "use Foo\n");
		put("pumped.fake", "use Bar\n");
		const down = new Set<string>();
		service = bindingService([], { down: (request) => down.has(request.module) });
		await service.indexWorkspace();

		down.add("inline.fake");
		put("x.fake", "export class Base {}\nexport class Foo {}\n");
		await service.applyBatch([{ kind: "changed", module: "x.fake", contentHash: "x-2" }]);
		down.add("pumped.fake");
		put("x.fake", "export class Base {}\nexport class Foo {}\nexport class Bar {}\n");
		await service.gate.exclusive(() => service.indexFile("x.fake"));
		await service.upgradeRemaining();
		const outage = { inline: targetOf("inline.fake"), pumped: targetOf("pumped.fake") };

		down.clear();
		// Any admitted parse is the provider answering again.
		await service.gate.exclusive(() => service.indexFile("x.fake"));
		await service.upgradeRemaining();

		expect({ outage, inline: targetOf("inline.fake"), pumped: targetOf("pumped.fake") }).toEqual({
			outage: { inline: null, pumped: null },
			inline: "lexicon fake x.fake Foo#",
			pumped: "lexicon fake x.fake Bar#",
		});
	});

	// One provider answering says nothing about another one's outage.
	it("retries an outage's debt when that provider answers again, not when another does", async () => {
		await gitInit(root);
		put("x.fake", "export class Base {}\n");
		put("user.fdata", "use Foo\n");
		put("other.fdata", "use Base\n");
		// Every parse asked of the user, answered or not.
		let asked = 0;
		let down = false;
		service = bindingService([], {
			running: [claims, dataClaims],
			down: (request) => {
				if (request.module === "user.fdata") asked++;
				return down && request.module.endsWith(".fdata");
			},
		});
		await service.indexWorkspace();

		down = true;
		put("x.fake", "export class Base {}\nexport class Foo {}\n");
		await service.applyBatch([{ kind: "changed", module: "x.fake", contentHash: "x-2" }]);
		const held = asked;
		await service.gate.exclusive(() => service.indexFile("x.fake"));
		await service.upgradeRemaining();
		const otherAnswered = asked;
		down = false;
		await service.gate.exclusive(() => service.indexFile("other.fdata"));
		await service.upgradeRemaining();

		expect({ otherAnswered: otherAnswered - held, bound: targetOf("user.fdata") }).toEqual({
			otherAnswered: 0,
			bound: "lexicon fake x.fake Foo#",
		});
	});

	// A refusal is about the file's own bytes: an unrelated parse says nothing new about it.
	it("retries a refused rebind on its provider's restart or its own file's event, never sooner", async () => {
		await gitInit(root);
		put("x.fake", "export class Base {}\n");
		put("user.fake", "use Foo\n");
		put("other.fake", "export class Other {}\n");
		const parses: string[] = [];
		const refusing = new Set<string>();
		const incarnation = { current: 1 };
		service = bindingService(parses, { refusing, incarnation });
		await service.indexWorkspace();
		const userParses = () => parses.filter((module) => module === "user.fake").length;
		const scanned = userParses();

		refusing.add("user.fake");
		put("x.fake", "export class Base {}\nexport class Foo {}\n");
		await service.applyBatch([{ kind: "changed", module: "x.fake", contentHash: "x-2" }]);
		await service.upgradeRemaining();
		const refused = userParses() - scanned;
		await service.gate.exclusive(() => service.indexFile("other.fake"));
		await service.upgradeRemaining();
		const unrelated = userParses() - scanned;

		refusing.clear();
		incarnation.current = 2;
		await service.upgradeRemaining();

		expect({ refused, unrelated, restarted: userParses() - scanned, bound: targetOf("user.fake") }).toEqual({
			refused: 1,
			unrelated: 1,
			restarted: 2,
			bound: "lexicon fake x.fake Foo#",
		});
	});

	// The move stays until the debt it owes is written, so a stop between the two loses neither.
	it("rebinds after a restart what a batch stopped mid-rebind had read but not yet owed", async () => {
		await gitInit(root);
		put("x.fake", "export class Base {}\n");
		put("user.fake", 'import "./x.fake";\nuse Foo\n');
		const file = path.join(root, "stopped.sqlite");
		const stopped = IndexStore.open(file).store;
		let stopping = false;
		const running = bindingService([], {
			over: stopped,
			// A daemon stopping under the rebind: its store goes, then the parse fails.
			down: (request) => {
				if (!stopping || request.module !== "user.fake") return false;
				stopped.close();
				return true;
			},
		});
		await running.indexWorkspace();

		stopping = true;
		put("x.fake", "export class Base {}\nexport class Foo {}\n");
		const cut = await running.applyBatch([{ kind: "changed", module: "x.fake", contentHash: "x-2" }]).then(
			() => "finished",
			() => "stopped",
		);
		const restarted = IndexStore.open(file).store;
		service = bindingService([], { over: restarted });
		await service.warmupWorkspace();
		await service.upgradeRemaining();
		const bound = targetOf("user.fake", restarted);
		restarted.close();

		expect({ cut, bound }).toEqual({ cut: "stopped", bound: "lexicon fake x.fake Foo#" });
	});

	// Where a batch reads a user before the module it binds against moves, the user read the old surface.
	it("parses again a user the batch wrote before the module whose surface then moved", async () => {
		await gitInit(root);
		put("a-user.fake", "use Foo\n");
		put("z-api.fake", "export class Base {}\n");
		const parses: string[] = [];
		service = bindingService(parses);
		await service.indexWorkspace();

		parses.length = 0;
		put("a-user.fake", "use Foo\nuse Base\n");
		put("z-api.fake", "export class Base {}\nexport class Foo {}\n");
		await service.applyBatch([
			{ kind: "changed", module: "a-user.fake", contentHash: "a-2" },
			{ kind: "changed", module: "z-api.fake", contentHash: "z-2" },
		]);

		expect({ parses, bound: targetOf("a-user.fake") }).toEqual({
			parses: ["a-user.fake", "z-api.fake", "a-user.fake"],
			bound: "lexicon fake z-api.fake Foo#",
		});
	});

	// A live rescan's provider still holds its parse of a changed module; a first scan's holds none.
	it("parses again a user a live rescan wrote before a changed module, and nothing extra on a first scan", async () => {
		await gitInit(root);
		// An importer written before what it imports, as every first scan has.
		put("a-user.fake", 'import "./z-api.fake";\nuse Foo\n');
		put("z-api.fake", "export class Base {}\n");
		const parses: string[] = [];
		service = bindingService(parses);
		await service.indexWorkspace();
		await service.upgradeRemaining();
		const first = [...parses];

		parses.length = 0;
		put("a-user.fake", 'import "./z-api.fake";\nuse Foo\nuse Base\n');
		put("z-api.fake", "export class Base {}\nexport class Foo {}\n");
		await service.indexWorkspace();
		await service.upgradeRemaining();

		expect({ first, rescan: parses, bound: targetOf("a-user.fake") }).toEqual({
			first: ["a-user.fake", "z-api.fake"],
			rescan: ["a-user.fake", "z-api.fake", "a-user.fake"],
			bound: "lexicon fake z-api.fake Foo#",
		});
	});

	// A resolver fault is no answer about where an import lands, so the importer is asked again.
	it("asks again, rather than forgetting, an importer whose resolution faulted", async () => {
		await gitInit(root);
		put("x.fake", "export class Base {}\n");
		put("old.fake", "export class Old {}\n");
		put("imp.fake", 'import "lib";\n');
		const parses: string[] = [];
		let unresolvable = false;
		service = bindingService(parses, { unresolvable: () => unresolvable, lands: turningOver });
		await service.indexWorkspace();

		parses.length = 0;
		unresolvable = true;
		put("x.fake", "export class Base {}\nexport class Foo {}\n");
		// A module arriving moves where `lib` lands, so only asking the provider again finds the importer.
		put("new.fake", "export class New {}\n");
		await service.applyBatch([
			{ kind: "changed", module: "x.fake", contentHash: "x-2" },
			{ kind: "changed", module: "new.fake", contentHash: "n-1" },
		]);
		const faulted = parses.includes("imp.fake");
		unresolvable = false;
		await service.gate.exclusive(() => service.indexFile("new.fake"));
		await service.upgradeRemaining();

		expect({ faulted, asked: parses.includes("imp.fake") }).toEqual({ faulted: false, asked: true });
	});

	// A store closed under a run ends it and says so, rather than restarting it forever.
	it("ends a pump run whose store closed under it, and rejects whoever awaits it", async () => {
		await gitInit(root);
		put("x.fake", "export class Foo {}\n");
		put("user.fake", "use Foo\n");
		const closing = IndexStore.open(path.join(root, "closing.sqlite")).store;
		const pumping = bindingService([], { over: closing });
		await pumping.indexWorkspace();
		closing.oweRebinds(["user.fake"]);

		const run = pumping.upgradeRemaining();
		closing.close();

		expect(
			await run.then(
				() => "resolved",
				() => "rejected",
			),
		).toBe("rejected");
	});

	// A debt on a module a warm scan left as an outline is paid by its upgrade, once the provider answers.
	it("pays a debt on a module left as an outline once its provider answers again", async () => {
		await gitInit(root);
		put("x.fake", "export class Foo {}\n");
		put("user.fake", "use Bar\n");
		service = bindingService();
		await service.indexWorkspace();
		// What a stopped daemon left owed, and bytes edited while it was down.
		store.oweRebinds(["user.fake"]);
		put("user.fake", "use Foo\n");

		let down = true;
		service = bindingService([], { down: (request) => down && request.depth !== "outline" });
		await service.warmupWorkspace();
		await service.upgradeRemaining();
		const outage = store.depthOf("user.fake");
		down = false;
		await service.gate.exclusive(() => service.indexFile("x.fake"));
		await service.upgradeRemaining();

		expect({ outage, depth: store.depthOf("user.fake"), bound: targetOf("user.fake") }).toEqual({
			outage: "outline",
			depth: "full",
			bound: "lexicon fake x.fake Foo#",
		});
	});

	// A restarted daemon may be asked to upgrade before any scan computed its scope.
	it("upgrades an outline a stopped daemon left, before any scan", async () => {
		await gitInit(root);
		put("x.fake", "export class Foo {}\n");
		service = bindingService();
		await service.gate.exclusive(() => service.indexFile("x.fake", "outline"));
		const left = store.depthOf("x.fake");
		service = bindingService();

		await service.upgradeRemaining();

		expect({ left, depth: store.depthOf("x.fake") }).toEqual({ left: "outline", depth: "full" });
	});

	// A parse that reads references binds against every move before it.
	it("settles a debt with any parse that reads references, rather than parsing it again", async () => {
		await gitInit(root);
		put("x.fake", "export class Foo {}\n");
		put("user.fake", "use Foo\n");
		const parses: string[] = [];
		service = bindingService(parses);
		await service.indexWorkspace();
		// What a daemon stopped before its pump reached this module leaves behind.
		store.oweRebinds(["user.fake"]);
		parses.length = 0;

		await service.gate.exclusive(() => service.indexFile("user.fake"));
		await service.upgradeRemaining();

		expect(parses).toEqual(["user.fake"]);
	});

	// Each upgrade that moves a surface reads its own imports again, never the workspace's.
	it("resolves the workspace's imports once for a run of upgrades that each move a surface", async () => {
		await gitInit(root);
		const modules = Array.from({ length: 40 }, (_, at) => `m${String(at).padStart(2, "0")}.fake`);
		for (const [at, module] of modules.entries()) {
			const next = modules[(at + 1) % modules.length] as string;
			put(module, `import "./${next}";\nexport class Base${at} {}\nexport class Late${at} {}\n`);
		}
		service = bindingService([], { declares: lateInFull });
		await service.warmupWorkspace();

		const before = service.resolutionStats();
		await service.upgradeRemaining();
		const after = service.resolutionStats();

		// Linear in the modules; asking the workspace's edges per upgrade is their square, 1600 here.
		expect(after.hits + after.misses - before.hits - before.misses).toBeLessThan(5 * modules.length);
	});

	// A module the index no longer holds has nothing to parse again, blocked or not.
	it("drops the debt of a module whose file is deleted", async () => {
		await gitInit(root);
		put("x.fake", "export class Base {}\n");
		put("user.fake", 'import "./x.fake";\nuse Foo\n');
		const refusing = new Set<string>();
		service = bindingService([], { refusing });
		await service.indexWorkspace();
		refusing.add("user.fake");
		put("x.fake", "export class Base {}\nexport class Foo {}\n");
		await service.applyBatch([{ kind: "changed", module: "x.fake", contentHash: "x-2" }]);
		const blocked = store.blockedRebinds().map((debt) => debt.module);

		rmSync(path.join(root, "user.fake"));
		await service.applyBatch([{ kind: "deleted", module: "user.fake" }]);

		expect({ blocked, deleted: store.blockedRebinds().map((debt) => debt.module) }).toEqual({
			blocked: ["user.fake"],
			deleted: [],
		});
	});
});

describe("what a surface carries", () => {
	// An importer binds through the re-export, so where it points is part of what it offers.
	it("rebinds the importers of a module whose re-export now points elsewhere", async () => {
		await gitInit(root);
		put("a.fake", "export class Foo {}\n");
		put("b.fake", "export class Foo {}\n");
		put("api.fake", 'reexport Foo from "./a.fake"\n');
		put("user.fake", 'import "./api.fake";\nuse Foo\n');
		service = bindingService();
		await service.indexWorkspace();
		await service.indexWorkspace();
		const before = targetOf("user.fake");

		put("api.fake", 'reexport Foo from "./b.fake"\n');
		await service.applyBatch([{ kind: "changed", module: "api.fake", contentHash: "api-2" }]);

		expect({ before, after: targetOf("user.fake") }).toEqual({
			before: "lexicon fake a.fake Foo#",
			after: "lexicon fake b.fake Foo#",
		});
	});

	// Moving between scopes changes no declaration, so only the scope names who reads it.
	it("parses again, in the batch, an importer of a scope a module left", async () => {
		await gitInit(root);
		put("com/a.fake", "export class Foo {}\n");
		put("user.fake", 'import "com"\nuse Foo\n');
		let scopeId = "com";
		const scopes = (module: string): ScopeContribution[] =>
			module === "com/a.fake"
				? [{ kind: "packageScope", scopeId, members: ["lexicon fake com/a.fake Foo#"] }]
				: [];
		const resolves = (request: MethodRequest<"resolveImport">): MethodResponse<"resolveImport"> =>
			request.specifier === "com"
				? { status: "resolved", landing: { kind: "packageScope", providerId: "fake", scopeId: "com" } }
				: resolveFake(request);
		service = bindingService([], { resolves, scopes });
		await service.indexWorkspace();

		scopeId = "org";
		put("com/a.fake", "export class Foo {}\n\n");
		const batch = parsedIn(
			await service.applyBatch([{ kind: "changed", module: "com/a.fake", contentHash: "a-2" }]),
		);

		expect(batch).toEqual(["com/a.fake", "user.fake"]);
	});

	// Scopes importing each other would otherwise rebind one another forever.
	it("parses no importer of a scope for a body edit that keeps its scopes and its surface", async () => {
		await gitInit(root);
		put("com/a.fake", 'import "org"\nexport class Foo {}\nuse Bar\n');
		put("org/b.fake", 'import "com"\nexport class Bar {}\nuse Foo\n');
		const scopes = (module: string): ScopeContribution[] => {
			const [scopeId = ""] = module.split("/");
			const name = scopeId === "com" ? "Foo" : "Bar";
			return [{ kind: "packageScope", scopeId, members: [`lexicon fake ${module} ${name}#`] }];
		};
		const resolves = (request: MethodRequest<"resolveImport">): MethodResponse<"resolveImport"> =>
			request.specifier === "com" || request.specifier === "org"
				? {
						status: "resolved",
						landing: { kind: "packageScope", providerId: "fake", scopeId: request.specifier },
					}
				: resolveFake(request);
		const parses: string[] = [];
		// Its own store, closed if the pump never settles, so a regression fails rather than hangs.
		const own = IndexStore.open(path.join(root, "scopes.sqlite")).store;
		service = bindingService(parses, { resolves, scopes, over: own });
		await service.indexWorkspace();
		await service.upgradeRemaining();
		parses.length = 0;

		put("com/a.fake", 'import "org"\nexport class Foo { edited }\nuse Bar\n');
		const batch = parsedIn(
			await service.applyBatch([{ kind: "changed", module: "com/a.fake", contentHash: "a-2" }]),
		);
		const settled = await Promise.race([
			service.upgradeRemaining().then(() => true),
			Bun.sleep(5_000).then(() => false),
		]);
		own.close();

		expect({ settled, batch, parses }).toEqual({ settled: true, batch: ["com/a.fake"], parses: ["com/a.fake"] });
	});

	// A standalone road forgets a module; the specifiers that landed on it are asked again.
	it("asks again where a specifier lands once the module it landed on is forgotten", async () => {
		await gitInit(root);
		put("old.fake", "export class Foo {}\n");
		put("user.fake", 'import "./old.fake"\nuse Foo\n');
		let asked = 0;
		const resolves = (request: MethodRequest<"resolveImport">): MethodResponse<"resolveImport"> => {
			if (request.specifier === "./old.fake") asked++;
			return resolveFake(request);
		};
		service = bindingService([], { resolves });
		await service.indexWorkspace();
		await service.indexFile("user.fake");
		const cached = asked;

		rmSync(path.join(root, "old.fake"));
		await service.indexFile("old.fake");
		await service.indexFile("user.fake");

		expect(asked).toBeGreaterThan(cached);
	});

	// Only the refused barrel's projection says the name now reaches through it: its parse is held.
	it("parses again, in the batch, a user binding through a refused barrel to a name its source gained", async () => {
		await gitInit(root);
		put("a.fake", "export class Bar {}\n");
		put("api.fake", 'reexport Foo from "./a.fake"\n');
		put("user.fake", 'import "./api.fake";\nuse Foo\n');
		const refusing = new Set<string>();
		service = bindingService([], { refusing });
		await service.indexWorkspace();
		refusing.add("api.fake");
		put("api.fake", 'reexport Foo from "./a.fake"\nSYNTAX\n');
		await service.applyBatch([{ kind: "changed", module: "api.fake", contentHash: "api-2" }]);

		put("a.fake", "export class Bar {}\nexport class Foo {}\n");
		const batch = parsedIn(await service.applyBatch([{ kind: "changed", module: "a.fake", contentHash: "a-2" }]));

		expect({ batch, bound: targetOf("user.fake") }).toEqual({
			batch: ["a.fake", "user.fake"],
			bound: "lexicon fake a.fake Foo#",
		});
	});

	// Resolutions turn over as the module goes, so only the imports written against it still name it.
	it("rebinds importers, plain or through a re-export, of a deleted module whose specifier now lands elsewhere", async () => {
		await gitInit(root);
		put("old.fake", "export class Base {}\n");
		put("new.fake", "export class Foo {}\nexport class Bar {}\n");
		put("other.fake", "export class Foo {}\nexport class Bar {}\n");
		put("api.fake", 'reexport Foo from "lib"\n');
		put("barrel-user.fake", 'import "./api.fake";\nuse Foo\n');
		// A name apart from the re-export's, so the barrel's own move does not find this user.
		put("plain-user.fake", 'import "lib";\nuse Bar\n');
		service = bindingService([], { lands: fallingBack });
		await service.indexWorkspace();
		await service.indexWorkspace();
		const users = () => ({ barrel: targetOf("barrel-user.fake"), plain: targetOf("plain-user.fake") });
		const before = users();

		rmSync(path.join(root, "old.fake"));
		await service.applyBatch([{ kind: "deleted", module: "old.fake" }]);
		await service.upgradeRemaining();

		expect({ before, after: users() }).toEqual({
			before: { barrel: null, plain: null },
			after: { barrel: "lexicon fake new.fake Foo#", plain: "lexicon fake new.fake Bar#" },
		});
	});

	// A provider may have read a module for an earlier dependent before the file changed under the scan.
	it("parses again a dependent a scan wrote before a module whose file changed during the scan", async () => {
		await gitInit(root);
		put("a-user.fake", "use Foo\n");
		put("z-api.fake", "export class Base {}\n");
		let changed = false;
		service = bindingService([], {
			afterParse: (module) => {
				if (module !== "a-user.fake" || changed) return;
				changed = true;
				put("z-api.fake", "export class Base {}\nexport class Foo {}\n");
			},
		});

		await service.indexWorkspace();
		await service.upgradeRemaining();

		expect(targetOf("a-user.fake")).toBe("lexicon fake z-api.fake Foo#");
	});

	// No root names an ignored file, so its first look is when an import first reaches it.
	it("parses again a dependent a scan wrote before an ignored module it imports changed during the scan", async () => {
		await gitInit(root);
		put(".gitignore", "gen.fake\n");
		put("gen.fake", "export class Base {}\n");
		put("a-user.fake", 'import "./gen.fake";\nuse Foo\n');
		put("b-other.fake", "export class Other {}\n");
		service = bindingService([], {
			afterParse: (module) => {
				if (module === "b-other.fake") put("gen.fake", "export class Base {}\nexport class Foo {}\n");
			},
		});

		await service.indexWorkspace();
		await service.upgradeRemaining();

		expect(targetOf("a-user.fake")).toBe("lexicon fake gen.fake Foo#");
	});

	it("parses again an imported dependent a scan wrote before the ignored module it imports changed", async () => {
		await gitInit(root);
		put(".gitignore", "mid.fake\ntouch.fake\ndeep.fake\n");
		put("user.fake", 'import "./mid.fake";\nimport "./touch.fake";\n');
		put("mid.fake", 'import "./deep.fake";\nuse Bar\n');
		put("touch.fake", "export class Touch {}\n");
		put("deep.fake", "export class Base {}\n");
		service = bindingService([], {
			afterParse: (module) => {
				if (module === "touch.fake") put("deep.fake", "export class Base {}\nexport class Bar {}\n");
			},
		});

		await service.indexWorkspace();
		await service.upgradeRemaining();

		expect(targetOf("mid.fake")).toBe("lexicon fake deep.fake Bar#");
	});
});

describe("what wakes the pump", () => {
	// Nothing else may happen for a long while, so a resolver fault arms its own retry.
	it("retries a move a resolver fault left pending once the retry comes due, with no other work", async () => {
		await gitInit(root);
		put("x.fake", "export class Base {}\n");
		put("old.fake", "export class Old {}\n");
		put("imp.fake", 'import "lib";\n');
		const parses: string[] = [];
		let unresolvable = false;
		const clock = fakeClock();
		service = bindingService(parses, { unresolvable: () => unresolvable, lands: turningOver, clock });
		await service.indexWorkspace();

		parses.length = 0;
		unresolvable = true;
		put("x.fake", "export class Base {}\nexport class Foo {}\n");
		// A module arriving moves where `lib` lands, so only asking the provider again finds the importer.
		put("new.fake", "export class New {}\n");
		await service.applyBatch([
			{ kind: "changed", module: "x.fake", contentHash: "x-2" },
			{ kind: "changed", module: "new.fake", contentHash: "n-1" },
		]);
		unresolvable = false;
		const early = await eventually(() => parses.includes("imp.fake"));
		clock.advance(RESOLVE_RETRY_MS);

		expect({ early, due: await eventually(() => parses.includes("imp.fake")) }).toEqual({
			early: false,
			due: true,
		});
	});

	// A restarted provider may answer what the one before it refused.
	it("retries a refused rebind when its provider respawns, with no other work", async () => {
		await gitInit(root);
		put("x.fake", "export class Base {}\n");
		put("user.fake", 'import "./x.fake";\nuse Foo\n');
		const refusing = new Set<string>();
		const respawns: { respawn?: (providerId: string) => void } = {};
		service = bindingService([], { refusing, respawns });
		await service.indexWorkspace();
		refusing.add("user.fake");
		put("x.fake", "export class Base {}\nexport class Foo {}\n");
		await service.applyBatch([{ kind: "changed", module: "x.fake", contentHash: "x-2" }]);

		refusing.clear();
		respawns.respawn?.("fake");

		expect(await eventually(() => targetOf("user.fake") === "lexicon fake x.fake Foo#")).toBe(true);
	});

	// Bytes put back to what the index holds are the refused file's own event, though nothing is parsed.
	it("retries a refused rebind once its file is restored to the bytes the index holds", async () => {
		await gitInit(root);
		put("x.fake", "export class Base {}\n");
		const admitted = 'import "./x.fake";\nuse Foo\n';
		put("user.fake", admitted);
		service = bindingService();
		await service.indexWorkspace();
		put("user.fake", `${admitted}SYNTAX\n`);
		put("x.fake", "export class Base {}\nexport class Foo {}\n");
		await service.applyBatch([{ kind: "changed", module: "x.fake", contentHash: "x-2" }]);
		const refused = store.blockedRebinds().map((debt) => debt.module);

		put("user.fake", admitted);
		await service.applyBatch([{ kind: "changed", module: "user.fake", contentHash: hashContent(admitted) }]);

		expect({
			refused,
			restored: await eventually(() => targetOf("user.fake") === "lexicon fake x.fake Foo#"),
		}).toEqual({ refused: ["user.fake"], restored: true });
	});

	// A read begun before resolutions turned over answers the old landing; the move waits for a new read.
	it("keeps a move pending when resolutions turn over while the pump reads its importers", async () => {
		await gitInit(root);
		put("x.fake", "export class Base {}\n");
		put("old.fake", "export class Old {}\n");
		put("imp.fake", 'import "lib";\n');
		const parses: string[] = [];
		let landing = "old.fake";
		let mode: "answer" | "fault" | "hold" = "answer";
		let release: (() => void) | null = null;
		const resolves = async (request: MethodRequest<"resolveImport">): Promise<MethodResponse<"resolveImport">> => {
			if (request.specifier !== "lib") return resolveFake(request);
			if (mode === "fault") throw new ProviderUnavailableError("provider is gone");
			const answer = landing;
			if (mode === "hold") {
				mode = "answer";
				await new Promise<void>((resume) => {
					release = resume;
				});
			}
			return landed(answer);
		};
		const clock = fakeClock();
		service = bindingService(parses, { resolves, clock });
		await service.indexWorkspace();

		// A fault leaves the importer unread, so the pump's read asks the provider rather than a cache.
		mode = "fault";
		put("n1.fake", "export class N1 {}\n");
		await service.applyBatch([{ kind: "changed", module: "n1.fake", contentHash: "n1" }]);
		mode = "hold";
		parses.length = 0;
		put("x.fake", "export class Base {}\nexport class Foo {}\n");
		await service.gate.exclusive(() => service.indexFile("x.fake"));
		const held = await eventually(() => release !== null);
		// While the pump waits, a batch turns resolutions over and "lib" now lands on x.
		landing = "x.fake";
		put("n2.fake", "export class N2 {}\n");
		await service.applyBatch([{ kind: "changed", module: "n2.fake", contentHash: "n2" }]);
		(release as (() => void) | null)?.();
		await service.upgradeRemaining();
		clock.advance(RESOLVE_RETRY_MS);

		expect({ held, rebound: await eventually(() => parses.includes("imp.fake")) }).toEqual({
			held: true,
			rebound: true,
		});
	});
});
