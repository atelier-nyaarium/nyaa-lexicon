import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	applyEdits,
	composeSymbolId,
	coordinatesOf,
	handlersFor,
	type MoveEditsRequest,
	PROTOCOL_VERSION,
	type Range,
} from "@nyaa-lexicon/protocol";
import { loadGdscriptMoveCases } from "../../../../protocol/src/conformance/moveCorpusGdscript.js";
import { MoveCaseSchema } from "../../../../protocol/src/conformance/types.js";
import { extractDeclarationsCore } from "../extractCore.js";
import { GDScriptProvider } from "../main.js";

const roots: string[] = [];

function workspace(files: Record<string, string>): string {
	const root = mkdtempSync(path.join(tmpdir(), "lexicon-gdscript-move-"));
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
	if (start < 0) throw new Error(`missing move test text: ${value}`);
	const range = coordinatesOf(text).rangeAt(start, start + value.length);
	if (range === undefined) throw new Error(`test range is outside text: ${value}`);
	return range;
}

function textAtRange(text: string, range: Range): string {
	const result = coordinatesOf(text).sliceRange(range);
	if (result === undefined) throw new Error("test range is outside text");
	return result;
}

function classId(module: string, name: string): string {
	return composeSymbolId({ language: "gdscript", module, descriptors: [{ kind: "type", name }] });
}

function methodId(module: string, root: string, name: string): string {
	return composeSymbolId({
		language: "gdscript",
		module,
		descriptors: [
			{ kind: "type", name: root },
			{ kind: "method", name },
		],
	});
}

function move(root: string, request: MoveEditsRequest) {
	const handlers = handlersFor(new GDScriptProvider());
	handlers.initialize({ workspaceRoot: root, protocolVersion: PROTOCOL_VERSION });
	handlers.discoverProject({ workspaceRoot: root });
	return handlers.moveEdits(request);
}

function apply(root: string, text: string, request: MoveEditsRequest) {
	const response = move(root, request);
	if (response.status !== "ready") throw new Error(`move was refused with ${response.reason}`);
	const result = applyEdits(text, response.edits);
	if ("problem" in result) throw new Error(result.problem);
	return { response, text: result.text };
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("move edits", () => {
	it("keeps the isolated GDScript corpus schema-valid", () => {
		const cases = loadGdscriptMoveCases();

		expect(cases).toHaveLength(8);
		expect(cases.every((testCase) => MoveCaseSchema.parse(testCase).id.startsWith("move/gd-"))).toBe(true);
	});

	it("leaves a global class_name reference unchanged", () => {
		const source = "class_name Moved\nextends Node\n";
		const use = "extends Node\n\nfunc use(value: Moved) -> void:\n\tvalue.get_class()\n";
		const root = workspace({ "source.gd": source, "use.gd": use, "target.gd": "" });
		const response = move(root, {
			module: "use.gd",
			text: use,
			exists: true,
			symbolId: classId("source.gd", "Moved"),
			name: "Moved",
			fromModule: "source.gd",
			toModule: "target.gd",
			role: {},
			importSites: [],
			dependencies: [],
			sites: [],
		});

		expect(response).toEqual({ status: "ready", edits: [], blocked: [] });
	});

	it("removes exactly the requested source declaration", () => {
		const moved = "func moved() -> void:\n\tpass\n";
		const source = `extends Node\n\nfunc keep() -> void:\n\tpass\n\n${moved}`;
		const root = workspace({ "source.gd": source, "target.gd": "" });
		const result = apply(root, source, {
			module: "source.gd",
			text: source,
			exists: true,
			symbolId: methodId("source.gd", "source", "moved"),
			name: "moved",
			fromModule: "source.gd",
			toModule: "target.gd",
			role: { removal: rangeForText(source, moved) },
			importSites: [],
			dependencies: [],
			sites: [],
		});

		expect(result.response.blocked).toEqual([]);
		expect(result.text).toBe("extends Node\n\nfunc keep() -> void:\n\tpass\n\n");
	});

	it("moves a method with its block body", () => {
		const source = "extends Node\n\nfunc moved() -> int:\n\treturn 1";
		const declaration = extractDeclarationsCore("source.gd", source, composeSymbolId).find(
			(candidate) => candidate.name === "moved",
		);
		if (declaration === undefined) throw new Error("method declaration missing");
		const moved = textAtRange(source, declaration.range);
		const root = workspace({ "source.gd": source, "target.gd": "" });
		const sourceResult = apply(root, source, {
			module: "source.gd",
			text: source,
			exists: true,
			symbolId: declaration.symbolId,
			name: "moved",
			fromModule: "source.gd",
			toModule: "target.gd",
			role: { removal: declaration.range },
			importSites: [],
			dependencies: [],
			sites: [],
		});

		expect(sourceResult.response.blocked).toEqual([]);
		expect(sourceResult.text).toBe("extends Node\n\n");

		const targetResult = apply(root, "", {
			module: "target.gd",
			text: "",
			exists: false,
			symbolId: declaration.symbolId,
			name: "moved",
			fromModule: "source.gd",
			toModule: "target.gd",
			role: { insertion: { text: moved } },
			importSites: [],
			dependencies: [],
			sites: [],
		});

		expect(targetResult.response.blocked).toEqual([]);
		expect(targetResult.text).toBe(moved);
	});

	it("moves a declaration sharing its line and leaves its neighbour", () => {
		const source = "extends Node\n\nvar f = 1; @export var g = 2\n";
		const declaration = extractDeclarationsCore("source.gd", source, composeSymbolId).find(
			(candidate) => candidate.name === "f",
		);
		if (declaration === undefined) throw new Error("property declaration missing");
		const root = workspace({ "source.gd": source, "target.gd": "" });
		const result = apply(root, source, {
			module: "source.gd",
			text: source,
			exists: true,
			symbolId: declaration.symbolId,
			name: "f",
			fromModule: "source.gd",
			toModule: "target.gd",
			role: { removal: declaration.range },
			importSites: [],
			dependencies: [],
			sites: [],
		});
		const kept = extractDeclarationsCore("source.gd", result.text, composeSymbolId).find(
			(candidate) => candidate.name === "g",
		);

		expect(textAtRange(source, declaration.range)).toBe("var f = 1");
		expect(result.response.blocked).toEqual([]);
		expect(kept === undefined ? undefined : textAtRange(result.text, kept.range)).toBe("@export var g = 2");
	});

	it("moves a multi-line const whole and leaves none of it behind", () => {
		const source = 'extends Node\n\nconst X = {\n\t"a": 1,\n}\nvar keep = 2\n';
		const declaration = extractDeclarationsCore("source.gd", source, composeSymbolId).find(
			(candidate) => candidate.name === "X",
		);
		if (declaration === undefined) throw new Error("constant declaration missing");
		const moved = textAtRange(source, declaration.range);
		const root = workspace({ "source.gd": source, "target.gd": "" });
		const request = {
			symbolId: declaration.symbolId,
			name: "X",
			fromModule: "source.gd",
			toModule: "target.gd",
			importSites: [],
			dependencies: [],
			sites: [],
		};
		const sourceResult = apply(root, source, {
			...request,
			module: "source.gd",
			text: source,
			exists: true,
			role: { removal: declaration.range },
		});
		const targetResult = apply(root, "", {
			...request,
			module: "target.gd",
			text: "",
			exists: false,
			role: { insertion: { text: moved } },
		});

		expect(sourceResult.response.blocked).toEqual([]);
		expect(sourceResult.text).toBe("extends Node\n\n\nvar keep = 2\n");
		expect(targetResult.text).toBe('const X = {\n\t"a": 1,\n}');
	});

	it("inserts the complete declaration into a new file", () => {
		const moved = "func moved() -> void:\n\tpass\n";
		const root = workspace({ "source.gd": moved });
		const result = apply(root, "", {
			module: "target.gd",
			text: "",
			exists: false,
			symbolId: methodId("source.gd", "source", "moved"),
			name: "moved",
			fromModule: "source.gd",
			toModule: "target.gd",
			role: { insertion: { text: moved } },
			importSites: [],
			dependencies: [],
			sites: [],
		});

		expect(result.response.blocked).toEqual([]);
		expect(result.text).toBe(moved);
	});

	it("refuses a second class_name registration in the target", () => {
		const source = "class_name Moved\nextends Node\n";
		const target = "class_name Existing\nextends Node\n";
		const root = workspace({ "source.gd": source, "target.gd": target });
		const response = move(root, {
			module: "target.gd",
			text: target,
			exists: true,
			symbolId: classId("source.gd", "Moved"),
			name: "Moved",
			fromModule: "source.gd",
			toModule: "target.gd",
			role: { insertion: { text: source } },
			importSites: [],
			dependencies: [],
			sites: [],
		});

		expect(response).toMatchObject({ status: "refused", reason: "TargetCollision" });
	});

	it("blocks a file-local sibling that stays behind", () => {
		const source = "extends Node\n\nfunc helper() -> int:\n\treturn 1\n\nfunc moved() -> int:\n\treturn helper()\n";
		const moved = "func moved() -> int:\n\treturn helper()\n";
		const root = workspace({ "source.gd": source, "target.gd": "" });
		const response = move(root, {
			module: "target.gd",
			text: "",
			exists: true,
			symbolId: methodId("source.gd", "source", "moved"),
			name: "moved",
			fromModule: "source.gd",
			toModule: "target.gd",
			role: { insertion: { text: moved } },
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
					range: rangeForText(source, "helper", source.indexOf("func moved")),
				},
			],
			sites: [],
		});

		expect(response.status).toBe("ready");
		if (response.status === "ready") expect(response.blocked).toMatchObject([{ reason: "PrivateSibling" }]);
	});

	it("blocks a preload path site as a string literal", () => {
		const source = "class_name Moved\nextends Node\n";
		const use = 'const Source = preload("res://source.gd")\n';
		const root = workspace({ "source.gd": source, "use.gd": use, "target.gd": "" });
		const response = move(root, {
			module: "use.gd",
			text: use,
			exists: true,
			symbolId: classId("source.gd", "Moved"),
			name: "Moved",
			fromModule: "source.gd",
			toModule: "target.gd",
			role: {},
			importSites: [],
			dependencies: [],
			sites: [rangeForText(use, "res://source.gd")],
		});

		expect(response.status).toBe("ready");
		if (response.status === "ready") expect(response.blocked).toMatchObject([{ reason: "StringLiteral" }]);
	});

	function moveHelper(source: string, target: string) {
		const moved = "func moved() -> void:\n\tHelper.run()\n";
		const root = workspace({ "source.gd": source, "target.gd": target, "helper.gd": "extends Node\n" });
		return move(root, {
			module: "target.gd",
			text: target,
			exists: true,
			symbolId: methodId("source.gd", "source", "moved"),
			name: "moved",
			fromModule: "source.gd",
			toModule: "target.gd",
			role: { insertion: { text: moved } },
			importSites: [],
			dependencies: [
				{
					name: "Helper",
					origin: { kind: "workspaceModule", symbolId: classId("helper.gd", "helper"), module: "helper.gd" },
				},
			],
			sites: [],
		});
	}

	const helperLoader = 'const Helper = preload("res://helper.gd")\n';

	it.each([
		["a string", 'extends Node\n@export_multiline var help = """\n# Usage\n"""\n'],
		["an annotation and its member", "extends Node\n@export\nvar speed = 1\n"],
	])("inserts a dependency after the header lines, not inside %s", (_, target) => {
		const response = moveHelper(helperLoader, target);

		expect(response.status).toBe("ready");
		if (response.status !== "ready") return;
		expect(response.edits.find((edit) => edit.newText === helperLoader)?.range.start).toEqual({
			line: 1,
			character: 0,
		});
	});

	it.each([
		["a loader", `extends Node\nvar doc = """\n${helperLoader}"""\n`],
		["a declaration", 'extends Node\nvar doc = """\nvar Helper = 1\n"""\n'],
	])("reads the target's own facts, not %s written inside its strings", (_, target) => {
		const response = moveHelper(helperLoader, target);

		expect(response).toMatchObject({ status: "ready", blocked: [] });
		if (response.status === "ready")
			expect(response.edits.some((edit) => edit.newText === helperLoader)).toBe(true);
	});

	it("reads the source's loader from its facts, not from a string", () => {
		const response = moveHelper(`var doc = """\n${helperLoader}"""\n`, "extends Node\n");

		expect(response).toMatchObject({ status: "ready", blocked: [{ reason: "StringLiteral" }] });
	});

	it("blocks a dependency whose name the target registers as its class_name", () => {
		const response = moveHelper(helperLoader, "class_name Helper\nextends Node\n");

		expect(response).toMatchObject({ status: "ready", blocked: [{ reason: "TargetCollision" }] });
	});

	it.each(["preload", "load"] as const)("copies an absolute %s dependency into the target", (loader) => {
		const target = "extends Node\n";
		const moved = "func moved() -> void:\n\tHelper.run()\n";
		const root = workspace({
			"source.gd": `const Helper = ${loader}("res://helper.gd")\n`,
			"target.gd": target,
			"helper.gd": "extends Node\n",
		});
		const response = move(root, {
			module: "target.gd",
			text: target,
			exists: true,
			symbolId: methodId("source.gd", "source", "moved"),
			name: "moved",
			fromModule: "source.gd",
			toModule: "target.gd",
			role: { insertion: { text: moved } },
			importSites: [],
			dependencies: [
				{
					name: "Helper",
					origin: {
						kind: "workspaceModule",
						symbolId: classId("helper.gd", "helper"),
						module: "helper.gd",
					},
				},
			],
			sites: [],
		});

		expect(response).toEqual({
			status: "ready",
			edits: [
				{
					range: { start: { line: 1, character: 0 }, end: { line: 1, character: 0 } },
					newText: `const Helper = ${loader}("res://helper.gd")\n${moved}`,
				},
			],
			blocked: [],
		});
	});

	it("reorders within one module, keeping its loader and siblings", () => {
		const loader = 'const Helper = preload("res://helper.gd")\n';
		const first = "func first() -> void:\n\tpass\n";
		const second = "func second() -> void:\n\tHelper.run()\n\tfirst()\n";
		const source = `extends Node\n\n${loader}\n${first}\n${second}`;
		const root = workspace({ "source.gd": source, "helper.gd": "extends Node\n" });
		const result = apply(root, source, {
			module: "source.gd",
			text: source,
			exists: true,
			symbolId: methodId("source.gd", "source", "second"),
			name: "second",
			fromModule: "source.gd",
			toModule: "source.gd",
			role: {
				removal: { start: { line: 6, character: 0 }, end: { line: 10, character: 0 } },
				insertion: { text: `${second}\n`, position: { line: 4, character: 0 } },
			},
			importSites: [],
			dependencies: [
				{
					name: "Helper",
					origin: { kind: "workspaceModule", symbolId: classId("helper.gd", "helper"), module: "helper.gd" },
				},
				{
					name: "first",
					origin: {
						kind: "sourceModule",
						symbolId: methodId("source.gd", "source", "first"),
						name: "first",
						exported: false,
					},
				},
			],
			sites: [],
		});

		expect(result.response.blocked).toEqual([]);
		expect(result.text).toBe(`extends Node\n\n${loader}\n${second}\n${first}`);
	});
});
