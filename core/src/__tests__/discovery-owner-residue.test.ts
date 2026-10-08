import { describe, expect, it } from "bun:test";
import { basename, join } from "node:path";
import { sourceFiles } from "@nyaa-lexicon/protocol";
import { declarationNamed, lineOf, memberCalls, parsedFiles, stringsIn } from "@nyaa-lexicon/protocol/ast";
import type ts from "typescript";

////////////////////////////////
//  Interfaces & Types

/**
 * Holds RelationDiscovery as the only writer of discovery's export snapshot and queue, and of the
 * suggestions and gaps a settle writes.
 *
 * Bug class killed: a changed export that never reaches the queue. The snapshot records a shape as
 * seen, so a second writer that records shapes apart from queueing them loses those exports for
 * good; two rounds of patches to separate seed, notice and backfill paths each left one.
 */
const CORE_SRC = join(import.meta.dirname, "..");

const OWNER = "relationDiscovery.ts";

const ROWS = "relationRows.ts";

/** SQL that writes the snapshot, the queue or the first-start marker. */
const TABLE_WRITE = /\b(INSERT|REPLACE|UPDATE|DELETE\s+FROM|DROP\s+TABLE)\b[^;]*\brelation_(exports|queue|seeded)\b/i;

/** The row methods whose SQL may write those tables; each is the owner's or private to the rows. */
const ROW_WRITERS = ["recordExports", "markSeeded", "forgetExport", "forgetModule", "dequeue"];

/** The row writes only the owner may call. */
const WRITES = [
	"recordExports",
	"markSeeded",
	"forgetModule",
	"dequeue",
	"replaceDiscovery",
	"addGap",
	"closeGap",
] as const;

const SKIP = ["__tests__", "dist", "node_modules"];

////////////////////////////////
//  Tests

describe("only RelationDiscovery writes discovery's snapshot and queue", () => {
	it("finds source files to check, so a passing run is never vacuous", () => {
		expect(sourceFiles(CORE_SRC, SKIP).length).toBeGreaterThan(0);
	});

	it("sees the owner call every write, so the rule is checking real names", () => {
		const owner = parsedFiles(CORE_SRC, SKIP).find(({ file }) => basename(file) === OWNER);
		if (owner === undefined) throw new Error(`${OWNER} not found`);
		const called = new Set(memberCalls(owner.source, WRITES).map(({ name }) => name));

		expect([...called].sort()).toEqual([...WRITES].sort());
	});

	it("has no discovery write anywhere else in core", () => {
		const offenders = parsedFiles(CORE_SRC, SKIP)
			.filter(({ file }) => basename(file) !== OWNER)
			.flatMap(({ file, source }) => memberCalls(source, WRITES).map(({ name }) => `${file}: ${name}`));

		expect(
			offenders,
			"discovery's snapshot and queue belong to RelationDiscovery. Route through start, observe or settle.",
		).toEqual([]);
	});

	it("keeps those table writes inside the listed row methods", () => {
		const files = parsedFiles(CORE_SRC, SKIP);
		const rows = files.find(({ file }) => basename(file) === ROWS);
		if (rows === undefined) throw new Error(`${ROWS} not found`);
		const writers = ROW_WRITERS.flatMap((name) => {
			const node = declarationNamed(rows.source, name);
			return node === undefined ? [] : [node];
		});
		expect(writers).toHaveLength(ROW_WRITERS.length);
		const inWriter = (node: ts.Node) => writers.some((writer) => node.pos >= writer.pos && node.end <= writer.end);

		const writes = files.flatMap((parsed) =>
			stringsIn(parsed.source)
				.filter(({ text }) => TABLE_WRITE.test(text))
				.map(({ node }) => ({ where: `${parsed.file}:${lineOf(parsed, node)}`, rows: parsed === rows, node })),
		);
		expect(writes.filter((write) => write.rows).length, "the row writers' own SQL should be found").toBeGreaterThan(
			0,
		);
		expect(
			writes.filter((write) => !write.rows || !inWriter(write.node)).map((write) => write.where),
			"only the listed row methods write the snapshot and queue tables; the owner calls them.",
		).toEqual([]);
	});
});
