import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { codeOnly, readSwept, sourceFiles } from "@nyaa-lexicon/protocol";

/** Holds daemonLock.ts as the only claimant of a store's lock in core. */
const SRC = join(import.meta.dirname, "..");

const OWNER = "daemonLock.ts";

const SKIP_DIRS = new Set(["dist", "node_modules", ".tsbuild", "tmp"]);

/** Every package with lock text on disk, protocol excepted: the schema and reader's own owner. */
const PACKAGES = ["core", "client", "adapters"].map((dir) => join(import.meta.dirname, "..", "..", "..", dir));

function coreFiles(): string[] {
	return sourceFiles(SRC, SKIP_DIRS)
		.filter((file) => !file.includes("__tests__"))
		.sort();
}

////////////////////////////////
//  Tests

describe("one lock claim for core", () => {
	it("keeps the owner on the claim primitive, so a passing sweep is never vacuous", () => {
		const owner = codeOnly(readSwept(join(SRC, OWNER)) ?? "");
		expect(/\blinkSync\(/.test(owner)).toBe(true);
	});

	it("has no module claiming a lock on its own", () => {
		const files = coreFiles();
		expect(files.map((file) => file.slice(SRC.length + 1))).toContain(OWNER);

		const offenders: string[] = [];
		for (const file of files) {
			if (file.endsWith(`/${OWNER}`)) continue;
			const code = codeOnly(readSwept(file) ?? "");
			if (/\blinkSync\(/.test(code)) offenders.push(file);
		}

		expect(offenders, "a store's lock is claimed through core/src/daemonLock.ts").toEqual([]);
	});
});

// Four call sites, one parser, so no one of them reads a lock differently from the rest.
describe("one lock parse for the whole client-daemon wire", () => {
	const swept = () => PACKAGES.flatMap((dir) => sourceFiles(dir, SKIP_DIRS)).filter((f) => !f.includes("__tests__"));

	it("finds source files to check, so a passing run is never vacuous", () => {
		expect(swept().length).toBeGreaterThan(20);
	});

	it("fires on a hand-rolled parse", () => {
		expect(codeOnly("DaemonLockSchema.safeParse(JSON.parse(raw))").includes("DaemonLockSchema.safeParse(")).toBe(
			true,
		);
	});

	it("has no module parsing a lock by hand outside protocol's shared reader", () => {
		const offenders: string[] = [];
		for (const file of swept()) {
			const code = codeOnly(readSwept(file) ?? "");
			if (/\bDaemonLockSchema\.safeParse\(/.test(code)) offenders.push(file);
		}

		expect(offenders, "a lock's raw text is read through parseDaemonLock in protocol/src/daemonRecords.ts").toEqual(
			[],
		);
	});
});
