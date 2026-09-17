import { describe, expect, it } from "bun:test";
import { readdirSync } from "node:fs";
import path from "node:path";
import { codeOnly, readSwept } from "@nyaa-lexicon/protocol";

/** The one owner of a read's declaration topology and of the summary a declaration answers as. */
const OWNER = "readContext.ts";

/** Holds the per-module topology and the one container walk the owner is built on. */
const PRIMITIVES = "locals.ts";

/** Names both owners to pin them, so it may spell what every other module may not. */
const PINS = path.join("__tests__", "readContext.test.ts");

/** Holds every token it refuses. */
const SELF = path.join("__tests__", "read-context-residue.test.ts");

/** Derives nesting on the write path, so it reads a module's rows through the owner alone. */
const PLANNER = "refactorPlanner.ts";

/** The store's read of a module's rows. Read by hand, it is a second topology. */
const ROWS = "declarationsIn";

/** Readers of the rows that ask nothing about nesting, each with why the rows suffice. */
const ROW_READERS: Record<string, string> = {
	"store.ts": "declares the read",
	"service.ts": "passes the read through to the daemon method",
	"indexReads.ts": "filters rows by name and summarizes them, in the store's order",
	"dispatch.ts": "names the daemon method, and diffs ids across a reindex no memo may span",
	"moduleDeclarations.ts": "snapshots the rows beside the module's hashes",
	"refusals.ts": "names an unminted id's neighbours",
	"knowledge.ts": "walks a file's declarations for gaps",
};

const ROOT = path.resolve(import.meta.dirname, "..");

function sourceFiles(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const file = path.join(directory, entry.name);
		return entry.isDirectory() ? sourceFiles(file) : file.endsWith(".ts") ? [file] : [];
	});
}

const FILES = sourceFiles(ROOT).map((file) => ({
	name: path.relative(ROOT, file),
	code: codeOnly(readSwept(file) ?? ""),
}));

function holdersOf(token: string, allowed: string[]): string[] {
	return FILES.filter((file) => file.name !== SELF && file.code.includes(token))
		.map((file) => file.name)
		.filter((name) => !allowed.includes(name));
}

function codeOf(name: string): string {
	return FILES.find((file) => file.name === name)?.code ?? "";
}

/** Holders outside the tests, whose doubles spell the store's reads. */
function codeHolders(token: string, allowed: string[]): string[] {
	return holdersOf(token, allowed).filter((name) => !name.startsWith("__tests__"));
}

////////////////////////////////
//  Tests

describe("one owner derives a read's declaration topology", () => {
	it("fails when the sweep misses a core file", () => {
		expect(FILES.length).toBeGreaterThan(20);
		expect(FILES.map((file) => file.name)).toEqual(
			expect.arrayContaining([OWNER, PRIMITIVES, PINS, SELF, PLANNER, ...Object.keys(ROW_READERS)]),
		);
		expect(codeOf(OWNER).length).toBeGreaterThan(1_000);
	});

	it("reads a module's rows only where nothing about nesting is asked", () => {
		const stale = Object.keys(ROW_READERS).filter((name) => !codeOf(name).includes(ROWS));
		expect(stale, "a reader listed here no longer reads the rows").toEqual([]);

		const offenders = codeHolders(ROWS, [OWNER, ...Object.keys(ROW_READERS)]);
		expect(offenders, "a reader deriving nesting from the rows asks the context").toEqual([]);
	});

	it("names a containment nowhere else", () => {
		expect(holdersOf("Containment", [OWNER, PRIMITIVES]), "a second reader deriving nesting drifts").toEqual([]);
	});

	it("names the container walk nowhere else, under any alias", () => {
		expect(holdersOf("ancestryOf", [OWNER, PRIMITIVES, PINS])).toEqual([]);
	});

	it("declares the declaration summary nowhere else, by either spelling", () => {
		expect(holdersOf("function toSummary", [OWNER])).toEqual([]);
		expect(holdersOf("const toSummary", [OWNER])).toEqual([]);
	});

	it("reads no container field in the readers", () => {
		const offenders = ["scope.ts", "knowledge.ts", "indexReads.ts"].filter((name) =>
			codeOf(name).includes("containerId"),
		);

		expect(offenders, "a nesting question answered by hand belongs on the context").toEqual([]);
	});
});
