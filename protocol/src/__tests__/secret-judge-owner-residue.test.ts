import { describe, expect, it } from "bun:test";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";
import { importSpecifiers, parseSource } from "../astResidue";
import { readSwept, sourceFiles } from "../residue";

/** One evaluator, two allowed callers. */

////////////////////////////////
//  Constants

const ROOT = join(import.meta.dirname, "..", "..", "..");
const SKIP = new Set(["__tests__", "dist", "node_modules", ".tsbuild", ".unslop", ".git", "temp"]);
const PACKAGE_SPECIFIER = "@nyaa-lexicon/protocol/secretJudge";
const JUDGE = join(ROOT, "protocol/src/secretJudge");
const IMPORTERS = new Set(["core/src/secretPolicy.ts", "protocol/src/readPolicy.ts"]);

const JUDGE_EXPORTS = ["SecretAccess", "SecretJudge", "SecretJudgeConfig", "SecretJudgeEvidence", "SecretPolicyWire"];

const POLICY_EXPORTS = [
	"AdmittedAs",
	"AdmittedBytes",
	"JournalAdmission",
	"JournalAdmissionResult",
	"JournalBytesResult",
	"ModuleVerdict",
	"PolicyAffected",
	"PolicyChange",
	"PolicyIndex",
	"PolicyJournal",
	"PolicyProviders",
	"PolicyTrigger",
	"ProviderVerdict",
	"ReaderVerdict",
	"SecretAdmission",
	"SecretPolicy",
	"SecretPolicyConfig",
	"SecretPolicyInitialOptions",
	"SecretPolicySnapshot",
	"SecretVerdict",
	"StoredAdmission",
	"StoredFailure",
	"UnparsedVerdict",
];

/** Protocol-root exports. */
const RETIRED_ROOT_EXPORTS = [
	"BUILT_IN_SECRETS",
	"SecretCandidate",
	"secretAnswerFor",
	"secretDiscoveryGlobs",
	"secretRuleFor",
	"secretTrackingMatcher",
];

/** Runtime dependencies shipped to providers. */
const JUDGE_CLOSURE = ["protocol/src/glob.ts", "protocol/src/secretJudge.ts", "protocol/src/secretMatchers.ts"];

////////////////////////////////
//  Functions

function reachesJudge(file: string, specifier: string): boolean {
	if (specifier === PACKAGE_SPECIFIER) return true;
	if (!specifier.startsWith(".")) return false;
	return resolve(dirname(file), specifier).replace(/\.(?:js|ts)$/, "") === JUDGE;
}

function judgeImporters(files: ReadonlyArray<{ file: string; text: string }>): string[] {
	return files
		.filter(({ file, text }) =>
			importSpecifiers(parseSource(file, text).source).some((specifier) => reachesJudge(file, specifier)),
		)
		.map(({ file }) => relative(ROOT, file))
		.sort();
}

function exportedNames(source: ts.SourceFile): string[] {
	const names = new Set<string>();
	for (const statement of source.statements) {
		if (ts.isExportDeclaration(statement)) {
			const clause = statement.exportClause;
			if (clause === undefined || !ts.isNamedExports(clause))
				names.add(`* from ${statement.moduleSpecifier?.getText(source)}`);
			else for (const element of clause.elements) names.add(element.name.text);
			continue;
		}
		if (ts.isExportAssignment(statement)) {
			names.add("default");
			continue;
		}
		const exported = ts.canHaveModifiers(statement)
			? ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true
			: false;
		if (!exported) continue;
		if (ts.isVariableStatement(statement)) {
			for (const declaration of statement.declarationList.declarations)
				names.add(declaration.name.getText(source));
		} else if ("name" in statement && statement.name !== undefined) {
			names.add((statement.name as ts.Identifier).text);
		}
	}
	return [...names].sort();
}

/** Runtime imports and re-exports. */
function runtimeSpecifiers(source: ts.SourceFile): string[] {
	const typeOnly: string[] = [];
	for (const statement of source.statements) {
		const declared =
			ts.isImportDeclaration(statement) && statement.importClause?.isTypeOnly === true
				? statement.moduleSpecifier
				: ts.isExportDeclaration(statement) && statement.isTypeOnly
					? statement.moduleSpecifier
					: undefined;
		if (declared !== undefined && ts.isStringLiteral(declared)) typeOnly.push(declared.text);
	}
	const loaded = importSpecifiers(source);
	for (const specifier of typeOnly) loaded.splice(loaded.indexOf(specifier), 1);
	return loaded;
}

/** Runtime dependency graph and external specifiers. */
function runtimeClosure(
	entry: string,
	read: (file: string) => string | undefined,
): { files: string[]; external: string[] } {
	const files = new Set<string>();
	const external = new Set<string>();
	const pending = [entry];
	while (pending.length > 0) {
		const file = pending.pop() as string;
		if (files.has(file)) continue;
		files.add(file);
		const text = read(file);
		if (text === undefined) continue;
		for (const specifier of runtimeSpecifiers(parseSource(file, text).source)) {
			if (specifier.startsWith(".")) pending.push(resolve(dirname(file), specifier).replace(/\.js$/, ".ts"));
			else external.add(specifier);
		}
	}
	return { files: [...files].map((file) => relative(ROOT, file)).sort(), external: [...external].sort() };
}

function sweptFiles(): Array<{ file: string; text: string }> {
	return sourceFiles(ROOT, SKIP).flatMap((file) => {
		const text = readSwept(file);
		return text === null || !text.includes("secretJudge") ? [] : [{ file, text }];
	});
}

function exportsOf(path: string): string[] {
	const file = join(ROOT, path);
	return exportedNames(parseSource(file, readSwept(file) ?? "").source);
}

////////////////////////////////
//  Tests

describe("one secret rule evaluator", () => {
	it("finds source files to check", () => {
		expect(sourceFiles(join(ROOT, "core/src"), SKIP).length).toBeGreaterThan(0);
		expect(sourceFiles(join(ROOT, "protocol/src"), SKIP).length).toBeGreaterThan(0);
		expect(sweptFiles().length).toBeGreaterThan(0);
	});

	it("is imported only by the policy and the provider read policy", () => {
		const importers = judgeImporters(sweptFiles());

		expect(importers.filter((file) => !IMPORTERS.has(file))).toEqual([]);
		expect(importers).toContain("core/src/secretPolicy.ts");
	});

	it("is not exported from the protocol root, and the policy exports no evaluator", () => {
		const root = exportsOf("protocol/src/index.ts");

		expect(root.filter((name) => JUDGE_EXPORTS.includes(name) || RETIRED_ROOT_EXPORTS.includes(name))).toEqual([]);
		expect(exportsOf("core/src/secretPolicy.ts")).toEqual(POLICY_EXPORTS);
		expect(exportsOf("protocol/src/secretJudge.ts")).toEqual(JUDGE_EXPORTS);
	});

	it("loads nothing at run time but the glob and matcher grammars", () => {
		const closure = runtimeClosure(`${JUDGE}.ts`, (file) => readSwept(file) ?? undefined);

		expect(closure.files).toEqual(JUDGE_CLOSURE);
		expect(closure.external).toEqual([]);
	});

	it("finds each planted escape", () => {
		const outsider = join(ROOT, "core/src/leak.ts");
		const imported = `import { SecretJudge } from "${PACKAGE_SPECIFIER}";\nSecretJudge;`;
		const relativeImport = `import { SecretJudge } from "../../protocol/src/secretJudge.js";\nSecretJudge;`;
		const reexport = `export { SecretJudge } from "${PACKAGE_SPECIFIER}";`;
		const star = `export * from "../../protocol/src/secretJudge";`;
		const owner = join(ROOT, "core/src/secretPolicy.ts");

		expect(judgeImporters([{ file: outsider, text: imported }])).toEqual(["core/src/leak.ts"]);
		expect(judgeImporters([{ file: outsider, text: relativeImport }])).toEqual(["core/src/leak.ts"]);
		expect(judgeImporters([{ file: outsider, text: reexport }])).toEqual(["core/src/leak.ts"]);
		expect(judgeImporters([{ file: outsider, text: star }])).toEqual(["core/src/leak.ts"]);
		expect(judgeImporters([{ file: owner, text: imported }])).toEqual(["core/src/secretPolicy.ts"]);
		expect(judgeImporters([{ file: outsider, text: 'import { x } from "./other.js";' }])).toEqual([]);

		const policy = parseSource("policy.ts", "export class SecretPolicy {}\nexport function answerFor() {}").source;
		const rexported = parseSource("index.ts", 'export { secretRuleFor } from "./secrets.js";').source;
		expect(exportedNames(policy)).toEqual(["SecretPolicy", "answerFor"]);
		expect(exportedNames(rexported)).toEqual(["secretRuleFor"]);
		expect(exportedNames(parseSource("star.ts", 'export * from "./secretJudge.js";').source)).toHaveLength(1);

		const files = new Map([
			[
				"/w/judge.ts",
				'import { a } from "./leaf.js";\nimport type { B } from "./types.js";\nexport const j = a;',
			],
			["/w/leaf.ts", 'import { createHash } from "node:crypto";\nimport { z } from "zod";\nexport const a = 1;'],
			["/w/types.ts", 'import { z } from "zod";'],
		]);
		const planted = runtimeClosure("/w/judge.ts", (file) => files.get(file));
		expect(planted.external).toEqual(["node:crypto", "zod"]);
		expect(planted.files).toHaveLength(2);
	});
});
