import { describe, expect, it } from "bun:test";
import path from "node:path";
import ts from "typescript";
import { FORMS } from "../conformance/stringForms.js";
import { codeOnly, readSwept, sourceFiles } from "../residue.js";

const TYPESCRIPT = FORMS["typescript"] as { real: readonly string[]; lines: readonly string[] };

describe("codeOnly", () => {
	it("keeps a comment marker inside every string form the language has", () => {
		// Rule 12's corollary: each hole in the string grammar surfaces as a false comment, so the
		// guard is a marker planted inside each form. The corpus already owns that table.
		const swept = codeOnly(TYPESCRIPT.lines.join("\n"));
		const kept = [...swept.matchAll(/MARK [a-z]/g)].map((match) => match[0]);
		const planted = [...TYPESCRIPT.lines.join("\n").matchAll(/MARK [a-z]/g)].map((match) => match[0]);
		expect(planted.length).toBeGreaterThan(8);
		expect(kept).toEqual(planted);
	});

	it("blanks a real comment", () => {
		for (const comment of TYPESCRIPT.real) {
			expect(codeOnly(`const x = 1; ${comment}`).trim()).toBe("const x = 1;");
		}
	});

	it("does not let a string swallow the code after it", () => {
		// Both defeated a pattern-based stripper, which deleted the violation rather than reporting it.
		expect(codeOnly(`const url = "http://host"; const stamp = Date.now();`)).toContain("Date.now");
		expect(codeOnly(`const open = "/*";\nconst stamp = Date.now();\nconst close = "*/";`)).toContain("Date.now");
	});

	it("reads a regular expression as a value, not as a comment", () => {
		expect(codeOnly(`const re = /\\/\\*[\\s\\S]*?\\*\\//g;\nDate.now();`)).toContain("Date.now");
		expect(codeOnly(`const path = /^[A-Za-z]:\\//.test(x);\nDate.now();`)).toContain("Date.now");
	});

	it("reads division as division", () => {
		expect(codeOnly(`const ratio = a / b / c; // gone\nDate.now();`)).toContain("Date.now");
		expect(codeOnly(`const ratio = a / b / c; // gone`)).not.toContain("gone");
	});

	it("sweeps a comment out of a template hole, and keeps the template's own text", () => {
		const source = "const t = `a ${/* gone */ value} b`;";
		const swept = codeOnly(source);
		expect(swept).not.toContain("gone");
		expect(swept).toContain("`a ${");
		expect(swept).toContain("value} b`;");
		expect(swept).toHaveLength(source.length);
	});

	it("returns a mask: same length, line endings intact", () => {
		const source = `/* one\ntwo */ const x = 1; // three\n`;
		const swept = codeOnly(source);
		expect(swept.length).toBe(source.length);
		expect([...swept].filter((character) => character === "\n")).toHaveLength(2);
	});
});

describe("codeOnly against the TypeScript parser", () => {
	const root = path.join(import.meta.dirname, "..", "..", "..");
	const files = ["protocol", "core", "client", "adapters", "providers", "formats"].flatMap((package_) =>
		sourceFiles(path.join(root, package_), ["node_modules", ".tsbuild", "dist", "temp"]),
	);

	it("found files to check", () => {
		expect(files.length).toBeGreaterThan(200);
	});

	// Only the safe direction is asserted. The walk below finds real comments and may miss some, so
	// every comment it DOES find must be blanked; a comment it misses is not evidence of anything.
	it("blanks every comment the parser finds", () => {
		const offenders: string[] = [];
		for (const file of files) {
			const text = readSwept(file);
			if (text === null) continue;
			const swept = codeOnly(text);
			const source = ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true);
			const walk = (node: ts.Node): void => {
				for (const range of ts.getLeadingCommentRanges(text, node.getFullStart()) ?? []) {
					const kept = swept.slice(range.pos, range.end).replace(/[\s]/g, "");
					if (kept !== "")
						offenders.push(`${path.relative(root, file)}:${range.pos} kept ${JSON.stringify(kept)}`);
				}
				for (const child of node.getChildren(source)) walk(child);
			};
			walk(source);
		}
		expect(offenders).toEqual([]);
	});
});
