import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeAll } from "../applyEdits";
import { sourceReader } from "../sourceRead";

////////////////////////////////
//  Helpers

let root: string;

function edit(line: number, from: number, to: number, newText: string) {
	return { range: { start: { line, character: from }, end: { line, character: to } }, newText };
}

function write(module: string, text: string | Uint8Array) {
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

function bytes(module: string): Buffer {
	return readFileSync(path.join(root, module));
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
			sourceReader(root),
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
			sourceReader(root),
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
			sourceReader(root),
		);

		expect(outcome).toMatchObject({ applied: false, module: "b.ts" });
		expect(read("a.ts")).toBe("add();\n");
	});

	// Its U+FFFD would be written over bytes no edit touched.
	it("writes nothing when one file is not valid UTF-8 away from its edits", () => {
		write("a.ts", "add();\n");
		const lossy = Buffer.from([...Buffer.from("add();\n// "), 0xc3, 0x28, 0x0a]);
		write("b.ts", lossy);

		const outcome = writeAll(
			root,
			[
				{ module: "a.ts", edits: [edit(0, 0, 3, "sum")] },
				{ module: "b.ts", edits: [edit(0, 0, 3, "sum")] },
			],
			sourceReader(root),
		);

		expect(outcome).toMatchObject({ applied: false, module: "b.ts", reason: expect.stringContaining("b.ts") });
		expect(read("a.ts")).toBe("add();\n");
		expect(bytes("b.ts").equals(lossy)).toBe(true);
	});

	it("keeps a BOM and non-ASCII text byte for byte outside the edit", () => {
		write("a.ts", "\u{FEFF}add(); // caf\u{E9} \u{1F600}\n");

		const outcome = writeAll(root, [{ module: "a.ts", edits: [edit(0, 1, 4, "sum")] }], sourceReader(root));

		expect(outcome).toEqual({ applied: true, modules: ["a.ts"] });
		expect(bytes("a.ts").equals(Buffer.from("\u{FEFF}sum(); // caf\u{E9} \u{1F600}\n", "utf8"))).toBe(true);
	});

	it("leaves no temporary files behind, so a workspace is never littered with them", () => {
		write("a.ts", "add();\n");
		writeAll(root, [{ module: "a.ts", edits: [edit(0, 0, 3, "sum")] }], sourceReader(root));

		expect(readdirSync(root)).toEqual(["a.ts"]);
	});
});
