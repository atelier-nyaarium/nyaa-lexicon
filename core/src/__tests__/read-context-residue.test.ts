import { describe, expect, it } from "bun:test";
import { readdirSync } from "node:fs";
import path from "node:path";
import { readSwept } from "@nyaa-lexicon/protocol";
import { callsTo, declarationNamed, memberReads, nodesIn, parseSource, stringsIn } from "@nyaa-lexicon/protocol/ast";
import ts from "typescript";

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

/** The store's stamp of a module's rows. Compared by hand, it is a second staleness rule. */
const STAMP = "stampOf";

/** Declares the stamp read. */
const STORE = "store.ts";

/** Readers of the rows that ask nothing about nesting, each with why the rows suffice. */
const ROW_READERS: Record<string, string> = {
	"store.ts": "declares the read",
	"service.ts": "passes the read through to the daemon method",
	"indexReads.ts": "filters rows by name and summarizes them, in the store's order",
	"dispatch.ts": "names the daemon method, and diffs ids across a reindex no memo may span",
	"moduleDeclarations.ts": "snapshots the rows beside the module's hashes",
	"refusals.ts": "names an unminted id's neighbours",
	"knowledge.ts": "walks a file's declarations for gaps",
	"paintFacts.ts": "renders a module's rows as paint spans, no nesting asked",
};

/** The store's every id for a module: the id grammar's own subtree, never the container walk. */
const IDS = "symbolIdsIn";

/** Readers of the ids, each with why a raw or a context-stamped read is right there. */
const ID_READERS: Record<string, string> = {
	"store.ts": "declares the read",
	"readContext.ts": "stamps the module asked; the walk is the id grammar's own, not a containment question",
	"refactorPlanner.ts": "walks the id grammar for a rename's map or a move's closure, through the context",
};

/** The store's import rows behind a rename's import edits or a move's dependency walk. */
const IMPORTS_NAMED = "importsNamed";

/** Readers of importsNamed, each with why a raw or a context-stamped read is right there. */
const IMPORTS_NAMED_READERS: Record<string, string> = {
	"store.ts": "declares the read",
	"readContext.ts": "stamps each answered row's own module",
	"imports.ts": "the resolver; `reads` is required, named explicitly by every caller",
};

/** The store's read of one module's import statements. */
const IMPORTS_IN = "importsIn";

/** Readers of importsIn, each with why a raw or a context-stamped read is right there. */
const IMPORTS_IN_READERS: Record<string, string> = {
	"store.ts": "declares the read",
	"readContext.ts": "stamps the module asked",
	"imports.ts": "the resolver; `reads` is required, named explicitly by every caller",
	"indexer.ts": "walks the import closure while indexing, not a plan",
	"service.ts": "warms a symbol's tree before answering, not a plan",
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
	source: parseSource(file, readSwept(file) ?? "").source,
}));

const EMPTY = parseSource("empty.ts", "").source;

/** Whether an identifier or string contains `token`. */
function mentions(source: ts.SourceFile, token: string): boolean {
	const named = nodesIn(source).some((node) => ts.isIdentifier(node) && node.text.includes(token));
	return named || stringsIn(source).some(({ text }) => text.includes(token));
}

function holdersOf(token: string, allowed: string[]): string[] {
	return FILES.filter((file) => file.name !== SELF && mentions(file.source, token))
		.map((file) => file.name)
		.filter((name) => !allowed.includes(name));
}

function sourceOf(name: string): ts.SourceFile {
	return FILES.find((file) => file.name === name)?.source ?? EMPTY;
}

function mentionedIn(name: string, token: string): boolean {
	return mentions(sourceOf(name), token);
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
		expect(sourceOf(OWNER).text.length).toBeGreaterThan(1_000);
	});

	it("reads a module's rows only where nothing about nesting is asked", () => {
		const stale = Object.keys(ROW_READERS).filter((name) => !mentionedIn(name, ROWS));
		expect(stale, "a reader listed here no longer reads the rows").toEqual([]);

		const offenders = codeHolders(ROWS, [OWNER, ...Object.keys(ROW_READERS)]);
		expect(offenders, "a reader deriving nesting from the rows asks the context").toEqual([]);
	});

	it("stamps a module's rows only where the owner records and compares them", () => {
		expect(mentionedIn(OWNER, STAMP), "the owner no longer stamps what it reads").toBe(true);

		const offenders = codeHolders(STAMP, [OWNER, STORE]);
		expect(offenders, "a writer proving its rows still stand asks the context's stamps").toEqual([]);
	});

	it("names a containment nowhere else", () => {
		expect(holdersOf("Containment", [OWNER, PRIMITIVES]), "a second reader deriving nesting drifts").toEqual([]);
	});

	it("names the container walk nowhere else, under any alias", () => {
		expect(holdersOf("ancestryOf", [OWNER, PRIMITIVES, PINS])).toEqual([]);
	});

	it("declares the declaration summary nowhere else, by either spelling", () => {
		const declaring = FILES.filter(({ source }) => declarationNamed(source, "toSummary") !== undefined).map(
			({ name }) => name,
		);
		expect(declaring).toEqual([OWNER]);
	});

	it("reads no container field in the readers", () => {
		const offenders = ["scope.ts", "knowledge.ts", "indexReads.ts"].filter((name) =>
			mentionedIn(name, "containerId"),
		);

		expect(offenders, "a nesting question answered by hand belongs on the context").toEqual([]);
	});
});

describe("a rename or move plan walks the id grammar, never the store, unstamped", () => {
	it("reads every module's ids only where a reason is named", () => {
		const stale = Object.keys(ID_READERS).filter((name) => !mentionedIn(name, IDS));
		expect(stale, "a reader listed here no longer reads the ids").toEqual([]);

		const offenders = codeHolders(IDS, Object.keys(ID_READERS));
		expect(offenders, "a reader of every module's ids is not named here with why").toEqual([]);
	});

	it("never walks the ids straight off the store inside the planner", () => {
		const offender = memberReads(sourceOf(PLANNER)).some(
			({ name, receiver }) => name === IDS && (receiver === "store" || receiver?.endsWith(".store") === true),
		);
		expect(offender, "a rename or move plan must stamp the ids it walks through the context").toBe(false);
	});
});

describe("a rename or move plan reads its import rows through the context, never the store", () => {
	it("reads every import-by-name lookup only where a reason is named", () => {
		const stale = Object.keys(IMPORTS_NAMED_READERS).filter((name) => !mentionedIn(name, IMPORTS_NAMED));
		expect(stale, "a reader listed here no longer reads importsNamed").toEqual([]);

		const offenders = codeHolders(IMPORTS_NAMED, Object.keys(IMPORTS_NAMED_READERS));
		expect(offenders, "a reader of importsNamed is not named here with why").toEqual([]);
	});

	it("reads every module's import statements only where a reason is named", () => {
		const stale = Object.keys(IMPORTS_IN_READERS).filter((name) => !mentionedIn(name, IMPORTS_IN));
		expect(stale, "a reader listed here no longer reads importsIn").toEqual([]);

		const offenders = codeHolders(IMPORTS_IN, Object.keys(IMPORTS_IN_READERS));
		expect(offenders, "a reader of importsIn is not named here with why").toEqual([]);
	});

	it("never reads an import row straight off the store inside the resolver's planning methods", () => {
		const offenders = [IMPORTS_NAMED, IMPORTS_IN].filter(
			(method) => callsTo(sourceOf("imports.ts"), method, "this.store").length > 0,
		);
		expect(
			offenders,
			"importSitesFor, importSitesForMove and importOriginFor must ask `reads`, so a plan can stamp what they answer",
		).toEqual([]);
	});

	// `reads` and `context` are required parameters; tsc is the check.
});

/** Every row a plan might read, by the store method that answers it. */
const ROW_READ_METHODS = [
	"declaration",
	"declarationsNamed",
	"referencesTo",
	"referencesIn",
	"referencesSpelled",
	"importsBinding",
	"importsNamed",
	"importsIn",
	"symbolIdsIn",
];

/** Raw store calls: `this.store.method(...)`. */
function rawStoreCalls(method: string): ts.CallExpression[] {
	return callsTo(sourceOf(PLANNER), method, "this.store");
}

describe("the planner reads every row through the context, never the store", () => {
	it("finds no store row read in the planner but checkMoveLanded's own", () => {
		const offenders = ROW_READ_METHODS.filter((method) => method !== "referencesIn").filter(
			(method) => rawStoreCalls(method).length > 0,
		);
		expect(offenders, "a plan-phase read must ask the context, never the store").toEqual([]);
	});

	// checkMoveLanded's own read, after the reindex, stays raw.
	it("keeps exactly one raw read: checkMoveLanded's own, after the reindex", () => {
		const reads = rawStoreCalls("referencesIn");
		expect(reads.length, "checkMoveLanded is the one read that must see fresh rows, not the plan's").toBe(1);
		const landed = declarationNamed(sourceOf(PLANNER), "checkMoveLanded");
		expect(landed !== undefined && callsTo(landed, "referencesIn", "this.store").length).toBe(1);
	});
});
