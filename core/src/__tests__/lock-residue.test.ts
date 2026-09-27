import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { readSwept, sourceFiles } from "@nyaa-lexicon/protocol";
import { callsTo, parsedFiles, parseSource } from "@nyaa-lexicon/protocol/ast";
import type ts from "typescript";

/** Holds daemonLock.ts as the only claimant of a store's lock in core. */
const SRC = join(import.meta.dirname, "..");

const OWNER = "daemonLock.ts";

const SKIP_DIRS = new Set(["dist", "node_modules", ".tsbuild", "tmp"]);

/** Every package with lock text on disk, protocol excepted: the schema and reader's own owner. */
const PACKAGES = ["core", "client", "adapters"].map((dir) => join(import.meta.dirname, "..", "..", "..", dir));

const claims = (root: ts.Node): boolean => callsTo(root, "linkSync").length > 0;

const parsesByHand = (root: ts.Node): boolean => callsTo(root, "safeParse", "DaemonLockSchema").length > 0;

////////////////////////////////
//  Tests

describe("one lock claim for core", () => {
	it("keeps the owner on the claim primitive, so a passing sweep is never vacuous", () => {
		expect(claims(parseSource(OWNER, readSwept(join(SRC, OWNER)) ?? "").source)).toBe(true);
	});

	it("has no module claiming a lock on its own", () => {
		const files = parsedFiles(SRC, SKIP_DIRS).filter(({ file }) => !file.includes("__tests__"));
		expect(files.map(({ file }) => file.slice(SRC.length + 1))).toContain(OWNER);

		const offenders = files
			.filter(({ file, source }) => !file.endsWith(`/${OWNER}`) && claims(source))
			.map(({ file }) => file);

		expect(offenders, "a store's lock is claimed through core/src/daemonLock.ts").toEqual([]);
	});
});

// Four call sites, one parser, so no one of them reads a lock differently from the rest.
describe("one lock parse for the whole client-daemon wire", () => {
	const swept = () =>
		PACKAGES.flatMap((dir) => parsedFiles(dir, SKIP_DIRS)).filter(({ file }) => !file.includes("__tests__"));

	it("finds source files to check, so a passing run is never vacuous", () => {
		expect(PACKAGES.flatMap((dir) => sourceFiles(dir, SKIP_DIRS)).length).toBeGreaterThan(20);
	});

	it("fires on a hand-rolled parse", () => {
		expect(parsesByHand(parseSource("probe.ts", "DaemonLockSchema.safeParse(JSON.parse(raw))").source)).toBe(true);
	});

	it("has no module parsing a lock by hand outside protocol's shared reader", () => {
		const offenders = swept()
			.filter(({ source }) => parsesByHand(source))
			.map(({ file }) => file);

		expect(offenders, "a lock's raw text is read through parseDaemonLock in protocol/src/daemonRecords.ts").toEqual(
			[],
		);
	});
});
