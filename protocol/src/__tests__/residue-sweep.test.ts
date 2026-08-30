import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codeOnly, readSwept, sourceFiles } from "../residue.js";

////////////////////////////////
//  Tests

describe("sweeping a tree that another test is writing into", () => {
	it("answers null for a file that vanished between the listing and the read", () => {
		const root = mkdtempSync(join(tmpdir(), "residue-sweep-"));
		try {
			mkdirSync(join(root, "src"));
			const kept = join(root, "src", "kept.ts");
			const doomed = join(root, "src", "doomed.mutant-0.ts");
			writeFileSync(kept, "export const a = 1;\n");
			writeFileSync(doomed, "export const b = 2;\n");

			// The listing is one moment and the read is another, which is the race itself.
			const listed = sourceFiles(root, []);
			expect(listed).toHaveLength(2);
			rmSync(doomed);

			expect(readSwept(doomed)).toBeNull();
			expect(listed.map((file) => readSwept(file)).filter((source) => source !== null)).toHaveLength(1);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	// A dangling link is listed and cannot be stat'ed, which is the shape of a file removed in between.
	it("skips a path that vanished between the listing and its stat", () => {
		const root = mkdtempSync(join(tmpdir(), "residue-sweep-"));
		try {
			mkdirSync(join(root, "src"));
			writeFileSync(join(root, "src", "kept.ts"), "export const a = 1;\n");
			symlinkSync(join(root, "src", "gone.mutant-0.ts"), join(root, "src", "dangling.ts"));

			expect(sourceFiles(root, []).map((file) => file.split("/").pop())).toEqual(["kept.ts"]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("still reads a file that is there", () => {
		const root = mkdtempSync(join(tmpdir(), "residue-sweep-"));
		try {
			const file = join(root, "a.ts");
			writeFileSync(file, "// a comment\nconst token = 1;\n");
			expect(codeOnly(readSwept(file) ?? "")).not.toContain("a comment");
			expect(codeOnly(readSwept(file) ?? "")).toContain("token");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
