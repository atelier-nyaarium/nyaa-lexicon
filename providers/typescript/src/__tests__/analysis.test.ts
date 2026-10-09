import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	coordinatesOf,
	type FileFacts,
	PROTOCOL_VERSION,
	type ProjectModel,
	parseSymbolId,
} from "@nyaa-lexicon/protocol";
import type { TypeScriptAnalyzer } from "../analyzer.js";
import { TypeScriptProvider, warmingHandlers } from "../main.js";
import { harness } from "./harness.js";

////////////////////////////////
//  Helpers

const roots: string[] = [];

/** Watched even when absent, since an install writes one. */
const LOCKFILES = ["bun.lock", "bun.lockb", "package-lock.json", "yarn.lock", "pnpm-lock.yaml"];

function workspace(files: Record<string, string>): string {
	const root = mkdtempSync(path.join(tmpdir(), "lexicon-typescript-analysis-"));
	roots.push(root);
	for (const [module, text] of Object.entries(files)) {
		const full = path.join(root, module);
		mkdirSync(path.dirname(full), { recursive: true });
		writeFileSync(full, text);
	}
	return root;
}

function rangeAt(text: string, offset: number) {
	const range = coordinatesOf(text).rangeAt(offset, offset);
	if (range === undefined) throw new Error("invalid test offset");
	return range;
}

function textAt(
	text: string,
	range: { start: { line: number; character: number }; end: { line: number; character: number } },
) {
	const value = coordinatesOf(text).sliceRange(range);
	if (value === undefined) throw new Error("invalid test range");
	return value;
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

////////////////////////////////
//  Tests

describe("checker-backed analysis", () => {
	it("walks only core's scope when no tsconfig names the files", () => {
		const root = workspace({
			"src/kept.ts": "export const kept = 1;",
			"volumes/home/ignored.ts": "export const ignored = 1;",
		});
		const discovered = new TypeScriptProvider().discoverProject(root, undefined, ["src/kept.ts"]);
		expect(discovered.model.files).toEqual(["src/kept.ts"]);
	});

	it("binds the synthetic default of a CommonJS package's dynamic import as external", () => {
		const text = 'export async function load() {\n\treturn (await import("pkg")).default;\n}';
		const root = workspace({
			"tsconfig.json": JSON.stringify({ compilerOptions: { module: "ESNext", moduleResolution: "Bundler" } }),
			"node_modules/pkg/package.json": JSON.stringify({ name: "pkg", main: "./index.js", types: "./index.d.ts" }),
			"node_modules/pkg/index.d.ts": "export declare const value: number;",
			"a.ts": text,
		});
		const provider = harness();
		provider.initialize(root);
		const facts = provider.parseFile({ module: "a.ts", contentHash: "a", text }) as FileFacts;
		provider.shutdown();
		const synthetic = facts.references.find((reference) => reference.name === "default");
		expect(synthetic?.binding).toMatchObject({ status: "unbound", reason: "ExternalDependency" });
	});

	it("binds default imports to anonymous default declarations", () => {
		const files = {
			"class-default.ts": "export default class { run() {} }\n",
			"object-default.ts": "export default { greet() {} };\n",
			"expression-default.ts": "class Foo {} export default new Foo();\n",
			"use.ts": [
				'import classDefault from "./class-default";',
				'import objectDefault from "./object-default";',
				'import expressionDefault from "./expression-default";',
				"classDefault; objectDefault; expressionDefault;",
			].join("\n"),
		};
		const root = workspace(files);
		const provider = harness();
		provider.initialize(root);
		const classFacts = provider.parseFile({
			module: "class-default.ts",
			contentHash: "class-default",
			text: files["class-default.ts"],
		});
		const objectFacts = provider.parseFile({
			module: "object-default.ts",
			contentHash: "object-default",
			text: files["object-default.ts"],
		});
		const expressionFacts = provider.parseFile({
			module: "expression-default.ts",
			contentHash: "expression-default",
			text: files["expression-default.ts"],
		});
		const useFacts = provider.parseFile({ module: "use.ts", contentHash: "use", text: files["use.ts"] });
		const defaultId = (facts: typeof classFacts) =>
			facts.declarations.find((declaration) => declaration.name === "default")?.symbolId;

		for (const [name, facts] of [
			["classDefault", classFacts],
			["objectDefault", objectFacts],
			["expressionDefault", expressionFacts],
		] as const) {
			const symbolId = defaultId(facts);
			if (symbolId === undefined) throw new Error("default declaration missing");
			expect(useFacts.references.find((reference) => reference.name === name)?.binding).toEqual({
				status: "bound",
				symbolId,
				provenance: "bound",
			});
		}
		provider.shutdown();
	});

	it("joins a re-exported binding to the declaration id minted by parseFile", () => {
		const root = workspace({
			"foo.ts": "export function add() {}\n",
			"bar.ts": 'export { add } from "./foo";\n',
			"use.ts": 'import { add } from "./bar"; export function run() { add(); }\n',
		});
		const provider = harness();
		provider.initialize(root);

		const useText = 'import { add } from "./bar"; export function run() { add(); }\n';
		const useFacts = provider.parseFile({ module: "use.ts", contentHash: "use", text: useText });
		const fooText = "export function add() {}\n";
		const fooFacts = provider.parseFile({ module: "foo.ts", contentHash: "foo", text: fooText });
		const target = fooFacts.declarations.find((declaration) => declaration.name === "add");
		const reference = useFacts.references.find((candidate) => candidate.name === "add");
		if (target === undefined) throw new Error("target declaration missing");

		expect(target).toBeDefined();
		expect(reference?.binding).toEqual({
			status: "bound",
			symbolId: target.symbolId,
			provenance: "bound",
		});
		provider.shutdown();
	});

	it("types the supplied overlay rather than the saved file", () => {
		const root = workspace({ "disk.ts": "export const disk = 1;\n" });
		const provider = harness();
		provider.initialize(root);

		const facts = provider.parseFile({
			module: "disk.ts",
			contentHash: "overlay",
			text: "export const overlay: number = 1;\n",
		});
		const target = facts.declarations.find((declaration) => declaration.name === "overlay");

		expect(target).toBeDefined();
		expect(provider.typeOf({ symbolId: target?.symbolId ?? "" })).toMatchObject({
			status: "known",
			display: "number",
		});
		provider.shutdown();
	});

	it("refreshes facts for each transient candidate", () => {
		const provider = harness();
		provider.initialize(workspace({}));
		const first = provider.handlers.probeFile({
			module: "missing.ts",
			contentHash: "first",
			text: "export function RenameOutcome() {}\n",
		});
		const second = provider.handlers.probeFile({
			module: "missing.ts",
			contentHash: "second",
			text: "export function FreshOutcome() {}\n",
		});

		expect({
			first: first.declarations.find((declaration) => declaration.name === "RenameOutcome")?.name,
			hasFresh: second.declarations.some((declaration) => declaration.name === "FreshOutcome"),
		}).toEqual({ first: "RenameOutcome", hasFresh: true });
		provider.shutdown();
	});

	it("reuses one compiler generation for unchanged indexed files", () => {
		const files = {
			"tsconfig.json": JSON.stringify({ include: ["*.ts"] }),
			"a.ts": "export const a: number = 1;\n",
			"b.ts": "export const b: number = 2;\n",
			"c.ts": "export const c: number = 3;\n",
		};
		const root = workspace(files);
		const provider = harness();
		provider.initialize(root);

		for (const module of ["a.ts", "b.ts", "c.ts"] as const) {
			provider.parseFile({ module, contentHash: module, text: files[module] });
		}

		const before = provider.programStats().programGenerations;
		for (const module of ["a.ts", "b.ts", "c.ts"] as const) {
			provider.parseFile({ module, contentHash: `${module}-again`, text: files[module] });
		}
		expect(provider.programStats().programGenerations - before).toBe(0);
		provider.shutdown();
	});

	it("keeps repeated passes flat and restores transient Program roots", () => {
		const files = {
			"tsconfig.json": JSON.stringify({ include: ["src/**/*.ts"] }),
			"src/base.ts": "export class Base {}\n",
			"src/use.ts": 'import { Base } from "./base"; export const value = new Base();\n',
			"types.d.ts": "export interface Ambient { value: string }\n",
		};
		const provider = harness();
		provider.initialize(workspace(files));
		const modules = ["src/base.ts", "src/use.ts"] as const;
		for (const module of modules) provider.parseFile({ module, contentHash: module, text: files[module] });
		const firstPass = provider.programStats().programGenerations;
		for (const module of modules) provider.parseFile({ module, contentHash: module, text: files[module] });
		expect(provider.programStats().programGenerations - firstPass).toBe(0);

		const changed = `${files["src/base.ts"]}export class Added {}\n`;
		provider.handlers.probeFile({ module: "src/base.ts", contentHash: "changed", text: changed });
		const afterChangedProbe = provider.programStats().programGenerations;
		expect(afterChangedProbe - firstPass).toBe(2);
		provider.handlers.probeFile({ module: "src/base.ts", contentHash: "same", text: files["src/base.ts"] });
		const afterSameProbe = provider.programStats().programGenerations;
		expect(afterSameProbe - afterChangedProbe).toBe(0);

		provider.handlers.parseFile({
			module: "types.d.ts",
			contentHash: "types",
			text: files["types.d.ts"],
			depth: "surface",
		});
		provider.handlers.moduleAdmission?.({
			module: "types.d.ts",
			contentHash: "types",
			outcome: { status: "admitted" },
		});
		provider.bind({
			module: "types.d.ts",
			name: "Ambient",
			range: { start: { line: 0, character: 17 }, end: { line: 0, character: 24 } },
		});
		expect(provider.programStats().programGenerations - afterSameProbe).toBe(2);
		provider.shutdown();
	});

	it("announces a cold program build, lets the notice out before the build holds the thread, then says ready", async () => {
		const root = workspace({
			"tsconfig.json": JSON.stringify({ include: ["*.ts"] }),
			"a.ts": "export const a = 1;\n",
		});
		const served = (fails = false) => {
			const provider = new TypeScriptProvider();
			const handlers = warmingHandlers(provider);
			const events: string[] = [];
			const waiters = new Set<{ count: number; resolve: () => void }>();
			const record = (event: string) => {
				events.push(event);
				for (const waiter of waiters)
					if (events.length >= waiter.count) {
						waiters.delete(waiter);
						waiter.resolve();
					}
			};
			provider.store.announcePhase = (phase, label) => {
				record(label === undefined ? phase : `${phase}: ${label}`);
				// A turn later, when a written notice has gone out.
				setTimeout(() => record(`${phase} out`), 0);
			};
			handlers.initialize({ workspaceRoot: root, protocolVersion: PROTOCOL_VERSION });
			handlers.discoverProject({ workspaceRoot: root });
			// The warm starts after discovery returns, so a fake build set now is the one it runs.
			let built = false;
			const fake = {
				cold: () => !built,
				warm: () => {
					events.push("build");
					built = true;
					if (fails) throw new Error("the build failed");
				},
				dispose: () => {},
			};
			provider.store.project.analyzer = fake as unknown as TypeScriptAnalyzer;
			return {
				provider,
				handlers,
				events,
				until: (count: number) =>
					events.length >= count
						? Promise.resolve()
						: new Promise<void>((resolve) => waiters.add({ count, resolve })),
			};
		};

		// A build that throws still says ready.
		for (const fails of [false, true]) {
			const warmed = served(fails);
			await warmed.until(5);
			expect(warmed.events, `fails=${fails}`).toEqual([
				"initializing: building the TypeScript program",
				"initializing out",
				"build",
				"ready",
				"ready out",
			]);
		}

		// Shut down once announced: nothing builds, and the bracket still closes.
		const stopped = served();
		await Promise.resolve();
		stopped.handlers.shutdown({});
		await stopped.until(4);
		expect(stopped.events).toEqual([
			"initializing: building the TypeScript program",
			"initializing out",
			"ready",
			"ready out",
		]);

		// Shut down before the warm starts: nothing to announce.
		const early = served();
		early.handlers.shutdown({});
		// The warm would announce in a microtask, which every timer turn follows.
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(early.events).toEqual([]);
	});

	it("holds a request that reads the program until the warm build ends, and warms again after a config change", async () => {
		const text = "export const a = 1;\n";
		const root = workspace({ "tsconfig.json": JSON.stringify({ include: ["*.ts"] }), "a.ts": text });
		const provider = new TypeScriptProvider();
		const handlers = warmingHandlers(provider);
		const phases: [string, boolean][] = [];
		provider.store.announcePhase = (phase) => phases.push([phase, provider.store.project.analyzer?.cold() ?? true]);
		handlers.initialize({ workspaceRoot: root, protocolVersion: PROTOCOL_VERSION });
		handlers.discoverProject({ workspaceRoot: root });
		const facts = await handlers.parseFile({ module: "a.ts", contentHash: "a", text });

		expect(facts.declarations.map((declaration) => declaration.name)).toEqual(["a"]);
		expect(phases).toEqual([
			["initializing", true],
			["ready", false],
		]);

		writeFileSync(
			path.join(root, "tsconfig.json"),
			JSON.stringify({ include: ["*.ts"], compilerOptions: { strict: true } }),
		);
		handlers.discoverProject({ workspaceRoot: root });
		await handlers.parseFile({ module: "a.ts", contentHash: "a", text });
		expect(phases.slice(2)).toEqual([
			["initializing", true],
			["ready", false],
		]);
		handlers.shutdown({});
	});

	it("roots every discovered source when no tsconfig exists, and reads one once created", () => {
		const files = {
			"src/a.ts": "export const a = 1;\n",
			"src/nested/b.ts": "export const b = 2;\n",
		};
		const root = workspace(files);
		const provider = harness();
		provider.initialize(root);
		const discover = () => provider.handlers.discoverProject({ workspaceRoot: root }) as ProjectModel;
		provider.parseFile({ module: "src/a.ts", contentHash: "a", text: files["src/a.ts"] });
		expect(provider.programStats().rootFiles).toBe(2);

		const walked = discover();
		expect(walked.configFiles.sort()).toEqual([...LOCKFILES, "tsconfig.json"].sort());
		writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({ include: ["src/nested"] }));
		const configured = discover();
		expect(configured.fingerprint).not.toBe(walked.fingerprint);
		expect(configured.files).toEqual(["src/nested/b.ts"]);
		provider.shutdown();
	});

	it("moves the project fingerprint only for config that changes how files read, and reads the new config", () => {
		const config = (compilerOptions: object, included: string[] = []) =>
			JSON.stringify({
				extends: "./tsconfig.base.json",
				include: ["src", "one", "two", ...included],
				compilerOptions,
			});
		const root = workspace({
			"tsconfig.base.json": JSON.stringify({ compilerOptions: { strict: true } }),
			"tsconfig.json": config({ paths: { "@lib/*": ["./one/*"] } }),
			"package.json": JSON.stringify({ name: "app", scripts: { test: "bun test" } }),
			"src/use.ts": 'import { value } from "@lib/value";\n',
			"one/value.ts": "export const value = 1;\n",
			"two/value.ts": "export const value = 2;\n",
			"types/module.d.ts": "export declare const typed: number;\n",
			"types/script.d.ts": "declare const BUILD: string;\n",
			"types/augment.d.ts": "export {};\ndeclare global {\n\tconst FLAG: boolean;\n}\n",
		});
		const provider = harness();
		provider.initialize(root);
		const discover = () => provider.handlers.discoverProject({ workspaceRoot: root }) as ProjectModel;
		const lands = () => provider.resolveImport({ fromModule: "src/use.ts", specifier: "@lib/value" });

		const first = discover();
		expect(first.configFiles.sort()).toEqual(
			[...LOCKFILES, "package.json", "tsconfig.base.json", "tsconfig.json"].sort(),
		);
		expect(lands()).toMatchObject({ status: "resolved", landing: { module: "one/value.ts" } });
		const edits: [string, string, boolean][] = [
			["tsconfig.json", config({ paths: { "@lib/*": ["./one/*"] }, outDir: "out" }), false],
			["package.json", JSON.stringify({ name: "app", scripts: { test: "bun test --watch" } }), false],
			["tsconfig.json", config({ paths: { "@lib/*": ["./two/*"] }, outDir: "out" }), true],
			["tsconfig.base.json", JSON.stringify({ compilerOptions: { strict: false } }), true],
			["package.json", JSON.stringify({ name: "app", exports: "./src/use.ts" }), true],
			// Only a declaration file that declares globals changes what other files read.
			["tsconfig.json", config({ paths: { "@lib/*": ["./two/*"] } }, ["types/module.d.ts"]), false],
			["tsconfig.json", config({ paths: { "@lib/*": ["./two/*"] } }, ["types/script.d.ts"]), true],
			[
				"tsconfig.json",
				config({ paths: { "@lib/*": ["./two/*"] } }, ["types/script.d.ts", "types/augment.d.ts"]),
				true,
			],
		];
		let fingerprint = first.fingerprint;
		for (const [file, text, moves] of edits) {
			writeFileSync(path.join(root, file), text);
			const next = discover().fingerprint;
			expect(next !== fingerprint, `${file} ${text}`).toBe(moves);
			fingerprint = next;
		}
		expect(lands()).toMatchObject({ status: "resolved", landing: { module: "two/value.ts" } });
		provider.shutdown();
	});

	it("moves the fingerprint for a referenced project's settings, never for a file it gains", () => {
		const project = (compilerOptions: object) =>
			JSON.stringify({
				compilerOptions: { module: "CommonJS", composite: true, ...compilerOptions },
				include: ["src/**/*.ts"],
			});
		const root = workspace({
			"tsconfig.json": JSON.stringify({ files: [], references: [{ path: "./pkg" }] }),
			"pkg/tsconfig.json": project({}),
			"pkg/src/a.ts": "export const a = 1;\n",
		});
		const provider = harness();
		provider.initialize(root);
		const discover = () => (provider.handlers.discoverProject({ workspaceRoot: root }) as ProjectModel).fingerprint;
		let fingerprint = discover();
		const edits: [string, string, boolean][] = [
			["pkg/src/fresh.ts", "export const fresh = 1;\n", false],
			["pkg/tsconfig.json", project({ outDir: "out" }), false],
			["pkg/tsconfig.json", project({ outDir: "out", strict: false }), true],
		];
		for (const [file, text, moves] of edits) {
			writeFileSync(path.join(root, file), text);
			const next = discover();
			expect(next !== fingerprint, `${file} ${text}`).toBe(moves);
			fingerprint = next;
			if (file === "pkg/src/fresh.ts") {
				const facts = provider.parseFile({ module: file, contentHash: "fresh", text }) as FileFacts;
				expect(facts.runtime).toBe("cjs");
			}
		}
		provider.shutdown();
	});

	it("rereads a dependency's declarations once they change on disk", () => {
		const root = workspace({
			"tsconfig.json": JSON.stringify({ compilerOptions: { module: "CommonJS" } }),
			"a.ts": 'import { dep } from "dep";\nexport const x = dep;\n',
			"node_modules/dep/package.json": JSON.stringify({ name: "dep", types: "index.d.ts" }),
			"node_modules/dep/index.d.ts": "export declare const dep: number;\n",
		});
		const provider = harness();
		provider.initialize(root);
		const typeOfX = (text: string) => {
			provider.parseFile({ module: "a.ts", contentHash: text, text });
			return provider.typeOf({ symbolId: "lexicon typescript a.ts x." });
		};
		expect(typeOfX('import { dep } from "dep";\nexport const x = dep;\n')).toMatchObject({ display: "number" });
		writeFileSync(path.join(root, "node_modules/dep/index.d.ts"), "export declare const dep: boolean;\n");
		expect(typeOfX('import { dep } from "dep";\nexport const x = dep; // read\n')).toMatchObject({
			display: "boolean",
		});
		provider.shutdown();
	});

	it("moves the fingerprint for what is installed, never for what the workspace imports", () => {
		const manifest = (name: string, version: string) =>
			JSON.stringify({ name, version, types: "index.d.ts", exports: { ".": "./index.js", "./sub": "./sub.js" } });
		const source = 'import { dep } from "dep";\nexport const a = dep;\n';
		const root = workspace({
			"tsconfig.json": JSON.stringify({ compilerOptions: { module: "NodeNext", types: ["*"] } }),
			"package.json": JSON.stringify({ name: "ws", type: "module", dependencies: { dep: "^1.0.0" } }),
			"node_modules/dep/package.json": manifest("dep", "1.0.0"),
			"node_modules/dep/index.d.ts": "export declare const dep: number;\n",
			"node_modules/dep/sub.d.ts": "export declare const sub: number;\n",
			"node_modules/other/package.json": manifest("other", "1.0.0"),
			"node_modules/other/index.d.ts": "export declare const other: number;\n",
			"src/a.ts": source,
		});
		const provider = harness();
		provider.initialize(root);
		const discover = () => provider.handlers.discoverProject({ workspaceRoot: root }) as ProjectModel;
		const first = discover();
		expect(first.configFiles).toEqual(expect.arrayContaining(["package.json", ...LOCKFILES]));
		const edits: Array<[string, string, boolean]> = [
			["src/a.ts", `${source}import { other } from "other";\nexport const b = other;\n`, false],
			["src/a.ts", `${source}import { sub } from "dep/sub";\nexport const b = sub;\n`, false],
			["src/a.ts", `${source}import type { other } from "other";\nexport let b: typeof other;\n`, false],
			["src/a.ts", `${source}import { gone } from "not-installed";\nexport const b = gone;\n`, false],
			// The last import gone, resolution stops probing for a package.json in src.
			["src/a.ts", "export const a = 1;\n", false],
			["node_modules/dep/package.json", manifest("dep", "2.0.0"), true],
			["bun.lock", '{ "lockfileVersion": 1 }\n', true],
			["node_modules/@types/extra/index.d.ts", "declare const extra: number;\n", true],
		];
		let fingerprint = first.fingerprint;
		for (const [index, [file, text, moves]] of edits.entries()) {
			provider.parseFile({ module: "src/a.ts", contentHash: `a${index}`, text: source });
			const held = provider.provider.store.project;
			mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
			writeFileSync(path.join(root, file), text);
			const next = discover().fingerprint;
			expect(next !== fingerprint, file).toBe(moves);
			// A restated project leaves its old Programs behind.
			expect(held.languageServices.size, file).toBe(moves ? 0 : 1);
			fingerprint = next;
		}
		provider.shutdown();
	});

	it("compiles referenced projects whose settings read alike in one Program, and others apart", () => {
		for (const [strict, firstProgramFiles] of [
			[true, 2],
			[false, 1],
		] as const) {
			const files = {
				"tsconfig.json": JSON.stringify({ files: [], references: [{ path: "./one" }, { path: "./two" }] }),
				"one/tsconfig.json": JSON.stringify({
					compilerOptions: { strict: true, composite: true, outDir: "out" },
					include: ["src/**/*.ts"],
				}),
				"two/tsconfig.json": JSON.stringify({
					compilerOptions: { strict, composite: true, outDir: "dist" },
					include: ["src/**/*.ts"],
				}),
				"one/src/a.ts": "export const a = 1;\n",
				"two/src/b.ts": "export const b = 2;\n",
			};
			const provider = harness();
			provider.initialize(workspace(files));
			for (const module of ["one/src/a.ts", "two/src/b.ts"] as const)
				provider.parseFile({ module, contentHash: module, text: files[module] });
			expect(provider.programStats().workspaceFiles, `strict ${strict}`).toBe(firstProgramFiles);
			provider.shutdown();
		}
	});

	it("moves the project fingerprint when a package.json resolution reads or probes changes, through a link too", () => {
		for (const linked of [false, true]) {
			const real = workspace({
				"tsconfig.json": JSON.stringify({
					include: ["src"],
					compilerOptions: { paths: { "@lib": ["./vendor/lib"], "@new": ["./vendor/new"] } },
				}),
				"src/use.ts": 'import { value } from "@lib";\nimport { fresh } from "@new";\n',
				"vendor/lib/package.json": JSON.stringify({ types: "a.d.ts" }),
				"vendor/lib/a.d.ts": "export declare const value: 1;\n",
				"vendor/lib/b.d.ts": "export declare const value: 2;\n",
				"vendor/new/index.d.ts": "export declare const fresh: 1;\n",
				"vendor/new/b.d.ts": "export declare const fresh: 2;\n",
			});
			const root = linked ? `${real}-link` : real;
			if (linked) {
				symlinkSync(real, root, "dir");
				roots.push(root);
			}
			const provider = harness();
			provider.initialize(root);
			const discover = () => provider.handlers.discoverProject({ workspaceRoot: root }) as ProjectModel;
			const lands = (specifier: string) => provider.resolveImport({ fromModule: "src/use.ts", specifier });

			const first = discover();
			let fingerprint = first.fingerprint;
			expect(first.configFiles).toEqual(
				expect.arrayContaining(["vendor/lib/package.json", "vendor/new/package.json"]),
			);
			expect(lands("@lib")).toMatchObject({ status: "resolved", landing: { module: "vendor/lib/a.d.ts" } });
			expect(lands("@new")).toMatchObject({ status: "resolved", landing: { module: "vendor/new/index.d.ts" } });
			// An edited manifest, then one created where resolution found none.
			for (const [manifest, specifier] of [
				["vendor/lib", "@lib"],
				["vendor/new", "@new"],
			] as const) {
				writeFileSync(path.join(root, manifest, "package.json"), JSON.stringify({ types: "b.d.ts" }));
				const next = discover().fingerprint;
				expect(next, `${manifest} linked=${linked}`).not.toBe(fingerprint);
				fingerprint = next;
				expect(lands(specifier)).toMatchObject({
					status: "resolved",
					landing: { module: `${manifest}/b.d.ts` },
				});
			}
			provider.shutdown();
		}
	});

	it("advances the compiler generation when the saved file changes", () => {
		const initial = "export const value: number = 1;\n";
		const changed = 'export const value: string = "next";\n';
		const root = workspace({ "tsconfig.json": JSON.stringify({ include: ["*.ts"] }), "value.ts": initial });
		const provider = harness();
		provider.initialize(root);

		provider.parseFile({ module: "value.ts", contentHash: "v1", text: initial });
		writeFileSync(path.join(root, "value.ts"), changed);
		const facts = provider.parseFile({ module: "value.ts", contentHash: "v2", text: changed });
		const valueId = facts.declarations.find((declaration) => declaration.name === "value")?.symbolId;
		provider.parseFile({ module: "value.ts", contentHash: "v2-repeat", text: changed });

		expect(provider.typeOf({ symbolId: valueId ?? "" })).toMatchObject({
			status: "known",
			display: "string",
			provenance: "declared",
		});
		expect(provider.programStats()).toMatchObject({ programGenerations: 2 });
		provider.shutdown();
	});

	it("rebuilds dependent type lookup after another file changes", () => {
		const files = {
			"tsconfig.json": JSON.stringify({ include: ["*.ts"] }),
			"base.ts": "export class Model {}\n",
			"use.ts": 'import { Model } from "./base"; export const value: Model = new Model();\n',
			"touch.ts": "export const touch = 1;\n",
		};
		const root = workspace(files);
		const provider = harness();
		provider.initialize(root);

		const base = provider.parseFile({ module: "base.ts", contentHash: "base", text: files["base.ts"] });
		const use = provider.parseFile({ module: "use.ts", contentHash: "use", text: files["use.ts"] });
		provider.parseFile({ module: "touch.ts", contentHash: "touch", text: files["touch.ts"] });
		const generationsBeforeChange = provider.programStats().programGenerations;
		const modelId = base.declarations.find((declaration) => declaration.name === "Model")?.symbolId;
		const valueId = use.declarations.find((declaration) => declaration.name === "value")?.symbolId;

		provider.parseFile({
			module: "touch.ts",
			contentHash: "touch-v2",
			text: "export const touch = 2;\n",
		});

		expect(provider.typeOf({ symbolId: valueId ?? "" })).toMatchObject({
			status: "known",
			display: "Model",
			provenance: "declared",
			symbolId: modelId,
		});
		expect(provider.programStats().programGenerations - generationsBeforeChange).toBe(1);
		provider.shutdown();
	});

	it("reports overload declarations as ambiguous candidates", () => {
		const text = [
			"export function choose(value: string): string;",
			"export function choose(value: number): number;",
			"export function choose(value: string | number) { return value; }",
			"export function run() { choose(1); }",
			"",
		].join("\n");
		const root = workspace({ "overloads.ts": text });
		const provider = harness();
		provider.initialize(root);
		const facts = provider.parseFile({ module: "overloads.ts", contentHash: "overloads", text });
		const reference = facts.references.find((candidate) => candidate.name === "choose");

		expect(reference?.binding.status).toBe("ambiguous");
		if (reference?.binding.status === "ambiguous") expect(reference.binding.candidates.length).toBeGreaterThan(1);
		provider.shutdown();
	});

	it("keeps qualified beside the bound binding", () => {
		const useText = 'import * as lib from "./lib";\nexport function run() { lib.go(); }\n';
		const root = workspace({ "lib.ts": "export function go() {}\n", "use.ts": useText });
		const provider = harness();
		provider.initialize(root);
		const facts = provider.parseFile({ module: "use.ts", contentHash: "use", text: useText });
		const go = facts.references.find((reference) => reference.name === "go");

		expect(facts.references.map((reference) => [reference.name, reference.qualified])).toEqual([
			["lib", false],
			["go", true],
		]);
		expect(go?.binding.status).toBe("bound");
		provider.shutdown();
	});

	it("attaches checker bindings to supported reference roles", () => {
		const text = [
			"export class Base {}",
			"export interface Contract {}",
			"export class Child extends Base implements Contract {}",
			"export const source: Base = new Base();",
			"export const input: Child = new Child();",
			"export function run() { let target = input; target = source; return target; }",
			"",
		].join("\n");
		const root = workspace({ "roles.ts": text });
		const provider = harness();
		provider.initialize(root);
		const facts = provider.parseFile({ module: "roles.ts", contentHash: "roles", text });

		for (const role of ["call", "read", "write", "typeUse", "instantiate", "extends", "implements"] as const) {
			const references = facts.references.filter((reference) => reference.role === role);
			if (role === "call") expect(references).toEqual([]);
			else expect(references.length, role).toBeGreaterThan(0);
			expect(
				references.every((reference) => reference.binding.status === "bound"),
				role,
			).toBe(true);
		}
		provider.shutdown();
	});

	it("binds heritage references across local interfaces and imported bases", () => {
		const files = {
			"base.ts": "export class ImportedBase {}\n",
			"heritage.ts": [
				'import { ImportedBase } from "./base";',
				"export class LocalBase {}",
				"export class LocalChild extends LocalBase {}",
				"export interface Contract {}",
				"export class Implementer implements Contract {}",
				"export interface Left {}",
				"export interface Right {}",
				"export interface Combined extends Left, Right {}",
				"export class ImportedChild extends ImportedBase {}",
				"",
			].join("\n"),
		};
		const root = workspace(files);
		const provider = harness();
		provider.initialize(root);
		provider.parseFile({ module: "base.ts", contentHash: "base", text: files["base.ts"] });
		const facts = provider.parseFile({
			module: "heritage.ts",
			contentHash: "heritage",
			text: files["heritage.ts"],
		});

		const extendsReferences = facts.references.filter((reference) => reference.role === "extends");
		const implementsReferences = facts.references.filter((reference) => reference.role === "implements");
		expect(extendsReferences.map((reference) => reference.name)).toEqual(
			expect.arrayContaining(["LocalBase", "Left", "Right", "ImportedBase"]),
		);
		expect(implementsReferences.map((reference) => reference.name)).toEqual(["Contract"]);
		expect(
			[...extendsReferences, ...implementsReferences].every((reference) => reference.binding.status === "bound"),
		).toBe(true);
		provider.shutdown();
	});

	it("binds a declaration range through the same checker path from a cold program", () => {
		const text = "export function add() {}\n";
		const root = workspace({ "add.ts": text });
		const provider = harness();
		provider.initialize(root);
		const binding = provider.bind({
			module: "add.ts",
			name: "add",
			range: rangeAt(text, text.indexOf("add")),
		});

		expect(binding).toMatchObject({ status: "bound", provenance: "bound" });
		provider.shutdown();
	});

	it("binds several declaration ranges from cold programs", () => {
		const files = {
			"a.ts": "export function add() {}\n",
			"b.ts": "export function add() {}\n",
			"c.ts": "export function add() {}\n",
		};
		const root = workspace(files);
		const provider = harness();
		provider.initialize(root);

		for (const [module, text] of Object.entries(files)) {
			expect(provider.bind({ module, name: "add", range: rangeAt(text, text.indexOf("add")) })).toMatchObject({
				status: "bound",
				provenance: "bound",
			});
		}
		provider.shutdown();
	});

	it("binds a parameter declaration and its body references to one composed id", () => {
		const text = "export function add(value: number) { return value; }\n";
		const root = workspace({ "parameter.ts": text });
		const provider = harness();
		provider.initialize(root);

		const binding = provider.bind({
			module: "parameter.ts",
			name: "value",
			range: rangeAt(text, text.indexOf("value")),
		});
		const facts = provider.parseFile({ module: "parameter.ts", contentHash: "parameter", text });
		const parameter = facts.declarations.find((declaration) => declaration.name === "value");
		const reference = facts.references.find((candidate) => candidate.name === "value");
		if (parameter === undefined) throw new Error("parameter declaration missing");

		expect(binding).toEqual({ status: "bound", symbolId: parameter.symbolId, provenance: "bound" });
		expect(reference?.binding).toEqual(binding);
		expect(parseSymbolId(parameter?.symbolId ?? "")?.descriptors.at(-1)).toEqual({
			kind: "parameter",
			name: "value",
		});
		expect(provider.typeOf({ symbolId: parameter?.symbolId ?? "" })).toMatchObject({
			status: "known",
			display: "number",
			provenance: "declared",
		});
		provider.shutdown();
	});

	it("binds a union's property to the constituents the checker resolves, and a parameter's or element's member", () => {
		const text = [
			"export type Result = { ok: true; file: string } | { ok: false; failure: string; items: { id: string }[] };",
			"export function use(result: Result, opts: { path: string }) {",
			"  if (result.ok) return result.file + opts.path;",
			"  return result.failure + result.items[0]?.id;",
			"}",
			"",
		].join("\n");
		const root = workspace({ "union.ts": text });
		const provider = harness();
		provider.initialize(root);
		const facts = provider.parseFile({ module: "union.ts", contentHash: "union", text });
		const idOf = (name: string) =>
			facts.declarations
				.filter((declaration) => declaration.name === name)
				.map((declaration) => declaration.symbolId);
		const bindingOf = (name: string) => facts.references.find((reference) => reference.name === name)?.binding;

		expect(bindingOf("ok")).toEqual({ status: "ambiguous", candidates: idOf("ok").sort(), provenance: "bound" });
		for (const name of ["file", "failure", "path", "id"]) {
			const [symbolId] = idOf(name);
			expect(bindingOf(name), name).toEqual({
				status: "bound",
				symbolId: symbolId as string,
				provenance: "bound",
			});
		}
		provider.shutdown();
	});

	it("binds each name shared by several syntactic roles to its one declaration", () => {
		const text = [
			"export class Box {",
			"\tconstructor(private readonly side: number) { console.log(side); }",
			"\tget area(): number { return this.side * this.side; }",
			"\tset area(value: number) {}",
			"\tgrow() { this.area = this.area + 1; }",
			"}",
			"function measure() { return { width: 1, depth: 2 }; }",
			"export const { width, depth: deep } = measure();",
			"export const total = width + deep;",
			"",
		].join("\n");
		const root = workspace({ "shared.ts": text });
		const provider = harness();
		provider.initialize(root);
		const facts = provider.parseFile({ module: "shared.ts", contentHash: "shared", text });
		const idOf = (name: string) =>
			facts.declarations
				.filter((declaration) => declaration.name === name)
				.map((declaration) => declaration.symbolId);
		const targetsOf = (name: string) =>
			facts.references
				.filter((reference) => reference.name === name)
				.map((reference) =>
					reference.binding.status === "bound" ? reference.binding.symbolId : reference.binding,
				);

		for (const name of ["side", "width", "deep"]) {
			const [id] = idOf(name);
			expect(idOf(name), name).toHaveLength(1);
			expect(targetsOf(name).length, name).toBeGreaterThan(0);
			expect(
				targetsOf(name).every((target) => target === id),
				name,
			).toBe(true);
		}
		// A getter and its setter are one property, which its first declaration names.
		const getter = idOf("area")[0] as string;
		expect(targetsOf("area")).toEqual([getter, getter]);
		provider.shutdown();
	});

	it("binds a value and a type sharing a name by the use's position, and keeps a merge one symbol", () => {
		const files = {
			"d.ts": "export const N = 1;\nexport type N = number;\n",
			"use.ts": ['import { N } from "./d";', "let x = N;", "let y: N = x;", "type Q = typeof N;"].join("\n"),
			"user.ts": [
				'export const User = { name: "" };',
				"export type User = typeof User;",
				"export function check(u: User): User { return { name: User.name + u.name }; }",
				"export type Name = typeof User.name;",
			].join("\n"),
			"merge.ts": [
				"export interface Box {}",
				"export class Box {}",
				"const box: Box = new Box();",
				"export function Space() {}",
				"export namespace Space { export interface Item {} }",
				"let item: Space.Item;",
				"class Holder implements Space.Item {}",
				"Space();",
			].join("\n"),
		};
		const provider = harness();
		provider.initialize(workspace(files));
		const bindings = (module: keyof typeof files, name: string) =>
			provider
				.parseFile({ module, contentHash: module, text: files[module] })
				.references.filter((reference) => reference.name === name)
				.map(({ range, binding }) => {
					if (binding.status !== "bound") return `${range.start.line} ${binding.status}`;
					return `${range.start.line} ${binding.symbolId.slice(binding.symbolId.lastIndexOf(" ") + 1)}`;
				});
		provider.parseFile({ module: "d.ts", contentHash: "d.ts", text: files["d.ts"] });

		expect(bindings("use.ts", "N")).toEqual(["1 N.", "2 N#", "3 N."]);
		expect(bindings("user.ts", "User")).toEqual(["1 User.", "2 User#", "2 User#", "2 User.", "3 User."]);
		// A merge stays one symbol; a namespace position reads every meaning of a function and namespace pair.
		expect(bindings("merge.ts", "Box")).toEqual(["2 Box#", "2 Box#"]);
		expect(bindings("merge.ts", "Space")).toEqual(["5 ambiguous", "7 Space()."]);
		// A heritage receiver is no reference, though a caller may still bind its position.
		const heritage = files["merge.ts"].indexOf("Space.Item {}");
		const range = {
			start: rangeAt(files["merge.ts"], heritage).start,
			end: rangeAt(files["merge.ts"], heritage).start,
		};
		expect(provider.bind({ module: "merge.ts", name: "Space", range }).status).toBe("ambiguous");
		provider.shutdown();
	});

	it("binds same-file references in an explicitly included JavaScript file", () => {
		const text =
			"var _N=Object.create;function fN($,v){return $}class Q4{}class W3 extends Q4{constructor(){super();fN(W3,1)}}";
		const root = workspace({
			"tsconfig.json": JSON.stringify({ include: ["src/**/*.ts"] }),
			"lexicon.json": JSON.stringify({ include: ["dist/**"] }),
			"src/index.ts": "export const source = 1;\n",
			"dist/cycle-mcp.js": text,
		});
		const provider = harness();
		provider.initialize(root);
		const facts = provider.parseFile({ module: "dist/cycle-mcp.js", contentHash: "cycle", text });
		const q4 = facts.declarations.find((declaration) => declaration.name === "Q4");
		const extendsReference = facts.references.find((reference) => reference.name === "Q4");
		const callReference = facts.references.find((reference) => reference.name === "fN");
		if (q4 === undefined) throw new Error("base declaration missing");

		expect(q4).toBeDefined();
		expect(extendsReference?.role).toBe("extends");
		expect(extendsReference?.binding).toEqual({
			status: "bound",
			symbolId: q4.symbolId,
			provenance: "bound",
		});
		expect(callReference?.binding).toMatchObject({ status: "bound", provenance: "bound" });
		provider.shutdown();
	});

	it(
		"keeps reference facts deterministic across sessions and program admission order",
		() => {
			const files = {
				"a.ts": "function shared(){}\n",
				"b.ts": "function shared(){}\n",
				"use.ts": "shared();\n",
			};
			const root = workspace(files);
			const parse = (order: (keyof typeof files)[]) => {
				const provider = harness();
				provider.initialize(root);
				for (const module of order) provider.parseFile({ module, contentHash: module, text: files[module] });
				const first = provider.parseFile({ module: "use.ts", contentHash: "use", text: files["use.ts"] });
				const second = provider.parseFile({ module: "use.ts", contentHash: "use", text: files["use.ts"] });
				provider.shutdown();
				return [first.references, second.references] as const;
			};

			const [sameSession, sameSessionAgain] = parse(["a.ts", "b.ts", "use.ts"]);
			const [freshSession, freshSessionAgain] = parse(["a.ts", "b.ts", "use.ts"]);
			const [reordered] = parse(["b.ts", "a.ts", "use.ts"]);
			expect(sameSessionAgain).toEqual(sameSession);
			expect(freshSession).toEqual(sameSession);
			expect(freshSessionAgain).toEqual(sameSession);
			expect(reordered).toEqual(sameSession);
			expect(sameSession[0]?.binding).toEqual({
				status: "ambiguous",
				candidates: ["lexicon typescript a.ts shared().", "lexicon typescript b.ts shared()."],
				provenance: "bound",
			});

			const fallbackText = "var A={run:()=>H()};function H(){}";
			const fallbackRoot = workspace({
				"tsconfig.json": JSON.stringify({ include: ["src/**/*.ts"] }),
				"src/index.ts": "export const source = 1;\n",
				"dist/bundle.js": fallbackText,
			});
			const parseFallback = () => {
				const provider = harness();
				provider.initialize(fallbackRoot);
				const first = provider.parseFile({
					module: "dist/bundle.js",
					contentHash: "bundle",
					text: fallbackText,
				});
				const second = provider.parseFile({
					module: "dist/bundle.js",
					contentHash: "bundle",
					text: fallbackText,
				});
				provider.shutdown();
				return [first.references, second.references] as const;
			};
			const [fallbackFirst, fallbackSecond] = parseFallback();
			const [fallbackFresh] = parseFallback();
			expect(fallbackSecond).toEqual(fallbackFirst);
			expect(fallbackFresh).toEqual(fallbackFirst);
		},
		// Five programs built in turn; the parallel gate triples their time.
		{ timeout: 30_000 },
	);

	it("attributes initializer references to the declared variable", () => {
		const text =
			'var A={run:($)=>H($),name:"x"},B=[K(1)];function H($){return $}function K($){return $}var C=_(()=>H(2));';
		const root = workspace({ "bundle.ts": text });
		const provider = harness();
		provider.initialize(root);
		const facts = provider.parseFile({ module: "bundle.ts", contentHash: "bundle", text });
		const declaration = (name: string) => facts.declarations.find((item) => item.name === name);
		const referenceFrom = (name: string, owner: string) =>
			facts.references.find((reference) => reference.name === name && reference.fromId === owner);

		const a = declaration("A");
		const b = declaration("B");
		const c = declaration("C");
		const h = declaration("H");
		const k = declaration("K");
		// A function-valued property is A's member, and holds its own body's references.
		const run = declaration("run");
		const hFromA = referenceFrom("H", run?.symbolId ?? "");
		const kFromB = referenceFrom("K", b?.symbolId ?? "");
		const hFromC = referenceFrom("H", c?.symbolId ?? "");
		if (h === undefined || k === undefined) throw new Error("fan-out declaration missing");

		expect(run?.containerId).toBe(a?.symbolId);
		expect(hFromA?.binding).toEqual({ status: "bound", symbolId: h.symbolId, provenance: "bound" });
		expect(kFromB?.binding).toEqual({ status: "bound", symbolId: k.symbolId, provenance: "bound" });
		expect(hFromC?.binding).toEqual({ status: "bound", symbolId: h.symbolId, provenance: "bound" });
		const fanOut = new Set(
			facts.references
				.filter(
					(reference) =>
						[a?.symbolId, run?.symbolId].includes(reference.fromId) && reference.binding.status === "bound",
				)
				.map((reference) => (reference.binding.status === "bound" ? reference.binding.symbolId : undefined)),
		);
		const parameter = facts.declarations.find((item) => item.name === "$" && item.containerId === run?.symbolId);
		expect(fanOut).toEqual(new Set([h?.symbolId, parameter?.symbolId]));
		expect(
			facts.references
				.filter((reference) => reference.fromId !== undefined)
				.every(
					(reference) => parseSymbolId(reference.fromId as string)?.descriptors.at(-1)?.kind !== "parameter",
				),
		).toBe(true);
		provider.shutdown();
	});

	it("binds contextually typed object property names", () => {
		const text = [
			"interface Options { retries: number; nested: { enabled: boolean } }",
			"declare function consume(options: Options): void;",
			"const typed: Options = { retries: 1, nested: { enabled: true } };",
			"consume({ retries: 2, nested: { enabled: false } });",
			"function make(): Options { return { retries: 3, nested: { enabled: true } }; }",
			"const untyped = { retries: 4 };",
		].join("\n");
		const root = workspace({ "properties.ts": text });
		const provider = harness();
		provider.initialize(root);
		const facts = provider.parseFile({ module: "properties.ts", contentHash: "properties", text });
		const propertyIds = new Map(
			facts.declarations
				.filter(
					(declaration) =>
						declaration.kind === "property" &&
						parseSymbolId(declaration.symbolId)?.descriptors[0]?.name === "Options",
				)
				.map((declaration) => [declaration.name, declaration.symbolId]),
		);
		const references = facts.references.filter(
			(reference) => reference.role === "read" && ["retries", "enabled"].includes(reference.name),
		);
		expect(references.map((reference) => reference.name)).toEqual([
			"retries",
			"enabled",
			"retries",
			"enabled",
			"retries",
			"enabled",
		]);
		for (const reference of references) {
			expect(textAt(text, reference.range)).toBe(reference.name);
			const symbolId = propertyIds.get(reference.name);
			if (symbolId === undefined) throw new Error("property declaration missing");
			expect(reference.binding).toEqual({
				status: "bound",
				symbolId,
				provenance: "bound",
			});
		}
		provider.shutdown();
	});

	it("binds a use of a typed object's member to the member its declared type reads", () => {
		const text = [
			"interface Probe { owner(): boolean; words: string[] }",
			"interface Tool { name: string; words: string[] }",
			"const words: string[] = [];",
			"export const probe: Probe = { owner: () => true, words };",
			'export const tool = { name: "x", words } satisfies Tool;',
			"probe.owner();",
			"tool.name;",
			"tool.words;",
		].join("\n");
		const root = workspace({ "typed.ts": text });
		const provider = harness();
		provider.initialize(root);
		const facts = provider.parseFile({ module: "typed.ts", contentHash: "typed", text });
		const dotted = (symbolId: string) =>
			(parseSymbolId(symbolId)?.descriptors ?? []).map((descriptor) => descriptor.name).join(".");
		const uses = facts.references
			.filter((reference) => reference.range.start.line >= 3 && reference.role !== "typeUse")
			.map((reference) => [
				reference.range.start.line,
				reference.name,
				reference.binding.status === "bound" ? dotted(reference.binding.symbolId) : reference.binding.status,
			]);

		expect(uses).toEqual([
			[3, "owner", "Probe.owner"],
			[3, "words", "words"],
			[4, "name", "Tool.name"],
			[4, "words", "words"],
			[5, "probe", "probe"],
			[5, "owner", "Probe.owner"],
			[6, "tool", "tool"],
			[6, "name", "tool.name"],
			[7, "tool", "tool"],
			[7, "words", "tool.words"],
		]);
		provider.shutdown();
	});

	it("binds a shorthand property once to its local declaration", () => {
		const text = [
			"interface Options { retries: number }",
			"declare function consume(options: Options): void;",
			"const retries = 1;",
			"consume({ retries });",
		].join("\n");
		const root = workspace({ "shorthand.ts": text });
		const provider = harness();
		provider.initialize(root);
		const facts = provider.parseFile({ module: "shorthand.ts", contentHash: "shorthand", text });
		const local = facts.declarations.find(
			(declaration) => declaration.name === "retries" && declaration.kind === "constant",
		);
		const references = facts.references.filter(
			(reference) => reference.name === "retries" && reference.role === "read",
		);
		if (local === undefined) throw new Error("local declaration missing");

		expect(references).toHaveLength(1);
		expect(references[0]?.binding).toEqual({
			status: "bound",
			symbolId: local.symbolId,
			provenance: "bound",
		});
		provider.shutdown();
	});

	it("keeps static gaps distinct from external, dynamic, and runtime references", () => {
		const text = [
			'import * as path from "node:path";',
			'import packageJson from "./data.json";',
			"const files: string[] = [];",
			"const dynamic: any = files;",
			"export function run(value: string) {",
			"  packageJson.version;",
			"  path.dirname(value);",
			"  files.push(value);",
			"  dynamic.missing();",
			"  for (const local of files) local;",
			"  (value as unknown as { hidden: string }).hidden;",
			"  return import.meta;",
			"}",
			"",
		].join("\n");
		const root = workspace({ "cases.ts": text });
		writeFileSync(path.join(root, "data.json"), '{"version":"test"}\n');
		const provider = harness();
		provider.initialize(root);
		const facts = provider.parseFile({ module: "cases.ts", contentHash: "cases", text });
		const reference = (name: string, role: "call" | "read") =>
			facts.references.find((candidate) => candidate.name === name && candidate.role === role)?.binding;

		expect(reference("value", "read")).toEqual({
			status: "bound",
			symbolId: "lexicon typescript cases.ts run().(value)",
			provenance: "bound",
		});
		expect(reference("local", "read")).toEqual({
			status: "bound",
			symbolId: "lexicon typescript cases.ts run().local.",
			provenance: "bound",
		});
		expect(reference("hidden", "read")).toEqual({
			status: "unbound",
			reason: "NotIndexed",
			detail: "the declaration is not in the symbol index",
		});
		expect(reference("dirname", "call")).toEqual({
			status: "unbound",
			reason: "ExternalDependency",
			detail: "the property belongs to an external dependency",
		});
		expect(reference("version", "read")).toEqual({
			status: "unbound",
			reason: "NotIndexed",
			detail: "the imported declaration is not in the symbol index",
		});
		expect(provider.typeOf({ module: "cases.ts", range: rangeAt(text, text.indexOf("version")) })).toEqual({
			status: "unknown",
			reason: "NotIndexed",
			detail: "the imported declaration is not in the symbol index",
		});
		expect(reference("push", "call")).toEqual({
			status: "unbound",
			reason: "ExternalDependency",
			detail: "the declaration is outside the workspace",
		});
		expect(reference("missing", "call")).toEqual({
			status: "unbound",
			reason: "DynamicallyTyped",
			detail: "the property receiver has type any",
		});
		expect(reference("meta", "read")).toEqual({
			status: "unbound",
			reason: "RuntimeConstructed",
			detail: "import.meta is runtime metadata",
		});
		expect(provider.typeOf({ module: "cases.ts", range: rangeAt(text, text.indexOf("dirname")) })).toEqual({
			status: "unknown",
			reason: "ExternalDependency",
			detail: "the property belongs to an external dependency",
		});
		expect(provider.typeOf({ module: "cases.ts", range: rangeAt(text, text.indexOf("push")) })).toEqual({
			status: "unknown",
			reason: "ExternalDependency",
			detail: "the declaration is outside the workspace",
		});
		expect(provider.typeOf({ module: "cases.ts", range: rangeAt(text, text.indexOf("path")) })).toEqual({
			status: "unknown",
			reason: "ExternalDependency",
			detail: "the declaration is outside the workspace",
		});
		expect(provider.typeOf({ module: "cases.ts", range: rangeAt(text, text.indexOf("missing")) })).toEqual({
			status: "unknown",
			reason: "DynamicallyTyped",
			detail: "the property receiver has type any",
		});
		expect(provider.typeOf({ module: "cases.ts", range: rangeAt(text, text.indexOf("meta")) })).toEqual({
			status: "unknown",
			reason: "RuntimeConstructed",
			detail: "import.meta is runtime metadata",
		});
		provider.shutdown();
	});

	// Dangling rather than dynamic, so a move that leaves one behind reports it.
	it("calls a local import that binds nothing broken: a missing export, a script or a missing file", () => {
		const root = workspace({
			"script.ts": "const shared = 1;\n",
			"module.ts": "const shared = 1;\nexport const other = 2;\n",
			"exported.ts": "export const shared = 1;\n",
		});
		const provider = harness();
		provider.initialize(root);
		const bindingFrom = (specifier: string) => {
			const text = `import { shared } from "${specifier}";\nexport const copy = shared;\n`;
			const facts = provider.parseFile({ module: "use.ts", contentHash: specifier, text });
			const binding = facts.references.find((reference) => reference.name === "shared")?.binding;
			return binding?.status === "unbound" ? binding.reason : binding?.status;
		};

		expect(["./script", "./module", "./missing", "./exported"].map(bindingFrom)).toEqual([
			"BrokenImport",
			"BrokenImport",
			"BrokenImport",
			"bound",
		]);
		provider.shutdown();
	});

	it("reports a runtime reason only when the requested range has no source token", () => {
		const text = "export const value = 1;\n";
		const root = workspace({ "tokens.ts": text });
		const provider = harness();
		provider.initialize(root);

		expect(
			provider.bind({ module: "tokens.ts", name: "missing", range: rangeAt(text, text.indexOf("value")) }),
		).toEqual({ status: "unbound", reason: "RuntimeConstructed", detail: "the name is not a source token" });
		expect(provider.typeOf({ module: "tokens.ts", range: rangeAt(text, text.indexOf(";")) })).toEqual({
			status: "unknown",
			reason: "RuntimeConstructed",
			detail: "the range is not a source token",
		});
		provider.shutdown();
	});

	it("types a readable declaration range from a cold program", () => {
		const text = "export const value: number = 1;\n";
		const root = workspace({ "value.ts": text });
		const provider = harness();
		provider.initialize(root);

		expect(provider.typeOf({ module: "value.ts", range: rangeAt(text, text.indexOf("value")) })).toMatchObject({
			status: "known",
			display: "number",
			provenance: "declared",
		});
		provider.shutdown();
	});

	it("types several readable declaration ranges from cold programs", () => {
		const files = {
			"a.ts": "export const a: number = 1;\n",
			"b.ts": 'export const b: string = "b";\n',
			"c.ts": "export const c: boolean = true;\n",
		};
		const displays = { "a.ts": "number", "b.ts": "string", "c.ts": "boolean" };
		const root = workspace(files);
		const provider = harness();
		provider.initialize(root);

		for (const [module, text] of Object.entries(files)) {
			expect(
				provider.typeOf({ module, range: rangeAt(text, text.indexOf("const ") + "const ".length) }),
			).toMatchObject({
				status: "known",
				display: displays[module as keyof typeof displays],
				provenance: "declared",
			});
		}
		provider.shutdown();
	});

	it("keeps lib-backed array types precise", () => {
		const text = "export const values: string[] = [];\n";
		const root = workspace({ "arrays.ts": text });
		const provider = harness();
		provider.initialize(root);
		const facts = provider.parseFile({ module: "arrays.ts", contentHash: "arrays", text });
		const target = facts.declarations.find((declaration) => declaration.name === "values");

		expect(provider.typeOf({ symbolId: target?.symbolId ?? "" })).toEqual({
			status: "known",
			display: "string[]",
			provenance: "declared",
		});
		provider.shutdown();
	});

	it("returns indexed ids for named known and inferred types", () => {
		const text = [
			"export class Foo {}",
			"export class Bar {}",
			"export type Alias = Foo;",
			"export class Box<T> {}",
			"export const annotated: Foo = new Foo();",
			"export const inferred = new Foo();",
			"export const aliased: Alias = new Foo();",
			"export const generic = new Box<number>();",
			"export const primitive: number = 1;",
			"export const structural: { value: number } = { value: 1 };",
			"export let union: Foo | Bar;",
			"export const external: Date = new Date();",
			"",
		].join("\n");
		const root = workspace({ "types.ts": text });
		const provider = harness();
		provider.initialize(root);
		const facts = provider.parseFile({ module: "types.ts", contentHash: "types", text });
		const typeOf = (name: string) => {
			const declaration = facts.declarations.find((candidate) => candidate.name === name);
			return provider.typeOf({ symbolId: declaration?.symbolId ?? "" });
		};
		const idOf = (name: string) => facts.declarations.find((candidate) => candidate.name === name)?.symbolId;

		expect(typeOf("annotated")).toEqual({
			status: "known",
			display: "Foo",
			provenance: "declared",
			symbolId: idOf("Foo"),
		});
		expect(typeOf("inferred")).toEqual({
			status: "inferred",
			display: "Foo",
			basis: "initializer",
			symbolId: idOf("Foo"),
		});
		expect(typeOf("aliased")).toEqual({
			status: "known",
			display: "Foo",
			provenance: "declared",
			symbolId: idOf("Alias"),
		});
		expect(typeOf("Alias")).toEqual({
			status: "known",
			display: "Foo",
			provenance: "declared",
			symbolId: idOf("Alias"),
		});
		expect(typeOf("generic")).toEqual({
			status: "inferred",
			display: "Box<number>",
			basis: "initializer",
			symbolId: idOf("Box"),
		});
		expect(typeOf("primitive")).toEqual({ status: "known", display: "number", provenance: "declared" });
		expect(typeOf("structural")).toEqual({
			status: "known",
			display: "{ value: number; }",
			provenance: "declared",
		});
		expect(typeOf("union")).toEqual({
			status: "known",
			display: "Foo | Bar",
			provenance: "declared",
		});
		expect(typeOf("external")).toEqual({ status: "known", display: "Date", provenance: "declared" });
		provider.shutdown();
	});

	it("maps imported named types to their source declaration ids", () => {
		const files = {
			"base.ts": "export class Foo {}\n",
			"use.ts": [
				'import { Foo } from "./base";',
				"export const annotated: Foo = new Foo();",
				"export const inferred = new Foo();",
				"",
			].join("\n"),
		};
		const root = workspace(files);
		const provider = harness();
		provider.initialize(root);
		const baseFacts = provider.parseFile({ module: "base.ts", contentHash: "base", text: files["base.ts"] });
		const useFacts = provider.parseFile({ module: "use.ts", contentHash: "use", text: files["use.ts"] });
		const fooId = baseFacts.declarations.find((declaration) => declaration.name === "Foo")?.symbolId;

		for (const name of ["annotated", "inferred"]) {
			const declaration = useFacts.declarations.find((candidate) => candidate.name === name);
			const type = provider.typeOf({ symbolId: declaration?.symbolId ?? "" });
			expect(type).toMatchObject({ symbolId: fooId });
		}
		provider.shutdown();
	});

	it("surfaces literal facts and declaration metrics through parseFile", () => {
		const text = [
			'export const value = "a\\nb";',
			"export const enabled = true;",
			"export function run(flag: boolean) {",
			"  if (flag) return 1;",
			"  return 0;",
			"}",
			"",
		].join("\n");
		const root = workspace({ "facts.ts": text });
		const provider = harness();
		const initialized = provider.initialize(root);
		const facts = provider.parseFile({ module: "facts.ts", contentHash: "facts", text });
		const run = facts.declarations.find((declaration) => declaration.name === "run");

		expect(initialized.tiers).toMatchObject({ literals: true, metrics: true });
		expect(facts.literals.map((literal) => [literal.kind, literal.value, literal.number])).toEqual([
			["string", "a\nb", undefined],
			["boolean", "true", undefined],
			["number", "1", 1],
			["number", "0", 0],
		]);
		expect(run?.metrics).toEqual({ lines: 4, parameters: 1, nesting: 1, branches: 2 });
		provider.shutdown();
	});

	it("labels inferred types with the evidence that determined them", () => {
		const text = [
			"const value = 1;",
			"const dynamic = missing;",
			"export function returns() { return value; }",
			"export function noReturn() {}",
			"",
		].join("\n");
		const root = workspace({ "inference.ts": text });
		const provider = harness();
		provider.initialize(root);
		const facts = provider.parseFile({ module: "inference.ts", contentHash: "inference", text });
		const typeOf = (name: string) => {
			const declaration = facts.declarations.find((candidate) => candidate.name === name);
			return provider.typeOf({ symbolId: declaration?.symbolId ?? "" });
		};

		expect(typeOf("value")).toEqual({ status: "inferred", display: "1", basis: "initializer" });
		expect(typeOf("returns")).toMatchObject({ status: "inferred", basis: "return statements" });
		expect(typeOf("noReturn")).toEqual({
			status: "inferred",
			display: "() => void",
			basis: "function body",
			symbolId: facts.declarations.find((candidate) => candidate.name === "noReturn")?.symbolId,
		});
		expect(typeOf("dynamic")).toEqual({
			status: "unknown",
			reason: "DynamicallyTyped",
			detail: "the inferred type is any",
		});
		provider.shutdown();
	});

	it("preserves literal return unions and inferred provenance", () => {
		const text = [
			"export function pick(a: boolean, b: boolean) {",
			'  if (a) return "foo";',
			'  else if (b) return "bar";',
			'  return "baz";',
			"}",
			"export function maybe(a: boolean) {",
			'  if (a) return "foo";',
			"}",
			"export function annotated(a: boolean): string {",
			'  if (a) return "foo";',
			'  return "bar";',
			"}",
			"",
		].join("\n");
		const root = workspace({ "return-unions.ts": text });
		const provider = harness();
		provider.initialize(root);
		const facts = provider.parseFile({ module: "return-unions.ts", contentHash: "return-unions", text });
		const typeOf = (name: string) => {
			const declaration = facts.declarations.find((candidate) => candidate.name === name);
			return provider.typeOf({ symbolId: declaration?.symbolId ?? "" });
		};

		expect(typeOf("pick")).toEqual({
			status: "inferred",
			display: '(a: boolean, b: boolean) => "foo" | "bar" | "baz"',
			basis: "return statements",
			symbolId: facts.declarations.find((candidate) => candidate.name === "pick")?.symbolId,
		});
		expect(typeOf("maybe")).toEqual({
			status: "inferred",
			display: '(a: boolean) => "foo" | undefined',
			basis: "return statements",
			symbolId: facts.declarations.find((candidate) => candidate.name === "maybe")?.symbolId,
		});
		expect(typeOf("annotated")).toEqual({
			status: "known",
			display: "(a: boolean) => string",
			provenance: "declared",
			symbolId: facts.declarations.find((candidate) => candidate.name === "annotated")?.symbolId,
		});
		provider.shutdown();
	});

	it("types a constructor through its class construct signature", () => {
		const text = "export class Box { constructor(value: string) {} }\n";
		const root = workspace({ "constructor.ts": text });
		const provider = harness();
		provider.initialize(root);
		const facts = provider.parseFile({ module: "constructor.ts", contentHash: "constructor", text });
		const target = facts.declarations.find((declaration) => declaration.kind === "constructor");
		const type = provider.typeOf({ symbolId: target?.symbolId ?? "" });

		expect(type).toMatchObject({ status: "known", provenance: "declared" });
		if (type.status === "known") {
			expect(type.display).toContain("value: string");
			expect(type.display).toContain("Box");
		}
		provider.shutdown();
	});

	it("extracts a parsed file once for its facts and its own bindings", () => {
		const text = "export function add(value: number) { return value; }\nadd(1);\n";
		const root = workspace({ "once.ts": text });
		const provider = harness();
		provider.initialize(root);
		const memo = provider.provider.store.memo.bind(provider.provider.store);
		let extractions = 0;
		provider.provider.store.memo = <R>(key: string, compute: () => R) =>
			memo(key, () => {
				if (key.startsWith("extract:")) extractions += 1;
				return compute();
			});
		const facts = provider.parseFile({ module: "once.ts", contentHash: "once", text });

		expect(facts.references.map((reference) => reference.binding.status)).toEqual(["bound", "bound"]);
		expect(extractions).toBe(1);
		provider.shutdown();
	});

	it("gives same-named locals their own ids, each typed and bound as itself", () => {
		const text = [
			"export function run(kind: string) {",
			'  if (kind === "a") { const value = 1; return value; }',
			'  { const value = "two"; return value; }',
			"}",
			"",
		].join("\n");
		const root = workspace({ "locals.ts": text });
		const provider = harness();
		provider.initialize(root);
		const facts = provider.parseFile({ module: "locals.ts", contentHash: "locals", text });
		const values = facts.declarations.filter((declaration) => declaration.name === "value");
		const reads = facts.references.filter((reference) => reference.name === "value");

		expect(new Set(values.map((value) => value.symbolId)).size).toBe(2);
		expect(values.map((value) => provider.typeOf({ symbolId: value.symbolId }))).toMatchObject([
			{ display: "1" },
			{ display: '"two"' },
		]);
		expect(reads.map((read) => (read.binding.status === "bound" ? read.binding.symbolId : undefined))).toEqual(
			values.map((value) => value.symbolId),
		);
		provider.shutdown();
	});
});

describe("source admission", () => {
	it("refuses an out-of-range source position", () => {
		const module = "stale.ts";
		const text = "export const value = 1;\n";
		const root = workspace({ [module]: text });
		const provider = harness();
		provider.initialize(root);
		const range = { start: { line: 0, character: 99 }, end: { line: 0, character: 100 } };

		expect(provider.bind({ module, name: "value", range })).toEqual({
			status: "unbound",
			reason: "RuntimeConstructed",
			detail: "the range is not a source token",
		});
		expect(provider.typeOf({ module, range })).toEqual({
			status: "unknown",
			reason: "RuntimeConstructed",
			detail: "the range is not a source token",
		});
		provider.shutdown();
	});

	it("reports syntax diagnostics for several readable files", () => {
		const files = {
			"a.ts": "export const a = ;\n",
			"b.ts": "export const b = ;\n",
			"c.ts": "export const c = ;\n",
		};
		const root = workspace(files);
		const provider = harness();
		provider.initialize(root);

		for (const module of Object.keys(files)) {
			const facts = provider.parseFile({
				module,
				contentHash: module,
				text: (files as Record<string, string>)[module] as string,
			});
			expect(facts.diagnostics).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						severity: "error",
						message: expect.stringContaining("Expression expected"),
						path: module,
					}),
				]),
			);
		}
		provider.shutdown();
	});

	it("reports unsupported and missing source requests", () => {
		const root = workspace({ "present.ts": "export const value = 1;\n" });
		const provider = harness();
		provider.initialize(root);

		expect(provider.bind({ module: "notes.txt", name: "value", range: rangeAt("value", 0) })).toMatchObject({
			status: "unbound",
			reason: "NotImplemented",
		});
		expect(provider.bind({ module: "missing.ts", name: "value", range: rangeAt("value", 0) })).toMatchObject({
			status: "unbound",
			reason: "ParseError",
		});
		provider.shutdown();
	});

	it("types an anonymous default from its node, and answers a static block has no type", () => {
		const files = {
			"klass.ts": "export default class { x = 1; static { const y = 2; } }\n",
			"fn.ts": "export default function (a: number) { return a; }\n",
		};
		const provider = harness();
		provider.initialize(workspace(files));
		const typeOf = (module: keyof typeof files, pick: (declaration: { name: string; kind: string }) => boolean) => {
			const facts = provider.parseFile({ module, contentHash: module, text: files[module] });
			const declaration = facts.declarations.find(pick);
			return provider.typeOf({ symbolId: declaration?.symbolId ?? "" });
		};

		expect({
			klass: typeOf("klass.ts", (declaration) => declaration.kind === "class"),
			fn: typeOf("fn.ts", (declaration) => declaration.kind === "function"),
			block: typeOf("klass.ts", (declaration) => declaration.name === "static"),
		}).toMatchObject({
			klass: { status: "known", display: "default" },
			fn: { status: "known", display: "(a: number) => number" },
			block: { status: "unknown", reason: "DynamicallyTyped" },
		});
		provider.shutdown();
	});

	it("types nothing from a file the scope denies", () => {
		const files = {
			"secret.ts": 'export const secret = "hidden";\n',
			"uses.ts": 'import { secret } from "./secret";\nexport const shown = secret;\n',
		};
		const typeOfShown = (deny?: string[]) => {
			const provider = harness();
			provider.initialize(workspace(files), deny);
			const facts = provider.parseFile({ module: "uses.ts", contentHash: "uses", text: files["uses.ts"] });
			const shown = facts.declarations.find((declaration) => declaration.name === "shown");
			const type = provider.typeOf({ symbolId: shown?.symbolId ?? "" });
			provider.shutdown();
			return JSON.stringify(type).includes("hidden");
		};

		expect({ open: typeOfShown(), denied: typeOfShown(["secret.ts"]) }).toEqual({
			open: true,
			denied: false,
		});
	});
});

describe("outline depth", () => {
	it("echoes outline with declarations and imports only", () => {
		const files = { "cart.ts": 'import { z } from "./zed";\nexport class Cart {}\nconst noise = "literal";\n' };
		const root = workspace(files);
		const provider = harness();
		provider.initialize(root);

		const facts = provider.parseFile({
			module: "cart.ts",
			contentHash: "cart",
			text: files["cart.ts"],
			depth: "outline",
		});

		expect(facts.depth).toBe("outline");
		expect(facts.declarations.map((declaration) => declaration.name)).toContain("Cart");
		expect(facts.imports.map((statement) => statement.specifier)).toEqual(["./zed"]);
		expect(facts.references).toEqual([]);
		expect(facts.literals).toEqual([]);
		provider.shutdown();
	});

	it("still reports a syntax error at outline depth", () => {
		const files = { "broken.ts": "export function add( {\n" };
		const root = workspace(files);
		const provider = harness();
		provider.initialize(root);

		const facts = provider.parseFile({
			module: "broken.ts",
			contentHash: "broken",
			text: files["broken.ts"],
			depth: "outline",
		});

		expect(facts.diagnostics.some((diagnostic) => diagnostic.severity === "error")).toBe(true);
		provider.shutdown();
	});
});
