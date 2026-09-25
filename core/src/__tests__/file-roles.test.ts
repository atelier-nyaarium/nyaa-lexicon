// A file's role end to end: a provider's parse, the declared tier, the store, describe and overview.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { composeSymbolId, type Declaration } from "@nyaa-lexicon/protocol";
import { LexiconService } from "../service";
import { sourceReader } from "../sourceRead";
import { IndexStore } from "../store";
import { FAKE_CLAIMS, fakeSupervisor } from "./fakeProvider";

////////////////////////////////
//  Helpers

let root: string;
let store: IndexStore;

const MAIN = composeSymbolId({ language: "fake", module: "a.fake", descriptors: [{ kind: "method", name: "main" }] });

const DECLARATION: Declaration = {
	symbolId: MAIN,
	kind: "function",
	name: "main",
	range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } },
	visibility: "public",
};

async function index(fileRoles: boolean): Promise<LexiconService> {
	writeFileSync(path.join(root, "a.fake"), "main\n");
	const supervisor = fakeSupervisor({
		claims: [FAKE_CLAIMS],
		tiers: { fileRoles },
		discover: () => ["a.fake"],
		answers: {
			parseFile: (request) => ({
				module: request.module,
				contentHash: request.contentHash,
				declarations: [DECLARATION],
				references: [],
				imports: [],
				literals: [],
				diagnostics: [],
				role: { kind: "entry", how: "main", symbolId: MAIN },
			}),
		},
	});
	const service = new LexiconService(store, supervisor, sourceReader(root), root);
	await service.indexWorkspace();
	return service;
}

beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), "lexicon-file-roles-"));
	store = IndexStore.open(path.join(root, "index.sqlite")).store;
});

afterEach(() => {
	store.close();
	rmSync(root, { recursive: true, force: true });
});

////////////////////////////////
//  Tests

describe("a file's role", () => {
	it("reaches describe and the overview's entry points from a provider declaring the tier", async () => {
		const service = await index(true);
		const overview = await service.overview();

		expect({ role: service.describe(MAIN)?.moduleRole, entries: overview.entryPoints }).toEqual({
			role: { kind: "entry", how: "main", symbolId: MAIN },
			entries: [{ module: "a.fake", how: "main", symbolId: MAIN }],
		});
	});

	// Absence means unreported, not empty.
	it("is dropped at the wire from a provider that never declared the tier", async () => {
		const service = await index(false);
		const overview = await service.overview();

		expect({ role: service.describe(MAIN)?.moduleRole, entries: overview.entryPoints }).toEqual({
			role: undefined,
			entries: undefined,
		});
	});
});
