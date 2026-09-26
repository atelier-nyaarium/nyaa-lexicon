import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readWorkspaceFile, readWorkspaceHead } from "../sourceFile";
import { resolveContained } from "../workspacePath";

////////////////////////////////
//  Helpers

let root: string;
let outside: string;

function put(dir: string, relative: string, text = ""): void {
	const full = path.join(dir, relative);
	mkdirSync(path.dirname(full), { recursive: true });
	writeFileSync(full, text);
}

function link(target: string, relative: string): void {
	const full = path.join(root, relative);
	mkdirSync(path.dirname(full), { recursive: true });
	symlinkSync(target, full);
}

beforeEach(() => {
	root = realpathSync(mkdtempSync(path.join(tmpdir(), "lexicon-contained-")));
	outside = realpathSync(mkdtempSync(path.join(tmpdir(), "lexicon-outside-")));
	put(root, "inner/real.ts", "#!/usr/bin/env bun\ninside\n");
	put(outside, "secret.ts", "#!/usr/bin/env bun\nsecret\n");
	link(path.join(outside, "secret.ts"), "file-out.ts");
	link(outside, "dir-out");
	link(path.join(root, "inner", "real.ts"), "file-in.ts");
	link(path.join(root, "inner"), "dir-in");
	link(path.join(outside, "gone.ts"), "dangling.ts");
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
	rmSync(outside, { recursive: true, force: true });
});

////////////////////////////////
//  Tests

describe("where a module's real path lands", () => {
	it("follows a leaf to its real file, and refuses one that leaves the root", () => {
		const real = path.join(root, "inner", "real.ts");
		expect({
			plain: resolveContained(root, "inner/real.ts"),
			fileIn: resolveContained(root, "file-in.ts"),
			dirIn: resolveContained(root, "dir-in/real.ts"),
			fileOut: resolveContained(root, "file-out.ts"),
			dirOut: resolveContained(root, "dir-out/secret.ts"),
			escape: resolveContained(root, "../secret.ts"),
		}).toEqual({
			plain: { kind: "file", path: real },
			fileIn: { kind: "file", path: real },
			dirIn: { kind: "file", path: real },
			fileOut: { kind: "outside" },
			dirOut: { kind: "outside" },
			escape: { kind: "outside" },
		});
	});

	it("judges a path not on disk by its nearest existing ancestor", () => {
		expect({
			created: resolveContained(root, "new/deeper/a.ts"),
			dangling: resolveContained(root, "dangling.ts"),
			throughOut: resolveContained(root, "dir-out/new/a.ts"),
		}).toEqual({
			created: { kind: "absent", path: path.join(root, "new", "deeper", "a.ts") },
			dangling: { kind: "absent", path: path.join(root, "dangling.ts") },
			throughOut: { kind: "outside" },
		});
	});

	// A no-follow read or a rename replaces the leaf link, never reaching its target.
	it("keeps a leaf where it sits, while still refusing a parent link that leaves the root", () => {
		expect({
			fileOut: resolveContained(root, "file-out.ts", "keep"),
			dangling: resolveContained(root, "dangling.ts", "keep"),
			dirOut: resolveContained(root, "dir-out/secret.ts", "keep"),
			dirIn: resolveContained(root, "dir-in/real.ts", "keep"),
		}).toEqual({
			fileOut: { kind: "file", path: path.join(root, "file-out.ts") },
			dangling: { kind: "file", path: path.join(root, "dangling.ts") },
			dirOut: { kind: "outside" },
			dirIn: { kind: "file", path: path.join(root, "dir-in", "real.ts") },
		});
	});

	it("answers a root reached through a link as the same workspace", () => {
		const alias = path.join(outside, "alias");
		symlinkSync(root, alias);
		expect(resolveContained(alias, "inner/real.ts")).toEqual({
			kind: "file",
			path: path.join(root, "inner", "real.ts"),
		});
	});
});

describe("reading a module inside the workspace", () => {
	it("reads through a link that stays inside, and refuses one that leaves", () => {
		expect({
			fileIn: readWorkspaceFile(root, "file-in.ts"),
			dirIn: readWorkspaceFile(root, "dir-in/real.ts").kind,
			fileOut: readWorkspaceFile(root, "file-out.ts"),
			dirOut: readWorkspaceFile(root, "dir-out/secret.ts"),
			dangling: readWorkspaceFile(root, "dangling.ts"),
			directory: readWorkspaceFile(root, "inner"),
		}).toEqual({
			fileIn: { kind: "text", text: "#!/usr/bin/env bun\ninside\n", lossless: true },
			dirIn: "text",
			fileOut: { kind: "outside" },
			dirOut: { kind: "outside" },
			dangling: { kind: "missing" },
			directory: { kind: "missing" },
		});
	});

	it("reads a shebang line only from a file inside", () => {
		expect([
			readWorkspaceHead(root, "file-in.ts"),
			readWorkspaceHead(root, "file-out.ts"),
			readWorkspaceHead(root, "dangling.ts"),
		]).toEqual(["#!/usr/bin/env bun", undefined, undefined]);
	});
});
