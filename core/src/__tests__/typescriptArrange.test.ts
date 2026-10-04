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
	it("moves a section banner to a new target and drops it from an emptied section", async () => {
		const source =
			"// licence\n\n////////////////////////////////\n// Values\n\nexport function moved() {\n\treturn 1;\n}\n";
		writeFileSync(path.join(root, "src/source.ts"), source);
		await service.indexFile("src/source.ts");
		const symbolId = service.findByName("moved", "src/source.ts").find((found) => found.module === "src/source.ts")
			?.symbolId as string;
		const request = { toModule: "src/new-target.ts", placements: [{ symbolId }] };
		const preview = (await dispatch("previewArrange", request)) as ResponseOf<"previewArrange">;
		if (!preview.ok) throw new Error(preview.reason);

		expect(preview.files).toEqual([
			{
				module: "src/new-target.ts",
				base: null,
				created: true,
				text: "////////////////////////////////\n// Values\n\nexport function moved() {\n\treturn 1;\n}\n",
				result: expect.any(String),
			},
			{
				module: "src/source.ts",
				base: expect.any(String),
				created: false,
				text: "// licence\n\n",
				result: expect.any(String),
			},
		]);
	});

	it("re-points a barrel and an importer, leaves a same-named import from elsewhere, and places every target declaration", async () => {
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
			placed: shown.placed,
			barrel: read("src/barrel.ts"),
			use: read("src/use.ts"),
			source: read("src/source.ts"),
			target: read("src/target.ts"),
		}).toMatchObject({
			outcome: { moved: true },
			placed: [
				{
					symbolId: service.findByName("marker")[0]?.symbolId,
					range: { start: { line: 0, character: 0 }, end: { line: 0, character: 24 } },
				},
				{ symbolId: foo, range: { start: { line: 2, character: 0 }, end: { line: 4, character: 1 } } },
			],
			barrel: 'export { foo } from "./target";\n',
			use: 'import { foo as otherFoo } from "./other";\nimport { foo } from "./target";\n\nexport const total = foo() + otherFoo();\n',
			source: "export function keep() {\n\treturn 2;\n}\n",
			target: "export const marker = 0;\n\nexport function foo() {\n\treturn 1;\n}\n",
		});
	}, 120_000);

	it("outlines a declaration's lines with the line its name is on, below its doc comment", async () => {
		writeFileSync(path.join(root, "src/doc.ts"), "/**\n * Doc.\n */\nexport function doc() {\n\treturn 1;\n}\n");
		await service.indexFile("src/doc.ts");
		const rows = (await dispatch("outlineModule", { module: "src/doc.ts" })) as ResponseOf<"outlineModule">;

		expect(rows.map((row) => [row.name, row.lines])).toEqual([["doc", { start: 0, end: 5, name: 3 }]]);
	}, 120_000);

	it("places every declaration at its stored span when a reorder changes nothing, placed or not", async () => {
		const id = (name: string) => service.findByName(name, "src/source.ts")[0]?.symbolId as string;
		const shown = (await dispatch("previewArrange", {
			toModule: "src/source.ts",
			placements: [{ symbolId: id("foo"), anchor: { symbolId: id("keep"), side: "before" } }],
		})) as ResponseOf<"previewArrange">;

		expect(shown).toMatchObject({
			ok: true,
			files: [],
			placed: [
				{ symbolId: id("foo"), range: { start: { line: 0, character: 0 }, end: { line: 2, character: 1 } } },
				{ symbolId: id("keep"), range: { start: { line: 4, character: 0 }, end: { line: 6, character: 1 } } },
			],
		});
	}, 120_000);

	it("moves one declaration the same way: a barrel and an importer follow, a same-named import stays", async () => {
		const foo = service.findByName("foo").find((found) => found.module === "src/source.ts")?.symbolId as string;
		const outcome = await dispatch("refactorMove", { symbolId: foo, toModule: "src/target.ts" });

		expect({ outcome, barrel: read("src/barrel.ts"), use: read("src/use.ts") }).toMatchObject({
			outcome: { moved: true },
			barrel: 'export { foo } from "./target";\n',
			use: 'import { foo as otherFoo } from "./other";\nimport { foo } from "./target";\n\nexport const total = foo() + otherFoo();\n',
		});
	}, 120_000);

	it("refuses a move a wildcard barrel re-exports, leaving the barrel's importer whole", async () => {
		writeFileSync(path.join(root, "src/star.ts"), 'export * from "./source";\n');
		writeFileSync(path.join(root, "src/viaStar.ts"), 'import { foo } from "./star";\n\nexport const v = foo();\n');
		for (const module of ["src/star.ts", "src/viaStar.ts"]) await service.indexFile(module);
		const foo = service.findByName("foo").find((found) => found.module === "src/source.ts")?.symbolId as string;
		const outcome = await dispatch("refactorMove", { symbolId: foo, toModule: "src/target.ts" });

		expect({ outcome, source: read("src/source.ts"), viaStar: read("src/viaStar.ts") }).toMatchObject({
			outcome: { moved: false },
			source: FILES["src/source.ts"],
			viaStar: 'import { foo } from "./star";\n\nexport const v = foo();\n',
		});
	}, 120_000);

	it("refuses a move a namespace re-export or a namespace import that uses it binds, and allows one that does not", async () => {
		const moveFoo = async (files: Record<string, string>) => {
			for (const [module, text] of Object.entries(files)) {
				writeFileSync(path.join(root, module), text);
				await service.indexFile(module);
			}
			const foo = service.findByName("foo").find((found) => found.module === "src/source.ts")?.symbolId as string;
			return dispatch("refactorMove", { symbolId: foo, toModule: "src/target.ts" });
		};
		const reExported = await moveFoo({
			"src/ns.ts": 'export * as ns from "./source";\n',
			"src/viaNs.ts": 'import { ns } from "./ns";\n\nexport const v = ns.foo();\n',
		});
		const imported = await moveFoo({
			"src/ns.ts": "export const unrelated = 0;\n",
			"src/viaNs.ts": 'import * as src from "./source";\n\nexport const v = src.foo();\n',
		});
		const unused = await moveFoo({
			"src/viaNs.ts": 'import * as src from "./source";\n\nexport const v = src.keep();\n',
		});

		expect({ reExported, imported, unused }).toMatchObject({
			reExported: { moved: false },
			imported: { moved: false },
			unused: { moved: true },
		});
	}, 120_000);

	it("refuses moving a default export a namespace re-export forwards, not one only `export *` covers", async () => {
		const moveDefault = async (barrel: string) => {
			const files: Record<string, string> = {
				"src/source.ts":
					"export default function foo() {\n\treturn 1;\n}\n\nexport function keep() {\n\treturn 2;\n}\n",
				"src/target.ts": FILES["src/target.ts"] as string,
				"src/barrel.ts": "export {};\n",
				"src/use.ts": "export {};\n",
				"src/ns.ts": barrel,
			};
			for (const [module, text] of Object.entries(files)) {
				writeFileSync(path.join(root, module), text);
				await service.indexFile(module);
			}
			const foo = service.findByName("foo").find((found) => found.module === "src/source.ts")?.symbolId as string;
			return dispatch("refactorMove", { symbolId: foo, toModule: "src/target.ts" });
		};

		expect({
			namespace: await moveDefault('export * as ns from "./source";\n'),
			star: await moveDefault('export * from "./source";\n'),
		}).toMatchObject({ namespace: { moved: false }, star: { moved: true } });
	}, 120_000);

	it("moves a set together as one step, exporting none of the helpers only the set uses", async () => {
		writeFileSync(
			path.join(root, "src/git.ts"),
			"const LIMIT = 10;\n\nfunction clip(text: string): string {\n\treturn text.slice(0, LIMIT);\n}\n\nexport function run(text: string): string {\n\treturn clip(text);\n}\n\nexport function other(): number {\n\treturn 1;\n}\n",
		);
		await service.indexFile("src/git.ts");
		const id = (name: string) => service.findByName(name, "src/git.ts")[0]?.symbolId as string;
		const outcome = await dispatch("refactorMove", {
			symbolId: id("run"),
			toModule: "src/runner.ts",
			together: [id("clip"), id("LIMIT")],
		});
		const status = (await dispatch("refactorStatus", {})) as ResponseOf<"refactorStatus">;

		expect({
			outcome,
			steps: status.steps.length,
			runner: read("src/runner.ts"),
			git: read("src/git.ts"),
		}).toMatchObject({
			outcome: { moved: true },
			steps: 1,
			runner: "const LIMIT = 10;\n\nfunction clip(text: string): string {\n\treturn text.slice(0, LIMIT);\n}\n\nexport function run(text: string): string {\n\treturn clip(text);\n}\n",
			git: "export function other(): number {\n\treturn 1;\n}\n",
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
