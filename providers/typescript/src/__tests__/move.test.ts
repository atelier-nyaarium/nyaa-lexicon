import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	applyEdits,
	coordinatesOf,
	type MoveDependency,
	type MoveEditsRequest,
	type MoveImportSite,
	type Range,
} from "@nyaa-lexicon/protocol";
import ts from "typescript";
import { importOf } from "../imports.js";
import { makeMoveEdits } from "../move.js";
import type { WorkMeter } from "../move-imports.js";
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

/** Moves BODY into `target`, which must reach `dependencies`. */
function importInto(target: string, dependencies: MoveDependency[], files: Record<string, string> = {}) {
	const response = move(workspace({ "target.ts": target, "source.ts": "", ...files }), {
		module: "target.ts",
		text: target,
		exists: true,
		symbolId: "lexicon typescript source.ts moved.",
		name: "moved",
		fromModule: "source.ts",
		toModule: "target.ts",
		role: { insertion: { text: BODY } },
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
					reExport: false,
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
						reExport: true,
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
							reExport: false,
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
						reExport: false,
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
		const named = { importKind: "named", importedName: "moved", reExport: false } as const;
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
				site: { importKind: "default", localName: "moved", reExport: false },
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
				site: { ...named, reExport: true },
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
			text: `import { sibling } from "./source";\n${body}`,
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
	it("keeps default, namespace and type-only forms in their own statement", () => {
		const target = 'import { existing } from "pkg";\n';
		const body = "export function moved() { return local; }\n";
		const cases = [
			'import local from "pkg";',
			'import * as local from "pkg";',
			'import type local from "pkg";',
			'import type { Remote as local } from "pkg";',
			'import type * as local from "pkg";',
			'import local = require("pkg");',
			'import type local = require("pkg");',
		];

		for (const statement of cases) {
			const written = ts.createSourceFile("source.ts", statement, ts.ScriptTarget.ESNext, true).statements[0];
			if (written === undefined || !(ts.isImportDeclaration(written) || ts.isImportEqualsDeclaration(written))) {
				throw new Error("missing test import");
			}
			const entry = importOf(written, written.getSourceFile())?.imported[0];
			const via = {
				importKind: entry?.kind ?? (entry?.name === undefined ? "namespace" : "named"),
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
			expect(response.blocked).toEqual([]);
			expect(applyEdits(target, response.edits)).toEqual({ text: `${target}${statement}\n\n\n${body}` });
		}
	});

	it("keeps its own statement when the existing import is type-only", () => {
		const target = 'import type { Shape } from "./source";\n';
		const body = "export function moved() { return sibling; }\n";
		const response = move(
			workspace({ "source.ts": "export const sibling = 1;\nexport type Shape = string;\n", "target.ts": target }),
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
					{
						name: "sibling",
						origin: { kind: "sourceModule", symbolId: "source.sibling.", name: "sibling", exported: true },
					},
				],
				sites: [],
			},
		);

		if (response.status !== "ready") throw new Error("move was refused");
		expect(applyEdits(target, response.edits)).toEqual({
			text: `import type { Shape } from "./source";\nimport { sibling } from "./source";\n\n\n${body}`,
		});
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
				expected: `${target}import { sibling, other } from './source';\n\n\n${BODY}`,
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
			{ target: "", expected: `import { sibling, other } from "./source";\n${BODY}` },
			{
				target: "import type { Shape } from './source';\n",
				expected: `import type { Shape } from './source';\nimport { sibling, other } from './source';\n\n\n${BODY}`,
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
			text: `import { "a-b" as local } from "pkg";\n${BODY}`,
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
			applied: { text: `import { sibling } from "./source";\n${scoped}\n${BODY}` },
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

	it("plans many dependencies into a module of many imports in time linear in their count", () => {
		const timed = (count: number) => {
			const target = Array.from(
				{ length: count },
				(_, index) => `import { a${index} } from './m${index}';\n`,
			).join("");
			const provider = harness();
			provider.initialize(workspace({ "target.ts": target, "source.ts": "" }));
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
			provider.moveEdits(request);
			let best = Number.POSITIVE_INFINITY;
			for (let round = 0; round < 3; round++) {
				const started = performance.now();
				expect(provider.moveEdits(request)).toMatchObject({ status: "ready", blocked: [] });
				best = Math.min(best, performance.now() - started);
			}
			provider.shutdown();
			return best;
		};
		// Linear reads 8x; a rescan per dependency read over 28x.
		expect(timed(8_000) / timed(1_000)).toBeLessThan(16);
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
						reExport: false,
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
						reExport: false,
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
		expect(importInto("", [lib]).applied).toEqual({ text: `import lib = require("pkg");\n${BODY}` });
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
				expect(applyEdits(text, response.edits)).toEqual({
					text: 'import { source } from "./data";\nexport const kept = 1;\n',
				});
			}
		}
	});

	// A byte order mark is whitespace to the scanner, so nothing precedes the first statement.
	it("breaks the line before a first statement only when a token or comment precedes it there", () => {
		const bom = String.fromCharCode(0xfeff);
		const body = "export function moved() { return sibling; }\n";
		const cases = [
			{
				target: `${bom}export const kept = 1;\n`,
				expected: `${bom}import { sibling } from "./source";\nexport const kept = 1;\n\n${body}`,
			},
			{
				target: "/* lead */ export const kept = 1;\n",
				expected: `/* lead */ \nimport { sibling } from "./source";\nexport const kept = 1;\n\n${body}`,
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
			text: `import { parse } from "@scope/parser/subpath";\n${body}`,
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
						reExport: false,
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
						reExport: false,
					},
				],
				dependencies: [],
				sites: [],
			},
		);

		if (response.status !== "ready") throw new Error("move was refused");
		expect(response.edits[0]).toMatchObject({ newText: 'import { moved } from "@/new";' });
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
});
