import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { canonicalRoot, type PlatformEnv, stateRoot, workspacePaths } from "@nyaa-lexicon/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findProject, forgetProject, readRegistry, registerProject } from "../projectRegistry";

////////////////////////////////
//  Helpers

let home: string;
let host: PlatformEnv;

const admitAll = () => ({ admitted: true });
const admitAllDirs = () => ({ admitted: true });

function dir(...segments: string[]): string {
	const full = path.join(home, ...segments);
	mkdirSync(full, { recursive: true });
	return full;
}

beforeEach(() => {
	// Canonical, so a temp directory reached through a link (macOS /var) compares as itself.
	home = canonicalRoot(mkdtempSync(path.join(tmpdir(), "lexicon-registry-")));
	host = { platform: "linux", env: { XDG_STATE_HOME: path.join(home, "state") }, home };
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

////////////////////////////////
//  Tests

describe("registering", () => {
	it("starts with nothing, since discovery no longer adds anything", () => {
		expect(readRegistry(host)).toEqual([]);
	});

	it("keeps stable identity without session naming state", () => {
		const outcome = registerProject(dir("alpha"), admitAll, host);

		expect(outcome).toMatchObject({ registered: true, already: false });
		expect(readRegistry(host)).toEqual([{ key: expect.stringMatching(/^alpha-/), root: path.join(home, "alpha") }]);
	});

	it("registers a path reached through a symlink as the project already there, under its real root", () => {
		const real = dir("real", "alpha");
		const link = path.join(home, "link");
		symlinkSync(path.join(home, "real"), link);

		expect(registerProject(real, admitAll, host)).toMatchObject({ registered: true, already: false });
		const again = registerProject(path.join(link, "alpha"), admitAll, host);

		expect(again).toMatchObject({ registered: true, already: true });
		expect(readRegistry(host)).toHaveLength(1);
		expect(readRegistry(host)[0]?.root).not.toContain("link");
		expect(forgetProject(path.join(link, "alpha"), host)).toBe(true);
		expect(readRegistry(host)).toEqual([]);
	});

	it("registering twice is the same project, reported as already there", () => {
		const root = dir("alpha");
		registerProject(root, admitAll, host);

		expect(registerProject(root, admitAll, host)).toMatchObject({ registered: true, already: true });
		expect(readRegistry(host)).toHaveLength(1);
	});

	it("does not persist names for projects sharing a basename", () => {
		registerProject(dir("one", "app"), admitAll, host);
		registerProject(dir("two", "app"), admitAll, host);

		const stored = JSON.parse(readFileSync(path.join(stateRoot(host), "projects.json"), "utf8"));
		expect(stored.projects).toEqual([
			{ key: expect.any(String), root: path.join(home, "one", "app") },
			{ key: expect.any(String), root: path.join(home, "two", "app") },
		]);
	});

	it("reads registry files written before names moved into sessions", () => {
		mkdirSync(stateRoot(host), { recursive: true });
		writeFileSync(
			path.join(stateRoot(host), "projects.json"),
			JSON.stringify({ projects: [{ key: "alpha-key", root: "/work/alpha", name: "alpha" }] }),
		);

		expect(readRegistry(host)).toEqual([{ key: "alpha-key", root: "/work/alpha" }]);
	});

	it("refuses a root the admission rules reject, and passes the reason through", () => {
		const outcome = registerProject(dir("nope"), () => ({ admitted: false, reason: "that is your home" }), host);

		expect(outcome).toEqual({ registered: false, reason: "that is your home" });
		expect(readRegistry(host)).toEqual([]);
	});
});

describe("what the file does not keep", () => {
	it("never persists a session-facing name or binding", () => {
		registerProject(dir("alpha"), admitAll, host);

		const raw = readFileSync(path.join(stateRoot(host), "projects.json"), "utf8");
		expect(raw).not.toContain("name");
		expect(raw).not.toContain("bound");
	});
});

describe("forgetting", () => {
	it("drops a project from the registry", () => {
		registerProject(dir("alpha"), admitAll, host);
		const [registered] = readRegistry(host);

		expect(forgetProject(registered?.key ?? "", host)).toBe(true);
		expect(readRegistry(host)).toEqual([]);
	});

	it("reports a miss rather than pretending", () => {
		expect(forgetProject("ghost", host)).toBe(false);
	});
});

describe("looking up durable identity", () => {
	it("finds by key or exact root, and answers null otherwise", () => {
		const root = dir("alpha");
		registerProject(root, admitAll, host);
		const projects = readRegistry(host);

		expect(findProject(root, projects)?.root).toBe(root);
		expect(findProject(projects[0]?.key ?? "", projects)?.root).toBe(root);
		expect(findProject("ghost", projects)).toBeNull();
	});
});

describe("a store directory of the project's choosing", () => {
	it("is a second entry for the same workspace, created private and stored canonical", () => {
		const root = dir("alpha");
		const custom = path.join(home, "stores", "refs");
		registerProject(root, admitAll, host);

		const outcome = registerProject(root, admitAll, host, custom);

		expect(outcome).toMatchObject({ registered: true, already: false, project: { root, stateDir: custom } });
		expect(statSync(custom).isDirectory()).toBe(true);
		if (process.platform !== "win32") expect(statSync(custom).mode & 0o777).toBe(0o700);
		const [first, second] = readRegistry(host);
		expect(first).toEqual({ key: expect.any(String), root });
		expect(second).toEqual({ key: first?.key, root, stateDir: custom });
		const stored = JSON.parse(readFileSync(path.join(stateRoot(host), "projects.json"), "utf8"));
		expect(stored.projects[1]).toEqual({ key: first?.key, root, stateDir: custom });
	});

	it("is the same store again through a link, since the directory is stored canonical", () => {
		const root = dir("alpha");
		const real = dir("stores", "refs");
		symlinkSync(path.join(home, "stores"), path.join(home, "link"));
		registerProject(root, admitAll, host, real, admitAllDirs);

		const again = registerProject(root, admitAll, host, path.join(home, "link", "refs"), admitAllDirs);

		expect(again).toMatchObject({ registered: true, already: true });
		expect(readRegistry(host)).toEqual([{ key: expect.any(String), root, stateDir: real }]);
	});

	it("is named by its directory alone; the key and the root name the default store", () => {
		const root = dir("alpha");
		const custom = dir("stores", "refs");
		registerProject(root, admitAll, host, custom, admitAllDirs);
		const [entry] = readRegistry(host);
		const key = entry?.key ?? "";

		expect(findProject(custom, readRegistry(host))).toEqual({ key, root, stateDir: custom });
		expect(findProject(key, readRegistry(host))).toBeNull();
		expect(findProject(root, readRegistry(host))).toBeNull();

		registerProject(root, admitAll, host);
		expect(findProject(key, readRegistry(host))).toEqual({ key, root });
		expect(findProject(root, readRegistry(host))).toEqual({ key, root });
	});

	it("is forgotten on its own, leaving the default store", () => {
		const root = dir("alpha");
		const custom = dir("stores", "refs");
		registerProject(root, admitAll, host);
		registerProject(root, admitAll, host, custom, admitAllDirs);

		expect(forgetProject(custom, host)).toBe(true);
		expect(readRegistry(host)).toEqual([{ key: expect.any(String), root }]);
		expect(existsSync(custom)).toBe(true);
	});

	it("refuses a directory the admission rules reject, and passes the reason through", () => {
		const outcome = registerProject(dir("alpha"), admitAll, host, path.join(home, "nope"), () => ({
			admitted: false,
			reason: "that is a link",
		}));

		expect(outcome).toEqual({ registered: false, reason: "that is a link" });
		expect(readRegistry(host)).toEqual([]);
	});

	// Two entries for one directory would be two identities for one store.
	it("treats the default directory spelled out as the default store", () => {
		const root = dir("alpha");

		const outcome = registerProject(root, admitAll, host, workspacePaths(host, root).dir, admitAllDirs);

		expect(outcome).toMatchObject({ registered: true, project: { root } });
		expect(readRegistry(host)).toEqual([{ key: expect.any(String), root }]);
	});
});
