import { describe, expect, it } from "bun:test";
import { basename, join } from "node:path";
import { codeOnly, readSwept, sourceFiles } from "@nyaa-lexicon/protocol";

const CORE = import.meta.dirname.replace(/\/__tests__$/, "");

/** Calls the port member; the two files that DECLARE it match none of the spellings below. */
const OWNER = join(CORE, "indexer.ts");

/**
 * Every way to reach the port member, not just the dotted call.
 *
 * `admission` on its own is the workspace's word in `daemonCli.ts` and `projectRegistry.ts`, a
 * different concept, so the bare identifier is not the token. Minted per sweep: `test` on a global
 * regex carries `lastIndex` from the call before it and skips every other file.
 */
const reaches = () => /\.admission\b|\[\s*["'`]admission["'`]\s*\]|[{,]\s*admission\s*[,}:]/g;

const SKIP_DIRS = new Set(["dist", "node_modules", ".tsbuild", "fixtures", "__tests__"]);

////////////////////////////////
//  Tests

describe("only the indexer tells a provider what the index did", () => {
	it("finds the owner and a core to sweep, so a passing run is never vacuous", () => {
		expect(readSwept(OWNER)).not.toBeNull();
		expect(sourceFiles(CORE, SKIP_DIRS).length).toBeGreaterThanOrEqual(30);
		// One reach, since the indexer's own road is the only thing that names the port member.
		expect([...codeOnly(readSwept(OWNER) ?? "").matchAll(reaches())].length).toBeGreaterThanOrEqual(1);
	});

	it("recognises each spelling when planted", () => {
		const planted = [
			"this.supervisor.admission(providerId, verdict);",
			'port["admission"](providerId, verdict);',
			"const { admission } = port;",
			"const port = { admission: () => {} };",
		];
		for (const line of planted) expect(reaches().test(line), line).toBe(true);
		// The workspace's own admission, which is a different concept and not the port's member.
		for (const line of ["const admission = admitWorkspace(root, host);", "stateDir ? admission : admitStateDir(x)"])
			expect(reaches().test(line), line).toBe(false);
	});

	it("reaches the member in no core module but the indexer", () => {
		const offenders = sourceFiles(CORE, SKIP_DIRS)
			.filter((file) => file !== OWNER)
			.filter((file) => reaches().test(codeOnly(readSwept(file) ?? "")))
			.map((file) => basename(file));

		expect(
			offenders,
			"telling a provider what the index did belongs to core/src/indexer.ts, the only module that writes facts",
		).toEqual([]);
	});

	// Counted, not merely found: a second publication earlier in the file leaves a later one for an
	// ordering check to land on, which passes on a case it was not shown.
	it("publishes admitted once, after the store has committed the facts", () => {
		const code = codeOnly(readSwept(OWNER) ?? "");
		const commit = code.indexOf("this.store.replaceFile(");
		expect(commit, "the indexer commits through store.replaceFile").toBeGreaterThan(-1);

		const admitted = [...code.matchAll(/status: "admitted"/g)].map((match) => match.index);
		expect(admitted, "one road admits a parse").toHaveLength(1);
		expect(admitted[0], "the admitted verdict is published after the commit, never before").toBeGreaterThan(commit);
	});

	it("reads the parser's incarnation before the parse it will publish for", () => {
		const code = codeOnly(readSwept(OWNER) ?? "");
		const read = code.indexOf("this.supervisor.incarnationOf(");
		const parse = code.indexOf('"parseFile"');
		expect(read, "the indexer reads which process answers").toBeGreaterThan(-1);
		expect(parse, "the indexer parses").toBeGreaterThan(-1);
		expect(read, "a restart between the two must not inherit the verdict").toBeLessThan(parse);
	});

	// Call sites, not `status` literals: a road building its outcome through a helper would add a
	// publication without moving a count of the literals. Which road publishes what is pinned by
	// moduleAdmission.test.ts, which drives each of them.
	it("publishes from a counted set of call sites", () => {
		const code = codeOnly(readSwept(OWNER) ?? "");
		const sites = [...code.matchAll(/this\.publish\(/g)];
		expect(sites, "the commit, the refused parse, and the fault under the commit").toHaveLength(3);

		const road = code.indexOf("private publish(");
		expect(road, "one road reaches the port").toBeGreaterThan(-1);
		expect([...code.matchAll(reaches())].length, "only that road names the port member").toBe(1);
	});

	it("records the failure before it publishes a refusal", () => {
		const code = codeOnly(readSwept(OWNER) ?? "");
		const at = code.indexOf("private refuseParse(");
		expect(at, "one road refuses a parse").toBeGreaterThan(-1);

		const recorded = code.indexOf("this.store.recordFailure(", at);
		const published = code.indexOf("this.publish(", at);
		expect(recorded, "refuseParse records through the store").toBeGreaterThan(at);
		expect(published, "it publishes after it records").toBeGreaterThan(recorded);
	});
});
