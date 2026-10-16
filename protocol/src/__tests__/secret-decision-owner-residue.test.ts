import { describe, expect, it } from "bun:test";
import { join, relative } from "node:path";
import ts from "typescript";
import { callsTo, declaresName, lineOf, literalText, nodesIn, type ParsedSource, parseSource } from "../astResidue";
import { readSwept, sourceFiles } from "../residue";

/** Decisions own masking; readers own facts. */

////////////////////////////////
//  Constants

const ROOT = join(import.meta.dirname, "..", "..", "..");
const SKIP = new Set(["__tests__", "dist", "node_modules", ".tsbuild", ".unslop", ".git", "temp"]);
const DECISION = "protocol/src/secretDecision.ts";
/** Hazard checks inspect fields, not names. */
const CONTRACT = "protocol/src/secretSyntax.ts";
const MATCHERS = "protocol/src/secretMatchers.ts";
const READS_CONTRACT = ["secretSyntax", "secretDecision"];
const GRAMMAR_ROOTS = ["core/src", "formats/src", "protocol/src"];

const NAME_MATCHES = new Set(["includes", "some", "every", "find", "findIndex", "indexOf"]);
const HAZARD_FIELDS = new Set(["reach", "reshapes", "within"]);
const GRAMMAR_NAMES = [
	"isMatcherMap",
	"matcherKind",
	"parseMatcher",
	"pathParts",
	"pathSegments",
	"validateMatcherMap",
];

////////////////////////////////
//  Functions

function readsContract(text: string): boolean {
	return READS_CONTRACT.some((name) => text.includes(name));
}

/** Parsed contract readers. */
function contractReaders(): ParsedSource[] {
	return sourceFiles(ROOT, SKIP).flatMap((file) => {
		const text = readSwept(file);
		return text === null || !readsContract(text) ? [] : [parseSource(file, text)];
	});
}

function rooted(parsed: ParsedSource): string {
	return relative(ROOT, parsed.file);
}

/** Calls and matcher-name lists. */
function nameMatching(parsed: ParsedSource): string[] {
	const asked = callsTo(parsed.source, "mayName");
	const listed = nodesIn(parsed.source).filter(
		(node): node is ts.CallExpression =>
			ts.isCallExpression(node) &&
			ts.isPropertyAccessExpression(node.expression) &&
			NAME_MATCHES.has(node.expression.name.text) &&
			ts.isPropertyAccessExpression(node.expression.expression) &&
			node.expression.expression.name.text === "names",
	);
	return [...asked, ...listed].map((node) => `${rooted(parsed)}:${lineOf(parsed, node)} name matching`);
}

/** Hazard field reads. */
function hazardConsequences(parsed: ParsedSource): string[] {
	return nodesIn(parsed.source)
		.filter((node) => ts.isPropertyAccessExpression(node) && HAZARD_FIELDS.has(node.name.text))
		.map((node) => `${rooted(parsed)}:${lineOf(parsed, node)} hazard consequence`);
}

function decisionOffenders(files: readonly ParsedSource[]): string[] {
	return files.flatMap((parsed) => {
		const path = rooted(parsed);
		if (path === DECISION) return [];
		return [...nameMatching(parsed), ...(path === CONTRACT ? [] : hazardConsequences(parsed))];
	});
}

/** Matcher grammar declarations. */
function grammarCopies(parsed: ParsedSource): string[] {
	const declared = GRAMMAR_NAMES.filter((name) => declaresName(parsed.source, name));
	const marked = callsTo(parsed.source, "startsWith").filter((call) => literalText(call.arguments[0]) === "@");
	return [
		...declared.map((name) => `${rooted(parsed)} declares ${name}`),
		...marked.map((call) => `${rooted(parsed)}:${lineOf(parsed, call)} tests for @`),
	];
}

function grammarOffenders(files: readonly ParsedSource[]): string[] {
	return files.flatMap((parsed) => (rooted(parsed) === MATCHERS ? [] : grammarCopies(parsed)));
}

function grammarSources(): ParsedSource[] {
	return GRAMMAR_ROOTS.flatMap((root) =>
		sourceFiles(join(ROOT, root), SKIP).flatMap((file) => {
			const text = readSwept(file);
			return text === null ? [] : [parseSource(file, text)];
		}),
	);
}

////////////////////////////////
//  Tests

describe("one secret decision", () => {
	const readers = contractReaders();

	it("finds the files that read the contract", () => {
		const found = readers.map(rooted);

		expect(found).toContain(DECISION);
		expect(found).toContain("core/src/secretPolicy.ts");
		expect(found.some((path) => path.startsWith("formats/src/secret/"))).toBe(true);
	});

	it("matches names and weighs hazards only in the decision", () => {
		expect(decisionOffenders(readers)).toEqual([]);
	});

	it("declares the matcher grammar once", () => {
		const sources = grammarSources();

		expect(sources.map(rooted)).toContain(MATCHERS);
		expect(grammarOffenders(sources)).toEqual([]);
	});

	it("finds each planted escape", () => {
		const text = `import type { SecretHazard, SecretNode } from "@nyaa-lexicon/protocol/secretSyntax";
function leak(format: any, text: string, node: SecretNode, hazard: SecretHazard, nodes: SecretNode[]) {
	format.mayName(text, node.key, ["data"]);
	node.names.includes("data");
	(nodes[0] as SecretNode).names.some((name) => name === "data");
	return hazard.reach === "any" || hazard.reshapes || hazard.within === 0;
}`;
		const at = (path: string) => parseSource(join(ROOT, path), text);

		expect(readsContract(text)).toBe(true);
		expect(decisionOffenders([at("core/src/leak.ts")])).toHaveLength(6);
		expect(decisionOffenders([at("formats/src/secret/leak.ts")])).toHaveLength(6);
		expect(decisionOffenders([at(CONTRACT)])).toHaveLength(3);
		expect(decisionOffenders([at(DECISION)])).toEqual([]);

		const copy = `export function pathParts(path: string) { return path.startsWith("@") ? null : path.split("."); }
const isMatcherMap = () => true;`;
		const copied = (path: string) => parseSource(join(ROOT, path), copy);

		expect(grammarOffenders([copied("core/src/leak.ts")])).toHaveLength(3);
		expect(grammarOffenders([copied(MATCHERS)])).toEqual([]);
	});
});
