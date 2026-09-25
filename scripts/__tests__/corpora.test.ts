import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { sourceFiles } from "../../protocol/src/residue.js";
import { CORPORA } from "../corpora";

const ROOT = path.join(import.meta.dirname, "..", "..");
const SKIP = [".git", ".tsbuild", "dist", "node_modules", "temp"];
/** Scratch, never cloned. */
const SCRATCH = new Set(["mutants"]);
const TEMP_READ = /["'`]temp\/([\w.-]+)|["'`]temp["'`],\s*["'`]([\w.-]+)["'`]/g;

test("every corpus a test reads under temp/ is pinned, and every pinned corpus is read", () => {
	const files = sourceFiles(ROOT, SKIP).filter((file) => file.endsWith(".test.ts"));
	const read = new Set<string>();
	for (const file of files) {
		for (const match of readFileSync(file, "utf8").matchAll(TEMP_READ)) {
			const dir = match[1] ?? match[2]!;
			if (!SCRATCH.has(dir)) read.add(dir);
		}
	}
	const pinned = new Set(CORPORA.map((corpus) => corpus.dir));
	expect({
		swept: files.length > 0,
		unpinned: [...read].filter((dir) => !pinned.has(dir)),
		unread: [...pinned].filter((dir) => !read.has(dir)),
	}).toEqual({ swept: true, unpinned: [], unread: [] });
});
