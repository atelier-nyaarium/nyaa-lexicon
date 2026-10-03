import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	type ArrangeEditsRequest,
	type ArrangeMember,
	applyEdits,
	composeSymbolId,
	coordinatesOf,
	handlersFor,
	type MoveDependency,
	type Position,
	PROTOCOL_VERSION,
	type Range,
} from "@nyaa-lexicon/protocol";
import { extractDeclarationsCore } from "../extractCore.js";
import { GDScriptProvider } from "../main.js";

const roots: string[] = [];

function workspace(files: Record<string, string>): string {
	const root = mkdtempSync(path.join(tmpdir(), "lexicon-gdscript-arrange-"));
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
	if (start < 0) throw new Error(`missing arrange test text: ${value}`);
	const range = coordinatesOf(text).rangeAt(start, start + value.length);
	if (range === undefined) throw new Error(`test range is outside text: ${value}`);
	return range;
}

/** Whole lines `start` to `end`, end exclusive. */
function lines(start: number, end: number): Range {
	return { start: { line: start, character: 0 }, end: { line: end, character: 0 } };
}

function at(line: number): Position {
	return { line, character: 0 };
}

function idOf(module: string, text: string, name: string): string {
	const declaration = extractDeclarationsCore(module, text, composeSymbolId).find(
		(candidate) => candidate.name === name,
	);
	if (declaration === undefined) throw new Error(`missing declaration: ${name}`);
	return declaration.symbolId;
}

function stub(name: string): string {
	return `func ${name}() -> void:\n\tpass\n`;
}

function classId(module: string, name: string): string {
	return composeSymbolId({ language: "gdscript", module, descriptors: [{ kind: "type", name }] });
}

const helperLoader = 'const Helper = preload("res://helper.gd")\n';

const helperDependency: MoveDependency = {
	name: "Helper",
	origin: { kind: "workspaceModule", symbolId: classId("helper.gd", "helper"), module: "helper.gd" },
};

/** One module's part of a source.gd to target.gd arrangement. */
function part(module: string, text: string, fields: Partial<ArrangeEditsRequest>): ArrangeEditsRequest {
	return {
		module,
		text,
		exists: true,
		fromModule: "source.gd",
		toModule: "target.gd",
		members: [],
		importSites: [],
		dependencies: [],
		...fields,
	};
}

function arrange(root: string, request: ArrangeEditsRequest) {
	const handlers = handlersFor(new GDScriptProvider());
	handlers.initialize({ workspaceRoot: root, protocolVersion: PROTOCOL_VERSION });
	handlers.discoverProject({ workspaceRoot: root });
	return handlers.arrangeEdits(request);
}

function apply(root: string, request: ArrangeEditsRequest) {
	const response = arrange(root, request);
	if (response.status !== "ready") throw new Error(`arrangement was refused with ${response.reason}`);
	const result = applyEdits(request.text, response.edits);
	if ("problem" in result) throw new Error(result.problem);
	return { response, text: result.text };
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("arrange edits", () => {
	it("lands two declarations at the target's end as one group, one calling the other", () => {
		const keep = "func keep() -> void:\n\tpass\n";
		const helper = "func helper() -> int:\n\treturn 1\n";
		const moved = "func moved() -> int:\n\treturn helper()\n";
		const source = `extends Node\n\n${keep}\n${helper}\n${moved}`;
		const target = "extends Node\n\nfunc last() -> void:\n\tpass\n";
		const root = workspace({ "source.gd": source, "target.gd": target });
		const helperId = idOf("source.gd", source, "helper");
		const movedId = idOf("source.gd", source, "moved");

		const landed = apply(
			root,
			part("target.gd", target, {
				members: [
					{
						symbolId: helperId,
						name: "helper",
						insertion: { text: `\n${helper}`, position: at(4) },
						sites: [],
					},
					{ symbolId: movedId, name: "moved", insertion: { text: `\n${moved}`, position: at(4) }, sites: [] },
				],
				dependencies: [{ name: "helper", origin: { kind: "insideClosure", symbolId: helperId } }],
			}),
		);

		expect(landed.response.blocked).toEqual([]);
		expect(landed.text).toBe(`${target}\n${helper}\n${moved}`);

		const left = apply(
			root,
			part("source.gd", source, {
				members: [
					{ symbolId: helperId, name: "helper", removal: lines(4, 8), sites: [] },
					{ symbolId: movedId, name: "moved", removal: lines(8, 10), sites: [] },
				],
			}),
		);

		expect(left.response.blocked).toEqual([]);
		expect(left.text).toBe(`extends Node\n\n${keep}`);
	});

	it("lands each position's members as one edit, in member order", () => {
		const [a, b, c] = [stub("a"), stub("b"), stub("c")];
		const source = `extends Node\n\n${a}\n${b}\n${c}`;
		const [first, last] = [stub("first"), stub("last")];
		const target = `extends Node\n\n${first}\n${last}`;
		const root = workspace({ "source.gd": source, "target.gd": target });
		const member = (name: string, text: string, line: number): ArrangeMember => ({
			symbolId: idOf("source.gd", source, name),
			name,
			insertion: { text, position: at(line) },
			sites: [],
		});
		// GDScript has no export form.
		const exported = member("a", `${a}\n`, 2);
		if (exported.insertion !== undefined) exported.insertion.exported = true;

		const result = apply(
			root,
			part("target.gd", target, { members: [exported, member("b", `\n${b}`, 4), member("c", `\n${c}`, 4)] }),
		);

		expect(result.response.blocked).toEqual([]);
		expect(result.response.edits).toHaveLength(2);
		expect(result.text).toBe(`extends Node\n\n${a}\n${first}\n${b}\n${c}\n${last}`);
	});

	it("reorders the target's own declarations", () => {
		const [first, second, third] = [stub("first"), stub("second"), stub("third")];
		const target = `extends Node\n\n${first}\n${second}\n${third}`;
		const root = workspace({ "target.gd": target });
		const member = (name: string, removal: Range, text: string): ArrangeMember => ({
			symbolId: idOf("target.gd", target, name),
			name,
			removal,
			insertion: { text, position: at(2) },
			sites: [],
		});

		const result = apply(
			root,
			part("target.gd", target, {
				fromModule: "target.gd",
				members: [member("second", lines(4, 8), second), member("third", lines(8, 10), `\n${third}\n`)],
			}),
		);

		expect(result.response.blocked).toEqual([]);
		expect(result.text).toBe(`extends Node\n\n${second}\n${third}\n${first}`);
	});

	it("blocks each member that code staying in the source still calls", () => {
		const keep = "func keep() -> void:\n\ta()\n\tb()\n";
		const source = `extends Node\n\nfunc a() -> void:\n\tpass\n\nfunc b() -> void:\n\tpass\n\n${keep}`;
		const root = workspace({ "source.gd": source, "target.gd": "extends Node\n" });
		const [aId, bId] = [idOf("source.gd", source, "a"), idOf("source.gd", source, "b")];

		const result = apply(
			root,
			part("source.gd", source, {
				members: [
					{ symbolId: aId, name: "a", removal: lines(2, 5), sites: [] },
					{ symbolId: bId, name: "b", removal: lines(5, 8), sites: [] },
				],
				dependencies: [
					{ name: "a", origin: { kind: "workspaceModule", symbolId: aId, module: "target.gd" } },
					{ name: "b", origin: { kind: "workspaceModule", symbolId: bId, module: "target.gd" } },
				],
			}),
		);

		expect(result.response.blocked).toMatchObject([{ reason: "StringLiteral" }, { reason: "StringLiteral" }]);
		expect(result.text).toBe(`extends Node\n\n${keep}`);
	});

	it("blocks a referencing module's loader bindings of members", () => {
		const source = "extends Node\n\nclass Inner:\n\tpass\n\nconst LIMIT = 3\n";
		const use =
			'extends Node\n\nconst Inner = preload("res://source.gd").Inner\nconst LIMIT = preload("res://source.gd").LIMIT\n';
		const root = workspace({ "source.gd": source, "use.gd": use, "target.gd": "extends Node\n" });
		const site = (name: string) => ({
			range: rangeForText(use, name),
			specifier: "res://source.gd",
			importKind: "namespace" as const,
			localName: name,
			reExport: false,
			symbolId: idOf("source.gd", source, name),
		});

		const response = arrange(
			root,
			part("use.gd", use, {
				members: ["Inner", "LIMIT"].map((name) => ({
					symbolId: idOf("source.gd", source, name),
					name,
					sites: [],
				})),
				importSites: [site("Inner"), site("LIMIT")],
			}),
		);

		expect(response).toEqual({
			status: "ready",
			edits: [],
			blocked: [
				expect.objectContaining({ reason: "StringLiteral", range: rangeForText(use, "Inner") }),
				expect.objectContaining({ reason: "StringLiteral", range: rangeForText(use, "LIMIT") }),
			],
		});
	});

	it("refuses a target that binds an arriving member's name", () => {
		const source = "extends Node\n\nclass Inner:\n\tpass\n";
		const target = 'extends Node\n\nconst Inner = preload("res://source.gd").Inner\n';
		const root = workspace({ "source.gd": source, "target.gd": target });
		const symbolId = idOf("source.gd", source, "Inner");

		const response = arrange(
			root,
			part("target.gd", target, {
				members: [
					{
						symbolId,
						name: "Inner",
						insertion: { text: "\nclass Inner:\n\tpass\n", position: at(3) },
						sites: [],
					},
				],
				importSites: [
					{
						range: rangeForText(target, "Inner"),
						specifier: "res://source.gd",
						importKind: "namespace",
						localName: "Inner",
						symbolId,
					},
				],
			}),
		);

		expect(response).toMatchObject({ status: "refused", reason: "TargetCollision" });
	});

	it("copies a loader the moved bodies share once, and needs nothing for a class_name", () => {
		const a = "func a() -> void:\n\tHelper.run()\n";
		const b = "func b() -> void:\n\tHelper.stop()\n\tprint(Source)\n";
		const source = `class_name Source\nextends Node\n\n${helperLoader}\n${a}\n${b}`;
		const target = "extends Node\n\nfunc last() -> void:\n\tpass\n";
		const root = workspace({ "source.gd": source, "target.gd": target, "helper.gd": "extends Node\n" });

		const result = apply(
			root,
			part("target.gd", target, {
				members: [
					{
						symbolId: idOf("source.gd", source, "a"),
						name: "a",
						insertion: { text: `\n${a}`, position: at(4) },
						sites: [],
					},
					{
						symbolId: idOf("source.gd", source, "b"),
						name: "b",
						insertion: { text: `\n${b}`, position: at(4) },
						sites: [],
					},
				],
				dependencies: [
					helperDependency,
					{
						name: "Source",
						origin: { kind: "sourceModule", symbolId: classId("source.gd", "Source"), name: "Source" },
					},
				],
			}),
		);

		expect(result.response.blocked).toEqual([]);
		expect(result.text).toBe(`extends Node\n\n${helperLoader}func last() -> void:\n\tpass\n\n${a}\n${b}`);
	});

	it("puts a loader line where a removed span starts, not inside it", () => {
		const a = "func a() -> void:\n\tHelper.run()\n";
		const own = "func own() -> void:\n\tpass\n";
		const source = `extends Node\n\n${helperLoader}\n${a}`;
		const target = `extends Node\n\n${own}`;
		const root = workspace({ "source.gd": source, "target.gd": target, "helper.gd": "extends Node\n" });

		const result = apply(
			root,
			part("target.gd", target, {
				members: [
					{
						symbolId: idOf("source.gd", source, "a"),
						name: "a",
						insertion: { text: `\n${a}`, position: at(1) },
						sites: [],
					},
					{
						symbolId: idOf("target.gd", target, "own"),
						name: "own",
						removal: lines(1, 4),
						insertion: { text: `\n${own}`, position: at(1) },
						sites: [],
					},
				],
				dependencies: [helperDependency],
			}),
		);

		expect(result.response.blocked).toEqual([]);
		expect(result.text).toBe(`extends Node\n${helperLoader}\n${a}\n${own}`);
	});

	it("blocks a qualified use of a member", () => {
		const source = "extends Node\n\nstatic func helper() -> void:\n\tpass\n";
		const use =
			'extends Node\n\nconst Source = preload("res://source.gd")\n\nfunc use() -> void:\n\tSource.helper()\n';
		const root = workspace({ "source.gd": source, "use.gd": use, "target.gd": "extends Node\n" });
		const site = rangeForText(use, "helper", use.indexOf("Source.helper"));

		const response = arrange(
			root,
			part("use.gd", use, {
				members: [{ symbolId: idOf("source.gd", source, "helper"), name: "helper", sites: [site] }],
			}),
		);

		expect(response).toEqual({
			status: "ready",
			edits: [],
			blocked: [expect.objectContaining({ reason: "NoImportPath", range: site })],
		});
	});
});
