import { describe, expect, it } from "vitest";
import { type PlatformEnv, stateRoot, storePaths, workspaceKey, workspacePaths } from "../paths";

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
	it("answers the same paths from a store key as from the workspace that minted it", () => {
		expect(storePaths(POSIX, workspaceKey("/home/me/proj"))).toEqual(workspacePaths(POSIX, "/home/me/proj"));
	});
});
