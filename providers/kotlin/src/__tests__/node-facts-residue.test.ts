import { describe, expect, it } from "bun:test";
import { basename, join } from "node:path";
import { codeOnly, readSwept, sourceFiles } from "@nyaa-lexicon/protocol";

/** A syntax node carries syntax; a derived fact lives in `environment.ts`, keyed by the node. */
const SRC = join(import.meta.dirname, "..");

/** What tree-sitter reports. Anything else is derived. */
const STRUCTURAL = ["children", "end", "field", "missing", "named", "parent", "start", "type"];

/**
 * Widening a node's static type, or reopening its interface, is the way past `tsc`.
 *
 * No provider source spells any of these today, so none carries an allowlist entry.
 */
const BYPASSES = [
	"declare module",
	"as Record<",
	"as any",
	"as unknown",
	"Object.assign",
	"Object.defineProperty",
	"Reflect.set",
];

const SKIP = ["__tests__", ".tsbuild", "dist", "node_modules"];

/** Members of an interface, one per line. A member the scan cannot read keeps its whole line, so it fails. */
function interfaceMembers(source: string, name: string): string[] | null {
	const opener = `export interface ${name} {`;
	const at = source.indexOf(opener);
	if (at < 0) return null;
	const members: string[] = [];
	for (const line of source.slice(at + opener.length).split("\n")) {
		const trimmed = line.trim();
		if (trimmed === "}") return members;
		if (trimmed === "") continue;
		const cut = trimmed.search(/[?:(]/u);
		members.push(cut < 0 ? trimmed : trimmed.slice(0, cut));
	}
	return null;
}

function providerSources(): Array<{ file: string; source: string }> {
	const read: Array<{ file: string; source: string }> = [];
	for (const file of sourceFiles(SRC, SKIP)) {
		const text = readSwept(file);
		if (text !== null) read.push({ file, source: codeOnly(text) });
	}
	return read;
}

////////////////////////////////
//  Tests

describe("a syntax node carries syntax, never a derived fact", () => {
	it("declares only what tree-sitter reports on SyntaxNode", () => {
		const text = readSwept(join(SRC, "tree.ts"));
		expect(text, "tree.ts is the home of SyntaxNode and the sweep must read it").not.toBeNull();
		const members = interfaceMembers(codeOnly(text as string), "SyntaxNode");
		expect(members, "SyntaxNode was not found in tree.ts, so this test checked nothing").not.toBeNull();
		expect(
			[...(members as string[])].sort(),
			"a fact about a node belongs in environment.ts, keyed by the node, never on the node",
		).toEqual(STRUCTURAL);
	});

	it("never widens a node's type or reopens its interface", () => {
		const read = providerSources();
		expect(read.length, "the sweep found no provider source, so it checked nothing").toBeGreaterThanOrEqual(8);
		const offenders: string[] = [];
		for (const { file, source } of read) {
			for (const bypass of BYPASSES) if (source.includes(bypass)) offenders.push(`${basename(file)}: ${bypass}`);
		}
		expect(offenders, "a widened or reopened node lets a derived fact back onto the tree").toEqual([]);
	});
});
