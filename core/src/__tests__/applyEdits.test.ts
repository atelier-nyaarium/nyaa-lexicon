import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { stageAll } from "../applyEdits";
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

beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), "lexicon-apply-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

////////////////////////////////
//  Tests

describe("staging a whole rename", () => {
	it("stages every file when every file can be spliced", () => {
		write("a.ts", "add();\n");
		write("b.ts", "add();\n");

		const outcome = stageAll(
			[
				{ module: "a.ts", edits: [edit(0, 0, 3, "sum")] },
				{ module: "b.ts", edits: [edit(0, 0, 3, "sum")] },
			],
			sourceReader(root),
		);

		expect(outcome).toEqual({
			staged: [
				{ module: "a.ts", text: "sum();\n" },
				{ module: "b.ts", text: "sum();\n" },
			],
		});
	});

	it("refuses the whole set when any file is gone, has unusable edits, or is not valid UTF-8", () => {
		write("a.ts", "add();\n");
		write("b.ts", "add();\n");
		write("lossy.ts", Buffer.from([...Buffer.from("add();\n// "), 0xc3, 0x28, 0x0a]));
		const stage = (module: string, edits = [edit(0, 0, 3, "sum")]) =>
			stageAll(
				[
					{ module: "a.ts", edits: [edit(0, 0, 3, "sum")] },
					{ module, edits },
				],
				sourceReader(root),
			);

		expect([
			stage("gone.ts"),
			stage("b.ts", [edit(0, 0, 3, "sum"), edit(0, 1, 4, "x")]),
			stage("lossy.ts"),
		]).toMatchObject([
			{ applied: false, module: "gone.ts" },
			{ applied: false, module: "b.ts" },
			{ applied: false, module: "lossy.ts", reason: expect.stringContaining("lossy.ts") },
		]);
	});

	it("keeps a BOM and non-ASCII text outside the edit", () => {
		write("a.ts", "\u{FEFF}add(); // caf\u{E9} \u{1F600}\n");

		const outcome = stageAll([{ module: "a.ts", edits: [edit(0, 1, 4, "sum")] }], sourceReader(root));

		expect(outcome).toEqual({ staged: [{ module: "a.ts", text: "\u{FEFF}sum(); // caf\u{E9} \u{1F600}\n" }] });
	});
});
