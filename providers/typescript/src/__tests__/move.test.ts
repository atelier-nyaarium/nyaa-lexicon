import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { applyEdits, type MoveEditsRequest, type Range } from "@nyaa-lexicon/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { TypeScriptProvider } from "../main";

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

function positionAt(text: string, offset: number) {
	const before = text.slice(0, offset);
	const lineStart = before.lastIndexOf("\n") + 1;
	return { line: before.split("\n").length - 1, character: offset - lineStart };
}

function rangeForText(text: string, value: string, from = 0): Range {
	const start = text.indexOf(value, from);
	if (start === -1) throw new Error(`missing test text: ${value}`);
	return { start: positionAt(text, start), end: positionAt(text, start + value.length) };
}

function move(root: string, request: MoveEditsRequest) {
	const provider = new TypeScriptProvider();
	provider.initialize(root);
	const response = provider.moveEdits(request);
	provider.shutdown();
	return response;
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("move edits", () => {
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

	it("blocks a namespace import site the same way", () => {
		const text = 'import * as old from "./old";\nold.moved();\n';
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
					range: rangeForText(text, "old", text.indexOf("* as ")),
					specifier: "./old",
					importKind: "namespace",
					localName: "old",
					reExport: false,
				},
			],
			dependencies: [],
			sites: [],
		});

		if (response.status !== "ready") throw new Error("move was refused");
		expect(response.edits).toEqual([]);
		expect(response.blocked).toHaveLength(1);
		expect(response.blocked[0]?.reason).toBe("NotImplemented");
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

	it("refuses a target declaration collision", () => {
		const text = "export const moved = 1;\n";
		const response = move(workspace({ "target.ts": text }), {
			module: "target.ts",
			text,
			exists: true,
			symbolId: "lexicon typescript source.ts moved.",
			name: "moved",
			fromModule: "source.ts",
			toModule: "target.ts",
			role: {},
			importSites: [],
			dependencies: [],
			sites: [],
		});

		expect(response).toMatchObject({ status: "refused", reason: "TargetCollision" });
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
