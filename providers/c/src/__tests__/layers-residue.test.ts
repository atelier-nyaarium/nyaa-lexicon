import { describe, expect, it } from "bun:test";
import { basename, join } from "node:path";
import { memberReads, parsedFiles, parseSource } from "@nyaa-lexicon/protocol/ast";
import type ts from "typescript";

const SRC = join(import.meta.dirname, "..");

const SKIP = ["__tests__", ".tsbuild", "dist", "node_modules"];

/** The declaration parser's layers, from the records up. */
const LAYERS = new Set(["records.ts", "declarators.ts", "statements.ts", "declarations.ts"]);

/** Protected only so one layer reaches the next; everything past the layers reads declarations, never builds them. */
const SHARED = new Set([
	"scoped",
	"replaced",
	"addCandidate",
	"markQualifiedName",
	"code",
	"headHas",
	"topLevelIndex",
	"splitSegments",
	"argumentsClose",
	"pastAttributes",
	"looksLikeDeclaration",
	"readHead",
	"declarators",
	"candidateDeclarator",
	"findDeclaratorName",
	"header",
	"declaratorHeader",
	"markTypeRange",
	"nested",
	"findFunctionCandidate",
	"blockScope",
	"parseDeclaration",
]);

function sharedReads(source: ts.SourceFile): string[] {
	return memberReads(source)
		.filter(({ receiver, name }) => receiver === "this" && SHARED.has(name))
		.map(({ name }) => name);
}

////////////////////////////////
//  Tests

describe("the declaration layers keep their shared members to themselves", () => {
	it("reports a planted reach", () => {
		const planted = parseSource("planted.ts", "class P { run() { this.addCandidate(x); return this.scoped; } }");

		expect(sharedReads(planted.source)).toEqual(["addCandidate", "scoped"]);
	});

	it("finds them reached from no file outside the layers", () => {
		const outside = parsedFiles(SRC, SKIP).filter(({ file }) => !LAYERS.has(basename(file)));
		const offenders = outside.flatMap(({ file, source }) =>
			sharedReads(source).map((name) => `${basename(file)} ${name}`),
		);

		expect(outside.length).toBeGreaterThan(0);
		expect(offenders).toEqual([]);
	});
});
