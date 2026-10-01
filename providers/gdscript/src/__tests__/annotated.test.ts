import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	applyEdits,
	composeSymbolId,
	coordinatesOf,
	type Declaration,
	handlersFor,
	type MoveEditsRequest,
	PROTOCOL_VERSION,
} from "@nyaa-lexicon/protocol";
import { GDScriptProvider } from "../main.js";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const SOURCE = [
	"@tool",
	"extends Node",
	"",
	"## Speed.",
	"@export_range(0, 10)",
	"var speed = 1",
	"@onready",
	"# note",
	"var label = $Label",
	'@rpc("any_peer")',
	"func sync(value):",
	"\treturn value",
	"",
	'@export_category("Stats") @export',
	"var hp := 2",
	"",
].join("\n");

function handlers() {
	const root = mkdtempSync(path.join(tmpdir(), "lexicon-gdscript-annotated-"));
	roots.push(root);
	const wired = handlersFor(new GDScriptProvider());
	wired.initialize({ workspaceRoot: root, protocolVersion: PROTOCOL_VERSION });
	wired.discoverProject({ workspaceRoot: root });
	return wired;
}

function parsed(module: string, text: string): Map<string, Declaration> {
	const facts = handlers().parseFile({ module, contentHash: "hash", text });
	return new Map(facts.declarations.map((declaration) => [declaration.name, declaration]));
}

function named(by: Map<string, Declaration>, name: string): Declaration {
	const declaration = by.get(name);
	if (declaration === undefined) throw new Error(`missing ${name}`);
	return declaration;
}

function request(module: string, text: string, role: MoveEditsRequest["role"]): MoveEditsRequest {
	return {
		module,
		text,
		exists: true,
		symbolId: composeSymbolId({
			language: "gdscript",
			module: "source.gd",
			descriptors: [
				{ kind: "type", name: "source" },
				{ kind: "method", name: "sync" },
			],
		}),
		name: "sync",
		fromModule: "source.gd",
		toModule: "target.gd",
		role,
		importSites: [],
		dependencies: [],
		sites: [],
	};
}

function apply(move: MoveEditsRequest): string {
	const response = handlers().moveEdits(move);
	if (response.status !== "ready") throw new Error(`move refused with ${response.reason}`);
	if (response.blocked.length > 0) throw new Error(`move blocked with ${response.blocked[0]?.reason}`);
	const result = applyEdits(move.text, response.edits);
	if ("problem" in result) throw new Error(result.problem);
	return result.text;
}

describe("GDScript annotated declarations", () => {
	it("start at the first owned annotation, keep the name as the selection, and leave detached ones out", () => {
		const by = parsed("source.gd", SOURCE);
		const coordinates = coordinatesOf(SOURCE);
		const spans = ["speed", "label", "sync", "hp"].map((name) => {
			const { range, selectionRange, metrics } = named(by, name);
			return [name, coordinates.sliceRange(range), selectionRange?.start, metrics?.lines];
		});

		expect(spans).toEqual([
			["speed", "@export_range(0, 10)\nvar speed = 1", { line: 5, character: 4 }, 2],
			["label", "@onready\n# note\nvar label = $Label", { line: 8, character: 4 }, 3],
			["sync", '@rpc("any_peer")\nfunc sync(value):\n\treturn value', { line: 10, character: 5 }, 3],
			["hp", "@export\nvar hp := 2", { line: 14, character: 4 }, 2],
		]);
		expect(named(by, "hp").signature).toBe("@export var hp := 2");
		expect(named(by, "source").range.start).toEqual({ line: 1, character: 0 });
	});

	it("leaves no annotation behind when a move removes the declaration's range", () => {
		const by = parsed("source.gd", SOURCE);
		const moved = apply(request("source.gd", SOURCE, { removal: named(by, "sync").range }));

		expect(moved).toBe(
			[
				"@tool",
				"extends Node",
				"",
				"## Speed.",
				"@export_range(0, 10)",
				"var speed = 1",
				"@onready",
				"# note",
				"var label = $Label",
				"",
				"",
				'@export_category("Stats") @export',
				"var hp := 2",
				"",
			].join("\n"),
		);
	});

	it("lands an insertion before an annotated anchor above its annotations", () => {
		const target = '@rpc("any_peer")\nfunc existing():\n\tpass\n';
		const line = named(parsed("target.gd", target), "existing").range.start.line;
		const moved = apply(
			request("target.gd", target, {
				insertion: { text: "func sync(value):\n\treturn value\n\n", position: { line, character: 0 } },
			}),
		);

		expect(moved).toBe('func sync(value):\n\treturn value\n\n@rpc("any_peer")\nfunc existing():\n\tpass\n');
	});
});
