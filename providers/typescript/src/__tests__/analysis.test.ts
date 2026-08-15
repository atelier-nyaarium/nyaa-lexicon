import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { coordinatesOf, parseSymbolId } from "@nyaa-lexicon/protocol";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import { TypeScriptAnalyzer } from "../analyzer";
import { TypeScriptProvider } from "../main";
import { loadProject } from "../project";

////////////////////////////////
//  Helpers

const roots: string[] = [];

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
		const provider = new TypeScriptProvider();
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
			expect(useFacts.references.find((reference) => reference.name === name)?.binding).toEqual({
				status: "bound",
				symbolId: defaultId(facts),
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
		const provider = new TypeScriptProvider();
		provider.initialize(root);

		const useText = 'import { add } from "./bar"; export function run() { add(); }\n';
		const useFacts = provider.parseFile({ module: "use.ts", contentHash: "use", text: useText });
		const fooText = "export function add() {}\n";
		const fooFacts = provider.parseFile({ module: "foo.ts", contentHash: "foo", text: fooText });
		const target = fooFacts.declarations.find((declaration) => declaration.name === "add");
		const reference = useFacts.references.find((candidate) => candidate.name === "add");

		expect(target).toBeDefined();
		expect(reference?.binding).toEqual({
			status: "bound",
			symbolId: target?.symbolId,
			provenance: "bound",
		});
		provider.shutdown();
	});

	it("types the supplied overlay rather than the saved file", () => {
		const root = workspace({ "disk.ts": "export const disk = 1;\n" });
		const provider = new TypeScriptProvider();
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

	it("refreshes fallback facts when source text changes at one overlay version", () => {
		const root = workspace({});
		const analyzer = new TypeScriptAnalyzer(root, loadProject(root));
		const source = (text: string) =>
			ts.createSourceFile("missing.ts", text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);

		const first = analyzer.extract("missing.ts", source("export function RenameOutcome() {}\n"));
		const second = analyzer.extract("missing.ts", source("export function FreshOutcome() {}\n"));

		expect({
			first: first.declarations.find((declaration) => declaration.name === "RenameOutcome")?.name,
			hasFresh: second.declarations.some((declaration) => declaration.name === "FreshOutcome"),
		}).toEqual({ first: "RenameOutcome", hasFresh: true });
		analyzer.dispose();
	});

	it("reuses one compiler generation for unchanged indexed files", () => {
		const files = {
			"tsconfig.json": JSON.stringify({ include: ["*.ts"] }),
			"a.ts": "export const a: number = 1;\n",
			"b.ts": "export const b: number = 2;\n",
			"c.ts": "export const c: number = 3;\n",
		};
		const root = workspace(files);
		const provider = new TypeScriptProvider();
		provider.initialize(root);

		for (const module of ["a.ts", "b.ts", "c.ts"] as const) {
			provider.parseFile({ module, contentHash: module, text: files[module] });
		}

		expect(provider.programStats()).toMatchObject({ programGenerations: 1 });
		provider.shutdown();
	});

	it("advances the compiler generation when the saved file changes", () => {
		const initial = "export const value: number = 1;\n";
		const changed = 'export const value: string = "next";\n';
		const root = workspace({ "tsconfig.json": JSON.stringify({ include: ["*.ts"] }), "value.ts": initial });
		const provider = new TypeScriptProvider();
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
		const provider = new TypeScriptProvider();
		provider.initialize(root);

		const base = provider.parseFile({ module: "base.ts", contentHash: "base", text: files["base.ts"] });
		const use = provider.parseFile({ module: "use.ts", contentHash: "use", text: files["use.ts"] });
		provider.parseFile({ module: "touch.ts", contentHash: "touch", text: files["touch.ts"] });
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
		expect(provider.programStats()).toMatchObject({ programGenerations: 2 });
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
		const provider = new TypeScriptProvider();
		provider.initialize(root);
		const facts = provider.parseFile({ module: "overloads.ts", contentHash: "overloads", text });
		const reference = facts.references.find((candidate) => candidate.name === "choose");

		expect(reference?.binding.status).toBe("ambiguous");
		if (reference?.binding.status === "ambiguous") expect(reference.binding.candidates.length).toBeGreaterThan(1);
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
		const provider = new TypeScriptProvider();
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
		const provider = new TypeScriptProvider();
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
		const provider = new TypeScriptProvider();
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
		const provider = new TypeScriptProvider();
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
		const provider = new TypeScriptProvider();
		provider.initialize(root);

		const binding = provider.bind({
			module: "parameter.ts",
			name: "value",
			range: rangeAt(text, text.indexOf("value")),
		});
		const facts = provider.parseFile({ module: "parameter.ts", contentHash: "parameter", text });
		const parameter = facts.declarations.find((declaration) => declaration.name === "value");
		const reference = facts.references.find((candidate) => candidate.name === "value");

		expect(binding).toEqual({ status: "bound", symbolId: parameter?.symbolId, provenance: "bound" });
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

	it("binds same-file references in an explicitly included JavaScript file", () => {
		const text =
			"var _N=Object.create;function fN($,v){return $}class Q4{}class W3 extends Q4{constructor(){super();fN(W3,1)}}";
		const root = workspace({
			"tsconfig.json": JSON.stringify({ include: ["src/**/*.ts"] }),
			"lexicon.json": JSON.stringify({ include: ["dist/**"] }),
			"src/index.ts": "export const source = 1;\n",
			"dist/cycle-mcp.js": text,
		});
		const provider = new TypeScriptProvider();
		provider.initialize(root);
		const facts = provider.parseFile({ module: "dist/cycle-mcp.js", contentHash: "cycle", text });
		const q4 = facts.declarations.find((declaration) => declaration.name === "Q4");
		const extendsReference = facts.references.find((reference) => reference.name === "Q4");
		const callReference = facts.references.find((reference) => reference.name === "fN");

		expect(q4).toBeDefined();
		expect(extendsReference?.role).toBe("extends");
		expect(extendsReference?.binding).toEqual({
			status: "bound",
			symbolId: q4?.symbolId,
			provenance: "bound",
		});
		expect(callReference?.binding).toMatchObject({ status: "bound", provenance: "bound" });
		provider.shutdown();
	});

	it("keeps reference facts deterministic across sessions and program admission order", () => {
		const files = {
			"a.ts": "function shared(){}\n",
			"b.ts": "function shared(){}\n",
			"use.ts": "shared();\n",
		};
		const root = workspace(files);
		const parse = (order: (keyof typeof files)[]) => {
			const provider = new TypeScriptProvider();
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
			const provider = new TypeScriptProvider();
			provider.initialize(fallbackRoot);
			const first = provider.parseFile({ module: "dist/bundle.js", contentHash: "bundle", text: fallbackText });
			const second = provider.parseFile({ module: "dist/bundle.js", contentHash: "bundle", text: fallbackText });
			provider.shutdown();
			return [first.references, second.references] as const;
		};
		const [fallbackFirst, fallbackSecond] = parseFallback();
		const [fallbackFresh] = parseFallback();
		expect(fallbackSecond).toEqual(fallbackFirst);
		expect(fallbackFresh).toEqual(fallbackFirst);
	});

	it("attributes initializer references to the declared variable", () => {
		const text =
			'var A={run:($)=>H($),name:"x"},B=[K(1)];function H($){return $}function K($){return $}var C=_(()=>H(2));';
		const root = workspace({ "bundle.ts": text });
		const provider = new TypeScriptProvider();
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
		const hFromA = referenceFrom("H", a?.symbolId ?? "");
		const kFromB = referenceFrom("K", b?.symbolId ?? "");
		const hFromC = referenceFrom("H", c?.symbolId ?? "");

		expect(hFromA?.binding).toEqual({ status: "bound", symbolId: h?.symbolId, provenance: "bound" });
		expect(kFromB?.binding).toEqual({ status: "bound", symbolId: k?.symbolId, provenance: "bound" });
		expect(hFromC?.binding).toEqual({ status: "bound", symbolId: h?.symbolId, provenance: "bound" });
		const fanOut = new Set(
			facts.references
				.filter((reference) => reference.fromId === a?.symbolId && reference.binding.status === "bound")
				.map((reference) => (reference.binding.status === "bound" ? reference.binding.symbolId : undefined)),
		);
		expect(fanOut).toEqual(new Set([h?.symbolId]));
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
		const provider = new TypeScriptProvider();
		provider.initialize(root);
		const facts = provider.parseFile({ module: "properties.ts", contentHash: "properties", text });
		const propertyIds = new Map(
			facts.declarations
				.filter((declaration) => declaration.kind === "property")
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
			expect(reference.binding).toEqual({
				status: "bound",
				symbolId: propertyIds.get(reference.name),
				provenance: "bound",
			});
		}
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
		const provider = new TypeScriptProvider();
		provider.initialize(root);
		const facts = provider.parseFile({ module: "shorthand.ts", contentHash: "shorthand", text });
		const local = facts.declarations.find(
			(declaration) => declaration.name === "retries" && declaration.kind === "constant",
		);
		const references = facts.references.filter(
			(reference) => reference.name === "retries" && reference.role === "read",
		);

		expect(references).toHaveLength(1);
		expect(references[0]?.binding).toEqual({
			status: "bound",
			symbolId: local?.symbolId,
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
			"  return import.meta;",
			"}",
			"",
		].join("\n");
		const root = workspace({ "cases.ts": text });
		writeFileSync(path.join(root, "data.json"), '{"version":"test"}\n');
		const provider = new TypeScriptProvider();
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

	it("reports a runtime reason only when the requested range has no source token", () => {
		const text = "export const value = 1;\n";
		const root = workspace({ "tokens.ts": text });
		const provider = new TypeScriptProvider();
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
		const provider = new TypeScriptProvider();
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
		const provider = new TypeScriptProvider();
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
		const provider = new TypeScriptProvider();
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
		const provider = new TypeScriptProvider();
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
		const provider = new TypeScriptProvider();
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
		const provider = new TypeScriptProvider();
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
		const provider = new TypeScriptProvider();
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
		const provider = new TypeScriptProvider();
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
		const provider = new TypeScriptProvider();
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

	it("reports an ambiguous type id when declarations share one index id", () => {
		const text = [
			"export function run(kind: string) {",
			'  if (kind === "a") { const value = 1; return value; }',
			"  { const value = 2; return value; }",
			"}",
			"",
		].join("\n");
		const root = workspace({ "ambiguous.ts": text });
		const provider = new TypeScriptProvider();
		provider.initialize(root);
		const facts = provider.parseFile({ module: "ambiguous.ts", contentHash: "ambiguous", text });
		const target = facts.declarations.find((declaration) => declaration.name === "value");

		expect(provider.typeOf({ symbolId: target?.symbolId ?? "" })).toEqual({
			status: "unknown",
			reason: "Ambiguous",
			detail: "the symbol id maps to several declarations",
		});
		provider.shutdown();
	});
});

describe("source admission", () => {
	it("refuses an out-of-range source position", () => {
		const module = "stale.ts";
		const text = "export const value = 1;\n";
		const root = workspace({ [module]: text });
		const analyzer = new TypeScriptAnalyzer(root, loadProject(root));
		const range = { start: { line: 0, character: 99 }, end: { line: 0, character: 100 } };

		expect(analyzer.bind(module, "value", range)).toEqual({
			status: "unbound",
			reason: "RuntimeConstructed",
			detail: "the range is not a source token",
		});
		expect(analyzer.typeOf({ module, range })).toEqual({
			status: "unknown",
			reason: "RuntimeConstructed",
			detail: "the range is not a source token",
		});
		analyzer.dispose();
	});

	it("reports compiler diagnostics for several readable files from cold programs", () => {
		const files = {
			"a.ts": "export const a = ;\n",
			"b.ts": "export const b = ;\n",
			"c.ts": "export const c = ;\n",
		};
		const root = workspace(files);
		const analyzer = new TypeScriptAnalyzer(root, loadProject(root));

		for (const module of Object.keys(files)) {
			expect(analyzer.diagnostics(module)).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						severity: "error",
						message: expect.stringContaining("Expression expected"),
						path: module,
					}),
				]),
			);
		}
		analyzer.dispose();
	});

	it("reports cold source failures with their reason and detail", () => {
		const root = workspace({ "present.ts": "export const value = 1;\n" });
		const analyzer = new TypeScriptAnalyzer(root, loadProject(root));

		expect(analyzer.diagnostics("../outside.ts")).toEqual([
			{
				severity: "error",
				message: "ExternalDependency: the module is outside the indexed workspace",
				path: "../outside.ts",
			},
		]);
		expect(analyzer.diagnostics("notes.txt")).toEqual([
			{
				severity: "error",
				message: "NotImplemented: the provider does not claim extension .txt",
				path: "notes.txt",
			},
		]);
		expect(analyzer.diagnostics("missing.ts")).toEqual([
			{
				severity: "error",
				message: "ParseError: the file does not exist",
				path: "missing.ts",
			},
		]);
		analyzer.dispose();
	});
});

describe("outline depth", () => {
	it("echoes outline with declarations and imports only", () => {
		const files = { "cart.ts": 'import { z } from "./zed";\nexport class Cart {}\nconst noise = "literal";\n' };
		const root = workspace(files);
		const provider = new TypeScriptProvider();
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
		const provider = new TypeScriptProvider();
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
