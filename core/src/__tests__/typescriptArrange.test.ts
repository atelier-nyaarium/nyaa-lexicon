// An arrangement through the daemon's handlers with the TypeScript provider, over files the test writes.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ResponseOf } from "@nyaa-lexicon/protocol";
import { createDispatch } from "../dispatch";
import { LexiconService } from "../service";
import { sourceReader } from "../sourceRead";
import { IndexStore } from "../store";
import { ProviderSupervisor } from "../supervisor";
import { TransactionManager } from "../transactions";

////////////////////////////////
//  Fixtures

const PROVIDER = path.join(import.meta.dirname, "..", "..", "..", "providers", "typescript", "src", "main.ts");

const FILES: Record<string, string> = {
	"tsconfig.json": JSON.stringify({
		compilerOptions: { module: "esnext", moduleResolution: "bundler", strict: true },
		include: ["src"],
	}),
	"src/source.ts": "export function foo() {\n\treturn 1;\n}\n\nexport function keep() {\n\treturn 2;\n}\n",
	"src/other.ts": "export function foo() {\n\treturn 3;\n}\n",
	"src/target.ts": "export const marker = 0;\n",
	"src/barrel.ts": 'export { foo } from "./source";\n',
	"src/use.ts":
		'import { foo as otherFoo } from "./other";\nimport { foo } from "./source";\n\nexport const total = foo() + otherFoo();\n',
};

let root: string;
let store: IndexStore;
let supervisor: ProviderSupervisor;
let service: LexiconService;
let dispatch: ReturnType<typeof createDispatch>;

function read(module: string): string {
	return readFileSync(path.join(root, module), "utf8");
}

beforeEach(async () => {
	root = mkdtempSync(path.join(tmpdir(), "lexicon-ts-arrange-"));
	mkdirSync(path.join(root, "src"));
	for (const [module, text] of Object.entries(FILES)) writeFileSync(path.join(root, module), text);
	store = IndexStore.open(path.join(root, "index.sqlite")).store;
	supervisor = new ProviderSupervisor();
	await supervisor.start({ command: [process.execPath, "run", PROVIDER], timeoutMs: 30_000 }, root);
	service = new LexiconService(store, supervisor, sourceReader(root), root);
	dispatch = createDispatch(service, { transactions: new TransactionManager(store, root) });
	for (const module of Object.keys(FILES).filter((name) => name.endsWith(".ts"))) await service.indexFile(module);
	await dispatch("refactorStart", {});
});

afterEach(() => {
	supervisor.stopAll();
	store.close();
	rmSync(root, { recursive: true, force: true });
});

////////////////////////////////
//  Tests

describe("an arrangement with the TypeScript provider", () => {
	it("re-points a barrel and an importer, and leaves a same-named import from elsewhere", async () => {
		const foo = service.findByName("foo").find((found) => found.module === "src/source.ts")?.symbolId as string;
		const request = { toModule: "src/target.ts", placements: [{ symbolId: foo }] };
		const shown = (await dispatch("previewArrange", request)) as ResponseOf<"previewArrange">;
		if (!shown.ok) throw new Error(shown.reason);
		const outcome = await dispatch("refactorArrange", {
			...request,
			expect: shown.files.map(({ module, base, result }) => ({ module, base, result })),
		});

		expect({
			outcome,
			barrel: read("src/barrel.ts"),
			use: read("src/use.ts"),
			source: read("src/source.ts"),
			target: read("src/target.ts"),
		}).toMatchObject({
			outcome: { moved: true },
			barrel: 'export { foo } from "./target";\n',
			use: 'import { foo as otherFoo } from "./other";\nimport { foo } from "./target";\n\nexport const total = foo() + otherFoo();\n',
			source: "export function keep() {\n\treturn 2;\n}\n",
			target: "export const marker = 0;\n\nexport function foo() {\n\treturn 1;\n}\n",
		});
	}, 120_000);

	it("writes the target's line endings around a moved declaration, and leaves a break inside its literal", async () => {
		writeFileSync(path.join(root, "src/banner.ts"), "export function banner() {\n\treturn `one\ntwo`;\n}\n");
		writeFileSync(path.join(root, "src/windows.ts"), "export const marker = 0;\r\n");
		for (const module of ["src/banner.ts", "src/windows.ts"]) await service.indexFile(module);
		const banner = service.findByName("banner")[0]?.symbolId as string;
		const request = { toModule: "src/windows.ts", placements: [{ symbolId: banner }] };
		const shown = (await dispatch("previewArrange", request)) as ResponseOf<"previewArrange">;
		if (!shown.ok) throw new Error(shown.reason);
		await dispatch("refactorArrange", {
			...request,
			expect: shown.files.map(({ module, base, result }) => ({ module, base, result })),
		});

		expect(read("src/windows.ts")).toBe(
			"export const marker = 0;\r\n\r\nexport function banner() {\r\n\treturn `one\ntwo`;\r\n}\r\n",
		);
	}, 120_000);
});
