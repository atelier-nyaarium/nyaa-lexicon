import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { applyEdits, coordinatesOf, type Range, type RenameEditsRequest } from "@nyaa-lexicon/protocol";
import ts from "typescript";
import { harness } from "./harness.js";

const roots: string[] = [];

function workspace(files: Record<string, string>): string {
	const root = mkdtempSync(path.join(tmpdir(), "lexicon-typescript-rename-"));
	roots.push(root);
	for (const [module, text] of Object.entries(files)) writeFileSync(path.join(root, module), text);
	return root;
}

function rangeForText(text: string, value: string, from = 0): Range {
	const start = text.indexOf(value, from);
	if (start === -1) throw new Error(`missing test text: ${value}`);
	const range = coordinatesOf(text).rangeAt(start, start + value.length);
	if (range === undefined) throw new Error(`invalid test text range: ${value}`);
	return range;
}

function site(text: string, value: string, from = 0) {
	return { range: rangeForText(text, value, from) };
}

function syntaxErrors(text: string, module = "rename.ts"): readonly ts.Diagnostic[] {
	const source = ts.createSourceFile(module, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	return (source as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
}

function rename(root: string, request: RenameEditsRequest) {
	const provider = harness();
	provider.initialize(root);
	const response = provider.renameEdits(request);
	provider.shutdown();
	return response;
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("rename edits", () => {
	it("blocks a site range that does not address content", () => {
		const text = "const oldName = 1;\n";
		const range = { start: { line: 0, character: 99 }, end: { line: 0, character: 100 } };
		const response = rename(workspace({ "stale.ts": text }), {
			module: "stale.ts",
			text,
			oldName: "oldName",
			newName: "newName",
			sites: [{ range }],
		});

		expect(response).toEqual({
			status: "ready",
			edits: [],
			blocked: [{ range, reason: "ParseError", detail: "the site range is outside the module" }],
		});
	});

	it("returns sorted exact edits that apply to reparsable text", () => {
		const text = "export const oldName = 1;\nexport function run() { return oldName; }\n";
		const response = rename(workspace({ "rename.ts": text }), {
			module: "rename.ts",
			text,
			oldName: "oldName",
			newName: "newName",
			sites: [site(text, "oldName"), site(text, "oldName", text.indexOf("return"))],
		});

		expect(response).toEqual({
			status: "ready",
			edits: [
				{ range: rangeForText(text, "oldName"), newText: "newName" },
				{ range: rangeForText(text, "oldName", text.indexOf("return")), newText: "newName" },
			],
			blocked: [],
		});
		if (response.status !== "ready") throw new Error("rename was refused");
		expect(applyEdits(text, response.edits)).toEqual({
			text: "export const newName = 1;\nexport function run() { return newName; }\n",
		});
		const applied = applyEdits(text, response.edits);
		if ("problem" in applied) throw new Error(applied.problem);
		expect(syntaxErrors(applied.text)).toEqual([]);
	});

	it("applies a rename after an astral character on the same line", () => {
		const astral = String.fromCodePoint(0x1f600);
		const text = `const marker = "${astral}"; const oldName = 1;\noldName;\n`;
		const response = rename(workspace({ "astral.ts": text }), {
			module: "astral.ts",
			text,
			oldName: "oldName",
			newName: "newName",
			sites: [site(text, "oldName"), site(text, "oldName", text.indexOf("oldName;"))],
		});

		if (response.status !== "ready") throw new Error("rename was refused");
		const renamed = applyEdits(text, response.edits);
		if ("problem" in renamed) throw new Error(renamed.problem);
		expect(renamed.text).toBe(`const marker = "${astral}"; const newName = 1;\nnewName;\n`);
		expect(syntaxErrors(renamed.text)).toEqual([]);
	});

	it("expands object and destructuring shorthand without changing the property key", () => {
		const objectText = "const oldName = 1;\nconst value = { oldName };\n";
		const objectResponse = rename(workspace({ "object.ts": objectText }), {
			module: "object.ts",
			text: objectText,
			oldName: "oldName",
			newName: "newName",
			sites: [
				site(objectText, "oldName"),
				{ ...site(objectText, "oldName", objectText.indexOf("{ oldName")), role: "read" },
			],
		});
		if (objectResponse.status !== "ready") throw new Error("object rename was refused");
		expect(objectResponse.edits[1]).toEqual({
			range: rangeForText(objectText, "oldName", objectText.indexOf("{ oldName")),
			newText: "oldName: newName",
		});
		const objectApplied = applyEdits(objectText, objectResponse.edits);
		if ("problem" in objectApplied) throw new Error(objectApplied.problem);
		expect(syntaxErrors(objectApplied.text)).toEqual([]);

		const destructuringText = "const source = { oldName: 1 };\nconst { oldName } = source;\noldName;\n";
		const destructuringResponse = rename(workspace({ "destructuring.ts": destructuringText }), {
			module: "destructuring.ts",
			text: destructuringText,
			oldName: "oldName",
			newName: "newName",
			sites: [
				site(destructuringText, "oldName", destructuringText.indexOf("const {")),
				site(destructuringText, "oldName", destructuringText.indexOf("oldName;")),
			],
		});
		if (destructuringResponse.status !== "ready") throw new Error("destructuring rename was refused");
		expect(destructuringResponse.edits[0]).toEqual({
			range: rangeForText(destructuringText, "oldName", destructuringText.indexOf("const {")),
			newText: "oldName: newName",
		});
		const destructuringApplied = applyEdits(destructuringText, destructuringResponse.edits);
		if ("problem" in destructuringApplied) throw new Error(destructuringApplied.problem);
		expect(syntaxErrors(destructuringApplied.text)).toEqual([]);
	});

	it("renames an object member's own key, keeping a shorthand's value and colliding only with its siblings", () => {
		const text = [
			"interface Box { oldName: number; other: number }",
			"const oldName = 1;",
			"const outer = 2;",
			"export const box = { oldName, other: 2 } satisfies Box;",
			"export const keyed = { oldName: 3 } satisfies Partial<Box>;",
			"box.oldName;",
		].join("\n");
		const root = workspace({ "member.ts": text });
		const request = (newName: string, declaredAt: string, readAt?: string) => ({
			module: "member.ts",
			text,
			oldName: "oldName",
			newName,
			sites: [
				site(text, "oldName", text.indexOf(declaredAt)),
				...(readAt === undefined ? [] : [{ ...site(text, "oldName", text.indexOf(readAt)), role: "read" }]),
			],
		});
		const renamed = (response: ReturnType<typeof rename>) => {
			if (response.status !== "ready") throw new Error(`rename was refused: ${JSON.stringify(response)}`);
			const applied = applyEdits(text, response.edits);
			if ("problem" in applied) throw new Error(applied.problem);
			return applied.text.split("\n").slice(3);
		};

		expect(renamed(rename(root, request("outer", "oldName,", "box.")))).toEqual([
			"export const box = { outer: oldName, other: 2 } satisfies Box;",
			"export const keyed = { oldName: 3 } satisfies Partial<Box>;",
			"box.outer;",
		]);
		expect(renamed(rename(root, request("outer", "oldName: 3")))).toEqual([
			"export const box = { oldName, other: 2 } satisfies Box;",
			"export const keyed = { outer: 3 } satisfies Partial<Box>;",
			"box.oldName;",
		]);
		expect(rename(root, request("other", "oldName,"))).toMatchObject({ status: "refused", reason: "Collision" });
	});

	it("renames a key read off a namespace and keeps the local it binds", () => {
		const text = 'import * as d from "./d";\nconst { parse } = d;\nconst { parse: p } = d;\nparse() + p();\n';
		const keyAt = (from: string) => ({
			range: rangeForText(text, "parse", text.indexOf(from)),
			role: "read" as const,
		});
		const response = rename(workspace({ "d.ts": "export function parse() {}\n", "use.ts": text }), {
			module: "use.ts",
			text,
			oldName: "parse",
			newName: "load",
			sites: [keyAt("{ parse }"), keyAt("{ parse: p")],
		});
		if (response.status !== "ready") throw new Error("namespace key rename was refused");
		expect({ blocked: response.blocked, text: applyEdits(text, response.edits) }).toEqual({
			blocked: [],
			text: {
				text: 'import * as d from "./d";\nconst { load: parse } = d;\nconst { load: p } = d;\nparse() + p();\n',
			},
		});
	});

	it("rewrites only the source side of an aliased import", () => {
		const text = 'import { oldName as localName } from "./source";\nlocalName();\n';
		const response = rename(workspace({ "use.ts": text }), {
			module: "use.ts",
			text,
			oldName: "oldName",
			newName: "newName",
			sites: [site(text, "oldName"), site(text, "localName")],
		});

		expect(response).toEqual({
			status: "ready",
			edits: [{ range: rangeForText(text, "oldName"), newText: "newName" }],
			blocked: [],
		});
	});

	it("blocks string property, ambient, and anonymous default sites", () => {
		const stringText = 'declare const value: { oldName: number };\nvalue["oldName"];\n';
		const stringResponse = rename(workspace({ "string.ts": stringText }), {
			module: "string.ts",
			text: stringText,
			oldName: "oldName",
			newName: "newName",
			sites: [site(stringText, "oldName", stringText.indexOf('["') + 2)],
		});
		if (stringResponse.status !== "ready") throw new Error("string rename was refused");
		expect(stringResponse.edits).toEqual([]);
		expect(stringResponse.blocked[0]).toMatchObject({ reason: "StringLiteral" });

		const ambientText = "declare const oldName: number;\n";
		const ambientResponse = rename(workspace({ "ambient.ts": ambientText }), {
			module: "ambient.ts",
			text: ambientText,
			oldName: "oldName",
			newName: "newName",
			sites: [site(ambientText, "oldName")],
		});
		if (ambientResponse.status !== "ready") throw new Error("ambient rename was refused");
		expect(ambientResponse.blocked[0]).toMatchObject({ reason: "ExternalContract" });

		const defaultText = "export default function () {}\n";
		const defaultResponse = rename(workspace({ "default.ts": defaultText }), {
			module: "default.ts",
			text: defaultText,
			oldName: "default",
			newName: "newName",
			sites: [site(defaultText, "default")],
		});
		if (defaultResponse.status !== "ready") throw new Error("default rename was refused");
		expect(defaultResponse.blocked[0]).toMatchObject({ reason: "NotImplemented" });
	});

	it("blocks a site that covers only part of a token", () => {
		const text = 'const oldNameLonger = 1;\nconst label = "oldName here";\n';
		const response = rename(workspace({ "partial.ts": text }), {
			module: "partial.ts",
			text,
			oldName: "oldName",
			newName: "newName",
			sites: [site(text, "oldName"), site(text, "oldName", text.indexOf('"'))],
		});

		if (response.status !== "ready") throw new Error("partial rename was refused");
		expect(response.edits).toEqual([]);
		expect(response.blocked.map((entry) => entry.reason)).toEqual(["ParseError", "ParseError"]);
	});

	it("refuses invalid names, reserved words, and scope collisions", () => {
		const text = "const oldName = 1;\nconst existing = 2;\noldName;\n";
		const root = workspace({ "collision.ts": text });
		const request = (newName: string) => ({
			module: "collision.ts",
			text,
			oldName: "oldName",
			newName,
			sites: [site(text, "oldName"), site(text, "oldName", text.indexOf("oldName;"))],
		});

		expect(rename(root, request("not-valid"))).toEqual({
			status: "refused",
			reason: "InvalidName",
			detail: "the new name is not a legal identifier",
		});
		expect(rename(root, request("class"))).toEqual({
			status: "refused",
			reason: "ReservedWord",
			detail: "the new name is reserved: class",
		});
		expect(rename(root, request("existing"))).toEqual({
			status: "refused",
			reason: "Collision",
			detail: "the new name collides with an existing symbol: existing",
		});

		const memberText = "class Box { oldName() {} existing() {} }\n";
		expect(
			rename(workspace({ "member.ts": memberText }), {
				module: "member.ts",
				text: memberText,
				oldName: "oldName",
				newName: "existing",
				sites: [site(memberText, "oldName")],
			}),
		).toMatchObject({ status: "refused", reason: "Collision" });
	});

	it("preserves private field syntax and distinguishes it from a public field", () => {
		const text = "class Box { #oldName = 1; oldName = 2; read() { return this.#oldName; } }\n";
		const response = rename(workspace({ "private.ts": text }), {
			module: "private.ts",
			text,
			oldName: "oldName",
			newName: "newName",
			sites: [
				site(text, "#oldName"),
				site(text, "#oldName", text.indexOf("return")),
				site(text, "oldName", text.indexOf("oldName = 2")),
			],
		});
		if (response.status !== "ready") throw new Error("private rename was refused");
		expect(response.edits).toEqual([
			{ range: rangeForText(text, "#oldName"), newText: "#newName" },
			{ range: rangeForText(text, "oldName", text.indexOf("oldName = 2")), newText: "newName" },
			{ range: rangeForText(text, "#oldName", text.indexOf("return")), newText: "#newName" },
		]);
	});

	it("refuses a # name when no site is a private name", () => {
		const text = 'const oldName = 1;\nconst tag = "#oldName";\n';
		const response = rename(workspace({ "hash.ts": text }), {
			module: "hash.ts",
			text,
			oldName: "oldName",
			newName: "#newName",
			sites: [site(text, "oldName"), site(text, "#oldName")],
		});

		expect(response).toMatchObject({ status: "refused", reason: "InvalidName" });
	});

	it("blocks a JSX casing change", () => {
		const text = "const Foo = () => null;\nconst element = <Foo />;\n";
		const response = rename(workspace({ "jsx.tsx": text }), {
			module: "jsx.tsx",
			text,
			oldName: "Foo",
			newName: "foo",
			sites: [site(text, "Foo", text.indexOf("<"))],
		});
		if (response.status !== "ready") throw new Error("JSX rename was refused");
		expect(response.edits).toEqual([]);
		expect(response.blocked[0]).toMatchObject({ reason: "NotImplemented" });
	});
});

describe("kept names", () => {
	/** Renames `oldName` in `text`, a site at its first occurrence after each `from`, kept where flagged. */
	function renameIn(text: string, sites: Array<{ from: string; keep?: true }>, names = ["hashBytes", "digestBytes"]) {
		const [oldName, newName] = names as [string, string];
		const hash = { "hash.ts": `export function ${oldName}() {}\n` };
		const response = rename(workspace({ ...hash, "barrel.ts": text }), {
			module: "barrel.ts",
			text,
			oldName,
			newName,
			sites: sites.map(({ from, keep }) => ({
				range: rangeForText(text, oldName, text.indexOf(from)),
				...(keep ? { keep } : {}),
			})),
		});
		if (response.status !== "ready") throw new Error(`rename was refused: ${JSON.stringify(response)}`);
		return { blocked: response.blocked, text: applyEdits(text, response.edits) };
	}

	it("keeps the old exported name at a stopped re-export, and the old local at a stopped import", () => {
		expect(renameIn('export { hashBytes } from "./hash";\n', [{ from: "export", keep: true }])).toEqual({
			blocked: [],
			text: { text: 'export { digestBytes as hashBytes } from "./hash";\n' },
		});
		const local = 'import { hashBytes } from "./hash";\nexport { hashBytes };\nhashBytes();\n';
		expect(renameIn(local, [{ from: "import", keep: true }])).toEqual({
			blocked: [],
			text: { text: 'import { digestBytes as hashBytes } from "./hash";\nexport { hashBytes };\nhashBytes();\n' },
		});
		// An alias already keeps its name.
		expect(renameIn('export { hashBytes as h } from "./hash";\n', [{ from: "export", keep: true }])).toEqual({
			blocked: [],
			text: { text: 'export { digestBytes as h } from "./hash";\n' },
		});
	});

	it("collapses an alias renamed back to its own name", () => {
		const text =
			'export { digestBytes as hashBytes } from "./hash";\nimport { type digestBytes as hashBytes } from "./hash";\n';
		const back = renameIn(text, [{ from: "export" }, { from: "import" }], ["digestBytes", "hashBytes"]);
		expect(back).toEqual({
			blocked: [],
			text: { text: 'export { hashBytes } from "./hash";\nimport { type hashBytes } from "./hash";\n' },
		});
	});

	it("blocks a kept site that is no specifier's source name", () => {
		const text = "export function hashBytes() {}\n";
		const response = rename(workspace({ "barrel.ts": text }), {
			module: "barrel.ts",
			text,
			oldName: "hashBytes",
			newName: "digestBytes",
			sites: [{ range: rangeForText(text, "hashBytes"), keep: true }],
		});
		expect(response).toMatchObject({ status: "ready", edits: [], blocked: [{ reason: "NotImplemented" }] });
	});

	it("renames an aliased import's source beside an unrelated local of the new name", () => {
		const text = 'import { hashBytes as h } from "./hash";\nconst digestBytes = h;\n';
		expect(renameIn(text, [{ from: "import" }])).toEqual({
			blocked: [],
			text: { text: 'import { digestBytes as h } from "./hash";\nconst digestBytes = h;\n' },
		});
	});
});

describe("collisions", () => {
	const use = 'import { N } from "./source";\nconsole.log(N);\n';

	/** Renames `N` to `M` in `module`, a site at the first `N` after each anchor. */
	function renameN(files: Record<string, string>, module: string, anchors: string[]) {
		const text = files[module] ?? "";
		return rename(workspace(files), {
			module,
			text,
			oldName: "N",
			newName: "M",
			sites: anchors.map((anchor) => site(text, "N", text.indexOf(anchor))),
		});
	}

	function renamed(files: Record<string, string>, module: string, anchors: string[]) {
		const response = renameN(files, module, anchors);
		if (response.status !== "ready") throw new Error(`rename was refused: ${JSON.stringify(response)}`);
		return { blocked: response.blocked, text: applyEdits(files[module] ?? "", response.edits) };
	}

	it("renames through a second star that re-exports the same symbol under the new name", () => {
		const files = {
			"source.ts": "export const N = 1;\n",
			"alias.ts": 'export { N as M } from "./source";\n',
			"hub.ts": 'export * from "./source";\nexport * from "./alias";\n',
			"use.ts": 'import { N } from "./hub";\nconsole.log(N);\n',
		};
		expect(renamed(files, "use.ts", ["{ N", "(N"])).toEqual({
			blocked: [],
			text: { text: 'import { M } from "./hub";\nconsole.log(M);\n' },
		});
	});

	it("renames a value onto the name of a type declared beside it", () => {
		const files = { "source.ts": "export const N = 1;\nexport type M = string;\n", "use.ts": use };
		expect([renamed(files, "source.ts", ["const N"]), renamed(files, "use.ts", ["{ N", "(N"])]).toEqual([
			{ blocked: [], text: { text: "export const M = 1;\nexport type M = string;\n" } },
			{ blocked: [], text: { text: 'import { M } from "./source";\nconsole.log(M);\n' } },
		]);
	});

	it("renames an imported value beside a local type of the new name", () => {
		const files = {
			"source.ts": "export const N = 1;\n",
			"use.ts": 'import { N } from "./source";\ntype M = string;\nexport const y: M = String(N);\n',
		};
		expect(renamed(files, "use.ts", ["{ N", "(N"])).toEqual({
			blocked: [],
			text: { text: 'import { M } from "./source";\ntype M = string;\nexport const y: M = String(M);\n' },
		});
	});

	it("refuses a different symbol of a shared meaning, and a second binding of the same one", () => {
		const imported = [
			{ "source.ts": "export const N = 1;\nexport const M = 2;\n", "use.ts": use },
			// A class shares the type meaning.
			{ "source.ts": "export class N {}\nexport type M = string;\n", "use.ts": use },
			// The barrel's own type shadows the value its star carries.
			{
				"source.ts": "export const N = 1;\n",
				"hub.ts": 'export * from "./source";\nexport type M = string;\n',
				"use.ts": 'import { N } from "./hub";\nconsole.log(N);\n',
			},
			{
				"source.ts": "export const N = 1;\n",
				"alias.ts": 'export { N as M } from "./source";\n',
				"use.ts": 'import { N } from "./source";\nimport { M } from "./alias";\nconsole.log(N, M);\n',
			},
		].map((files) => renameN(files, "use.ts", ["{ N", "(N"]));
		const local = { "local.ts": "class N {}\ntype M = string;\nnew N();\n" };
		const responses = [...imported, renameN(local, "local.ts", ["class N", "new N"])];
		expect(responses.map((response) => (response.status === "refused" ? response.reason : "ready"))).toEqual([
			"Collision",
			"Collision",
			"Collision",
			"Collision",
			"Collision",
		]);
	});
});
