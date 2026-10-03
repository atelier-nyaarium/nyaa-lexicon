import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { applyEdits, composeSymbolId, coordinatesOf, type MoveEditsRequest, type Range } from "@nyaa-lexicon/protocol";
import { PythonProvider } from "../main";

const roots: string[] = [];

function provider(files: Record<string, string> = {}): PythonProvider {
	const root = mkdtempSync(path.join(tmpdir(), "lexicon-python-move-"));
	roots.push(root);
	for (const [module, text] of Object.entries(files)) {
		const file = path.join(root, module);
		mkdirSync(path.dirname(file), { recursive: true });
		writeFileSync(file, text);
	}
	const value = new PythonProvider();
	value.initialize(root);
	return value;
}

function symbolId(module: string, name: string): string {
	return composeSymbolId({ language: "python", module, descriptors: [{ kind: "method", name }] });
}

function span(text: string, value: string, from = 0): Range {
	const start = text.indexOf(value, from);
	if (start < 0) throw new Error(`missing ${value}`);
	return rangeAt(text, start, value.length);
}

function rangeAt(text: string, start: number, length: number): Range {
	const range = coordinatesOf(text).rangeAt(start, start + length);
	if (range === undefined) throw new Error(`invalid test range at ${start}`);
	return range;
}

async function apply(text: string, request: MoveEditsRequest, files: Record<string, string>) {
	const response = await provider(files).moveEdits(request);
	if (response.status !== "ready") throw new Error(`move refused with ${response.reason}`);
	if (response.blocked.length > 0) throw new Error(`move blocked with ${response.blocked[0]?.reason}`);
	const result = applyEdits(text, response.edits);
	if ("problem" in result) throw new Error(result.problem);
	return result.text;
}

/** Moves `add` out of cart. */
function namedImportRequest(text: string, siteText: string, localName: string, relative = false): MoveEditsRequest {
	const fromModule = relative ? "src/cart.py" : "cart.py";
	return {
		module: relative ? "src/use.py" : "use.py",
		text,
		exists: true,
		symbolId: symbolId(fromModule, "add"),
		name: "add",
		fromModule,
		toModule: relative ? "src/items.py" : "items.py",
		role: {},
		importSites: [
			{
				range: span(text, siteText),
				specifier: relative ? ".cart" : "cart",
				importKind: "named",
				importedName: "add",
				localName,
			},
		],
		dependencies: [],
		sites: [],
	};
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Python move edits", () => {
	it("refuses insertion positions that do not address content", async () => {
		const cases = [
			{ text: "value = 1\n", position: { line: 0, character: 99 } },
			{ text: "value = 1\n", position: { line: 0, character: -1 } },
			{ text: "ab\r\n", position: { line: 0, character: 3 } },
		];

		for (const { text, position } of cases) {
			const response = await provider({ "target.py": text }).moveEdits({
				module: "target.py",
				text,
				exists: true,
				symbolId: symbolId("source.py", "moved"),
				name: "moved",
				fromModule: "source.py",
				toModule: "target.py",
				role: { insertion: { text: "moved = 1\n", position } },
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

	it("splits a multi-name import and keeps the moved alias", async () => {
		const text = "from .cart import keep, add as total\nvalue = total(1, 2)\n";
		const request = namedImportRequest(text, "add", "total", true);

		expect(
			await apply(text, request, {
				"src/__init__.py": "",
				"src/cart.py": "def add(left, right):\n    return left + right\n",
				"src/items.py": "",
				"src/use.py": text,
			}),
		).toBe("from .cart import keep\nfrom .items import add as total\nvalue = total(1, 2)\n");
	});

	it("moves an aliased name listed after a longer name it prefixes", async () => {
		const text = "from cart import add_all, add as total\nvalue = total(1, 2)\n";
		const request = namedImportRequest(text, "add as total", "total");

		expect(
			await apply(text, request, {
				"cart.py": "def add(left, right):\n    return left + right\ndef add_all():\n    pass\n",
				"items.py": "",
				"use.py": text,
			}),
		).toBe("from cart import add_all\nfrom items import add as total\nvalue = total(1, 2)\n");
	});

	it("rewrites a module name however its dotted path is spelled", async () => {
		for (const text of ["from package . subpackage import add\n", "from package.\\\n    subpackage import add\n"]) {
			const request: MoveEditsRequest = {
				module: "use.py",
				text,
				exists: true,
				symbolId: symbolId("package/subpackage.py", "add"),
				name: "add",
				fromModule: "package/subpackage.py",
				toModule: "items.py",
				role: {},
				importSites: [
					{
						range: span(text, "add", text.lastIndexOf("add")),
						specifier: "package.subpackage",
						importKind: "named",
						importedName: "add",
						localName: "add",
					},
				],
				dependencies: [],
				sites: [],
			};

			expect(
				await apply(text, request, {
					"package/__init__.py": "",
					"package/subpackage.py": "def add():\n    pass\n",
					"items.py": "",
					"use.py": text,
				}),
			).toBe("from items import add\n");
		}
	});

	it("splits a multi-name import where its statement sits", async () => {
		const cases = [
			[
				"try: from cart import add, keep\nexcept ImportError: pass\n",
				"try: from cart import keep; from items import add\nexcept ImportError: pass\n",
			],
			[
				"def load():\n\tfrom cart import add, keep\n\treturn add\n",
				"def load():\n\tfrom cart import keep\n\tfrom items import add\n\treturn add\n",
			],
		] as const;

		for (const [text, expected] of cases) {
			const request: MoveEditsRequest = {
				module: "use.py",
				text,
				exists: true,
				symbolId: symbolId("cart.py", "add"),
				name: "add",
				fromModule: "cart.py",
				toModule: "items.py",
				role: {},
				importSites: [
					{
						range: span(text, "add"),
						specifier: "cart",
						importKind: "named",
						importedName: "add",
						localName: "add",
					},
				],
				dependencies: [],
				sites: [],
			};

			expect(
				await apply(text, request, {
					"cart.py": "def add():\n    pass\ndef keep():\n    pass\n",
					"items.py": "",
					"use.py": text,
				}),
			).toBe(expected);
		}
	});

	it("blocks a split that would drop a comment inside the import", async () => {
		const files = {
			"src/__init__.py": "",
			"src/cart.py": "def add():\n    pass\ndef keep():\n    pass\n",
			"src/items.py": "",
		};
		const text = "from .cart import (\n    keep,  # compatibility export\n    add,\n)\nvalue = add()\n";
		const request = namedImportRequest(text, "add", "add", true);
		const response = await provider({ ...files, "src/use.py": text }).moveEdits(request);

		expect(response).toMatchObject({
			status: "ready",
			edits: [],
			blocked: [{ range: span(text, "add"), reason: "NotImplemented" }],
		});

		// A comment after the statement is outside its range.
		const trailing = "from .cart import keep, add  # compatibility export\n";
		expect(
			await apply(trailing, namedImportRequest(trailing, "add", "add", true), {
				...files,
				"src/use.py": trailing,
			}),
		).toBe("from .cart import keep\nfrom .items import add  # compatibility export\n");
	});

	it("preserves an alias in a single named import", async () => {
		const text = "from cart import add as total\nvalue = total(1, 2)\n";
		const request = namedImportRequest(text, "add", "total");

		expect(
			await apply(text, request, {
				"cart.py": "def add(left, right):\n    return left + right\n",
				"items.py": "",
				"use.py": text,
			}),
		).toBe("from items import add as total\nvalue = total(1, 2)\n");
	});

	it("rerenders a relative dependency for a deeper target", async () => {
		const text = "\n";
		const request: MoveEditsRequest = {
			module: "src/nested/items.py",
			text,
			exists: true,
			symbolId: symbolId("src/cart.py", "add"),
			name: "add",
			fromModule: "src/cart.py",
			toModule: "src/nested/items.py",
			role: { insertion: { text: "def add(value):\n    return helper(value)\n" } },
			importSites: [],
			dependencies: [
				{
					name: "helper",
					origin: {
						kind: "workspaceModule",
						symbolId: symbolId("src/util.py", "helper"),
						module: "src/util.py",
						via: {
							specifier: ".util",
							importKind: "named",
							importedName: "helper",
							localName: "helper",
							range: span("from .util import helper\n", "helper"),
						},
					},
				},
			],
			sites: [],
		};

		expect(
			await apply(text, request, {
				"src/__init__.py": "",
				"src/cart.py": "def add(value):\n    return helper(value)\n",
				"src/util.py": "def helper(value):\n    return value\n",
				"src/nested/__init__.py": "",
				"src/nested/items.py": text,
			}),
			// The module's own blank line survives between the inserted import and the appended body,
			// because the move writes around existing content rather than rewriting it.
		).toBe("from ..util import helper\n\ndef add(value):\n    return helper(value)\n");
	});

	it("rerenders a relative dependency for a shallower target", async () => {
		const text = "";
		const request: MoveEditsRequest = {
			module: "src/items.py",
			text,
			exists: true,
			symbolId: symbolId("src/nested/cart.py", "add"),
			name: "add",
			fromModule: "src/nested/cart.py",
			toModule: "src/items.py",
			role: { insertion: { text: "def add(value):\n    return helper(value)\n" } },
			importSites: [],
			dependencies: [
				{
					name: "helper",
					origin: {
						kind: "workspaceModule",
						symbolId: symbolId("src/nested/util.py", "helper"),
						module: "src/nested/util.py",
						via: {
							specifier: ".util",
							importKind: "named",
							importedName: "helper",
							localName: "helper",
							range: span("from .util import helper\n", "helper"),
						},
					},
				},
			],
			sites: [],
		};

		expect(
			await apply(text, request, {
				"src/__init__.py": "",
				"src/nested/cart.py": "def add(value):\n    return helper(value)\n",
				"src/nested/util.py": "def helper(value):\n    return value\n",
				"src/items.py": text,
			}),
		).toBe("from .nested.util import helper\ndef add(value):\n    return helper(value)\n");
	});

	it("blocks namespace and wildcard imports", async () => {
		const namespaceText = "import cart\nvalue = cart.add(1, 2)\n";
		const namespaceResponse = await provider({
			"src/cart.py": "def add(left, right):\n    return left + right\n",
			"src/items.py": "",
			"src/use.py": namespaceText,
		}).moveEdits({
			module: "src/use.py",
			text: namespaceText,
			exists: true,
			symbolId: symbolId("src/cart.py", "add"),
			name: "add",
			fromModule: "src/cart.py",
			toModule: "src/items.py",
			role: {},
			importSites: [
				{
					range: span(namespaceText, "cart"),
					specifier: "cart",
					importKind: "namespace",
					localName: "cart",
				},
			],
			dependencies: [],
			sites: [span(namespaceText, "add")],
		});
		// Both the import statement and the qualified use block; either alone would leave the other
		// silently unrepaired, so the count is part of the expectation.
		if (namespaceResponse.status !== "ready") throw new Error("namespace move was refused");
		expect(namespaceResponse.edits).toEqual([]);
		expect(namespaceResponse.blocked).toHaveLength(2);
		for (const site of namespaceResponse.blocked) expect(site.reason).toBe("NotImplemented");

		const starText = "from .cart import *\n";
		const starResponse = await provider({
			"src/__init__.py": "",
			"src/cart.py": "def add(left, right):\n    return left + right\n",
			"src/items.py": "",
			"src/use.py": starText,
		}).moveEdits({
			module: "src/use.py",
			text: starText,
			exists: true,
			symbolId: symbolId("src/cart.py", "add"),
			name: "add",
			fromModule: "src/cart.py",
			toModule: "src/items.py",
			role: {},
			importSites: [
				{
					range: span(starText, "*"),
					specifier: ".cart",
					importKind: "wildcard",
				},
			],
			dependencies: [],
			sites: [],
		});
		expect(starResponse).toMatchObject({ status: "ready", blocked: [{ reason: "NotImplemented" }] });
	});

	it("blocks a moved name inside __all__", async () => {
		const text = '__all__ = ["add"]\ndef add():\n    pass\n';
		const response = await provider({
			"src/__init__.py": "",
			"src/cart.py": "def add():\n    pass\n",
			"src/items.py": "",
			"src/use.py": text,
		}).moveEdits({
			module: "src/use.py",
			text,
			exists: true,
			symbolId: symbolId("src/cart.py", "add"),
			name: "add",
			fromModule: "src/cart.py",
			toModule: "src/items.py",
			role: {},
			importSites: [],
			dependencies: [],
			sites: [span(text, "add")],
		});

		expect(response).toMatchObject({ status: "ready", edits: [], blocked: [{ reason: "StringLiteral" }] });
	});

	it("refuses a target collision", async () => {
		const text = "add = 1\n";
		const response = await provider({
			"src/cart.py": "def add():\n    pass\n",
			"src/items.py": text,
		}).moveEdits({
			module: "src/items.py",
			text,
			exists: true,
			symbolId: symbolId("src/cart.py", "add"),
			name: "add",
			fromModule: "src/cart.py",
			toModule: "src/items.py",
			role: { insertion: { text: "def add():\n    pass\n" } },
			importSites: [],
			dependencies: [],
			sites: [],
		});

		expect(response).toMatchObject({ status: "refused", reason: "TargetCollision" });
	});

	it("reorders within one module and keeps its imports as written", async () => {
		const text =
			"from math import floor\n\ndef helper(value):\n    return value\n\ndef total(value):\n    return value\n\ndef add(value):\n    return floor(helper(value))\n";
		const request: MoveEditsRequest = {
			module: "src/cart.py",
			text,
			exists: true,
			symbolId: symbolId("src/cart.py", "add"),
			name: "add",
			fromModule: "src/cart.py",
			toModule: "src/cart.py",
			role: {
				removal: { start: { line: 7, character: 0 }, end: { line: 10, character: 0 } },
				insertion: {
					text: "def add(value):\n    return floor(helper(value))\n\n",
					position: { line: 5, character: 0 },
				},
			},
			importSites: [],
			dependencies: [
				{
					name: "helper",
					origin: {
						kind: "sourceModule",
						symbolId: symbolId("src/cart.py", "helper"),
						name: "helper",
						exported: true,
					},
				},
			],
			sites: [],
		};

		expect(await apply(text, request, { "src/cart.py": text })).toBe(
			"from math import floor\n\ndef helper(value):\n    return value\n\ndef add(value):\n    return floor(helper(value))\n\ndef total(value):\n    return value\n",
		);
	});

	it("creates a new target file from the supplied insertion", async () => {
		const text = "";
		const request: MoveEditsRequest = {
			module: "src/items.py",
			text,
			exists: false,
			symbolId: symbolId("src/cart.py", "add"),
			name: "add",
			fromModule: "src/cart.py",
			toModule: "src/items.py",
			role: { insertion: { text: "def add():\n    pass\n" } },
			importSites: [],
			dependencies: [],
			sites: [],
		};

		expect(await apply(text, request, { "src/cart.py": "def add():\n    pass\n" })).toBe("def add():\n    pass\n");
	});

	it("inserts dependencies after a shebang, a module docstring and future imports", async () => {
		const cases = [
			['"""docs"""\nfrom __future__ import annotations\nvalue = 1\n', 2],
			['"""docs""" \\\n    ; value = 1\n', 2],
			["#!/usr/bin/env python\nvalue = 1\n", 1],
		] as const;

		for (const [text, prologueLines] of cases) {
			const request: MoveEditsRequest = {
				module: "src/items.py",
				text,
				exists: true,
				symbolId: symbolId("src/cart.py", "add"),
				name: "add",
				fromModule: "src/cart.py",
				toModule: "src/items.py",
				role: { insertion: { text: "def add(value):\n    return helper(value)\n" } },
				importSites: [],
				dependencies: [
					{
						name: "helper",
						origin: {
							kind: "sourceModule",
							symbolId: symbolId("src/cart.py", "helper"),
							name: "helper",
							exported: true,
						},
					},
				],
				sites: [],
			};
			const lines = text.split("\n");
			const expected = [
				...lines.slice(0, prologueLines),
				"from .cart import helper",
				...lines.slice(prologueLines),
			].join("\n");

			expect(
				await apply(text, request, {
					"src/__init__.py": "",
					"src/cart.py": "def helper(value):\n    return value\n",
					"src/items.py": text,
				}),
			).toBe(`${expected}def add(value):\n    return helper(value)\n`);
		}
	});
});
