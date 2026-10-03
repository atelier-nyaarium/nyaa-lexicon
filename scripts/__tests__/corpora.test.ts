import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { literalText, parseSource, stringsIn } from "../../protocol/src/astResidue.js";
import { sourceFiles } from "../../protocol/src/residue.js";
import { CORPORA } from "../corpora";

const ROOT = path.join(import.meta.dirname, "..", "..");
const SKIP = [".git", ".tsbuild", "dist", "node_modules", "temp"];
/** Scratch, never cloned. */
const SCRATCH = new Set(["mutants"]);

/** Each directory a file names under temp/: `"temp/dir"`, or `"temp"` then `"dir"` in one call or array. */
function tempDirsIn(file: string): string[] {
	const { source } = parseSource(file, readFileSync(file, "utf8"));
	const dirs = stringsIn(source).map(({ node, text }) => {
		if (text.startsWith("temp/")) return text.slice("temp/".length).split("/")[0];
		if (text !== "temp") return undefined;
		const { parent } = node;
		const siblings = ts.isCallExpression(parent)
			? parent.arguments
			: ts.isArrayLiteralExpression(parent)
				? parent.elements
				: undefined;
		return literalText(siblings?.[siblings.indexOf(node as ts.Expression) + 1])?.split("/")[0];
	});
	return dirs.filter((dir): dir is string => dir !== undefined && dir !== "");
}

test("every corpus a test reads under temp/ is pinned, and every pinned corpus is read", () => {
	const files = sourceFiles(ROOT, SKIP).filter((file) => file.endsWith(".test.ts"));
	const read = new Set(files.flatMap(tempDirsIn).filter((dir) => !SCRATCH.has(dir)));
	const pinned = new Set(CORPORA.map((corpus) => corpus.dir));
	expect({
		swept: files.length > 0,
		unpinned: [...read].filter((dir) => !pinned.has(dir)),
		unread: [...pinned].filter((dir) => !read.has(dir)),
	}).toEqual({ swept: true, unpinned: [], unread: [] });
});
