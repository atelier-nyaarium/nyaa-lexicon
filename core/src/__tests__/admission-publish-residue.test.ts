import { describe, expect, it } from "bun:test";
import { basename, join } from "node:path";
import { readSwept } from "@nyaa-lexicon/protocol";
import {
	callsTo,
	declarationNamed,
	nodesIn,
	parsedFiles,
	parseSource,
	startOf,
	stringsIn,
} from "@nyaa-lexicon/protocol/ast";
import ts from "typescript";

const CORE = join(import.meta.dirname, "..");

/** Calls the port member; the two files that DECLARE it match none of the spellings below. */
const OWNER = join(CORE, "indexer.ts");

const MEMBER = "admission";

const SKIP_DIRS = new Set(["dist", "node_modules", ".tsbuild", "fixtures", "__tests__"]);

/**
 * Every way to reach the port member, not just the dotted call: a member read, a destructure, or a
 * property of an object literal.
 *
 * `admission` on its own is the workspace's word in `daemonCli.ts` and `projectRegistry.ts`, a
 * different concept, so the bare identifier is not a reach.
 */
function reaches(root: ts.Node): ts.Node[] {
	return nodesIn(root).filter((node) => {
		if (ts.isPropertyAccessExpression(node)) return node.name.text === MEMBER;
		if (ts.isElementAccessExpression(node)) return stringsIn(node.argumentExpression)[0]?.text === MEMBER;
		if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
			const named = node.propertyName ?? node.name;
			return ts.isIdentifier(named) && named.text === MEMBER;
		}
		if (!ts.isObjectLiteralElementLike(node) || !ts.isObjectLiteralExpression(node.parent)) return false;
		return node.name !== undefined && ts.isIdentifier(node.name) && node.name.text === MEMBER;
	});
}

function owner(): ts.SourceFile {
	return parseSource(OWNER, readSwept(OWNER) ?? "").source;
}

/** `this.publish(...)` calls under `root`. */
function publications(root: ts.Node): ts.CallExpression[] {
	return callsTo(root, "publish", "this");
}

////////////////////////////////
//  Tests

describe("only the indexer tells a provider what the index did", () => {
	it("finds the owner and a core to sweep, so a passing run is never vacuous", () => {
		expect(readSwept(OWNER)).not.toBeNull();
		expect(parsedFiles(CORE, SKIP_DIRS).length).toBeGreaterThanOrEqual(30);
		// One reach, since the indexer's own road is the only thing that names the port member.
		expect(reaches(owner()).length).toBeGreaterThanOrEqual(1);
	});

	it("recognises each spelling when planted", () => {
		const planted = [
			"this.supervisor.admission(providerId, verdict);",
			'port["admission"](providerId, verdict);',
			"const { admission } = port;",
			"const port = { admission: () => {} };",
		];
		for (const line of planted) expect(reaches(parseSource("probe.ts", line).source), line).toHaveLength(1);
		// The workspace's own admission, which is a different concept and not the port's member.
		for (const line of ["const admission = admitWorkspace(root, host);", "stateDir ? admission : admitStateDir(x)"])
			expect(reaches(parseSource("probe.ts", line).source), line).toEqual([]);
	});

	it("reaches the member in no core module but the indexer", () => {
		const offenders = parsedFiles(CORE, SKIP_DIRS)
			.filter(({ file, source }) => file !== OWNER && reaches(source).length > 0)
			.map(({ file }) => basename(file));

		expect(
			offenders,
			"telling a provider what the index did belongs to core/src/indexer.ts, the only module that writes facts",
		).toEqual([]);
	});

	// Counted, not merely found: a second publication earlier in the file leaves a later one for an
	// ordering check to land on, which passes on a case it was not shown.
	it("publishes admitted once, after the store has committed the facts", () => {
		const source = owner();
		const commits = callsTo(source, "replaceFile", "this.store");
		expect(commits, "the indexer commits through store.replaceFile").toHaveLength(1);

		const admitted = nodesIn(source).filter(
			(node) =>
				ts.isPropertyAssignment(node) &&
				ts.isIdentifier(node.name) &&
				node.name.text === "status" &&
				ts.isStringLiteral(node.initializer) &&
				node.initializer.text === "admitted",
		);
		expect(admitted, "one road admits a parse").toHaveLength(1);
		expect(
			startOf(admitted[0] as ts.Node),
			"the admitted verdict is published after the commit, never before",
		).toBeGreaterThan(startOf(commits[0] as ts.Node));
	});

	it("reads the parser's incarnation before the parse it will publish for", () => {
		const source = owner();
		const read = callsTo(source, "incarnationOf", "this.supervisor")[0];
		const parse = stringsIn(source).find(({ text }) => text === "parseFile")?.node;
		expect(read, "the indexer reads which process answers").toBeDefined();
		expect(parse, "the indexer parses").toBeDefined();
		expect(startOf(read as ts.Node), "a restart between the two must not inherit the verdict").toBeLessThan(
			startOf(parse as ts.Node),
		);
	});

	// Call sites, not `status` literals: a road building its outcome through a helper would add a
	// publication without moving a count of the literals. Which road publishes what is pinned by
	// moduleAdmission.test.ts, which drives each of them.
	it("publishes from a counted set of call sites", () => {
		const source = owner();
		expect(publications(source), "the commit, the refused parse, and the fault under the commit").toHaveLength(3);

		const road = declarationNamed(source, "publish");
		expect(road !== undefined && ts.isMethodDeclaration(road), "one road reaches the port").toBe(true);
		expect(reaches(source), "only that road names the port member").toHaveLength(1);
		expect(reaches(road as ts.Node)).toHaveLength(1);
	});

	it("records the failure before it publishes a refusal", () => {
		const road = declarationNamed(owner(), "refuseParse");
		expect(road, "one road refuses a parse").toBeDefined();

		const recorded = callsTo(road as ts.Node, "recordFailure", "this.store")[0];
		const published = publications(road as ts.Node)[0];
		expect(recorded, "refuseParse records through the store").toBeDefined();
		expect(published, "it publishes").toBeDefined();
		expect(startOf(published as ts.Node), "it publishes after it records").toBeGreaterThan(
			startOf(recorded as ts.Node),
		);
	});
});
