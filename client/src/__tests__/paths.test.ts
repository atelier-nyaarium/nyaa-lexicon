import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { canonicalRoot, type PlatformEnv, stateRoot, storePaths, workspaceKey, workspacePaths } from "../paths";

////////////////////////////////
//  Helpers

const POSIX: PlatformEnv = { platform: "linux", env: {}, home: "/home/me" };
const WINDOWS: PlatformEnv = { platform: "win32", env: {}, home: "C:\\Users\\me" };

////////////////////////////////
//  Tests

describe("stateRoot", () => {
	it("follows the XDG convention on POSIX", () => {
		expect(stateRoot(POSIX)).toBe("/home/me/.local/state/nyaa-lexicon");
		expect(stateRoot({ ...POSIX, env: { XDG_STATE_HOME: "/custom" } })).toBe("/custom/nyaa-lexicon");
	});

	it("follows the Windows convention on Windows, which is the whole reason this file exists", () => {
		expect(stateRoot(WINDOWS)).toContain("AppData");
		expect(stateRoot({ ...WINDOWS, env: { LOCALAPPDATA: "D:\\State" } })).toContain("D:");
	});

	it("ignores an empty variable rather than rooting state at a relative path", () => {
		expect(stateRoot({ ...POSIX, env: { XDG_STATE_HOME: "" } })).toBe("/home/me/.local/state/nyaa-lexicon");
		expect(stateRoot({ ...WINDOWS, env: { LOCALAPPDATA: "" } })).toContain("AppData");
	});

	it("does not use the POSIX convention on Windows, nor the reverse", () => {
		expect(stateRoot({ ...WINDOWS, env: { XDG_STATE_HOME: "/should/be/ignored" } })).not.toContain("should");
		expect(stateRoot({ ...POSIX, env: { LOCALAPPDATA: "/should/be/ignored" } })).not.toContain("should");
	});
});

describe("canonicalRoot", () => {
	it("follows a symlink to the one path a workspace has, and keys both spellings alike", () => {
		const scratch = mkdtempSync(path.join(tmpdir(), "lexicon-real-"));
		try {
			const real = path.join(scratch, "real", "proj");
			const link = path.join(scratch, "link");
			mkdirSync(real, { recursive: true });
			symlinkSync(path.join(scratch, "real"), link);

			expect(canonicalRoot(path.join(link, "proj"))).toBe(canonicalRoot(real));
			expect(workspaceKey(path.join(link, "proj"))).toBe(workspaceKey(real));
			expect(canonicalRoot(path.join(link, "proj"))).not.toContain("link");
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	});

	it("resolves a path that does not exist textually, which is all that can be known of it", () => {
		expect(canonicalRoot("/nowhere/at/all/../proj")).toBe(path.resolve("/nowhere/at/proj"));
	});
});

describe("workspaceKey", () => {
	it("gives one workspace one key", () => {
		expect(workspaceKey("/home/me/proj")).toBe(workspaceKey("/home/me/proj"));
	});

	it("separates two checkouts that share a basename, which a name alone would collide", () => {
		expect(workspaceKey("/a/proj")).not.toBe(workspaceKey("/b/proj"));
	});

	it("keeps the basename readable so a state directory is recognizable by eye", () => {
		expect(workspaceKey("/home/me/nyaa-lexicon")).toMatch(/^nyaa-lexicon-[0-9a-f]{16}$/);
	});

	it("strips characters a directory name cannot carry", () => {
		expect(workspaceKey("/tmp/we:ird name")).toMatch(/^we-ird-name-[0-9a-f]{16}$/);
	});
});

describe("workspacePaths", () => {
	it("derives every path from one root, so nothing is built at a call site", () => {
		const paths = workspacePaths(POSIX, "/home/me/proj");
		expect(paths.lockFile.startsWith(paths.dir)).toBe(true);
		expect(paths.index.startsWith(paths.dir)).toBe(true);
	});

	it("gives two workspaces separate directories", () => {
		expect(workspacePaths(POSIX, "/a/proj").dir).not.toBe(workspacePaths(POSIX, "/b/proj").dir);
	});

	// The names are the contract the docs quote.
	it("keeps the diagnostics file and the reports directory inside the workspace directory", () => {
		const paths = workspacePaths(POSIX, "/home/me/proj");
		expect(paths.diagnosticsFile).toBe(`${paths.dir}/diagnostics.json`);
		expect(paths.reportsDir).toBe(`${paths.dir}/reports`);
	});

	// Readers of the state root hold keys.
	it("answers the same paths from a store directory as from the workspace that minted it", () => {
		const directory = path.join(stateRoot(POSIX), workspaceKey("/home/me/proj"));
		expect(storePaths(directory)).toEqual(workspacePaths(POSIX, "/home/me/proj"));
	});

	// A custom directory is the store's identity, so the workspace key plays no part in it.
	it("puts every path under a caller's own directory when one is given", () => {
		const paths = workspacePaths(POSIX, "/home/me/proj", "/elsewhere/store");
		expect(paths.dir).toBe("/elsewhere/store");
		expect(paths.lockFile).toBe("/elsewhere/store/daemon.json");
		expect(paths).toEqual(storePaths("/elsewhere/store"));
	});
});
