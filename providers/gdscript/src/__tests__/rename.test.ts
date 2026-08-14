import path from "node:path";
import { applyEdits, coordinatesOf, type RenameSite } from "@nyaa-lexicon/protocol";
import { expect, test } from "vitest";
import { extractFile } from "../extract.js";
import { GDScriptProvider } from "../main.js";

function rangeFor(text: string, value: string) {
	const offset = text.indexOf(value);
	if (offset < 0) throw new Error(`test text missing ${value}`);
	const range = coordinatesOf(text).rangeAt(offset, offset + value.length);
	if (range === undefined) throw new Error(`test range is outside text: ${value}`);
	return range;
}

test("returns non-overlapping edits that reparse when applied in response order", () => {
	const provider = new GDScriptProvider();
	provider.initialize("/workspace");
	const text = `class_name RenameFixture
var old_value := 1
func run() -> void:
	old_value += 1
`;
	const parsed = provider.parseFile({ module: "rename.gd", contentHash: "rename", text });
	const sites: RenameSite[] = parsed.references
		.filter((reference) => reference.name === "old_value")
		.map((reference) => ({ range: reference.range, role: reference.role }));
	const declaration = parsed.declarations.find((candidate) => candidate.name === "old_value");
	if (declaration === undefined) throw new Error("test declaration missing");
	sites.push({ range: declaration.selectionRange });

	const result = provider.renameEdits({
		module: "rename.gd",
		text,
		oldName: "old_value",
		newName: "new_value",
		sites,
	});

	expect(result).toMatchObject({ status: "ready", blocked: [] });
	if (result.status !== "ready") return;
	expect(result.edits).toHaveLength(2);
	const rewritten = applyEdits(text, result.edits);
	if ("problem" in rewritten) throw new Error(rewritten.problem);
	expect(() => extractFile("rename.gd", rewritten.text)).not.toThrow();
	expect(
		extractFile("rename.gd", rewritten.text).declarations.some((declaration) => declaration.name === "new_value"),
	).toBe(true);
	expect(result.edits[0]?.range.start.line).toBeGreaterThanOrEqual(result.edits[1]?.range.start.line ?? 0);
});

test("refuses a position between CRLF terminators", () => {
	const provider = new GDScriptProvider();
	provider.initialize("/workspace");
	const text = "var old_name := 1\r\n";

	expect(
		provider.renameEdits({
			module: "crlf.gd",
			text,
			oldName: "old_name",
			newName: "new_name",
			sites: [{ range: { start: { line: 0, character: 18 }, end: { line: 0, character: 18 } } }],
		}),
	).toEqual({ status: "refused", reason: "ParseError", detail: "a rename site has an invalid range" });
});

test("refuses illegal, reserved, and colliding names", () => {
	const provider = new GDScriptProvider();
	provider.initialize("/workspace");
	const text = "var old_name := 1\nvar taken := 2\n";
	const site = { range: { start: { line: 0, character: 4 }, end: { line: 0, character: 12 } } };

	expect(
		provider.renameEdits({ module: "names.gd", text, oldName: "old_name", newName: "1name", sites: [site] }),
	).toEqual({
		status: "refused",
		reason: "InvalidName",
		detail: "the new name is not a legal GDScript identifier",
	});
	expect(
		provider.renameEdits({ module: "names.gd", text, oldName: "old_name", newName: "class", sites: [site] }),
	).toEqual({
		status: "refused",
		reason: "ReservedWord",
		detail: "the new name is a GDScript keyword",
	});
	expect(
		provider.renameEdits({ module: "names.gd", text, oldName: "old_name", newName: "taken", sites: [site] }),
	).toEqual({
		status: "refused",
		reason: "Collision",
		detail: "the new name already exists in this GDScript file",
	});
	expect(
		provider.renameEdits({
			module: "parameter.gd",
			text: "func run(taken):\n\tvar old_name := 1\n",
			oldName: "old_name",
			newName: "taken",
			sites: [{ range: { start: { line: 1, character: 5 }, end: { line: 1, character: 13 } } }],
		}),
	).toEqual({
		status: "refused",
		reason: "Collision",
		detail: "the new name already exists as a function parameter",
	});
});

test("blocks class_name and exported property contracts", () => {
	const provider = new GDScriptProvider();
	provider.initialize("/workspace");
	const classText = "class_name OldClass\nextends Node\n";
	const classFacts = provider.parseFile({ module: "class.gd", contentHash: "class", text: classText });
	const classDeclaration = classFacts.declarations.find((declaration) => declaration.name === "OldClass");
	if (classDeclaration === undefined) throw new Error("test class declaration missing");
	const classResult = provider.renameEdits({
		module: "class.gd",
		text: classText,
		oldName: "OldClass",
		newName: "NewClass",
		sites: [{ range: classDeclaration.selectionRange }],
	});
	expect(classResult).toMatchObject({ status: "ready", blocked: [{ reason: "ExternalContract" }] });

	const exportText = "@export var old_value := 1\n";
	const exportFacts = provider.parseFile({ module: "export.gd", contentHash: "export", text: exportText });
	const exportDeclaration = exportFacts.declarations.find((declaration) => declaration.name === "old_value");
	if (exportDeclaration === undefined) throw new Error("test export declaration missing");
	const exportResult = provider.renameEdits({
		module: "export.gd",
		text: exportText,
		oldName: "old_value",
		newName: "new_value",
		sites: [{ range: exportDeclaration.selectionRange }],
	});
	expect(exportResult).toMatchObject({ status: "ready", blocked: [{ reason: "ExternalContract" }] });
});

test("blocks dynamic loaders and signal string sites while the scanner omits signal strings", () => {
	const provider = new GDScriptProvider();
	provider.initialize("/workspace");
	const text = `signal old_signal
func run(path: String) -> void:
	load(path)
	emit_signal("old_signal")
`;
	const parsed = provider.parseFile({ module: "signals.gd", contentHash: "signals", text });
	expect(parsed.references.some((reference) => reference.name === "old_signal")).toBe(false);
	const signal = parsed.declarations.find((declaration) => declaration.name === "old_signal");
	const loader = parsed.references.find((reference) => reference.name === "load");
	if (signal === undefined || loader === undefined) throw new Error("test signal sites missing");

	const signalResult = provider.renameEdits({
		module: "signals.gd",
		text,
		oldName: "old_signal",
		newName: "new_signal",
		sites: [{ range: signal.selectionRange }],
	});
	expect(signalResult).toMatchObject({ status: "ready", blocked: [{ reason: "StringLiteral" }] });

	const loaderResult = provider.renameEdits({
		module: "signals.gd",
		text,
		oldName: "load",
		newName: "fetch",
		sites: [{ range: loader.range, role: loader.role }],
	});
	expect(loaderResult).toMatchObject({ status: "ready", blocked: [{ reason: "NotImplemented" }] });
});

test("blocks resource paths and local-only preload bindings", () => {
	const provider = new GDScriptProvider();
	provider.initialize("/workspace");
	const text = `const LocalScript = preload("res://old.gd")
`;

	const localResult = provider.renameEdits({
		module: "imports.gd",
		text,
		oldName: "LocalScript",
		newName: "RenamedScript",
		sites: [{ range: rangeFor(text, "LocalScript"), role: "import" }],
	});
	expect(localResult).toMatchObject({ status: "ready", blocked: [{ reason: "ExternalContract" }] });

	const pathResult = provider.renameEdits({
		module: "imports.gd",
		text,
		oldName: "old.gd",
		newName: "RenamedPath",
		sites: [{ range: rangeFor(text, "res://old.gd"), role: "import" }],
	});
	expect(pathResult).toMatchObject({ status: "ready", blocked: [{ reason: "ExternalContract" }] });
});

test("refuses a class_name collision from the project registry", () => {
	const provider = new GDScriptProvider();
	const fixtureRoot = path.join(process.cwd(), "providers/gdscript/src/__tests__/fixtures/autoload");
	provider.initialize(fixtureRoot);

	expect(
		provider.renameEdits({
			module: "user.gd",
			text: "var old_name := 1\n",
			oldName: "old_name",
			newName: "State",
			sites: [{ range: { start: { line: 0, character: 4 }, end: { line: 0, character: 12 } } }],
		}),
	).toEqual({
		status: "refused",
		reason: "Collision",
		detail: "the new name is already a registered class_name",
	});
});
