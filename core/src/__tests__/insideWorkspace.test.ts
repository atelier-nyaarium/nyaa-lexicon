import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { insideWorkspace } from "../sourceRead";

const made: string[] = [];

function scratch(): string {
	const dir = mkdtempSync(path.join(tmpdir(), "lexicon-inside-"));
	made.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("where a write may land", () => {
	it("answers the absolute path of a module under the root, created directories included", () => {
		const root = scratch();
		expect(insideWorkspace(root, "src/a.ts")).toBe(path.join(root, "src", "a.ts"));
		expect(insideWorkspace(root, "new/deeper/b.ts")).toBe(path.join(root, "new", "deeper", "b.ts"));
	});

	it("refuses a module that names its way out of the root", () => {
		const root = scratch();
		expect(() => insideWorkspace(root, "../secret.md")).toThrow(/module path must/);
		expect(() => insideWorkspace(root, "/etc/passwd")).toThrow(/module path must/);
	});

	// A link inside the workspace pointing outside it: the name stays inside, the bytes would not.
	it("refuses a write that would land outside the real root through a linked directory", () => {
		const root = scratch();
		const outside = scratch();
		symlinkSync(outside, path.join(root, "linkdir"));
		mkdirSync(path.join(root, "inner"));
		symlinkSync(path.join(root, "inner"), path.join(root, "innerlink"));
		writeFileSync(path.join(root, "inner", "ok.ts"), "");

		expect(() => insideWorkspace(root, "linkdir/new.ts")).toThrow(/through a link/);
		expect(() => insideWorkspace(root, "linkdir/deeper/new.ts")).toThrow(/through a link/);
		// A link that stays inside is fine, and so is a root reached through its own real path.
		expect(insideWorkspace(root, "innerlink/ok.ts")).toBe(path.join(root, "innerlink", "ok.ts"));
		expect(insideWorkspace(realpathSync(root), "inner/ok.ts")).toBe(
			path.join(realpathSync(root), "inner", "ok.ts"),
		);
	});
});
