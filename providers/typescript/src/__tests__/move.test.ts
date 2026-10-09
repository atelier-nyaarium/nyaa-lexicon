import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	applyEdits,
	composeSymbolId,
	coordinatesOf,
	type MoveDependency,
	type MoveEditsRequest,
	type MoveImportSite,
	type Range,
	type WorkMeter,
} from "@nyaa-lexicon/protocol";
import ts from "typescript";
import { importOf } from "../imports.js";
import { makeMoveEdits } from "../move.js";
import { harness } from "./harness.js";

const roots: string[] = [];

function workspace(files: Record<string, string>): string {
	const root = mkdtempSync(path.join(tmpdir(), "lexicon-typescript-move-"));
	roots.push(root);
	for (const [module, text] of Object.entries(files)) {
		const full = path.join(root, module);
		mkdirSync(path.dirname(full), { recursive: true });
		writeFileSync(full, text);
	}
	return root;
}

function rangeForText(text: string, value: string, from = 0): Range {
	const start = text.indexOf(value, from);
	if (start === -1) throw new Error(`missing test text: ${value}`);
	const range = coordinatesOf(text).rangeAt(start, start + value.length);
	if (range === undefined) throw new Error(`invalid test text range: ${value}`);
	return range;
}

function move(root: string, request: MoveEditsRequest) {
	const provider = harness();
	provider.initialize(root);
	const response = provider.moveEdits(request);
	provider.shutdown();
	return response;
}

const BODY = "export function moved() { return 1; }\n";

/** Moves `body` into `target`, which must reach `dependencies`. */
function importInto(target: string, dependencies: MoveDependency[], files: Record<string, string> = {}, body = BODY) {
	const response = move(workspace({ "target.ts": target, "source.ts": "", ...files }), {
		module: "target.ts",
		text: target,
		exists: true,
		symbolId: "lexicon typescript source.ts moved.",
		name: "moved",
		fromModule: "source.ts",
		toModule: "target.ts",
		role: { insertion: { text: body } },
		importSites: [],
		dependencies,
		sites: [],
	});
	if (response.status !== "ready") throw new Error("move was refused");
	return { blocked: response.blocked, applied: applyEdits(target, response.edits) };
}

function sibling(name: string): MoveDependency {
	return { name, origin: { kind: "sourceModule", symbolId: `source.${name}.`, name, exported: true } };
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("move edits", () => {
	it("refuses insertion positions that do not address content", () => {
		const cases = [
			{ text: "const existing = 1;\n", position: { line: 0, character: 99 } },
			{ text: "const existing = 1;\n", position: { line: 0, character: -1 } },
			{ text: "ab\r\n", position: { line: 0, character: 3 } },
		];

		for (const { text, position } of cases) {
			const response = move(workspace({ "target.ts": text }), {
				module: "target.ts",
				text,
				exists: true,
				symbolId: "lexicon typescript source.ts moved.",
				name: "moved",
				fromModule: "source.ts",
				toModule: "target.ts",
				role: { insertion: { text: "export const moved = 1;\n", position } },
				importSites: [],
				dependencies: [],
				sites: [],
			});

			expect(response).toEqual({
				status: "ready",
				edits: [],
				blocked: [
					{
						range: { start: position, end: position },
						reason: "ParseError",
						detail: "the insertion position is outside the module",
					},
				],
			});
		}
	});

	it("rewrites an import specifier while preserving its alias", () => {
		const text = 'import { moved as local } from "./old";\nlocal();\n';
		const importText = 'import { moved as local } from "./old";';
		const response = move(workspace({ "use.ts": text, "old.ts": "export function moved() {}\n", "new.ts": "" }), {
			module: "use.ts",
			text,
			exists: true,
			symbolId: "lexicon typescript old.ts moved.",
			name: "moved",
			fromModule: "old.ts",
			toModule: "new.ts",
			role: {},
			importSites: [
				{
					range: rangeForText(text, importText),
					specifier: "./old",
					importKind: "named",
					importedName: "moved",
					localName: "local",
				},
			],
			dependencies: [],
			sites: [],
		});

		if (response.status !== "ready") throw new Error("move was refused");
		expect(response.blocked).toEqual([]);
		expect(response.edits).toEqual([
			{
				range: rangeForText(text, importText),
				newText: 'import { moved as local } from "./new";',
			},
		]);
		expect(applyEdits(text, response.edits)).toEqual({
			text: 'import { moved as local } from "./new";\nlocal();\n',
		});
	});

	// The table's first catch: the provider rewrote `export * from "./old"` to point at the target,
	// which repoints every OTHER symbol the barrel re-exported. A whole-module binding must block.
	it("blocks a star re-export instead of repointing the whole module", () => {
		const text = 'export * from "./old";\n';
		const response = move(
			workspace({ "barrel.ts": text, "old.ts": "export function moved() {}\n", "new.ts": "" }),
			{
				module: "barrel.ts",
				text,
				exists: true,
				symbolId: "lexicon typescript old.ts moved.",
				name: "moved",
				fromModule: "old.ts",
				toModule: "new.ts",
				role: {},
				importSites: [
					{
						range: rangeForText(text, "./old"),
						specifier: "./old",
						importKind: "wildcard",
					},
				],
				dependencies: [],
				sites: [],
			},
		);

		if (response.status !== "ready") throw new Error("move was refused");
		expect(response.edits).toEqual([]);
		expect(response.blocked).toHaveLength(1);
		expect(response.blocked[0]?.reason).toBe("NotImplemented");
	});

	it("blocks a namespace or import-equals site the same way", () => {
		const cases = [
			{
				text: 'import * as moved from "./old";\nmoved.run();\n',
				importKind: "namespace",
				importedName: undefined,
			},
			// Core matches the site by its local name, though the statement binds the whole module.
			{ text: 'import moved = require("./old");\nmoved();\n', importKind: "require", importedName: undefined },
		] as const;

		for (const { text, importKind, importedName } of cases) {
			const response = move(
				workspace({ "use.ts": text, "old.ts": "export function moved() {}\n", "new.ts": "" }),
				{
					module: "use.ts",
					text,
					exists: true,
					symbolId: "lexicon typescript old.ts moved.",
					name: "moved",
					fromModule: "old.ts",
					toModule: "new.ts",
					role: {},
					importSites: [
						{
							range: rangeForText(text, "moved"),
							specifier: "./old",
							importKind,
							...(importedName === undefined ? {} : { importedName }),
							localName: "moved",
						},
					],
					dependencies: [],
					sites: [],
				},
			);

			if (response.status !== "ready") throw new Error("move was refused");
			expect(response.edits).toEqual([]);
			expect(response.blocked).toMatchObject([{ reason: "NotImplemented" }]);
		}
	});

	it("uses an imported name span to locate the enclosing import statement", () => {
		const text = 'import { add } from "./cart";\nadd(1, 2);\n';
		const importText = 'import { add } from "./cart";';
		const response = move(
			workspace({ "src/use.ts": text, "src/cart.ts": "export function add() {}\n", "src/items.ts": "" }),
			{
				module: "src/use.ts",
				text,
				exists: true,
				symbolId: "lexicon typescript src/cart.ts add.",
				name: "add",
				fromModule: "src/cart.ts",
				toModule: "src/items.ts",
				role: {},
				importSites: [
					{
						range: rangeForText(text, "add"),
						specifier: "./cart",
						importKind: "named",
						importedName: "add",
					},
				],
				dependencies: [],
				sites: [],
			},
		);

		if (response.status !== "ready") throw new Error("move was refused");
		expect(response.blocked).toEqual([]);
		expect(response.edits).toEqual([
			{ range: rangeForText(text, importText), newText: 'import { add } from "./items";' },
		]);
		expect(applyEdits(text, response.edits)).toEqual({
			text: 'import { add } from "./items";\nadd(1, 2);\n',
		});
	});

	it("moves one name out of an import that keeps others, in its own form, joining or dropping statements", () => {
		const named = { importKind: "named", importedName: "moved" } as const;
		const cases: { imports: string; site: Omit<MoveImportSite, "range" | "specifier">; expected: string }[] = [
			{
				imports: 'import { moved, stay } from "./old";',
				site: named,
				expected: 'import { stay } from "./old";\nimport { moved } from "./new";',
			},
			{
				imports: 'import { stay, moved as run, other } from "./old";',
				site: { ...named, localName: "run" },
				expected: 'import { stay, other } from "./old";\nimport { moved as run } from "./new";',
			},
			{
				imports: 'import type { stay, moved } from "./old";',
				site: { ...named, typeOnly: true },
				expected: 'import type { stay } from "./old";\nimport type { moved } from "./new";',
			},
			{
				imports: 'import { type moved, stay } from "./old";',
				site: { ...named, typeOnly: true },
				expected: 'import { stay } from "./old";\nimport type { moved } from "./new";',
			},
			{
				imports: 'import moved, { stay } from "./old";',
				site: { importKind: "default", localName: "moved" },
				expected: 'import { stay } from "./old";\nimport moved from "./new";',
			},
			{
				imports: 'import stay, { moved } from "./old";',
				site: named,
				expected: 'import stay from "./old";\nimport { moved } from "./new";',
			},
			{
				imports: 'import { moved, /* explains stay */ stay } from "./old";',
				site: named,
				expected: 'import { /* explains stay */ stay } from "./old";\nimport { moved } from "./new";',
			},
			{
				imports: 'import { stay /* about stay */, moved } from "./old";',
				site: named,
				expected: 'import { stay /* about stay */ } from "./old";\nimport { moved } from "./new";',
			},
			{
				imports: 'import { moved, stay } from "./old";\nimport { other } from "./new";',
				site: named,
				expected: 'import { stay } from "./old";\nimport { other, moved } from "./new";',
			},
			{
				imports: 'import { moved } from "./old";\nimport { other } from "./new";',
				site: named,
				expected: 'import { other, moved } from "./new";',
			},
			{
				imports: 'export { stay, moved } from "./old";',
				site: named,
				expected: 'export { stay } from "./old";\nexport { moved } from "./new";',
			},
		];

		for (const { imports, site, expected } of cases) {
			const text = `${imports}\nconsole.log(1);\n`;
			const response = move(
				workspace({
					"use.ts": text,
					"old.ts": "export function moved() {}\nexport const stay = 1, other = 2;\n",
					"new.ts": "",
				}),
				{
					module: "use.ts",
					text,
					exists: true,
					symbolId: "lexicon typescript old.ts moved.",
					name: "moved",
					fromModule: "old.ts",
					toModule: "new.ts",
					role: {},
					importSites: [{ range: rangeForText(text, "moved"), specifier: "./old", ...site }],
					dependencies: [],
					sites: [],
				},
			);

			if (response.status !== "ready") throw new Error("move was refused");
			expect(response.blocked, imports).toEqual([]);
			expect(applyEdits(text, response.edits), imports).toEqual({ text: `${expected}\nconsole.log(1);\n` });
		}
	});

	it("adds an import for an exported sibling left in the source module", () => {
		const body = "export function moved() { return sibling; }\n";
		const response = move(workspace({ "source.ts": "export const sibling = 1;\n", "target.ts": "" }), {
			module: "target.ts",
			text: "",
			exists: true,
			symbolId: "lexicon typescript source.ts moved.",
			name: "moved",
			fromModule: "source.ts",
			toModule: "target.ts",
			role: { insertion: { text: body } },
			importSites: [],
			dependencies: [
				{
					name: "sibling",
					origin: { kind: "sourceModule", symbolId: "source.sibling.", name: "sibling", exported: true },
				},
			],
			sites: [],
		});

		if (response.status !== "ready") throw new Error("move was refused");
		expect(response.blocked).toEqual([]);
		expect(response.edits).toHaveLength(1);
		expect(applyEdits("", response.edits)).toEqual({
			text: `import { sibling } from "./source";\n\n${body}`,
		});
	});

	// Two statements for one specifier is valid code but reads as a mistake, so a name the target
	// can already reach through an existing import joins it instead.
	it("folds a new name into an existing import for the same specifier", () => {
		const target = 'import { existing } from "./source";\n\nexport const kept = 1;\n';
		for (const name of ["sibling", "$sibling", `caf${String.fromCodePoint(0xe9)}`]) {
			const body = `export function moved() { return ${name}; }\n`;
			const response = move(
				workspace({
					"source.ts": `export const ${name} = 1;\nexport const existing = 2;\n`,
					"target.ts": target,
				}),
				{
					module: "target.ts",
					text: target,
					exists: true,
					symbolId: "lexicon typescript source.ts moved.",
					name: "moved",
					fromModule: "source.ts",
					toModule: "target.ts",
					role: { insertion: { text: body } },
					importSites: [],
					dependencies: [
						{ name, origin: { kind: "sourceModule", symbolId: `source.${name}.`, name, exported: true } },
					],
					sites: [],
				},
			);

			if (response.status !== "ready") throw new Error("move was refused");
			expect(response.blocked).toEqual([]);
			expect(applyEdits(target, response.edits)).toEqual({
				text: `import { existing, ${name} } from "./source";\n\nexport const kept = 1;\n\n${body}`,
			});
		}
	});

	it("lands an existing import in the mode its file resolves import declarations with", () => {
		const target = 'import { existing } from "#src";\n';
		const body = "export function moved() { return sibling; }\n";
		const response = move(
			workspace({
				"tsconfig.json": JSON.stringify({
					compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext" },
				}),
				"package.json": JSON.stringify({
					type: "module",
					imports: { "#src": { import: "./source.js", require: "./other.cjs" } },
				}),
				"source.ts": "export const sibling = 1;\nexport const existing = 2;\n",
				"other.cts": "export const existing = 3;\n",
				"target.ts": target,
			}),
			{
				module: "target.ts",
				text: target,
				exists: true,
				symbolId: "lexicon typescript source.ts moved.",
				name: "moved",
				fromModule: "source.ts",
				toModule: "target.ts",
				role: { insertion: { text: body } },
				importSites: [],
				dependencies: [sibling("sibling")],
				sites: [],
			},
		);
		if (response.status !== "ready") throw new Error("move was refused");
		expect(applyEdits(target, response.edits)).toEqual({
			text: `import { existing, sibling } from "#src";\n\n${body}`,
		});
	});

	it("lands one specifier apart as an import and as a require in the same module", () => {
		const target = 'import { existing } from "#src";\nimport moved = require("#src");\n';
		const response = move(
			workspace({
				"tsconfig.json": JSON.stringify({
					compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext" },
				}),
				"package.json": JSON.stringify({
					type: "module",
					imports: { "#src": { import: "./source.js", require: "./other.cjs" } },
				}),
				"source.ts": "export function moved() { return 1; }\nexport const existing = 2;\n",
				"other.cts": "export = function moved() { return 3; };\n",
				"target.mts": target,
			}),
			{
				module: "target.mts",
				text: target,
				exists: true,
				symbolId: "lexicon typescript source.ts moved.",
				name: "moved",
				fromModule: "source.ts",
				toModule: "target.mts",
				role: { insertion: { text: BODY } },
				importSites: [],
				dependencies: [],
				sites: [],
			},
		);
		// The require binds other.cts's `moved`, which the move does not take with it.
		expect(response).toMatchObject({ status: "refused", reason: "TargetCollision" });
	});

	it("folds an aliased name into an existing import for its origin specifier", () => {
		const target = 'import { existing } from "pkg";\n';
		const body = "export function moved() { return $local; }\n";
		const response = move(workspace({ "target.ts": target }), {
			module: "target.ts",
			text: target,
			exists: true,
			symbolId: "lexicon typescript source.ts moved.",
			name: "moved",
			fromModule: "source.ts",
			toModule: "target.ts",
			role: { insertion: { text: body } },
			importSites: [],
			dependencies: [
				{
					name: "$local",
					origin: {
						kind: "external",
						via: { specifier: "pkg", importKind: "named", importedName: "$remote", localName: "$local" },
					},
				},
			],
			sites: [],
		});

		if (response.status !== "ready") throw new Error("move was refused");
		expect(response.blocked).toEqual([]);
		expect(applyEdits(target, response.edits)).toEqual({
			text: `import { existing, $remote as $local } from "pkg";\n\n${body}`,
		});
	});

	// Each origin is read from the source's own statement, the way core reads the stored import.
	it("joins a value default and a named type to the module's import, keeping other forms in their own statement", () => {
		const target = 'import { existing } from "pkg";\n';
		const body = "export function moved() { return local; }\n";
		const cases: { statement: string; joined?: string }[] = [
			{ statement: 'import local from "pkg";', joined: 'import local, { existing } from "pkg";' },
			{ statement: 'import * as local from "pkg";' },
			{ statement: 'import type local from "pkg";' },
			{
				statement: 'import type { Remote as local } from "pkg";',
				joined: 'import { existing, type Remote as local } from "pkg";',
			},
			{ statement: 'import type * as local from "pkg";' },
			{ statement: 'import local = require("pkg");' },
			{ statement: 'import type local = require("pkg");' },
		];

		for (const { statement, joined } of cases) {
			const written = ts.createSourceFile("source.ts", statement, ts.ScriptTarget.ESNext, true).statements[0];
			if (written === undefined || !(ts.isImportDeclaration(written) || ts.isImportEqualsDeclaration(written))) {
				throw new Error("missing test import");
			}
			const entry = importOf(written, written.getSourceFile())?.edges[0];
			const via = {
				importKind: entry?.kind ?? "named",
				...(entry?.name === undefined ? {} : { importedName: entry.name }),
				...(entry?.typeOnly === true ? { typeOnly: true } : {}),
			} as const;
			const response = move(workspace({ "target.ts": target }), {
				module: "target.ts",
				text: target,
				exists: true,
				symbolId: "lexicon typescript source.ts moved.",
				name: "moved",
				fromModule: "source.ts",
				toModule: "target.ts",
				role: { insertion: { text: body } },
				importSites: [],
				dependencies: [
					{
						name: "local",
						origin: { kind: "external", via: { specifier: "pkg", localName: "local", ...via } },
					},
				],
				sites: [],
			});

			if (response.status !== "ready") throw new Error("move was refused");
			expect(response.blocked, statement).toEqual([]);
			expect(applyEdits(target, response.edits), statement).toEqual({
				text: joined === undefined ? `${target}${statement}\n\n${body}` : `${joined}\n\n${body}`,
			});
		}
	});

	it("imports the types and values one module gives in one statement, marking each type beside a value", () => {
		const from = (name: string, typeOnly?: boolean): MoveDependency => ({
			name,
			origin: {
				kind: "external",
				via: {
					specifier: "node:child_process",
					importKind: "named",
					importedName: name,
					localName: name,
					...(typeOnly === true ? { typeOnly } : {}),
				},
			},
		});
		const mixed = [from("ChildProcess", true), from("spawn")];
		const cases = [
			{
				target: "",
				dependencies: mixed,
				expected: 'import { type ChildProcess, spawn } from "node:child_process";',
			},
			{
				target: "",
				dependencies: [from("ChildProcess", true), from("Serializable", true)],
				expected: 'import type { ChildProcess, Serializable } from "node:child_process";',
			},
			{
				target: 'import { exec } from "node:child_process";',
				dependencies: mixed,
				expected: 'import { exec, type ChildProcess, spawn } from "node:child_process";',
			},
			{
				target: 'import type { Readable } from "node:child_process";',
				dependencies: [from("ChildProcess", true)],
				expected: 'import type { Readable, ChildProcess } from "node:child_process";',
			},
			{
				target: 'import type { Readable, Writable as W } from "node:child_process";',
				dependencies: mixed,
				expected:
					'import { type Readable, type Writable as W, type ChildProcess, spawn } from "node:child_process";',
			},
		];

		for (const { target, dependencies, expected } of cases) {
			const result = importInto(target === "" ? "" : `${target}\n`, dependencies);
			expect(result.blocked, target).toEqual([]);
			expect(result.applied, target).toEqual({ text: `${expected}\n\n${BODY}` });
		}
	});

	it("imports with `type` a name the moved body uses only as a type", () => {
		const from = (name: string, importKind: "named" | "namespace" = "named"): MoveDependency => ({
			name,
			origin: {
				kind: "external",
				via: {
					specifier: "pkg",
					importKind,
					localName: name,
					...(importKind === "named" ? { importedName: name } : {}),
				},
			},
		});
		const cases = [
			{
				body: "export function run(): ChildProcess { return spawn(); }\n",
				dependencies: [from("ChildProcess"), from("spawn")],
				expected: 'import { type ChildProcess, spawn } from "pkg";',
			},
			{
				body: "export class Runner implements Shape { size: ns.Size = 1; }\n",
				dependencies: [from("Shape"), from("ns", "namespace")],
				expected: 'import type { Shape } from "pkg";\nimport type * as ns from "pkg";',
			},
			// Any value use keeps the value import, a type query's included.
			{
				body: "export const made: Thing = new Thing();\n",
				dependencies: [from("Thing")],
				expected: 'import { Thing } from "pkg";',
			},
			{
				body: "export let copy: typeof value;\n",
				dependencies: [from("value")],
				expected: 'import { value } from "pkg";',
			},
			{
				body: "export class Child extends ns.Base {}\n",
				dependencies: [from("ns", "namespace")],
				expected: 'import * as ns from "pkg";',
			},
			// Decorator metadata emits a decorated class's signature types as values.
			{
				body: "@Injectable()\nexport class Service {\n\tconstructor(readonly repo: Repo) {}\n}\n",
				dependencies: [from("Injectable"), from("Repo")],
				expected: 'import { Injectable, Repo } from "pkg";',
			},
		];

		for (const { body, dependencies, expected } of cases) {
			const result = importInto("", dependencies, {}, body);
			expect(result.blocked, body).toEqual([]);
			expect(result.applied, body).toEqual({ text: `${expected}\n\n${body}` });
		}
	});

	it("imports a moved name back into the source with `type` where what stays uses it only as a type", () => {
		const cases = [
			{
				moved: "export interface Shape { size: number }\n",
				kept: "export function area(shape: Shape) { return shape.size; }\n",
				typeOnly: true,
			},
			{ moved: "export class Shape {}\n", kept: "export const made: Shape = new Shape();\n", typeOnly: false },
		];
		for (const { moved, kept, typeOnly } of cases) {
			const text = `${moved}\n${kept}`;
			const response = move(workspace({ "source.ts": text, "target.ts": "" }), {
				module: "source.ts",
				text,
				exists: true,
				symbolId: "lexicon typescript source.ts Shape#",
				name: "Shape",
				fromModule: "source.ts",
				toModule: "target.ts",
				role: { removal: rangeForText(text, `${moved}\n`) },
				importSites: [],
				dependencies: [
					{
						name: "Shape",
						origin: {
							kind: "workspaceModule",
							symbolId: "lexicon typescript target.ts Shape#",
							module: "target.ts",
						},
					},
				],
				sites: [],
			});

			if (response.status !== "ready") throw new Error("move was refused");
			expect(response.blocked).toEqual([]);
			expect(applyEdits(text, response.edits)).toEqual({
				text: `import ${typeOnly ? "type " : ""}{ Shape } from "./target";\n\n${kept}`,
			});
		}
	});

	it("keeps one blank line between the import block and what lands or stays below it", () => {
		const cases = [
			{ target: "", expected: `import { sibling } from "./source";\n\n${BODY}` },
			{
				target: "// only a comment",
				expected: `// only a comment\nimport { sibling } from "./source";\n\n${BODY}`,
			},
			{
				target: 'import { a } from "./a";\n',
				expected: `import { a } from "./a";\nimport { sibling } from "./source";\n\n${BODY}`,
			},
		];
		for (const { target, expected } of cases) {
			const result = importInto(target, [sibling("sibling")], { "a.ts": "export const a = 1;\n" });
			expect(result.blocked, target).toEqual([]);
			expect(result.applied, target).toEqual({ text: expected });
		}

		// The import the move takes out leaves no blank first line, and no doubled one under a header.
		for (const header of ["", "// Header.\n\n"]) {
			const text = `${header}import { moved } from "./source";\n\nexport const kept = moved();\n`;
			const response = move(workspace({ "target.ts": text, "source.ts": BODY }), {
				module: "target.ts",
				text,
				exists: true,
				symbolId: "lexicon typescript source.ts moved().",
				name: "moved",
				fromModule: "source.ts",
				toModule: "target.ts",
				role: { insertion: { text: BODY } },
				importSites: [
					{
						range: rangeForText(text, "moved"),
						specifier: "./source",
						importKind: "named",
						importedName: "moved",
					},
				],
				dependencies: [],
				sites: [],
			});

			if (response.status !== "ready") throw new Error("move was refused");
			expect(applyEdits(text, response.edits), header).toEqual({
				text: `${header}export const kept = moved();\n\n${BODY}`,
			});
		}
	});

	it("spells a new relative specifier as the module's relative imports do, else as the moved body's", () => {
		const helper = (specifier: string): MoveDependency => ({
			name: "helper",
			origin: {
				kind: "workspaceModule",
				symbolId: "lexicon typescript lib.ts helper.",
				module: "lib.ts",
				via: { specifier, importKind: "named", importedName: "helper", localName: "helper" },
			},
		});
		const files = { "a.ts": "export const a = 1;\n", "lib.ts": "export const helper = 1;\n" };
		const cases = [
			// A data file's extension says nothing about the style.
			{
				target: 'import data from "./data.json";\nimport { a } from "./a.js";\n',
				dependencies: [sibling("sibling")],
				expected:
					'import data from "./data.json";\nimport { a } from "./a.js";\nimport { sibling } from "./source.js";',
			},
			{
				target: 'import { a } from "./a";\n',
				dependencies: [helper("./lib.js")],
				expected: 'import { a } from "./a";\nimport { helper } from "./lib";',
			},
			{
				target: "",
				dependencies: [sibling("sibling"), helper("./lib.js")],
				expected: 'import { sibling } from "./source.js";\nimport { helper } from "./lib.js";',
			},
		];
		for (const { target, dependencies, expected } of cases) {
			const result = importInto(target, dependencies, { ...files, "data.json": "{}" });
			expect(result.blocked, target).toEqual([]);
			expect(result.applied, target).toEqual({ text: `${expected}\n\n${BODY}` });
		}

		// With none to copy, the project's resolution decides.
		for (const [module, expected] of [
			["nodenext", "./source.js"],
			["esnext", "./source"],
		] as const) {
			const tsconfig = JSON.stringify({ compilerOptions: { module } });
			const result = importInto("", [sibling("sibling")], { "tsconfig.json": tsconfig });
			expect(result.applied, module).toEqual({ text: `import { sibling } from "${expected}";\n\n${BODY}` });
		}
	});

	it("gives every name from one module one statement, leaving an existing one as written", () => {
		const cases = [
			{
				target: "import { existing } from './source';\n",
				expected: `import { existing, sibling, other } from './source';\n\n${BODY}`,
			},
			{
				target: "import def, {\n\texisting,\n} from './source';\n",
				expected: `import def, {\n\texisting, sibling, other,\n} from './source';\n\n${BODY}`,
			},
			// Attributes can change which export binds, so a statement carrying them takes no names.
			...[
				'import { existing } from \'./source\' with { "resolution-mode": "require" };\n',
				"import { existing } from './source' assert { type: 'json' };\n",
			].map((target) => ({
				target,
				expected: `${target}import { sibling, other } from './source';\n\n${BODY}`,
			})),
			{
				target: "import {} from './source';\n",
				expected: `import { sibling, other } from './source';\n\n${BODY}`,
			},
			{
				target: "import { /* keep */ } from './source';\n",
				expected: `import { sibling, other /* keep */ } from './source';\n\n${BODY}`,
			},
			{
				target: "import lib from './source';\n",
				expected: `import lib, { sibling, other } from './source';\n\n${BODY}`,
			},
			{ target: "", expected: `import { sibling, other } from "./source";\n\n${BODY}` },
			{
				target: "import type { Shape } from './source';\n",
				expected: `import { type Shape, sibling, other } from './source';\n\n${BODY}`,
			},
		];

		for (const { target, expected } of cases) {
			const result = importInto(target, [sibling("sibling"), sibling("other")]);
			expect(result.blocked).toEqual([]);
			expect(result.applied).toEqual({ text: expected });
		}
	});

	it("keeps an export name that is no identifier a string", () => {
		const named = (importedName: string): MoveDependency => ({
			name: "local",
			origin: {
				kind: "external",
				via: { specifier: "pkg", importKind: "named", importedName, localName: "local" },
			},
		});

		expect(importInto("", [named("a-b")]).applied).toEqual({
			text: `import { "a-b" as local } from "pkg";\n\n${BODY}`,
		});
		expect(importInto("import { existing } from 'pkg';\n", [named("it's")]).applied).toEqual({
			text: `import { existing, 'it\\'s' as local } from 'pkg';\n\n${BODY}`,
		});
	});

	it("reuses a binding the target already has, and blocks a name bound to something else", () => {
		const reused = [
			{ target: "import { sibling } from './source.js';\n", dependency: sibling("sibling") },
			{
				target: "export const helper = 1;\n",
				dependency: {
					name: "helper",
					origin: { kind: "workspaceModule", symbolId: "target.helper.", module: "target.ts" },
				} as const,
			},
		];
		for (const { target, dependency } of reused) {
			expect(importInto(target, [dependency])).toEqual({ blocked: [], applied: { text: `${target}\n${BODY}` } });
		}
		const scoped = "function load() {\n\tvar sibling = 1;\n}\n";
		expect(importInto(scoped, [sibling("sibling")])).toEqual({
			blocked: [],
			applied: { text: `import { sibling } from "./source";\n\n${scoped}\n${BODY}` },
		});

		for (const target of [
			"import { other as sibling } from './other';\n",
			"import type { sibling } from './source';\n",
			"const sibling = 2;\n",
			// A `var` in a top-level block binds module scope; one in a function does not.
			"if (ready) {\n\tfor (var sibling of list) use(sibling);\n}\n",
		]) {
			const result = importInto(target, [sibling("sibling")], { "other.ts": "export const other = 1;\n" });
			expect(result.blocked).toMatchObject([{ reason: "TargetCollision" }]);
			expect(result.applied).toEqual({ text: `${target}\n${BODY}` });
		}
	});

	it("plans many dependencies into a module of many imports with work linear in their count", () => {
		const work = (count: number) => {
			const target = Array.from(
				{ length: count },
				(_, index) => `import { a${index} } from './m${index}';\n`,
			).join("");
			const meter: WorkMeter = { steps: 0 };
			const source = ts.createSourceFile("target.ts", target, ts.ScriptTarget.ESNext, true);
			const request: MoveEditsRequest = {
				module: "target.ts",
				text: target,
				exists: true,
				symbolId: "lexicon typescript source.ts moved.",
				name: "moved",
				fromModule: "source.ts",
				toModule: "target.ts",
				role: { insertion: { text: BODY } },
				importSites: [],
				dependencies: Array.from({ length: count }, (_, index) => sibling(`s${index}`)),
				sites: [],
			};
			expect(
				makeMoveEdits(
					request,
					source,
					undefined,
					() => ({ specifier: "./source" }),
					() => "source.ts",
					false,
					meter,
				),
			).toMatchObject({ status: "ready", blocked: [] });
			return meter.steps;
		};
		// Each dependency uses one shared index of the target imports.
		const small = work(1_000);
		const large = work(8_000);
		expect(large / small).toBeLessThan(12);
	}, 30_000);

	it("plans type-only names beside many value imports, many repointed sites, and many aliases, in near-linear work", () => {
		const shapes = {
			typeOnly: (count: number) => {
				const text = Array.from({ length: count }, (_, index) => `import { v${index} } from './lib';\n`).join(
					"",
				);
				const dependencies = Array.from({ length: count }, (_, index): MoveDependency => {
					const name = `t${index}`;
					return {
						name,
						origin: {
							kind: "workspaceModule",
							symbolId: `lib.${name}.`,
							module: "lib.ts",
							via: { specifier: "./lib", importKind: "named", importedName: name, typeOnly: true },
						},
					};
				});
				return { text, dependencies, importSites: [] };
			},
			sites: (count: number) => {
				const lines = Array.from(
					{ length: count },
					(_, index) => `import { moved as m${index}, s${index} } from './source';\n`,
				);
				const text = lines.join("");
				const coordinates = coordinatesOf(text);
				let at = "import { ".length;
				const importSites = lines.map((line, index): MoveImportSite => {
					const range = coordinates.rangeAt(at, at + "moved".length);
					if (range === undefined) throw new Error("invalid test range");
					at += line.length;
					return {
						range,
						specifier: "./source",
						importKind: "named",
						importedName: "moved",
						localName: `m${index}`,
					};
				});
				return { text, dependencies: [], importSites };
			},
			aliases: (count: number) => {
				const elements = Array.from({ length: count }, (_, index) => `moved as m${index}`);
				const text = `import { ${elements.join(", ")}, stay } from './source';\n`;
				const coordinates = coordinatesOf(text);
				let at = "import { ".length;
				const importSites = elements.map((element, index): MoveImportSite => {
					const range = coordinates.rangeAt(at, at + "moved".length);
					if (range === undefined) throw new Error("invalid test range");
					at += element.length + ", ".length;
					return {
						range,
						specifier: "./source",
						importKind: "named",
						importedName: "moved",
						localName: `m${index}`,
					};
				});
				return { text, dependencies: [], importSites };
			},
		};
		const count = 4_000;
		for (const [shape, build] of Object.entries(shapes)) {
			const { text, dependencies, importSites } = build(count);
			const meter: WorkMeter = { steps: 0 };
			const response = makeMoveEdits(
				{
					module: "target.ts",
					text,
					exists: true,
					symbolId: "lexicon typescript source.ts moved.",
					name: "moved",
					fromModule: "source.ts",
					toModule: shape === "typeOnly" ? "target.ts" : "new.ts",
					role: {},
					importSites,
					dependencies,
					sites: [],
				},
				ts.createSourceFile("target.ts", text, ts.ScriptTarget.ESNext, true),
				undefined,
				(_fromModule, targetModule) => ({ specifier: `./${targetModule.replace(/\.ts$/, "")}` }),
				(_fromModule, specifier) => `${specifier.replace(/^\.\//, "")}.ts`,
				false,
				meter,
			);
			expect(response, shape).toMatchObject({ status: "ready", blocked: [] });
			// A search per name. A scan of every statement, candidate or binding per name reads count squared.
			expect(meter.steps, shape).toBeLessThanOrEqual(2 * count * Math.log2(count));
		}
	});

	it("keeps `import x = require()` as its own form, which JavaScript and ECMAScript modules cannot write", () => {
		const lib: MoveDependency = {
			name: "lib",
			origin: {
				kind: "external",
				via: { specifier: "pkg", importKind: "require", localName: "lib" },
			},
		};
		expect(importInto("", [lib]).applied).toEqual({ text: `import lib = require("pkg");\n\n${BODY}` });
		const existing = "import lib = require('pkg');\n";
		expect(importInto(existing, [lib])).toEqual({ blocked: [], applied: { text: `${existing}\n${BODY}` } });

		const nodeNext = {
			"tsconfig.json": JSON.stringify({ compilerOptions: { module: "nodenext" } }),
			"package.json": JSON.stringify({ type: "module" }),
		};
		const configured = (module: string) => ({ "tsconfig.json": JSON.stringify({ compilerOptions: { module } }) });
		const targets = [
			{ module: "target.js", files: {}, writes: false },
			{ module: "target.mts", files: {}, writes: false },
			{ module: "target.ts", files: nodeNext, writes: false },
			{ module: "target.cts", files: nodeNext, writes: true },
			{ module: "target.ts", files: configured("esnext"), writes: false },
			{ module: "target.ts", files: configured("es2020"), writes: false },
			{ module: "target.ts", files: configured("commonjs"), writes: true },
			// Nothing compiles an unconfigured repo as ESNext; the fallback only guesses.
			{ module: "target.ts", files: {}, writes: true },
		];
		for (const { module, files, writes } of targets) {
			const response = move(workspace({ [module]: "", "source.cts": "", ...files }), {
				module,
				text: "",
				exists: true,
				symbolId: "lexicon typescript source.cts moved.",
				name: "moved",
				fromModule: "source.cts",
				toModule: module,
				role: { insertion: { text: BODY } },
				importSites: [],
				dependencies: [lib],
				sites: [],
			});
			expect(response, `${module} ${JSON.stringify(files)}`).toMatchObject({
				status: "ready",
				blocked: writes ? [] : [{ reason: "NotImplemented" }],
			});
		}
	});

	it("blocks moving one name out of a declaration that binds others, and moves a lone one", () => {
		const cases = [
			{ statement: "export const { alpha, beta } = source;", blocked: true },
			{ statement: "export const alpha = 1, beta = 2;", blocked: true },
			{ statement: "export const { alpha } = source;", blocked: false },
		];

		for (const { statement, blocked } of cases) {
			const text = `import { source } from "./data";\n${statement}\nexport const kept = 1;\n`;
			const response = move(workspace({ "source.ts": text, "data.ts": "export const source = {};\n" }), {
				module: "source.ts",
				text,
				exists: true,
				symbolId: "lexicon typescript source.ts alpha.",
				name: "alpha",
				fromModule: "source.ts",
				toModule: "target.ts",
				role: { removal: rangeForText(text, `${statement}\n`) },
				importSites: [],
				dependencies: [],
				sites: [],
			});

			if (response.status !== "ready") throw new Error("move was refused");
			if (blocked) {
				expect(response.edits).toEqual([]);
				expect(response.blocked).toMatchObject([{ reason: "NotImplemented" }]);
			} else {
				expect(response.blocked).toEqual([]);
				expect(applyEdits(text, response.edits)).toEqual({ text: "export const kept = 1;\n" });
			}
		}
	});

	// A byte order mark is whitespace to the scanner, so nothing precedes the first statement.
	it("puts a module's first import after a byte order mark and above a comment on the first line", () => {
		const bom = String.fromCharCode(0xfeff);
		const body = "export function moved() { return sibling; }\n";
		const cases = [
			{
				target: `${bom}export const kept = 1;\n`,
				expected: `${bom}import { sibling } from "./source";\n\nexport const kept = 1;\n\n${body}`,
			},
			{
				target: "/* lead */ export const kept = 1;\n",
				expected: `import { sibling } from "./source";\n\n/* lead */ export const kept = 1;\n\n${body}`,
			},
		];

		for (const { target, expected } of cases) {
			const response = move(workspace({ "source.ts": "export const sibling = 1;\n", "target.ts": target }), {
				module: "target.ts",
				text: target,
				exists: true,
				symbolId: "lexicon typescript source.ts moved.",
				name: "moved",
				fromModule: "source.ts",
				toModule: "target.ts",
				role: { insertion: { text: body } },
				importSites: [],
				dependencies: [
					{
						name: "sibling",
						origin: { kind: "sourceModule", symbolId: "source.sibling.", name: "sibling", exported: true },
					},
				],
				sites: [],
			});

			if (response.status !== "ready") throw new Error("move was refused");
			expect(response.blocked).toEqual([]);
			expect(applyEdits(target, response.edits)).toEqual({ text: expected });
		}
	});

	it("adds a new import below the leading imports and directives, never under a statement's comment", () => {
		const cases = [
			{
				target: 'import { a } from "./a";\n\n// Fixtures\nconst kept = a;\n',
				expected: `import { a } from "./a";\nimport { sibling } from "./source";\n\n// Fixtures\nconst kept = a;\n\n${BODY}`,
			},
			{
				target: 'import { a } from "./a"; // why\nconst kept = a;\n',
				expected: `import { a } from "./a"; // why\nimport { sibling } from "./source";\nconst kept = a;\n\n${BODY}`,
			},
			{
				target: '"use client";\n\nconst kept = 1;\n',
				expected: `"use client";\nimport { sibling } from "./source";\n\nconst kept = 1;\n\n${BODY}`,
			},
			{
				target: 'import { a } from "./a";',
				expected: `import { a } from "./a";\nimport { sibling } from "./source";\n\n${BODY}`,
			},
			// A local re-export belongs to the file's body, under its banner, not to the imports.
			{
				target: 'import type { a } from "./a";\n\n////\n//  Types\n\nexport type { a };\n',
				expected: `import type { a } from "./a";\nimport { sibling } from "./source";\n\n////\n//  Types\n\nexport type { a };\n\n${BODY}`,
			},
			// Without imports: past the file's header, above the banner and the doc its declaration owns.
			{
				target: "// Header.\n\n////\n//  Types\n\n/** Doc. */\nconst kept = 1;\n",
				expected: `// Header.\n\nimport { sibling } from "./source";\n\n////\n//  Types\n\n/** Doc. */\nconst kept = 1;\n\n${BODY}`,
			},
			{
				target: "/** Doc. */\nconst kept = 1;\n",
				expected: `import { sibling } from "./source";\n\n/** Doc. */\nconst kept = 1;\n\n${BODY}`,
			},
		];

		for (const { target, expected } of cases) {
			const result = importInto(target, [sibling("sibling")], { "a.ts": "export const a = 1;\n" });
			expect(result.blocked).toEqual([]);
			expect(result.applied).toEqual({ text: expected });
		}
	});

	it("drops the imports only the moved text named, keeping shared ones and ones unused before", () => {
		const text = [
			'import d, { a, b } from "./m";',
			'import { c } from "./n";',
			'import { unused } from "./o";',
			"",
			"export function moved() { return a + c + d; }",
			"export const kept = b;",
			"",
		].join("\n");
		const response = move(workspace({ "source.ts": text }), {
			module: "source.ts",
			text,
			exists: true,
			symbolId: "lexicon typescript source.ts moved().",
			name: "moved",
			fromModule: "source.ts",
			toModule: "target.ts",
			role: { removal: rangeForText(text, "export function moved() { return a + c + d; }\n") },
			importSites: [],
			dependencies: [],
			sites: [],
		});

		if (response.status !== "ready") throw new Error("move was refused");
		expect(response.blocked).toEqual([]);
		expect(applyEdits(text, response.edits)).toEqual({
			text: 'import { b } from "./m";\nimport { unused } from "./o";\n\nexport const kept = b;\n',
		});
	});

	it("repoints the source's own exports of the moved name, or blocks where its new home may not export it", () => {
		const foo = "export function foo() { return 1; }\n";
		const cases: {
			name?: string;
			moved: string;
			kept: string;
			back?: boolean;
			expected?: string;
			site?: string;
		}[] = [
			{ moved: foo, kept: "export { foo as bar };\n", expected: 'export { foo as bar } from "./target";\n' },
			{
				moved: foo,
				kept: "const a = 1;\nexport { a, foo as bar, foo as baz };\n",
				expected: 'const a = 1;\nexport { a };\nexport { foo as bar, foo as baz } from "./target";\n',
			},
			{
				name: "Shape",
				moved: "export interface Shape { size: number }\n",
				kept: "export function area(shape: Shape) { return shape.size; }\nexport { Shape as Form };\n",
				back: true,
				expected: [
					'import type { Shape } from "./target";',
					"",
					"export function area(shape: Shape) { return shape.size; }",
					'export type { Shape as Form } from "./target";',
					"",
				].join("\n"),
			},
			// The core imports what a default export names back.
			{
				moved: foo,
				kept: "export default foo;\n",
				back: true,
				expected: 'import { foo } from "./target";\n\nexport default foo;\n',
			},
			// The target may land it unexported.
			{ moved: "function foo() { return 1; }\n", kept: "export { foo };\n", site: "foo" },
			{
				moved: foo,
				kept: "export namespace foo { export const x = 1; }\nexport { foo as bar };\n",
				site: "foo as bar",
			},
		];

		for (const { name = "foo", moved, kept, back = false, expected, site } of cases) {
			const text = `${moved}\n${kept}`;
			const response = move(workspace({ "source.ts": text, "target.ts": "" }), {
				module: "source.ts",
				text,
				exists: true,
				symbolId: `lexicon typescript source.ts ${name}.`,
				name,
				fromModule: "source.ts",
				toModule: "target.ts",
				role: { removal: rangeForText(text, `${moved}\n`) },
				importSites: [],
				dependencies: back
					? [
							{
								name,
								origin: {
									kind: "workspaceModule",
									symbolId: `lexicon typescript target.ts ${name}.`,
									module: "target.ts",
								},
							},
						]
					: [],
				sites: [],
			});

			if (response.status !== "ready") throw new Error("move was refused");
			if (site !== undefined) {
				expect(response.blocked, kept).toMatchObject([
					{ reason: "NotImplemented", range: rangeForText(text, site, text.lastIndexOf("export {")) },
				]);
			} else {
				expect(response.blocked, kept).toEqual([]);
				expect(applyEdits(text, response.edits), kept).toEqual({ text: expected as string });
			}
		}
	});

	it("exports what it inserts when asked, after decorators and before other modifiers", () => {
		const cases = [
			{ text: "const moved = 1;\n", expected: "export const moved = 1;\n" },
			{ text: "/** Doc. */\nfunction moved() {}\n", expected: "/** Doc. */\nexport function moved() {}\n" },
			{ text: "@sealed\nclass Moved {}\n", expected: "@sealed\nexport class Moved {}\n" },
			{ text: "declare const moved: number;\n", expected: "export declare const moved: number;\n" },
			{
				text: "function moved(a: string): void;\nfunction moved(a: unknown) {}\n",
				expected: "export function moved(a: string): void;\nexport function moved(a: unknown) {}\n",
			},
			{ text: "export const moved = 1;\n", expected: "export const moved = 1;\n" },
		];

		for (const { text, expected } of cases) {
			const response = move(workspace({ "target.ts": "" }), {
				module: "target.ts",
				text: "",
				exists: false,
				symbolId: "lexicon typescript source.ts moved.",
				name: "moved",
				fromModule: "source.ts",
				toModule: "target.ts",
				role: { insertion: { text, exported: true } },
				importSites: [],
				dependencies: [],
				sites: [],
			});

			if (response.status !== "ready") throw new Error("move was refused");
			expect(applyEdits("", response.edits)).toEqual({ text: expected });
		}
	});

	it("appends below the target's last content with one blank line between", () => {
		const body = "export const moved = 1;\n";
		const cases = [
			{ target: "export const kept = 1;\n", expected: `export const kept = 1;\n\n${body}` },
			{ target: "export const kept = 1;\r\n\r\n", expected: `export const kept = 1;\r\n\r\n${body}` },
			{ target: "export const kept = 1;\n\t\n", expected: `export const kept = 1;\n\t\n${body}` },
			{ target: "// only a comment", expected: `// only a comment\n${body}` },
		];

		for (const { target, expected } of cases) {
			const response = move(workspace({ "target.ts": target }), {
				module: "target.ts",
				text: target,
				exists: true,
				symbolId: "lexicon typescript source.ts moved.",
				name: "moved",
				fromModule: "source.ts",
				toModule: "target.ts",
				role: { insertion: { text: body } },
				importSites: [],
				dependencies: [],
				sites: [],
			});

			if (response.status !== "ready") throw new Error("move was refused");
			expect(applyEdits(target, response.edits)).toEqual({ text: expected });
		}
	});

	it("blocks a private sibling with PrivateSibling", () => {
		const response = move(workspace({ "target.ts": "" }), {
			module: "target.ts",
			text: "",
			exists: true,
			symbolId: "lexicon typescript source.ts moved.",
			name: "moved",
			fromModule: "source.ts",
			toModule: "target.ts",
			role: { insertion: { text: "export function moved() { return sibling; }\n" } },
			importSites: [],
			dependencies: [
				{
					name: "sibling",
					origin: { kind: "sourceModule", symbolId: "source.sibling.", name: "sibling", exported: false },
				},
			],
			sites: [],
		});

		if (response.status !== "ready") throw new Error("move was refused");
		expect(response.edits).toEqual([
			{
				range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
				newText: expect.any(String),
			},
		]);
		expect(response.blocked).toMatchObject([{ reason: "PrivateSibling" }]);
	});

	it("preserves an external package specifier verbatim", () => {
		const body = "export const moved = parse(value);\n";
		const response = move(workspace({ "target.ts": "" }), {
			module: "target.ts",
			text: "",
			exists: true,
			symbolId: "lexicon typescript source.ts moved.",
			name: "moved",
			fromModule: "source.ts",
			toModule: "target.ts",
			role: { insertion: { text: body } },
			importSites: [],
			dependencies: [
				{
					name: "parse",
					origin: {
						kind: "external",
						via: {
							specifier: "@scope/parser/subpath",
							importKind: "named",
							importedName: "parse",
							localName: "parse",
						},
					},
				},
			],
			sites: [],
		});

		if (response.status !== "ready") throw new Error("move was refused");
		expect(applyEdits("", response.edits)).toEqual({
			text: `import { parse } from "@scope/parser/subpath";\n\n${body}`,
		});
	});

	it("recomputes a relative specifier from the importing directory", () => {
		const text = 'import { moved } from "../old";\nmoved();\n';
		const importText = 'import { moved } from "../old";';
		const response = move(
			workspace({
				"src/feature/use.ts": text,
				"src/old.ts": "export function moved() {}\n",
				"src/new/location/moved.ts": "export function moved() {}\n",
			}),
			{
				module: "src/feature/use.ts",
				text,
				exists: true,
				symbolId: "lexicon typescript src/old.ts moved.",
				name: "moved",
				fromModule: "src/old.ts",
				toModule: "src/new/location/moved.ts",
				role: {},
				importSites: [
					{
						range: rangeForText(text, importText),
						specifier: "../old",
						importKind: "named",
						importedName: "moved",
						localName: "moved",
					},
				],
				dependencies: [],
				sites: [],
			},
		);

		if (response.status !== "ready") throw new Error("move was refused");
		expect(response.edits[0]).toMatchObject({ newText: 'import { moved } from "../new/location/moved";' });
	});

	it("uses a configured path alias when the existing import chose it", () => {
		const text = 'import { moved } from "@/old";\nmoved();\n';
		const importText = 'import { moved } from "@/old";';
		const response = move(
			workspace({
				"tsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } } }),
				"src/use.ts": text,
				"src/old.ts": "export function moved() {}\n",
				"src/new.ts": "export function moved() {}\n",
			}),
			{
				module: "src/use.ts",
				text,
				exists: true,
				symbolId: "lexicon typescript src/old.ts moved.",
				name: "moved",
				fromModule: "src/old.ts",
				toModule: "src/new.ts",
				role: {},
				importSites: [
					{
						range: rangeForText(text, importText),
						specifier: "@/old",
						importKind: "named",
						importedName: "moved",
						localName: "moved",
					},
				],
				dependencies: [],
				sites: [],
			},
		);

		if (response.status !== "ready") throw new Error("move was refused");
		expect(response.edits[0]).toMatchObject({ newText: 'import { moved } from "@/new";' });
	});

	it("keeps a linked workspace package's specifier for a dependency it still reaches", () => {
		const body = "export const moved = findRefs(text);\n";
		const root = workspace({
			"packages/proto/package.json": JSON.stringify({
				name: "@acme/proto",
				exports: { "./refs": "./src/refs.ts" },
			}),
			"packages/proto/src/refs.ts": "export function findRefs(text: string) { return text; }\n",
			"app/src/source.ts": "",
			"app/src/editor/target.ts": "",
		});
		mkdirSync(path.join(root, "node_modules/@acme"), { recursive: true });
		symlinkSync(path.join(root, "packages/proto"), path.join(root, "node_modules/@acme/proto"), "dir");
		const response = move(root, {
			module: "app/src/editor/target.ts",
			text: "",
			exists: true,
			symbolId: "lexicon typescript app/src/source.ts moved.",
			name: "moved",
			fromModule: "app/src/source.ts",
			toModule: "app/src/editor/target.ts",
			role: { insertion: { text: body } },
			importSites: [],
			dependencies: [
				{
					name: "findRefs",
					origin: {
						kind: "workspaceModule",
						symbolId: "lexicon typescript packages/proto/src/refs.ts findRefs().",
						module: "packages/proto/src/refs.ts",
						via: {
							specifier: "@acme/proto/refs",
							importKind: "named",
							importedName: "findRefs",
							localName: "findRefs",
						},
					},
				},
			],
			sites: [],
		});

		if (response.status !== "ready") throw new Error("move was refused");
		expect(applyEdits("", response.edits)).toEqual({
			text: `import { findRefs } from "@acme/proto/refs";\n\n${body}`,
		});
	});

	it("answers normally for a target file that does not exist yet", () => {
		const insertion = "export const moved = 1;\n";
		const response = move(workspace({}), {
			module: "new/target.ts",
			text: "",
			exists: false,
			symbolId: "lexicon typescript source.ts moved.",
			name: "moved",
			fromModule: "source.ts",
			toModule: "new/target.ts",
			role: { insertion: { text: insertion } },
			importSites: [],
			dependencies: [],
			sites: [],
		});

		expect(response).toEqual({
			status: "ready",
			edits: [
				{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: insertion },
			],
			blocked: [],
		});
	});

	it("refuses a target declaration collision, `export =` included", () => {
		const cases = [
			{ text: "export const moved = 1;\n", name: "moved" },
			{ text: "export = 1;\n", name: "export=" },
		];
		for (const { text, name } of cases) {
			const response = move(workspace({ "target.ts": text }), {
				module: "target.ts",
				text,
				exists: true,
				symbolId: `lexicon typescript source.ts ${name}.`,
				name,
				fromModule: "source.ts",
				toModule: "target.ts",
				role: {},
				importSites: [],
				dependencies: [],
				sites: [],
			});

			expect(response, name).toMatchObject({ status: "refused", reason: "TargetCollision" });
		}
	});

	it("reorders within one module, keeping every import and the framed insertion as written", () => {
		const text = [
			'import d, { a, b } from "./m";',
			'import { c } from "./n";',
			"",
			"export const kept = b;",
			"",
			"export function moved() { return a + c + d; }",
			"",
		].join("\n");
		const response = move(workspace({ "source.ts": text }), {
			module: "source.ts",
			text,
			exists: true,
			symbolId: "lexicon typescript source.ts moved().",
			name: "moved",
			fromModule: "source.ts",
			toModule: "source.ts",
			role: {
				removal: { start: { line: 4, character: 0 }, end: { line: 6, character: 0 } },
				insertion: {
					text: "export function moved() { return a + c + d; }\n\n",
					position: { line: 3, character: 0 },
				},
			},
			importSites: [],
			dependencies: [],
			sites: [],
		});

		if (response.status !== "ready") throw new Error(`move was refused: ${JSON.stringify(response)}`);
		expect(response.blocked).toEqual([]);
		expect(applyEdits(text, response.edits)).toEqual({
			text: 'import d, { a, b } from "./m";\nimport { c } from "./n";\n\nexport function moved() { return a + c + d; }\n\nexport const kept = b;\n',
		});
	});

	// Moving a symbol back where a move left an import of it: the undo of that move.
	it("takes the target's own import of the moved symbol out instead of refusing it as a collision", () => {
		const cases = [
			{
				text: 'import { moved } from "./source";\n\nexport const kept = moved();\n',
				expected: `export const kept = moved();\n\n${BODY}`,
			},
			{
				text: 'import { moved, other } from "./source";\n\nexport const kept = moved() + other;\n',
				expected: `import { other } from "./source";\n\nexport const kept = moved() + other;\n\n${BODY}`,
			},
		];
		for (const { text, expected } of cases) {
			const response = move(workspace({ "target.ts": text, "source.ts": `${BODY}export const other = 2;\n` }), {
				module: "target.ts",
				text,
				exists: true,
				symbolId: "lexicon typescript source.ts moved().",
				name: "moved",
				fromModule: "source.ts",
				toModule: "target.ts",
				role: { insertion: { text: BODY } },
				importSites: [
					{
						range: rangeForText(text, "moved"),
						specifier: "./source",
						importKind: "named",
						importedName: "moved",
					},
				],
				dependencies: [],
				sites: [],
			});

			if (response.status !== "ready") throw new Error(`move was refused: ${JSON.stringify(response)}`);
			expect(response.blocked).toEqual([]);
			expect(applyEdits(text, response.edits)).toEqual({ text: expected });
		}
	});

	it("refuses a target path outside the workspace", () => {
		const response = move(workspace({ "source.ts": "export const moved = 1;\n" }), {
			module: "source.ts",
			text: "export const moved = 1;\n",
			exists: true,
			symbolId: "lexicon typescript source.ts moved.",
			name: "moved",
			fromModule: "source.ts",
			toModule: "../target.ts",
			role: { removal: rangeForText("export const moved = 1;\n", "export const moved = 1;") },
			importSites: [],
			dependencies: [],
			sites: [],
		});

		expect(response).toMatchObject({ status: "refused", reason: "InvalidTarget" });
	});

	it("exports requested private declarations in place and acknowledges only supported declarations", () => {
		const source =
			"function helper() { return 1; }\nconst VALUE = 2;\nconst { hidden } = { hidden: 3 };\nexport function moved() { return helper() + VALUE; }\n";
		const root = workspace({ "source.ts": source, "target.ts": "" });
		const helper = composeSymbolId({
			language: "typescript",
			module: "source.ts",
			descriptors: [{ kind: "term", name: "helper" }],
		});
		const value = composeSymbolId({
			language: "typescript",
			module: "source.ts",
			descriptors: [{ kind: "term", name: "VALUE" }],
		});
		const hidden = composeSymbolId({
			language: "typescript",
			module: "source.ts",
			descriptors: [{ kind: "term", name: "hidden" }],
		});
		const response = move(root, {
			module: "source.ts",
			text: source,
			exists: true,
			symbolId: "lexicon typescript source.ts moved.",
			name: "moved",
			fromModule: "source.ts",
			toModule: "target.ts",
			role: { removal: rangeForText(source, "export function moved() { return helper() + VALUE; }") },
			importSites: [],
			dependencies: [],
			sites: [],
			exportInPlace: [helper, value, hidden],
		});
		if (response.status !== "ready") throw new Error("move was refused");
		expect(response.exportedInPlace).toEqual([helper, value]);
		const sourceResult = applyEdits(source, response.edits);
		if ("problem" in sourceResult) throw new Error(sourceResult.problem);
		expect(sourceResult.text).toContain("export function helper() { return 1; }\nexport const VALUE = 2;");
		const target = move(root, {
			module: "target.ts",
			text: "",
			exists: true,
			symbolId: "lexicon typescript source.ts moved.",
			name: "moved",
			fromModule: "source.ts",
			toModule: "target.ts",
			role: { insertion: { text: "export function moved() { return helper() + VALUE; }\n" } },
			importSites: [],
			sites: [],
			dependencies: [
				{
					name: "helper",
					origin: { kind: "sourceModule", symbolId: helper, name: "helper", exported: false, promoted: true },
				},
				{
					name: "VALUE",
					origin: { kind: "sourceModule", symbolId: value, name: "VALUE", exported: false, promoted: true },
				},
			],
		});
		if (target.status !== "ready") throw new Error("target move was refused");
		const targetResult = applyEdits("", target.edits);
		if ("problem" in targetResult) throw new Error(targetResult.problem);
		expect(targetResult.text).toContain('import { helper, VALUE } from "./source";');
	});

	it("exports every overload and merged interface declaration together", () => {
		const cases = [
			{
				name: "overloaded",
				descriptor: { kind: "method" as const, name: "overloaded" },
				text: "function overloaded(value: string): string;\nfunction overloaded(value: number): string;\nfunction overloaded(value: string | number) { return String(value); }\nexport function moved() { return overloaded(1); }\n",
				prefix: "export function overloaded",
				count: 3,
			},
			{
				name: "Options",
				descriptor: { kind: "type" as const, name: "Options" },
				text: "interface Options { a: string; }\ninterface Options { b: number; }\nexport function moved(value: Options) { return value.a; }\n",
				prefix: "export interface Options",
				count: 2,
			},
		];
		for (const item of cases) {
			const symbolId = composeSymbolId({
				language: "typescript",
				module: "source.ts",
				descriptors: [item.descriptor],
			});
			const response = move(workspace({ "source.ts": item.text, "target.ts": "" }), {
				module: "source.ts",
				text: item.text,
				exists: true,
				symbolId: "lexicon typescript source.ts moved.",
				name: "moved",
				fromModule: "source.ts",
				toModule: "target.ts",
				role: {
					removal: rangeForText(
						item.text,
						item.text.slice(item.text.lastIndexOf("export function moved"), item.text.trimEnd().length),
					),
				},
				importSites: [],
				dependencies: [],
				sites: [],
				exportInPlace: [symbolId],
			});
			if (response.status !== "ready") throw new Error("move was refused");
			expect(response.exportedInPlace).toEqual([symbolId]);
			const applied = applyEdits(item.text, response.edits);
			if ("problem" in applied) throw new Error(applied.problem);
			expect(applied.text.match(new RegExp(item.prefix, "g"))).toHaveLength(item.count);
		}
	});
});
