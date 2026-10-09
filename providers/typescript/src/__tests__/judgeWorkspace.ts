// Fixture workspaces for the load-cycle judge, and the requests that ask it about them.

import { expect } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { hashContent, type JudgeLoadCycleAnswer } from "@nyaa-lexicon/protocol";
import { harness } from "./harness.js";

export type Answered = Extract<JudgeLoadCycleAnswer, { verdict: unknown }>;

export type Files = Record<string, string>;

export const roots: string[] = [];

export const ESM = { module: "ESNext", moduleResolution: "Bundler" };
export const CJS = { module: "CommonJS" };
export const RUNTIMES = [
	["esm", ESM],
	["cjs", CJS],
] as const;
/** Hand-written CommonJS. */
export const SCRIPTS = { ...CJS, allowJs: true };

/**
 * A workspace of `files`, and a request naming `members`. Every source file is parsed and admitted,
 * unless `scope` names what the index's scope admits: then only the members are, the rest pending.
 */
export function indexed(files: Files, options: object, members: string[], entries: string[], scope?: string[]) {
	const root = mkdtempSync(path.join(tmpdir(), "lexicon-ts-judge-"));
	roots.push(root);
	const config = { compilerOptions: { target: "ES2022", strict: true, skipLibCheck: true, ...options } };
	writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify(config));
	for (const [module, text] of Object.entries(files)) {
		mkdirSync(path.dirname(path.join(root, module)), { recursive: true });
		writeFileSync(path.join(root, module), text);
	}
	const provider = harness();
	provider.initialize(root);
	if (scope !== undefined) provider.handlers.discoverProject({ workspaceRoot: root, scope });
	/** Each declaration the index holds, by its id. */
	const declared = new Map<string, { module: string; name: string }>();
	for (const [module, text] of Object.entries(files)) {
		if (!/\.[cm]?[jt]sx?$/.test(module) || (scope !== undefined && !members.includes(module))) continue;
		const facts = provider.parseFile({ module, contentHash: hashContent(text), text }) as {
			declarations?: Array<{ symbolId: string; name: string }>;
		};
		for (const { symbolId, name } of facts.declarations ?? []) declared.set(symbolId, { module, name });
	}
	const request = {
		members: members.map((module) => ({ module, contentHash: hashContent(files[module] ?? "") })),
		entries,
	};
	return { provider, request, declared };
}

/** Indexes the files, then asks the judge until it answers, each slice continuing the last. */
export async function judge(
	files: Files,
	options: object,
	members: string[],
	entries: string[],
	scope?: string[],
): Promise<Answered> {
	return (await judgeIndexed(files, options, members, entries, scope)).answer;
}

/** The judge's answer, beside the declarations the index holds. */
export async function judgeIndexed(
	files: Files,
	options: object,
	members: string[],
	entries: string[],
	scope?: string[],
): Promise<{ answer: Answered; declared: ReadonlyMap<string, { module: string; name: string }> }> {
	const { provider, request, declared } = indexed(files, options, members, entries, scope);
	let answer = await provider.handlers.judgeLoadCycle?.(request);
	while (answer !== undefined && "partial" in answer)
		answer = await provider.handlers.judgeLoadCycle?.({ ...request, partial: answer.partial });
	provider.shutdown();
	if (answer === undefined || "partial" in answer) throw new Error("the judge gave no answer");
	return { answer, declared };
}

/** The verdict from each entry on its own. */
export async function verdicts(files: Files, options: object, members: string[]): Promise<Record<string, string>> {
	const found: Record<string, string> = {};
	for (const entry of members) found[entry] = (await judge(files, options, members, [entry])).verdict;
	return found;
}

/** `b` reads `A` from `a` in `shape`, while `a` loads `b` before it initializes `A`. */
export function reading(shape: string, imports = 'import { A } from "./a";'): Files {
	return {
		"a.ts": 'import "./b";\nexport const A = 1;',
		"b.ts": `${imports}\ndeclare function unseen(): void;\ndeclare const flag: boolean;\n${shape}\nexport {};`,
	};
}

export async function entering(shape: string, options: object = ESM): Promise<string> {
	return (await judge(reading(shape), options, ["a.ts", "b.ts"], ["a.ts"])).verdict;
}

/** Each shape's verdict entering `a`, beside the one expected, under every runtime. */
export async function expectShapes(
	cases: ReadonlyArray<readonly [shape: string, verdict: string]>,
	extra: object = {},
	runtimes: ReadonlyArray<readonly [string, object]> = RUNTIMES,
): Promise<void> {
	const found: string[][] = [];
	const expected: string[][] = [];
	for (const [runtime, options] of runtimes) {
		for (const [shape, verdict] of cases) {
			found.push([runtime, shape, await entering(shape, { ...options, ...extra })]);
			expected.push([runtime, shape, verdict]);
		}
	}
	expect(found).toEqual(expected);
}

/** Removes every workspace a test made. */
export function cleanWorkspaces(): void {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}
