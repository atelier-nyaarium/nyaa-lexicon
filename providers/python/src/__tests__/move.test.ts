import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { applyEdits, composeSymbolId, type MoveEditsRequest, type Range } from "@nyaa-lexicon/protocol";
import { afterEach, describe, expect, it } from "vitest";
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
	const before = text.slice(0, start);
	const line = before.split("\n").length - 1;
	const character = start - before.lastIndexOf("\n") - 1;
	return {
		start: { line, character },
		end: { line, character: character + length },
	};
}

function apply(text: string, request: MoveEditsRequest, files: Record<string, string>) {
	const response = provider(files).moveEdits(request);
	if (response.status !== "ready") throw new Error(`move refused with ${response.reason}`);
	if (response.blocked.length > 0) throw new Error(`move blocked with ${response.blocked[0]?.reason}`);
	const result = applyEdits(text, response.edits);
	if ("problem" in result) throw new Error(result.problem);
	return result.text;
}

function namedImportRequest(
	text: string,
	siteText: string,
	fromModule = text.includes("from .cart") ? "src/cart.py" : "cart.py",
	toModule = text.includes("from .cart") ? "src/items.py" : "items.py",
): MoveEditsRequest {
	const relative = text.includes("from .cart");
	const importLine = text.split("\n").find((line) => line.startsWith("from ")) ?? "";
	const imported = /\badd(?:\s+as\s+(\w+))?/.exec(importLine);
	return {
		module: relative ? "src/use.py" : "use.py",
		text,
		exists: true,
		symbolId: symbolId(fromModule, "add"),
		name: "add",
		fromModule,
		toModule,
		role: {},
		importSites: [
			{
				range: span(text, siteText),
				specifier: relative ? ".cart" : "cart",
				importKind: "named",
				importedName: "add",
				localName: imported?.[1] ?? "add",
				reExport: false,
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
	it("splits a multi-name import and keeps the moved alias", () => {
		const text = "from .cart import keep, add as total\nvalue = total(1, 2)\n";
		const request = namedImportRequest(text, "add", "src/cart.py", "src/items.py");

		expect(
			apply(text, request, {
				"src/__init__.py": "",
				"src/cart.py": "def add(left, right):\n    return left + right\n",
				"src/items.py": "",
				"src/use.py": text,
			}),
		).toBe("from .cart import keep\nfrom .items import add as total\nvalue = total(1, 2)\n");
	});

	it("preserves an alias in a single named import", () => {
		const text = "from cart import add as total\nvalue = total(1, 2)\n";
		const request = namedImportRequest(text, "add");

		expect(
			apply(text, request, {
				"cart.py": "def add(left, right):\n    return left + right\n",
				"items.py": "",
				"use.py": text,
			}),
		).toBe("from items import add as total\nvalue = total(1, 2)\n");
	});

	it("rerenders a relative dependency for a deeper target", () => {
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
			apply(text, request, {
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

	it("rerenders a relative dependency for a shallower target", () => {
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
			apply(text, request, {
				"src/__init__.py": "",
				"src/nested/cart.py": "def add(value):\n    return helper(value)\n",
				"src/nested/util.py": "def helper(value):\n    return value\n",
				"src/items.py": text,
			}),
		).toBe("from .nested.util import helper\ndef add(value):\n    return helper(value)\n");
	});

	it("blocks namespace and wildcard imports", () => {
		const namespaceText = "import cart\nvalue = cart.add(1, 2)\n";
		const namespaceResponse = provider({
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
					reExport: false,
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
		const starResponse = provider({
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
					reExport: false,
				},
			],
			dependencies: [],
			sites: [],
		});
		expect(starResponse).toMatchObject({ status: "ready", blocked: [{ reason: "NotImplemented" }] });
	});

	it("blocks a moved name inside __all__", () => {
		const text = '__all__ = ["add"]\ndef add():\n    pass\n';
		const response = provider({
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

	it("refuses a target collision", () => {
		const text = "add = 1\n";
		const response = provider({
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

	it("creates a new target file from the supplied insertion", () => {
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

		expect(apply(text, request, { "src/cart.py": "def add():\n    pass\n" })).toBe("def add():\n    pass\n");
	});

	it("inserts dependencies after a module docstring and future imports", () => {
		const text = '"""docs"""\nfrom __future__ import annotations\nvalue = 1\n';
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

		expect(
			apply(text, request, {
				"src/__init__.py": "",
				"src/cart.py": "def helper(value):\n    return value\n",
				"src/items.py": text,
			}),
		).toBe(
			'"""docs"""\nfrom __future__ import annotations\nfrom .cart import helper\nvalue = 1\ndef add(value):\n    return helper(value)\n',
		);
	});
});
