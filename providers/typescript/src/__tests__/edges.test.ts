import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { coordinatesOf, type Export, type FileFacts, parseSymbolId, type Range } from "@nyaa-lexicon/protocol";
import ts from "typescript";
import { extractFile } from "../extract";
import { extractSurfaceFile } from "../surface";
import { harness } from "./harness.js";

////////////////////////////////
//  Helpers

const roots: string[] = [];

function workspace(files: Record<string, string>): string {
	const root = mkdtempSync(path.join(tmpdir(), "lexicon-typescript-edges-"));
	roots.push(root);
	for (const [module, text] of Object.entries(files)) {
		const full = path.join(root, module);
		mkdirSync(path.dirname(full), { recursive: true });
		writeFileSync(full, text);
	}
	return root;
}

function extract(text: string, module = "src/a.ts") {
	const source = ts.createSourceFile(module, text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
	return extractFile(module, source);
}

/** Parses every file at full depth, admitted, and answers the last one's facts. */
function parsed(files: Record<string, string>, module: string, depth?: "outline"): FileFacts {
	const provider = harness();
	provider.initialize(workspace(files));
	let facts: FileFacts | undefined;
	for (const [name, text] of Object.entries(files)) {
		const answer = provider.parseFile({ module: name, contentHash: name, text, ...(depth ? { depth } : {}) });
		if (name === module) facts = answer as FileFacts;
	}
	provider.shutdown();
	if (facts === undefined) throw new Error(`missing test module: ${module}`);
	return facts;
}

function rangeForText(text: string, value: string, from = 0): Range {
	const start = text.indexOf(value, from);
	if (start === -1) throw new Error(`missing test text: ${value}`);
	const range = coordinatesOf(text).rangeAt(start, start + value.length);
	if (range === undefined) throw new Error(`invalid test text range: ${value}`);
	return range;
}

/** Each export as form, name, what it targets by name, and its meaning. */
function exportsOf(facts: Pick<FileFacts, "exports" | "imports" | "declarations">, text: string) {
	const slice = (range: Range) => coordinatesOf(text).sliceRange(range);
	const named = (target: Export["target"]) => {
		if (target.kind === "symbol") return facts.declarations.find((d) => d.symbolId === target.symbolId)?.name;
		if (target.kind === "unknown") return target.reason;
		return slice(target.span);
	};
	return (facts.exports ?? []).map((edge) => ({
		form: edge.form,
		name: edge.name,
		target: `${edge.target.kind}:${named(edge.target)}`,
		...(edge.meaning === undefined ? {} : { meaning: edge.meaning }),
		...(edge.certainty.status === "unknown" ? { certainty: edge.certainty.reason } : {}),
	}));
}

/** Each reference as `line:name`, what it binds, whether qualified, and the edge and path or declaration it resolves through. */
function usesOf(facts: FileFacts, text: string, skip: readonly string[] = []): string[] {
	const slice = (range: Range) => coordinatesOf(text).sliceRange(range);
	const shown = facts.references.filter((reference) => !skip.includes(reference.name));
	return shown.map(({ name, range, binding, origin, qualified }) => {
		const bound =
			binding.status === "bound"
				? (parseSymbolId(binding.symbolId)
						?.descriptors.map((descriptor) => descriptor.name)
						.join("/") ?? "?")
				: binding.status === "unbound"
					? binding.reason
					: "ambiguous";
		const through =
			origin === undefined
				? "none"
				: origin.kind === "declaration"
					? "declaration"
					: `${slice(origin.span)}${origin.path === undefined ? "" : ` .${origin.path.join(".")}`}`;
		const module = binding.status === "bound" ? `${parseSymbolId(binding.symbolId)?.module} ` : "";
		return `${range.start.line}:${name} ${module}${bound}${qualified ? " qualified" : ""} via ${through}`;
	});
}

const KNOWN = { status: "known" } as const;
const BINDS = {
	bindsLocally: true,
	conflict: { priority: 0, amongTransfers: "exclude", againstLocal: "localWins" },
} as const;

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

////////////////////////////////
//  Tests

describe("import edges", () => {
	it("reports one edge per transfer, every form, in one source order with the exports", () => {
		const source = [
			'import { foo } from "./named";',
			'import { original as renamed } from "./aliased";',
			'import defaultThing, * as space from "./default";',
			'import type { TypeOnly } from "./type-only";',
			'import { type Inline as Local } from "./inline";',
			'import equals = require("./equals");',
			'import "./effect";',
			'export { reexported } from "./reexport";',
			'export { sourceName as exportedName } from "./alias";',
			'export * as spaced from "./spaced";',
			'export * from "./all";',
			'export type * from "./types";',
		].join("\n");
		const at = (value: string, line: string) => rangeForText(source, value, source.indexOf(line));
		const found = extract(source);

		expect(found.imports).toEqual([
			{
				specifier: "./named",
				edges: [
					{
						kind: "named",
						span: at("foo", "import { foo"),
						name: "foo",
						range: at("foo", "import { foo"),
						...BINDS,
						loads: "static",
						certainty: KNOWN,
						order: 0,
					},
				],
			},
			{
				specifier: "./aliased",
				edges: [
					{
						kind: "named",
						span: at("original as renamed", "import { original"),
						name: "original",
						range: at("original", "import { original"),
						local: "renamed",
						localRange: at("renamed", "import { original"),
						...BINDS,
						loads: "static",
						certainty: KNOWN,
						order: 1,
					},
				],
			},
			{
				specifier: "./default",
				edges: [
					{
						kind: "default",
						span: at("defaultThing", "import defaultThing"),
						local: "defaultThing",
						localRange: at("defaultThing", "import defaultThing"),
						...BINDS,
						loads: "static",
						certainty: KNOWN,
						order: 2,
					},
					{
						kind: "namespace",
						span: at("* as space", "import defaultThing"),
						local: "space",
						localRange: at("space", "import defaultThing"),
						...BINDS,
						loads: "static",
						certainty: KNOWN,
						order: 3,
					},
				],
			},
			{
				specifier: "./type-only",
				edges: [
					{
						kind: "named",
						span: at("TypeOnly", "import type {"),
						name: "TypeOnly",
						range: at("TypeOnly", "import type {"),
						...BINDS,
						typeOnly: true,
						elided: true,
						meaning: ["type"],
						loads: "static",
						certainty: KNOWN,
						order: 4,
					},
				],
			},
			{
				specifier: "./inline",
				edges: [
					{
						kind: "named",
						span: at("type Inline as Local", "import { type"),
						name: "Inline",
						range: at("Inline", "import { type"),
						local: "Local",
						localRange: at("Local", "import { type"),
						...BINDS,
						typeOnly: true,
						elided: true,
						meaning: ["type"],
						loads: "static",
						certainty: KNOWN,
						order: 5,
					},
				],
			},
			{
				specifier: "./equals",
				edges: [
					{
						kind: "require",
						span: at("equals", "import equals"),
						local: "equals",
						localRange: at("equals", "import equals"),
						...BINDS,
						loads: "static",
						certainty: KNOWN,
						order: 6,
					},
				],
			},
			{
				specifier: "./effect",
				edges: [
					{
						kind: "sideEffect",
						span: at('import "./effect";', 'import "./effect"'),
						bindsLocally: false,
						elided: false,
						loads: "static",
						certainty: KNOWN,
						order: 7,
					},
				],
			},
			{
				specifier: "./reexport",
				edges: [
					{
						kind: "named",
						span: at("reexported", "export { reexported"),
						name: "reexported",
						range: at("reexported", "export { reexported"),
						bindsLocally: false,
						loads: "static",
						certainty: KNOWN,
						order: 8,
					},
				],
			},
			{
				specifier: "./alias",
				edges: [
					{
						kind: "named",
						span: at("sourceName as exportedName", "export { sourceName"),
						name: "sourceName",
						range: at("sourceName", "export { sourceName"),
						bindsLocally: false,
						loads: "static",
						certainty: KNOWN,
						order: 10,
					},
				],
			},
			{
				specifier: "./spaced",
				edges: [
					{
						kind: "wildcard",
						span: at("* as spaced", "export * as spaced"),
						selector: { kind: "visible" },
						bindsLocally: false,
						elided: false,
						loads: "static",
						certainty: KNOWN,
						order: 12,
					},
				],
			},
			{
				specifier: "./all",
				edges: [
					{
						kind: "wildcard",
						span: at("*", 'export * from "./all"'),
						selector: { kind: "allButDefault" },
						bindsLocally: false,
						elided: false,
						loads: "static",
						certainty: KNOWN,
						order: 14,
					},
				],
			},
			{
				specifier: "./types",
				edges: [
					{
						kind: "wildcard",
						span: at("*", "export type *"),
						selector: { kind: "allButDefault" },
						bindsLocally: false,
						typeOnly: true,
						elided: true,
						meaning: ["type"],
						loads: "static",
						certainty: KNOWN,
						order: 16,
					},
				],
			},
		]);
		expect(found.exports.map((edge) => edge.order)).toEqual([9, 11, 13, 15, 17]);
	});

	it("reports a dynamic import as an edge binding nothing", () => {
		const source = 'export async function load() { return import("./lazy"); }\n';
		expect(extract(source).imports).toEqual([
			{
				specifier: "./lazy",
				edges: [
					{
						kind: "sideEffect",
						span: rangeForText(source, 'import("./lazy")'),
						bindsLocally: false,
						loads: "deferred",
						certainty: KNOWN,
						order: 1,
					},
				],
			},
		]);
	});

	it("reports a CommonJS require only where the checker proves it", () => {
		const use = [
			'const whole = require("./m");',
			'const { run, run: go } = require("./m");',
			'const one = require("./m").run;',
			'require("./m");',
			"whole.run();",
			'require("./m").run();',
			'function later() { return require("./m"); }',
		].join("\n");
		const shadow = [
			"function require(path) { return path; }",
			'const whole = require("./m");',
			'function inner(require) { return require("./m").run; }',
		].join("\n");
		const files = { "src/m.js": "exports.run = function run() {};\n", "src/use.js": use, "src/shadow.js": shadow };

		const facts = parsed(files, "src/use.js");
		const edges = facts.imports.flatMap((statement) =>
			statement.edges.map((edge) => [statement.specifier, edge.kind, edge.name, edge.local]),
		);
		expect(edges).toEqual([
			["./m", "require", undefined, "whole"],
			["./m", "named", "run", undefined],
			["./m", "named", "run", "go"],
			["./m", "named", "run", "one"],
			["./m", "sideEffect", undefined, undefined],
			["./m", "sideEffect", undefined, undefined],
			["./m", "sideEffect", undefined, undefined],
		]);
		// A call that binds nothing is its own edge, wherever it is written.
		const loads = facts.imports
			.flatMap((statement) => statement.edges)
			.filter((edge) => edge.kind === "sideEffect")
			.map((edge) => [edge.span.start.line, coordinatesOf(use).sliceRange(edge.span)]);
		expect(loads).toEqual([
			[3, 'require("./m")'],
			[5, 'require("./m")'],
			[6, 'require("./m")'],
		]);
		// The receiver's edge carries the use; JavaScript's own `require` declares nothing to name.
		const origins = (line: number) =>
			facts.references
				.filter((reference) => reference.range.start.line === line)
				.map(({ name, origin }) => [name, origin?.kind, origin?.kind === "import" ? origin.path : undefined]);
		expect(origins(0)).toEqual([["require", undefined, undefined]]);
		expect(origins(4)).toEqual([
			["whole", "import", undefined],
			["run", "import", ["run"]],
		]);
		expect(parsed(files, "src/shadow.js").imports).toEqual([]);
		// Without the checker nothing is proved.
		expect(parsed(files, "src/use.js", "outline").imports).toEqual([]);
	});
});

describe("reference origins", () => {
	it("names the import edge a use resolves through, with a receiver's path, else the declaration", () => {
		const use = [
			'import { add as plus } from "./add";',
			'import * as ns from "./add";',
			'import req = require("./add");',
			'import made from "./made";',
			"function local() {}",
			"plus();",
			"ns.Inner.deep();",
			"let typed: ns.T;",
			"req.add();",
			"local();",
			"made();",
		].join("\n");
		const files = {
			"src/add.ts": [
				"export function add() {}",
				"export namespace Inner { export function deep() {} }",
				"export type T = number;",
			].join("\n"),
			"src/made.ts": "export default function () {}\n",
			"src/use.ts": use,
		};
		const facts = parsed(files, "src/use.ts");
		const slice = (range: Range) => coordinatesOf(use).sliceRange(range);
		const origins = facts.references.map((reference) => {
			const origin = reference.origin;
			const through =
				origin === undefined ? "none" : origin.kind === "declaration" ? "declaration" : slice(origin.span);
			return `${reference.name} ${through}${origin?.kind === "import" && origin.path ? ` .${origin.path.join(".")}` : ""}`;
		});

		expect(origins).toEqual([
			"plus add as plus",
			"ns * as ns",
			"Inner * as ns .Inner",
			"deep * as ns .Inner.deep",
			"ns * as ns",
			"T * as ns .T",
			"req req",
			"add req .add",
			"local declaration",
			"made made",
		]);
	});

	it("reads a destructured key off a namespace or require binding as a member, keeping its local", () => {
		const use = [
			'import * as d from "./d";',
			'import req = require("./d");',
			"const { parse } = d;",
			"const { parse: p } = req;",
			"const { Inner: { deep } } = d;",
			"const { deep: viaPath } = d.Inner;",
			"const plain = { kept: 1 };",
			"const { kept } = plain;",
			"parse();",
		].join("\n");
		const files = {
			"src/d.ts": "export function parse() {}\nexport namespace Inner { export function deep() {} }\n",
			"src/use.ts": use,
		};
		expect(usesOf(parsed(files, "src/use.ts"), use)).toEqual([
			"2:parse src/d.ts parse qualified via * as d .parse",
			"2:d NotIndexed via * as d",
			"3:parse src/d.ts parse qualified via req .parse",
			"3:req NotIndexed via req",
			"4:Inner src/d.ts Inner qualified via * as d .Inner",
			"4:deep src/d.ts Inner/deep qualified via * as d .Inner.deep",
			"4:d NotIndexed via * as d",
			"5:deep src/d.ts Inner/deep qualified via * as d .Inner.deep",
			"5:d NotIndexed via * as d",
			"5:Inner src/d.ts Inner qualified via * as d .Inner",
			"7:plain src/use.ts plain via declaration",
			"8:parse src/use.ts parse via declaration",
		]);
	});

	it("binds a CommonJS export's object and assigned name to nothing, never to the assigned value", () => {
		const assigned = "function parse() {}\nmodule.exports = parse;\n";
		const named = [
			"function parse() {}",
			"exports.other = parse;",
			"module.exports.parse = parse;",
			'Object.defineProperty(exports, "more", { value: parse });',
		].join("\n");
		const shadowed = "function parse() {}\nconst exports = {};\nexports.other = parse;\n";
		const files = { "src/assigned.js": assigned, "src/named.js": named, "src/shadowed.js": shadowed };
		expect(usesOf(parsed(files, "src/assigned.js"), assigned)).toEqual([
			"1:module NotIndexed via none",
			"1:exports NotIndexed qualified via none",
			"1:parse src/assigned.js parse via declaration",
		]);
		expect(usesOf(parsed(files, "src/named.js"), named, ["Object", "defineProperty", "value"])).toEqual([
			"1:exports NotIndexed via none",
			"1:other NotIndexed qualified via none",
			"1:parse src/named.js parse via declaration",
			"2:module NotIndexed via none",
			"2:exports NotIndexed qualified via none",
			"2:parse NotIndexed qualified via none",
			"2:parse src/named.js parse via declaration",
			"3:exports NotIndexed via none",
			"3:parse src/named.js parse via declaration",
		]);
		// A local named `exports` is that local.
		expect(usesOf(parsed(files, "src/shadowed.js"), shadowed)[0]).toBe(
			"2:exports src/shadowed.js exports via declaration",
		);
	});

	it("binds a required member of `module.exports = { N: local }` as that local, only through the import", () => {
		const exporter = "function load() {}\nmodule.exports = { parse: load };\nmodule.exports.parse();\n";
		const use = [
			'const { parse } = require("./d");',
			"parse();",
			'const m = require("./d");',
			"m.parse();",
			"const { parse: again } = m;",
		].join("\n");
		const shorthand = 'const m = require("./d");\nconst { parse } = m;\n';
		const files = { "src/d.js": exporter, "src/use.js": use, "src/shorthand.js": shorthand };
		expect(usesOf(parsed(files, "src/use.js"), use, ["require"])).toEqual([
			"1:parse src/d.js load via parse",
			"3:m NotIndexed via m",
			"3:parse src/d.js load qualified via m .parse",
			"4:parse src/d.js load qualified via m .parse",
			"4:m NotIndexed via m",
		]);
		expect(usesOf(parsed(files, "src/shorthand.js"), shorthand, ["require"])).toEqual([
			"1:parse src/d.js load qualified via m .parse",
			"1:m NotIndexed via m",
		]);
		// No import routes the module's own read, so it binds no local.
		expect(usesOf(parsed(files, "src/d.js"), exporter).at(-1)).toBe("2:parse NotIndexed qualified via declaration");
	});

	it("binds a required name through each CommonJS member form, and reads no require edge's own name as a use", () => {
		const use = [
			'const { parse: pa } = require("./a");',
			'const { parse: pb } = require("./b");',
			'const { parse: pc } = require("./c");',
			'const direct = require("./b").parse;',
			"pa(); pb(); pc(); direct();",
		].join("\n");
		const files = {
			"src/a.js": "function load() {}\nexports.parse = load;\n",
			"src/b.js": "function load() {}\nmodule.exports.parse = load;\n",
			"src/c.js": "function load() {}\nmodule.exports = { parse: (load) };\n",
			"src/use.js": use,
		};
		expect(usesOf(parsed(files, "src/use.js"), use, ["require"])).toEqual([
			"4:pa src/a.js load via parse: pa",
			"4:pb src/b.js load via parse: pb",
			"4:pc src/c.js load via parse: pc",
			"4:direct src/b.js load via direct",
		]);
	});
});

describe("export edges", () => {
	it("reports each form with its target and meaning", () => {
		const source = [
			'import { imported } from "./m";',
			"export function add() {}",
			"export const a = 1, b = 2;",
			"export interface Shape {}",
			"export const Shape = 1;",
			"const sub = 1;",
			"export { sub as minus, imported };",
			"export default function named() {}",
			"export function over(): void;",
			"export function over(x?: number) {}",
			"export class Merged {}",
			"export interface Merged { extra: number }",
			'export { forwarded, source as renamed } from "./f";',
			'export * as ns from "./n";',
			'export * from "./s";',
			'export type { Kind } from "./k";',
		].join("\n");

		expect(exportsOf(extract(source), source)).toEqual([
			{ form: "direct", name: "add", target: "symbol:add", meaning: ["value"] },
			{ form: "direct", name: "a", target: "symbol:a", meaning: ["value"] },
			{ form: "direct", name: "b", target: "symbol:b", meaning: ["value"] },
			{ form: "direct", name: "Shape", target: "symbol:Shape", meaning: ["type"] },
			{ form: "direct", name: "Shape", target: "symbol:Shape", meaning: ["value"] },
			{ form: "local", name: "minus", target: "symbol:sub", meaning: ["value"] },
			{ form: "local", name: "imported", target: "import:imported" },
			{ form: "default", name: "default", target: "symbol:named", meaning: ["value"] },
			{ form: "direct", name: "over", target: "symbol:over", meaning: ["value"] },
			{ form: "direct", name: "Merged", target: "symbol:Merged", meaning: ["value", "type"] },
			{ form: "forward", name: "forwarded", target: "import:forwarded" },
			{ form: "forward", name: "renamed", target: "import:source as renamed" },
			{ form: "namespace", name: "ns", target: "import:* as ns" },
			{ form: "star", name: undefined, target: "import:*" },
			{ form: "forward", name: "Kind", target: "import:Kind", meaning: ["type"] },
		]);
	});

	it("targets a default or assigned name's declaration, and nothing for an expression", () => {
		const cases: Array<[string, ReturnType<typeof exportsOf>]> = [
			[
				"const n = 1;\nexport default n;\n",
				[{ form: "default", name: "default", target: "symbol:n", meaning: ["value"] }],
			],
			["export default 42;\n", [{ form: "default", name: "default", target: "unknown:NotIndexed" }]],
			[
				"export default function () {}\n",
				[{ form: "default", name: "default", target: "symbol:default", meaning: ["value"] }],
			],
			["export default missing;\n", [{ form: "default", name: "default", target: "unknown:NotIndexed" }]],
			[
				"class Box {}\nexport = Box;\n",
				[{ form: "assignment", name: undefined, target: "symbol:Box", meaning: ["value", "type"] }],
			],
			[
				'import thing = require("./thing");\nexport = thing;\n',
				[{ form: "assignment", name: undefined, target: "import:thing" }],
			],
		];
		for (const [source, expected] of cases) expect(exportsOf(extract(source), source), source).toEqual(expected);
	});

	it("reports a namespace's meaning only where the checker proves it holds values", () => {
		const files = {
			"src/a.ts":
				"export namespace Values { export const x = 1; }\nexport namespace Types { export type T = 1; }\n",
		};
		const text = files["src/a.ts"];
		expect(exportsOf(parsed(files, "src/a.ts"), text)).toEqual([
			{ form: "direct", name: "Values", target: "symbol:Values", meaning: ["value", "type"] },
			{ form: "direct", name: "Types", target: "symbol:Types", meaning: ["type"] },
		]);
		expect(exportsOf(parsed(files, "src/a.ts", "outline"), text)).toEqual([
			{ form: "direct", name: "Values", target: "symbol:Values" },
			{ form: "direct", name: "Types", target: "symbol:Types" },
		]);
	});

	it("reports exports at surface depth against the surface's own declarations", () => {
		const declarations = [
			"export declare function send(value: string): string;",
			"declare const kept: number;",
			"export { kept as shown };",
			'export * from "./more";',
		].join("\n");
		const facts = extractSurfaceFile("types/lib.d.ts", declarations);
		expect(exportsOf(facts, declarations)).toEqual([
			{ form: "direct", name: "send", target: "symbol:send", meaning: ["value"] },
			{ form: "local", name: "shown", target: "symbol:shown", meaning: ["value"] },
			{ form: "star", name: undefined, target: "import:*" },
		]);

		const bundle =
			'export function send(v){return v}export{send as post};const x=1;export{x};export*from"./chunk.js";';
		const runtime = extractSurfaceFile("opaque/runtime.js", bundle);
		expect(exportsOf(runtime, bundle)).toEqual([
			{ form: "direct", name: "send", target: "symbol:send", meaning: ["value"] },
			{ form: "local", name: "post", target: "symbol:post", meaning: ["value"] },
			{ form: "local", name: "x", target: "unknown:NotIndexed" },
			{ form: "star", name: undefined, target: "import:*" },
		]);
		// A bundle reports only the import its exports forward.
		expect(runtime.imports.map((statement) => statement.specifier)).toEqual(["./chunk.js"]);
	});

	it("reads CommonJS exports in a script, and only once on load as known", () => {
		const text = [
			"function run() {}",
			"exports.run = run;",
			"module.exports.go = () => 1;",
			"if (ready) exports.later = 1;",
		].join("\n");
		const files = { "src/m.js": text };
		expect(exportsOf(parsed(files, "src/m.js"), text)).toEqual([
			{ form: "local", name: "run", target: "symbol:run", meaning: ["value"] },
			{ form: "direct", name: "go", target: "unknown:NotIndexed" },
			{ form: "direct", name: "later", target: "unknown:NotIndexed", certainty: "RuntimeConstructed" },
		]);
		// An ES module's `exports` is just a name.
		const module = "export const kept = 1;\nexports.run = 1;\n";
		expect(exportsOf(parsed({ "src/e.js": module }, "src/e.js"), module)).toEqual([
			{ form: "direct", name: "kept", target: "symbol:kept", meaning: ["value"] },
		]);
	});
});
