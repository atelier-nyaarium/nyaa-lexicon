import { describe, expect, it } from "bun:test";
import { basename } from "node:path";
import { parsedFiles, parseSource, stringsIn } from "@nyaa-lexicon/protocol/ast";
import ts from "typescript";

/**
 * Policy mints admissions and failures. Store owns blob deletion and WAL truncation.
 */
const CORE = new URL("..", import.meta.url).pathname;

const MINTER = "secretPolicy.ts";

const PRUNER = "store.ts";

const JOURNAL_BRANDS = ["AdmittedBytes", "JournalAdmission"] as const;

const BLOB_DELETE = /DELETE\s+FROM\s+refactor_blobs\b/i;

type Source = Parameters<typeof stringsIn>[0];

const deletesBlobs = (source: Source) => stringsIn(source).some(({ text }) => BLOB_DELETE.test(text));

const names = (name: string) => (type: ts.TypeNode | undefined) =>
	type !== undefined && ts.isTypeReferenceNode(type) && type.typeName.getText() === name;

/** Finds type assertions and arguments that forge brands. */
function forges(source: Source, name: string): boolean {
	const naming = names(name);
	let found = false;
	const visit = (node: ts.Node): void => {
		if ((ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) && naming(node.type)) found = true;
		if (ts.isCallExpression(node) && node.typeArguments?.some(naming) === true) found = true;
		ts.forEachChild(node, visit);
	};
	visit(source);
	return found;
}

const forgesAdmission = (source: Source) => forges(source, "SecretAdmission");

const forgesFailure = (source: Source) => forges(source, "StoredFailure");

describe("one pruner of blobs and one minter of admissions", () => {
	const swept = parsedFiles(CORE, ["__tests__"]);

	it("sweeps core and finds each owner doing its part, so a passing run is never vacuous", () => {
		expect(swept.length).toBeGreaterThan(50);
		expect(swept.filter(({ file, source }) => basename(file) === PRUNER && deletesBlobs(source))).toHaveLength(1);
		expect(swept.filter(({ file, source }) => basename(file) === MINTER && forgesAdmission(source))).toHaveLength(
			1,
		);
		expect(swept.filter(({ file, source }) => basename(file) === MINTER && forgesFailure(source))).toHaveLength(1);
		for (const name of JOURNAL_BRANDS)
			expect(swept.filter(({ file, source }) => basename(file) === MINTER && forges(source, name))).toHaveLength(
				1,
			);
	});

	it("recognizes a planted blob delete, quoted or templated", () => {
		for (const text of [
			'db.prepare("DELETE FROM refactor_blobs WHERE hash = ?");',
			"db.prepare(`DELETE FROM refactor_blobs WHERE hash NOT IN (${kept})`);",
			'db.exec("delete  from refactor_blobs");',
		])
			expect(deletesBlobs(parseSource("planted.ts", text).source), text).toBe(true);
		expect(deletesBlobs(parseSource("planted.ts", 'db.prepare("SELECT bytes FROM refactor_blobs");').source)).toBe(
			false,
		);
	});

	it("recognizes a planted assertion, angle assertion and type argument naming the admission", () => {
		for (const text of [
			"const admission = { module, stamp: null, as: 'plain' } as SecretAdmission;",
			"const admission = <SecretAdmission>{ module };",
			"const admission = forge<SecretAdmission>();",
		])
			expect(forgesAdmission(parseSource("planted.ts", text).source), text).toBe(true);
		expect(forgesAdmission(parseSource("planted.ts", "const admission: SecretAdmission = given;").source)).toBe(
			false,
		);
	});

	it("recognizes a planted failure assertion, angle assertion and type argument naming the brand", () => {
		for (const text of [
			"const failure = 'broke near the value' as StoredFailure;",
			"const failure = <StoredFailure>message;",
			"const failure = forge<StoredFailure>();",
		])
			expect(forgesFailure(parseSource("planted.ts", text).source), text).toBe(true);
		expect(forgesFailure(parseSource("planted.ts", "const failure: StoredFailure = given;").source)).toBe(false);
	});

	it("recognizes planted journal admission forgeries", () => {
		for (const name of JOURNAL_BRANDS) {
			for (const text of [
				`const image = value as ${name};`,
				`const image = <${name}>value;`,
				`const image = forge<${name}>();`,
			])
				expect(forges(parseSource("planted.ts", text).source, name), text).toBe(true);
			expect(forges(parseSource("planted.ts", `const image: ${name} = given;`).source, name)).toBe(false);
		}
	});

	it("deletes blobs nowhere but the store", () => {
		const offenders = swept
			.filter(({ file, source }) => basename(file) !== PRUNER && deletesBlobs(source))
			.map(({ file }) => basename(file));

		expect(offenders, "prune through IndexStore.pruneBlobs or IndexStore.purgeImages in core/src/store.ts").toEqual(
			[],
		);
	});

	it("mints an admission nowhere but the policy", () => {
		const offenders = swept
			.filter(({ file, source }) => basename(file) !== MINTER && forgesAdmission(source))
			.map(({ file }) => basename(file));

		expect(offenders, "ask the snapshot in core/src/secretPolicy.ts for the admission").toEqual([]);
	});

	it("words a failure nowhere but the policy", () => {
		const offenders = swept
			.filter(({ file, source }) => basename(file) !== MINTER && forgesFailure(source))
			.map(({ file }) => basename(file));

		expect(offenders, "ask the verdict in core/src/secretPolicy.ts for the failure").toEqual([]);
	});

	it("mints journal admissions nowhere but the policy", () => {
		for (const name of JOURNAL_BRANDS) {
			const offenders = swept
				.filter(({ file, source }) => basename(file) !== MINTER && forges(source, name))
				.map(({ file }) => basename(file));

			expect(offenders, name).toEqual([]);
		}
	});
});
