import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PlatformEnv } from "../paths";
import { findProject, forgetProject, readRegistry, registerProject } from "../projectRegistry";

////////////////////////////////
//  Helpers

let home: string;
let host: PlatformEnv;

const admitAll = () => ({ admitted: true });

function dir(...segments: string[]): string {
	const full = path.join(home, ...segments);
	mkdirSync(full, { recursive: true });
	return full;
}

beforeEach(() => {
	home = mkdtempSync(path.join(tmpdir(), "lexicon-registry-"));
	host = { platform: "linux", env: { XDG_STATE_HOME: path.join(home, "state") }, home };
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

////////////////////////////////
//  Tests

describe("registering", () => {
	it("starts with nothing, since discovery no longer adds anything", () => {
		expect(readRegistry(host)).toEqual([]);
	});

	it("keeps a registered project, named after its directory and not yet bound", () => {
		const outcome = registerProject(dir("alpha"), admitAll, host);

		expect(outcome).toMatchObject({ registered: true, already: false });
		expect(readRegistry(host)).toMatchObject([{ name: "alpha", bound: false }]);
	});

	it("registering twice is the same project, reported as already there", () => {
		const root = dir("alpha");
		registerProject(root, admitAll, host);

		expect(registerProject(root, admitAll, host)).toMatchObject({ registered: true, already: true });
		expect(readRegistry(host)).toHaveLength(1);
	});

	// Two checkouts called `app` are the common case, and a name that silently means either is worse
	// than an ugly one.
	it("gives two projects sharing a basename distinct names", () => {
		registerProject(dir("one", "app"), admitAll, host);
		registerProject(dir("two", "app"), admitAll, host);

		expect(readRegistry(host).map((project) => project.name)).toEqual(["app", "app-2"]);
	});

	it("refuses a root the admission rules reject, and passes the reason through", () => {
		const outcome = registerProject(dir("nope"), () => ({ admitted: false, reason: "that is your home" }), host);

		expect(outcome).toEqual({ registered: false, reason: "that is your home" });
		expect(readRegistry(host)).toEqual([]);
	});
});

// A bind belongs to a session, so the file must not carry one: a restart that inherited yesterday's
// bindings would answer from codebases nobody asked about.
describe("what the file does not keep", () => {
	it("never persists a binding, whatever the value in memory was", () => {
		registerProject(dir("alpha"), admitAll, host);

		expect(readRegistry(host)).toMatchObject([{ name: "alpha", bound: false }]);
	});
});

describe("forgetting", () => {
	it("drops a project from the registry", () => {
		registerProject(dir("alpha"), admitAll, host);

		expect(forgetProject("alpha", host)).toBe(true);
		expect(readRegistry(host)).toEqual([]);
	});

	it("reports a miss rather than pretending", () => {
		expect(forgetProject("ghost", host)).toBe(false);
	});
});

describe("looking one up", () => {
	it("finds by either handle, and answers null otherwise", () => {
		registerProject(dir("alpha"), admitAll, host);
		const projects = readRegistry(host);

		expect(findProject("alpha", projects)?.name).toBe("alpha");
		expect(findProject(projects[0]?.key ?? "", projects)?.name).toBe("alpha");
		expect(findProject("ghost", projects)).toBeNull();
	});
});
