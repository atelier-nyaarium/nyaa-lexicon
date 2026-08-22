import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import type { attachComments } from "../commentAttach";
import { CASES } from "./commentAttachCases";

/** Four mutants, one per attachment defect that shipped; the case table must fail each. */
const SOURCE = join(import.meta.dirname, "..", "commentAttach.ts");

interface Mutant {
	name: string;
	/** Must occur exactly once, so a moved rule fails here instead of silently seeding nothing. */
	find: string;
	replace: string;
}

const MUTANTS: Mutant[] = [
	{
		name: "a run's membership is read from the group grown so far, so three break into two and one",
		find: "\t\t\tlast.joinable &&\n\t\t\titem.joinable &&",
		replace:
			"\t\t\tlast.joinable &&\n\t\t\titem.joinable &&\n\t\t\t(current?.[0] as Placed).comment.range.start.line === last.comment.range.end.line &&",
	},
	{
		name: "a comment inside a body leads the sibling declared below it",
		find: "\tif (scope !== undefined && comparePoints(scope.range.end, nearest.range.start) < 0) return undefined;",
		replace: "\tvoid scope;",
	},
	{
		name: "a block comment joins a line-comment run",
		find: "\t\t\t!isBlockComment(comment.text),",
		replace: "\t\t\ttrue,",
	},
	{
		name: "a declaration with no name span is read as if it had one",
		find: "declaration.selectionRange?.start.line === line ? [{ declaration, at: declaration.selectionRange.start }] : [],",
		replace:
			"(declaration.selectionRange as { start: { line: number } }).start.line === line ? [{ declaration, at: (declaration.selectionRange as { start: { line: number; character: number } }).start }] : [],",
	},
	{
		name: "every written line between a comment and a declaration is a wall",
		find: "\t\tif (blankLines.has(line) || declarationLines.has(line)) return false;",
		replace: "\t\tif (blankLines.has(line) || declarationLines.has(line) || line >= 0) return false;",
	},
];

const written: string[] = [];

afterAll(() => {
	for (const file of written) rmSync(file, { force: true });
});

async function mutated(index: number, mutant: Mutant): Promise<typeof attachComments> {
	const source = readFileSync(SOURCE, "utf8");
	expect(source.split(mutant.find).length - 1, `mutant site for: ${mutant.name}`).toBe(1);
	const file = join(import.meta.dirname, "..", `commentAttach.mutant-${index}.ts`);
	written.push(file);
	writeFileSync(file, source.replace(mutant.find, mutant.replace));
	// A fresh query each run, so a rewritten mutant is never served from the module cache.
	const loaded = (await import(/* @vite-ignore */ `${pathToFileURL(file).href}?run=${Date.now()}`)) as {
		attachComments: typeof attachComments;
	};
	return loaded.attachComments;
}

////////////////////////////////
//  Tests

describe("the attachment cases fail each seeded defect", () => {
	for (const [index, mutant] of MUTANTS.entries()) {
		it(`fail when ${mutant.name}`, async () => {
			const attach = await mutated(index, mutant);
			const caught = CASES.filter((testCase) => {
				try {
					testCase.run(attach);
					return false;
				} catch {
					return true;
				}
			});
			expect(
				caught.map((testCase) => testCase.name),
				`no case fails the mutant: ${mutant.name}`,
			).not.toEqual([]);
		});
	}
});
