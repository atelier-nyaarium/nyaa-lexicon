import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Declaration, IndexDepth } from "@nyaa-lexicon/protocol";
import type { FileEvent } from "../invalidation";
import type { ProviderPort } from "../providerPort";
import type { ProviderClaims } from "../routing";
import { LexiconService } from "../service";
import { MAX_SOURCE_BYTES, type SourceReader, sourceReader } from "../sourceRead";
import { IndexStore } from "../store";
import { ProviderUnavailableError } from "../supervisor";
import { fakeClasses } from "./fakeGrammar";
import { importsFrom, parseFake, resolveFake, fakeSupervisor as sharedFake } from "./fakeProvider";
import { gitAdd, gitInit } from "./gitFixture";
import { landed } from "./importEdges";

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
/** Claims `.fakeh` only beside a `.fake`, the way a C++ provider claims `.h`. */
const headerClaims: ProviderClaims = {
	providerId: "fakeheader",
	language: "fake",
	extensions: [],
	sharedExtensions: [{ extension: ".fakeh", beside: [".fake"] }],
};
/** Plain `.fakeh` extension claim. */
const plainHeaderClaims: ProviderClaims = { providerId: "fakeplain", language: "fake", extensions: [".fakeh"] };
const fallbackClaims: ProviderClaims = {
	providerId: "text",
	language: "text",
	extensions: [],
	fallback: true,
	content: "text",
};
const point = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };

function put(module: string, text: string): void {
	const full = path.join(root, module);
	mkdirSync(path.dirname(full), { recursive: true });
	writeFileSync(full, text);
}

async function initGit(): Promise<void> {
	await gitInit(root);
}

function declaration(module: string, name: string): Declaration {
	return {
		symbolId: `lexicon fake ${module} ${name}.`,
		kind: "class",
		name,
		range: point,
		selectionRange: point,
		visibility: "public",
		exported: true,
	};
}

/** `lazyEvidence: false` ignores the indexer's registered source, so only a scan's own observation routes a header. */
function fakeSupervisor(
	discovered: string[] = [],
	parseRequests: Array<{ module: string; depth?: IndexDepth }> = [],
	{
		lazyEvidence = true,
		fallback = false,
		plainHeaders = false,
		released,
	}: {
		lazyEvidence?: boolean;
		fallback?: boolean;
		plainHeaders?: boolean;
		released?: Array<{ module: string; providerId: string }>;
	} = {},
): ProviderPort {
	return sharedFake({
		...(released === undefined ? {} : { released }),
		claims: [
			claims,
			dataClaims,
			headerClaims,
			...(fallback ? [fallbackClaims] : []),
			...(plainHeaders ? [plainHeaderClaims] : []),
		],
		discover: () => discovered,
		lazyEvidence,
		answers: {
			parseFile: (request) => {
				parseRequests.push({
					module: request.module,
					...(request.depth === undefined ? {} : { depth: request.depth }),
				});
				if (request.text.includes("POISON")) throw new Error("poisoned file");
				const diagnostics = request.text.includes("SYNTAX")
					? [{ severity: "error" as const, message: "syntax error" }]
					: request.text.includes("WARN")
						? [{ severity: "warning" as const, message: "duplicate key" }]
						: [];
				const declarations = fakeClasses(request.text).map((found) => declaration(request.module, found.name));
				// A provider that ignores the depth ceiling: line 1 is `"NOTE"`, sent at every depth.
				const noted = request.text.split("\n")[1] === '"NOTE"';
				const note = { start: { line: 1, character: 0 }, end: { line: 1, character: 6 } };
				return {
					module: request.module,
					contentHash: request.contentHash,
					declarations,
					references: [],
					imports: importsFrom(request.text),
					literals: noted ? [{ kind: "string" as const, value: "NOTE", range: note }] : [],
					diagnostics,
				};
			},
			resolveImport: (request) =>
				request.specifier.startsWith("external:")
					? {
							status: "external",
							packageName: "fixture",
							surface: { module: request.specifier.slice("external:".length) },
						}
					: resolveFake(request),
		},
	});
}

beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), "lexicon-workspace-"));
	store = IndexStore.open(path.join(root, "index.sqlite")).store;
});

afterEach(() => {
	store.close();
	rmSync(root, { recursive: true, force: true });
});

////////////////////////////////
//  Tests

describe("a batch that changes nothing", () => {
	// Admission is git and routing evidence; the tail is every root's imports through the providers.
	// Neither belongs to a save that moved no bytes.
	it("admits nothing and asks no provider when every file is unchanged", async () => {
		await initGit();
		put("root.fake", 'export class Root {}\nimport "./leaf.fake";\n');
		put("leaf.fake", "export class Leaf {}\n");
		let parses = 0;
		let resolves = 0;
		let admissions = 0;
		const port = sharedFake({
			claims: [claims],
			answers: {
				parseFile: (request) => {
					parses++;
					return parseFake(request);
				},
				resolveImport: (request) => {
					resolves++;
					return resolveFake(request);
				},
			},
		});
		const counting: ProviderPort = {
			...port,
			observeWorkspace: (modules) => {
				admissions++;
				port.observeWorkspace(modules);
			},
		};
		service = new LexiconService(store, counting, sourceReader(root), root);
		await service.indexWorkspace();
		expect(service.findByName("Leaf")).toHaveLength(1);
		const [parsed, resolved, admitted] = [parses, resolves, admissions];

		const outcomes = await service.applyBatch([
			{ kind: "changed", module: "root.fake", contentHash: store.contentHashOf("root.fake") as string },
			{ kind: "changed", module: "leaf.fake", contentHash: store.contentHashOf("leaf.fake") as string },
		]);

		expect(outcomes.map((o) => [o.action, o.cause])).toEqual([
			["skipped", "current"],
			["skipped", "current"],
		]);
		expect([parses, resolves, admissions]).toEqual([parsed, resolved, admitted]);
	});
});

describe("provider discovery scope", () => {
	it("passes admitted workspace modules to discoverProject", async () => {
		await initGit();
		put("src/kept.fake", "export class Kept {}\n");
		let received: string[] | undefined;
		const base = fakeSupervisor(["src/kept.fake"]);
		const port: ProviderPort = {
			...base,
			askProvider: (providerId, method, params) => {
				if (method === "discoverProject") received = (params as { scope: string[] }).scope;
				return base.askProvider(providerId, method, params);
			},
		};
		service = new LexiconService(store, port, sourceReader(root), root);
		await service.indexWorkspace();
		expect(received).toContain("src/kept.fake");
	});
});

describe("where a specifier lands", () => {
	/**
	 * One root importing a chain of ignored files, so each link is reachable only through the one
	 * above it and the closure takes a round per link.
	 */
	async function chain(depth: number): Promise<void> {
		await initGit();
		put("root.fake", `export class Root {}\nimport "./link1.fake";\n`);
		const links = Array.from({ length: depth }, (_, step) => `link${step + 1}.fake`);
		put(".gitignore", `${links.join("\n")}\n`);
		for (let step = 1; step <= depth; step++) {
			const next = step === depth ? "" : `import "./link${step + 1}.fake";\n`;
			put(`link${step}.fake`, `export class Link${step} {}\n${next}`);
		}
	}

	/** Counts a resolve per (module, specifier), so a repeat of one question is visible. */
	function countingService(asked: string[]): LexiconService {
		const port = sharedFake({
			claims: [claims],
			answers: {
				resolveImport: (request) => {
					asked.push(`${request.fromModule} ${request.specifier}`);
					return resolveFake(request);
				},
			},
		});
		return new LexiconService(store, port, sourceReader(root), root);
	}

	// Every round used to re-walk everything seen so far, so a chain asked its head's imports once
	// per link. The reachability answer is the thing that must not change.
	it("asks each importer once per scan, and still reaches the whole chain", async () => {
		await chain(4);
		const asked: string[] = [];
		service = countingService(asked);

		await service.indexWorkspace();

		expect(service.findByName("Link4")).toHaveLength(1);
		expect([...asked].sort()).toEqual([
			"link1.fake ./link2.fake",
			"link2.fake ./link3.fake",
			"link3.fake ./link4.fake",
			"root.fake ./link1.fake",
		]);
	});

	// A body edit moves no file and no rule, so where every specifier lands is what it was.
	it("is not asked again by a batch that only edits a body", async () => {
		await chain(3);
		const asked: string[] = [];
		service = countingService(asked);
		await service.indexWorkspace();
		asked.length = 0;

		put("link1.fake", 'export class Link1 {}\nexport class Extra {}\nimport "./link2.fake";\n');
		await service.applyBatch([{ kind: "changed", module: "link1.fake", contentHash: "link1-2" }]);

		expect(service.findByName("Extra")).toHaveLength(1);
		expect(asked).toEqual([]);
	});

	// A file that did not exist can be where a specifier lands, so the answers have to be asked again.
	it("is asked again once a module appears", async () => {
		await chain(2);
		const asked: string[] = [];
		service = countingService(asked);
		await service.indexWorkspace();
		asked.length = 0;

		put("fresh.fake", "export class Fresh {}\n");
		await service.applyBatch([{ kind: "changed", module: "fresh.fake", contentHash: "fresh-1" }]);

		expect(service.findByName("Fresh")).toHaveLength(1);
		expect(asked.length).toBeGreaterThan(0);
	});

	// The provider names its config files; an edit to one restates where everything lands.
	it("is asked again once a config the provider named is edited", async () => {
		await initGit();
		put("root.fake", 'export class Root {}\nimport "./leaf.fake";\n');
		put("leaf.fake", "export class Leaf {}\n");
		put("fake.config", "rules\n");
		const asked: string[] = [];
		const port = sharedFake({
			claims: [{ ...claims, extensions: [".fake", ".config"] }],
			answers: {
				discoverProject: () => ({
					files: ["root.fake", "leaf.fake", "fake.config"],
					externalRoots: [],
					configFiles: ["fake.config"],
					diagnostics: [],
				}),
				resolveImport: (request) => {
					asked.push(`${request.fromModule} ${request.specifier}`);
					return resolveFake(request);
				},
			},
		});
		service = new LexiconService(store, port, sourceReader(root), root);
		await service.indexWorkspace();
		asked.length = 0;

		put("fake.config", "rules\nmore\n");
		await service.applyBatch([{ kind: "changed", module: "fake.config", contentHash: "config-2" }]);

		expect(asked.length).toBeGreaterThan(0);
	});

	// Unchanged bytes read differently once the project's symbols move.
	it("parses every module again when a config edit moves the project's fingerprint, and only then", async () => {
		await initGit();
		put("root.fake", 'export class Root {}\nimport "./leaf.fake";\n');
		put("leaf.fake", "export class Leaf {}\n");
		put("fake.config", "symbols\n");
		const parses: string[] = [];
		const port = () =>
			sharedFake({
				answers: {
					discoverProject: () => ({
						files: ["root.fake", "leaf.fake"],
						externalRoots: [],
						configFiles: ["fake.config"],
						diagnostics: [],
						// The config's first line stands for what the provider reads it for.
						fingerprint: readFileSync(path.join(root, "fake.config"), "utf8").split("\n")[0] as string,
					}),
					parseFile: (request) => {
						parses.push(request.module);
						return parseFake(request);
					},
				},
			});
		const edit = async (text: string): Promise<string[]> => {
			parses.length = 0;
			put("fake.config", text);
			await service.applyBatch([{ kind: "changed", module: "fake.config", contentHash: text }]);
			return [...parses].sort();
		};
		const warm = async (): Promise<string[]> => {
			parses.length = 0;
			service = new LexiconService(store, port(), sourceReader(root), root);
			await service.warmupWorkspace();
			return [...parses].sort();
		};
		service = new LexiconService(store, port(), sourceReader(root), root);
		await service.indexWorkspace();

		const sameSymbols = await edit("symbols\ncomment\n");
		const newSymbols = await edit("other\n");
		const warmUnchanged = await warm();
		put("fake.config", "moved while stopped\n");
		const warmMoved = await warm();

		expect({ sameSymbols, newSymbols, warmUnchanged, warmMoved }).toEqual({
			sameSymbols: [],
			newSymbols: ["leaf.fake", "root.fake"],
			warmUnchanged: [],
			warmMoved: ["leaf.fake", "root.fake"],
		});
	});

	// A build database under an ignored build/ still states the rules.
	it("lets the watcher read a config file git ignores, never a denied one", async () => {
		await initGit();
		put(".gitignore", "build/\n");
		put("lexicon.json", JSON.stringify({ deny: ["secret/**"] }));
		put("root.fake", "export class Root {}\n");
		put("build/fake.config", "symbols\n");
		put("build/other.fake", "export class Other {}\n");
		put("secret/fake.config", "symbols\n");
		const port = sharedFake({
			answers: {
				discoverProject: () => ({
					files: ["root.fake"],
					externalRoots: [],
					configFiles: ["build/fake.config", "secret/fake.config"],
					diagnostics: [],
				}),
			},
		});
		service = new LexiconService(store, port, sourceReader(root), root);
		await service.indexWorkspace();
		const scope = service.watchScope();

		expect(["build/fake.config", "secret/fake.config", "build/other.fake"].map(scope.admits)).toEqual([
			true,
			false,
			false,
		]);
	});
});

describe("a config edit that restates a project", () => {
	/**
	 * A provider reading `fake.config`: its first line is the project's fingerprint, the rest the
	 * files it discovers. Every parse declares `Under_<fingerprint>`, the project it read under.
	 */
	function projectService({
		refusing,
		down,
		parses,
	}: {
		refusing?: Set<string>;
		down?: Set<string>;
		parses?: string[];
	} = {}): LexiconService {
		let reading = "";
		const port = sharedFake({
			answers: {
				discoverProject: () => {
					const [fingerprint = "", ...files] = readFileSync(path.join(root, "fake.config"), "utf8")
						.trim()
						.split("\n");
					reading = fingerprint;
					return { files, externalRoots: [], configFiles: ["fake.config"], diagnostics: [], fingerprint };
				},
				parseFile: (request) => {
					if (down?.has(request.module)) throw new ProviderUnavailableError("provider is gone");
					parses?.push(request.module);
					const facts = parseFake(request);
					return {
						...facts,
						declarations: [...facts.declarations, declaration(request.module, `Under_${reading}`)],
						diagnostics:
							refusing?.has(request.module) === true
								? [{ severity: "error" as const, message: "refused" }]
								: facts.diagnostics,
					};
				},
			},
		});
		return new LexiconService(store, port, sourceReader(root), root);
	}

	const restate = (fingerprint: string, ...others: FileEvent[]) => {
		put("fake.config", `${fingerprint}\n`);
		return service.applyBatch([{ kind: "changed", module: "fake.config", contentHash: fingerprint }, ...others]);
	};

	// The source edited beside the config is read once, and under the project the config now states.
	it("parses a source edited beside the config under the project it states", async () => {
		await initGit();
		put("fake.config", "old\n");
		put("a.fake", "export class A {}\n");
		put("b.fake", "export class B {}\n");
		service = projectService();
		await service.indexWorkspace();

		put("a.fake", "export class A {}\nexport class Edited {}\n");
		await restate("new", { kind: "changed", module: "a.fake", contentHash: "a-2" });

		const under = service.findByName("Under_new").map((found) => found.module);
		expect(under.sort()).toEqual(["a.fake", "b.fake"]);
	});

	// A module the new reading never admitted still holds the old one, so the next warm scan owes it.
	it("records the restated project only once every module it reads was admitted under it", async () => {
		await initGit();
		put("fake.config", "one\n");
		put("a.fake", "export class A {}\n");
		put("b.fake", "export class B {}\n");
		const refusing = new Set<string>();
		const down = new Set<string>();
		service = projectService({ refusing, down });
		await service.indexWorkspace();

		refusing.add("a.fake");
		await restate("two");
		const refused = store.projectFingerprint("fake");
		refusing.clear();
		down.add("b.fake");
		await restate("three");
		const outage = store.projectFingerprint("fake");
		down.clear();
		await restate("four");

		expect({ refused, outage, admitted: store.projectFingerprint("fake") }).toEqual({
			refused: "one",
			outage: "one",
			admitted: "four",
		});
	});

	// A daemon on its way out cuts a restatement at a file boundary; the project it states stays unrecorded.
	it("stops a restatement for a leaving daemon and leaves the rest to the next warm scan", async () => {
		await initGit();
		put("fake.config", "one\n");
		for (const module of ["a.fake", "b.fake", "c.fake", "d.fake"]) put(module, "export class A {}\n");
		const parses: string[] = [];
		service = projectService({ parses });
		await service.indexWorkspace();

		parses.length = 0;
		put("fake.config", "two\n");
		await service.applyBatch(
			[{ kind: "changed", module: "fake.config", contentHash: "two" }],
			() => parses.length >= 2,
		);
		const cut = { parsed: parses.length, project: store.projectFingerprint("fake") };
		await service.warmupWorkspace();

		const under = service.findByName("Under_two").map((found) => found.module);
		expect({ cut, under: under.sort(), project: store.projectFingerprint("fake") }).toEqual({
			cut: { parsed: 2, project: "one" },
			under: ["a.fake", "b.fake", "c.fake", "d.fake"],
			project: "two",
		});
	});

	// No git: the provider's own discovery is all that makes a file a root.
	it("roots a file the restated project names and prunes one it no longer does", async () => {
		put("fake.config", "one\na.fake\nb.fake\n");
		put("a.fake", "export class A {}\n");
		put("b.fake", "export class B {}\n");
		put("c.fake", "export class C {}\n");
		service = projectService();
		await service.indexWorkspace();
		const before = store.indexedFiles().sort();

		put("fake.config", "two\na.fake\nc.fake\n");
		await service.applyBatch([{ kind: "changed", module: "fake.config", contentHash: "two" }]);

		expect({ before, after: store.indexedFiles().sort() }).toEqual({
			before: ["a.fake", "b.fake"],
			after: ["a.fake", "c.fake"],
		});
	});

	// A warm scan holds a moved project to the batch's rule: a refused module leaves the old one.
	it("records a project a warm scan restated only once every module it reads was admitted", async () => {
		await initGit();
		put("fake.config", "one\n");
		put("a.fake", "export class A {}\n");
		put("b.fake", "export class B {}\n");
		const refusing = new Set<string>();
		service = projectService({ refusing });
		await service.indexWorkspace();

		put("fake.config", "two\n");
		refusing.add("a.fake");
		service = projectService({ refusing });
		await service.warmupWorkspace();
		const refused = store.projectFingerprint("fake");
		refusing.clear();
		service = projectService({ refusing });
		await service.warmupWorkspace();

		expect({ refused, retried: store.projectFingerprint("fake") }).toEqual({ refused: "one", retried: "two" });
	});

	// Where a specifier lands follows the project, even one that stops naming the config that moved it.
	it("asks again where specifiers land once a restated project stops naming its own config", async () => {
		await initGit();
		// Reached only through the import, so the landing decides which is indexed.
		put(".gitignore", "a.fake\nb.fake\n");
		put("root.fake", 'export class Root {}\nimport "lib";\n');
		put("a.fake", "export class A {}\n");
		put("b.fake", "export class B {}\n");
		// The fingerprint, then where "lib" lands.
		put("fake.config", "one\na.fake\n");
		const lines = () => readFileSync(path.join(root, "fake.config"), "utf8").trim().split("\n");
		const port = sharedFake({
			answers: {
				discoverProject: () => {
					const [fingerprint = "", landing = ""] = lines();
					const configFiles = landing === "b.fake" ? [] : ["fake.config"];
					return { files: [], externalRoots: [], configFiles, diagnostics: [], fingerprint };
				},
				resolveImport: (request) =>
					request.specifier === "lib" ? landed(lines()[1] as string) : resolveFake(request),
			},
		});
		service = new LexiconService(store, port, sourceReader(root), root);
		await service.indexWorkspace();
		const before = store.indexedFiles().sort();

		put("fake.config", "two\nb.fake\n");
		await service.applyBatch([{ kind: "changed", module: "fake.config", contentHash: "two" }]);

		expect({ before, after: store.indexedFiles().sort() }).toEqual({
			before: ["a.fake", "root.fake"],
			after: ["b.fake", "root.fake"],
		});
	});
});

describe("a refused file", () => {
	// Its bytes are the reason it holds nothing, so only a change to them earns another read.
	it("is not re-read by a batch that does not name it", async () => {
		await initGit();
		put("root.fake", "export class Root {}\n");
		writeFileSync(path.join(root, "blob.bin"), Buffer.from([0x50, 0x4b, 0x00, 0x01]));
		const reads: string[] = [];
		const base = sourceReader(root);
		const reader: SourceReader = (module) => {
			reads.push(module);
			return base(module);
		};
		service = new LexiconService(store, fakeSupervisor([], [], { fallback: true }), reader, root);
		await service.indexWorkspace();
		expect(store.parseFailureOf("blob.bin")?.reason).toContain("not text");
		const before = reads.filter((module) => module === "blob.bin").length;
		expect(before).toBeGreaterThan(0);

		put("root.fake", "export class Root {}\nexport class Second {}\n");
		const outcomes = await service.applyBatch([{ kind: "changed", module: "root.fake", contentHash: "root-2" }]);

		expect(outcomes.map((o) => o.module)).not.toContain("blob.bin");
		expect(reads.filter((module) => module === "blob.bin")).toHaveLength(before);
		expect(store.parseFailureOf("blob.bin")).not.toBeNull();
	});
});

describe("workspace roots", () => {
	it("routes admitted unowned files to fallback and records guarded failures", async () => {
		await initGit();
		put("root.fake", "export class Root {}\n");
		put("Dockerfile", "FROM base\n\nRUN app\n");
		writeFileSync(path.join(root, "binary"), Buffer.from([0, 1, 2]));
		service = new LexiconService(store, fakeSupervisor([], [], { fallback: true }), sourceReader(root), root);

		const outcomes = await service.indexWorkspace();

		expect(outcomes).toContainEqual(expect.objectContaining({ module: "Dockerfile", action: "indexed" }));
		expect(outcomes).toContainEqual(
			expect.objectContaining({
				module: "binary",
				action: "skipped",
				reason: "parse failed",
				failure: expect.stringContaining("NUL"),
			}),
		);
		expect((await service.overview()).content?.files.text).toBe(1);
	});

	it("adds git-visible claimed files to provider discovery", async () => {
		await initGit();
		put("root.fake", "export class Root {}\n");
		put("extra.fake", "export class Extra {}\n");
		service = new LexiconService(store, fakeSupervisor(["root.fake"]), sourceReader(root), root);

		const outcomes = await service.indexWorkspace();

		expect(outcomes.filter((outcome) => outcome.action === "indexed").map((outcome) => outcome.module)).toEqual([
			"extra.fake",
			"root.fake",
		]);
		expect(service.findByName("Extra")).toHaveLength(1);
	});

	it("forgets a root that vanishes before the next scan", async () => {
		await initGit();
		put("root.fake", "export class Root {}\n");
		await gitAdd(root, "root.fake");
		service = new LexiconService(store, fakeSupervisor(["root.fake"]), sourceReader(root), root);

		await service.indexWorkspace();
		rmSync(path.join(root, "root.fake"));
		const outcomes = await service.indexWorkspace();

		expect(service.findByName("Root")).toEqual([]);
		expect(outcomes).toContainEqual({
			module: "root.fake",
			action: "forgotten",
			cause: "missing",
			reason: "file is gone",
		});
	});

	it("moves indexed facts with a live rename batch", async () => {
		await initGit();
		put("before.fake", "export class Before {}\n");
		service = new LexiconService(store, fakeSupervisor(), sourceReader(root), root);

		await service.indexWorkspace();
		rmSync(path.join(root, "before.fake"));
		put("after.fake", "export class After {}\n");
		await service.applyBatch([
			{ kind: "deleted", module: "before.fake" },
			{ kind: "changed", module: "after.fake", contentHash: "after-1" },
		]);

		expect(service.findByName("Before")).toEqual([]);
		expect(service.findByName("After")).toHaveLength(1);
	});

	// A provider indexing its own workspace would otherwise bind to the file the index let go of.
	it("tells providers each module it lets go of, deleted or grown past the limit", async () => {
		await initGit();
		put("gone.fake", "export class Gone {}\n");
		put("big.fake", "export class Big {}\n");
		put("kept.fake", "export class Kept {}\n");
		const forgotten: string[] = [];
		service = new LexiconService(store, sharedFake({ claims: [claims], forgotten }), sourceReader(root), root);
		await service.indexWorkspace();
		expect(forgotten).toEqual([]);

		rmSync(path.join(root, "gone.fake"));
		writeFileSync(path.join(root, "big.fake"), Buffer.alloc(MAX_SOURCE_BYTES + 1, 0x61));
		await service.applyBatch([
			{ kind: "deleted", module: "gone.fake" },
			{ kind: "changed", module: "big.fake", contentHash: "big-2" },
		]);

		expect(forgotten.sort()).toEqual(["big.fake", "gone.fake"]);
		expect(service.findByName("Kept")).toHaveLength(1);
	});
});

describe("a shared extension claim", () => {
	it("routes a header beside a source on the first scan, since evidence is read before ownership", async () => {
		await initGit();
		put("a.fake", "export class Source {}\n");
		put("a.fakeh", "export class Header {}\n");
		service = new LexiconService(store, fakeSupervisor([], [], { lazyEvidence: false }), sourceReader(root), root);

		const outcomes = await service.indexWorkspace();

		expect(outcomes.filter((outcome) => outcome.action === "indexed").map((outcome) => outcome.module)).toEqual([
			"a.fake",
			"a.fakeh",
		]);
		expect(service.findByName("Header")).toHaveLength(1);
	});

	it("routes a header on a fresh service, before any scan has run", async () => {
		await initGit();
		put("b.fake", "export class Source {}\n");
		put("b.fakeh", "export class Header {}\n");
		service = new LexiconService(store, fakeSupervisor(), sourceReader(root), root);

		await expect(service.indexFile("b.fakeh")).resolves.toMatchObject({ action: "indexed" });
	});

	it("takes a source indexed outside a scan as evidence", async () => {
		await initGit();
		put("b.fakeh", "export class Header {}\n");
		service = new LexiconService(store, fakeSupervisor(), sourceReader(root), root);

		await service.indexWorkspace();
		await expect(service.indexFile("b.fakeh")).resolves.toMatchObject({ action: "skipped", reason: "unclaimed" });
		put("b.fake", "export class Source {}\n");
		await service.indexFile("b.fake");
		await expect(service.indexFile("b.fakeh")).resolves.toMatchObject({ action: "indexed" });
	});

	it("drops the claim with the last source a batch deletes", async () => {
		await initGit();
		put("c.fake", "export class Source {}\n");
		put("c.fakeh", "export class Header {}\n");
		service = new LexiconService(store, fakeSupervisor(["c.fake", "c.fakeh"]), sourceReader(root), root);

		await service.indexWorkspace();
		rmSync(path.join(root, "c.fake"));
		const outcomes = await service.applyBatch([
			{ kind: "deleted", module: "c.fake" },
			{ kind: "changed", module: "c.fakeh", contentHash: "c-2" },
		]);

		expect(outcomes).toContainEqual(expect.objectContaining({ module: "c.fakeh", reason: "unclaimed" }));
		await expect(service.indexFile("c.fakeh")).resolves.toMatchObject({ action: "skipped", reason: "unclaimed" });
	});

	it("gains a shared claim once a batch creates the sibling source", async () => {
		await initGit();
		put("d.fakeh", "export class Header {}\n");
		service = new LexiconService(store, fakeSupervisor(["d.fakeh"]), sourceReader(root), root);

		await service.indexWorkspace();
		await expect(service.indexFile("d.fakeh")).resolves.toMatchObject({ action: "skipped", reason: "unclaimed" });

		put("d.fake", "export class Source {}\n");
		const outcomes = await service.applyBatch([{ kind: "changed", module: "d.fake", contentHash: "d-1" }]);
		expect(outcomes).toContainEqual(expect.objectContaining({ module: "d.fake", action: "indexed" }));

		await expect(service.indexFile("d.fakeh")).resolves.toMatchObject({ action: "indexed" });
	});

	it("parses a header again under its new owner once a batch moves the claim, and back", async () => {
		await initGit();
		put("e.fakeh", "export class Header {}\n");
		const parses: Array<{ module: string }> = [];
		const released: Array<{ module: string; providerId: string }> = [];
		service = new LexiconService(
			store,
			fakeSupervisor(["e.fakeh"], parses, { plainHeaders: true, released }),
			sourceReader(root),
			root,
		);

		await service.indexWorkspace();
		const plain = store.writerOf("e.fakeh");
		put("e.fake", "export class Source {}\n");
		await service.applyBatch([{ kind: "changed", module: "e.fake", contentHash: "e-1" }]);
		const shared = store.writerOf("e.fakeh");
		rmSync(path.join(root, "e.fake"));
		await service.applyBatch([{ kind: "deleted", module: "e.fake" }]);

		expect({
			plain,
			shared,
			back: store.writerOf("e.fakeh"),
			headerParses: parses.filter((parse) => parse.module === "e.fakeh").length,
			released,
		}).toEqual({
			plain: "fakeplain",
			shared: "fakeheader",
			back: "fakeplain",
			headerParses: 3,
			released: [
				{ module: "e.fakeh", providerId: "fakeplain" },
				{ module: "e.fakeh", providerId: "fakeheader" },
			],
		});
		expect(service.findByName("Header")).toHaveLength(1);
	});
});

describe("root exclusions and includes", () => {
	it("does not parse a denied direct index request", async () => {
		await initGit();
		put("lexicon.json", JSON.stringify({ deny: ["reference.fake"] }));
		put("reference.fake", "export class Reference {}\n");
		const requests: Array<{ module: string; depth?: "full" | "surface" }> = [];
		service = new LexiconService(store, fakeSupervisor([], requests), sourceReader(root), root);

		await expect(service.indexFile("reference.fake")).resolves.toEqual({
			module: "reference.fake",
			action: "skipped",
			cause: "unclaimed",
			reason: "denied by scope",
		});
		expect(requests).toEqual([]);
	});

	it("forgets a held module a direct index no longer admits", async () => {
		await initGit();
		put("reference.fake", "export class Reference {}\n");
		put("b.fake", "export class Source {}\n");
		put("b.fakeh", "export class Header {}\n");
		service = new LexiconService(store, fakeSupervisor(), sourceReader(root), root);
		await service.indexWorkspace();
		expect(service.findByName("Reference")).toHaveLength(1);
		expect(service.findByName("Header")).toHaveLength(1);

		put("lexicon.json", JSON.stringify({ deny: ["reference.fake"] }));
		rmSync(path.join(root, "b.fake"));
		service = new LexiconService(store, fakeSupervisor(), sourceReader(root), root);

		await expect(service.indexFile("reference.fake")).resolves.toMatchObject({
			action: "forgotten",
			reason: "denied by scope",
		});
		await expect(service.indexFile("b.fakeh")).resolves.toMatchObject({ action: "forgotten", reason: "unclaimed" });
		expect(service.findByName("Reference")).toEqual([]);
		expect(service.findByName("Header")).toEqual([]);
		await expect(service.indexFile("b.fakeh")).resolves.toMatchObject({ action: "skipped", reason: "unclaimed" });
	});

	it("excludes generated roots until an explicit include names them", async () => {
		await initGit();
		put(".gitattributes", "generated.fake linguist-generated\n");
		put("generated.fake", "export class Generated {}\n");
		put("ordinary.fake", "export class Ordinary {}\n");
		put("lexicon.json", JSON.stringify({ exclude: ["generated.fake"] }));
		service = new LexiconService(store, fakeSupervisor(), sourceReader(root), root);

		await service.indexWorkspace();
		expect(service.findByName("Generated")).toEqual([]);
		expect(service.findByName("Ordinary")).toHaveLength(1);

		put("lexicon.json", JSON.stringify({ include: ["generated.fake"], exclude: ["generated.fake"] }));
		await service.indexWorkspace();
		expect(service.findByName("Generated")).toHaveLength(1);

		put("lexicon.json", JSON.stringify({ exclude: ["generated.fake"] }));
		const outcomes = await service.indexWorkspace();
		expect(service.findByName("Generated")).toEqual([]);
		expect(outcomes).toContainEqual({
			module: "generated.fake",
			action: "forgotten",
			cause: "unclaimed",
			reason: "no longer a root or reachable",
		});
	});

	it("passes configured bundle roots and reachable files to providers at surface depth", async () => {
		await initGit();
		put(".gitignore", "opaque/\n");
		put("root.fake", 'export class Root {}\nimport "./opaque/runtime.fake";\n');
		put("opaque/runtime.fake", "export class Runtime {}\n");
		put("lexicon.json", JSON.stringify({ bundles: ["opaque/**"] }));
		const requests: Array<{ module: string; depth?: "full" | "surface" }> = [];
		service = new LexiconService(store, fakeSupervisor([], requests), sourceReader(root), root);

		await service.indexWorkspace();

		expect(requests.find((request) => request.module === "root.fake")).toEqual({ module: "root.fake" });
		expect(requests.find((request) => request.module === "opaque/runtime.fake")).toEqual({
			module: "opaque/runtime.fake",
			depth: "surface",
		});
	});
});

describe("reachability and failures", () => {
	it("indexes an external surface without treating the package as a workspace module", async () => {
		await initGit();
		put(".gitignore", "external.fake\n");
		put("root.fake", 'export class Root {}\nimport "external:external.fake";\n');
		put("external.fake", "export class External {}\n");
		const requests: Array<{ module: string; depth?: "full" | "surface" }> = [];
		service = new LexiconService(store, fakeSupervisor([], requests), sourceReader(root), root);

		await service.indexWorkspace();

		expect(service.findByName("External")).toHaveLength(1);
		expect(requests.find((request) => request.module === "external.fake")).toEqual({
			module: "external.fake",
			depth: "surface",
		});
	});

	it("stores no literals from a surface parse, even when the provider sends them", async () => {
		await initGit();
		put(".gitignore", "external.fake\n");
		put("root.fake", 'export class Root {}\n"NOTE"\nimport "external:external.fake";\n');
		put("external.fake", 'export class External {}\n"NOTE"\n');
		service = new LexiconService(store, fakeSupervisor(), sourceReader(root), root);

		await service.indexWorkspace();

		expect(service.findLiterals({ value: "NOTE" }).literals.map((hit) => hit.module)).toEqual(["root.fake"]);
	});

	it("omits dependency modules from the overview", async () => {
		await initGit();
		put(".gitignore", "node_modules/\n");
		put("root.fake", 'export class Root {}\nimport "external:node_modules/fixture/index.fake";\n');
		put("node_modules/fixture/index.fake", "export class External {}\n");
		service = new LexiconService(store, fakeSupervisor(), sourceReader(root), root);

		await service.indexWorkspace();

		expect(await service.overview()).toMatchObject({
			files: 1,
			symbols: 1,
			references: 0,
			imports: 1,
			literals: 0,
			modules: 1,
			largest: [{ module: "root.fake", symbols: 1 }],
		});
	});

	it("counts and ranks data files apart from code", async () => {
		await initGit();
		put("root.fake", "export class Root {}\n");
		put("fixtures/specs.fdata", "export class A {}\nexport class B {}\n");
		service = new LexiconService(store, fakeSupervisor(), sourceReader(root), root);

		await service.indexWorkspace();

		expect(await service.overview()).toMatchObject({
			content: {
				files: { code: 1, data: 1, document: 0, text: 0, unknown: 0 },
				symbols: { code: 1, data: 2, document: 0, text: 0, unknown: 0 },
			},
			largest: [{ module: "root.fake", symbols: 1 }],
			largestData: [{ module: "fixtures/specs.fdata", symbols: 2, content: "data" }],
		});
	});

	it("classes a file kept by an earlier release on the next scan, without re-reading it", async () => {
		await initGit();
		put("root.fake", "export class Root {}\n");
		put("specs.fdata", "export class A {}\n");
		const parsed: Array<{ module: string }> = [];
		service = new LexiconService(store, fakeSupervisor([], parsed), sourceReader(root), root);
		await service.indexWorkspace();
		store.close();

		const file = path.join(root, "index.sqlite");
		const raw = new DatabaseSync(file);
		raw.exec("ALTER TABLE files DROP COLUMN content");
		raw.close();
		store = IndexStore.open(file).store;
		service = new LexiconService(store, fakeSupervisor([], parsed), sourceReader(root), root);
		expect((await service.overview()).content.files).toEqual({
			code: 0,
			data: 0,
			document: 0,
			text: 0,
			unknown: 2,
		});

		// The daemon's start-up scan.
		parsed.length = 0;
		await service.warmupWorkspace();

		expect(parsed).toEqual([]);
		expect((await service.overview()).content.files).toEqual({
			code: 1,
			data: 1,
			document: 0,
			text: 0,
			unknown: 0,
		});
	});

	it("keeps an out-of-scope import tree while referenced and prunes it after a live refactor", async () => {
		await initGit();
		put(".gitignore", "reachable.fake\nleaf.fake\n");
		put("root.fake", "export class Root {}\n");
		put("reachable.fake", 'export class Reachable {}\nimport "./leaf.fake";\n');
		put("leaf.fake", "export class Leaf {}\n");
		service = new LexiconService(store, fakeSupervisor(), sourceReader(root), root);

		await service.indexWorkspace();
		expect(service.findByName("Reachable")).toEqual([]);
		expect(service.findByName("Leaf")).toEqual([]);

		put("root.fake", 'export class Root {}\nimport "./reachable.fake";\n');
		await service.applyBatch([{ kind: "changed", module: "root.fake", contentHash: "root-2" }]);
		expect(service.findByName("Reachable")).toHaveLength(1);
		expect(service.findByName("Leaf")).toHaveLength(1);

		put("root.fake", "export class Root {}\n");
		const outcomes = await service.applyBatch([{ kind: "changed", module: "root.fake", contentHash: "root-3" }]);

		expect(service.findByName("Reachable")).toEqual([]);
		expect(service.findByName("Leaf")).toEqual([]);
		expect(outcomes).toContainEqual({
			module: "reachable.fake",
			action: "forgotten",
			cause: "unclaimed",
			reason: "no longer a root or reachable",
		});
		expect(outcomes).toContainEqual({
			module: "leaf.fake",
			action: "forgotten",
			cause: "unclaimed",
			reason: "no longer a root or reachable",
		});
	});

	it("denies imported files and prunes their prior facts after a config change", async () => {
		await initGit();
		put("root.fake", 'export class Root {}\nimport "./reference/entry.fake";\n');
		put("reference/entry.fake", "export class Reference {}\n");
		const requests: Array<{ module: string; depth?: "full" | "surface" }> = [];
		service = new LexiconService(store, fakeSupervisor([], requests), sourceReader(root), root);

		await service.indexWorkspace();
		expect(service.findByName("Reference")).toHaveLength(1);
		expect(requests.filter((request) => request.module === "reference/entry.fake")).toHaveLength(1);

		put("lexicon.json", JSON.stringify({ deny: ["reference/**"] }));
		const outcomes = await service.applyBatch([
			{ kind: "changed", module: "lexicon.json", contentHash: "scope-deny" },
		]);

		expect(service.findByName("Reference")).toEqual([]);
		expect(requests.filter((request) => request.module === "reference/entry.fake")).toHaveLength(1);
		expect(outcomes).toContainEqual({
			module: "reference/entry.fake",
			action: "forgotten",
			cause: "unclaimed",
			reason: "no longer a root or reachable",
		});
	});

	it("prunes an imported tree when its only root is deleted", async () => {
		await initGit();
		put(".gitignore", "reachable.fake\nleaf.fake\n");
		put("root.fake", 'export class Root {}\nimport "./reachable.fake";\n');
		put("reachable.fake", 'export class Reachable {}\nimport "./leaf.fake";\n');
		put("leaf.fake", "export class Leaf {}\n");
		service = new LexiconService(store, fakeSupervisor(), sourceReader(root), root);

		await service.indexWorkspace();
		rmSync(path.join(root, "root.fake"));
		await service.applyBatch([{ kind: "deleted", module: "root.fake" }]);

		expect(service.findByName("Root")).toEqual([]);
		expect(service.findByName("Reachable")).toEqual([]);
		expect(service.findByName("Leaf")).toEqual([]);
	});

	it("indexes an import tree to its fixpoint", async () => {
		await initGit();
		put(".gitignore", "hidden/\n");
		put("root.fake", 'export class Root {}\nimport "./hidden/0.fake";\n');
		for (let depth = 0; depth < 12; depth++) {
			const next = depth === 11 ? "" : `\nimport "./${depth + 1}.fake";`;
			put(`hidden/${depth}.fake`, `export class Depth${depth} {}${next}\n`);
		}
		service = new LexiconService(store, fakeSupervisor(), sourceReader(root), root);

		await service.indexWorkspace();

		expect(service.findByName("Depth11")).toHaveLength(1);
	});

	it("keeps prior facts and continues after a poisoned workspace file", async () => {
		await initGit();
		put("bad.fake", "export class Bad {}\n");
		put("good.fake", "export class Good {}\n");
		service = new LexiconService(store, fakeSupervisor(), sourceReader(root), root);

		await service.indexWorkspace();
		put("bad.fake", "POISON\n");
		put("good.fake", "export class GoodUpdated {}\n");
		const outcomes = await service.indexWorkspace();

		expect(outcomes).toContainEqual({
			module: "bad.fake",
			action: "skipped",
			cause: "parseFailed",
			reason: "parse failed",
			failure: "poisoned file",
		});
		expect(service.findByName("Bad")).toHaveLength(1);
		expect(service.findByName("GoodUpdated")).toHaveLength(1);
		expect(service.indexStatus()).toMatchObject({ state: "ready", failures: 1 });
		expect((await service.overview()).index).toMatchObject({ failures: 1 });
	});

	it("keeps a warning beside the file's facts rather than failing the file", async () => {
		await initGit();
		put("noted.fake", "export class Noted {} // WARN\n");
		put("clean.fake", "export class Clean {}\n");
		service = new LexiconService(store, fakeSupervisor(), sourceReader(root), root);

		await service.indexWorkspace();

		expect(service.findByName("Noted")).toHaveLength(1);
		expect(service.indexStatus().failures).toBe(0);
		expect(service.fileNotes("noted.fake")).toEqual({
			module: "noted.fake",
			known: true,
			notes: [{ severity: "warning", message: "duplicate key" }],
		});
		expect(service.fileNotes("clean.fake")).toEqual({ module: "clean.fake", known: true, notes: [] });
		expect((await service.overview()).notes).toEqual({ noted: 1, unknown: 0 });
	});

	it("records a binary and an oversized file as failures with the reason, holding no facts", async () => {
		await initGit();
		put("ok.fake", "export class Ok {}\n");
		writeFileSync(path.join(root, "blob.fake"), Buffer.from([0x65, 0x00, 0x66]));
		writeFileSync(path.join(root, "big.fake"), Buffer.alloc(MAX_SOURCE_BYTES + 1, 0x61));
		const parseRequests: Array<{ module: string }> = [];
		service = new LexiconService(store, fakeSupervisor([], parseRequests), sourceReader(root), root);

		const outcomes = await service.indexWorkspace();

		expect(service.findByName("Ok")).toHaveLength(1);
		expect(outcomes).toContainEqual({
			module: "blob.fake",
			action: "skipped",
			cause: "binary",
			reason: "parse failed",
			failure: expect.stringContaining("NUL"),
		});
		expect(store.parseFailures()).toEqual([
			{
				module: "big.fake",
				reason: `${MAX_SOURCE_BYTES + 1} bytes, past the ${MAX_SOURCE_BYTES} byte limit for indexing`,
			},
			{ module: "blob.fake", reason: "not text: a NUL byte within the first 8 KiB" },
		]);
		expect(store.declarationsIn("blob.fake")).toEqual([]);
		expect(store.declarationsIn("big.fake")).toEqual([]);
		// Neither reached the provider.
		expect(parseRequests.map((request) => request.module)).toEqual(["ok.fake"]);
	});

	it("keeps prior facts while a live file has syntax errors", async () => {
		await initGit();
		put(".gitignore", "reachable.fake\n");
		put("root.fake", 'export class Before {}\nimport "./reachable.fake";\n');
		put("reachable.fake", "export class Reachable {}\n");
		service = new LexiconService(store, fakeSupervisor(), sourceReader(root), root);

		await service.indexWorkspace();
		put("root.fake", "SYNTAX\nexport class After {}\n");
		const broken = await service.applyBatch([{ kind: "changed", module: "root.fake", contentHash: "root-broken" }]);

		expect(broken).toContainEqual({
			module: "root.fake",
			action: "skipped",
			cause: "parseFailed",
			reason: "parse failed",
			failure: "syntax error",
		});
		expect(service.findByName("Before")).toHaveLength(1);
		expect(service.findByName("After")).toEqual([]);
		expect(service.findByName("Reachable")).toHaveLength(1);

		put("root.fake", "export class After {}\n");
		await service.applyBatch([{ kind: "changed", module: "root.fake", contentHash: "root-green" }]);
		expect(service.findByName("Before")).toEqual([]);
		expect(service.findByName("After")).toHaveLength(1);
		expect(service.findByName("Reachable")).toEqual([]);
	});

	it("isolates a poisoned closure target", async () => {
		await initGit();
		put(".gitignore", "reachable.fake\n");
		put("root.fake", 'export class Root {}\nimport "./reachable.fake";\n');
		put("reachable.fake", "export class Reachable {}\n");
		service = new LexiconService(store, fakeSupervisor(), sourceReader(root), root);

		await service.indexWorkspace();
		put("reachable.fake", "POISON\n");
		const outcomes = await service.indexWorkspace();

		expect(outcomes).toContainEqual({
			module: "reachable.fake",
			action: "skipped",
			cause: "parseFailed",
			reason: "parse failed",
			failure: "poisoned file",
		});
		expect(service.findByName("Reachable")).toHaveLength(1);
	});

	it("isolates a poisoned watcher event from later events", async () => {
		await initGit();
		put("bad.fake", "export class Bad {}\n");
		put("good.fake", "export class Good {}\n");
		service = new LexiconService(store, fakeSupervisor(), sourceReader(root), root);

		await service.indexWorkspace();
		put("bad.fake", "POISON\n");
		put("good.fake", "export class GoodUpdated {}\n");
		const outcomes = await service.applyBatch([
			{ kind: "changed", module: "bad.fake", contentHash: "bad-2" },
			{ kind: "changed", module: "good.fake", contentHash: "good-2" },
		]);

		expect(outcomes[0]).toMatchObject({ action: "skipped", reason: "parse failed" });
		expect(outcomes[1]).toMatchObject({ action: "indexed", module: "good.fake" });
		expect(service.findByName("Bad")).toHaveLength(1);
		expect(service.findByName("GoodUpdated")).toHaveLength(1);
	});
});

describe("abandoning a batch mid-flight", () => {
	// A daemon asked to stop mid-batch cuts it short at a file boundary rather than running it to
	// the end, so every file already written above stays whole and the rest is left for next time.
	it("ends the batch at a file boundary once asked to abandon, leaving later files untouched", async () => {
		await initGit();
		put("a.fake", "export class A {}\n");
		put("b.fake", "export class B {}\n");
		put("c.fake", "export class C {}\n");
		service = new LexiconService(store, fakeSupervisor(), sourceReader(root), root);
		await service.indexWorkspace();

		put("a.fake", "export class AUpdated {}\n");
		put("b.fake", "export class BUpdated {}\n");
		put("c.fake", "export class CUpdated {}\n");
		let checks = 0;
		const outcomes = await service.applyBatch(
			[
				{ kind: "changed", module: "a.fake", contentHash: null },
				{ kind: "changed", module: "b.fake", contentHash: null },
				{ kind: "changed", module: "c.fake", contentHash: null },
			],
			() => ++checks > 1,
		);

		// Only the file already in progress when the check first passed was written.
		expect(outcomes).toHaveLength(1);
		expect(outcomes[0]).toMatchObject({ action: "indexed", module: "a.fake" });
		expect(service.findByName("AUpdated")).toHaveLength(1);
		// b and c are untouched, not half-written: their pre-batch declarations still stand.
		expect(service.findByName("B")).toHaveLength(1);
		expect(service.findByName("BUpdated")).toHaveLength(0);
		expect(service.findByName("C")).toHaveLength(1);
		expect(service.findByName("CUpdated")).toHaveLength(0);

		// The next scan re-reads what the abandoned batch left, since their stored hash no longer
		// matches disk.
		await service.indexWorkspace();
		expect(service.findByName("BUpdated")).toHaveLength(1);
		expect(service.findByName("CUpdated")).toHaveLength(1);
	});

	// A check before the first file means nothing in the batch was ever attempted.
	it("attempts nothing when already asked to abandon before the batch starts", async () => {
		await initGit();
		put("a.fake", "export class A {}\n");
		service = new LexiconService(store, fakeSupervisor(), sourceReader(root), root);
		await service.indexWorkspace();

		put("a.fake", "export class AUpdated {}\n");
		const outcomes = await service.applyBatch(
			[{ kind: "changed", module: "a.fake", contentHash: null }],
			() => true,
		);

		expect(outcomes).toHaveLength(0);
		expect(service.findByName("AUpdated")).toHaveLength(0);
	});
});
