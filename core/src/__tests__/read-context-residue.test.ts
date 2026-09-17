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

////////////////////////////////
//  Tests

describe("one owner derives a read's declaration topology", () => {
	it("fails when the sweep misses a core file", () => {
		expect(FILES.length).toBeGreaterThan(20);
		expect(FILES.map((file) => file.name)).toEqual(expect.arrayContaining([OWNER, PRIMITIVES, PINS, SELF]));
		expect(codeOf(OWNER).length).toBeGreaterThan(1_000);
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
