import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PlatformEnv } from "@nyaa-lexicon/client";
import { admitStateDir, admitWorkspace, type DirectoryOwner } from "../workspaceAdmission";

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

////////////////////////////////
//  State directories

const posix = process.platform !== "win32";

function owner(uid: number | null = process.getuid?.() ?? null): DirectoryOwner {
	return { platform: process.platform, uid };
}

function mode(dir: string): number {
	return statSync(dir).mode & 0o777;
}

describe("admitting a state directory", () => {
	it("creates an absent directory for the owner alone, parents included", () => {
		const dir = path.join(home, "stores", "deep", "refs");

		expect(admitStateDir(dir, owner())).toEqual({ admitted: true });

		expect(statSync(dir).isDirectory()).toBe(true);
		if (posix) {
			expect(mode(dir)).toBe(0o700);
			expect(mode(path.join(home, "stores", "deep"))).toBe(0o700);
			expect(mode(path.join(home, "stores"))).toBe(0o700);
		}
	});

	it("admits a directory already the owner's alone, and never touches its mode", () => {
		const dir = make("refs");
		chmodSync(dir, 0o700);
		expect(admitStateDir(dir, owner())).toEqual({ admitted: true });

		if (!posix) return;
		chmodSync(dir, 0o500);
		expect(admitStateDir(dir, owner())).toEqual({ admitted: true });
		expect(mode(dir)).toBe(0o500);
	});

	it("refuses a relative path", () => {
		expect(admitStateDir("refs", owner()).admitted).toBe(false);
	});

	it("refuses a link whatever it points at, and a file wearing the name", () => {
		const real = make("real");
		chmodSync(real, 0o700);
		const link = path.join(home, "link");
		symlinkSync(real, link);
		const file = path.join(home, "file");
		writeFileSync(file, "");

		expect(admitStateDir(link, owner())).toMatchObject({ admitted: false, reason: expect.stringMatching(/link/) });
		expect(admitStateDir(file, owner()).admitted).toBe(false);
	});

	// Windows reports every directory as writable by all, so the rule has no meaning there.
	it.skipIf(!posix)("refuses a directory its group or the world may write, and never narrows it", () => {
		const shared = make("shared");
		for (const wide of [0o770, 0o707, 0o777]) {
			chmodSync(shared, wide);
			expect(admitStateDir(shared, owner()).admitted).toBe(false);
			expect(mode(shared)).toBe(wide);
		}
		chmodSync(shared, 0o755);
		expect(admitStateDir(shared, owner())).toEqual({ admitted: true });
	});

	// A directory owned by someone else cannot be made without root, so the asker is faked instead.
	it.skipIf(!posix)("refuses a directory owned by someone else", () => {
		const dir = make("theirs");
		chmodSync(dir, 0o700);
		const stranger = (process.getuid?.() ?? 0) + 1;

		expect(admitStateDir(dir, owner(stranger))).toMatchObject({
			admitted: false,
			reason: expect.stringMatching(/owned by uid/),
		});
		expect(admitStateDir(dir, owner(null))).toEqual({ admitted: true });
	});

	it("judges neither mode nor owner where the platform has neither", () => {
		const dir = make("anything");
		chmodSync(dir, 0o777);

		expect(admitStateDir(dir, { platform: "win32", uid: null })).toEqual({ admitted: true });
	});
});
