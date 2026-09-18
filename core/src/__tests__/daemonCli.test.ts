import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { storePaths } from "@nyaa-lexicon/client";
import { resumeAbandonedDelete } from "../daemonCli";

////////////////////////////////
//  Helpers

function scratch(): string {
	return mkdtempSync(path.join(tmpdir(), "lexicon-resume-"));
}

////////////////////////////////
//  Tests

// Finishes a dead delete before serving, and leaves anything else exactly as found.
describe("resuming a claim that stole a delete's lock", () => {
	it("finishes it and says so when the claim stole a delete", () => {
		const directory = scratch();
		try {
			writeFileSync(storePaths(directory).index, "stale");

			expect(resumeAbandonedDelete({ stolenRole: "delete" }, directory, false)).toBe(true);
			expect(existsSync(storePaths(directory).index)).toBe(false);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("touches nothing when the claim stole a daemon's lock instead", () => {
		const directory = scratch();
		try {
			writeFileSync(storePaths(directory).index, "kept");

			expect(resumeAbandonedDelete({ stolenRole: "daemon" }, directory, false)).toBe(false);
			expect(existsSync(storePaths(directory).index)).toBe(true);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("touches nothing when nothing was stolen at all", () => {
		const directory = scratch();
		try {
			writeFileSync(storePaths(directory).index, "kept");

			expect(resumeAbandonedDelete({}, directory, false)).toBe(false);
			expect(existsSync(storePaths(directory).index)).toBe(true);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	// A default directory's resume clears the whole of it, not only the enumerated list.
	it("clears a default store whole, including a file the enumerated list does not name", () => {
		const directory = scratch();
		try {
			writeFileSync(storePaths(directory).index, "stale");
			writeFileSync(path.join(directory, "stray.txt"), "not in the list");

			expect(resumeAbandonedDelete({ stolenRole: "delete" }, directory, true)).toBe(true);
			expect(existsSync(storePaths(directory).index)).toBe(false);
			expect(existsSync(path.join(directory, "stray.txt"))).toBe(false);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
