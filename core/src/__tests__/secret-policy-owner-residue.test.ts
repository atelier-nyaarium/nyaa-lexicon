import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { sourceFiles } from "@nyaa-lexicon/protocol";
import { calleeOf, callsIn, lineOf, parsedFiles, parseSource, usesName } from "@nyaa-lexicon/protocol/ast";
import ts from "typescript";

////////////////////////////////
//  Constants

const CORE_SRC = join(import.meta.dirname, "..");
const SKIP = ["__tests__", "dist", "node_modules", ".tsbuild"];
const POLICY_CALLS = new Set(["assessSecretText", "secretFormatFor", "verifySecretSyntax"]);
const STAMP_CALLS = new Set(["policyStampOf", "policyStamps", "policyStampsOf"]);
const CONFIG_READ_CALLS = new Set(["readScopeConfig"]);
const POLICY_CONSTRUCTION = new Set(["SecretPolicySnapshot"]);
const OWNER = "secretPolicy.ts";
const STAMP_OWNER = "indexer.ts";

////////////////////////////////
//  Functions

function callsNamed(parsed: ReturnType<typeof parsedFiles>[number], names: ReadonlySet<string>): ts.CallExpression[] {
	return callsIn(parsed.source).filter((call) => {
		const callee = calleeOf(call);
		return callee !== undefined && names.has(callee.name);
	});
}

function callOffenders(sources: ReturnType<typeof parsedFiles>, names: ReadonlySet<string>, owner: string): string[] {
	return sources.flatMap((parsed) =>
		relative(CORE_SRC, parsed.file) === owner
			? []
			: callsNamed(parsed, names).map((call) => {
					const callee = calleeOf(call);
					return `${relative(CORE_SRC, parsed.file)}:${lineOf(parsed, call)} ${callee?.name}`;
				}),
	);
}

function enclosingCallable(node: ts.Node): string | undefined {
	for (let at: ts.Node | undefined = node.parent; at !== undefined; at = at.parent) {
		if (
			(ts.isMethodDeclaration(at) || ts.isFunctionDeclaration(at)) &&
			at.name !== undefined &&
			ts.isIdentifier(at.name)
		)
			return at.name.text;
	}
	return undefined;
}

function snapshotConstructionOffenders(sources: ReturnType<typeof parsedFiles>): string[] {
	return sources.flatMap((parsed) => {
		if (relative(CORE_SRC, parsed.file) === OWNER) return [];
		return parsed.source.statements.flatMap((statement) => {
			const found: string[] = [];
			const visit = (node: ts.Node): void => {
				if (
					ts.isNewExpression(node) &&
					ts.isIdentifier(node.expression) &&
					POLICY_CONSTRUCTION.has(node.expression.text)
				)
					found.push(relative(CORE_SRC, parsed.file));
				ts.forEachChild(node, visit);
			};
			visit(statement);
			return found;
		});
	});
}

function refreshCallers(sources: ReturnType<typeof parsedFiles>): string[] {
	return sources.flatMap((parsed) =>
		callsNamed(parsed, new Set(["refresh"])).map(() => relative(CORE_SRC, parsed.file)),
	);
}

function forbiddenPolicyImports(sources: ReturnType<typeof parsedFiles>): string[] {
	return sources.flatMap((parsed) => {
		const file = relative(CORE_SRC, parsed.file);
		if (file !== OWNER && file !== "../../protocol/src/secretJudge.ts") return [];
		return parsed.source.statements.flatMap((statement) => {
			if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) return [];
			const specifier = statement.moduleSpecifier.text;
			const forbidden = ["node:fs", "node:child_process"].includes(specifier);
			const named = statement.importClause?.namedBindings;
			const importedNames =
				named !== undefined && ts.isNamedImports(named)
					? named.elements.map((element) => element.name.text)
					: [];
			return [
				...(forbidden ? [`${relative(CORE_SRC, parsed.file)}:${specifier}`] : []),
				...importedNames
					.filter((name) => ["runGit", "resolveContained"].includes(name))
					.map((name) => `${relative(CORE_SRC, parsed.file)}:${name}`),
			];
		});
	});
}

function evidenceInputKinds(sources: ReturnType<typeof parsedFiles>): string[] {
	const parsed = sources.find((source) => relative(CORE_SRC, source.file) === "policyEvidence.ts") ?? sources[0];
	if (parsed === undefined) return [];
	const keys = new Set<string>();
	const visit = (node: ts.Node): void => {
		if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "input") {
			const key = node.arguments[0];
			if (key !== undefined && ts.isStringLiteral(key)) keys.add(key.text);
		}
		if (ts.isTemplateExpression(node) && ["listing:", "ignored:"].includes(node.head.text))
			keys.add(node.head.text);
		ts.forEachChild(node, visit);
	};
	visit(parsed.source);
	return [...keys];
}

function installVisibility(sources: ReturnType<typeof parsedFiles>): string[] {
	return sources.flatMap((parsed) => {
		if (relative(CORE_SRC, parsed.file) !== OWNER) return [];
		const policy = parsed.source.statements.find(
			(statement): statement is ts.ClassDeclaration =>
				ts.isClassDeclaration(statement) && statement.name?.text === "SecretPolicy",
		);
		const install = policy?.members.find(
			(member): member is ts.MethodDeclaration =>
				ts.isMethodDeclaration(member) && member.name.getText(parsed.source) === "install",
		);
		if (install === undefined) return ["secretPolicy.ts:install is missing"];
		return install.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.PrivateKeyword) === true
			? []
			: ["secretPolicy.ts:install is public"];
	});
}

function scopeAssignments(sources: ReturnType<typeof parsedFiles>): string[] {
	const found: string[] = [];
	for (const parsed of sources) {
		const visit = (node: ts.Node): void => {
			if (
				ts.isBinaryExpression(node) &&
				node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
				ts.isPropertyAccessExpression(node.left) &&
				node.left.expression.kind === ts.SyntaxKind.ThisKeyword &&
				node.left.name.text === "scope"
			) {
				found.push(`${relative(CORE_SRC, parsed.file)}:${enclosingCallable(node) ?? "no callable"}`);
			}
			ts.forEachChild(node, visit);
		};
		visit(parsed.source);
	}
	return found;
}

/** Files that unseal reads. */
function unsealers(sources: ReturnType<typeof parsedFiles>): string[] {
	return sources
		.filter((parsed) => usesName(parsed.source, "unseal"))
		.map((parsed) => relative(CORE_SRC, parsed.file));
}

/** Files that word withheld failures. */
function withholders(sources: ReturnType<typeof parsedFiles>): string[] {
	return sources
		.filter((parsed) => usesName(parsed.source, "SECRET_DETAILS_WITHHELD"))
		.map((parsed) => relative(CORE_SRC, parsed.file));
}

////////////////////////////////
//  Tests

describe("one secret policy owner", () => {
	const sources = parsedFiles(CORE_SRC, SKIP);

	it("finds source files to check", () => {
		expect(sourceFiles(CORE_SRC, SKIP).length).toBeGreaterThan(0);
	});

	it("keeps rule and format calls in the policy", () => {
		expect(callOffenders(sources, POLICY_CALLS, OWNER)).toEqual([]);
	});

	it("keeps config parsing and snapshot construction in the policy", () => {
		expect(callOffenders(sources, CONFIG_READ_CALLS, OWNER)).toEqual([]);
		expect(snapshotConstructionOffenders(sources)).toEqual([]);
	});

	it("keeps policy stamp reads in the indexer", () => {
		expect(callOffenders(sources, STAMP_CALLS, STAMP_OWNER)).toEqual([]);
	});

	it("installs the scope in one method", () => {
		expect(scopeAssignments(sources)).toEqual(["indexer.ts:installScope"]);
	});

	it("constructs snapshots only in the policy owner", () => {
		expect(snapshotConstructionOffenders(sources)).toEqual([]);
	});

	it("routes refresh through the owner, indexer and entry points", () => {
		expect([...new Set(refreshCallers(sources))].sort()).toEqual([
			"daemonCli.ts",
			"gradeCli.ts",
			"indexCli.ts",
			"indexer.ts",
			"secretPolicy.ts",
		]);
	});

	it("keeps install private and filesystem imports in evidence", () => {
		expect(installVisibility(sources)).toEqual([]);
		const judgePath = join(CORE_SRC, "../../protocol/src/secretJudge.ts");
		const judge = parseSource(judgePath, readFileSync(judgePath, "utf8"));
		expect(forbiddenPolicyImports([...sources, judge])).toEqual([]);
		const publicInstall = parseSource(join(CORE_SRC, OWNER), "class SecretPolicy { install() {} }");
		const fsImport = parseSource(join(CORE_SRC, OWNER), 'import { readFileSync } from "node:fs";');
		const gitImport = parseSource(join(CORE_SRC, OWNER), 'import { runGit } from "./fileScope.js";');
		const judgeImport = parseSource(judgePath, 'import { resolveContained } from "@nyaa-lexicon/protocol";');
		expect(installVisibility([publicInstall])).toEqual(["secretPolicy.ts:install is public"]);
		expect(forbiddenPolicyImports([fsImport])).toEqual(["secretPolicy.ts:node:fs"]);
		expect(forbiddenPolicyImports([gitImport])).toEqual(["secretPolicy.ts:runGit"]);
		expect(forbiddenPolicyImports([judgeImport])).toEqual(["../../protocol/src/secretJudge.ts:resolveContained"]);
	});

	it("opens a sealed read only in the policy, which sealing is defined beside", () => {
		expect(unsealers(sources).sort()).toEqual(["secretPolicy.ts", "sourceRead.ts"]);
	});

	it("words a guarded module's failure only in the policy", () => {
		expect(withholders(sources)).toEqual(["secretPolicy.ts"]);
	});

	it("finds each planted ownership escape", () => {
		const planted = parseSource(
			"negative-control.ts",
			`function leak(store: unknown, root: string) {
				assessSecretText();
				secretFormatFor();
				verifySecretSyntax();
				readScopeConfig("root");
				policyStampOf("a");
				policyStamps();
				policyStampsOf([], []);
				new SecretPolicySnapshot(view);
				this.secretPolicy.refresh({ kind: "startup" });
				public install() {}
				this.scope = null;
				unseal(read);
				const reason = SECRET_DETAILS_WITHHELD;
			}`,
		);
		const controls = [planted];

		expect(callOffenders(controls, POLICY_CALLS, OWNER)).toHaveLength(POLICY_CALLS.size);
		expect(callOffenders(controls, CONFIG_READ_CALLS, OWNER)).toHaveLength(1);
		expect(callOffenders(controls, STAMP_CALLS, STAMP_OWNER)).toHaveLength(3);
		expect(snapshotConstructionOffenders(controls)).toHaveLength(1);
		expect(refreshCallers(controls)).toHaveLength(1);
		expect(scopeAssignments(controls)).toHaveLength(1);
		expect(unsealers(controls)).toHaveLength(1);
		expect(withholders(controls)).toHaveLength(1);
	});

	it("requires repository-scoped evidence inputs", () => {
		const planted = parseSource(
			"negative-control.ts",
			`input("config", value);
			input("repositories", value);
			input("links", value);
			input("listing:", value);`,
		);
		expect(evidenceInputKinds(sources).sort()).toEqual(["config", "ignored:", "links", "listing:", "repositories"]);
		expect(evidenceInputKinds([planted]).sort()).toEqual(["config", "links", "listing:", "repositories"]);
	});
});
