import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { applyEdits, composeSymbolId, type MoveEditsRequest, type Range } from "@nyaa-lexicon/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { loadGdscriptMoveCases } from "../../../../protocol/src/conformance/moveCorpusGdscript.js";
import { MoveCaseSchema } from "../../../../protocol/src/conformance/types.js";
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

function positionAt(text: string, offset: number) {
	const before = text.slice(0, offset);
	return {
		line: before.split("\n").length - 1,
		character: offset - (before.lastIndexOf("\n") + 1),
	};
}

function rangeForText(text: string, value: string, from = 0): Range {
	const start = text.indexOf(value, from);
	if (start < 0) throw new Error(`missing move test text: ${value}`);
	return { start: positionAt(text, start), end: positionAt(text, start + value.length) };
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
	const provider = new GDScriptProvider();
	provider.initialize(root);
	provider.discoverProject(root);
	const response = provider.moveEdits(request);
	return response;
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

		expect(cases).toHaveLength(6);
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

	// A GDScript declaration range stops at the header, which is what the core sends. Taking it
	// literally relocated `func moved() -> void:` and left `pass` behind, in two files that no
	// longer parse. Found by driving a real move, caught by the syntax gate, reverted.
	it("refuses a removal that would strand a block body", () => {
		const source = "extends Node\n\nfunc moved() -> void:\n\tpass\n";
		const root = workspace({ "source.gd": source, "target.gd": "" });
		const result = apply(root, source, {
			module: "source.gd",
			text: source,
			exists: true,
			symbolId: methodId("source.gd", "source", "moved"),
			name: "moved",
			fromModule: "source.gd",
			toModule: "target.gd",
			role: { removal: rangeForText(source, "func moved() -> void:") },
			importSites: [],
			dependencies: [],
			sites: [],
		});

		expect(result.response.blocked).toHaveLength(1);
		expect(result.response.blocked[0]?.reason).toBe("NotImplemented");
		expect(result.text).toBe(source);
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
});
