import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { workspaceKey } from "@nyaa-lexicon/client";
import { dotenvFormat, jsonFormat, secretFormatFor, yamlFormat } from "@nyaa-lexicon/formats/secret";
import {
	composeSymbolId,
	coordinatesOf,
	type Declaration,
	formatRef,
	hashBytes,
	hashContent,
	type Literal,
	type OffsetRange,
	walkChain,
} from "@nyaa-lexicon/protocol";
import { SecretJudge } from "@nyaa-lexicon/protocol/secretJudge";
import { systemClock } from "../clock";
import { Database } from "../database";
import { createDispatch } from "../dispatch.js";
import type { GitRunner } from "../fileScope";
import { runGit } from "../fileScope";
import { type LiveIndex, startLiveIndex } from "../liveIndex";
import type { MethodRequest, MethodResponse, ProviderPort } from "../providerPort";
import { sourceReader } from "../sourceRead";
import { IndexStore } from "../store";
import { ProviderUnavailableError } from "../supervisor";
import { TransactionManager } from "../transactions";
import { readEvent } from "../watcher";
import { admit, failPlain, writePlain } from "./admissions";
import { fakeSupervisor } from "./fakeProvider";
import { gitAdd, gitCommit, gitInit, gitRmCached, gitSubmoduleAdd, gitWorktreeAdd } from "./gitFixture";
import { failingCommit } from "./storeFailures";
import { TestLexiconService as LexiconService, testPolicy } from "./testPolicy";

////////////////////////////////
//  Helpers

let root: string;
let store: IndexStore;
let live: LiveIndex | undefined;
const additionalRoots: string[] = [];

function put(module: string, text: string): void {
	const file = path.join(root, module);
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, text);
}

function journalDenial(index: LexiconService, module: string, bytes?: Uint8Array): string | null {
	let contents = bytes;
	if (contents === undefined) {
		try {
			contents = readFileSync(path.join(root, module));
		} catch {
			contents = new Uint8Array();
		}
	}
	const result = index.policy.admitBytes(module, contents);
	return result.kind === "withheld" ? result.reason : null;
}

/** Imported readers used by the policy. */
const READERS = new Map([dotenvFormat, jsonFormat, yamlFormat].map((format) => [format.id, format.read.bind(format)]));

/** Parses key formats into property-value facts. */
function parseFacts(request: MethodRequest<"parseFile">): MethodResponse<"parseFile"> {
	const format = secretFormatFor(request.module);
	const documents = format === null ? [] : (READERS.get(format.id)?.(request.text).documents ?? []);
	const declarations: Declaration[] = [];
	const literals: Literal[] = [];
	const declared = new Set<string>();
	const language = format?.id ?? "json";
	const coordinates = coordinatesOf(request.text);
	const place = (span: OffsetRange) => {
		const range = coordinates.rangeAt(span.start, span.end);
		if (range === undefined) throw new Error("test text range is unavailable");
		return range;
	};
	const literalText = (span: OffsetRange): string => {
		const raw = request.text.slice(span.start, span.end);
		if (language === "json" && raw.startsWith('"')) {
			try {
				return JSON.parse(raw) as string;
			} catch {
				return raw;
			}
		}
		if (language === "yaml" && raw.startsWith("'") && raw.endsWith("'"))
			return raw.slice(1, -1).replaceAll("''", "'");
		return raw;
	};
	documents.forEach((document, index) => {
		const root = documents.length > 1 ? [{ kind: "namespace" as const, name: `[${index}]` }] : [];
		const seen = new Set<number>();
		const visit = (
			at: number,
			descriptors: Array<{ kind: "term" | "namespace"; name: string }>,
			containerId?: string,
		) => {
			const node = document.nodes[at];
			const name = node?.names[0];
			if (node === undefined || seen.has(at) || node.virtual) return;
			seen.add(at);
			const isArrayItem = node.index !== undefined;
			if (name === undefined && !isArrayItem) return;
			const next = [
				...descriptors,
				isArrayItem
					? { kind: "namespace" as const, name: `[${node.index}]` }
					: { kind: "term" as const, name: name as string },
			];
			const symbolId = composeSymbolId({ language, module: request.module, descriptors: next });
			if (declared.has(symbolId)) return;
			declared.add(symbolId);
			const selectionRange = place(node.key);
			if (!isArrayItem) {
				declarations.push({
					symbolId,
					kind: "property",
					name: name as string,
					range: place({ start: Math.min(node.key.start, node.value.start), end: node.value.end }),
					selectionRange,
					visibility: "public",
					...(containerId === undefined ? {} : { containerId }),
				});
			}
			if (node.value.end > node.value.start) {
				literals.push({
					kind: "string",
					value: literalText(node.value),
					range: place(node.value),
					containerId: symbolId,
				});
			}
			for (const child of node.children) visit(child, next, isArrayItem ? containerId : symbolId);
		};
		for (const child of document.nodes[0]?.children ?? []) visit(child, root);
	});
	return {
		module: request.module,
		contentHash: request.contentHash,
		declarations,
		references: [],
		imports: [],
		literals,
		comments: [],
		diagnostics: [],
	};
}

function testProvider(
	asked: string[] = [],
	failParseFor: ReadonlySet<string> = new Set(),
	dropDeclarationsFor: ReadonlyMap<string, ReadonlySet<string>> = new Map(),
): ProviderPort {
	return fakeSupervisor({
		claims: [
			{ providerId: "fixture-json", language: "json", extensions: [".json", ".jsonc"] },
			{ providerId: "fixture-yaml", language: "yaml", extensions: [".yaml", ".yml"] },
			{ providerId: "fixture-text", language: "text", extensions: [], fallback: true, content: "text" },
		],
		answers: {
			discoverProject: () => ({ files: [], externalRoots: [], configFiles: [], diagnostics: [] }),
			parseFile: (request) => {
				asked.push(request.module);
				if (failParseFor.has(request.module)) throw new Error("fixture provider failed");
				if (request.module === ".env") {
					const range = coordinatesOf(request.text).rangeAt(0, request.text.length);
					if (range === undefined) throw new Error("test text range is unavailable");
					return {
						module: request.module,
						contentHash: request.contentHash,
						declarations: [],
						references: [],
						imports: [],
						literals: [],
						comments: [],
						docs: [{ range, text: request.text, fenced: false }],
						diagnostics: [],
					};
				}
				const parsed = parseFacts(request);
				const dropped = dropDeclarationsFor.get(request.module);
				const droppedIds = new Set(
					parsed.declarations
						.filter(({ name }) => dropped?.has(name) === true)
						.map(({ symbolId }) => symbolId),
				);
				const facts =
					dropped === undefined
						? parsed
						: {
								...parsed,
								declarations: parsed.declarations.filter(({ name }) => !dropped.has(name)),
								literals: parsed.literals.filter(
									(literal) => !droppedIds.has(literal.containerId ?? ""),
								),
							};
				if (request.module === "broken.json" || request.module === "package.json") {
					return {
						...facts,
						diagnostics: [{ severity: "error", message: "Unexpected end of JSON input" }],
					};
				}
				if (request.module === "quoted-secret.yaml") {
					return {
						...facts,
						diagnostics: [{ severity: "error", message: 'YAML error near "QUOTED_SECRET_VALUE"' }],
					};
				}
				if (request.module === "multi-doc.yaml") {
					const separator = request.text.indexOf("---\n");
					const secondStart = separator < 0 ? -1 : request.text.indexOf("apiVersion", separator);
					const coordinates = coordinatesOf(request.text);
					const roots = [
						{ name: "[0]", start: 0, end: separator },
						{ name: "[1]", start: secondStart, end: request.text.length },
					];
					for (const root of roots) {
						const range = coordinates.rangeAt(root.start, root.end);
						if (range === undefined) throw new Error("test document range is unavailable");
						facts.declarations.push({
							symbolId: composeSymbolId({
								language: "yaml",
								module: request.module,
								descriptors: [{ kind: "namespace", name: root.name }],
							}),
							kind: "namespace",
							name: root.name,
							range,
							selectionRange: range,
							visibility: "public",
						});
					}
				}
				return facts;
			},
		},
	});
}

function service(
	asked: string[] = [],
	failParseFor: ReadonlySet<string> = new Set(),
	dropDeclarationsFor: ReadonlyMap<string, ReadonlySet<string>> = new Map(),
): LexiconService {
	return new LexiconService(store, testProvider(asked, failParseFor, dropDeclarationsFor), sourceReader(root), root);
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	throw new Error("the awaited secret index state never arrived");
}

async function waitForScope(
	index: LexiconService,
	predicate: (scope: Awaited<ReturnType<LexiconService["currentScope"]>>) => boolean,
) {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		if (predicate(await index.currentScope())) return;
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	throw new Error("the awaited secret scope state never arrived");
}

async function watch(index: LexiconService): Promise<void> {
	await index.currentScope();
	live = startLiveIndex({
		service: index,
		workspaceRoot: root,
		clock: systemClock,
		debounceMs: 5,
	});
	await live.warmed;
}

beforeEach(async () => {
	root = mkdtempSync(path.join(tmpdir(), "lexicon-secrets-"));
	store = IndexStore.open(path.join(root, "index.sqlite")).store;
	await gitInit(root);
});

afterEach(() => {
	live?.stop();
	live = undefined;
	store.close();
	for (const extra of additionalRoots.splice(0)) rmSync(extra, { recursive: true, force: true });
	rmSync(root, { recursive: true, force: true });
});

////////////////////////////////
//  Tests

describe("secret-aware indexing", () => {
	it("matches the provider judge for probes and linked paths", async () => {
		put(
			"lexicon.json",
			JSON.stringify({
				deny: ["private/**"],
				secrets: { "**/.env*": { "@untracked": "omit" } },
			}),
		);
		put(".env", "API_KEY=tracked\n");
		mkdirSync(path.join(root, "link"), { recursive: true });
		symlinkSync("../.env", path.join(root, "link/config.ts"));
		await gitAdd(root, "lexicon.json", ".env", "link/config.ts");
		const index = service();
		await index.currentScope();
		const snapshot = index.policy.current;
		const probes = [
			".env",
			"link/config.ts",
			".env.local",
			"src/.env.production",
			"credentials.json",
			"src/Credentials.json",
			"keys/server.pem",
			"keys/Server.PEM",
			"private/entry.ts",
			"plain.ts",
			"settings.yaml",
		];
		const dropped = { ...snapshot.wire, tracked: [] };
		const revision = hashContent(
			JSON.stringify({
				builtIns: dropped.builtIns,
				secrets: dropped.secrets,
				deny: dropped.deny,
				syntax: dropped.syntax,
				trackingKind: dropped.trackingKind,
				tracked: dropped.tracked,
				aliases: dropped.aliases,
				targets: dropped.targets,
				directoryLinks: dropped.directoryLinks ?? [],
			}),
		);
		const withoutTracked = SecretJudge.from({ ...dropped, revision });
		const received = SecretJudge.from(JSON.parse(JSON.stringify(snapshot.wire)));

		expect(probes.map((module) => snapshot.access(module))).toEqual(
			probes.map((module) => received.access(module)),
		);
		expect(snapshot.wire.tracked).toContain(".env");
		expect(snapshot.wire.aliases.flatMap(([, aliases]) => aliases)).toContain("link/config.ts");
		expect(withoutTracked.access(".env")).toBe("closed");
		expect(snapshot.access(".env")).toBe("open");
	});

	it("refuses to journal a whole-file secret", async () => {
		const secretText = '{"password":"JOURNAL_SECRET"}\n';
		put("credentials.json", secretText);
		await gitAdd(root, "credentials.json");
		const index = service();
		await index.currentScope();
		const transactions = new TransactionManager(store, root, index.policy);
		transactions.start();

		expect(transactions.track("credentials.json")).toMatchObject({
			tracked: false,
			reason: expect.stringContaining("secret file"),
		});
		expect(transactions.beforeImage("credentials.json")).toEqual({ tracked: false });
		expect(transactions.settledImage(1, "credentials.json", "opened")).toEqual({ held: false });
		expect(store.heldImage("credentials.json", hashBytes(Buffer.from(secretText)))).toBeNull();
	});

	it("refuses planned text that would become secret before journaling it", async () => {
		put("lexicon.json", JSON.stringify({ secrets: { "**/settings.json": { password: "redact" } } }));
		put("settings.json", '{"public":"visible"}\n');
		const index = service();
		await index.currentScope();
		const transactions = new TransactionManager(store, root, index.policy);
		transactions.start();
		const planned = Buffer.from('{"password":"PLANNED_SECRET_VALUE"}\n');

		const result = transactions.beginStep("replace", ["settings.json"], undefined, [
			{ module: "settings.json", text: planned.toString("utf8") },
		]);

		expect(result.ok).toBe(false);
		expect(store.heldImage("settings.json", hashBytes(planned))).toBeNull();
		expect(transactions.status().steps).toEqual([]);
	});

	it("keeps plain JSON and YAML visible while matching Kubernetes secrets", async () => {
		put("config.json", '{"config":"ordinary-json-value"}\n');
		put("config.yaml", "kind: Deployment\nconfig: ordinary-value\n");
		const index = service();
		await index.indexFile("config.json");
		await index.indexFile("config.yaml");

		const jsonKey = store.declarationsIn("config.json").find(({ name }) => name === "config");
		const configKey = store.declarationsIn("config.yaml").find(({ name }) => name === "config");
		if (!jsonKey || !configKey) throw new Error("expected plain data declarations");
		const jsonSource = await index.symbolSource({ symbolId: jsonKey.symbolId });
		const configSource = await index.symbolSource({ symbolId: configKey.symbolId });
		expect(jsonSource).toMatchObject({ found: true });
		expect(configSource).toMatchObject({ found: true });
		expect(journalDenial(index, "config.json")).toBeNull();
		expect(journalDenial(index, "config.yaml")).toBeNull();
		expect((await index.planInsert({ module: "config.yaml", text: "extra: visible" })).state).toBe("planned");
	});

	it("matches escaped JSON document checks", async () => {
		put("escaped.json", '{"kind":"Sec\\u0072et","data":{"token":"ESCAPED_DOCUMENT_SECRET"}}\n');
		const index = service();
		await index.indexFile("escaped.json");

		expect(index.findLiterals({ value: "ESCAPED_DOCUMENT_SECRET" }).total).toBe(0);
		expect(index.findByName("token")[0]?.valueStatus).toBe("set");
	});

	it("runs the reader for every plausible Kubernetes kind spelling", async () => {
		const cases = [
			["block-scalar.yaml", "kind: >-\n  Secret\ndata:\n  token: BLOCK_SCALAR_SECRET\n", "BLOCK_SCALAR_SECRET"],
			["next-line.yaml", "kind:\n  Secret\ndata:\n  token: NEXT_LINE_SECRET\n", "NEXT_LINE_SECRET"],
			["tagged.yaml", "kind: !!str Secret\ndata:\n  token: TAGGED_SECRET\n", "TAGGED_SECRET"],
			["flow.yaml", "{apiVersion: v1, kind: Secret, data: {token: FLOW_SECRET}}\n", "FLOW_SECRET"],
			["bom.yaml", "\uFEFFkind: Secret\ndata:\n  token: BOM_SECRET\n", "BOM_SECRET"],
			[
				"next-line.json",
				'{"kind":\n    "Secret",\n "data": {"token": "JSON_NEXT_LINE_SECRET"}}\n',
				"JSON_NEXT_LINE_SECRET",
			],
			[
				"escaped-value.yaml",
				'kind: "\\x53ecret"\ndata:\n  token: ESCAPED_VALUE_SECRET\n',
				"ESCAPED_VALUE_SECRET",
			],
			[
				"escaped-unicode.yaml",
				'kind: "\\U00000053ecret"\ndata:\n  token: ESCAPED_UNICODE_SECRET\n',
				"ESCAPED_UNICODE_SECRET",
			],
			["escaped-key.yaml", '"\\x6bind": Secret\ndata:\n  token: ESCAPED_KEY_SECRET\n', "ESCAPED_KEY_SECRET"],
		] as const;
		for (const [module, text] of cases) put(module, text);
		const index = service();

		for (const [module, , value] of cases) {
			await index.indexFile(module);
			expect(index.findLiterals({ value }).total).toBe(0);
			expect(journalDenial(index, module)).not.toBeNull();
			expect(
				store.declarationsIn(module).some(({ name, valueStatus }) => name === "token" && valueStatus === "set"),
			).toBe(true);
		}
	});

	it("keeps real diagnostics for malformed plain JSON", async () => {
		put("broken.json", '{ "metadata": { broken\n');
		put("package.json", '{"name":"app","kind":"Deployment","scripts":{\n');
		const index = service();

		for (const module of ["broken.json", "package.json"]) {
			const outcome = await index.indexFile(module);

			expect(outcome.failure, module).toBe("Unexpected end of JSON input");
			expect(journalDenial(index, module), module).toBeNull();
			expect(store.parseFailureOf(module)?.reason, module).toBe("Unexpected end of JSON input");
		}
	});

	it("keeps empty data files plain in the index and guard", async () => {
		put("empty.yaml", "# no document\n");
		const index = service();
		const outcome = await index.indexFile("empty.yaml");

		expect(outcome.failure).toBeUndefined();
		expect(store.contentHashOf("empty.yaml")).not.toBeNull();
		expect(journalDenial(index, "empty.yaml")).toBeNull();
	});

	it("keeps the keys of a whole-file secret that breaks off", async () => {
		put("credentials.json", '{"password":\n');
		const asked: string[] = [];
		const index = service(asked);
		const outcome = await index.indexFile("credentials.json");

		expect(outcome.failure).toBeUndefined();
		expect(asked).toEqual([]);
		expect(store.contentHashOf("credentials.json")).not.toBeNull();
		expect(store.declarationsIn("credentials.json").map(({ name, valueStatus }) => [name, valueStatus])).toEqual([
			["password", "empty"],
		]);
	});

	it("masks a Secret that aliases a value and keeps its keys", async () => {
		put("secret.yaml", "kind: Secret\ndata:\n  token: &token ALIAS_SECRET\n  copy: *token\n");
		const index = service();
		const outcome = await index.indexFile("secret.yaml");

		expect(outcome.failure).toBeUndefined();
		expect(index.findLiterals({ value: "ALIAS_SECRET" }).total).toBe(0);
		expect(store.parseFailureOf("secret.yaml")).toBeNull();
		expect(
			store
				.declarationsIn("secret.yaml")
				.filter(({ valueStatus }) => valueStatus !== undefined)
				.map(({ name, valueStatus }) => [name, valueStatus]),
		).toEqual([
			["data", "set"],
			["token", "set"],
			["copy", "set"],
		]);
		expect(journalDenial(index, "secret.yaml")).not.toBeNull();
	});

	it("masks a Secret whose kind a root merge can supply", async () => {
		put(
			"merged-secret.yaml",
			"metadata:\n  annotations: &kind\n    kind: Secret\n<<: *kind\ndata:\n  token: ROOT_MERGE_SECRET\n",
		);
		const index = service();
		const outcome = await index.indexFile("merged-secret.yaml");

		expect(outcome.failure).toBeUndefined();
		expect(index.findLiterals({ value: "ROOT_MERGE_SECRET" }).total).toBe(0);
		expect(index.findByName("token", "merged-secret.yaml")[0]?.valueStatus).toBe("set");
	});

	it("masks a Secret under duplicate kinds, and withholds a sensitive YAML parse failure", async () => {
		put("duplicate-kind.yaml", "kind: Deployment\nkind: Secret\ndata:\n  token: DUPLICATE_KIND_SECRET\n");
		put("quoted-secret.yaml", "kind: Secret\ndata:\n  token: QUOTED_SECRET_VALUE\n");
		const index = service();

		const duplicate = await index.indexFile("duplicate-kind.yaml");
		expect(duplicate.failure).toBeUndefined();
		expect(index.findByName("token", "duplicate-kind.yaml")[0]?.valueStatus).toBe("set");

		const quoted = await index.indexFile("quoted-secret.yaml");
		expect(quoted.failure).toBe("secret file; details withheld");
		expect(store.parseFailureOf("quoted-secret.yaml")?.reason).toBe("secret file; details withheld");
		expect(index.findLiterals({ value: "DUPLICATE_KIND_SECRET" }).total).toBe(0);
		expect(index.findLiterals({ value: "QUOTED_SECRET_VALUE" }).total).toBe(0);
	});

	it("masks a Secret whose kind is an alias", async () => {
		put(
			"aliased-kind.yaml",
			"kindValue: &secretKind Secret\nkind: *secretKind\ndata:\n  token: ALIASED_KIND_SECRET\n",
		);
		const index = service();
		const outcome = await index.indexFile("aliased-kind.yaml");

		expect(outcome.failure).toBeUndefined();
		expect(index.findLiterals({ value: "ALIASED_KIND_SECRET" }).total).toBe(0);
		expect(index.findByName("token", "aliased-kind.yaml")[0]?.valueStatus).toBe("set");
	});

	it("indexes ordinary YAML anchors and merge keys", async () => {
		put(
			"values.yaml",
			"kind: Deployment\nbase: &defaults\n  existingSecret: ordinary-name\nconfig:\n  <<: *defaults\n",
		);
		const index = service();
		const outcome = await index.indexFile("values.yaml");

		expect(outcome.failure).toBeUndefined();
		expect(journalDenial(index, "values.yaml")).toBeNull();
		expect(store.parseFailureOf("values.yaml")).toBeNull();
		expect(store.contentHashOf("values.yaml")).not.toBeNull();
	});

	it("masks a complex YAML key's value without storing its spelling", async () => {
		put("complex.yaml", "kind: Secret\ndata:\n  ? [one, two]\n  : COMPLEX_KEY_VALUE\n");
		const index = service();
		const outcome = await index.indexFile("complex.yaml");

		expect(outcome.failure).toBeUndefined();
		expect(index.findLiterals({ value: "COMPLEX_KEY_VALUE" }).total).toBe(0);
		expect(store.declarationsIn("complex.yaml").some(({ name }) => name.includes("one"))).toBe(false);
		expect(index.findByName("data", "complex.yaml")[0]?.valueStatus).toBe("set");
	});

	it("fails closed when a matching rule has no reader", async () => {
		put("lexicon.json", JSON.stringify({ secrets: { "**/settings.toml": { password: "redact" } } }));
		put("settings.toml", "password = TOML_READER_SECRET\n");
		const index = service();
		const outcome = await index.indexFile("settings.toml");

		expect(outcome.failure).toContain("secret file; details withheld");
		expect(store.contentHashOf("settings.toml")).toBeNull();
		expect(index.findLiterals({ value: "TOML_READER_SECRET" }).total).toBe(0);
	});

	it("discovers ignored dotenv files for keys and leaves ignored ordinary files out", async () => {
		put(".gitignore", ".env.local\nignored.fake\nnode_modules/\n");
		await gitAdd(root, ".gitignore");
		put(".env.local", "API_KEY=IGNORED_SECRET\nEMPTY=\n");
		put("ignored.fake", "export class Ignored {}\n");
		put("node_modules/.env.local", "API_KEY=EXCLUDED_DIRECTORY_SECRET\n");
		const index = service();
		await index.warmupWorkspace();

		expect(store.declarationsIn(".env.local").map(({ name, valueStatus }) => [name, valueStatus])).toEqual([
			["API_KEY", "set"],
			["EMPTY", "empty"],
		]);
		expect(store.contentHashOf("ignored.fake")).toBeNull();
		expect(store.contentHashOf("node_modules/.env.local")).toBeNull();
		expect(index.findLiterals({ value: "IGNORED_SECRET" }).total).toBe(0);
	});

	it("applies a secret alias rule to its contained target", async () => {
		put("src/config.json", '{"password":"SYMLINK_TARGET_SECRET"}\n');
		symlinkSync("config.json", path.join(root, "src/credentials.json"));
		await gitAdd(root, "src/config.json", "src/credentials.json");
		const asked: string[] = [];
		const index = new LexiconService(store, testProvider(asked), sourceReader(root), root, systemClock);
		await index.currentScope();
		expect(journalDenial(index, "src/config.json")).not.toBeNull();
		await index.indexFile("src/config.json");

		expect(store.declarationsIn("src/config.json").map(({ name, valueStatus }) => [name, valueStatus])).toEqual([
			["password", "set"],
		]);
		expect(index.findLiterals({ value: "SYMLINK_TARGET_SECRET" }).total).toBe(0);
		expect(asked).not.toContain("src/config.json");
		expect(journalDenial(index, "src/config.json")).not.toBeNull();
	});

	it("discovers ignored secret names with built-in case-insensitive globs", async () => {
		put(".gitignore", ".ENV.LOCAL\n");
		await gitAdd(root, ".gitignore");
		put(".ENV.LOCAL", "API_KEY=UPPERCASE_SECRET\n");
		const index = service();
		await index.warmupWorkspace();

		expect(store.declarationsIn(".ENV.LOCAL").map(({ name, valueStatus }) => [name, valueStatus])).toEqual([
			["API_KEY", "set"],
		]);
		expect(index.findLiterals({ value: "UPPERCASE_SECRET" }).total).toBe(0);
	});

	it("records a new ignored dotenv path through the watcher", async () => {
		put(".gitignore", "dist/\n");
		await gitAdd(root, ".gitignore");
		const index = service();
		await watch(index);
		const batches = spyOn(index, "applyBatch");
		expect(index.watchScope().watchesModule("dist/.env.local")).toBe(true);
		expect(index.watchScope().admits("dist/.env.local")).toBe(true);

		put("dist/.env.local", "API_KEY=NEW_IGNORED_SECRET\n");
		live?.inject("dist/.env.local");
		await waitFor(() =>
			batches.mock.calls.some(([events]) => events.some(({ module }) => module === "dist/.env.local")),
		);
		await live?.settled();

		const recorded = batches.mock.calls
			.flatMap(([events]) => events)
			.filter(({ module }) => module === "dist/.env.local");
		expect(recorded).toHaveLength(1);
		expect(store.declarationsIn("dist/.env.local")).toEqual([]);
		expect(index.findLiterals({ value: "NEW_IGNORED_SECRET" }).total).toBe(0);
		expect(index.findDocs({ text: "NEW_IGNORED_SECRET" }).total).toBe(0);
	});

	it("indexes untracked dotenv keys only, with status and a resolvable chain", async () => {
		put(".env.local", "API_KEY=TOP_SECRET\nEMPTY=\n");
		const asked: string[] = [];
		const index = service(asked);
		await index.indexFile(".env.local");

		expect(store.declarationsIn(".env.local").map(({ name, valueStatus }) => [name, valueStatus])).toEqual([
			["API_KEY", "set"],
			["EMPTY", "empty"],
		]);
		expect(index.findLiterals({ value: "TOP_SECRET" }).total).toBe(0);
		expect(index.findDocs({ text: "TOP_SECRET" }).total).toBe(0);
		expect(index.findComments({ text: "TOP_SECRET" }).total).toBe(0);
		expect(asked).toEqual([]);
		const key = store.declarationsIn(".env.local").find(({ name }) => name === "API_KEY");
		if (!key) throw new Error("expected the redacted key declaration");
		const source = await index.symbolSource({ symbolId: key.symbolId });
		expect(source).toMatchObject({
			found: true,
			text: "API_KEY",
			range: key.selectionRange,
			valueStatus: "set",
			spanHash: hashContent("API_KEY"),
		});
		if (source.found) expect(source.text).not.toContain("TOP_SECRET");
		expect(walkChain(store.declarationsIn(".env.local"), ["API_KEY"])).toMatchObject({
			kind: "exact",
			candidate: { name: "API_KEY", valueStatus: "set" },
		});
	});

	it("keeps the keys of an untracked dotenv file around lines it cannot read", async () => {
		put(
			".env.local",
			"API_KEY=JUNK_ONE\nsource ./other.sh\nnot an assignment JUNK_TWO\nTOKEN=JUNK_THREE\nEMPTY=\n",
		);
		const asked: string[] = [];
		const index = service(asked);
		const outcome = await index.indexFile(".env.local");

		expect(outcome.failure).toBeUndefined();
		expect(asked).toEqual([]);
		expect(store.declarationsIn(".env.local").map(({ name, valueStatus }) => [name, valueStatus])).toEqual([
			["API_KEY", "set"],
			["TOKEN", "set"],
			["EMPTY", "empty"],
		]);
		for (const value of ["JUNK_ONE", "JUNK_TWO", "JUNK_THREE"]) {
			expect(index.findLiterals({ value }).total).toBe(0);
			expect(index.findDocs({ text: value }).total).toBe(0);
		}
	});

	it("keeps the keys of a CRLF dotenv file and answers each as its name alone", async () => {
		put(".env.local", "FIRST=CRLF_ONE\r\nSECOND=CRLF_TWO\r\n");
		const index = service();
		const outcome = await index.indexFile(".env.local");
		const second = store.declarationsIn(".env.local").find(({ name }) => name === "SECOND");
		if (!second) throw new Error("expected the second key");

		expect(outcome.failure).toBeUndefined();
		expect(store.declarationsIn(".env.local").map(({ name }) => name)).toEqual(["FIRST", "SECOND"]);
		expect(await index.symbolSource({ symbolId: second.symbolId })).toMatchObject({ found: true, text: "SECOND" });
		expect(index.findDocs({ text: "CRLF_TWO" }).total).toBe(0);
	});

	it("declares a whole-file YAML key by the provider's spelling", async () => {
		put("lexicon.json", JSON.stringify({ secrets: { "**/keys.yaml": "redact" } }));
		put("keys.yaml", "on: ENABLED_VALUE\nyes: AGREED_VALUE\n");
		const index = service();
		await index.indexFile("keys.yaml");
		const idOf = (name: string) =>
			composeSymbolId({ language: "yaml", module: "keys.yaml", descriptors: [{ kind: "term", name }] });

		expect(store.declarationsIn("keys.yaml").map(({ symbolId }) => symbolId)).toEqual([idOf("on"), idOf("yes")]);
		expect(index.findLiterals({ value: "ENABLED_VALUE" }).total).toBe(0);
	});

	it("proves a Kubernetes-ruled file plain from its text, without reading it as a document", async () => {
		put("plain.json", '{"name":"ordinary","version":"1.0.0"}\n');
		const reads = spyOn(jsonFormat, "read");
		try {
			const index = service();
			await index.indexFile("plain.json");
			const edited = '{"name":"edited","version":"1.0.1"}\n';
			put("plain.json", edited);
			await index.applyBatch([{ kind: "changed", module: "plain.json", contentHash: hashContent(edited) }]);
			expect(reads).not.toHaveBeenCalled();

			put("secret.json", '{"kind":"Secret","data":{"token":"PREFILTER_VALUE"}}\n');
			await index.indexFile("secret.json");
			expect(reads).toHaveBeenCalled();
		} finally {
			reads.mockRestore();
		}
	});

	it("lets a tracked dotenv file keep its ordinary provider facts", async () => {
		put(".env", "API_KEY=TRACKED_VALUE\n");
		await gitAdd(root, ".env");
		const asked: string[] = [];
		const index = service(asked);
		await index.indexFile(".env");

		expect(asked).toEqual([".env"]);
		expect(index.findDocs({ text: "TRACKED_VALUE" }).total).toBe(1);
	});

	it("selects secret readers without case-sensitive suffixes", () => {
		expect(secretFormatFor("folder/.ENV.LOCAL")?.id).toBe("dotenv");
		expect(secretFormatFor("folder/CREDS.JSON")?.id).toBe("json");
		expect(secretFormatFor("folder/CONFIG.YAML")?.id).toBe("yaml");
	});

	it("uses the JSON symbol language for an uppercase whole-file secret", async () => {
		put("CREDENTIALS.JSON", '{"installed":{"client_secret":"CASE_SECRET"}}\n');
		const index = service();
		await index.indexFile("CREDENTIALS.JSON");
		const declaration = store.declarationsIn("CREDENTIALS.JSON").find(({ name }) => name === "client_secret");

		expect(declaration?.symbolId).toBe(
			composeSymbolId({
				language: "json",
				module: "CREDENTIALS.JSON",
				descriptors: [
					{ kind: "term", name: "installed" },
					{ kind: "term", name: "client_secret" },
				],
			}),
		);
	});

	it("classifies a tracked dotenv symlink by its ignored target", async () => {
		put(".gitignore", ".env.local\n");
		put(".env.local", "API_KEY=SYMLINK_SECRET\n");
		symlinkSync(".env.local", path.join(root, ".env"));
		await gitAdd(root, ".gitignore", ".env");
		const asked: string[] = [];
		const index = service(asked);
		await index.indexFile(".env");

		expect(asked).toEqual([]);
		expect(store.declarationsIn(".env").map(({ name, valueStatus }) => [name, valueStatus])).toEqual([
			["API_KEY", "set"],
		]);
		expect(index.findLiterals({ value: "SYMLINK_SECRET" }).total).toBe(0);
	});

	it("forgets a tracked file alias when its target becomes secret", async () => {
		const plain = '{"kind":"Deployment","data":{"token":"ALIAS_TRANSITION_SECRET"}}\n';
		const secret = '{"kind":"Secret","data":{"token":"ALIAS_TRANSITION_SECRET"}}\n';
		put("target.json", plain);
		symlinkSync("target.json", path.join(root, "alias.json"));
		await gitAdd(root, "target.json", "alias.json");
		const index = service();
		await index.warmupWorkspace();

		expect(store.literalsIn("alias.json").map(({ value }) => value)).toContain("ALIAS_TRANSITION_SECRET");

		put("target.json", secret);
		await index.applyBatch([{ kind: "changed", module: "target.json", contentHash: null }]);

		expect(store.literalsIn("alias.json").map(({ value }) => value)).not.toContain("ALIAS_TRANSITION_SECRET");
		expect(index.findLiterals({ value: "ALIAS_TRANSITION_SECRET" }).total).toBe(0);
		expect(store.contentHashOf("alias.json")).not.toBe(hashContent(plain));
	});

	it("forgets directory-link aliases when their target becomes secret", async () => {
		const plain = '{"kind":"Deployment","data":{"token":"DIR_ALIAS_SECRET"}}\n';
		const secret = '{"kind":"Secret","data":{"token":"DIR_ALIAS_SECRET"}}\n';
		put("target/config.json", plain);
		symlinkSync("target", path.join(root, "linked"));
		await gitAdd(root, "-A");
		const index = service();
		await index.indexFile("linked/config.json");

		expect(store.literalsIn("linked/config.json").map(({ value }) => value)).toContain("DIR_ALIAS_SECRET");
		const aliasesOf = spyOn(index.policy.evidence, "aliasesOf");

		put("target/config.json", secret);
		const outcomes = await index.applyBatch([{ kind: "changed", module: "target/config.json", contentHash: null }]);

		expect(aliasesOf).toHaveBeenCalledWith("target/config.json");
		expect(outcomes.map(({ module }) => module)).toContain("linked/config.json");
		expect(store.literalsIn("linked/config.json").map(({ value }) => value)).not.toContain("DIR_ALIAS_SECRET");
		expect(store.contentHashOf("linked/config.json")).not.toBe(hashContent(plain));
	});

	it("refreshes Git evidence before answering a dispatch read", async () => {
		put(".env", "API_KEY=READ_WINDOW_SECRET\n");
		await gitAdd(root, ".env");
		const index = service();
		await index.indexFile(".env");
		const dispatch = createDispatch(index);

		expect(await dispatch("findDocs", { text: "READ_WINDOW_SECRET" })).toMatchObject({ total: 1 });
		await gitRmCached(root, ".env");

		const answer = await dispatch("findDocs", { text: "READ_WINDOW_SECRET" });

		expect(answer).toMatchObject({ total: 0 });
	});

	it("refreshes lexicon config before answering a dispatch read", async () => {
		put("private.json", '{"password":"CONFIG_WINDOW_SECRET"}\n');
		const index = service();
		await index.indexFile("private.json");
		const dispatch = createDispatch(index);

		expect(await dispatch("findLiterals", { value: "CONFIG_WINDOW_SECRET" })).toMatchObject({ total: 1 });
		put("lexicon.json", JSON.stringify({ secrets: { "**/private.json": { password: "redact" } } }));

		const answer = await dispatch("findLiterals", { value: "CONFIG_WINDOW_SECRET" });

		expect(answer).toMatchObject({ total: 0 });
		expect(store.literalsIn("private.json")).toEqual([]);
	});

	it("forgets upgraded plaintext before a secret provider failure", async () => {
		put("config.json", '{"password":"UPGRADED_PLAINTEXT"}\n');
		await gitAdd(root, "config.json");
		const first = service();
		await first.indexFile("config.json");
		expect(first.findLiterals({ value: "UPGRADED_PLAINTEXT" }).total).toBe(1);
		store.journalWrite((db) => {
			db.prepare("UPDATE files SET policyStamp = NULL WHERE module = ?").run("config.json");
		});
		put("lexicon.json", JSON.stringify({ secrets: { "**/config.json": { password: "redact" } } }));
		const second = service([], new Set(["config.json"]));
		const outcome = await second.indexFile("config.json");

		expect(outcome.failure).toBe("secret file; details withheld");
		expect(second.findLiterals({ value: "UPGRADED_PLAINTEXT" }).total).toBe(0);
		expect(store.literalsIn("config.json")).toEqual([]);
		expect(store.contentHashOf("config.json")).toBeNull();
		expect(store.parseFailureOf("config.json")?.reason).toBe("secret file; details withheld");
	});

	it("reconciles old plaintext facts before a restarted service answers", async () => {
		const text = '{"password":"RESTARTED_PLAINTEXT"}\n';
		put("credentials.json", text);
		const start = text.indexOf("RESTARTED_PLAINTEXT");
		const range = coordinatesOf(text).rangeAt(start, start + "RESTARTED_PLAINTEXT".length);
		if (range === undefined) throw new Error("expected the legacy literal range");
		writePlain(store, {
			module: "credentials.json",
			contentHash: hashContent(text),
			declarations: [],
			references: [],
			literals: [{ kind: "string", value: "RESTARTED_PLAINTEXT", range }],
		});
		store.close();
		store = IndexStore.open(path.join(root, "index.sqlite")).store;
		const index = service();

		await index.gate.exclusive(() => index.reconcileSecretPolicy());

		expect(index.findLiterals({ value: "RESTARTED_PLAINTEXT" }).total).toBe(0);
		expect(store.contentHashOf("credentials.json")).toBeNull();
	});

	it("compares only the rows affected by a staged file", async () => {
		put("source.ts", "export {};\n");
		put("other.ts", "export {};\n");
		await gitAdd(root, "source.ts", "other.ts");
		const index = service();
		await index.currentScope();
		await index.gate.exclusive(() => store.pass(async () => index.indexer.reconcilePolicy()));
		writePlain(store, { module: "source.ts", contentHash: "source", declarations: [], references: [] });
		writePlain(store, { module: "other.ts", contentHash: "other", declarations: [], references: [] });

		put("added.ts", "export {};\n");
		await gitAdd(root, "added.ts");
		const stampQueries: Array<[string[], string[]]> = [];
		const policyStampsOf = store.policyStampsOf.bind(store);
		store.policyStampsOf = (modules, prefixes) => {
			stampQueries.push([[...modules], [...prefixes]]);
			return policyStampsOf(modules, prefixes);
		};
		await index.gate.exclusive(async () => {
			await index.policy.refresh({ kind: "events", modules: [], evidence: ["listing:"] });
			index.indexer.reconcilePolicy();
		});

		expect(stampQueries).toEqual([[["added.ts"], []]]);
		expect(store.contentHashOf("source.ts")).toBe("source");
		expect(store.contentHashOf("other.ts")).toBe("other");
	});

	it("restores the affected rows after a lost reconcile commit", async () => {
		put(".env", "API_KEY=private\n");
		await gitAdd(root, ".env");
		const index = service();
		await index.currentScope();
		await index.gate.exclusive(() => store.pass(async () => index.indexer.reconcilePolicy()));
		writePlain(store, { module: ".env", contentHash: "old", declarations: [], references: [] });
		await gitRmCached(root, ".env");
		const stampQueries: Array<[string[], string[]]> = [];
		const policyStampsOf = store.policyStampsOf.bind(store);
		store.policyStampsOf = (modules, prefixes) => {
			stampQueries.push([[...modules], [...prefixes]]);
			return policyStampsOf(modules, prefixes);
		};

		await index.gate.exclusive(async () => {
			await index.policy.refresh({ kind: "events", modules: [], evidence: ["listing:"] });
			failingCommit(store).arm();
			await store.pass(async () => index.indexer.reconcilePolicy()).catch(() => {});
			expect(store.contentHashOf(".env")).toBe("old");
			await store.pass(async () => index.indexer.reconcilePolicy());
		});

		expect(stampQueries).toEqual([
			[[".env"], []],
			[[".env"], []],
		]);
		expect(store.contentHashOf(".env")).toBeNull();
	});

	it("forgets a held module the scope denies even when its stamp already matches", async () => {
		const text = '{"password":"DENIED_HELD_SECRET"}\n';
		put("lexicon.json", JSON.stringify({ deny: ["denied.json"] }));
		put("denied.json", text);
		const index = service();
		await index.currentScope();
		const stamp = index.policy.current.answer("denied.json").stamp;
		const start = text.indexOf("DENIED_HELD_SECRET");
		const range = coordinatesOf(text).rangeAt(start, start + "DENIED_HELD_SECRET".length);
		if (range === undefined) throw new Error("expected the held literal range");
		store.replaceFile({
			module: "denied.json",
			contentHash: hashContent(text),
			admission: admit("denied.json", "plain", stamp),
			declarations: [],
			references: [],
			literals: [{ kind: "string", value: "DENIED_HELD_SECRET", range }],
		});

		await index.indexFile("denied.json");

		expect(index.findLiterals({ value: "DENIED_HELD_SECRET" }).total).toBe(0);
		expect(store.contentHashOf("denied.json")).toBeNull();
	});

	it("drops a stale plaintext failure row when the service restarts", async () => {
		put("credentials.json", '{"password":"FAILURE_ROW_SECRET"}\n');
		failPlain(store, "credentials.json", 'parse error near "FAILURE_ROW_SECRET"');
		store.close();
		store = IndexStore.open(path.join(root, "index.sqlite")).store;
		const index = service();

		await index.gate.exclusive(() => index.reconcileSecretPolicy());

		expect(store.parseFailureOf("credentials.json")).toBeNull();
		expect(index.indexStatus().failed.some(({ reason }) => reason.includes("FAILURE_ROW_SECRET"))).toBe(false);
	});

	it("forgets old facts before an abandoned policy-refresh batch returns", async () => {
		put("settings.json", '{"password":"ABANDONED_POLICY_SECRET"}\n');
		const index = service();
		await index.indexFile("settings.json");
		expect(index.findLiterals({ value: "ABANDONED_POLICY_SECRET" }).total).toBe(1);

		put("lexicon.json", JSON.stringify({ secrets: { "**/settings.json": { password: "redact" } } }));
		const outcomes = await index.applyBatch(
			[
				{ kind: "changed", module: "lexicon.json", contentHash: null },
				{ kind: "changed", module: "settings.json", contentHash: null },
			],
			() => true,
		);

		expect(outcomes).toEqual([]);
		expect(index.findLiterals({ value: "ABANDONED_POLICY_SECRET" }).total).toBe(0);
		expect(store.contentHashOf("settings.json")).toBeNull();
	});

	it("reads a whole-file secret's keys with no provider claiming it, and again when it changes", async () => {
		put(".env.local", "API_KEY=ONE\n");
		const index = new LexiconService(store, fakeSupervisor({ claims: [] }), sourceReader(root), root);
		await index.warmupWorkspace();
		const status = index.moduleStatus(".env.local");
		expect(store.declarationsIn(".env.local").map(({ name }) => name)).toEqual(["API_KEY"]);

		put(".env.local", "API_KEY=TWO\nOTHER=\n");
		const outcomes = await index.applyBatch([{ kind: "changed", module: ".env.local", contentHash: null }]);

		expect({ claimed: status.claimed, provider: status.provider }).toEqual({ claimed: true, provider: undefined });
		expect(outcomes).toContainEqual(expect.objectContaining({ module: ".env.local", action: "indexed" }));
		expect(store.declarationsIn(".env.local").map(({ name }) => name)).toEqual(["API_KEY", "OTHER"]);
	});

	it("forgets a keys row an older syntax version stamped, then reads the file again under the current one", async () => {
		put(".env.local", "API_KEY=ONE\n");
		const initialIndex = service();
		await initialIndex.currentScope();
		const secretPolicy = initialIndex.policy.current;
		const { secrets, deny, syntax } = secretPolicy.wire;
		const stampAt = (version: number) =>
			SecretJudge.fromEvidence(
				{ secrets, deny, syntax: version },
				{ tracked: null, aliasesByTarget: new Map(), targets: new Map() },
			).answer(".env.local").stamp;
		const current = secretPolicy.answer(".env.local").stamp;
		const older = stampAt(syntax - 1);
		expect(stampAt(syntax)).toBe(current);
		store.replaceFile({
			module: ".env.local",
			contentHash: "older",
			admission: admit(".env.local", "keys", older),
			declarations: [],
			references: [],
			literals: [],
		});
		store.close();
		store = IndexStore.open(path.join(root, "index.sqlite")).store;
		const asked: string[] = [];
		const index = service(asked);

		await index.gate.exclusive(() => index.reconcileSecretPolicy());
		const forgotten = store.contentHashOf(".env.local");
		await index.indexFile(".env.local");

		expect({
			moved: older !== current,
			forgotten,
			stamp: store.policyStampOf(".env.local"),
			keys: store.declarationsIn(".env.local").map(({ name }) => name),
			asked,
		}).toEqual({ moved: true, forgotten: null, stamp: current, keys: ["API_KEY"], asked: [] });
	});

	it("drops the plaintext a file held and words its fault by its verdict when it turns into a Secret", async () => {
		const value = "STALE_PLAINTEXT_VALUE";
		put("deploy.yaml", `kind: ConfigMap\ndata:\n  token: ${value}\n`);
		let failing = false;
		const supervisor = testProvider();
		const index = new LexiconService(
			store,
			{
				...supervisor,
				observeModule: (module) => {
					if (failing) throw new Error(`observe failed near ${value}`);
					supervisor.observeModule(module);
				},
			},
			sourceReader(root),
			root,
		);
		await index.indexFile("deploy.yaml");
		expect(index.findLiterals({ value }).total).toBe(1);

		put("deploy.yaml", `kind: Secret\ndata:\n  token: ${value}\n`);
		failing = true;
		const outcome = await index.indexFile("deploy.yaml");

		expect(outcome).toMatchObject({ action: "skipped", cause: "fault" });
		expect(index.findLiterals({ value }).total).toBe(0);
		expect(store.contentHashOf("deploy.yaml")).toBeNull();
		expect(JSON.stringify([outcome, store.parseFailureOf("deploy.yaml")])).not.toContain(value);
	});

	it("digests a masked document from its blanked text, so a hidden value never moves a digest", async () => {
		const documents = (value: string) =>
			`apiVersion: v1\nkind: Secret\ndata:\n  token: ${value}\n---\napiVersion: apps/v1\nkind: Deployment\n`;
		const index = service();
		const digestOfSecretRoot = async (value: string) => {
			put("multi-doc.yaml", documents(value));
			await index.indexFile("multi-doc.yaml");
			const root = store.declarationsIn("multi-doc.yaml").find(({ name }) => name === "[0]");
			return root === undefined ? undefined : store.patternDigestOf(root.symbolId);
		};

		const first = await digestOfSecretRoot("FIRST_HIDDEN");
		const second = await digestOfSecretRoot("SECOND_HIDDEN_AND_LONGER");

		expect(first).toBeDefined();
		expect(first).toEqual(second);
	});

	it("drops an outage noted while a file was plain once it is a Secret that parses", async () => {
		put("deploy.yaml", "kind: ConfigMap\ndata:\n  token: ordinary\n");
		let down = true;
		const supervisor = testProvider();
		const index = new LexiconService(
			store,
			{
				...supervisor,
				askProvider: async (providerId, method, params) => {
					if (down) throw new ProviderUnavailableError("provider exited");
					return supervisor.askProvider(providerId, method, params);
				},
			},
			sourceReader(root),
			root,
		);
		await index.indexFile("deploy.yaml");
		const noted = index.indexer.providerFailureOf("deploy.yaml");

		down = false;
		put("deploy.yaml", "kind: Secret\ndata:\n  token: HIDDEN\n");
		await index.indexFile("deploy.yaml");

		expect({ noted, kept: index.indexer.providerFailureOf("deploy.yaml") }).toEqual({
			noted: "provider exited",
			kept: null,
		});
	});

	it("records a provider outage on a masked file in the verdict's words, and on a plain file not at all", async () => {
		const value = "OUTAGE_VALUE";
		put("secret.yaml", `kind: Secret\ndata:\n  token: ${value}\n`);
		put("plain.yaml", `kind: ConfigMap\ndata:\n  token: ${value}\n`);
		const supervisor = testProvider();
		const index = new LexiconService(
			store,
			{
				...supervisor,
				askProvider: async () => {
					throw new ProviderUnavailableError(`provider exited near ${value}`);
				},
			},
			sourceReader(root),
			root,
		);

		const masked = await index.indexFile("secret.yaml");
		const plain = await index.indexFile("plain.yaml");

		expect(masked).toMatchObject({ cause: "providerDown" });
		expect(JSON.stringify([masked, store.parseFailureOf("secret.yaml")])).not.toContain(value);
		expect(store.parseFailureOf("secret.yaml")).not.toBeNull();
		expect(plain).toMatchObject({ cause: "providerDown" });
		expect(plain.failure).toContain(value);
		expect(store.parseFailureOf("plain.yaml")).toBeNull();
	});

	it("keeps an index write's own words out of a masked file's failure, and in a plain one's", async () => {
		const value = "WRITE_FAULT_VALUE";
		put("secret.yaml", `kind: Secret\ndata:\n  token: ${value}\n`);
		put("plain.yaml", `kind: ConfigMap\ndata:\n  token: ${value}\n`);
		const replaceFile = store.replaceFile.bind(store);
		store.replaceFile = (...args: Parameters<IndexStore["replaceFile"]>) => {
			if (args[0].module.endsWith(".yaml")) throw new Error(`write failed near ${value}`);
			return replaceFile(...args);
		};
		const index = service();

		const masked = await index.indexFile("secret.yaml");
		const plain = await index.indexFile("plain.yaml");

		expect(masked).toMatchObject({ cause: "fault" });
		expect(JSON.stringify([masked, store.parseFailureOf("secret.yaml")])).not.toContain(value);
		expect(plain).toMatchObject({ cause: "fault" });
		expect(plain.failure).toContain(value);
		expect(store.parseFailureOf("plain.yaml")?.reason).toContain(value);
	});

	it("words a fault that escaped before any verdict by the module's answer alone", async () => {
		put(".env.local", "API_KEY=ESCAPED_VALUE\n");
		put("plain.txt", "ordinary\n");
		const initialIndex = service();
		await initialIndex.currentScope();
		const secretPolicy = initialIndex.policy.current;
		store.replaceFile({
			module: ".env.local",
			contentHash: "held",
			admission: secretPolicy.admission(".env.local"),
			declarations: [],
			references: [],
			literals: [],
		});
		const reader = sourceReader(root);
		const index = new LexiconService(
			store,
			testProvider(),
			(module) => {
				if (module === ".env.local" || module === "plain.txt") throw new Error(`read failed near ${module}`);
				return reader(module);
			},
			root,
		);

		const outcomes = await index.warmupWorkspace();

		expect(outcomes).toContainEqual(expect.objectContaining({ module: ".env.local", cause: "fault" }));
		expect(outcomes).toContainEqual(expect.objectContaining({ module: "plain.txt", cause: "fault" }));
		expect(store.contentHashOf(".env.local")).toBeNull();
		expect(store.parseFailureOf(".env.local")?.reason).not.toContain("read failed");
		expect(store.parseFailureOf("plain.txt")?.reason).toContain("read failed");
	});

	it("masks a Kubernetes Secret document and leaves a Deployment document plain", async () => {
		const text = [
			"apiVersion: v1",
			"kind: Secret",
			"data:",
			"  token: SECRET_BASE64_VALUE",
			"---",
			"apiVersion: apps/v1",
			"kind: Deployment",
			"metadata:",
			"  name: deployment-name",
			"replicas: 1",
			"",
		].join("\n");
		put("multi-doc.yaml", text);
		const index = service();
		await index.indexFile("multi-doc.yaml");

		expect(index.findLiterals({ value: "SECRET_BASE64_VALUE" }).total).toBe(0);
		expect(index.findLiterals({ value: "deployment-name" }).total).toBe(1);
		expect(index.findByName("token")[0]?.valueStatus).toBe("set");
		const secretRoot = store.declarationsIn("multi-doc.yaml").find(({ name }) => name === "[0]");
		const deploymentRoot = store.declarationsIn("multi-doc.yaml").find(({ name }) => name === "[1]");
		if (!secretRoot || !deploymentRoot) throw new Error("expected document root declarations");
		const secretSource = await index.symbolSource({ symbolId: secretRoot.symbolId });
		const deploymentSource = await index.symbolSource({ symbolId: deploymentRoot.symbolId });
		expect(secretSource.found).toBe(true);
		if (secretSource.found) {
			expect(secretSource.text).toContain("(redacted)");
			expect(secretSource.text).not.toContain("SECRET_BASE64_VALUE");
		}
		expect(deploymentSource.found).toBe(true);
		if (deploymentSource.found) {
			expect(deploymentSource.text).toContain("deployment-name");
			expect(deploymentSource.text).not.toContain("(redacted)");
		}
		const deploymentLiteral = index.findLiterals({ value: "deployment-name" }).literals[0];
		if (!deploymentLiteral) throw new Error("expected the Deployment literal");
		const source = await index.symbolSource({ factId: deploymentLiteral.factId });
		expect(source).toMatchObject({ found: true, text: "deployment-name" });
	});

	it("adds reader declarations when a masked provider omitted the key", async () => {
		put("lexicon.json", JSON.stringify({ secrets: { "**/config.json": { password: "redact" } } }));
		put("config.json", '{"password":"READER_ONLY_SECRET","public":"visible"}\n');
		const index = service([], new Set(), new Map([["config.json", new Set(["password"])]]));
		await index.indexFile("config.json");

		expect(store.declarationsIn("config.json")).toContainEqual(
			expect.objectContaining({ name: "password", valueStatus: "set" }),
		);
		expect(index.findByName("password", "config.json")[0]?.valueStatus).toBe("set");
		expect(index.findLiterals({ value: "READER_ONLY_SECRET" }).total).toBe(0);
		expect(index.findLiterals({ value: "visible" }).total).toBe(1);
	});

	it("redacts data under Kubernetes List items", async () => {
		put(
			"list.yaml",
			"kind: List\nitems:\n  - kind: Secret\n    data:\n      token: LIST_SECRET_VALUE\n  - kind: ConfigMap\n    data:\n      name: LIST_CONFIGMAP_VALUE\n",
		);
		const index = service();
		await index.indexFile("list.yaml");

		expect(index.findLiterals({ value: "LIST_SECRET_VALUE" }).total).toBe(0);
		expect(index.findLiterals({ value: "LIST_CONFIGMAP_VALUE" }).total).toBe(0);
		expect(store.declarationsIn("list.yaml").filter(({ name }) => name === "data")).toHaveLength(2);
	});

	it("masks an omitted value inside its parent source slice", async () => {
		put("lexicon.json", JSON.stringify({ secrets: { "**/settings.yaml": { "deploy.prod.password": "omit" } } }));
		put("settings.yaml", "deploy:\n  prod:\n    password: OMITTED_PASSWORD\n    region: local\n");
		const index = service();
		await index.indexFile("settings.yaml");

		const deploy = store.declarationsIn("settings.yaml").find(({ name }) => name === "deploy");
		if (!deploy) throw new Error("expected the parent declaration");
		const source = await index.symbolSource({ symbolId: deploy.symbolId });
		expect(source.found).toBe(true);
		if (source.found) {
			expect(source.text).toContain("(redacted)");
			expect(source.text).toContain("region: local");
			expect(source.text).not.toContain("OMITTED_PASSWORD");
		}
	});

	it("allows journaling plain YAML and refuses a matching Secret file", async () => {
		const plain = "kind: Deployment\nmetadata:\n  name: public-service\n";
		const secret = "kind: Secret\ndata:\n  token: JOURNAL_SECRET_VALUE\n";
		put("plain.yaml", plain);
		put("secret.yaml", secret);
		await gitAdd(root, "plain.yaml", "secret.yaml");
		const index = service();
		await index.currentScope();
		const transactions = new TransactionManager(store, root, index.policy);
		transactions.start();

		expect(transactions.track("plain.yaml")).toMatchObject({ tracked: true });
		expect(transactions.track("secret.yaml")).toMatchObject({
			tracked: false,
			reason: expect.stringContaining("secret file"),
		});
		expect(store.heldImage("secret.yaml", hashBytes(Buffer.from(secret)))).toBeNull();
		expect((await index.planInsert({ module: "plain.yaml", text: "extra: visible" })).state).toBe("planned");
		expect((await index.planInsert({ module: "secret.yaml", text: "extra: hidden" })).state).toBe("refused");
	});

	it("prunes retained journal images when a file becomes secret", async () => {
		const text = '{"password":"JOURNAL_RECLASSIFIED_SECRET"}\n';
		put("journaled.json", text);
		await gitAdd(root, "journaled.json");
		const index = service();
		await index.indexFile("journaled.json");
		const transactions = new TransactionManager(store, root, index.policy);
		index.attachJournal(transactions);
		transactions.start();
		expect(transactions.track("journaled.json").tracked).toBe(true);
		expect(transactions.commit().committed).toBe(true);

		const imageHash = hashBytes(Buffer.from(text));
		expect(store.heldImage("journaled.json", imageHash)?.bytes).not.toBeNull();
		put("lexicon.json", JSON.stringify({ secrets: { "**/journaled.json": "redact" } }));
		await index.applyBatch([{ kind: "changed", module: "lexicon.json", contentHash: null }]);

		expect(store.heldImage("journaled.json", imageHash)).toBeNull();
		expect(transactions.settledImage(1, "journaled.json", "opened").held).toBe(false);
	});

	it("purges a historical secret image when the current document no longer matches", async () => {
		const before = '{"password":"HISTORICAL_IMAGE_SECRET"}\n';
		put("settings.json", before);
		const index = service();
		await index.indexFile("settings.json");
		const transactions = new TransactionManager(store, root, index.policy);
		index.attachJournal(transactions);
		transactions.start();
		expect(transactions.track("settings.json").tracked).toBe(true);
		expect(transactions.commit().committed).toBe(true);
		const imageHash = hashBytes(Buffer.from(before));
		expect(store.heldImage("settings.json", imageHash)?.bytes).not.toBeNull();

		put("lexicon.json", JSON.stringify({ secrets: { "**/settings.json": { password: "redact" } } }));
		put("settings.json", '{"kind":"Deployment","name":"public"}\n');
		await index.applyBatch([{ kind: "changed", module: "lexicon.json", contentHash: null }]);

		expect(journalDenial(index, "settings.json")).toBeNull();
		expect(store.heldImage("settings.json", imageHash)).toBeNull();
		expect(transactions.settledImage(1, "settings.json", "opened").held).toBe(false);
	});

	it("reconciles journal-only modules when the policy revision moves", async () => {
		put(".gitignore", "journal-only.yaml\n");
		await gitAdd(root, ".gitignore");
		put("journal-only.yaml", "password: JOURNAL_POLICY_SECRET\n");
		const index = service();
		const initialScope = await index.currentScope();
		const initialRevision = index.policy.current.revision;
		expect(initialScope.allows("journal-only.yaml")).toBe(false);
		const transactions = new TransactionManager(store, root, index.policy);
		index.attachJournal(transactions);
		transactions.start();
		expect(transactions.track("journal-only.yaml").tracked).toBe(true);
		const originalHash = hashBytes(Buffer.from("password: JOURNAL_POLICY_SECRET\n"));
		expect(store.contentHashOf("journal-only.yaml")).toBeNull();
		expect(store.heldImage("journal-only.yaml", originalHash)?.bytes).not.toBeNull();

		put("lexicon.json", JSON.stringify({ secrets: { "**/journal-only.yaml": { password: "redact" } } }));
		await index.applyBatch([{ kind: "changed", module: "lexicon.json", contentHash: null }]);
		expect(index.policy.current.revision).not.toBe(initialRevision);
		expect(journalDenial(index, "journal-only.yaml")).not.toBeNull();
		expect(store.depthOf("journal-only.yaml")).toBeNull();
		expect(store.heldImage("journal-only.yaml", originalHash)).toBeNull();
		expect(transactions.commit().committed).toBe(true);
	});

	it("prunes orphan blobs during startup secret reconciliation", () => {
		const index = service();
		const transactions = new TransactionManager(store, root, index.policy);
		const orphan = index.policy.admitBytes("orphan.json", Buffer.from("unreferenced"));
		if (orphan.kind !== "admitted") throw new Error("expected a plain orphan image");
		store.putBlob(orphan.value);
		expect(store.heldImage(orphan.value.module, orphan.value.hash)).not.toBeNull();
		expect(transactions.readmit()).toEqual({ purged: 0 });
		expect(store.heldImage(orphan.value.module, orphan.value.hash)).toBeNull();
	});

	it("does not inspect journal images when the module answer is plain", async () => {
		const text = "export const cart = 1;\n";
		put("cart.ts", text);
		const index = service();
		await index.currentScope();
		let imageReads = 0;
		const transactions = new TransactionManager(store, root, index.policy);
		transactions.start();
		expect(transactions.track("cart.ts").tracked).toBe(true);
		imageReads = 0;
		const heldImage = store.heldImage.bind(store);
		store.heldImage = (module, hash) => {
			imageReads++;
			return heldImage(module, hash);
		};

		expect(transactions.readmit()).toEqual({ purged: 0 });
		expect(imageReads).toBe(0);
		expect(store.heldImage("cart.ts", hashBytes(Buffer.from(text)))?.bytes).not.toBeNull();
	});

	it("does not persist an unchanged policy on a scope refresh", async () => {
		put("lexicon.json", JSON.stringify({ secrets: {} }));
		const index = service();
		await index.currentScope();
		let writes = 0;
		const remember = store.rememberSecretPolicy.bind(store);
		store.rememberSecretPolicy = (policy) => {
			writes++;
			remember(policy);
		};

		await index.applyBatch([], undefined, ["repositories", "listing:"]);
		expect(writes).toBe(0);
	});

	it("uses only built-ins before scope is computed", () => {
		const ordinary = "export class Cart {}\n";
		const secret = "API_KEY=UNTRACKED_SECRET_VALUE\n";
		put("cart.ts", ordinary);
		put(".env.local", secret);
		const index = service();
		const transactions = new TransactionManager(store, root, index.policy);
		transactions.start();

		expect(journalDenial(index, "cart.ts")).toBeNull();
		expect(transactions.track("cart.ts")).toMatchObject({ tracked: true });
		expect(transactions.track(".env.local")).toMatchObject({
			tracked: false,
			reason: expect.stringContaining("secret file"),
		});
		expect(store.heldImage(".env.local", hashBytes(Buffer.from(secret)))).toBeNull();
	});

	it("loads the project policy before answering the first scope", async () => {
		put("lexicon.json", JSON.stringify({ secrets: { "**/settings.json": { password: "redact" } } }));
		put("settings.json", '{"password":"PROJECT_SECRET_VALUE"}\n');
		const index = new LexiconService(store, testProvider(), sourceReader(root), root, systemClock);
		await index.currentScope();

		expect(journalDenial(index, "settings.json")).not.toBeNull();
		const outcome = await index.indexFile("settings.json");
		expect(outcome.failure).toBeUndefined();
		expect(index.findLiterals({ value: "PROJECT_SECRET_VALUE" }).total).toBe(0);
	});

	it("refuses a literal fact address when the current rule hides its value", async () => {
		put("lexicon.json", JSON.stringify({ secrets: { "**/manifest.yaml": {} } }));
		put("manifest.yaml", "kind: Secret\ndata:\n  token: STORED_BEFORE_POLICY\n");
		const first = service();
		await first.indexFile("manifest.yaml");
		const literal = first.findLiterals({ value: "STORED_BEFORE_POLICY" }).literals[0];
		if (!literal) throw new Error("expected the pre-policy literal fact");

		put("lexicon.json", JSON.stringify({}));
		const second = service();
		await second.currentScope();
		const source = await second.symbolSource({ factId: literal.factId });
		expect(source.found).toBe(false);
		if (!source.found) expect(source.reason).toContain("secret file");
	});

	it("omits a configured key and its subtree", async () => {
		put("lexicon.json", JSON.stringify({ secrets: { "**/settings.yaml": { "service.private": "omit" } } }));
		put(
			"settings.yaml",
			"service:\n  private:\n    password: OMITTED_PASSWORD\n    nested:\n      token: OMITTED_TOKEN\n  public: visible\n",
		);
		const index = service();
		await index.indexFile("settings.yaml");

		expect(store.declarationsIn("settings.yaml").map(({ name }) => name)).toEqual(["service", "public"]);
		expect(index.findLiterals({ value: "OMITTED_PASSWORD" }).total).toBe(0);
		expect(index.findLiterals({ value: "OMITTED_TOKEN" }).total).toBe(0);
		expect(index.findLiterals({ value: "visible" }).total).toBe(1);
	});

	it("omits matching keys inside a whole-file redaction", async () => {
		put(
			"lexicon.json",
			JSON.stringify({
				secrets: {
					"**/credentials.json": "redact",
					"**/*.json": { "installed.client_secret": "omit" },
				},
			}),
		);
		put("credentials.json", '{"installed":{"client_secret":"OMITTED_SECRET","client_id":"PUBLIC_ID"}}\n');
		const index = service();
		await index.indexFile("credentials.json");

		expect(store.declarationsIn("credentials.json").map(({ name }) => name)).toEqual(["installed", "client_id"]);
		expect(index.findLiterals({ value: "OMITTED_SECRET" }).total).toBe(0);
		expect(index.findLiterals({ value: "PUBLIC_ID" }).total).toBe(0);
		expect(index.findByName("client_id", "credentials.json")[0]?.valueStatus).toBe("set");
	});

	it("indexes a whole-file omission without facts or provider reads", async () => {
		put("lexicon.json", JSON.stringify({ deny: ["denied/**"] }));
		put(".gitignore", "server.key\n");
		put("server.key", "PRIVATE_KEY_BYTES\n");
		put("public.json", '{"name":"public"}\n');
		put("denied/blocked.json", '{"password":"DENIED_BYTES"}\n');
		await gitAdd(root, "lexicon.json", ".gitignore", "public.json", "denied/blocked.json");
		const asked: string[] = [];
		const index = service(asked);
		await index.warmupWorkspace();
		const scope = await index.currentScope();
		const omitted = index.moduleStatus("server.key");
		const view = index.policy.current.view(sourceReader(root)("server.key"));
		const publicDeclaration = store.declarationsIn("public.json")[0];
		if (publicDeclaration === undefined) throw new Error("expected a public declaration");
		const reference = formatRef(workspaceKey(root), "server.key", []);
		const note = index.writeNote({
			symbolId: publicDeclaration.symbolId,
			text: `Uses the key file at [the key](${reference}).`,
			expectedRevision: 0,
		});

		expect([scope.known?.has("server.key"), scope.denies("server.key")]).toEqual([true, false]);
		expect(omitted).toMatchObject({ exists: true, claimed: true, indexed: true });
		expect(index.policy.current.admission("server.key").as).toBe("omit");
		expect(index.policy.current.access("server.key")).toBe("closed");
		expect(store.policyStampOf("server.key")).toBe(index.policy.current.admission("server.key").stamp);
		expect(view.kind).toBe("refused");
		if (view.kind === "refused") expect(store.contentHashOf("server.key")).toBe(view.hash);
		expect(store.depthOf("server.key")).toBe("full");
		expect(store.declarationsIn("server.key")).toEqual([]);
		expect(store.literalsIn("server.key")).toEqual([]);
		expect(store.referencesIn("server.key")).toEqual([]);
		expect(store.importsIn("server.key")).toEqual([]);
		expect(store.commentsIn("server.key")).toEqual([]);
		expect(store.docsToScan(20, { module: "server.key", hidden: store.hiddenModules(undefined) })).toEqual([]);
		expect(await index.moduleSecretModes(["server.key"])).toEqual([{ module: "server.key", mode: "omit" }]);
		expect(asked).not.toContain("server.key");
		expect(journalDenial(index, "server.key")).not.toBeNull();
		expect(note.outcome).toBe("saved");
		expect(index.readNote(publicDeclaration.symbolId)?.links).toContainEqual(
			expect.objectContaining({ written: reference, kind: "file", state: "ok" }),
		);
		expect(index.moduleStatus("denied/blocked.json")).toMatchObject({ exists: false, indexed: false });
		expect(store.contentHashOf("denied/blocked.json")).toBeNull();
		expect(index.findLiterals({ value: "PRIVATE_KEY_BYTES" }).total).toBe(0);
		expect(index.findLiterals({ value: "DENIED_BYTES" }).total).toBe(0);
	});

	it("reparses unchanged text when its effective policy changes", async () => {
		put("manifest.yaml", "kind: Deployment\npassword: HIDDEN_AFTER_POLICY_CHANGE\n");
		const asked: string[] = [];
		const first = service(asked);
		await first.indexFile("manifest.yaml");
		expect(asked).toHaveLength(1);

		put("lexicon.json", JSON.stringify({ secrets: { "**/manifest.yaml": { password: "redact" } } }));
		const second = service(asked);
		await second.indexFile("manifest.yaml", "full", true);

		expect(asked).toHaveLength(2);
		expect(second.findLiterals({ value: "HIDDEN_AFTER_POLICY_CHANGE" }).total).toBe(0);
		expect(second.findByName("password")[0]?.valueStatus).toBe("set");
		await second.indexFile("manifest.yaml", "full", true);
		expect(asked).toHaveLength(2);
	});

	it("hashes only the allowed view of a masked file", async () => {
		put("lexicon.json", JSON.stringify({ secrets: { "**/config.json": { password: "redact" } } }));
		put("config.json", '{"password":"SAME_VALUE_1","public":"visible"}\n');
		const asked: string[] = [];
		const index = service(asked);
		await index.indexFile("config.json");
		const storedHash = store.contentHashOf("config.json");
		if (storedHash === null) throw new Error("expected an indexed config file");

		expect(storedHash).not.toBe(hashContent('{"password":"SAME_VALUE_1","public":"visible"}\n'));
		expect(index.moduleDeclarations("config.json").diskHash).toBe(storedHash);
		put("config.json", '{"password":"SAME_VALUE_2","public":"visible"}\n');
		expect(index.moduleDeclarations("config.json").contentHash).toBe(storedHash);
		expect(index.moduleDeclarations("config.json").diskHash).toBe(storedHash);

		await index.indexFile("config.json", "full", true);
		expect(asked).toHaveLength(1);
		expect(index.findLiterals({ value: "SAME_VALUE_2" }).total).toBe(0);
	});

	it("hashes hidden values after collapsing their line breaks", async () => {
		const first = "kind: Secret\nstringData:\n  token: |-\n    abcd\n    ef\n    ghij\n";
		const second = "kind: Secret\nstringData:\n  token: |-\n    a\n    bcdef\n    ghij\n";
		put("secret.yaml", first);
		const index = service();
		await index.indexFile("secret.yaml");
		const firstHash = store.contentHashOf("secret.yaml");

		put("secret.yaml", second);
		await index.indexFile("secret.yaml", "full", true);
		const secondHash = store.contentHashOf("secret.yaml");

		expect(firstHash).not.toBeNull();
		expect(secondHash).toBe(firstHash);
	});

	it("keeps one hash for a guarded file in the index, the drift check, the declarations and the watcher", async () => {
		put("lexicon.json", JSON.stringify({ secrets: { "**/config.json": { password: "redact" } } }));
		put("config.json", '{"password":"SAME_VALUE_1","public":"visible"}\n');
		put(".env.local", "API_KEY=ONE_VALUE\nEMPTY=\n");
		const index = service();
		await index.indexFile("config.json");
		await index.indexFile(".env.local");

		for (const module of ["config.json", ".env.local"]) {
			const stored = store.contentHashOf(module);
			const read = sourceReader(root)(module);
			if (stored === null || read.kind !== "text") throw new Error("expected an indexed text file");

			expect(stored).not.toBe(hashContent(readFileSync(path.join(root, module), "utf8")));
			expect({
				view: index.hashOfRead(read),
				declarations: index.moduleDeclarations(module).diskHash,
				drift: index.currentHashOf(module),
				event: readEvent(root, module, (each) => index.hashOfRead(each)),
			}).toEqual({
				view: stored,
				declarations: stored,
				drift: stored,
				event: { kind: "changed", module, contentHash: stored },
			});
		}
	});

	it("moves a guarded file's hash with a hidden value's length and not with its content", async () => {
		put(".env.local", "API_KEY=ONE_VALUE\n");
		const index = service();
		await index.indexFile(".env.local");

		put(".env.local", "API_KEY=TWO_VALUE\n");
		expect(index.staleModules([".env.local"])).toEqual([]);
		put(".env.local", "API_KEY=A_LONGER_VALUE\n");
		expect(index.staleModules([".env.local"])).toEqual([".env.local"]);
	});

	it("stages no rename edit over a file with hidden values", async () => {
		put(".env.local", "API_KEY=ONE_VALUE\n");
		put("plain.txt", "API_KEY=ONE_VALUE\n");
		const index = service();
		await index.indexFile(".env.local");
		const edit = { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 7 } }, newText: "KEY" };
		const staged = (module: string) => index.renameWrites([{ module, contentHash: "h", edits: [edit] }]);

		expect("reason" in staged(".env.local")).toBe(true);
		expect(staged("plain.txt")).toEqual({ writes: [{ module: "plain.txt", base: "h", text: "KEY=ONE_VALUE\n" }] });
	});

	it("refreshes policy when lexicon.json changes", async () => {
		const text = "kind: Deployment\npassword: WATCHED_SECRET\n";
		put("manifest.yaml", text);
		await gitAdd(root, "manifest.yaml");
		const asked: string[] = [];
		const index = service(asked);
		await index.indexFile("manifest.yaml");
		await watch(index);

		put(
			"lexicon.json",
			JSON.stringify({
				secrets: {
					"**/manifest.yaml": { password: "redact" },
					"**/private.json": { "@untracked": "omit" },
				},
			}),
		);
		live?.inject("lexicon.json");
		await waitFor(() => asked.filter((module) => module === "manifest.yaml").length === 2);
		await live?.settled();

		expect(index.findLiterals({ value: "WATCHED_SECRET" }).total).toBe(0);
		expect(
			store.declarationsIn("manifest.yaml").map(({ name, valueStatus }) => [name, valueStatus]),
		).toContainEqual(["password", "set"]);
		expect(index.findByName("password", "manifest.yaml")[0]?.valueStatus).toBe("set");
		expect(index.policy.current.access("private.json")).toBe("closed");
	});

	it("logs evidence drift found by the hourly audit", async () => {
		put("source.ts", "export const source = true;\n");
		await gitAdd(root, "source.ts");
		const index = service();
		await index.currentScope();
		const logged = spyOn(console, "log").mockImplementation(() => {});
		try {
			put("added.ts", "export const added = true;\n");
			await gitAdd(root, "added.ts");
			await index.indexer.auditPolicy();
			expect(logged).toHaveBeenCalledWith("secret policy evidence drift");
		} finally {
			logged.mockRestore();
		}
	});

	it("does not reparse plain files when Git tracking changes their status", async () => {
		put("plain.json", '{"kind":"Deployment","name":"ordinary"}\n');
		const asked: string[] = [];
		const index = service(asked);
		// Workspace indexing starts at roots.
		await index.indexWorkspace();
		const batches = spyOn(index, "applyBatch");
		await watch(index);
		const parsesBeforeTracking = asked.length;

		await gitAdd(root, "plain.json");
		await waitFor(() => batches.mock.calls.some(([, , evidence]) => evidence?.includes("listing:") === true));
		await live?.settled();

		const tracking = index.policy.evidence.current()?.collected.tracking;
		if (tracking === undefined) throw new Error("expected collected tracking evidence");
		expect({
			tracked: tracking.kind === "tracked" && tracking.files.has("plain.json"),
			parses: asked.length,
		}).toEqual({ tracked: true, parses: parsesBeforeTracking });
	});

	it("does not reparse an indexed plain file that a Git refresh newly reaches", async () => {
		put("plain.json", '{"kind":"Deployment","name":"ordinary"}\n');
		const asked: string[] = [];
		const index = service(asked);
		// Unrooted files are not scanned.
		await index.indexFile("plain.json");
		await gitAdd(root, "plain.json");

		await index.applyBatch([], undefined, ["repositories", "listing:"]);

		expect(asked).toEqual(["plain.json"]);
	});

	it("reads a live batch's plain file only to parse it, and a secret file to assess it", async () => {
		const text = "export const cart = 1;\n";
		put("cart.ts", text);
		put(".env.local", "API_KEY=PREFLIGHT_VALUE\n");
		const reads: string[] = [];
		const read = sourceReader(root);
		const index = new LexiconService(
			store,
			testProvider(),
			(module) => {
				reads.push(module);
				return read(module);
			},
			root,
		);
		await index.indexFile("cart.ts");
		await index.indexFile(".env.local");

		reads.length = 0;
		await index.applyBatch([{ kind: "changed", module: "cart.ts", contentHash: hashContent(text) }]);
		expect(reads).toEqual([]);

		const edited = "export const cart = 2;\n";
		put("cart.ts", edited);
		await index.applyBatch([{ kind: "changed", module: "cart.ts", contentHash: hashContent(edited) }]);
		expect(reads.filter((module) => module === "cart.ts")).toEqual(["cart.ts"]);

		reads.length = 0;
		const outcomes = await index.applyBatch([{ kind: "changed", module: ".env.local", contentHash: null }]);
		expect(reads).toEqual([".env.local"]);
		expect(outcomes.map(({ cause }) => cause)).toEqual(["current"]);
	});

	it("admits a path an include names after startup", async () => {
		put(".gitignore", "vendor/\n");
		await gitAdd(root, ".gitignore");
		// Binary: never indexed.
		mkdirSync(path.join(root, "vendor"));
		writeFileSync(path.join(root, "vendor/blob.bin"), Buffer.from([0x41, 0x00, 0x42]));
		const index = service();
		await index.currentScope();
		const scope = index.watchScope();
		expect(scope.admits("vendor/blob.bin")).toBe(false);

		put("lexicon.json", JSON.stringify({ include: ["vendor/**"] }));
		await index.applyBatch([{ kind: "changed", module: "lexicon.json", contentHash: null }]);

		expect(scope.admits("vendor/blob.bin")).toBe(true);
	});

	it("skips a submodule added after startup without collecting its evidence", async () => {
		const source = mkdtempSync(path.join(tmpdir(), "lexicon-secrets-sub-"));
		additionalRoots.push(source);
		await gitInit(source);
		writeFileSync(path.join(source, ".env"), "API_KEY=SUBMODULE_SECRET\n");
		await gitAdd(source, ".env");
		await gitCommit(source, "tracked dotenv");
		put("lexicon.json", JSON.stringify({ include: ["sub/**"] }));
		put(".gitignore", "index.sqlite*\n");
		const gitCalls: Array<{ cwd: string; args: string[] }> = [];
		const countingGit: GitRunner = (clock, cwd, args, options) => {
			gitCalls.push({ cwd, args: [...args] });
			return runGit(clock, cwd, args, options);
		};
		const policy = testPolicy(root, undefined, store, countingGit);
		const asked: string[] = [];
		const index = new LexiconService(store, testProvider(asked), sourceReader(root), root, systemClock, policy);
		await watch(index);
		expect(policy.evidence.current()?.collected.repositories.map(({ prefix }) => prefix)).toEqual([""]);

		await gitSubmoduleAdd(root, source, "sub");
		await waitForScope(
			index,
			() => index.policy.evidence.current()?.collected.repositories[0]?.gitlinks.has("sub") === true,
		);
		await live?.settled();
		const collected = policy.evidence.current()?.collected;
		expect(collected?.repositories.map(({ prefix }) => prefix)).toEqual([""]);
		const subscriptions = index.watchScope().subscriptions();
		expect(subscriptions.map(({ path: subscribed }) => subscribed)).toContain(path.join(root, ".git", "index"));
		expect(subscriptions.some(({ path: subscribed }) => subscribed.includes(path.join(".git", "modules")))).toBe(
			false,
		);
		expect(collected?.modules.has("sub/.env")).toBe(false);
		expect(gitCalls.some(({ cwd }) => cwd === path.join(root, "sub"))).toBe(false);
		expect(index.watchScope().admits("sub/.env")).toBe(false);
		expect(policy.current.answer("sub/.env").kind).toBe("wholeRedact");
		expect(index.findLiterals({ value: "SUBMODULE_SECRET" }).total).toBe(0);
		expect(store.declarationsIn("sub/.env")).toEqual([]);
		expect(asked).not.toContain("sub/.env");
	});

	it("judges static and currently untracked whole-file secrets", async () => {
		put(".env", "API_KEY=TRACKED_VALUE\n");
		put(".env.local", "API_KEY=UNTRACKED_VALUE\n");
		put("credentials.json", '{"password":"CREDENTIAL_VALUE"}\n');
		await gitAdd(root, ".env");
		const index = service();
		await index.currentScope();

		expect(index.policy.current.access("credentials.json")).toBe("bytes");
		expect(index.policy.current.access(".env.local")).toBe("bytes");
		expect(index.policy.current.access(".env")).toBe("open");
		expect(index.policy.current.answer(".env").kind).toBe("plain");
	});

	it("redacts a tracked dotenv file after the Git index drops it", async () => {
		put(".gitignore", ".env\n");
		put(".env", "API_KEY=TRACKED_SECRET\n");
		await gitAdd(root, "-f", ".gitignore", ".env");
		const index = service();
		await index.indexFile(".env");
		expect(index.findDocs({ text: "TRACKED_SECRET" }).total).toBe(1);
		await watch(index);

		await gitRmCached(root, ".env");
		await waitFor(
			() =>
				store
					.declarationsIn(".env")
					.some(({ name, valueStatus }) => name === "API_KEY" && valueStatus === "set") &&
				index.findDocs({ text: "TRACKED_SECRET" }).total === 0,
		);
		await live?.settled();

		expect(index.findDocs({ text: "TRACKED_SECRET" }).total).toBe(0);
		expect(index.findLiterals({ value: "TRACKED_SECRET" }).total).toBe(0);
	});

	it("watches the external index path of a linked worktree", async () => {
		put(".gitignore", ".env\n");
		put(".env", "API_KEY=WORKTREE_SECRET\n");
		await gitAdd(root, "-f", ".gitignore", ".env");
		await gitCommit(root, "tracked dotenv");
		const mainRoot = root;
		const worktreeRoot = `${root}-worktree`;
		await gitWorktreeAdd(mainRoot, worktreeRoot);
		additionalRoots.push(mainRoot);
		store.close();
		root = worktreeRoot;
		store = IndexStore.open(path.join(root, "index.sqlite")).store;

		const index = service();
		await index.indexFile(".env");
		expect(index.findDocs({ text: "WORKTREE_SECRET" }).total).toBe(1);
		await watch(index);

		await gitRmCached(root, ".env");
		await waitFor(() => index.findDocs({ text: "WORKTREE_SECRET" }).total === 0);
		await live?.settled();

		expect(index.findLiterals({ value: "WORKTREE_SECRET" }).total).toBe(0);
		expect(
			store.declarationsIn(".env").some(({ name, valueStatus }) => name === "API_KEY" && valueStatus === "set"),
		).toBe(true);
	});

	it("reparses an edited tracked lexicon.json as JSON", async () => {
		put("lexicon.json", '{"alpha":1}\n');
		await gitAdd(root, "lexicon.json");
		const index = service();
		await index.warmupWorkspace();
		const edited = '{"beta":1}\n';
		put("lexicon.json", edited);
		await index.applyBatch([{ kind: "changed", module: "lexicon.json", contentHash: hashContent(edited) }]);

		expect(store.declarationsIn("lexicon.json").map(({ name }) => name)).toEqual(["beta"]);
	});

	it("keeps built-in rules when the project secrets schema is malformed", async () => {
		put("lexicon.json", JSON.stringify({ secrets: { "**/*.yaml": { "@unknown": "redact" } } }));
		put("secret.yaml", "kind: Secret\ndata:\n  password: BUILTIN_SECRET\n");
		const index = service();
		await index.indexFile("secret.yaml");

		expect(index.indexStatus().scopeNotes).toContain(
			"lexicon.json secrets is invalid; built-in secret rules are active",
		);
		expect(index.findLiterals({ value: "BUILTIN_SECRET" }).total).toBe(0);
	});

	it("keeps the last valid policy through malformed config", async () => {
		put("lexicon.json", JSON.stringify({ secrets: { "**/private.json": "omit" } }));
		const index = service();
		const initial = await index.currentScope();
		expect(initial.denies("private.json")).toBe(false);
		put("lexicon.json", JSON.stringify({ secrets: { "**/*.json": { "@unknown": "omit" } } }));
		await index.applyBatch([{ kind: "changed", module: "lexicon.json", contentHash: null }]);
		const schemaRetained = await index.currentScope();
		expect(schemaRetained.denies("private.json")).toBe(false);
		expect(index.policy.current.access("private.json")).toBe("closed");
		expect(index.indexStatus().scopeNotes).toContain(
			"lexicon.json secrets is invalid; last valid secret rules are active",
		);
		put("lexicon.json", "{");
		await index.applyBatch([{ kind: "changed", module: "lexicon.json", contentHash: null }]);
		const retained = await index.currentScope();

		expect(retained.denies("private.json")).toBe(false);
		expect(index.policy.current.access("private.json")).toBe("closed");
		expect(index.indexStatus().scopeNotes).toContain("lexicon.json is invalid; last valid secret rules are active");
		expect(index.policy.current.access("private.json")).toBe("closed");

		put("lexicon.json", JSON.stringify({ secrets: { "**/credentials.json": "omit" } }));
		await index.applyBatch([{ kind: "changed", module: "lexicon.json", contentHash: null }]);
		const adopted = await index.currentScope();
		expect(adopted.denies("private.json")).toBe(false);
		expect(index.policy.current.access("credentials.json")).toBe("closed");
	});

	it("loads the last valid secrets and deny after a malformed-config restart", async () => {
		put(
			"lexicon.json",
			JSON.stringify({
				secrets: { "**/private.json": "omit" },
				deny: ["**/custom-denied/**"],
			}),
		);
		const first = service();
		await first.currentScope();
		expect(store.lastSecretPolicy()).toEqual({
			secrets: { "**/private.json": "omit" },
			deny: ["**/custom-denied/**"],
		});
		store.close();
		store = IndexStore.open(path.join(root, "index.sqlite")).store;

		put("lexicon.json", "{");
		const policy = testPolicy(root, undefined, store);
		expect(policy.current.answer("private.json").kind).toBe("omit");
		const restarted = service();
		const scope = await restarted.currentScope();

		expect(scope.denies("private.json")).toBe(false);
		expect(scope.denies("custom-denied/item.fake")).toBe(true);
		expect(restarted.indexStatus().scopeNotes).toContain(
			"lexicon.json is invalid; last valid secret rules are active",
		);
	});
});

describe("what indexing leaves in the log", () => {
	let reader: Database;

	/** Holds a reader snapshot to defer truncation. */
	const hold = () => {
		reader.exec("BEGIN");
		reader.prepare("SELECT COUNT(*) FROM files").get();
	};

	const owed = () => store.purgeState().pending;

	beforeEach(() => {
		reader = Database.open(path.join(root, "index.sqlite"), { readOnly: true });
	});

	afterEach(() => {
		reader.close();
	});

	it("owes nothing when plain JSON is deleted", async () => {
		put("a.json", '{"name":"a"}\n');
		put("b.json", '{"name":"b"}\n');
		await gitAdd(root, "a.json", "b.json");
		const index = service();
		await index.warmupWorkspace();
		expect(store.contentHashOf("a.json")).not.toBeNull();
		hold();
		rmSync(path.join(root, "a.json"));
		rmSync(path.join(root, "b.json"));

		await index.applyBatch([
			{ kind: "deleted", module: "a.json" },
			{ kind: "deleted", module: "b.json" },
		]);

		expect({ a: store.contentHashOf("a.json"), b: store.contentHashOf("b.json"), owed: owed() }).toEqual({
			a: null,
			b: null,
			owed: false,
		});
	});

	it("owes the log a truncate when a Deployment is edited into a Secret", async () => {
		put("deploy.yaml", "kind: ConfigMap\ndata:\n  token: SAME_VALUE\n");
		const index = service();
		await index.indexFile("deploy.yaml");
		expect(index.findLiterals({ value: "SAME_VALUE" }).total).toBe(1);
		hold();

		put("deploy.yaml", "kind: Secret\ndata:\n  token: SAME_VALUE\n");
		await index.indexFile("deploy.yaml");

		expect({ literals: index.findLiterals({ value: "SAME_VALUE" }).total, owed: owed() }).toEqual({
			literals: 0,
			owed: true,
		});
	});

	it("owes the log a truncate when a tracked dotenv file becomes untracked", async () => {
		put(".env", "API_KEY=TRACKED_VALUE\n");
		await gitAdd(root, ".env");
		const index = service();
		await index.indexFile(".env");
		expect(index.findDocs({ text: "TRACKED_VALUE" }).total).toBe(1);
		hold();

		await gitRmCached(root, ".env");
		await index.applyBatch([], undefined, ["repositories", "listing:"]);

		expect({ docs: index.findDocs({ text: "TRACKED_VALUE" }).total, owed: owed() }).toEqual({
			docs: 0,
			owed: true,
		});
	});

	it("leaves no trace of a tracked dotenv value in the file or the log once it becomes untracked", async () => {
		const value = "TRACE_VALUE_7f3a91c2e5";
		const file = path.join(root, "index.sqlite");
		const holds = (target: string) => existsSync(target) && readFileSync(target).includes(value);
		put(".env", `API_KEY=${value}\n`);
		await gitAdd(root, ".env");
		const index = service();
		await index.indexFile(".env");
		expect(index.findDocs({ text: value }).total).toBe(1);
		const admin = Database.open(file);
		admin.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
		admin.close();
		expect(holds(file)).toBe(true);

		await gitRmCached(root, ".env");
		await index.applyBatch([], undefined, ["repositories", "listing:"]);

		expect({
			docs: index.findDocs({ text: value }).total,
			owed: owed(),
			db: holds(file),
			wal: holds(`${file}-wal`),
		}).toEqual({
			docs: 0,
			owed: false,
			db: false,
			wal: false,
		});
	});

	it("owes nothing when an untracked dotenv file is parsed again", async () => {
		put(".env.local", "API_KEY=ONE\n");
		const index = service();
		await index.indexFile(".env.local");
		expect(store.declarationsIn(".env.local").map(({ name, valueStatus }) => [name, valueStatus])).toEqual([
			["API_KEY", "set"],
		]);
		hold();

		put(".env.local", "API_KEY=TWO\nOTHER=\n");
		await index.indexFile(".env.local");

		expect({ keys: store.declarationsIn(".env.local").length, owed: owed() }).toEqual({ keys: 2, owed: false });
	});

	it("owes the log a truncate when a policy change turns plain facts into a secret's", async () => {
		put("settings.json", '{"password":"POLICY_VALUE"}\n');
		const index = service();
		await index.indexFile("settings.json");
		expect(index.findLiterals({ value: "POLICY_VALUE" }).total).toBe(1);
		hold();

		put("lexicon.json", JSON.stringify({ secrets: { "**/settings.json": { password: "redact" } } }));
		await index.applyBatch([{ kind: "changed", module: "lexicon.json", contentHash: null }]);

		expect({ literals: index.findLiterals({ value: "POLICY_VALUE" }).total, owed: owed() }).toEqual({
			literals: 0,
			owed: true,
		});
	});

	async function forgetsEveryOlderRowAtOnce(journaled: boolean): Promise<void> {
		const modules = ["data/a.json", "data/b.yaml", "data/c.json", "data/d.yaml"];
		const text = (module: string) => (module.endsWith(".json") ? '{"name":"ordinary"}\n' : "name: ordinary\n");
		for (const module of modules) put(module, text(module));
		const initialIndex = service();
		await initialIndex.currentScope();
		const answer = initialIndex.policy.current.answer(modules[0] as string);
		if (answer.kind !== "matchers") throw new Error("expected the Kubernetes rule");
		const previous = hashContent(JSON.stringify(answer.rule));
		for (const module of modules) {
			store.replaceFile({
				module,
				contentHash: hashContent(text(module)),
				admission: admit(module, "plain", previous),
				declarations: [],
				references: [],
				literals: [],
			});
		}
		store.close();
		store = IndexStore.open(path.join(root, "index.sqlite")).store;
		const asked: string[] = [];
		const index = service(asked);
		if (journaled) {
			const transactions = new TransactionManager(store, root, index.policy);
			index.attachJournal(transactions);
		}
		hold();

		await index.gate.exclusive(() => index.reconcileSecretPolicy());

		expect(modules.map((module) => store.contentHashOf(module))).toEqual([null, null, null, null]);
		expect(asked).toEqual([]);
		expect(store.purgeState()).toMatchObject({ pending: true, attempts: 1 });

		await index.indexFile("data/a.json");
		expect(asked).toEqual(["data/a.json"]);
		expect(store.policyStampOf("data/a.json")).toBe(answer.stamp);
		expect(answer.stamp).not.toBe(previous);
	}

	it("forgets every row an older reader version stamped in one batch, before any parse", () =>
		forgetsEveryOlderRowAtOnce(false));

	it("owes the log one truncate for them with the journal wired", () => forgetsEveryOlderRowAtOnce(true));
});
