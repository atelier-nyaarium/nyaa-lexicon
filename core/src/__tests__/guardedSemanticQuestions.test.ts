import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { composeSymbolId } from "@nyaa-lexicon/protocol";
import { systemClock } from "../clock.js";
import { fromText } from "../sourceRead.js";
import { IndexStore } from "../store.js";
import { writePlain } from "./admissions.js";
import { fakeSupervisor } from "./fakeProvider.js";
import { TestLexiconService, testPolicy } from "./testPolicy.js";

let root: string;
let store: IndexStore;
const roots: string[] = [];

afterEach(() => {
	store?.close();
	for (const directory of roots.splice(0)) rmSync(directory, { recursive: true, force: true });
});

it("withholds guarded semantic questions before asking a provider", async () => {
	root = mkdtempSync(path.join(tmpdir(), "lexicon-guarded-questions-"));
	roots.push(root);
	store = IndexStore.open(path.join(root, "index.sqlite")).store;
	const modules = [".env.local", "secret.yaml"];
	const symbols = modules.map((module) =>
		composeSymbolId({ language: "fixture", module, descriptors: [{ kind: "term", name: "token" }] }),
	);
	const absent = composeSymbolId({
		language: "fixture",
		module: ".env.local",
		descriptors: [{ kind: "term", name: "absent" }],
	});
	for (const [index, module] of modules.entries()) {
		writePlain(store, {
			module,
			contentHash: `hash-${index}`,
			declarations: [
				{
					symbolId: symbols[index] as string,
					kind: "property",
					name: "token",
					range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
					selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
					visibility: "public",
				},
			],
			references: [],
		});
	}
	store.settleProjections();

	const asked: string[] = [];
	const supervisor = fakeSupervisor({
		claims: [{ providerId: "fake", language: "fixture", extensions: [".local", ".yaml"] }],
		answers: {
			bind: (_request, module) => {
				asked.push(`bind:${module}`);
				return { status: "unbound", reason: "NotIndexed" };
			},
			typeOf: (_request, module) => {
				asked.push(`typeOf:${module}`);
				return { status: "known", display: "string", provenance: "inferred" };
			},
		},
	});
	const policy = testPolicy(root, undefined, store);
	const service = new TestLexiconService(
		store,
		supervisor,
		fromText(() => null),
		root,
		systemClock,
		policy,
	);
	const detail = policy.genericWithheldDetail;
	const answers = await Promise.all([
		service.typeOf(symbols[0] as string),
		service.typeOf(absent),
		service.bind(modules[0] as string, "token", { start: { line: 0, character: 0 } }),
		service.typeOf(symbols[1] as string),
		service.bind(modules[1] as string, "token", { start: { line: 0, character: 0 } }),
	]);

	expect(modules.map((module) => policy.current.access(module))).toEqual(["bytes", "bytes"]);
	expect({ answers, asked }).toEqual({
		answers: [
			{ status: "unknown", reason: "NotIndexed", detail },
			{ status: "unknown", reason: "NotIndexed", detail },
			{ status: "unknown", reason: "NotIndexed", detail },
			{ status: "unknown", reason: "NotIndexed", detail },
			{ status: "unknown", reason: "NotIndexed", detail },
		],
		asked: [],
	});
});
