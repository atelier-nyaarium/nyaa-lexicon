import { describe, expect, it } from "vitest";
import { coChangesFor, commitsMentioning, fileHistoryFor, filesOf, readHistory } from "../history";

////////////////////////////////
//  Helpers

function commit(hash: string, ...files: string[]) {
	return { hash, at: 0, message: "", changes: files.map((path) => ({ path, added: 1, deleted: 0 })) };
}

function spoke(hash: string, message: string, files = 1) {
	return {
		hash,
		at: 100,
		message,
		changes: Array.from({ length: files }, (_, i) => ({ path: `f${i}.ts`, added: 1, deleted: 0 })),
	};
}

/** A commit with real timestamps and line counts, for the churn and age questions. */
function edit(hash: string, at: number, ...changes: Array<[string, number, number]>) {
	return { hash, at, message: "", changes: changes.map(([path, added, deleted]) => ({ path, added, deleted })) };
}

////////////////////////////////
//  Tests

describe("co-change", () => {
	it("ranks the file that changed alongside it most often", () => {
		const { partners } = coChangesFor("a.ts", [
			commit("1", "a.ts", "b.ts"),
			commit("2", "a.ts", "b.ts"),
			commit("3", "a.ts", "c.ts"),
		]);

		expect(partners.map((p) => p.module)).toEqual(["b.ts", "c.ts"]);
		expect(partners[0]).toMatchObject({ together: 2, outOf: 3 });
	});

	// A bare count cannot be judged. 8 of 9 is a partner you must look at and 8 of 200 is noise, so
	// the denominator rides along on every row.
	it("reports the denominator, so a count can be read as a proportion", () => {
		const { partners } = coChangesFor("a.ts", [
			commit("1", "a.ts", "b.ts"),
			commit("2", "a.ts"),
			commit("3", "a.ts"),
			commit("4", "unrelated.ts"),
		]);

		expect(partners[0]).toEqual({ module: "b.ts", together: 1, outOf: 3 });
	});

	/**
	 * The filter the whole signal depends on.
	 *
	 * A formatter run or a licence sweep touches hundreds of unrelated files and pairs every one
	 * with every other. Left in, one such commit outweighs every real commit in the sample.
	 */
	it("ignores a sweep, and says that it did rather than filtering silently", () => {
		const sweep = commit("wide", ...Array.from({ length: 50 }, (_, i) => `f${i}.ts`), "a.ts");
		const { partners, report } = coChangesFor("a.ts", [commit("1", "a.ts", "b.ts"), sweep]);

		expect(partners.map((p) => p.module)).toEqual(["b.ts"]);
		expect(report.skippedWideCommits).toBe(1);
	});

	it("answers nothing for a file with no history rather than inventing a partner", () => {
		expect(coChangesFor("ghost.ts", [commit("1", "a.ts", "b.ts")]).partners).toEqual([]);
	});

	it("never counts a file as its own partner", () => {
		const { partners } = coChangesFor("a.ts", [commit("1", "a.ts", "a.ts", "b.ts")]);
		expect(partners.map((p) => p.module)).toEqual(["b.ts"]);
	});
});

describe("reading history", () => {
	// Reads this repository, which is the only history guaranteed to be here.
	it("reads real commits with the files they touched", async () => {
		const commits = await readHistory(process.cwd(), 5);

		expect(commits.length).toBeGreaterThan(0);
		expect(commits.every((c) => /^[0-9a-f]{40}$/.test(c.hash))).toBe(true);
		expect(commits.some((c) => filesOf(c).length > 0)).toBe(true);
		// A timestamp, or age is unanswerable and the truncation flag means nothing.
		expect(commits.every((c) => c.at > 0)).toBe(true);
	});

	it("reads how much each file moved, not just that it moved", async () => {
		const commits = await readHistory(process.cwd(), 20);
		const touched = commits.flatMap((c) => c.changes);

		expect(touched.some((change) => change.added > 0)).toBe(true);
		expect(touched.every((change) => Number.isFinite(change.added) && Number.isFinite(change.deleted))).toBe(true);
	});

	it("answers churn and age for a file this repository actually has", async () => {
		const commits = await readHistory(process.cwd(), 200);
		const history = fileHistoryFor("core/src/store.ts", commits);

		expect(history.commits).toBeGreaterThan(0);
		expect(history.linesAdded).toBeGreaterThan(0);
		expect(history.firstSeen).not.toBeNull();
		expect(history.lastTouched).toBeGreaterThanOrEqual(history.firstSeen as number);
	});

	it("finds real partners, or says the only commits were too wide to count", async () => {
		const commits = await readHistory(process.cwd(), 200);
		const { partners, report } = coChangesFor("core/src/store.ts", commits);

		// Not asserting WHICH file: that would encode this session's history into a test.
		//
		// Nor asserting that partners exist unconditionally, because they legitimately may not. A
		// repository whose only commit touching this file is a bulk import has every candidate
		// dropped as a sweep, and reporting nothing is then the correct answer rather than a miss.
		// What must always hold is that the drop was REPORTED: a pair query that silently returns
		// nothing is indistinguishable from a file with no partners, which is the whole reason the
		// count is on the report.
		if (partners.length === 0) {
			expect(report.skippedWideCommits).toBeGreaterThan(0);
			return;
		}
		expect(partners[0]?.outOf).toBeGreaterThan(0);
	});
});

/**
 * The only tier-1 source of RATIONALE rather than structure.
 *
 * A reference says a symbol is used. A commit message saying why it stopped caching says something
 * no edge in the index can.
 */
describe("commits naming a symbol", () => {
	it("finds the commits whose message names it, newest first", () => {
		const found = commitsMentioning("resolveImport", [
			spoke("3", "Cache resolveImport, since the re-export walk asks it repeatedly"),
			spoke("2", "Unrelated work"),
			spoke("1", "Add resolveImport\n\nProviders own specifier resolution."),
		]);

		expect(found.map((m) => m.hash)).toEqual(["3", "1"]);
		expect(found[0]?.subject).toBe("Cache resolveImport, since the re-export walk asks it repeatedly");
	});

	it("reads the body, not only the subject, since that is where a reason usually is", () => {
		const found = commitsMentioning("hashOf", [
			spoke("1", "Tidy up\n\nAlso stopped hashOf reading the whole file."),
		]);
		expect(found).toHaveLength(1);
	});

	// A substring match turns every mention of a short name into noise that reads as evidence.
	it("matches on a word boundary, so add does not match address", () => {
		expect(commitsMentioning("add", [spoke("1", "Fix the address parser")])).toEqual([]);
		expect(commitsMentioning("add", [spoke("2", "Fix add() for empty carts")]).map((m) => m.hash)).toEqual(["2"]);
	});

	it("refuses to search a name too short to mean anything, rather than returning prose", () => {
		expect(commitsMentioning("id", [spoke("1", "id was wrong")])).toEqual([]);
	});

	// A mention in a 90-file sweep is weaker than one in a 2-file commit, and only the count says so.
	it("carries how many files the commit touched, so a mention can be weighed", () => {
		expect(commitsMentioning("widget", [spoke("1", "Rename widget", 3)])[0]?.files).toBe(3);
	});

	it("caps the list rather than returning a decade of history", () => {
		const many = Array.from({ length: 40 }, (_, i) => spoke(`${i}`, "touch the widget again"));
		expect(commitsMentioning("widget", many, 5)).toHaveLength(5);
	});

	it("reads real commit messages from this repository", async () => {
		const commits = await readHistory(process.cwd(), 50);

		expect(commits.some((c) => c.message.length > 0)).toBe(true);
		// Numstat still parses with a message in front of it, which is the risk in reading both.
		expect(commits.some((c) => c.changes.length > 0)).toBe(true);
	});
});

describe("churn and age", () => {
	const window = [edit("3", 300, ["a.ts", 5, 1]), edit("2", 200, ["b.ts", 9, 9]), edit("1", 100, ["a.ts", 40, 0])];

	it("counts lines rather than commits, so two kinds of busy file are distinguishable", () => {
		expect(fileHistoryFor("a.ts", window)).toMatchObject({ commits: 2, linesAdded: 45, linesDeleted: 1 });
	});

	it("reads age from the oldest and newest commit touching it", () => {
		expect(fileHistoryFor("a.ts", window)).toMatchObject({ firstSeen: 100, lastTouched: 300 });
	});

	// A file the window bottomed out on was already there. Reporting its floor as its age is how the
	// oldest file in a repository ends up looking like the newest.
	it("says when the window ran out rather than reporting a floor as a date", () => {
		expect(fileHistoryFor("a.ts", window).truncated).toBe(true);
		expect(fileHistoryFor("b.ts", window).truncated).toBe(false);
	});

	it("answers zero and null for a file with no history, rather than inventing one", () => {
		expect(fileHistoryFor("ghost.ts", window)).toMatchObject({
			commits: 0,
			linesAdded: 0,
			firstSeen: null,
			lastTouched: null,
		});
	});

	// Co-change drops a sweep because it says nothing about which files belong together. Churn keeps
	// it, because a formatter run genuinely edited this file.
	it("counts a sweep, which co-change deliberately does not", () => {
		const sweep = edit(
			"wide",
			400,
			...Array.from({ length: 60 }, (_, i) => [`f${i}.ts`, 1, 1] as [string, number, number]),
		);

		expect(fileHistoryFor("f0.ts", [sweep]).commits).toBe(1);
		expect(coChangesFor("f0.ts", [sweep]).partners).toEqual([]);
	});
});
