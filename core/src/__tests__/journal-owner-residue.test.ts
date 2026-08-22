import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { codeOnly, sourceFiles } from "@nyaa-lexicon/protocol";
import { describe, expect, it } from "vitest";

////////////////////////////////
//  Interfaces & Types

/**
 * Holds TransactionManager as the only reader or writer of the refactor journal.
 *
 * Bug class killed: a second writer whose phase transitions differ slightly. The journal is the
 * only record of what a half-applied refactor used to look like, so a disagreement about when a
 * step counts as written does not corrupt a query, it removes the ability to put files back.
 *
 * The store is exempt because it owns the SQL for every table; it moves rows and decides nothing.
 */
const CORE_SRC = join(import.meta.dirname, "..");

/** Spelled once here, so a new journal table joins the rule by being added to this list. */
const JOURNAL_TABLES = [
	"refactor_transactions",
	"refactor_steps",
	"refactor_blobs",
	"refactor_images",
	"refactor_issues",
];

/** transactions.ts decides what the rows mean; store.ts holds the schema and the row plumbing. */
const OWNERS = new Set(["transactions.ts", "store.ts"]);

const SKIP = ["__tests__", "dist", "node_modules"];

////////////////////////////////
//  Tests

describe("only the transaction manager touches the refactor journal", () => {
	it("finds source files to check, so a passing run is never vacuous", () => {
		expect(sourceFiles(CORE_SRC, SKIP).length).toBeGreaterThan(0);
	});

	it("sees the owners themselves, so the rule is checking real names", () => {
		const owned = sourceFiles(CORE_SRC, SKIP).filter((file) => OWNERS.has(basename(file)));
		const mentions = owned.filter((file) =>
			JOURNAL_TABLES.some((table) => codeOnly(readFileSync(file, "utf8")).includes(table)),
		);

		expect(mentions.length, "the journal tables should be named by their owners").toBe(OWNERS.size);
	});

	it("has no journal table named anywhere else in core", () => {
		const offenders: string[] = [];

		for (const file of sourceFiles(CORE_SRC, SKIP)) {
			if (OWNERS.has(basename(file))) continue;
			const code = codeOnly(readFileSync(file, "utf8"));
			for (const table of JOURNAL_TABLES) {
				if (code.includes(table)) offenders.push(`${file}: ${table}`);
			}
		}

		expect(
			offenders,
			"the refactor journal belongs to TransactionManager. Route through it rather than reading its tables.",
		).toEqual([]);
	});
});
