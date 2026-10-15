import { describe, expect, it } from "bun:test";
import { basename, join } from "node:path";
import { sourceFiles } from "@nyaa-lexicon/protocol";
import { declarationNamed, type MemberRead, memberCalls, mentionsWord, parsedFiles } from "@nyaa-lexicon/protocol/ast";
import type ts from "typescript";
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

const MIGRATION_TABLES = ["refactor_transactions", "refactor_steps", "refactor_rebinds"];

/** Lifts legacy rebind rows while the store schema is upgraded. */
const MIGRATION_READERS = new Map([["liftAppliedRebinds", "copies legacy applied moves into the journal"]]);

/** Transactions interpret rows; store moves them, registry defines them. */
const OWNERS = new Set(["transactions.ts", "store.ts", "journalSchema.ts"]);

const SKIP = ["__tests__", "dist", "node_modules"];

/** Journal tables named as string words or identifiers. */
function tablesNamed(source: ts.Node): string[] {
	return JOURNAL_TABLES.filter((table) => mentionsWord(source, table));
}

function tablesOutsideMigration(source: ts.SourceFile): string[] {
	const migrations = [...MIGRATION_READERS.keys()].flatMap((name) => {
		const found = declarationNamed(source, name);
		return found === undefined ? [] : [found];
	});
	return source.statements.filter((statement) => !migrations.includes(statement)).flatMap(tablesNamed);
}

/** `store.journal(...)`, off any receiver ending in the store. */
function journalEscapes(source: ts.SourceFile): MemberRead[] {
	return memberCalls(source, ["journal"]).filter(
		({ receiver }) => receiver === "store" || receiver?.endsWith(".store") === true,
	);
}

////////////////////////////////
//  Tests

describe("only the transaction manager touches the refactor journal", () => {
	it("finds source files to check, so a passing run is never vacuous", () => {
		expect(sourceFiles(CORE_SRC, SKIP).length).toBeGreaterThan(0);
	});

	it("sees the owners themselves, so the rule is checking real names", () => {
		const owned = parsedFiles(CORE_SRC, SKIP).filter(({ file }) => OWNERS.has(basename(file)));
		const mentions = owned.filter(({ source }) => tablesNamed(source).length > 0);

		expect(mentions.length, "the journal tables should be named by their owners").toBe(OWNERS.size);
	});

	it("finds the legacy lift by declaration", () => {
		const declarations = parsedFiles(CORE_SRC, SKIP).flatMap(({ source }) =>
			[...MIGRATION_READERS.keys()].flatMap((name) => {
				const found = declarationNamed(source, name);
				return found === undefined ? [] : [found];
			}),
		);
		expect(declarations).toHaveLength(MIGRATION_READERS.size);
		const [migration] = declarations;
		expect(migration === undefined ? [] : tablesNamed(migration)).toEqual(MIGRATION_TABLES);
	});

	it("has no journal table named anywhere else in core", () => {
		const offenders = parsedFiles(CORE_SRC, SKIP)
			.filter(({ file }) => !OWNERS.has(basename(file)))
			.flatMap(({ file, source }) => tablesOutsideMigration(source).map((table) => `${file}: ${table}`));

		expect(
			offenders,
			"the refactor journal belongs to TransactionManager. Route through it rather than reading its tables.",
		).toEqual([]);
	});

	it("has no raw journal escape outside the store", () => {
		const files = parsedFiles(CORE_SRC, SKIP);
		expect(files.length).toBeGreaterThan(0);
		const offenders = files
			.filter(({ file, source }) => basename(file) !== "store.ts" && journalEscapes(source).length > 0)
			.map(({ file }) => file);
		expect(offenders).toEqual([]);
	});
});
