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

/** File that calls the port member. */
const OWNER = join(CORE, "indexer.ts");

/** Policy-created admission on its verdict. */
const POLICY = join(CORE, "secretPolicy.ts");

const MEMBER = "admission";

const SKIP_DIRS = new Set(["dist", "node_modules", ".tsbuild", "fixtures", "__tests__"]);

/** Receivers for policy admissions passed to the store. */
const POLICY_RECEIVER = /(?:^|\.)(?:secretPolicy|current|input|verdict)$/;

/** Store writes carrying policy admissions. */
const STORE_WRITES = new Set(["replaceFile"]);

/** Matches store writes with policy admission shorthand. */
function givenToStore(node: ts.Node): boolean {
	if (!ts.isShorthandPropertyAssignment(node)) return false;
	const call = node.parent.parent;
	return (
		ts.isCallExpression(call) &&
		ts.isPropertyAccessExpression(call.expression) &&
		STORE_WRITES.has(call.expression.name.text)
	);
}

/**
 * Finds port-member reads, destructures, and object fields.
 * Excludes workspace and policy admissions.
 */
function reaches(root: ts.Node): ts.Node[] {
	return nodesIn(root).filter((node) => {
		if (ts.isPropertyAccessExpression(node))
			return node.name.text === MEMBER && !POLICY_RECEIVER.test(node.expression.getText());
		if (ts.isElementAccessExpression(node)) return stringsIn(node.argumentExpression)[0]?.text === MEMBER;
		if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
			const named = node.propertyName ?? node.name;
			return ts.isIdentifier(named) && named.text === MEMBER;
		}
		if (!ts.isObjectLiteralElementLike(node) || !ts.isObjectLiteralExpression(node.parent)) return false;
		if (givenToStore(node)) return false;
		return node.name !== undefined && ts.isIdentifier(node.name) && node.name.text === MEMBER;
	});
}

/** Recognizes policy-owned admission references. */
function isPolicys(node: ts.Node): boolean {
	if (ts.isObjectLiteralElementLike(node)) return true;
	return ts.isPropertyAccessExpression(node) && node.expression.kind === ts.SyntaxKind.ThisKeyword;
}

function owner(): ts.SourceFile {
	return parseSource(OWNER, readSwept(OWNER) ?? "").source;
}

/** Finds `this.publish` calls. */
function publications(root: ts.Node): ts.CallExpression[] {
	return callsTo(root, "publish", "this");
}

////////////////////////////////
//  Tests

describe("only the indexer tells a provider what the index did", () => {
	it("finds the owner and a core to sweep, so a passing run is never vacuous", () => {
		expect(readSwept(OWNER)).not.toBeNull();
		expect(parsedFiles(CORE, SKIP_DIRS).length).toBeGreaterThanOrEqual(30);
		// The indexer is the sole port caller.
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
		// Workspace admission is not a port member.
		for (const line of ["const admission = admitWorkspace(root, host);", "stateDir ? admission : admitStateDir(x)"])
			expect(reaches(parseSource("probe.ts", line).source), line).toEqual([]);
		// Policy admissions are not port members.
		for (const line of [
			"const admission = this.secretPolicy.current.admission(read);",
			"const admission = this.secretPolicy.current.admission(module);",
			"this.store.replaceFile({ module, admission });",
			"const kept = input.admission;",
			"const admission = verdict.admission;",
		])
			expect(reaches(parseSource("probe.ts", line).source), line).toEqual([]);
		// Shorthand fields still reference the port member.
		expect(reaches(parseSource("probe.ts", "const port = { module, admission };").source)).toHaveLength(1);
		expect(reaches(parseSource("probe.ts", "this.relay({ module, admission });").source)).toHaveLength(1);
	});

	it("reaches the member in no core module but the indexer", () => {
		const offenders = parsedFiles(CORE, SKIP_DIRS)
			.filter(
				({ file, source }) =>
					file !== OWNER && reaches(source).some((node) => file !== POLICY || !isPolicys(node)),
			)
			.map(({ file }) => basename(file));

		expect(
			offenders,
			"telling a provider what the index did belongs to core/src/indexer.ts, the only module that writes facts",
		).toEqual([]);
	});

	// Count each publication before checking order.
	it("publishes admitted once, after the store has committed the facts", () => {
		const source = owner();
		const commits = callsTo(source, "replaceFile", "this.store");
		expect(commits, "reader and omit paths store directly").toHaveLength(3);
		const parse = callsTo(source, "askProvider", "this.supervisor").find((call) =>
			stringsIn(call).some(({ text }) => text === "parseFile"),
		);
		expect(parse, "provider facts come from parseFile").toBeDefined();
		const providerCommit = commits.find((commit) => startOf(commit) > startOf(parse as ts.Node));
		expect(providerCommit, "provider facts commit after parsing").toBeDefined();

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
			"the admitted verdict is published after the provider commit",
		).toBeGreaterThan(startOf(providerCommit as ts.Node));
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

	// Count sites. moduleAdmission.test.ts covers outcomes.
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
