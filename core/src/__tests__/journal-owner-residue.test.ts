import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { codeOnly, readSwept, sourceFiles } from "@nyaa-lexicon/protocol";
import { JOURNAL_TABLE_NAMES } from "../journalSchema";

////////////////////////////////
//  Interfaces & Types

/**
 * Holds TransactionManager as the only reader or writer of the refactor journal.
 *
 * Bug class killed: a second writer whose phase transitions differ slightly. The journal is the
 * only record of what a half-applied refactor used to look like, so a disagreement about when a
 * step counts as written does not corrupt a query, it removes the ability to put files back.
 *
 * Store owns row access; registry owns schema.
 */
const CORE_SRC = join(import.meta.dirname, "..");

/** Registered tables enter the residue sweep. */
const JOURNAL_TABLES: readonly string[] = JOURNAL_TABLE_NAMES;

/** Transactions interpret rows; store moves them, registry defines them. */
const OWNERS = new Set(["transactions.ts", "store.ts", "journalSchema.ts"]);

const SKIP = ["__tests__", "dist", "node_modules"];
const TOKEN = "store.journal(";

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
			const source = readSwept(file);
			if (source === null) continue;
			const code = codeOnly(source);
			for (const table of JOURNAL_TABLES) {
				if (code.includes(table)) offenders.push(`${file}: ${table}`);
			}
		}

		expect(
			offenders,
			"the refactor journal belongs to TransactionManager. Route through it rather than reading its tables.",
		).toEqual([]);
	});

	it("has no raw journal escape outside the store", () => {
		const files = sourceFiles(CORE_SRC, SKIP);
		expect(files.length).toBeGreaterThan(0);
		const offenders = files
			.filter((file) => basename(file) !== "store.ts")
			.flatMap((file) => {
				const source = readSwept(file);
				return source !== null && codeOnly(source).includes(TOKEN) ? [file] : [];
			});
		expect(offenders).toEqual([]);
	});
});
