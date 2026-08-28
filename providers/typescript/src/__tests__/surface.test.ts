import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { configuredSurfaceCandidates, isLikelyBundle, surfaceGlobMatches } from "../bundle";
import { TypeScriptProvider } from "../main";
import { extractSurfaceFile } from "../surface";

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
	it("keeps exported function names and parameters without implementation facts or types", () => {
		const internals = Array.from({ length: 400 }, (_, index) => `function x${index}(a){return a+${index}}`).join(
			";",
		);
		const text = `${internals};function q(hH,{data,highWaterMark}){return hH(data,highWaterMark)};class C{run(){}};export{q as send,C as Client}`;
		const provider = new TypeScriptProvider();
		provider.initialize(workspace({ "opaque/runtime.js": text }));

		const facts = provider.parseFile({ module: "opaque/runtime.js", contentHash: "runtime", text });
		const names = facts.declarations.map((declaration) => declaration.name);
		const send = facts.declarations.find((declaration) => declaration.name === "send");

		expect(isLikelyBundle("opaque/runtime.js", text)).toBe(true);
		expect(names).toEqual(["send", "hH", "data", "highWaterMark"]);
		expect(send?.signature).toBe("function send(hH, {data,highWaterMark})");
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
		]);
		expect(facts.declarations.find((declaration) => declaration.name === "constructor")).toMatchObject({
			kind: "constructor",
			signature: "constructor(seed: string)",
		});
		expect(facts.declarations.find((declaration) => declaration.name === "send")?.signature).toContain(
			"hH: Uint8Array",
		);
		expect(facts.declarations.find((declaration) => declaration.name === "open")).toMatchObject({
			kind: "method",
			signature: "open(url: string): Promise<void>",
		});
		expect(facts.declarations.filter((declaration) => declaration.name === "ready")).toHaveLength(2);
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
		const provider = new TypeScriptProvider();
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
		const provider = new TypeScriptProvider();
		provider.initialize(root);

		expect(
			provider.resolveImport({
				fromModule: "src/app.ts",
				specifier: "/runtime/widget.js",
				surfaceGlobs: ["opaque/runtime/**"],
			}),
		).toEqual({ status: "resolved", module: "opaque/runtime/widget.d.ts", depth: "surface" });
		provider.shutdown();
	});
});
