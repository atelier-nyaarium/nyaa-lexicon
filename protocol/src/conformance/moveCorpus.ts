// Move cases stay separate from analysis cases because move is an ungated provider method.

import { coordinatesOf } from "../coordinates.js";
import { composeSymbolId } from "../symbolId.js";
import type { Range } from "../symbols.js";
import { type MoveCase, MoveCaseSchema } from "./types.js";

////////////////////////////////
//  Constants

const TYPESCRIPT = "typescript";
const PYTHON = "python";

/** Composed, never spelled: the id grammar has one owner and a hand-spelled kind suffix drifts. */
function callableId(module: string, name: string): string {
	return composeSymbolId({ language: TYPESCRIPT, module, descriptors: [{ kind: "method", name }] });
}

function pythonCallableId(module: string, name: string): string {
	return composeSymbolId({ language: PYTHON, module, descriptors: [{ kind: "method", name }] });
}

function pythonVariableId(module: string, name: string): string {
	return composeSymbolId({ language: PYTHON, module, descriptors: [{ kind: "term", name }] });
}

const ADD_SYMBOL_ID = callableId("src/cart.ts", "add");
const CART_TYPE_ID = composeSymbolId({
	language: TYPESCRIPT,
	module: "src/cart.ts",
	descriptors: [{ kind: "type", name: "Cart" }],
});

const IMPORTER_NAMED_FILES = {
	"src/cart.ts": "export function add(left: number, right: number) { return left + right; }\n",
	"src/items.ts": "",
	"src/use.ts": 'import { add } from "./cart";\nexport const total = add(1, 2);\n',
};

const IMPORTER_ALIASED_FILES = {
	"src/cart.ts": "export function add(left: number, right: number) { return left + right; }\n",
	"src/items.ts": "",
	"src/use.ts": 'import { add as sum } from "./cart";\nexport const total = sum(1, 2);\n',
};

const IMPORTER_TYPE_ONLY_FILES = {
	"src/cart.ts": "export interface Cart { total: number; }\n",
	"src/items.ts": "",
	"src/use.ts": 'import type { Cart } from "./cart";\nexport const current: Cart = { total: 1 };\n',
};

const IMPORTER_NAMESPACE_FILES = {
	"src/cart.ts": "export function add(left: number, right: number) { return left + right; }\n",
	"src/items.ts": "",
	"src/use.ts": 'import * as cart from "./cart";\nexport const total = cart.add(1, 2);\n',
};

const TARGET_EXPORTED_SIBLING_FILES = {
	"src/cart.ts":
		"export function helper(value: number) { return value * 2; }\nexport function add(value: number) { return helper(value); }\n",
	"src/items.ts": "",
};

const TARGET_PRIVATE_SIBLING_FILES = {
	"src/cart.ts":
		"function helper(value: number) { return value * 2; }\nexport function add(value: number) { return helper(value); }\n",
	"src/items.ts": "",
};

const TARGET_EXTERNAL_FILES = {
	"src/cart.ts": 'import { z } from "zod";\nexport const schema = z.string();\n',
	"src/items.ts": "",
};

const TARGET_BUILTIN_FILES = {
	"src/cart.ts": "export function add(left: number, right: number) { return Math.max(left, right); }\n",
	"src/items.ts": "",
};

const TARGET_RELATIVE_FILES = {
	"src/cart.ts": 'import { helper } from "./util";\nexport function add(value: number) { return helper(value); }\n',
	"src/util.ts": "export function helper(value: number) { return value * 2; }\n",
	"src/nested/items.ts": "",
};

const TARGET_NEW_FILE_FILES = {
	"src/cart.ts": "export function add(left: number, right: number) { return left + right; }\n",
};

const TARGET_EXISTING_FILES = {
	"src/cart.ts": "export function add(left: number, right: number) { return left + right; }\n",
	"src/items.ts": "export const existing = 1;\n",
};

const TARGET_COLLISION_FILES = {
	"src/cart.ts": "export function add(left: number, right: number) { return left + right; }\n",
	"src/items.ts": "export const add = 1;\n",
};

const SOURCE_SELF_IMPORT_FILES = {
	"src/cart.ts":
		"export const marker = 1;\nexport function add(left: number, right: number) { return left + right; }\nexport function total() { return add(1, 2); }\n",
	"src/items.ts": "export function add(left: number, right: number) { return left + right; }\n",
};

const BARREL_NAMED_FILES = {
	"src/cart.ts": "export function add(left: number, right: number) { return left + right; }\n",
	"src/items.ts": "",
	"src/index.ts": 'export { add } from "./cart";\n',
};

const BARREL_STAR_FILES = {
	"src/cart.ts": "export function add(left: number, right: number) { return left + right; }\n",
	"src/items.ts": "",
	"src/index.ts": 'export * from "./cart";\n',
};

const TARGET_DYNAMIC_FILES = {
	"src/cart.ts": "export function add(name: string) { return load(name); }\n",
	"src/items.ts": "",
};

const TSCONFIG_ALIAS_FILES = {
	"tsconfig.json": '{"compilerOptions":{"baseUrl":".","paths":{"@app/*":["src/*"]}}}\n',
	"src/cart.ts": "export function add(left: number, right: number) { return left + right; }\n",
	"src/items.ts": "",
	"src/use.ts": 'import { add } from "@app/cart";\nexport const total = add(1, 2);\n',
};

const PYTHON_IMPORTER_NAMED_FILES = {
	"cart.py": "def add(left, right):\n    return left + right\n",
	"items.py": "",
	"use.py": "from cart import add\ntotal = add(1, 2)\n",
};

const PYTHON_IMPORTER_ALIASED_FILES = {
	"cart.py": "def add(left, right):\n    return left + right\n",
	"items.py": "",
	"use.py": "from cart import add as total\nvalue = total(1, 2)\n",
};

const PYTHON_IMPORTER_NAMESPACE_FILES = {
	"cart.py": "def add(left, right):\n    return left + right\n",
	"items.py": "",
	"use.py": "import cart\ntotal = cart.add(1, 2)\n",
};

const PYTHON_TARGET_EXPORTED_SIBLING_FILES = {
	"src/cart.py": "def helper(value):\n    return value * 2\ndef add(value):\n    return helper(value)\n",
	"src/items.py": "",
};

const PYTHON_TARGET_PRIVATE_SIBLING_FILES = {
	"src/cart.py": "def helper(value):\n    return value * 2\ndef add(value):\n    return helper(value)\n",
	"src/items.py": "",
};

const PYTHON_TARGET_EXTERNAL_FILES = {
	"src/cart.py": "from zod import z\nschema = z.string()\n",
	"src/items.py": "",
};

const PYTHON_TARGET_BUILTIN_FILES = {
	"src/cart.py": "def add(left, right):\n    return max(left, right)\n",
	"src/items.py": "",
};

const PYTHON_TARGET_RELATIVE_FILES = {
	"src/cart.py": "from .util import helper\ndef add(value):\n    return helper(value)\n",
	"src/util.py": "def helper(value):\n    return value * 2\n",
	"src/nested/items.py": "",
};

const PYTHON_TARGET_NEW_FILE_FILES = {
	"src/cart.py": "def add(left, right):\n    return left + right\n",
};

const PYTHON_TARGET_EXISTING_FILES = {
	"src/cart.py": "def add(left, right):\n    return left + right\n",
	"src/items.py": "existing = 1\n",
};

const PYTHON_TARGET_COLLISION_FILES = {
	"src/cart.py": "def add(left, right):\n    return left + right\n",
	"src/items.py": "add = 1\n",
};

const PYTHON_SOURCE_SELF_IMPORT_FILES = {
	"src/cart.py": "marker = 1\ndef add(left, right):\n    return left + right\ndef total():\n    return add(1, 2)\n",
	"src/items.py": "def add(left, right):\n    return left + right\n",
};

const PYTHON_BARREL_INIT_FILES = {
	"src/cart.py": "def add(left, right):\n    return left + right\n",
	"src/items.py": "",
	"src/__init__.py": "from .cart import add\n",
};

const PYTHON_BARREL_STAR_FILES = {
	"src/cart.py": "def add(left, right):\n    return left + right\n",
	"src/items.py": "",
	"src/__init__.py": "from .cart import *\n",
};

const PYTHON_TARGET_DYNAMIC_FILES = {
	"src/cart.py": "def add(name):\n    return load(name)\n",
	"src/items.py": "",
};

const ANCHORED_FILES = {
	"src/cart.ts": "export function add(left: number, right: number) { return left + right; }\n",
	"src/items.ts": "export const first = 1;\n\nexport const last = 2;\n",
};

const REORDER_FILES = {
	"src/cart.ts":
		'import { round } from "./math";\n\nexport function total(value: number) { return value; }\n\nexport function add(value: number) { return round(value); }\n',
	"src/math.ts": "export function round(value: number) { return Math.round(value); }\n",
};

const PYTHON_ANCHORED_FILES = {
	"src/cart.py": "def add(left, right):\n    return left + right\n",
	"src/items.py": "first = 1\n\nlast = 2\n",
};

const PYTHON_REORDER_FILES = {
	"src/cart.py":
		"from math import floor\n\ndef total(value):\n    return value\n\ndef add(value):\n    return floor(value)\n",
};

const MOVE_CASES: MoveCase[] = [
	{
		id: "move/importer-named-import-repointed",
		about: "A named import is repointed to the moved symbol's target module.",
		fixtures: {
			[TYPESCRIPT]: {
				files: IMPORTER_NAMED_FILES,
				request: {
					module: "src/use.ts",
					text: fileText(IMPORTER_NAMED_FILES, "src/use.ts"),
					exists: true,
					symbolId: ADD_SYMBOL_ID,
					name: "add",
					fromModule: "src/cart.ts",
					toModule: "src/items.ts",
					role: {},
					importSites: [
						{
							range: rangeForText(IMPORTER_NAMED_FILES, "src/use.ts", "add"),
							specifier: "./cart",
							importKind: "named",
							importedName: "add",
							localName: "add",
						},
					],
					dependencies: [],
					sites: [],
				},
				expect: {
					kind: "ready",
					files: {
						"src/use.ts": 'import { add } from "./items";\nexport const total = add(1, 2);\n',
					},
				},
			},
			[PYTHON]: {
				files: PYTHON_IMPORTER_NAMED_FILES,
				request: {
					module: "use.py",
					text: fileText(PYTHON_IMPORTER_NAMED_FILES, "use.py"),
					exists: true,
					symbolId: pythonCallableId("cart.py", "add"),
					name: "add",
					fromModule: "cart.py",
					toModule: "items.py",
					role: {},
					importSites: [
						{
							range: rangeForText(PYTHON_IMPORTER_NAMED_FILES, "use.py", "add"),
							specifier: "cart",
							importKind: "named",
							importedName: "add",
							localName: "add",
						},
					],
					dependencies: [],
					sites: [],
				},
				expect: {
					kind: "ready",
					files: { "use.py": "from items import add\ntotal = add(1, 2)\n" },
				},
			},
		},
	},
	{
		id: "move/importer-aliased-import-keeps-alias",
		about: "A named import keeps its local alias when its specifier changes.",
		fixtures: {
			[TYPESCRIPT]: {
				files: IMPORTER_ALIASED_FILES,
				request: {
					module: "src/use.ts",
					text: fileText(IMPORTER_ALIASED_FILES, "src/use.ts"),
					exists: true,
					symbolId: ADD_SYMBOL_ID,
					name: "add",
					fromModule: "src/cart.ts",
					toModule: "src/items.ts",
					role: {},
					importSites: [
						{
							range: rangeForText(IMPORTER_ALIASED_FILES, "src/use.ts", "add"),
							specifier: "./cart",
							importKind: "named",
							importedName: "add",
							localName: "sum",
						},
					],
					dependencies: [],
					sites: [],
				},
				expect: {
					kind: "ready",
					files: {
						"src/use.ts": 'import { add as sum } from "./items";\nexport const total = sum(1, 2);\n',
					},
				},
			},
			[PYTHON]: {
				files: PYTHON_IMPORTER_ALIASED_FILES,
				request: {
					module: "use.py",
					text: fileText(PYTHON_IMPORTER_ALIASED_FILES, "use.py"),
					exists: true,
					symbolId: pythonCallableId("cart.py", "add"),
					name: "add",
					fromModule: "cart.py",
					toModule: "items.py",
					role: {},
					importSites: [
						{
							range: rangeForText(PYTHON_IMPORTER_ALIASED_FILES, "use.py", "add"),
							specifier: "cart",
							importKind: "named",
							importedName: "add",
							localName: "total",
						},
					],
					dependencies: [],
					sites: [],
				},
				expect: {
					kind: "ready",
					files: { "use.py": "from items import add as total\nvalue = total(1, 2)\n" },
				},
			},
		},
	},
	{
		id: "move/importer-type-only-stays-type-only",
		about: "A type-only import stays type-only when its specifier changes.",
		fixtures: {
			[TYPESCRIPT]: {
				files: IMPORTER_TYPE_ONLY_FILES,
				request: {
					module: "src/use.ts",
					text: fileText(IMPORTER_TYPE_ONLY_FILES, "src/use.ts"),
					exists: true,
					symbolId: CART_TYPE_ID,
					name: "Cart",
					fromModule: "src/cart.ts",
					toModule: "src/items.ts",
					role: {},
					importSites: [
						{
							range: rangeForText(IMPORTER_TYPE_ONLY_FILES, "src/use.ts", "Cart"),
							specifier: "./cart",
							importKind: "named",
							typeOnly: true,
							importedName: "Cart",
							localName: "Cart",
						},
					],
					dependencies: [],
					sites: [],
				},
				expect: {
					kind: "ready",
					files: {
						"src/use.ts":
							'import type { Cart } from "./items";\nexport const current: Cart = { total: 1 };\n',
					},
				},
			},
		},
	},
	{
		id: "move/importer-namespace-import-blocks",
		about: "A qualified use blocks a namespace import repoint.",
		fixtures: {
			[TYPESCRIPT]: {
				files: IMPORTER_NAMESPACE_FILES,
				request: {
					module: "src/use.ts",
					text: fileText(IMPORTER_NAMESPACE_FILES, "src/use.ts"),
					exists: true,
					symbolId: ADD_SYMBOL_ID,
					name: "add",
					fromModule: "src/cart.ts",
					toModule: "src/items.ts",
					role: {},
					importSites: [
						{
							range: rangeForText(IMPORTER_NAMESPACE_FILES, "src/use.ts", "cart"),
							specifier: "./cart",
							importKind: "namespace",
							localName: "cart",
						},
					],
					dependencies: [],
					sites: [rangeForText(IMPORTER_NAMESPACE_FILES, "src/use.ts", "add")],
				},
				expect: { kind: "blocked" },
			},
			[PYTHON]: {
				files: PYTHON_IMPORTER_NAMESPACE_FILES,
				request: {
					module: "use.py",
					text: fileText(PYTHON_IMPORTER_NAMESPACE_FILES, "use.py"),
					exists: true,
					symbolId: pythonCallableId("cart.py", "add"),
					name: "add",
					fromModule: "cart.py",
					toModule: "items.py",
					role: {},
					importSites: [
						{
							range: rangeForText(PYTHON_IMPORTER_NAMESPACE_FILES, "use.py", "cart"),
							specifier: "cart",
							importKind: "namespace",
							localName: "cart",
						},
					],
					dependencies: [],
					sites: [rangeForText(PYTHON_IMPORTER_NAMESPACE_FILES, "use.py", "add")],
				},
				expect: { kind: "blocked" },
			},
		},
	},
	{
		id: "move/target-imports-exported-sibling-back",
		about: "A target imports an exported sibling that stays in the source module.",
		fixtures: {
			[TYPESCRIPT]: {
				files: TARGET_EXPORTED_SIBLING_FILES,
				request: {
					module: "src/items.ts",
					text: fileText(TARGET_EXPORTED_SIBLING_FILES, "src/items.ts"),
					exists: true,
					symbolId: ADD_SYMBOL_ID,
					name: "add",
					fromModule: "src/cart.ts",
					toModule: "src/items.ts",
					role: {
						insertion: { text: "export function add(value: number) { return helper(value); }\n" },
					},
					importSites: [],
					dependencies: [
						{
							name: "helper",
							origin: {
								kind: "sourceModule",
								symbolId: callableId("src/cart.ts", "helper"),
								name: "helper",
								exported: true,
							},
						},
					],
					sites: [],
				},
				expect: {
					kind: "ready",
					files: {
						"src/items.ts":
							'import { helper } from "./cart";\nexport function add(value: number) { return helper(value); }\n',
					},
				},
			},
			[PYTHON]: {
				files: PYTHON_TARGET_EXPORTED_SIBLING_FILES,
				request: {
					module: "src/items.py",
					text: fileText(PYTHON_TARGET_EXPORTED_SIBLING_FILES, "src/items.py"),
					exists: true,
					symbolId: pythonCallableId("src/cart.py", "add"),
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
								symbolId: pythonCallableId("src/cart.py", "helper"),
								name: "helper",
								exported: true,
							},
						},
					],
					sites: [],
				},
				expect: {
					kind: "ready",
					files: {
						"src/items.py": "from .cart import helper\ndef add(value):\n    return helper(value)\n",
					},
				},
			},
		},
	},
	{
		id: "move/target-private-sibling-blocks",
		about: "A target blocks when the moved body needs a private source sibling.",
		fixtures: {
			[TYPESCRIPT]: {
				files: TARGET_PRIVATE_SIBLING_FILES,
				request: {
					module: "src/items.ts",
					text: fileText(TARGET_PRIVATE_SIBLING_FILES, "src/items.ts"),
					exists: true,
					symbolId: ADD_SYMBOL_ID,
					name: "add",
					fromModule: "src/cart.ts",
					toModule: "src/items.ts",
					role: {
						insertion: { text: "export function add(value: number) { return helper(value); }\n" },
					},
					importSites: [],
					dependencies: [
						{
							name: "helper",
							origin: {
								kind: "sourceModule",
								symbolId: callableId("src/cart.ts", "helper"),
								name: "helper",
								exported: false,
							},
						},
					],
					sites: [],
				},
				expect: { kind: "blocked", reasons: ["PrivateSibling"] },
			},
			[PYTHON]: {
				files: PYTHON_TARGET_PRIVATE_SIBLING_FILES,
				request: {
					module: "src/items.py",
					text: fileText(PYTHON_TARGET_PRIVATE_SIBLING_FILES, "src/items.py"),
					exists: true,
					symbolId: pythonCallableId("src/cart.py", "add"),
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
								symbolId: pythonCallableId("src/cart.py", "helper"),
								name: "helper",
								exported: false,
							},
						},
					],
					sites: [],
				},
				expect: { kind: "blocked", reasons: ["PrivateSibling"] },
			},
		},
	},
	{
		id: "move/target-carries-external-import",
		about: "A target carries the moved body's named external import.",
		fixtures: {
			[TYPESCRIPT]: {
				files: TARGET_EXTERNAL_FILES,
				request: {
					module: "src/items.ts",
					text: fileText(TARGET_EXTERNAL_FILES, "src/items.ts"),
					exists: true,
					symbolId: ADD_SYMBOL_ID,
					name: "add",
					fromModule: "src/cart.ts",
					toModule: "src/items.ts",
					role: { insertion: { text: "export const schema = z.string();\n" } },
					importSites: [],
					dependencies: [
						{
							name: "z",
							origin: {
								kind: "external",
								via: {
									specifier: "zod",
									importKind: "named",
									importedName: "z",
									localName: "z",
									range: rangeForText(TARGET_EXTERNAL_FILES, "src/cart.ts", "z"),
								},
							},
						},
					],
					sites: [],
				},
				expect: {
					kind: "ready",
					files: {
						"src/items.ts": 'import { z } from "zod";\nexport const schema = z.string();\n',
					},
				},
			},
			[PYTHON]: {
				files: PYTHON_TARGET_EXTERNAL_FILES,
				request: {
					module: "src/items.py",
					text: fileText(PYTHON_TARGET_EXTERNAL_FILES, "src/items.py"),
					exists: true,
					symbolId: pythonVariableId("src/cart.py", "schema"),
					name: "schema",
					fromModule: "src/cart.py",
					toModule: "src/items.py",
					role: { insertion: { text: "schema = z.string()\n" } },
					importSites: [],
					dependencies: [
						{
							name: "z",
							origin: {
								kind: "external",
								via: {
									specifier: "zod",
									importKind: "named",
									importedName: "z",
									localName: "z",
									range: rangeForText(
										PYTHON_TARGET_EXTERNAL_FILES,
										"src/cart.py",
										"z",
										fileText(PYTHON_TARGET_EXTERNAL_FILES, "src/cart.py").indexOf("import"),
									),
								},
							},
						},
					],
					sites: [],
				},
				expect: {
					kind: "ready",
					files: { "src/items.py": "from zod import z\nschema = z.string()\n" },
				},
			},
		},
	},
	{
		id: "move/target-builtin-needs-nothing",
		about: "A target adds no import for a builtin omitted from the dependency inventory.",
		fixtures: {
			[TYPESCRIPT]: {
				files: TARGET_BUILTIN_FILES,
				request: {
					module: "src/items.ts",
					text: fileText(TARGET_BUILTIN_FILES, "src/items.ts"),
					exists: true,
					symbolId: ADD_SYMBOL_ID,
					name: "add",
					fromModule: "src/cart.ts",
					toModule: "src/items.ts",
					role: {
						insertion: {
							text: "export function add(left: number, right: number) { return Math.max(left, right); }\n",
						},
					},
					importSites: [],
					dependencies: [],
					sites: [],
				},
				expect: {
					kind: "ready",
					files: {
						"src/items.ts":
							"export function add(left: number, right: number) { return Math.max(left, right); }\n",
					},
				},
			},
			[PYTHON]: {
				files: PYTHON_TARGET_BUILTIN_FILES,
				request: {
					module: "src/items.py",
					text: fileText(PYTHON_TARGET_BUILTIN_FILES, "src/items.py"),
					exists: true,
					symbolId: pythonCallableId("src/cart.py", "add"),
					name: "add",
					fromModule: "src/cart.py",
					toModule: "src/items.py",
					role: { insertion: { text: "def add(left, right):\n    return max(left, right)\n" } },
					importSites: [],
					dependencies: [],
					sites: [],
				},
				expect: {
					kind: "ready",
					files: { "src/items.py": "def add(left, right):\n    return max(left, right)\n" },
				},
			},
		},
	},
	{
		id: "move/target-rerenders-relative-specifier",
		about: "A target rerenders a workspace dependency relative to its own directory.",
		fixtures: {
			[TYPESCRIPT]: {
				files: TARGET_RELATIVE_FILES,
				request: {
					module: "src/nested/items.ts",
					text: fileText(TARGET_RELATIVE_FILES, "src/nested/items.ts"),
					exists: true,
					symbolId: ADD_SYMBOL_ID,
					name: "add",
					fromModule: "src/cart.ts",
					toModule: "src/nested/items.ts",
					role: {
						insertion: { text: "export function add(value: number) { return helper(value); }\n" },
					},
					importSites: [],
					dependencies: [
						{
							name: "helper",
							origin: {
								kind: "workspaceModule",
								symbolId: callableId("src/util.ts", "helper"),
								module: "src/util.ts",
								via: {
									specifier: "./util",
									importKind: "named",
									importedName: "helper",
									localName: "helper",
									range: rangeForText(TARGET_RELATIVE_FILES, "src/cart.ts", "helper"),
								},
							},
						},
					],
					sites: [],
				},
				expect: {
					kind: "ready",
					files: {
						"src/nested/items.ts":
							'import { helper } from "../util";\nexport function add(value: number) { return helper(value); }\n',
					},
				},
			},
			[PYTHON]: {
				files: PYTHON_TARGET_RELATIVE_FILES,
				request: {
					module: "src/nested/items.py",
					text: fileText(PYTHON_TARGET_RELATIVE_FILES, "src/nested/items.py"),
					exists: true,
					symbolId: pythonCallableId("src/cart.py", "add"),
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
								symbolId: pythonCallableId("src/util.py", "helper"),
								module: "src/util.py",
								via: {
									specifier: ".util",
									importKind: "named",
									importedName: "helper",
									localName: "helper",
									range: rangeForText(PYTHON_TARGET_RELATIVE_FILES, "src/cart.py", "helper"),
								},
							},
						},
					],
					sites: [],
				},
				expect: {
					kind: "ready",
					files: {
						"src/nested/items.py": "from ..util import helper\ndef add(value):\n    return helper(value)\n",
					},
				},
			},
		},
	},
	{
		id: "move/target-new-file",
		about: "A target that does not exist is produced as a complete new file.",
		fixtures: {
			[TYPESCRIPT]: {
				files: TARGET_NEW_FILE_FILES,
				request: {
					module: "src/items.ts",
					text: "",
					exists: false,
					symbolId: ADD_SYMBOL_ID,
					name: "add",
					fromModule: "src/cart.ts",
					toModule: "src/items.ts",
					role: {
						insertion: {
							text: "export function add(left: number, right: number) { return left + right; }\n",
						},
					},
					importSites: [],
					dependencies: [],
					sites: [],
				},
				expect: {
					kind: "ready",
					files: {
						"src/items.ts": "export function add(left: number, right: number) { return left + right; }\n",
					},
				},
			},
			[PYTHON]: {
				files: PYTHON_TARGET_NEW_FILE_FILES,
				request: {
					module: "src/items.py",
					text: "",
					exists: false,
					symbolId: pythonCallableId("src/cart.py", "add"),
					name: "add",
					fromModule: "src/cart.py",
					toModule: "src/items.py",
					role: { insertion: { text: "def add(left, right):\n    return left + right\n" } },
					importSites: [],
					dependencies: [],
					sites: [],
				},
				expect: {
					kind: "ready",
					files: { "src/items.py": "def add(left, right):\n    return left + right\n" },
				},
			},
		},
	},
	{
		id: "move/target-existing-appends",
		about: "A target keeps its existing declaration and appends the moved body.",
		fixtures: {
			[TYPESCRIPT]: {
				files: TARGET_EXISTING_FILES,
				request: {
					module: "src/items.ts",
					text: fileText(TARGET_EXISTING_FILES, "src/items.ts"),
					exists: true,
					symbolId: ADD_SYMBOL_ID,
					name: "add",
					fromModule: "src/cart.ts",
					toModule: "src/items.ts",
					role: {
						insertion: {
							text: "export function add(left: number, right: number) { return left + right; }\n",
						},
					},
					importSites: [],
					dependencies: [],
					sites: [],
				},
				expect: {
					kind: "ready",
					files: {
						// A blank line separates the appended declaration from what the target already held.
						"src/items.ts":
							"export const existing = 1;\n\nexport function add(left: number, right: number) { return left + right; }\n",
					},
				},
			},
			[PYTHON]: {
				files: PYTHON_TARGET_EXISTING_FILES,
				request: {
					module: "src/items.py",
					text: fileText(PYTHON_TARGET_EXISTING_FILES, "src/items.py"),
					exists: true,
					symbolId: pythonCallableId("src/cart.py", "add"),
					name: "add",
					fromModule: "src/cart.py",
					toModule: "src/items.py",
					role: { insertion: { text: "def add(left, right):\n    return left + right\n" } },
					importSites: [],
					dependencies: [],
					sites: [],
				},
				expect: {
					kind: "ready",
					files: {
						"src/items.py": "existing = 1\ndef add(left, right):\n    return left + right\n",
					},
				},
			},
		},
	},
	{
		id: "move/target-collision-refuses",
		about: "A target that already declares the moved name refuses the request.",
		fixtures: {
			[TYPESCRIPT]: {
				files: TARGET_COLLISION_FILES,
				request: {
					module: "src/items.ts",
					text: fileText(TARGET_COLLISION_FILES, "src/items.ts"),
					exists: true,
					symbolId: ADD_SYMBOL_ID,
					name: "add",
					fromModule: "src/cart.ts",
					toModule: "src/items.ts",
					role: {
						insertion: {
							text: "export function add(left: number, right: number) { return left + right; }\n",
						},
					},
					importSites: [],
					dependencies: [],
					sites: [],
				},
				expect: { kind: "refused", reason: "TargetCollision" },
			},
			[PYTHON]: {
				files: PYTHON_TARGET_COLLISION_FILES,
				request: {
					module: "src/items.py",
					text: fileText(PYTHON_TARGET_COLLISION_FILES, "src/items.py"),
					exists: true,
					symbolId: pythonCallableId("src/cart.py", "add"),
					name: "add",
					fromModule: "src/cart.py",
					toModule: "src/items.py",
					role: { insertion: { text: "def add(left, right):\n    return left + right\n" } },
					importSites: [],
					dependencies: [],
					sites: [],
				},
				expect: { kind: "refused", reason: "TargetCollision" },
			},
		},
	},
	{
		id: "move/source-removal-and-self-import",
		about: "A source removes the declaration and imports it back for a remaining use.",
		fixtures: {
			[TYPESCRIPT]: {
				files: SOURCE_SELF_IMPORT_FILES,
				request: {
					module: "src/cart.ts",
					text: fileText(SOURCE_SELF_IMPORT_FILES, "src/cart.ts"),
					exists: true,
					symbolId: ADD_SYMBOL_ID,
					name: "add",
					fromModule: "src/cart.ts",
					toModule: "src/items.ts",
					role: {
						removal: rangeForText(
							SOURCE_SELF_IMPORT_FILES,
							"src/cart.ts",
							"export function add(left: number, right: number) { return left + right; }\n",
						),
					},
					importSites: [],
					dependencies: [
						{
							name: "add",
							origin: {
								kind: "workspaceModule",
								symbolId: callableId("src/items.ts", "add"),
								module: "src/items.ts",
							},
						},
					],
					sites: [],
				},
				expect: {
					kind: "ready",
					files: {
						"src/cart.ts":
							'import { add } from "./items";\n\nexport const marker = 1;\nexport function total() { return add(1, 2); }\n',
					},
				},
			},
			[PYTHON]: {
				files: PYTHON_SOURCE_SELF_IMPORT_FILES,
				request: {
					module: "src/cart.py",
					text: fileText(PYTHON_SOURCE_SELF_IMPORT_FILES, "src/cart.py"),
					exists: true,
					symbolId: pythonCallableId("src/cart.py", "add"),
					name: "add",
					fromModule: "src/cart.py",
					toModule: "src/items.py",
					role: {
						removal: rangeForText(
							PYTHON_SOURCE_SELF_IMPORT_FILES,
							"src/cart.py",
							"def add(left, right):\n    return left + right\n",
						),
					},
					importSites: [],
					dependencies: [
						{
							name: "add",
							origin: {
								kind: "workspaceModule",
								symbolId: pythonCallableId("src/items.py", "add"),
								module: "src/items.py",
							},
						},
					],
					sites: [],
				},
				expect: {
					kind: "ready",
					files: {
						"src/cart.py": "from .items import add\nmarker = 1\ndef total():\n    return add(1, 2)\n",
					},
				},
			},
		},
	},
	{
		id: "move/barrel-named-reexport-repointed",
		about: "A named barrel re-export is repointed to the target module.",
		fixtures: {
			[TYPESCRIPT]: {
				files: BARREL_NAMED_FILES,
				request: {
					module: "src/index.ts",
					text: fileText(BARREL_NAMED_FILES, "src/index.ts"),
					exists: true,
					symbolId: ADD_SYMBOL_ID,
					name: "add",
					fromModule: "src/cart.ts",
					toModule: "src/items.ts",
					role: {},
					importSites: [
						{
							range: rangeForText(BARREL_NAMED_FILES, "src/index.ts", "add"),
							specifier: "./cart",
							importKind: "named",
							importedName: "add",
							localName: "add",
						},
					],
					dependencies: [],
					sites: [],
				},
				expect: {
					kind: "ready",
					files: { "src/index.ts": 'export { add } from "./items";\n' },
				},
			},
			[PYTHON]: {
				files: PYTHON_BARREL_INIT_FILES,
				request: {
					module: "src/__init__.py",
					text: fileText(PYTHON_BARREL_INIT_FILES, "src/__init__.py"),
					exists: true,
					symbolId: pythonCallableId("src/cart.py", "add"),
					name: "add",
					fromModule: "src/cart.py",
					toModule: "src/items.py",
					role: {},
					importSites: [
						{
							range: rangeForText(PYTHON_BARREL_INIT_FILES, "src/__init__.py", "add"),
							specifier: ".cart",
							importKind: "named",
							importedName: "add",
							localName: "add",
						},
					],
					dependencies: [],
					sites: [],
				},
				expect: {
					kind: "ready",
					files: { "src/__init__.py": "from .items import add\n" },
				},
			},
		},
	},
	{
		id: "move/barrel-star-reexport-blocks",
		about: "A wildcard barrel re-export blocks because it cannot isolate the moved symbol.",
		fixtures: {
			[TYPESCRIPT]: {
				files: BARREL_STAR_FILES,
				request: {
					module: "src/index.ts",
					text: fileText(BARREL_STAR_FILES, "src/index.ts"),
					exists: true,
					symbolId: ADD_SYMBOL_ID,
					name: "add",
					fromModule: "src/cart.ts",
					toModule: "src/items.ts",
					role: {},
					importSites: [
						{
							range: rangeForText(BARREL_STAR_FILES, "src/index.ts", "*"),
							specifier: "./cart",
							importKind: "wildcard",
						},
					],
					dependencies: [],
					sites: [],
				},
				expect: { kind: "blocked" },
			},
			[PYTHON]: {
				files: PYTHON_BARREL_STAR_FILES,
				request: {
					module: "src/__init__.py",
					text: fileText(PYTHON_BARREL_STAR_FILES, "src/__init__.py"),
					exists: true,
					symbolId: pythonCallableId("src/cart.py", "add"),
					name: "add",
					fromModule: "src/cart.py",
					toModule: "src/items.py",
					role: {},
					importSites: [
						{
							range: rangeForText(PYTHON_BARREL_STAR_FILES, "src/__init__.py", "*"),
							specifier: ".cart",
							importKind: "wildcard",
						},
					],
					dependencies: [],
					sites: [],
				},
				expect: { kind: "blocked" },
			},
		},
	},
	{
		id: "move/dynamic-dependency-blocks",
		about: "A runtime-constructed dependency blocks the target request.",
		fixtures: {
			[TYPESCRIPT]: {
				files: TARGET_DYNAMIC_FILES,
				request: {
					module: "src/items.ts",
					text: fileText(TARGET_DYNAMIC_FILES, "src/items.ts"),
					exists: true,
					symbolId: ADD_SYMBOL_ID,
					name: "add",
					fromModule: "src/cart.ts",
					toModule: "src/items.ts",
					role: { insertion: { text: "export function add(name: string) { return load(name); }\n" } },
					importSites: [],
					dependencies: [
						{
							name: "load",
							origin: { kind: "unresolved", reason: "RuntimeConstructed" },
							range: rangeForText(TARGET_DYNAMIC_FILES, "src/cart.ts", "load"),
						},
					],
					sites: [],
				},
				expect: { kind: "blocked", reasons: ["DynamicDependency"] },
			},
			[PYTHON]: {
				files: PYTHON_TARGET_DYNAMIC_FILES,
				request: {
					module: "src/items.py",
					text: fileText(PYTHON_TARGET_DYNAMIC_FILES, "src/items.py"),
					exists: true,
					symbolId: pythonCallableId("src/cart.py", "add"),
					name: "add",
					fromModule: "src/cart.py",
					toModule: "src/items.py",
					role: { insertion: { text: "def add(name):\n    return load(name)\n" } },
					importSites: [],
					dependencies: [
						{
							name: "load",
							origin: { kind: "unresolved", reason: "RuntimeConstructed" },
							range: rangeForText(PYTHON_TARGET_DYNAMIC_FILES, "src/cart.py", "load"),
						},
					],
					sites: [],
				},
				expect: { kind: "blocked", reasons: ["DynamicDependency"] },
			},
		},
	},
	{
		id: "move/tsconfig-alias-specifier",
		about: "A configured path alias remains in the same alias family after repointing.",
		fixtures: {
			[TYPESCRIPT]: {
				files: TSCONFIG_ALIAS_FILES,
				request: {
					module: "src/use.ts",
					text: fileText(TSCONFIG_ALIAS_FILES, "src/use.ts"),
					exists: true,
					symbolId: ADD_SYMBOL_ID,
					name: "add",
					fromModule: "src/cart.ts",
					toModule: "src/items.ts",
					role: {},
					importSites: [
						{
							range: rangeForText(TSCONFIG_ALIAS_FILES, "src/use.ts", "add"),
							specifier: "@app/cart",
							importKind: "named",
							importedName: "add",
							localName: "add",
						},
					],
					dependencies: [],
					sites: [],
				},
				expect: {
					kind: "ready",
					files: {
						"src/use.ts": 'import { add } from "@app/items";\nexport const total = add(1, 2);\n',
					},
				},
			},
		},
	},
	{
		id: "move/anchored-insertion-verbatim",
		about: "An insertion with a position is whole lines the core already framed, and lands there as written.",
		fixtures: {
			[TYPESCRIPT]: {
				files: ANCHORED_FILES,
				request: {
					module: "src/items.ts",
					text: fileText(ANCHORED_FILES, "src/items.ts"),
					exists: true,
					symbolId: ADD_SYMBOL_ID,
					name: "add",
					fromModule: "src/cart.ts",
					toModule: "src/items.ts",
					role: {
						insertion: {
							text: "export function add(left: number, right: number) { return left + right; }\n\n",
							position: { line: 2, character: 0 },
						},
					},
					importSites: [],
					dependencies: [],
					sites: [],
				},
				expect: {
					kind: "ready",
					files: {
						"src/items.ts":
							"export const first = 1;\n\nexport function add(left: number, right: number) { return left + right; }\n\nexport const last = 2;\n",
					},
				},
			},
			[PYTHON]: {
				files: PYTHON_ANCHORED_FILES,
				request: {
					module: "src/items.py",
					text: fileText(PYTHON_ANCHORED_FILES, "src/items.py"),
					exists: true,
					symbolId: pythonCallableId("src/cart.py", "add"),
					name: "add",
					fromModule: "src/cart.py",
					toModule: "src/items.py",
					role: {
						insertion: {
							text: "def add(left, right):\n    return left + right\n\n",
							position: { line: 2, character: 0 },
						},
					},
					importSites: [],
					dependencies: [],
					sites: [],
				},
				expect: {
					kind: "ready",
					files: {
						"src/items.py": "first = 1\n\ndef add(left, right):\n    return left + right\n\nlast = 2\n",
					},
				},
			},
		},
	},
	{
		id: "move/reorder-within-module",
		about: "A request whose module is both source and target reorders: the moved name is no collision, and its imports stay.",
		fixtures: {
			[TYPESCRIPT]: {
				files: REORDER_FILES,
				request: {
					module: "src/cart.ts",
					text: fileText(REORDER_FILES, "src/cart.ts"),
					exists: true,
					symbolId: ADD_SYMBOL_ID,
					name: "add",
					fromModule: "src/cart.ts",
					toModule: "src/cart.ts",
					role: {
						// As the core widens it: the declaration's lines and the blank line above them.
						removal: { start: { line: 3, character: 0 }, end: { line: 5, character: 0 } },
						insertion: {
							text: "export function add(value: number) { return round(value); }\n\n",
							position: { line: 2, character: 0 },
						},
					},
					importSites: [],
					dependencies: [],
					sites: [],
				},
				expect: {
					kind: "ready",
					files: {
						"src/cart.ts":
							'import { round } from "./math";\n\nexport function add(value: number) { return round(value); }\n\nexport function total(value: number) { return value; }\n',
					},
				},
			},
			[PYTHON]: {
				files: PYTHON_REORDER_FILES,
				request: {
					module: "src/cart.py",
					text: fileText(PYTHON_REORDER_FILES, "src/cart.py"),
					exists: true,
					symbolId: pythonCallableId("src/cart.py", "add"),
					name: "add",
					fromModule: "src/cart.py",
					toModule: "src/cart.py",
					role: {
						removal: { start: { line: 4, character: 0 }, end: { line: 7, character: 0 } },
						insertion: {
							text: "def add(value):\n    return floor(value)\n\n",
							position: { line: 2, character: 0 },
						},
					},
					importSites: [],
					dependencies: [],
					sites: [],
				},
				expect: {
					kind: "ready",
					files: {
						"src/cart.py":
							"from math import floor\n\ndef add(value):\n    return floor(value)\n\ndef total(value):\n    return value\n",
					},
				},
			},
		},
	},
];

////////////////////////////////
//  Functions & Helpers

function fileText(files: Record<string, string>, module: string): string {
	const text = files[module];
	if (text === undefined) throw new Error(`missing move fixture file: ${module}`);
	return text;
}

function rangeForText(files: Record<string, string>, module: string, value: string, from = 0): Range {
	const text = fileText(files, module);
	const start = text.indexOf(value, from);
	if (start === -1) throw new Error(`missing move fixture text in ${module}: ${value}`);
	const range = coordinatesOf(text).rangeAt(start, start + value.length);
	if (range === undefined) throw new Error(`unaddressable move fixture range in ${module}: ${value}`);
	return range;
}

/** The move corpus, validated before a provider sees it. */
export function loadMoveCases(): MoveCase[] {
	return MOVE_CASES.map((testCase) => MoveCaseSchema.parse(testCase));
}
