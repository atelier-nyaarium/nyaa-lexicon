import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import { calleeOf, callsIn, parseSource } from "../astResidue";
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
			plain: { kind: "file", path: real, real: "inner/real.ts" },
			fileIn: { kind: "file", path: real, real: "inner/real.ts" },
			dirIn: { kind: "file", path: real, real: "inner/real.ts" },
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
			real: "inner/real.ts",
		});
	});
});

describe("reading a module inside the workspace", () => {
	it("opens resolved files without following a replacement link", () => {
		const file = path.join(import.meta.dir, "../sourceFile.ts");
		const source = parseSource(file, readFileSync(file, "utf8")).source;
		const guarded = (node: ts.Node): boolean => {
			if (ts.isPropertyAccessExpression(node) && node.name.text === "O_NOFOLLOW") return true;
			let found = false;
			ts.forEachChild(node, (child) => {
				found ||= guarded(child);
			});
			return found;
		};
		const calls = callsIn(source).filter((call) => calleeOf(call)?.name === "openSync");

		expect(calls.some((call) => call.arguments[1] !== undefined && guarded(call.arguments[1]))).toBe(true);
	});

	it("reads through a link that stays inside, and refuses one that leaves", () => {
		expect({
			fileIn: readWorkspaceFile(root, "file-in.ts"),
			dirIn: readWorkspaceFile(root, "dir-in/real.ts").kind,
			fileOut: readWorkspaceFile(root, "file-out.ts"),
			dirOut: readWorkspaceFile(root, "dir-out/secret.ts"),
			dangling: readWorkspaceFile(root, "dangling.ts"),
			directory: readWorkspaceFile(root, "inner"),
		}).toEqual({
			fileIn: { kind: "text", text: "#!/usr/bin/env bun\ninside\n", lossless: true, real: "inner/real.ts" },
			dirIn: "text",
			fileOut: { kind: "outside" },
			dirOut: { kind: "outside" },
			dangling: { kind: "missing" },
			directory: { kind: "missing" },
		});
	});

	it("decodes a UTF-16 file by its byte order mark, for reading only, and keeps a NUL-bearing file binary", () => {
		const text = `${String.fromCodePoint(0xfeff)}$x = 1\r\n`;
		writeFileSync(path.join(root, "le.ps1"), Buffer.from(text, "utf16le"));
		writeFileSync(path.join(root, "be.ps1"), Buffer.from(text, "utf16le").swap16());
		writeFileSync(path.join(root, "odd.ps1"), Buffer.concat([Buffer.from(text, "utf16le"), Buffer.from([0x41])]));
		writeFileSync(path.join(root, "nul.ts"), Buffer.from([0x61, 0x00, 0x62]));
		expect({
			le: readWorkspaceFile(root, "le.ps1"),
			be: readWorkspaceFile(root, "be.ps1"),
			odd: readWorkspaceFile(root, "odd.ps1").kind,
			nul: readWorkspaceFile(root, "nul.ts").kind,
		}).toEqual({
			le: { kind: "text", text, lossless: false, encoding: "utf-16le", real: "le.ps1" },
			be: { kind: "text", text, lossless: false, encoding: "utf-16be", real: "be.ps1" },
			odd: "binary",
			nul: "binary",
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
