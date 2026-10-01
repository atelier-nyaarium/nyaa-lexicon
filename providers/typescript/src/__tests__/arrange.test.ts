import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	type ArrangeEditsRequest,
	type ArrangeImportSite,
	type ArrangeMember,
	applyEdits,
	coordinatesOf,
	type MoveBlockedSite,
	type MoveDependency,
	type Position,
	type Range,
	type TextEdit,
} from "@nyaa-lexicon/protocol";
import { harness } from "./harness.js";

const roots: string[] = [];

function workspace(files: Record<string, string>): string {
	const root = mkdtempSync(path.join(tmpdir(), "lexicon-typescript-arrange-"));
	roots.push(root);
	for (const [module, text] of Object.entries(files)) {
		const full = path.join(root, module);
		mkdirSync(path.dirname(full), { recursive: true });
		writeFileSync(full, text);
	}
	return root;
}

/** One module's part, as the core builds it. */
type Part = Omit<ArrangeEditsRequest, "text" | "exists" | "fromModule" | "toModule">;

/** Answers and applies each part against one workspace; files absent from it are created. */
function arrange(files: Record<string, string>, fromModule: string, toModule: string, parts: Part[]) {
	const provider = harness();
	provider.initialize(workspace(files));
	const result = {
		files: { ...files },
		blocked: [] as MoveBlockedSite[],
		edits: {} as Record<string, TextEdit[]>,
	};
	try {
		for (const part of parts) {
			const text = files[part.module] ?? "";
			const response = provider.arrangeEdits({
				...part,
				text,
				exists: part.module in files,
				fromModule,
				toModule,
			});
			if (response.status !== "ready") throw new Error(`${part.module} was refused: ${JSON.stringify(response)}`);
			result.blocked.push(...response.blocked);
			result.edits[part.module] = response.edits;
			const applied = applyEdits(text, response.edits);
			if ("problem" in applied) throw new Error(`${part.module}: ${applied.problem}`);
			result.files[part.module] = applied.text;
		}
	} finally {
		provider.shutdown();
	}
	return result;
}

function id(name: string): string {
	return `lexicon typescript source.ts ${name}.`;
}

/** Whole lines `from` to `to`, end exclusive, as the core's layout removes them. */
function lines(from: number, to: number): Range {
	return { start: { line: from, character: 0 }, end: { line: to, character: 0 } };
}

function leaves(name: string, removal: Range): ArrangeMember {
	return { symbolId: id(name), name, removal, sites: [] };
}

function lands(name: string, text: string, position: Position, exported?: boolean): ArrangeMember {
	return {
		symbolId: id(name),
		name,
		insertion: { text, position, ...(exported === undefined ? {} : { exported }) },
		sites: [],
	};
}

function uses(name: string): ArrangeMember {
	return { symbolId: id(name), name, sites: [] };
}

/** The import of `name` in the first statement of `text` importing from `./source`. */
function importSite(text: string, name: string): ArrangeImportSite {
	const statement = text.indexOf('from "./source"');
	const open = text.lastIndexOf("{", statement);
	const start = text.indexOf(name, open);
	const range = coordinatesOf(text).rangeAt(start, start + name.length);
	if (range === undefined || start === -1 || start > statement) throw new Error(`missing test import: ${name}`);
	return {
		range,
		specifier: "./source",
		importKind: "named",
		importedName: name,
		reExport: false,
		symbolId: id(name),
	};
}

function imported(name: string): MoveDependency {
	return {
		name,
		origin: {
			kind: "workspaceModule",
			symbolId: `lexicon typescript ${name}.ts ${name}.`,
			module: `${name}.ts`,
			via: { specifier: `./${name}`, importKind: "named", importedName: name, localName: name },
		},
	};
}

function inside(name: string): MoveDependency {
	return { name, origin: { kind: "insideClosure", symbolId: id(name) } };
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("arrange edits", () => {
	it("lands two source declarations at the target's end as one group, the one using the other importing nothing for it", () => {
		const source = [
			'import { x } from "./x";',
			'import { z } from "./z";',
			'import { y } from "./y";',
			"",
			"export function a() { return helper() + x; }",
			"",
			"function helper() { return z; }",
			"",
			"export const kept = y;",
			"",
		].join("\n");
		const target = "export const t = 1;\n";
		const result = arrange(
			{
				"source.ts": source,
				"target.ts": target,
				"x.ts": "export const x = 1;\n",
				"y.ts": "export const y = 1;\n",
				"z.ts": "export const z = 1;\n",
			},
			"source.ts",
			"target.ts",
			[
				{
					module: "target.ts",
					members: [
						lands("a", "\nexport function a() { return helper() + x; }\n", { line: 1, character: 0 }),
						lands("helper", "\nfunction helper() { return z; }\n", { line: 1, character: 0 }),
					],
					importSites: [],
					dependencies: [inside("helper"), imported("x"), imported("z")],
				},
				{
					module: "source.ts",
					members: [leaves("a", lines(4, 6)), leaves("helper", lines(6, 8))],
					importSites: [],
					dependencies: [],
				},
			],
		);

		expect(result.blocked).toEqual([]);
		expect(result.files["target.ts"]).toBe(
			[
				'import { x } from "./x";',
				'import { z } from "./z";',
				"",
				"export const t = 1;",
				"",
				"export function a() { return helper() + x; }",
				"",
				"function helper() { return z; }",
				"",
			].join("\n"),
		);
		expect(result.files["source.ts"]).toBe('import { y } from "./y";\n\nexport const kept = y;\n');
	});

	it("lands members at two points, those sharing one as a single edit in member order", () => {
		const target = "export const first = 1;\n\nexport const second = 2;\n";
		const result = arrange({ "target.ts": target, "source.ts": "" }, "source.ts", "target.ts", [
			{
				module: "target.ts",
				members: [
					lands("b", "export const b = 3;\n", { line: 2, character: 0 }),
					lands("c", "\nexport const c = 4;\n\n", { line: 2, character: 0 }),
					lands("d", "\nexport const d = 5;\n", { line: 3, character: 0 }),
				],
				importSites: [],
				dependencies: [],
			},
		]);

		expect(result.blocked).toEqual([]);
		expect(result.edits["target.ts"]).toHaveLength(2);
		expect(result.files["target.ts"]).toBe(
			[
				"export const first = 1;",
				"",
				"export const b = 3;",
				"",
				"export const c = 4;",
				"",
				"export const second = 2;",
				"",
				"export const d = 5;",
				"",
			].join("\n"),
		);
	});

	it("reorders the target's own declarations, keeping every import", () => {
		const target = [
			'import { x } from "./x";',
			'import { y } from "./y";',
			"",
			"export const a = x;",
			"",
			"export const b = 2;",
			"",
			"export const c = y;",
			"",
		].join("\n");
		// `c` before `b`, which lands where `a` leaves; `a` at the end.
		const result = arrange(
			{ "target.ts": target, "x.ts": "export const x = 1;\n", "y.ts": "export const y = 1;\n" },
			"target.ts",
			"target.ts",
			[
				{
					module: "target.ts",
					members: [
						{ ...lands("c", "export const c = y;\n\n", { line: 3, character: 0 }), removal: lines(6, 8) },
						{ ...lands("a", "\nexport const a = x;\n", { line: 6, character: 0 }), removal: lines(3, 5) },
					],
					importSites: [],
					dependencies: [],
				},
			],
		);

		expect(result.blocked).toEqual([]);
		expect(result.files["target.ts"]).toBe(
			[
				'import { x } from "./x";',
				'import { y } from "./y";',
				"",
				"export const c = y;",
				"",
				"export const b = 2;",
				"",
				"export const a = x;",
				"",
			].join("\n"),
		);
	});

	it("gives the source one import of every member it still uses, exporting the one that was private", () => {
		const source = [
			"export function a() { return 1; }",
			"",
			"function b() { return 2; }",
			"",
			"export const kept = a() + b();",
			"",
		].join("\n");
		const result = arrange({ "source.ts": source }, "source.ts", "target.ts", [
			{
				module: "target.ts",
				members: [
					lands("a", "export function a() { return 1; }\n", { line: 0, character: 0 }),
					lands("b", "\nfunction b() { return 2; }\n", { line: 0, character: 0 }, true),
				],
				importSites: [],
				dependencies: [],
			},
			{
				module: "source.ts",
				members: [leaves("a", lines(0, 2)), leaves("b", lines(2, 4))],
				importSites: [],
				dependencies: ["a", "b"].map((name) => ({
					name,
					origin: { kind: "workspaceModule", symbolId: id(name), module: "target.ts" },
				})),
			},
		]);

		expect(result.blocked).toEqual([]);
		expect(result.files["target.ts"]).toBe(
			"export function a() { return 1; }\n\nexport function b() { return 2; }\n",
		);
		expect(result.files["source.ts"]).toBe('import { a, b } from "./target";\n\nexport const kept = a() + b();\n');
	});

	it("rewrites a statement naming two members once, and splits one naming a member and a staying name", () => {
		const both = 'import { a, b } from "./source";\n\nexport const r = a + b;\n';
		const split = 'import { a, stay } from "./source";\n\nexport const r = a + stay;\n';
		const result = arrange(
			{
				"source.ts": "export const a = 1;\nexport const b = 2;\nexport const stay = 3;\n",
				"target.ts": "",
				"both.ts": both,
				"split.ts": split,
			},
			"source.ts",
			"target.ts",
			[
				{
					module: "both.ts",
					members: [uses("a"), uses("b")],
					importSites: [importSite(both, "a"), importSite(both, "b")],
					dependencies: [],
				},
				{ module: "split.ts", members: [uses("a")], importSites: [importSite(split, "a")], dependencies: [] },
			],
		);

		expect(result.blocked).toEqual([]);
		expect(result.edits["both.ts"]).toHaveLength(1);
		expect(result.files["both.ts"]).toBe('import { a, b } from "./target";\n\nexport const r = a + b;\n');
		expect(result.files["split.ts"]).toBe(
			'import { stay } from "./source";\nimport { a } from "./target";\n\nexport const r = a + stay;\n',
		);
	});

	it("takes out the target's import of the members it now declares", () => {
		const target = 'import { a, b, other } from "./source";\n\nexport const t = a() + b() + other;\n';
		const result = arrange(
			{
				"source.ts":
					"export function a() { return 1; }\nexport function b() { return 2; }\nexport const other = 3;\n",
				"target.ts": target,
			},
			"source.ts",
			"target.ts",
			[
				{
					module: "target.ts",
					members: [
						lands("a", "\nexport function a() { return 1; }\n", { line: 3, character: 0 }),
						lands("b", "\nexport function b() { return 2; }\n", { line: 3, character: 0 }),
					],
					importSites: [importSite(target, "a"), importSite(target, "b")],
					dependencies: [],
				},
			],
		);

		expect(result.blocked).toEqual([]);
		expect(result.files["target.ts"]).toBe(
			[
				'import { other } from "./source";',
				"",
				"export const t = a() + b() + other;",
				"",
				"export function a() { return 1; }",
				"",
				"export function b() { return 2; }",
				"",
			].join("\n"),
		);
	});

	it("imports what stays in the source and is exported, and blocks what is private", () => {
		const target = "export const t = 1;\n";
		const part = (exported: boolean): Part => ({
			module: "target.ts",
			members: [lands("a", "\nexport function a() { return shared; }\n", { line: 1, character: 0 })],
			importSites: [],
			dependencies: [
				{ name: "shared", origin: { kind: "sourceModule", symbolId: id("shared"), name: "shared", exported } },
			],
		});
		const files = { "source.ts": "export const shared = 1;\n", "target.ts": target };

		const result = arrange(files, "source.ts", "target.ts", [part(true)]);
		expect(result.blocked).toEqual([]);
		expect(result.files["target.ts"]).toBe(
			'import { shared } from "./source";\n\nexport const t = 1;\n\nexport function a() { return shared; }\n',
		);

		expect(arrange(files, "source.ts", "target.ts", [part(false)]).blocked).toMatchObject([
			{ reason: "PrivateSibling" },
		]);
	});

	it("blocks a qualified use of a member", () => {
		const text = 'import * as src from "./source";\n\nexport const r = src.a();\n';
		const start = text.indexOf("src.a");
		const range = coordinatesOf(text).rangeAt(start, start + "src.a".length) as Range;
		const result = arrange(
			{ "source.ts": "export function a() { return 1; }\n", "target.ts": "", "use.ts": text },
			"source.ts",
			"target.ts",
			[{ module: "use.ts", members: [{ ...uses("a"), sites: [range] }], importSites: [], dependencies: [] }],
		);

		expect(result.blocked).toMatchObject([{ range, reason: "NotImplemented" }]);
	});

	it("refuses a target declaring an arriving name, a module that does not parse, and a target outside the workspace", () => {
		const cases = [
			{ text: "export const a = 1;\n", toModule: "target.ts", reason: "TargetCollision" },
			{ text: "export const = ;\n", toModule: "target.ts", reason: "ParseError" },
			{ text: "", toModule: "../target.ts", reason: "InvalidTarget" },
		];
		for (const { text, toModule, reason } of cases) {
			const provider = harness();
			provider.initialize(workspace({ "target.ts": text, "source.ts": "export const a = 1;\n" }));
			const response = provider.arrangeEdits({
				module: "target.ts",
				text,
				exists: true,
				fromModule: "source.ts",
				toModule,
				members: [lands("a", "\nexport const a = 1;\n", { line: 1, character: 0 })],
				importSites: [],
				dependencies: [],
			});
			provider.shutdown();
			expect(response, reason).toMatchObject({ status: "refused", reason });
		}
	});
});
