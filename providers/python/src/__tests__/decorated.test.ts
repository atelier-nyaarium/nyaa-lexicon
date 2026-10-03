import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	applyEdits,
	composeSymbolId,
	coordinatesOf,
	type Declaration,
	type MoveEditsRequest,
	PROTOCOL_VERSION,
} from "@nyaa-lexicon/protocol";
import { PythonProvider, wireHandlers } from "../main";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const SOURCE = [
	"import functools",
	"",
	"",
	"@functools.cache",
	"@trace(",
	'    "load",',
	")",
	"def load(path):",
	"    return path",
	"",
	"",
	'@trace("store")',
	"async def store(path):",
	"    return path",
	"",
	"",
	"@dataclass",
	"class Box:",
	"    @property",
	"    def size(self):",
	"        return 1",
	"",
].join("\n");

/** A provider over an empty workspace, and each declaration of a parse by name. */
async function parsed(
	module: string,
	text: string,
): Promise<{ provider: PythonProvider; by: Map<string, Declaration> }> {
	const root = mkdtempSync(path.join(tmpdir(), "lexicon-python-decorated-"));
	roots.push(root);
	const provider = new PythonProvider();
	const handlers = wireHandlers(provider);
	handlers.initialize({ workspaceRoot: root, protocolVersion: PROTOCOL_VERSION });
	handlers.discoverProject({ workspaceRoot: root });
	const facts = await handlers.parseFile({ module, contentHash: "hash", text });
	return { provider, by: new Map(facts.declarations.map((declaration) => [declaration.name, declaration])) };
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
			language: "python",
			module: "src/app.py",
			descriptors: [{ kind: "method", name: "load" }],
		}),
		name: "load",
		fromModule: "src/app.py",
		toModule: "src/io.py",
		role,
		importSites: [],
		dependencies: [],
		sites: [],
	};
}

async function apply(provider: PythonProvider, move: MoveEditsRequest): Promise<string> {
	const response = await provider.moveEdits(move);
	if (response.status !== "ready") throw new Error(`move refused with ${response.reason}`);
	if (response.blocked.length > 0) throw new Error(`move blocked with ${response.blocked[0]?.reason}`);
	const result = applyEdits(move.text, response.edits);
	if ("problem" in result) throw new Error(result.problem);
	return result.text;
}

describe("Python decorated declarations", () => {
	it("start at the first decorator and keep the name as the selection", async () => {
		const { by } = await parsed("src/app.py", SOURCE);
		const spans = ["load", "store", "Box", "size"].map((name) => {
			const { range, selectionRange, metrics } = named(by, name);
			return [name, range.start, selectionRange?.start, metrics?.lines];
		});

		expect(spans).toEqual([
			["load", { line: 3, character: 0 }, { line: 7, character: 4 }, 6],
			["store", { line: 11, character: 0 }, { line: 12, character: 10 }, 3],
			["Box", { line: 16, character: 0 }, { line: 17, character: 6 }, 5],
			["size", { line: 18, character: 4 }, { line: 19, character: 8 }, 3],
		]);
		expect(coordinatesOf(SOURCE).sliceRange(named(by, "load").range)).toBe(
			'@functools.cache\n@trace(\n    "load",\n)\ndef load(path):\n    return path',
		);
	});

	it("leaves no decorator behind when a move removes the declaration's range", async () => {
		const { provider, by } = await parsed("src/app.py", SOURCE);
		const moved = await apply(provider, request("src/app.py", SOURCE, { removal: named(by, "load").range }));

		expect(moved).toBe(
			[
				"import functools",
				"",
				"",
				"",
				"",
				"",
				'@trace("store")',
				"async def store(path):",
				"    return path",
				"",
				"",
				"@dataclass",
				"class Box:",
				"    @property",
				"    def size(self):",
				"        return 1",
				"",
			].join("\n"),
		);
	});

	it("lands an insertion before a decorated anchor above its decorators", async () => {
		const target = '@trace("existing")\ndef existing():\n    return 1\n';
		const { provider, by } = await parsed("src/io.py", target);
		const line = named(by, "existing").range.start.line;
		const moved = await apply(
			provider,
			request("src/io.py", target, {
				insertion: { text: "def load(path):\n    return path\n\n\n", position: { line, character: 0 } },
			}),
		);

		expect(moved).toBe('def load(path):\n    return path\n\n\n@trace("existing")\ndef existing():\n    return 1\n');
	});
});

const COMMENTED = [
	"#!/usr/bin/env python3",
	"def first():",
	"    return 1",
	"",
	"",
	"# Loads a path.",
	"# Twice.",
	'@trace("load")',
	"def load(path):",
	"    return path",
	"    # At the body's indent.",
	"def store(path):",
	"    return path",
	"",
	"# Fenced off.",
	"",
	"def fenced():",
	"    return 1",
	"",
	"",
	"class Box:",
	"    # Its size.",
	"    def size(self):",
	"        return 1",
	"",
	"",
	"x = 1  # trailing",
	"y = 2",
	"",
].join("\n");

describe("Python leading comments", () => {
	it("start a declaration at the comment lines directly above it at its own indentation", async () => {
		const { by } = await parsed("src/app.py", COMMENTED);
		const source = coordinatesOf(COMMENTED);
		const texts = ["first", "load", "store", "fenced", "size", "y"].map((name) => [
			name,
			source.sliceRange(named(by, name).range),
		]);

		expect(texts).toEqual([
			["first", "def first():\n    return 1"],
			["load", '# Loads a path.\n# Twice.\n@trace("load")\ndef load(path):\n    return path'],
			["store", "def store(path):\n    return path"],
			["fenced", "def fenced():\n    return 1"],
			["size", "# Its size.\n    def size(self):\n        return 1"],
			["y", "y = 2"],
		]);
		expect(named(by, "load").metrics?.lines).toBe(3);
	});

	it("leaves no comment behind when a move removes the declaration's range", async () => {
		const text =
			'import os\n\n\n# Loads a path.\n@trace("load")\ndef load(path):\n    return path\n\n\ndef keep():\n    return 1\n';
		const { provider, by } = await parsed("src/app.py", text);
		const moved = await apply(provider, request("src/app.py", text, { removal: named(by, "load").range }));

		expect(moved).toBe("import os\n\n\n\n\n\ndef keep():\n    return 1\n");
	});
});
