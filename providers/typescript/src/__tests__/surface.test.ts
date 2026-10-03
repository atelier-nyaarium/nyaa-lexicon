import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { FOLD_MARK, parseSymbolId, withOccurrences } from "@nyaa-lexicon/protocol";
import { configuredSurfaceCandidates, isLikelyBundle, surfaceGlobMatches } from "../bundle";
import { extractSurfaceFile } from "../surface";
import { harness } from "./harness.js";

////////////////////////////////
//  Helpers

const roots: string[] = [];

function workspace(files: Record<string, string>): string {
	const root = mkdtempSync(path.join(tmpdir(), "lexicon-typescript-surface-"));
	roots.push(root);
	for (const [module, text] of Object.entries(files)) {
		const full = path.join(root, module);
		mkdirSync(path.dirname(full), { recursive: true });
		writeFileSync(full, text);
	}
	return root;
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

////////////////////////////////
//  Tests

describe("bundle classification", () => {
	it("recognizes minifier density without naming a tool or directory", () => {
		const minified = `function a(hH){return hH};${"a(1);".repeat(500)}`;
		const readable = Array.from({ length: 500 }, (_, index) => `export const value${index} = ${index};`).join("\n");

		expect(isLikelyBundle("opaque/runtime.js", minified)).toBe(true);
		expect(isLikelyBundle("opaque/runtime.js", readable)).toBe(false);
		expect(isLikelyBundle("anywhere/runtime.min.js", "x")).toBe(true);
	});

	it("matches configured paths with the same segment rules as core", () => {
		expect(surfaceGlobMatches("opaque/**/*.js", "opaque/deep/runtime.js")).toBe(true);
		expect(surfaceGlobMatches("opaque/*.js", "opaque/deep/runtime.js")).toBe(false);
	});

	it("maps a runtime-root specifier only through a configured glob", () => {
		expect(configuredSurfaceCandidates("/runtime/widget.js", ["opaque/runtime/**"])).toEqual([
			"opaque/runtime/widget.js",
		]);
		expect(configuredSurfaceCandidates("/runtime/widget.js", [])).toEqual([]);
	});
});

describe("runtime bundle surfaces", () => {
	it("keeps exported function names and headers without implementation facts or types", () => {
		const internals = Array.from({ length: 400 }, (_, index) => `function x${index}(a){return a+${index}}`).join(
			";",
		);
		const text = `${internals};function q(hH,{data,highWaterMark}){return hH(data,highWaterMark)};class C{run(){}};export{q as send,C as Client}`;
		const provider = harness();
		provider.initialize(workspace({ "opaque/runtime.js": text }));

		const facts = provider.parseFile({ module: "opaque/runtime.js", contentHash: "runtime", text });
		const names = facts.declarations.map((declaration) => declaration.name);
		const send = facts.declarations.find((declaration) => declaration.name === "send");

		expect(isLikelyBundle("opaque/runtime.js", text)).toBe(true);
		expect(names).toEqual(["send", "hH", "data", "highWaterMark"]);
		expect(send?.signature).toBe("function q(hH,{data,highWaterMark})");
		expect(facts.references).toEqual([]);
		expect(facts.literals).toEqual([]);
		expect(provider.typeOf({ symbolId: send?.symbolId ?? "" })).toMatchObject({
			status: "unknown",
			reason: "DynamicallyTyped",
		});
		provider.shutdown();
	});

	it("recognizes direct CommonJS function exports", () => {
		const facts = extractSurfaceFile(
			"opaque/runtime.js",
			"const local=(hH,{data,highWaterMark})=>hH(data);exports.send=local;exports.value=1;",
		);

		expect(facts.declarations.map((declaration) => declaration.name)).toEqual([
			"send",
			"hH",
			"data",
			"highWaterMark",
		]);
	});
});

describe("registered declaration surfaces", () => {
	it("binds a use into a declaration surface only to ids that surface admits", () => {
		const lib = [
			"export interface Config { server: { port: number } | null; items: { id: string }[] }",
			"export default class Box {",
			"  constructor(readonly side: number);",
			"  get area(): number;",
			"  set area(value: number);",
			"  protected hidden(): void;",
			"  static make(options: { size: number }): Box;",
			"}",
			"declare class Local { run(): void }",
			"export { Local as Alias };",
			"export declare function load(options: { path: string }): Config;",
			"export declare enum Direction { Up, Down }",
			"export declare namespace Log {",
			"  function write(message: string): void;",
			"  const level: number;",
			"  namespace Deep { function dive(): void }",
			"}",
			'import fs = require("fs");',
			"declare global {",
			"  function shout(): void;",
			"}",
			"",
		].join("\n");
		// A script: its declarations are global, and its `declare module` is the package's surface.
		const ambient = [
			'declare module "pkg" {',
			'  import path = require("path");',
			"  export function start(): void;",
			"}",
			"declare function greet(name: string): void;",
			"declare const VERSION: string;",
			"",
		].join("\n");
		const use = [
			'import Box, { type Config, Alias, load, Direction, Log } from "../types/lib";',
			'import { start } from "pkg";',
			"export function run(config: Config, box: Box) {",
			'  load({ path: "x" });',
			'  Log.write("x");',
			"  Log.Deep.dive();",
			"  greet(VERSION);",
			"  start();",
			"  shout();",
			"  return [config.server?.port, config.items[0]?.id, box.side, box.area, new Alias().run(), Box.make({ size: 1 })];",
			"}",
			"export const facing = [Direction.Up, Log.level];",
			"export class Sub extends Box { peek() { return this.hidden(); } }",
			"",
		].join("\n");
		const surfaces = { "types/lib.d.ts": lib, "types/ambient.d.ts": ambient };
		const provider = harness();
		provider.initialize(workspace({ ...surfaces, "src/use.ts": use }));
		const parsed = Object.entries(surfaces).map(([module, text]) =>
			provider.parseFile({ module, contentHash: module, text, depth: "surface" }),
		);
		const admitted = new Map(
			parsed.flatMap((surface) =>
				withOccurrences(surface).declarations.map(
					(declaration) => [declaration.symbolId, declaration] as const,
				),
			),
		);
		const facts = provider.parseFile({ module: "src/use.ts", contentHash: "use", text: use });
		const intoSurfaces = facts.references.flatMap((reference) => {
			const binding = reference.binding;
			const targets =
				binding.status === "bound"
					? [binding.symbolId]
					: binding.status === "ambiguous"
						? binding.candidates
						: [];
			return targets.filter((target) => (parseSymbolId(target)?.module ?? "") in surfaces);
		});

		expect(intoSurfaces.filter((target) => !admitted.has(target))).toEqual([]);
		const reached = [
			...[
				"Config#server.port.",
				"Config#items.id.",
				"Box#side.",
				"Box#area.",
				"Box#",
				"load().",
				"Alias#",
				"Alias#run().",
				"Direction#Up.",
				"Log/write().",
				"Log/level.",
				"Log/Deep/dive().",
				"global/shout().",
			].map((id) => `lexicon typescript types/lib.d.ts ${id}`),
			...["pkg/start().", "greet().", "VERSION."].map((id) => `lexicon typescript types/ambient.d.ts ${id}`),
		];
		for (const id of reached) {
			expect(intoSurfaces, id).toContain(id);
			// A member leaves its module when its container does.
			expect(admitted.get(id)?.exported, id).toBe(true);
		}
		for (const [index, specifier] of ["fs", "path"].entries()) {
			expect(parsed[index]?.imports).toContainEqual(
				expect.objectContaining({
					specifier,
					edges: [expect.objectContaining({ local: specifier, kind: "require" })],
				}),
			);
		}
		provider.shutdown();
	});

	it("keeps declared signatures and public class members", () => {
		const text = [
			"export declare function send(hH: Uint8Array, { data, highWaterMark }: Options): Result;",
			"export declare class Client {",
			"  constructor(seed: string);",
			"  public open(url: string): Promise<void>;",
			"  field: number;",
			"  get ready(): boolean;",
			"  set ready(value: boolean);",
			"  protected hidden(): void;",
			"  private secret: string;",
			"}",
			"export type Shape = { side: number; area(): number };",
			"export type Result = { ok: true } | { ok: false };",
		].join("\n");
		const facts = extractSurfaceFile("types/runtime.d.ts", text);
		const names = facts.declarations.map((declaration) => declaration.name);

		expect(names).toEqual([
			"send",
			"hH",
			"data",
			"highWaterMark",
			"Client",
			"constructor",
			"seed",
			"open",
			"url",
			"field",
			"ready",
			"ready",
			"value",
			"Shape",
			"side",
			"area",
			"Result",
			"ok",
			"ok",
		]);
		expect(
			facts.declarations
				.filter((declaration) => declaration.languageKind === "typeAlias")
				.map((item) => item.name),
		).toEqual(["Shape", "Result"]);
		expect(facts.declarations.find((declaration) => declaration.name === "constructor")).toMatchObject({
			kind: "constructor",
			signature: "constructor(seed: string)",
		});
		expect(facts.declarations.find((declaration) => declaration.name === "send")?.signature).toBe(
			"export declare function send(hH: Uint8Array, { data, highWaterMark }: Options): Result",
		);
		expect(facts.declarations.find((declaration) => declaration.name === "open")).toMatchObject({
			kind: "method",
			signature: "public open(url: string): Promise<void>",
		});
		expect(facts.declarations.filter((declaration) => declaration.name === "ready")).toHaveLength(2);
	});

	it("signs every surface declaration with its whole header, as a workspace parse does", () => {
		const declared = extractSurfaceFile(
			"types/geo.d.ts",
			[
				"@sealed",
				"export declare abstract class Box<T>",
				"\textends Base<T> // why",
				"\timplements Shape {",
				"\tprotected constructor(seed: string);",
				"\tpublic static open(",
				"\t\turl: string,",
				"\t): Promise<void>;",
				"}",
				"export interface Options extends Base<string> {",
				"\texact: boolean;",
				"}",
				"export type Claim = { claimed: true } | { claimed: false };",
				"export declare enum Mode { A }",
			].join("\n"),
		);
		const signature = (facts: typeof declared, name: string) =>
			facts.declarations.find((declaration) => declaration.name === name)?.signature;
		expect(["Box", "open", "Options", "exact", "Claim", "Mode"].map((name) => signature(declared, name))).toEqual([
			"@sealed export declare abstract class Box<T> extends Base<T> implements Shape",
			"public static open(url: string): Promise<void>",
			"export interface Options extends Base<string>",
			"exact: boolean",
			`export type Claim = {${FOLD_MARK}} | {${FOLD_MARK}}`,
			"export declare enum Mode",
		]);

		const runtime = extractSurfaceFile(
			"node_modules/runtime/index.js",
			"exports.run = (value) => {\n\treturn value;\n};\nmodule.exports.stop = function (reason) {};\n",
		);
		expect(signature(runtime, "run")).toBe(`exports.run = (value) => {${FOLD_MARK}}`);
		expect(signature(runtime, "stop")).toBe("module.exports.stop = function (reason) {}");
	});

	it("uses package declarations and JavaScript only as a fallback", () => {
		const root = workspace({
			"src/app.ts": "export const app = 1;\n",
			"node_modules/typed/package.json": JSON.stringify({ name: "typed", types: "index.d.ts", main: "index.js" }),
			"node_modules/typed/index.d.ts": "export declare function typed(value: string): number;\n",
			"node_modules/typed/index.js": "exports.typed=(value)=>value.length;\n",
			"node_modules/runtime/package.json": JSON.stringify({ name: "runtime", main: "index.js" }),
			"node_modules/runtime/index.js": "exports.run=(value)=>value;\n",
		});
		const provider = harness();
		provider.initialize(root);

		expect(provider.resolveImport({ fromModule: "src/app.ts", specifier: "typed" })).toMatchObject({
			status: "external",
			packageName: "typed",
			surface: { module: "node_modules/typed/index.d.ts" },
		});
		expect(provider.resolveImport({ fromModule: "src/app.ts", specifier: "runtime" })).toMatchObject({
			status: "external",
			packageName: "runtime",
			surface: { module: "node_modules/runtime/index.js" },
		});
		provider.shutdown();
	});

	it("resolves a configured runtime-root import to its sibling declaration", () => {
		const root = workspace({
			"src/app.ts": "export const app = 1;\n",
			"opaque/runtime/widget.js": "exports.send=(value)=>value;\n",
			"opaque/runtime/widget.d.ts": "export declare function send(value: string): string;\n",
		});
		const provider = harness();
		provider.initialize(root);

		expect(
			provider.resolveImport({
				fromModule: "src/app.ts",
				specifier: "/runtime/widget.js",
				surfaceGlobs: ["opaque/runtime/**"],
			}),
		).toEqual({
			status: "resolved",
			landing: { kind: "module", module: "opaque/runtime/widget.d.ts" },
			depth: "surface",
		});
		provider.shutdown();
	});
});
