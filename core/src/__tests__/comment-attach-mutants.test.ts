import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseSource } from "@nyaa-lexicon/protocol/ast";
import ts from "typescript";
import type { attachComments } from "../commentAttach";
import { lexiconRoot } from "../providers";
import { CASES } from "./commentAttachCases";

/** One mutant per attachment defect that shipped; the case table must fail each. */
const SOURCE = join(import.meta.dirname, "..", "commentAttach.ts");

/** Outside `core/src`, where the residue sweeps walk, and inside the checkout, where packages resolve. */
const MUTANTS_DIR = join(lexiconRoot(), "temp", "mutants");

interface Mutant {
	name: string;
	/** Must occur exactly once, so a moved rule fails here instead of silently seeding nothing. */
	find: string;
	replace: string;
}

const MUTANTS: Mutant[] = [
	{
		name: "a run's membership is read from the group grown so far, so three break into two and one",
		find: "\t\t\tlast?.joinable === true &&\n\t\t\titem.joinable &&",
		replace:
			"\t\t\tlast?.joinable === true &&\n\t\t\titem.joinable &&\n\t\t\t(current?.[0] as Placed).comment.range.start.line === last.comment.range.end.line &&",
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
	{
		name: "a comment among a declaration's attributes leads its first member",
		find: "\t\tcomparePoints(group.range.end, name) < 0 &&",
		replace: "\t\tfalse &&",
	},
];

/** One directory per run, so two runs at once never read each other's mutants. */
let runDir: string | undefined;
let loads = 0;

afterAll(() => {
	if (runDir !== undefined) rmSync(runDir, { recursive: true, force: true });
});

/** Each relative or workspace-package import specifier, made absolute. */
function relocatedImports(text: string): string {
	const { source } = parseSource(SOURCE, text);
	const edits = source.statements.flatMap((statement) => {
		const specifier =
			ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)
				? statement.moduleSpecifier
				: undefined;
		if (specifier === undefined || !ts.isStringLiteral(specifier)) return [];
		const written = specifier.text;
		const target = written.startsWith("./")
			? join(import.meta.dirname, "..", written.slice("./".length))
			: /^@nyaa-lexicon\/[a-z-]+$/.test(written)
				? join(lexiconRoot(), written.slice("@nyaa-lexicon/".length), "src", "index.ts")
				: undefined;
		return target === undefined ? [] : [{ start: specifier.getStart(source), end: specifier.end, target }];
	});
	return edits.reduceRight(
		(out, edit) => `${out.slice(0, edit.start)}${JSON.stringify(edit.target)}${out.slice(edit.end)}`,
		text,
	);
}

async function mutated(index: number, mutant: Mutant): Promise<typeof attachComments> {
	const source = readFileSync(SOURCE, "utf8");
	expect(source.split(mutant.find).length - 1, `mutant site for: ${mutant.name}`).toBe(1);
	mkdirSync(MUTANTS_DIR, { recursive: true });
	runDir ??= mkdtempSync(join(MUTANTS_DIR, "run-"));
	const file = join(runDir, `commentAttach.mutant-${index}.ts`);
	// Every import becomes absolute, so the copy resolves what the source does. Workspace packages
	// are rewritten too: the copy lives outside any node_modules that would otherwise resolve them.
	const relocated = relocatedImports(source);
	writeFileSync(file, relocated.replace(mutant.find, mutant.replace));
	// A fresh query each load, so a rewritten mutant is never served from the module cache.
	const loaded = (await import(/* @vite-ignore */ `${pathToFileURL(file).href}?run=${++loads}`)) as {
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
