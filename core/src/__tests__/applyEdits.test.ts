import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyEdits, writeAll } from "../applyEdits";

////////////////////////////////
//  Helpers

let root: string;

function edit(line: number, from: number, to: number, newText: string) {
	return { range: { start: { line, character: from }, end: { line, character: to } }, newText };
}

function write(module: string, text: string) {
	const full = path.join(root, module);
	mkdirSync(path.dirname(full), { recursive: true });
	writeFileSync(full, text);
}

function read(module: string): string | null {
	try {
		return readFileSync(path.join(root, module), "utf8");
	} catch {
		return null;
	}
}

beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), "lexicon-apply-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

////////////////////////////////
//  Tests

describe("applying edits to one file", () => {
	it("replaces a span", () => {
		expect(applyEdits("const add = 1;\n", [edit(0, 6, 9, "sum")])).toEqual({ text: "const sum = 1;\n" });
	});

	// The defect this function exists to prevent: an earlier replacement of a different length
	// moves every later coordinate, so applying in reading order corrupts everything after the
	// first edit whose replacement is not the same width.
	it("applies several edits without letting earlier ones shift later ones", () => {
		const text = "add(add, add);\n";
		const result = applyEdits(text, [edit(0, 0, 3, "sum"), edit(0, 4, 7, "total"), edit(0, 9, 12, "x")]);

		expect(result).toEqual({ text: "sum(total, x);\n" });
	});

	it("gives the same answer whatever order the provider returned them in", () => {
		const text = "add(add, add);\n";
		const forwards = [edit(0, 0, 3, "sum"), edit(0, 4, 7, "total"), edit(0, 9, 12, "x")];

		expect(applyEdits(text, [...forwards].reverse())).toEqual(applyEdits(text, forwards));
	});

	it("spans lines", () => {
		const result = applyEdits("a\nbb\nccc\n", [edit(1, 0, 2, "X"), edit(2, 1, 3, "Y")]);
		expect(result).toEqual({ text: "a\nX\ncY\n" });
	});

	// Two edits claiming the same characters is a provider bug. Picking a winner would turn a
	// detectable fault into a silently wrong file.
	it("refuses overlapping edits rather than choosing between them", () => {
		const result = applyEdits("const add = 1;\n", [edit(0, 6, 9, "sum"), edit(0, 8, 11, "x")]);
		expect(result).toEqual({ problem: "two edits overlap, so the result would depend on order" });
	});

	it("refuses an edit past the end of the file", () => {
		expect(applyEdits("a\n", [edit(9, 0, 1, "x")])).toMatchObject({ problem: expect.stringContaining("outside") });
	});
});

describe("writing a whole rename", () => {
	it("writes every file when every file can be written", () => {
		write("a.ts", "add();\n");
		write("b.ts", "add();\n");

		const outcome = writeAll(
			root,
			[
				{ module: "a.ts", edits: [edit(0, 0, 3, "sum")] },
				{ module: "b.ts", edits: [edit(0, 0, 3, "sum")] },
			],
			read,
		);

		expect(outcome).toEqual({ applied: true, modules: ["a.ts", "b.ts"] });
		expect(read("a.ts")).toBe("sum();\n");
		expect(read("b.ts")).toBe("sum();\n");
	});

	// The whole reason for the pre-check. A rename that succeeds in two files and fails in the
	// third leaves a tree that does not build, and no record of how far it got.
	it("writes nothing at all when any file would fail", () => {
		write("a.ts", "add();\n");

		const outcome = writeAll(
			root,
			[
				{ module: "a.ts", edits: [edit(0, 0, 3, "sum")] },
				{ module: "gone.ts", edits: [edit(0, 0, 3, "sum")] },
			],
			read,
		);

		expect(outcome).toMatchObject({ applied: false, module: "gone.ts" });
		expect(read("a.ts")).toBe("add();\n");
	});

	it("writes nothing when one file's edits are unusable, not just unreadable", () => {
		write("a.ts", "add();\n");
		write("b.ts", "add();\n");

		const outcome = writeAll(
			root,
			[
				{ module: "a.ts", edits: [edit(0, 0, 3, "sum")] },
				{ module: "b.ts", edits: [edit(0, 0, 3, "sum"), edit(0, 1, 4, "x")] },
			],
			read,
		);

		expect(outcome).toMatchObject({ applied: false, module: "b.ts" });
		expect(read("a.ts")).toBe("add();\n");
	});

	it("leaves no temporary files behind, so a workspace is never littered with them", () => {
		write("a.ts", "add();\n");
		writeAll(root, [{ module: "a.ts", edits: [edit(0, 0, 3, "sum")] }], read);

		expect(readdirSync(root)).toEqual(["a.ts"]);
	});
});
