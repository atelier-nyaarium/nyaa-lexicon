import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeAll } from "../applyEdits";

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
