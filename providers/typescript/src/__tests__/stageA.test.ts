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

	it("reports default-elided imports and respects preserve options and JavaScript", () => {
		const files = {
			"src/a.ts": 'import { Shape } from "./shape"; let item: Shape;',
			"src/shape.ts": "export interface Shape {}",
		};
		expect(
			parse(files, "src/a.ts", JSON.stringify({ compilerOptions: { module: "ESNext" } })).imports[0]?.edges[0]
				?.elided,
		).toBe(true);
		const valueUse = {
			"src/a.ts": 'import { Shape } from "./shape"; new Shape();',
			"src/shape.ts": "export class Shape {}",
		};
		expect(
			parse(valueUse, "src/a.ts", JSON.stringify({ compilerOptions: { module: "ESNext" } })).imports[0]?.edges[0]
				?.elided,
		).toBeUndefined();
		expect(
			parse(
				files,
				"src/a.ts",
				JSON.stringify({ compilerOptions: { module: "ESNext", verbatimModuleSyntax: true } }),
			).imports[0]?.edges[0]?.elided,
		).toBeUndefined();
		expect(
			parse(
				files,
				"src/a.ts",
				JSON.stringify({ compilerOptions: { module: "ESNext", preserveValueImports: true } }),
			).imports[0]?.edges[0]?.elided,
		).toBeUndefined();
		expect(
			parse({ "src/a.js": 'import { value } from "./value.js"; value;' }, "src/a.js").imports[0]?.edges[0]
				?.elided,
		).toBeUndefined();
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
