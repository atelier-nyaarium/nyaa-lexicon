import { coordinatesOf, parseSymbolId } from "@nyaa-lexicon/protocol";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { extractFile } from "../extract";

////////////////////////////////
//  Helpers

function extract(text: string, module = "src/a.ts") {
	const source = ts.createSourceFile(module, text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
	return extractFile(module, source);
}

function extractWithChecker(text: string, module = "src/a.ts") {
	const options: ts.CompilerOptions = { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext };
	const host = ts.createCompilerHost(options, true);
	const defaultGetSourceFile = host.getSourceFile.bind(host);
	const defaultReadFile = host.readFile.bind(host);
	const defaultFileExists = host.fileExists.bind(host);
	host.readFile = (fileName) => (fileName === module ? text : defaultReadFile(fileName));
	host.fileExists = (fileName) => fileName === module || defaultFileExists(fileName);
	host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) =>
		fileName === module
			? ts.createSourceFile(fileName, text, languageVersion, true, ts.ScriptKind.TS)
			: defaultGetSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
	const program = ts.createProgram([module], options, host);
	const source = program.getSourceFile(module);
	if (source === undefined) throw new Error(`missing source file: ${module}`);
	return extractFile(module, source, program.getTypeChecker());
}

function named(text: string, name: string) {
	return extract(text).declarations.find((d) => d.name === name);
}

function descriptorsOf(symbolId: string): string[] {
	return (parseSymbolId(symbolId)?.descriptors ?? []).map((d) => `${d.kind}:${d.name}`);
}

function rangeForText(text: string, value: string, from = 0) {
	const start = text.indexOf(value, from);
	if (start === -1) throw new Error(`missing test text: ${value}`);
	const range = coordinatesOf(text).rangeAt(start, start + value.length);
	if (range === undefined) throw new Error(`invalid test text range: ${value}`);
	return range;
}

function offsetAt(text: string, position: { line: number; character: number }) {
	const offset = coordinatesOf(text).offsetAt(position);
	if (offset === undefined) throw new Error("invalid test position");
	return offset;
}

function textAt(
	text: string,
	range: { start: { line: number; character: number }; end: { line: number; character: number } },
) {
	const value = coordinatesOf(text).sliceRange(range);
	if (value === undefined) throw new Error("invalid test range");
	return value;
}

////////////////////////////////
//  Tests

describe("what it reports", () => {
	it("reports each declaration kind as itself", () => {
		const source = `
export class Cart {}
export interface Item {}
export function add() {}
export const LIMIT = 1;
export let counter = 0;
export enum Color { Red }
`;
		const kinds = extract(source).declarations.map((d) => [d.name, d.kind]);
		expect(kinds).toEqual(
			expect.arrayContaining([
				["Cart", "class"],
				["Item", "interface"],
				["add", "function"],
				["LIMIT", "constant"],
				["counter", "variable"],
				["Color", "enum"],
			]),
		);
	});

	it("mints declarations for anonymous default exports and owns their members", () => {
		for (const [source, kind, member] of [
			["export default class { run() {} }", "class", "run"],
			["export default { greet() {} }", "variable", "greet"],
		] as const) {
			const found = extract(source);
			const defaultDeclaration = found.declarations.find((declaration) => declaration.name === "default");
			const memberDeclaration = found.declarations.find((declaration) => declaration.name === member);

			expect(defaultDeclaration).toMatchObject({ name: "default", kind, exported: true });
			expect(textAt(source, defaultDeclaration?.range as (typeof found.declarations)[number]["range"])).toBe(
				source,
			);
			expect(
				textAt(
					source,
					defaultDeclaration?.selectionRange as (typeof found.declarations)[number]["selectionRange"],
				),
			).toBe("default");
			expect(memberDeclaration?.containerId).toBe(defaultDeclaration?.symbolId);
		}
	});

	it("mints a variable declaration for an expression default export", () => {
		const source = "export default new X();";
		const found = extract(source);
		const defaultDeclaration = found.declarations.find((declaration) => declaration.name === "default");

		expect(defaultDeclaration).toMatchObject({ name: "default", kind: "variable", exported: true });
		expect(textAt(source, defaultDeclaration?.range as (typeof found.declarations)[number]["range"])).toBe(source);
		expect(found.references).toEqual([expect.objectContaining({ name: "X", role: "instantiate" })]);
	});

	it("does not mint a second declaration for a named default class", () => {
		const found = extract("export default class Foo { run() {} }");
		const defaults = found.declarations.filter((declaration) => declaration.name === "default");
		const foo = found.declarations.find((declaration) => declaration.name === "Foo");

		expect(defaults).toHaveLength(0);
		expect(foo).toMatchObject({ kind: "class", exported: true });
		expect(found.declarations.find((declaration) => declaration.name === "run")?.containerId).toBe(foo?.symbolId);
	});

	it("keeps aliases, namespaces, modules, and type parameters distinct", () => {
		const found = extract(
			[
				"export type Alias = string;",
				"export abstract class AbstractBox {}",
				"export class Box<T> {}",
				"export namespace Names {}",
				'declare module "virtual" {}',
				"export const value = 1 as const;",
			].join("\n"),
		);

		expect(found.declarations).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ name: "Alias", kind: "interface" }),
				expect.objectContaining({ name: "AbstractBox", kind: "class" }),
				expect.objectContaining({ name: "Box", kind: "class" }),
				expect.objectContaining({ name: "Names", kind: "namespace" }),
				expect.objectContaining({ name: "virtual", kind: "module" }),
				expect.objectContaining({ name: "value", kind: "constant" }),
			]),
		);
		expect(found.declarations.some((declaration) => declaration.name === "T")).toBe(false);
	});

	it("separates const from let, since a consumer reads the kind to know what can be reassigned", () => {
		expect(named("const a = 1;", "a")?.kind).toBe("constant");
		expect(named("let a = 1;", "a")?.kind).toBe("variable");
	});

	it("nests a member under its class in both the container and the id", () => {
		const found = extract("export class Cart {\n  add() {}\n}\n");
		const cart = found.declarations.find((d) => d.name === "Cart");
		const add = found.declarations.find((d) => d.name === "add");

		expect(add?.containerId).toBe(cart?.symbolId);
		expect(descriptorsOf(add?.symbolId ?? "")).toEqual(["type:Cart", "method:add"]);
	});

	it("carries a signature without its body, which is the compression the tools ship", () => {
		const signature = named("export function add(a: number): number { return a; }", "add")?.signature;
		expect(signature).toBe("export function add(a: number): number");
	});

	it("starts each variable signature at its own declarator", () => {
		const found = extract("var a = 1, b = 2;\nlet c = 3, d = 4;\n");
		expect(found.declarations.map((declaration) => [declaration.name, declaration.signature])).toEqual([
			["a", "a = 1"],
			["b", "b = 2"],
			["c", "c = 3"],
			["d", "d = 4"],
		]);
	});

	it("uses the declaration id for literals inside object methods", () => {
		const found = extract('const tools = { handler() { return "ready"; } };');
		const handler = found.declarations.find((declaration) => declaration.name === "handler");
		const literal = found.literals.find((candidate) => candidate.value === "ready");
		expect(literal?.containerId).toBe(handler?.symbolId);
	});

	it("emits contextually typed object property names and skips untyped names", () => {
		const source = [
			"interface Options { retries: number; nested: { enabled: boolean } }",
			"declare function consume(options: Options): void;",
			"const typed: Options = { retries: 1, nested: { enabled: true } };",
			"consume({ retries: 2, nested: { enabled: false } });",
			"function make(): Options { return { retries: 3, nested: { enabled: true } }; }",
			"const untyped = { retries: 4 };",
		].join("\n");
		const found = extractWithChecker(source);
		const properties = found.references.filter(
			(reference) => reference.role === "read" && ["retries", "enabled"].includes(reference.name),
		);

		expect(properties.map((reference) => reference.name)).toEqual([
			"retries",
			"enabled",
			"retries",
			"enabled",
			"retries",
			"enabled",
		]);
		for (const reference of properties) {
			expect(textAt(source, reference.range)).toBe(reference.name);
		}
	});

	it("does not double-emit a shorthand property", () => {
		const source = [
			"interface Options { retries: number }",
			"declare function consume(options: Options): void;",
			"const retries = 1;",
			"consume({ retries });",
		].join("\n");
		const found = extractWithChecker(source);
		const references = found.references.filter(
			(reference) => reference.name === "retries" && reference.role === "read",
		);
		expect(references).toHaveLength(1);
		expect(textAt(source, references[0]?.range as (typeof found.references)[number]["range"])).toBe("retries");
	});

	it("carries a doc comment", () => {
		expect(named("/** Adds things. */\nexport function add() {}", "add")?.docComment).toBe("Adds things.");
	});

	it("gives a range that points at the real line", () => {
		const found = named("\n\nexport class Cart {}", "Cart");
		expect(found?.range.start.line).toBe(2);
	});

	// Leading trivia runs back to the previous token, so the naive read of it hands a move the
	// file's section banner to carry into the destination.
	// Overloads are separate symbols and must stay separable; merged declarations are ONE symbol in
	// TypeScript, so numbering them minted an ordinal the composer could not render and dropped.
	it("numbers overloads and leaves a merged interface and class sharing one id", () => {
		const overloads = extract(
			["export function f(x: string): string;", "export function f(x: number): number;"].join("\n"),
		).declarations.filter((declaration) => declaration.name === "f");
		expect(new Set(overloads.map((declaration) => declaration.symbolId)).size).toBe(overloads.length);

		const merged = extract(["export interface Box {}", "export class Box {}"].join("\n")).declarations.filter(
			(declaration) => declaration.name === "Box",
		);
		expect(merged.length).toBeGreaterThan(1);
		expect(new Set(merged.map((declaration) => declaration.symbolId)).size).toBe(1);
	});

	it("stops the range at a blank line, leaving a section banner with the file", () => {
		const source = [
			"////////////////////////////////",
			"//  Functions & Helpers",
			"",
			"/** Adds things. */",
			"export function add() {}",
		].join("\n");

		const found = named(source, "add");
		expect(textAt(source, found?.range as NonNullable<typeof found>["range"])).toBe(
			"/** Adds things. */\nexport function add() {}",
		);
	});

	it("takes no comment at all when a blank line separates the nearest one", () => {
		const source = ["// belongs to the file", "", "export function add() {}"].join("\n");

		const found = named(source, "add");
		expect(textAt(source, found?.range as NonNullable<typeof found>["range"])).toBe("export function add() {}");
	});

	it("keeps a multi-line comment block that touches the declaration", () => {
		const source = ["// first line", "// second line", "export function add() {}"].join("\n");

		const found = named(source, "add");
		expect(textAt(source, found?.range as NonNullable<typeof found>["range"])).toBe(
			"// first line\n// second line\nexport function add() {}",
		);
	});

	it("keeps whole declaration ranges and exact name selections", () => {
		const source = [
			"/** documented default */",
			"export default function defaultFn() {}",
			"/** documented class */",
			"@sealed",
			"export class Decorated {",
			"  constructor(value: string) {}",
			"  property = 1;",
			"  method() {}",
			"  get value() { return 1; }",
			"  set value(next: number) {}",
			"}",
			"export interface Contract { property: string; }",
			"export type Alias = string;",
			"export enum Color { Red }",
			"export function run() {}",
			"export const arrow = (x: number) => x;",
			"export function overloaded(x: string): string;",
			"export function overloaded(x: number): number;",
			"export function overloaded(x: string | number) { return x; }",
		].join("\n");
		const found = extract(source).declarations;
		const expected = [
			{
				kind: "function",
				name: "defaultFn",
				full: "/** documented default */\nexport default function defaultFn() {}",
			},
			{
				kind: "class",
				name: "Decorated",
				full: "/** documented class */\n@sealed\nexport class Decorated {\n  constructor(value: string) {}\n  property = 1;\n  method() {}\n  get value() { return 1; }\n  set value(next: number) {}\n}",
			},
			{ kind: "constructor", name: "constructor", full: "constructor(value: string) {}" },
			{ kind: "property", name: "property", full: "property = 1;" },
			{ kind: "method", name: "method", full: "method() {}" },
			{ kind: "property", name: "value", full: "get value() { return 1; }" },
			{ kind: "property", name: "value", full: "set value(next: number) {}" },
			{ kind: "interface", name: "Contract", full: "export interface Contract { property: string; }" },
			{ kind: "property", name: "property", full: "property: string;" },
			{ kind: "interface", name: "Alias", full: "export type Alias = string;" },
			{ kind: "enum", name: "Color", full: "export enum Color { Red }" },
			{ kind: "constant", name: "Red", full: "Red" },
			{ kind: "function", name: "run", full: "export function run() {}" },
			{ kind: "constant", name: "arrow", full: "export const arrow = (x: number) => x;" },
			{ kind: "function", name: "overloaded", full: "export function overloaded(x: string): string;" },
			{ kind: "function", name: "overloaded", full: "export function overloaded(x: number): number;" },
			{
				kind: "function",
				name: "overloaded",
				full: "export function overloaded(x: string | number) { return x; }",
			},
		];

		for (const item of expected) {
			const candidates = found.filter(
				(declaration) =>
					declaration.kind === item.kind &&
					declaration.name === item.name &&
					textAt(source, declaration.range) === item.full,
			);
			expect(candidates, `${item.kind} ${item.name}`).toHaveLength(1);
			const declaration = candidates[0];
			if (declaration === undefined) throw new Error(`missing declaration: ${item.kind} ${item.name}`);
			expect(declaration?.range).toEqual(rangeForText(source, item.full));
			expect(textAt(source, declaration.selectionRange)).toBe(item.name);
			expect(declaration.selectionRange).toEqual(
				rangeForText(source, item.name, offsetAt(source, declaration.range.start)),
			);
		}
	});

	it("emits parameter declarations under their owning function", () => {
		const source = [
			"interface Options { retries: number; }",
			"export function use(this: Options, required: string, optional?: number, ...rest: boolean[]) {}",
			"export function destructured({ retries: count = 1, nested: { deep } }: Options) {}",
			"export class Box { constructor(public value: number = 1) {} method(argument: string) {} }",
			"export const arrow = (value: number, ...items: string[]) => value;",
		].join("\n");
		const found = extract(source).declarations;
		const parameterDeclarations = found.filter((declaration) =>
			descriptorsOf(declaration.symbolId).at(-1)?.startsWith("parameter:"),
		);
		const parameterFor = (ownerName: string, name: string) => {
			const ownerIds = found
				.filter((declaration) => declaration.name === ownerName)
				.map((declaration) => declaration.symbolId);
			return parameterDeclarations.find(
				(declaration) => declaration.name === name && ownerIds.includes(declaration.containerId ?? ""),
			);
		};

		expect(parameterDeclarations).toHaveLength(10);
		for (const [ownerName, name, rangeText] of [
			["use", "this", "this: Options"],
			["use", "required", "required: string"],
			["use", "optional", "optional?: number"],
			["use", "rest", "...rest: boolean[]"],
			["destructured", "count", "retries: count"],
			["destructured", "deep", "deep"],
			["constructor", "value", "public value: number"],
			["method", "argument", "argument: string"],
			["arrow", "value", "value: number"],
			["arrow", "items", "...items: string[]"],
		] as const) {
			const parameter = parameterFor(ownerName, name);
			const owner = found.find(
				(declaration) => declaration.name === ownerName && declaration.symbolId === parameter?.containerId,
			);
			expect(parameter, `${ownerName}.${name}`).toBeDefined();
			expect(parameter?.kind).toBe("variable");
			expect(parameter?.visibility).toBe("local");
			expect(parameter?.exported).toBe(false);
			expect(textAt(source, parameter?.range ?? rangeForText(source, rangeText))).toBe(rangeText);
			expect(textAt(source, parameter?.selectionRange ?? rangeForText(source, name))).toBe(name);
			expect(descriptorsOf(parameter?.symbolId ?? "")).toEqual([
				...descriptorsOf(owner?.symbolId ?? ""),
				`parameter:${name}`,
			]);
		}
	});

	it("keeps reference ranges on the identifier and out of leading trivia", () => {
		const source = [
			"const value = 1;",
			"export function run() {",
			"  /* before */ return value;",
			"}",
			"run();",
		].join("\n");
		const references = extract(source).references;

		expect(references.map((reference) => textAt(source, reference.range))).toEqual(["value", "run"]);
		for (const reference of references) {
			const first = source.indexOf(reference.name);
			expect(reference.range).toEqual(rangeForText(source, reference.name, first + 1));
		}
	});

	it("reports decoded string, numeric, and boolean literals with exact source ranges", () => {
		const source = [
			'const text = "a\\nb";',
			"const template = `a\\nb`;",
			"const interpolated = `prefix $" + '{"inner"}' + "`;",
			"const hex = 0xFF;",
			"const separated = 1_000;",
			"const yes = true;",
			"const no = false;",
			'type Choice = "a" | "b";',
			'enum Status { Ready = "ready", Code = 0xFF }',
			"const pattern = /foo/;",
		].join("\n");
		const found = extract(source);

		expect(found.literals.map((literal) => [literal.kind, literal.value, literal.number])).toEqual([
			["string", "a\nb", undefined],
			["string", "a\nb", undefined],
			["string", "inner", undefined],
			["number", "0xFF", 255],
			["number", "1_000", 1000],
			["boolean", "true", undefined],
			["boolean", "false", undefined],
			["string", "a", undefined],
			["string", "b", undefined],
			["string", "ready", undefined],
			["number", "0xFF", 255],
		]);
		expect(found.literals.map((literal) => textAt(source, literal.range))).toEqual([
			'"a\\nb"',
			"`a\\nb`",
			'"inner"',
			"0xFF",
			"1_000",
			"true",
			"false",
			'"a"',
			'"b"',
			'"ready"',
			"0xFF",
		]);
		expect(found.literals.some((literal) => textAt(source, literal.range) === "/foo/")).toBe(false);
		const choice = found.declarations.find((declaration) => declaration.name === "Choice");
		const ready = found.declarations.find((declaration) => declaration.name === "Ready");
		expect(found.literals.find((literal) => textAt(source, literal.range) === '"a"')?.containerId).toBe(
			choice?.symbolId,
		);
		expect(found.literals.find((literal) => textAt(source, literal.range) === '"ready"')?.containerId).toBe(
			ready?.symbolId,
		);
	});

	it("measures declaration lines and executable shape without inventing fields", () => {
		const source = [
			"/** documented */",
			"export function measure(first: number, second: number) {",
			"  if (first && second) {",
			"    return first;",
			"  }",
			"  return 0;",
			"}",
			"export function overloaded(value: number): number;",
			"export const arrow = (value: number) => value;",
			"export const conditional = (value: boolean) => (value ? 1 : 0);",
			"export interface Item { value: string; }",
		].join("\n");
		const found = extract(source).declarations;

		expect(found.find((declaration) => declaration.name === "measure")?.metrics).toEqual({
			lines: 7,
			parameters: 2,
			nesting: 1,
			branches: 3,
		});
		expect(found.find((declaration) => declaration.name === "overloaded")?.metrics).toEqual({
			lines: 1,
			parameters: 1,
		});
		expect(found.find((declaration) => declaration.name === "arrow")?.metrics).toEqual({
			lines: 1,
			parameters: 1,
			nesting: 0,
			branches: 1,
		});
		expect(found.find((declaration) => declaration.name === "conditional")?.metrics).toEqual({
			lines: 1,
			parameters: 1,
			nesting: 1,
			branches: 2,
		});
		expect(found.find((declaration) => declaration.name === "Item")?.metrics).toEqual({ lines: 1 });
	});
});

describe("visibility and reach", () => {
	it("separates exported from file-local", () => {
		expect(named("export function a() {}", "a")?.exported).toBe(true);
		expect(named("function a() {}", "a")?.exported).toBe(false);
		expect(named("function a() {}", "a")?.visibility).toBe("fileLocal");
	});

	it("reads an access modifier rather than guessing from the name", () => {
		const source = "export class C {\n  private secret = 1;\n  protected shared = 2;\n  public open = 3;\n}";
		expect(named(source, "secret")?.visibility).toBe("private");
		expect(named(source, "shared")?.visibility).toBe("protected");
		expect(named(source, "open")?.visibility).toBe("public");
	});

	it("treats a hash-private field as private, and keeps the hash as part of its real name", () => {
		const field = named("export class C {\n  #hidden = 1;\n}", "#hidden");
		expect(field?.visibility).toBe("private");
		// The identifier in the source is `#hidden`, so that is the name a search must match.
		expect(named("export class C {\n  #hidden = 1;\n}", "hidden")).toBeUndefined();
	});

	it("counts a member of an exported class as reachable", () => {
		expect(named("export class C {\n  method() {}\n}", "method")?.exported).toBe(true);
		expect(named("class C {\n  method() {}\n}", "method")?.exported).toBe(false);
	});
});

describe("imports", () => {
	it("records source and local spans for every named import and export form", () => {
		const source = [
			'import { foo } from "./named";',
			'import { original as renamed } from "./aliased";',
			'import defaultThing from "./default";',
			'import * as namespace from "./namespace";',
			'import type { TypeOnly } from "./type-only";',
			'import { type InlineType as LocalInline } from "./inline-type";',
			'export { reexported } from "./reexport";',
			'export { sourceName as exportedName } from "./reexport-alias";',
			'export { defaultSource as default } from "./default-reexport";',
			'export * as namespaceExport from "./namespace-export";',
			'export * from "./all";',
			'import "./side-effect";',
		].join("\n");
		const span = (value: string, from: string) => rangeForText(source, value, source.indexOf(from));

		expect(extract(source).imports).toEqual([
			{
				specifier: "./named",
				imported: [{ name: "foo", range: span("foo", "import { foo }") }],
				reExport: false,
			},
			{
				specifier: "./aliased",
				imported: [
					{
						name: "original",
						range: span("original", "import { original"),
						local: "renamed",
						localRange: span("renamed", "import { original"),
					},
				],
				reExport: false,
			},
			{
				specifier: "./default",
				imported: [{ local: "defaultThing", localRange: span("defaultThing", "import defaultThing") }],
				reExport: false,
			},
			{
				specifier: "./namespace",
				imported: [{ local: "namespace", localRange: span("namespace", "import * as namespace") }],
				reExport: false,
			},
			{
				specifier: "./type-only",
				imported: [{ name: "TypeOnly", range: span("TypeOnly", "import type { TypeOnly") }],
				reExport: false,
			},
			{
				specifier: "./inline-type",
				imported: [
					{
						name: "InlineType",
						range: span("InlineType", "import { type InlineType"),
						local: "LocalInline",
						localRange: span("LocalInline", "import { type InlineType"),
					},
				],
				reExport: false,
			},
			{
				specifier: "./reexport",
				imported: [{ name: "reexported", range: span("reexported", "export { reexported") }],
				reExport: true,
			},
			{
				specifier: "./reexport-alias",
				imported: [
					{
						name: "sourceName",
						range: span("sourceName", "export { sourceName"),
						local: "exportedName",
						localRange: span("exportedName", "export { sourceName"),
					},
				],
				reExport: true,
			},
			{
				specifier: "./default-reexport",
				imported: [{ name: "defaultSource", range: span("defaultSource", "export { defaultSource") }],
				reExport: true,
			},
			{
				specifier: "./namespace-export",
				imported: [
					{ local: "namespaceExport", localRange: span("namespaceExport", "export * as namespaceExport") },
				],
				reExport: true,
			},
			{ specifier: "./all", imported: [], reExport: true },
			{ specifier: "./side-effect", imported: [], reExport: false },
		]);
	});

	it("records a side-effect import with no names rather than skipping it", () => {
		expect(extract('import "./polyfill";').imports).toEqual([
			{ specifier: "./polyfill", imported: [], reExport: false },
		]);
	});

	it("keeps imports and re-exports out of the reference role list", () => {
		const found = extract('import { Item } from "./item";\nexport { Item } from "./item";\n');
		expect(found.references).toEqual([]);
		expect(found.imports).toHaveLength(2);
	});

	it("keeps import specifiers in imports rather than literals", () => {
		const source = [
			'import { item } from "node:fs";',
			'export { item } from "./item";',
			'import "side-effect";',
			'const ordinary = "node:fs";',
			'const loaded = import("lazy");',
			'const required = require("require-spec");',
		].join("\n");
		const found = extract(source);

		expect(found.imports.map((entry) => entry.specifier)).toEqual(["node:fs", "./item", "side-effect", "lazy"]);
		expect(found.literals.map((literal) => literal.value)).toEqual(["node:fs", "require-spec"]);
	});
});

describe("references", () => {
	it("records a call and which declaration it came from", () => {
		const found = extract("function helper() {}\nexport function run() { helper(); }\n");
		const call = found.references.find((r) => r.name === "helper");
		const run = found.declarations.find((d) => d.name === "run");

		expect(call?.role).toBe("call");
		expect(call?.fromId).toBe(run?.symbolId);
	});

	it("records a value read", () => {
		const read = extract("const source = 1;\nexport const result = source;\n").references;
		expect(read).toEqual([expect.objectContaining({ name: "source", role: "read" })]);
	});

	it("records a simple write and both roles for a compound assignment", () => {
		const references = extract("let count = 0;\ncount = 1;\ncount += 1;\n").references;
		expect(references.filter((reference) => reference.name === "count").map((reference) => reference.role)).toEqual(
			["write", "read", "write"],
		);
	});

	it("records identifiers in type positions as type uses", () => {
		const references = extract("interface Item {}\nlet item: Item;\n").references;
		expect(references).toEqual([expect.objectContaining({ name: "Item", role: "typeUse" })]);
	});

	it("does not treat a const assertion keyword as a reference", () => {
		expect(extract("const value = 1 as const;\n").references).toEqual([]);
	});

	it("records a direct new target as an instantiation", () => {
		const references = extract("class Cart {}\nconst cart = new Cart();\n").references;
		expect(references).toEqual([expect.objectContaining({ name: "Cart", role: "instantiate" })]);
	});

	it("records direct heritage targets as extends and implements", () => {
		const references = extract(
			"class Base {}\ninterface Contract {}\nclass Child extends Base implements Contract {}\n",
		).references;
		expect(references).toEqual([
			expect.objectContaining({ name: "Base", role: "extends" }),
			expect.objectContaining({ name: "Contract", role: "implements" }),
		]);
	});

	it("reports a candidate as unbound with a reason, rather than claiming a resolution", () => {
		const call = extract("export function run() { helper(); }").references[0];
		expect(call?.binding).toMatchObject({ status: "unbound", reason: "NotImplemented" });
	});

	it("records a method call by its property name", () => {
		const found = extract("export function run() { cart.add(); }");
		expect(found.references.map((r) => r.name)).toContain("add");
	});
});

describe("ids", () => {
	it("mints ids that parse, for every declaration it reports", () => {
		const found = extract("export class C { m() {} }\nexport const x = 1;\n");
		for (const declaration of found.declarations) {
			expect(parseSymbolId(declaration.symbolId), declaration.name).not.toBeNull();
		}
	});

	it("gives two same-named members in different classes distinct ids", () => {
		const found = extract("export class A { go() {} }\nexport class B { go() {} }\n");
		const ids = found.declarations.filter((d) => d.name === "go").map((d) => d.symbolId);
		expect(new Set(ids).size).toBe(2);
	});
});
