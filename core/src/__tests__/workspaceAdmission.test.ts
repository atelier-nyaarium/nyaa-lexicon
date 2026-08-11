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

describe("indexing itself", () => {
	// Copilot names no workspace and starts the server inside the plugin, so lexicon indexed its own
	// install and reported one healthy project that was not the user's.
	it("refuses the install directory when nobody named a workspace, and names the variable", () => {
		const install = make("plugins", "lexicon");
		const outcome = admitWorkspace(install, host, {
			chosenBy: "fallback",
			installedAt: path.join(install, "dist"),
		});

		expect(outcome.admitted).toBe(false);
		if (outcome.admitted) return;
		expect(outcome.reason).toContain("LEXICON_WORKSPACE");
	});

	// Dogfooding: pointing lexicon at its own source is deliberate and must keep working.
	it("admits the install directory when a workspace was named", () => {
		const install = make("plugins", "lexicon");
		const context = { chosenBy: "explicit" as const, installedAt: path.join(install, "dist") };

		expect(admitWorkspace(install, host, context)).toEqual({ admitted: true });
	});

	it("admits a real project, since the install is elsewhere", () => {
		const context = { chosenBy: "fallback" as const, installedAt: path.join(home, "plugins", "lexicon", "dist") };

		expect(admitWorkspace(make("code", "app"), host, context)).toEqual({ admitted: true });
	});
});
