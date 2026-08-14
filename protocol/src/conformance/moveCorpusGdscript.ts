// GDScript move cases stay separate because loader paths and class_name registration are language-specific.

import { coordinatesOf } from "../coordinates.js";
import { composeSymbolId } from "../symbolId.js";
import type { Range } from "../symbols.js";
import { type MoveCase, MoveCaseSchema } from "./types.js";

////////////////////////////////
//  Constants

const GDSCRIPT = "gdscript";

function classId(module: string, name: string): string {
	return composeSymbolId({ language: GDSCRIPT, module, descriptors: [{ kind: "type", name }] });
}

function methodId(module: string, root: string, name: string): string {
	return composeSymbolId({
		language: GDSCRIPT,
		module,
		descriptors: [
			{ kind: "type", name: root },
			{ kind: "method", name },
		],
	});
}

////////////////////////////////
//  Cases

const CASES: MoveCase[] = [
	{
		id: "move/gd-class-name-zero-site-edits",
		about: "A class_name registration follows its declaration, so a global use needs no site edit.",
		fixtures: {
			[GDSCRIPT]: {
				files: {
					"source.gd": "class_name Moved\nextends Node\n",
					"use.gd": "extends Node\n\nfunc use(value: Moved) -> void:\n\tvalue.get_class()\n",
				},
				request: {
					module: "use.gd",
					text: "extends Node\n\nfunc use(value: Moved) -> void:\n\tvalue.get_class()\n",
					exists: true,
					symbolId: classId("source.gd", "Moved"),
					name: "Moved",
					fromModule: "source.gd",
					toModule: "target.gd",
					role: {},
					importSites: [],
					dependencies: [],
					sites: [],
				},
				expect: {
					kind: "ready",
					files: { "use.gd": "extends Node\n\nfunc use(value: Moved) -> void:\n\tvalue.get_class()\n" },
				},
			},
		},
	},
	{
		id: "move/gd-source-removal",
		about: "A source request removes the moved declaration at its supplied range.",
		fixtures: {
			[GDSCRIPT]: {
				files: {
					"source.gd": "extends Node\n\nfunc keep() -> void:\n\tpass\n\nfunc moved() -> void:\n\tpass\n",
					"target.gd": "",
				},
				request: {
					module: "source.gd",
					text: "extends Node\n\nfunc keep() -> void:\n\tpass\n\nfunc moved() -> void:\n\tpass\n",
					exists: true,
					symbolId: methodId("source.gd", "source", "moved"),
					name: "moved",
					fromModule: "source.gd",
					toModule: "target.gd",
					role: {
						removal: rangeForText(
							"extends Node\n\nfunc keep() -> void:\n\tpass\n\nfunc moved() -> void:\n\tpass\n",
							"func moved() -> void:\n\tpass\n",
						),
					},
					importSites: [],
					dependencies: [],
					sites: [],
				},
				expect: {
					kind: "ready",
					files: { "source.gd": "extends Node\n\nfunc keep() -> void:\n\tpass\n\n" },
				},
			},
		},
	},
	{
		id: "move/gd-target-new-file",
		about: "A missing GDScript target is created from the complete insertion text.",
		fixtures: {
			[GDSCRIPT]: {
				files: { "source.gd": "func moved() -> void:\n\tpass\n" },
				request: {
					module: "target.gd",
					text: "",
					exists: false,
					symbolId: methodId("source.gd", "source", "moved"),
					name: "moved",
					fromModule: "source.gd",
					toModule: "target.gd",
					role: { insertion: { text: "func moved() -> void:\n\tpass\n" } },
					importSites: [],
					dependencies: [],
					sites: [],
				},
				expect: { kind: "ready", files: { "target.gd": "func moved() -> void:\n\tpass\n" } },
			},
		},
	},
	{
		id: "move/gd-target-class-name-collision",
		about: "A target with its own class_name refuses another registration.",
		fixtures: {
			[GDSCRIPT]: {
				files: {
					"source.gd": "class_name Moved\nextends Node\n",
					"target.gd": "class_name Existing\nextends Node\n",
				},
				request: {
					module: "target.gd",
					text: "class_name Existing\nextends Node\n",
					exists: true,
					symbolId: classId("source.gd", "Moved"),
					name: "Moved",
					fromModule: "source.gd",
					toModule: "target.gd",
					role: { insertion: { text: "class_name Moved\nextends Node\n" } },
					importSites: [],
					dependencies: [],
					sites: [],
				},
				expect: { kind: "refused", reason: "TargetCollision" },
			},
		},
	},
	{
		id: "move/gd-private-sibling-blocks",
		about: "A moved function cannot reach a non-registered sibling left in the source file.",
		fixtures: {
			[GDSCRIPT]: {
				files: {
					"source.gd":
						"extends Node\n\nfunc helper() -> int:\n\treturn 1\n\nfunc moved() -> int:\n\treturn helper()\n",
					"target.gd": "",
				},
				request: {
					module: "target.gd",
					text: "",
					exists: true,
					symbolId: methodId("source.gd", "source", "moved"),
					name: "moved",
					fromModule: "source.gd",
					toModule: "target.gd",
					role: { insertion: { text: "func moved() -> int:\n\treturn helper()\n" } },
					importSites: [],
					dependencies: [
						{
							name: "helper",
							origin: {
								kind: "sourceModule",
								symbolId: methodId("source.gd", "source", "helper"),
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
		id: "move/gd-preload-site-blocks",
		about: "A preload path site is blocked because the index cannot rewrite its string meaning safely.",
		fixtures: {
			[GDSCRIPT]: {
				files: {
					"source.gd": "class_name Moved\nextends Node\n",
					"use.gd": 'const Source = preload("res://source.gd")\n',
				},
				request: {
					module: "use.gd",
					text: 'const Source = preload("res://source.gd")\n',
					exists: true,
					symbolId: classId("source.gd", "Moved"),
					name: "Moved",
					fromModule: "source.gd",
					toModule: "target.gd",
					role: {},
					importSites: [],
					dependencies: [],
					sites: [rangeForText('const Source = preload("res://source.gd")\n', "res://source.gd")],
				},
				expect: { kind: "blocked", reasons: ["StringLiteral"] },
			},
		},
	},
];

export const GDSCRIPT_MOVE_CASES: MoveCase[] = CASES.map((testCase) => MoveCaseSchema.parse(testCase));

export function loadGdscriptMoveCases(): MoveCase[] {
	return GDSCRIPT_MOVE_CASES.map((testCase) => MoveCaseSchema.parse(testCase));
}

////////////////////////////////
//  Helpers

function rangeForText(text: string, value: string): Range {
	const start = text.indexOf(value);
	if (start < 0) throw new Error(`missing GDScript move fixture text: ${value}`);
	const range = coordinatesOf(text).rangeAt(start, start + value.length);
	if (range === undefined) throw new Error(`unaddressable GDScript move fixture range: ${value}`);
	return range;
}
