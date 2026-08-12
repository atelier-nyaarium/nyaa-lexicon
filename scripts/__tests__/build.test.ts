import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	dirtyTrackedFiles,
	expandWorkspaceEntry,
	nextVersion,
	readVersion,
	setVersion,
	versionTargets,
} from "../build";

////////////////////////////////
//  Helpers

let root: string;

function pkg(dir: string, version = "1.2.3", extra = ""): void {
	mkdirSync(path.join(root, dir), { recursive: true });
	writeFileSync(path.join(root, dir, "package.json"), `{\n\t"name": "x",\n\t"version": "${version}"${extra}\n}\n`);
}

/** The plugin manifest the marketplace reads, which every bump has to move too. */
function manifest(version = "1.2.3"): void {
	mkdirSync(path.join(root, ".claude-plugin"), { recursive: true });
	writeFileSync(
		path.join(root, ".claude-plugin", "plugin.json"),
		`{\n\t"name": "lexicon",\n\t"version": "${version}"\n}\n`,
	);
}

beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), "lexicon-build-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

////////////////////////////////
//  Tests

describe("nextVersion", () => {
	it("bumps each component and zeroes the ones below it", () => {
		expect(nextVersion("1.2.3", "patch")).toBe("1.2.4");
		expect(nextVersion("1.2.3", "minor")).toBe("1.3.0");
		expect(nextVersion("1.2.3", "major")).toBe("2.0.0");
	});

	it("carries past 9 rather than treating components as digits", () => {
		expect(nextVersion("0.9.9", "patch")).toBe("0.9.10");
		expect(nextVersion("0.9.9", "minor")).toBe("0.10.0");
	});

	it("refuses anything that is not plain major.minor.patch", () => {
		expect(() => nextVersion("1.2", "patch")).toThrow();
		expect(() => nextVersion("1.2.3-rc.1", "patch")).toThrow();
		expect(() => nextVersion("v1.2.3", "patch")).toThrow();
	});
});

describe("setVersion / readVersion", () => {
	it("rewrites only the version, leaving every other byte alone", () => {
		const before = '{\n\t"name": "x",\n\t"version": "1.2.3",\n\t"private": true\n}\n';
		const after = setVersion(before, "1.3.0");
		expect(after).toBe('{\n\t"name": "x",\n\t"version": "1.3.0",\n\t"private": true\n}\n');
	});

	it("round-trips through readVersion", () => {
		expect(readVersion(setVersion('{"version": "0.0.1"}', "9.8.7"))).toBe("9.8.7");
	});

	it("refuses a file with two version fields rather than guessing which one", () => {
		const two = '{"version": "1.0.0", "deps": {"version": "2.0.0"}}';
		expect(() => setVersion(two, "1.0.1")).toThrow(/found 2/);
		expect(() => readVersion(two)).toThrow(/found 2/);
	});

	it("refuses a file with no version field", () => {
		expect(() => readVersion('{"name": "x"}')).toThrow(/found 0/);
	});
});

describe("expandWorkspaceEntry", () => {
	it("resolves a literal entry to its package.json", () => {
		pkg("core");
		expect(expandWorkspaceEntry(root, "core")).toEqual([path.join("core", "package.json")]);
	});

	it("throws on a literal entry with no package.json, since that means the list is stale", () => {
		expect(() => expandWorkspaceEntry(root, "core")).toThrow(/out of date/);
	});

	it("expands a star entry to every package under it, sorted", () => {
		pkg(path.join("adapters", "mcp"));
		pkg(path.join("adapters", "lsp"));
		expect(expandWorkspaceEntry(root, "adapters/*")).toEqual([
			path.join("adapters", "lsp", "package.json"),
			path.join("adapters", "mcp", "package.json"),
		]);
	});

	it("allows a star entry to match nothing, because providers/ is empty until the first one lands", () => {
		mkdirSync(path.join(root, "providers"), { recursive: true });
		expect(expandWorkspaceEntry(root, "providers/*")).toEqual([]);
	});

	it("throws when the star entry's directory is gone entirely", () => {
		expect(() => expandWorkspaceEntry(root, "providers/*")).toThrow(/is gone/);
	});

	it("ignores a directory under a star entry that has no package.json", () => {
		mkdirSync(path.join(root, "providers", "scratch"), { recursive: true });
		expect(expandWorkspaceEntry(root, "providers/*")).toEqual([]);
	});
});

describe("versionTargets", () => {
	it("puts the root first, then every workspace package, then the plugin manifest", () => {
		pkg(".", "1.2.3", ',\n\t"workspaces": ["core", "adapters/*"]');
		pkg("core");
		pkg(path.join("adapters", "mcp"));
		manifest();

		expect(versionTargets(root)).toEqual([
			"package.json",
			path.join("core", "package.json"),
			path.join("adapters", "mcp", "package.json"),
			path.join(".claude-plugin", "plugin.json"),
		]);
	});

	it("refuses a root with no workspaces, since this script assumes a monorepo", () => {
		pkg(".");
		expect(() => versionTargets(root)).toThrow(/no workspaces/);
	});

	// A manifest left behind is how an installed plugin stops updating: the marketplace compares
	// against a version the bundle no longer matches, and nothing anywhere says so.
	it("refuses a tree with no plugin manifest, rather than bumping everything else", () => {
		pkg(".", "1.2.3", ',\n\t"workspaces": ["core"]');
		pkg("core");

		expect(() => versionTargets(root)).toThrow(/marketplace reads it/);
	});
});

describe("dirtyTrackedFiles", () => {
	it("reports ordinary changes", () => {
		const line = "1 .M N... 100644 100644 100644 aaa bbb core/src/index.ts";
		expect(dirtyTrackedFiles(line)).toEqual(["core/src/index.ts"]);
	});

	it("ignores untracked and ignored entries, so a scratch file cannot block a release", () => {
		const out = ["? scratch.ts", "! node_modules/", "# branch.oid aaa"].join("\n");
		expect(dirtyTrackedFiles(out)).toEqual([]);
	});

	it("ignores tracked files under root and workspace dist directories", () => {
		const out = [
			"1 .M N... 100644 100644 100644 aaa bbb dist/main.js",
			"1 .M N... 100644 100644 100644 aaa bbb core/dist/index.js",
			"1 .M N... 100644 100644 100644 aaa bbb core/src/index.ts",
		].join("\n");
		expect(dirtyTrackedFiles(out)).toEqual(["core/src/index.ts"]);
	});

	it("takes the new path from a rename record, not the original", () => {
		const line = "2 R. N... 100644 100644 100644 aaa bbb R100 new/path.ts\told/path.ts";
		expect(dirtyTrackedFiles(line)).toEqual(["new/path.ts"]);
	});

	it("handles a path containing spaces, which is why fields are cut by offset", () => {
		const line = "1 .M N... 100644 100644 100644 aaa bbb docs/my notes.md";
		expect(dirtyTrackedFiles(line)).toEqual(["docs/my notes.md"]);
	});

	it("reports unmerged entries", () => {
		const line = "u UU N... 100644 100644 100644 100644 aaa bbb ccc conflict.ts";
		expect(dirtyTrackedFiles(line)).toEqual(["conflict.ts"]);
	});
});
