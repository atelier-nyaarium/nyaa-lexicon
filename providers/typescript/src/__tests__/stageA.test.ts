import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FileFacts } from "@nyaa-lexicon/protocol";
import ts from "typescript";
import { extractFile } from "../extract.js";
import { harness } from "./harness.js";

const roots: string[] = [];

function workspace(files: Record<string, string>, config = "{}"): string {
	const root = mkdtempSync(path.join(tmpdir(), "lexicon-ts-stage-a-"));
	roots.push(root);
	writeFileSync(path.join(root, "tsconfig.json"), config);
	for (const [module, text] of Object.entries(files)) {
		const target = path.join(root, module);
		mkdirSync(path.dirname(target), { recursive: true });
		writeFileSync(target, text);
	}
	return root;
}

function parse(files: Record<string, string>, module: string, config = "{}"): FileFacts {
	const provider = harness();
	provider.initialize(workspace(files, config));
	let answer: FileFacts | undefined;
	for (const [name, text] of Object.entries(files)) {
		const facts = provider.parseFile({ module: name, contentHash: name, text }) as FileFacts;
		if (name === module) answer = facts;
	}
	provider.shutdown();
	if (answer === undefined) throw new Error(`missing parsed facts: ${module}`);
	return answer;
}

/** What each emitted `a` module loads, keyed by its directory, from one full-program emit. */
function emittedLoads(root: string, config: string): Map<string, Set<string>> {
	const parsed = ts.parseJsonConfigFileContent(JSON.parse(config), ts.sys, root);
	const loads = new Map<string, Set<string>>();
	const host = ts.createCompilerHost(parsed.options);
	host.writeFile = (fileName, text) => {
		if (!/(^|\/)a\.[cm]?js$/.test(fileName)) return;
		const source = ts.createSourceFile("out.js", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
		const specifiers = new Set<string>();
		const visit = (node: ts.Node) => {
			if (
				(ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
				node.moduleSpecifier !== undefined &&
				ts.isStringLiteral(node.moduleSpecifier)
			)
				specifiers.add(node.moduleSpecifier.text);
			const argument = ts.isCallExpression(node) ? node.arguments[0] : undefined;
			if (
				ts.isCallExpression(node) &&
				ts.isIdentifier(node.expression) &&
				node.expression.text === "require" &&
				argument !== undefined &&
				ts.isStringLiteral(argument)
			)
				specifiers.add(argument.text);
			ts.forEachChild(node, visit);
		};
		visit(source);
		loads.set(path.dirname(path.relative(parsed.options.outDir ?? root, fileName)), specifiers);
	};
	ts.createProgram(parsed.fileNames, parsed.options, host).emit();
	return loads;
}

/** Every import statement of each case's `a` module is kept by extraction exactly when emit keeps it. */
function expectElisionMatchesEmit(options: object, cases: ReadonlyArray<Record<string, string>>): void {
	const config = JSON.stringify({ compilerOptions: options });
	const files = Object.fromEntries(
		cases.flatMap((entry, index) => Object.entries(entry).map(([name, text]) => [`case${index}/${name}`, text])),
	);
	const root = workspace(files, config);
	const loads = emittedLoads(root, config);
	const provider = harness();
	provider.initialize(root);
	const facts = new Map<string, FileFacts>();
	for (const [module, text] of Object.entries(files))
		facts.set(module, provider.parseFile({ module, contentHash: module, text }) as FileFacts);
	provider.shutdown();
	for (const [index, entry] of cases.entries()) {
		const module = Object.keys(entry).find((name) => name.startsWith("a."));
		const statements = facts.get(`case${index}/${module}`)?.imports ?? [];
		expect(statements.length, `case ${index}`).toBeGreaterThan(0);
		for (const { specifier, edges } of statements) {
			expect({
				index,
				specifier,
				decided: edges.every((edge) => edge.elided !== undefined),
				kept: edges.some((edge) => edge.elided === false),
			}).toEqual({
				index,
				specifier,
				decided: true,
				kept: loads.get(`case${index}`)?.has(specifier) ?? false,
			});
		}
	}
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Stage A load facts", () => {
	it("classifies reference phase and operation where syntax proves them", () => {
		const text = [
			"load();",
			"function later() { deferred(); }",
			"const immediate = (() => { invoked(); })();",
			"class C { static value = staticRead(); static { staticBlock(); } field = fieldRead(); get value2() { return getterBody(); } }",
			"const arrow = () => uncertain(); arrow();",
			"class Constructed { field = constructedField(); } new Constructed();",
			"const object = { get value() { return 1; } }; object.value;",
			"target.member; target(); new Target(); class Derived extends Base {}",
			"const stored = value; const { piece } = namespace;",
			"@decorator class Decorated {} target[key];",
			"export default defaultValue; const immediateParams = ((x = immediateDefault()) => {})();",
			"function deferredParams(x = deferredDefault()) {} class Computed { [computedName()]() {} }",
		].join("\n");
		const source = ts.createSourceFile("src/a.ts", text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
		const extracted = extractFile("src/a.ts", source);
		const refs = extracted.referenceBehavior;
		const phase = (name: string) => refs.find((reference) => reference.name === name)?.phase;
		const use = (name: string) => refs.find((reference) => reference.name === name)?.use;
		for (const name of [
			"load",
			"invoked",
			"staticRead",
			"staticBlock",
			"defaultValue",
			"immediateDefault",
			"computedName",
			"decorator",
		])
			expect(phase(name)).toBe("load");
		for (const name of ["deferred", "fieldRead", "getterBody", "deferredDefault"])
			expect(phase(name)).toBe("deferred");
		for (const name of ["uncertain", "constructedField", "value"]) expect(phase(name)).toBeUndefined();
		expect(use("target")).toBe("member");
		expect(refs.filter((reference) => reference.name === "target").map((reference) => reference.use)).toContain(
			"call",
		);
		expect(use("Target")).toBe("new");
		expect(use("Base")).toBe("extends");
		expect(use("value")).toBe("read");
		expect(use("namespace")).toBe("destructure");
		expect(use("decorator")).toBe("call");
	});

	it("marks import and require load timing", () => {
		const text = [
			'import "./side";',
			'export { value } from "./forward";',
			'const required = require("./required");',
			'function nested() { require("./nested"); }',
			'import("./dynamic");',
			'await import("./awaited");',
		].join("\n");
		const facts = parse({ "src/a.js": text }, "src/a.js", JSON.stringify({ compilerOptions: { allowJs: true } }));
		const loads = Object.fromEntries(facts.imports.map((entry) => [entry.specifier, entry.edges[0]?.loads]));
		expect(loads).toEqual({
			"./side": "static",
			"./forward": "static",
			"./required": "static",
			"./nested": "deferred",
			"./dynamic": "deferred",
			"./awaited": "static",
		});
	});

	it("matches runtime edge certainty against TypeScript full-program emit", () => {
		const value = "export const value = 1;";
		const klass = "export class C {}";
		const equals = "class C {}\nexport = C;";
		const both = "export interface T {} export const v = 1; export class C {}";
		const constEnum = "export const enum Code { Member = 1 }";
		const factory = "export function createElement(...args: unknown[]) { return args; }";
		const inner = "export namespace Inner { export function f() {} }";
		expectElisionMatchesEmit({ module: "CommonJS", target: "ES2020", jsx: "react" }, [
			{ "a.ts": 'import { T } from "./c"; let item: T;', "c.ts": both },
			{ "a.ts": 'import { v } from "./c"; let item: typeof v;', "c.ts": both },
			{ "a.ts": 'import * as ns from "./c"; let item: ns.T;', "c.ts": both },
			{ "a.ts": 'import * as ns from "./c"; export class A implements ns.T {}', "c.ts": both },
			{ "a.ts": 'import * as ns from "./c"; export interface J extends ns.T {}', "c.ts": both },
			{ "a.ts": 'import * as ns from "./c"; declare function f<X>(): X; f<ns.T>();', "c.ts": both },
			{ "a.ts": 'import { T } from "./c"; export default T;', "c.ts": both },
			{ "a.ts": 'import { T } from "./c"; export = T;', "c.ts": both },
			{ "a.ts": 'import { C } from "./c"; declare class D extends C {}', "c.ts": klass },
			{ "a.ts": 'import { C } from "./c"; declare global { var g: typeof C; }', "c.ts": klass },
			{ "a.ts": 'export { T } from "./c";', "c.ts": both },
			{ "a.ts": 'export { Code } from "./c";', "c.ts": constEnum },
			{ "a.ts": 'import { Code } from "./c"; export const n = Code.Member;', "c.ts": constEnum },
			{
				"a.ts": 'import { N } from "./c"; export const n = N.E.A;',
				"c.ts": "export namespace N { export const enum E { A = 1 } }",
			},
			{
				"a.ts": 'export { C } from "./b";',
				"b.ts": 'import type { C } from "./c"; export { C };',
				"c.ts": klass,
			},
			{ "a.ts": 'export { C } from "./b";', "b.ts": 'export type { C } from "./c";', "c.ts": klass },
			{ "a.ts": 'export { N } from "./c";', "c.ts": "export namespace N { export interface I {} }" },
			{ "a.ts": 'import * as ns from "./c"; import Y = ns.Inner; export {};', "c.ts": inner },
			{ "a.ts": 'import * as ns from "./c"; import Y = ns.Inner; Y.f();', "c.ts": inner },
			{ "a.ts": 'import { C } from "./c"; new C();', "c.ts": klass },
			{ "a.ts": 'import "./c";', "c.ts": value },
			{ "a.ts": 'import {} from "./c";', "c.ts": value },
			{ "a.ts": 'export * from "./c";', "c.ts": value },
			{ "a.ts": 'export {} from "./c";', "c.ts": value },
			{ "a.ts": 'export { type I } from "./c";', "c.ts": "export interface I {}" },
			{ "a.ts": 'import { C } from "./c"; const obj = { C };', "c.ts": klass },
			{ "a.ts": 'import { C } from "./c"; export { C };', "c.ts": klass },
			{ "a.ts": 'const value = require("./c");', "c.ts": "export = 1;" },
			{
				"a.ts": 'import { C } from "./barrel";\nimport { C as D } from "./c";\nnew D();',
				"barrel.ts": 'export { C } from "./c";',
				"c.ts": klass,
			},
			{ "a.ts": 'import C = require("./c");\nnew C();', "c.ts": equals },
			{ "a.ts": 'import C = require("./c");\nlet x: C;', "c.ts": equals },
			{ "a.ts": 'import C = require("./c");\nlet x: typeof C;', "c.ts": equals },
			{ "a.ts": 'export import C = require("./c");', "c.ts": equals },
			{ "a.ts": 'export import C = require("./c");', "c.ts": "interface C {}\nexport = C;" },
			{ "a.tsx": 'import * as React from "./c";\nexport const view = <div />;', "c.ts": factory },
			{
				"a.tsx":
					'/** @jsx h */\nimport { h } from "./h";\nimport * as React from "./c";\nexport const view = <div />;',
				"h.ts": "export function h(...args: unknown[]) { return args; }",
				"c.ts": factory,
			},
		]);
		expectElisionMatchesEmit({ module: "CommonJS", jsx: "react", jsxFactory: "h" }, [
			{
				"a.tsx": 'import { h } from "./h";\nimport * as React from "./c";\nexport const view = <div />;',
				"h.ts": "export function h(...args: unknown[]) { return args; }",
				"c.ts": factory,
			},
		]);
		expectElisionMatchesEmit({ module: "CommonJS", isolatedModules: true }, [
			{ "a.ts": 'export { Code } from "./c";', "c.ts": constEnum },
			{ "a.ts": 'import { Code } from "./c"; export const n = Code.Member;', "c.ts": constEnum },
		]);
		expectElisionMatchesEmit({ module: "CommonJS", preserveConstEnums: true }, [
			{ "a.ts": 'import { Code } from "./c";\nexport { Code };', "c.ts": constEnum },
		]);
		expectElisionMatchesEmit({ module: "ESNext", preserveValueImports: true }, [
			{ "a.ts": 'import { C } from "./c"; let item: C;', "c.ts": klass },
			{ "a.ts": 'export { T } from "./c";', "c.ts": both },
		]);
		expectElisionMatchesEmit({ module: "ESNext", verbatimModuleSyntax: true }, [
			{ "a.ts": 'import { T } from "./c";\nlet x: T;', "c.ts": both },
			{ "a.ts": 'import { type I } from "./c";\nlet x: I;', "c.ts": "export interface I {}" },
			{ "a.ts": 'import type { I } from "./c";\nlet x: I;', "c.ts": "export interface I {}" },
		]);
		expectElisionMatchesEmit({ module: "ESNext", allowJs: true, outDir: "out", rootDir: "." }, [
			{ "a.mjs": 'import { C } from "./c.mjs";', "c.mjs": klass },
			{ "a.js": 'import { C } from "./c.js";', "c.js": klass },
		]);
		expectElisionMatchesEmit({ module: "CommonJS", target: "ES5", lib: ["ES2015"], ignoreDeprecations: "6.0" }, [
			{
				"a.ts": 'import { P } from "./c"; export async function f(): P<void> {}',
				"c.ts": "export class P<T> extends Promise<T> {}",
			},
		]);
	}, 60000);

	it("elides every edge of a declaration file, which never runs", () => {
		const files = {
			"src/api.d.ts":
				'import "./side";\nexport * from "./impl";\nimport { Impl } from "./impl";\nexport declare const made: typeof Impl;',
			"src/impl.ts": "export class Impl {}",
			"src/side.ts": "export {};",
		};
		for (const verbatimModuleSyntax of [false, true]) {
			const config = JSON.stringify({ compilerOptions: { module: "ESNext", verbatimModuleSyntax } });
			const facts = parse(files, "src/api.d.ts", config);
			expect(facts.imports.flatMap((statement) => statement.edges.map((edge) => edge.elided))).toEqual([
				true,
				true,
				true,
			]);
		}
	});

	it("matches decorator metadata elision against TypeScript full-program emit", () => {
		const dec = "declare function dec(...args: unknown[]): any;";
		const klass = "export class C<T = unknown> {}";
		const decorated = (body: string, imported = "{ C }", declarations = klass) => ({
			"a.ts": `import ${imported} from "./c";\n${dec}\n${body}`,
			"c.ts": declarations,
		});
		expectElisionMatchesEmit({ module: "CommonJS", experimentalDecorators: true, emitDecoratorMetadata: true }, [
			decorated("class B { constructor(@dec first: number, second: C) {} }"),
			decorated("@dec class B { constructor(value: C) {} }"),
			decorated("class B { @dec m(value: C): void {} }"),
			decorated("class B { @dec get p() { return null; } set p(value: C) {} }"),
			decorated("class B { @dec get p(): number { return 1; } set p(value: C) {} }"),
			decorated("class B { @dec m(...xs: C[]) {} }"),
			decorated("class B { m(@dec x: number): C { return null!; } }"),
			decorated("class B { @dec m(this: C) {} }"),
			decorated("const B = class { @dec p!: C; };"),
			decorated("class B { @dec p!: C<number>; }"),
			decorated("class B { @dec p!: (C); }"),
			decorated("class B { @dec p!: C[]; }"),
			decorated("class B { @dec p!: Array<C>; }"),
			decorated("class B { @dec p!: Promise<C>; }"),
			decorated("class B { @dec p!: C | null; }"),
			decorated("class B { @dec p!: ns.C; }", "* as ns"),
			decorated("class B { @dec p!: Alias; }", "{ Alias }", "export type Alias = C; export class C {}"),
			decorated("class B { @dec p!: C; }", "{ C }", "export enum C { A }"),
			decorated("class B { @dec p!: F; }", "{ F }", "export function F() {} export interface F {}"),
			decorated("class B { @dec p!: C; }", "type { C }"),
		]);
		expectElisionMatchesEmit(
			{ module: "CommonJS", strict: false, experimentalDecorators: true, emitDecoratorMetadata: true },
			[decorated("class B { @dec p!: C | null; }")],
		);
		expectElisionMatchesEmit({ module: "CommonJS", emitDecoratorMetadata: true }, [
			decorated("class B { @dec p!: C; }"),
		]);
	}, 60000);

	it("uses referenced project options for extraction and path resolution", () => {
		const files = {
			"packages/lib/tsconfig.json": JSON.stringify({
				compilerOptions: {
					module: "CommonJS",
					baseUrl: ".",
					paths: { "@local/*": ["src/*"] },
				},
				include: ["src/**/*.ts"],
			}),
			"packages/lib/src/index.ts": 'import { Thing } from "@local/thing"; export const value = new Thing();',
			"packages/lib/src/thing.ts": "export class Thing {}",
		};
		const rootConfig = JSON.stringify({ files: [], references: [{ path: "./packages/lib" }] });
		const provider = harness();
		provider.initialize(workspace(files, rootConfig));
		const facts = provider.parseFile({
			module: "packages/lib/src/index.ts",
			contentHash: "index",
			text: files["packages/lib/src/index.ts"] ?? "",
		}) as FileFacts;
		expect(facts.imports[0]?.edges[0]?.elided).toBe(false);
		expect(facts.references.find((reference) => reference.name === "Thing")?.binding.status).toBe("bound");
		expect(
			provider.resolveImport({ fromModule: "packages/lib/src/index.ts", specifier: "@local/thing" }),
		).toMatchObject({
			status: "resolved",
			landing: { kind: "module", module: "packages/lib/src/thing.ts" },
		});
		provider.shutdown();
	});

	it("marks TypeScript require calls static only when module load invokes the function", () => {
		const facts = parse(
			{
				"src/a.ts": [
					'function reached() { require("./reached"); }',
					"reached();",
					'function later() { require("./later"); }',
					'(() => require("./iife"))();',
					'const arrow = () => require("./arrow");',
					"arrow();",
					'function outer() { class K { constructor() { require("./constructed"); } } }',
					"outer();",
				].join("\n"),
			},
			"src/a.ts",
		);
		expect(Object.fromEntries(facts.imports.map((entry) => [entry.specifier, entry.edges[0]?.loads]))).toEqual({
			"./reached": "static",
			"./later": "deferred",
			"./iife": "static",
			"./arrow": "static",
			"./constructed": "deferred",
		});
	});

	it("binds a reference through the condition its import's module system selects", () => {
		const files = {
			"package.json": JSON.stringify({
				name: "self",
				type: "module",
				imports: { "#b": { import: "./b.js", require: "./b-cjs.cjs" } },
			}),
			"a.ts": 'import { B } from "#b";\nexport const A = B + 1;',
			"b.ts": "export const B = 1;",
			"b-cjs.cts": "export const other = 1;",
		};
		const provider = harness();
		provider.initialize(
			workspace(files, JSON.stringify({ compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext" } })),
		);
		for (const module of ["b.ts", "b-cjs.cts"])
			provider.parseFile({ module, contentHash: module, text: files[module as keyof typeof files] });
		const facts = provider.parseFile({ module: "a.ts", contentHash: "a", text: files["a.ts"] }) as FileFacts;
		provider.shutdown();
		const read = facts.references.find((reference) => reference.name === "B" && reference.role === "read");
		expect(read?.binding).toMatchObject({ status: "bound", symbolId: "lexicon typescript b.ts B." });
	});

	it("resolves each import occurrence in the module system TypeScript gives it", () => {
		const files = {
			"node_modules/pkg/package.json": JSON.stringify({
				name: "pkg",
				exports: { ".": { import: "./esm.mjs", require: "./cjs.cjs" } },
			}),
			"node_modules/pkg/esm.d.mts": "export declare const esm: number;",
			"node_modules/pkg/cjs.d.cts": "export declare const cjs: number;",
			"src/a.mts":
				'import { esm } from "pkg";\nimport cjs = require("pkg");\nexport const both = [esm, cjs.cjs];',
		};
		const provider = harness();
		provider.initialize(
			workspace(files, JSON.stringify({ compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext" } })),
		);
		const text = files["src/a.mts"];
		const facts = provider.parseFile({ module: "src/a.mts", contentHash: "a", text }) as FileFacts;
		const occurrences = facts.imports.map((statement) => ({
			specifier: statement.specifier,
			resolutionMode: statement.edges[0]?.resolutionMode,
		}));
		expect(occurrences).toEqual([
			{ specifier: "pkg", resolutionMode: "import" },
			{ specifier: "pkg", resolutionMode: "require" },
		]);
		const surfaces = ["node_modules/pkg/esm.d.mts", "node_modules/pkg/cjs.d.cts"].map((module) => ({
			status: "external",
			surface: { module },
		}));
		expect(
			occurrences.map((occurrence) => provider.resolveImport({ fromModule: "src/a.mts", ...occurrence })),
		).toMatchObject(surfaces);
		const probed = provider.handlers.probeBatch?.({
			files: [{ module: "src/a.mts", contentHash: "a", text }],
			answer: ["src/a.mts"],
		});
		expect(probed?.status === "ready" ? probed.landings.map(({ resolution }) => resolution) : []).toMatchObject(
			surfaces,
		);
		provider.shutdown();
	});

	it("uses Node module format for extensions and package type", () => {
		const files = {
			"src/a.mts": "export {};",
			"src/b.cts": "export {};",
			"src/c.ts": "export {};",
			"package.json": '{"type":"module"}',
		};
		const config = JSON.stringify({ compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext" } });
		expect(parse(files, "src/a.mts", config).runtime).toBe("esm");
		expect(parse(files, "src/b.cts", config).runtime).toBe("cjs");
		expect(parse(files, "src/c.ts", config).runtime).toBe("esm");
		const noType = { ...files, "package.json": "{}" };
		expect(parse(noType, "src/c.ts", config).runtime).toBe("cjs");
		for (const module of ["AMD", "UMD", "System"] as const) {
			expect(parse(files, "src/a.mts", JSON.stringify({ compilerOptions: { module } })).runtime).toBeUndefined();
		}
	});

	it("keeps const, let and var as the declaration language kind", () => {
		const facts = parse({ "src/a.ts": "const a = 1; let b = 2; var c = 3;" }, "src/a.ts");
		expect(
			Object.fromEntries(facts.declarations.map((declaration) => [declaration.name, declaration.languageKind])),
		).toEqual({
			a: "const",
			b: "let",
			c: "var",
		});
	});
});
