import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Range, RenameEditsRequest, TextEdit } from "@nyaa-lexicon/protocol";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import { TypeScriptProvider } from "../main";

const roots: string[] = [];

function workspace(files: Record<string, string>): string {
	const root = mkdtempSync(path.join(tmpdir(), "lexicon-typescript-rename-"));
	roots.push(root);
	for (const [module, text] of Object.entries(files)) writeFileSync(path.join(root, module), text);
	return root;
}

function positionAt(text: string, offset: number) {
	const before = text.slice(0, offset);
	const lineStart = before.lastIndexOf("\n") + 1;
	return { line: before.split("\n").length - 1, character: offset - lineStart };
}

function rangeForText(text: string, value: string, from = 0): Range {
	const start = text.indexOf(value, from);
	if (start === -1) throw new Error(`missing test text: ${value}`);
	return { start: positionAt(text, start), end: positionAt(text, start + value.length) };
}

function site(text: string, value: string, from = 0) {
	return { range: rangeForText(text, value, from) };
}

function applyEdits(text: string, edits: TextEdit[]): string {
	let result = text;
	for (const edit of [...edits].reverse()) {
		const start = offsetAt(result, edit.range.start);
		const end = offsetAt(result, edit.range.end);
		result = `${result.slice(0, start)}${edit.newText}${result.slice(end)}`;
	}
	return result;
}

function offsetAt(text: string, position: { line: number; character: number }): number {
	return (
		text
			.split("\n")
			.slice(0, position.line)
			.reduce((offset, line) => offset + line.length + 1, 0) + position.character
	);
}

function syntaxErrors(text: string, module = "rename.ts"): readonly ts.Diagnostic[] {
	const source = ts.createSourceFile(module, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	return (source as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
}

function rename(root: string, request: RenameEditsRequest) {
	const provider = new TypeScriptProvider();
	provider.initialize(root);
	const response = provider.renameEdits(request);
	provider.shutdown();
	return response;
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("rename edits", () => {
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
		expect(applyEdits(text, response.edits)).toBe(
			"export const newName = 1;\nexport function run() { return newName; }\n",
		);
		expect(syntaxErrors(applyEdits(text, response.edits))).toEqual([]);
	});

	it("applies a rename after an astral character on the same line", () => {
		const text = 'const marker = "😀"; const oldName = 1;\noldName;\n';
		const response = rename(workspace({ "astral.ts": text }), {
			module: "astral.ts",
			text,
			oldName: "oldName",
			newName: "newName",
			sites: [site(text, "oldName"), site(text, "oldName", text.indexOf("oldName;"))],
		});

		if (response.status !== "ready") throw new Error("rename was refused");
		const renamed = applyEdits(text, response.edits);
		expect(renamed).toBe('const marker = "😀"; const newName = 1;\nnewName;\n');
		expect(syntaxErrors(renamed)).toEqual([]);
	});

	it("expands object and destructuring shorthand without changing the property key", () => {
		const objectText = "const oldName = 1;\nconst value = { oldName };\n";
		const objectResponse = rename(workspace({ "object.ts": objectText }), {
			module: "object.ts",
			text: objectText,
			oldName: "oldName",
			newName: "newName",
			sites: [site(objectText, "oldName"), site(objectText, "oldName", objectText.indexOf("{ oldName"))],
		});
		if (objectResponse.status !== "ready") throw new Error("object rename was refused");
		expect(objectResponse.edits[1]).toEqual({
			range: rangeForText(objectText, "oldName", objectText.indexOf("{ oldName")),
			newText: "oldName: newName",
		});
		expect(syntaxErrors(applyEdits(objectText, objectResponse.edits))).toEqual([]);

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
		expect(syntaxErrors(applyEdits(destructuringText, destructuringResponse.edits))).toEqual([]);
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
