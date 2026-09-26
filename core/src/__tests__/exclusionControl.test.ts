// A leak shows as a difference, so every answer is compared whole against a workspace that never
// held the hidden files.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ModuleExclusion } from "@nyaa-lexicon/protocol";
import { createDispatch } from "../dispatch";
import { LexiconService } from "../service";
import { sourceReader } from "../sourceRead";
import { IndexStore } from "../store";
import { ProviderSupervisor } from "../supervisor";
import { gitInit } from "./gitFixture";

////////////////////////////////
//  Harness

const ROOT = path.join(import.meta.dirname, "..", "..", "..");
const PROVIDERS = ["markdown", "json", "text"].map((name) => path.join(ROOT, "providers", name, "src", "main.ts"));

const VISIBLE: Record<string, string> = {
	"README.md": "# Keys\n\nA key looks like sk-a-placeholder.\n",
	"config.json": '{\n\t"apiKeyExample": "sk-a-placeholder",\n\t"region": "us-east"\n}\n',
	"app.json": '{\n\t"region": "us-east"\n}\n',
};

// One value shared by two hidden files, and one a hidden file shares with a visible one.
const HIDDEN: Record<string, string> = {
	".env": "OPENAI_API_KEY=sk-abc123live\n",
	"secrets/credentials.json": '{\n\t"apiKey": "sk-a-live-999",\n\t"apiKeyExample": "sk-a-placeholder"\n}\n',
	"secrets/credentials.prod.json": '{\n\t"apiKey": "sk-a-live-999"\n}\n',
};

const EXCLUDE: ModuleExclusion = { hide: ["**/.env*", "**/credentials*.json"] };

interface Workspace {
	ask: (method: string, params: unknown) => Promise<unknown>;
	close: () => void;
}

async function open(files: Record<string, string>): Promise<Workspace> {
	const root = mkdtempSync(path.join(tmpdir(), "lexicon-control-"));
	const workspace = path.join(root, "workspace");
	for (const [name, text] of Object.entries(files)) {
		mkdirSync(path.dirname(path.join(workspace, name)), { recursive: true });
		writeFileSync(path.join(workspace, name), text);
	}
	await gitInit(workspace);

	const store = IndexStore.open(path.join(root, "index.sqlite")).store;
	const supervisor = new ProviderSupervisor();
	await Promise.all(
		PROVIDERS.map((main) =>
			supervisor.start({ command: [process.execPath, "run", main], timeoutMs: 60_000 }, workspace),
		),
	);
	const service = new LexiconService(store, supervisor, sourceReader(workspace), workspace);
	await service.indexWorkspace();
	return {
		ask: createDispatch(service),
		close: () => {
			supervisor.stopAll();
			store.close();
			rmSync(root, { recursive: true, force: true });
		},
	};
}

const QUERIES: Array<[string, Record<string, unknown>]> = [
	["findDocs", { regex: "/sk-a/" }],
	["findDocs", { text: "sk-a" }],
	["findLiterals", { regex: "/sk-a/" }],
	["findLiterals", { value: "sk-a-live-999" }],
	["searchSymbols", { regex: "/api/i" }],
	["findComments", { regex: "/sk-a/" }],
	["findImports", { specifierRegex: "/./" }],
	["sharedLiterals", { minimumFiles: 2 }],
];

interface Shared {
	value: string;
	files: number;
}

let holding: Workspace;
let control: Workspace;

beforeAll(async () => {
	[holding, control] = await Promise.all([open({ ...VISIBLE, ...HIDDEN }), open(VISIBLE)]);
});

afterAll(() => {
	holding.close();
	control.close();
});

////////////////////////////////
//  Tests

describe("a search that excludes the secret files", () => {
	it("finds the secrets when nothing is excluded, so the control has something to hide", async () => {
		const docs = (await holding.ask("findDocs", { regex: "/sk-a/" })) as { docs: Array<{ module: string }> };
		expect(docs.docs.map((doc) => doc.module)).toContain(".env");
		const literals = (await holding.ask("findLiterals", { regex: "/sk-a/" })) as {
			literals: Array<{ module: string }>;
		};
		expect(literals.literals.map((literal) => literal.module)).toContain("secrets/credentials.json");
		const shared = (await holding.ask("sharedLiterals", { minimumFiles: 2 })) as Shared[];
		expect(shared.map((row) => row.value)).toContain("sk-a-live-999");
	});

	it.each(QUERIES)("%s %j answers exactly as a workspace without them", async (method, params) => {
		const asked = { ...params, exclude: EXCLUDE };
		const [held, clean] = await Promise.all([holding.ask(method, asked), control.ask(method, asked)]);
		expect(held).toEqual(clean);
	});

	it("still finds what is visible", async () => {
		const docs = (await holding.ask("findDocs", { regex: "/sk-a/", exclude: EXCLUDE })) as { total: number };
		const literals = (await holding.ask("findLiterals", { regex: "/sk-a/", exclude: EXCLUDE })) as {
			total: number;
		};
		const shared = (await holding.ask("sharedLiterals", { minimumFiles: 2, exclude: EXCLUDE })) as Shared[];
		expect({
			docs: docs.total,
			literals: literals.total,
			shared: shared.map((row) => [row.value, row.files]),
		}).toEqual({ docs: 1, literals: 1, shared: [["us-east", 2]] });
	});
});
