import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { GDScriptProvider, TIERS } from "../main.js";

const PROVIDER_ROOT = path.join(process.cwd(), "providers/gdscript");

function diagnostics(text: string, module = "broken.gd") {
	return new GDScriptProvider().parseFile({ module, contentHash: "diagnostics", text }).diagnostics;
}

function providerSourceFiles(directory: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const full = path.join(directory, entry.name);
		if (entry.isDirectory()) files.push(...providerSourceFiles(full));
		else if (entry.isFile() && (entry.name.endsWith(".gd") || entry.name === "project.godot")) files.push(full);
	}
	return files.sort();
}

test("reports an opening delimiter left unclosed at end of file", () => {
	expect(TIERS.syntaxDiagnostics).toBe(true);
	expect(diagnostics("var values = [\n")).toEqual([
		{
			severity: "error",
			message: 'Opening "[" is not closed before end of file.',
			path: "broken.gd",
			range: { start: { line: 0, character: 13 }, end: { line: 0, character: 14 } },
		},
	]);
});

test.each([
	["single-line", 'var value = "broken\n'],
	["multiline", 'var value = """broken\n'],
])("reports a %s string without a closing quote", (_kind, text) => {
	expect(diagnostics(text)).toEqual([
		{
			severity: "error",
			message: "String literal has no closing quote.",
			path: "broken.gd",
			range: { start: { line: 0, character: 12 }, end: { line: 0, character: 13 } },
		},
	]);
});

test("reports a dedent to an indentation level that was not opened", () => {
	const text = "func run():\n    if ready:\n        pass\n  return\n";

	expect(diagnostics(text)).toEqual([
		{
			severity: "error",
			message: "Indentation dedents to a level that was not opened.",
			path: "broken.gd",
			range: { start: { line: 3, character: 0 }, end: { line: 3, character: 2 } },
		},
	]);
});

test("reports a block header without an indented body", () => {
	const text = "func run():\n# comment\nvar after = 1\n";

	expect(diagnostics(text)).toEqual([
		{
			severity: "error",
			message: "Block header has no indented body.",
			path: "broken.gd",
			range: { start: { line: 0, character: 10 }, end: { line: 0, character: 11 } },
		},
	]);
});

test("keeps string and expression continuations out of indentation diagnostics", () => {
	const text = [
		"func run():",
		'\t"""body',
		"arbitrary: [",
		'\t"""',
		"\tvar values = [",
		"\t\t1,",
		"\t]",
		"\tvar sum = 1 + \\",
		"\t\t2",
		'\tvar text = "one\\',
		'two"',
		'\tif true: "body"',
		"",
	].join("\n");

	expect(diagnostics(text)).toEqual([]);
});

test("reports no syntax diagnostics for checked-in provider sources", () => {
	const files = providerSourceFiles(PROVIDER_ROOT);
	expect(files.length).toBeGreaterThan(0);

	for (const file of files) {
		const module = path.relative(PROVIDER_ROOT, file).split(path.sep).join("/");
		expect(diagnostics(readFileSync(file, "utf8"), module), module).toEqual([]);
	}
});
