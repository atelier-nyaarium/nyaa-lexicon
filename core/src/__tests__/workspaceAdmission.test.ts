import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PlatformEnv } from "../paths";
import { admitWorkspace } from "../workspaceAdmission";

////////////////////////////////
//  Helpers

let home: string;
let host: PlatformEnv;

function make(...segments: string[]): string {
	const full = path.join(home, ...segments);
	mkdirSync(full, { recursive: true });
	return full;
}

function repo(...segments: string[]): string {
	const full = make(...segments);
	mkdirSync(path.join(full, ".git"), { recursive: true });
	return full;
}

beforeEach(() => {
	home = mkdtempSync(path.join(tmpdir(), "lexicon-admit-"));
	host = { platform: "linux", env: {}, home };
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

////////////////////////////////
//  Tests

describe("admitting a workspace", () => {
	it("admits a repository", () => {
		expect(admitWorkspace(repo("app"), host)).toEqual({ admitted: true });
	});

	// Not everyone uses git, so absence of a .git is not evidence that nobody meant this directory.
	it("admits a project that is not a repository", () => {
		expect(admitWorkspace(make("scratch"), host)).toEqual({ admitted: true });
	});

	// The 420MB case, admitted anyway: whether a directory of projects is itself one is not a
	// judgement this gets to make. Opt-in warming is what keeps it cheap.
	it("admits a directory that merely contains other projects", () => {
		const umbrella = make("projects");
		repo("projects", "alpha");
		repo("projects", "beta");

		expect(admitWorkspace(umbrella, host)).toEqual({ admitted: true });
	});

	it("admits a child of home", () => {
		expect(admitWorkspace(make("code", "app"), host)).toEqual({ admitted: true });
	});
});

describe("refusing a workspace", () => {
	// Why this module exists: a home directory measured 67G, and walk mode allows everything.
	it("refuses the home directory, and says why", () => {
		const outcome = admitWorkspace(home, host);

		expect(outcome.admitted).toBe(false);
		if (outcome.admitted) return;
		expect(outcome.reason).toContain("home directory");
	});

	it("refuses the filesystem root", () => {
		expect(admitWorkspace("/", host).admitted).toBe(false);
	});

	// A refusal that a trailing `..` walks straight through is not a refusal.
	it("refuses home even when reached by an unnormalized path", () => {
		expect(admitWorkspace(path.join(home, "app", ".."), host).admitted).toBe(false);
	});
});

// Nothing is inferred from where the process runs any more, so the install directory needs no
// special case: it is admitted like any other, and only reached by registering it on purpose.
describe("the install directory", () => {
	it("is an ordinary project, admitted like any other", () => {
		expect(admitWorkspace(make("plugins", "lexicon"), host)).toEqual({ admitted: true });
	});
});
