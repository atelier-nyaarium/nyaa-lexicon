// Real provider output, through real attachment, to a real stored fact.
//
// The seam nothing else covers. The unit tests inject synthetic spans and the provider tests read
// their own parser, so a provider whose ranges disagreed with core's expectations would pass both
// and fail only here. Everything else about this tier was verified by hand at a terminal, which is
// exactly the kind of proof that stops happening once the person who wrote it moves on.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startProviders } from "../providers";
import { sourceReader } from "../sourceRead";
import { IndexStore } from "../store";
import { gitAdd, gitInit } from "./gitFixture";
import {
	TestLexiconService as LexiconService,
	TestProviderSupervisor as ProviderSupervisor,
	testPolicy,
} from "./testPolicy";

////////////////////////////////
//  Helpers

let root: string;
let store: IndexStore;
let supervisor: ProviderSupervisor;

/** Only TypeScript: this proves the seam, and every other provider would add a startup for it. */
const TYPESCRIPT_ONLY = [
	{
		directory: "typescript",
		command: [
			process.execPath,
			"run",
			path.join(import.meta.dirname, "..", "..", "..", "providers", "typescript", "src", "main.ts"),
		],
	},
];

const SOURCE = [
	"// A run of two lines,",
	"// wrapped mid-sentence.",
	"export function work(): number {",
	"\t// why this order",
	"\treturn 1;",
	"}",
	"",
	"// Not attached to anything below.",
	"",
	"export const total = 42;",
	"",
].join("\n");

beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), "lexicon-live-comments-"));
	store = IndexStore.open(path.join(root, "index.sqlite")).store;
	supervisor = new ProviderSupervisor();
});

afterEach(() => {
	supervisor.stopAll();
	store.close();
	rmSync(root, { recursive: true, force: true });
});

////////////////////////////////
//  Tests

describe("a real provider's comments, attached by core", () => {
	it("groups, attaches and stores what the provider actually emitted", async () => {
		mkdirSync(path.join(root, "src"), { recursive: true });
		writeFileSync(path.join(root, "src", "work.ts"), SOURCE);
		// Git discovery ignores untracked files.
		await gitInit(root);
		await gitAdd(root, "-A");

		await startProviders(supervisor, root, { commands: TYPESCRIPT_ONLY });
		const service = new LexiconService(store, supervisor, sourceReader(root), root, undefined, testPolicy(root));
		await service.indexWorkspace();

		const work = service.findByName("work")[0];
		expect(work).toBeDefined();

		// Grouping keeps one fact across the line break.
		const documentation = service.describe(work?.symbolId ?? "")?.symbol.docComment;
		expect(documentation).toBe("A run of two lines, wrapped mid-sentence.");

		// Body comments do not document functions.
		expect(service.describe(work?.symbolId ?? "")?.comments?.map((item) => item.text)).toEqual(["why this order"]);

		// Search may cross source fragments.
		expect(service.findComments({ text: "lines, wrapped" }).total).toBe(1);

		// Blank lines separate both neighbors.
		const floating = service.findComments({ text: "Not attached" }).comments[0];
		expect(floating?.form).toBe("standalone");
		expect(floating?.anchor).toBeNull();
	}, 60_000);
});
