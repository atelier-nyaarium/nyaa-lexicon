import { describe, expect, it } from "bun:test";
import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { calleeOf, callsIn, lineOf, type ParsedSource, parseSource } from "../astResidue";
import { readSwept, sourceFiles } from "../residue";

/** Stateful provider data stays in the kit. */
const PROVIDERS = join(import.meta.dirname, "..", "..", "..", "providers");

const SKIP_DIRS = new Set(["dist", "node_modules", ".tsbuild", "__tests__"]);

/** Source-content reads. */
const CONTENT_READS = new Set(["readFileSync", "readFile", "readSourceFile", "openSync", "createReadStream", "file"]);

/** Allowed configuration and asset reads. */
const ALLOWED_READS: Record<string, string> = {
	"rust/src/project.ts": "Cargo.toml",
	"gdscript/src/project.ts": "project.godot",
	"kotlin/src/tree.ts": "the bundled grammar",
	"typescript/src/analyzer.ts": "types and display of files the index does not hold",
	"typescript/src/project.ts": "tsconfig and package.json",
};

const COLLECTIONS = new Set(["Map", "Set", "WeakMap", "WeakSet", "Array"]);

const MUTATORS = new Set(["set", "add", "delete", "clear", "push", "pop", "shift", "unshift", "splice"]);

const KIT_NOTIFICATIONS = new Set(["moduleAdmission", "forgetModule", "probeFile"]);

////////////////////////////////
//  Helpers

function parsedProviders(): Array<{ provider: string; files: ParsedSource[] }> {
	return readdirSync(PROVIDERS, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => ({
			provider: entry.name,
			files: sourceFiles(join(PROVIDERS, entry.name, "src"), SKIP_DIRS).flatMap((file) => {
				const text = readSwept(file);
				return text === null ? [] : [parseSource(file, text)];
			}),
		}))
		.filter((entry) => entry.files.length > 0);
}

const where = (parsed: ParsedSource, node: ts.Node) => `${relative(PROVIDERS, parsed.file)}:${lineOf(parsed, node)}`;

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
	return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === kind);
}

function isCollection(initializer: ts.Expression | undefined): boolean {
	if (initializer === undefined) return false;
	if (ts.isArrayLiteralExpression(initializer) || ts.isObjectLiteralExpression(initializer)) return true;
	return (
		ts.isNewExpression(initializer) &&
		ts.isIdentifier(initializer.expression) &&
		COLLECTIONS.has(initializer.expression.text)
	);
}

function classesOf(source: ts.SourceFile): ts.ClassDeclaration[] {
	const found: ts.ClassDeclaration[] = [];
	const walk = (node: ts.Node): void => {
		if (ts.isClassDeclaration(node)) found.push(node);
		ts.forEachChild(node, walk);
	};
	walk(source);
	return found;
}

/** Instance fields and parameter properties. */
function fieldsOf(declaration: ts.ClassDeclaration): Array<{ node: ts.Node; name: string; init?: ts.Expression }> {
	const fields: Array<{ node: ts.Node; name: string; init?: ts.Expression }> = [];
	for (const member of declaration.members) {
		if (ts.isPropertyDeclaration(member) && !hasModifier(member, ts.SyntaxKind.StaticKeyword)) {
			const init = member.initializer;
			fields.push({ node: member, name: member.name.getText(), ...(init === undefined ? {} : { init }) });
		}
		if (ts.isConstructorDeclaration(member)) {
			for (const parameter of member.parameters) {
				if (ts.isParameterPropertyDeclaration(parameter, member))
					fields.push({ node: parameter, name: parameter.name.getText() });
			}
		}
	}
	return fields;
}

////////////////////////////////
//  Tests

describe("provider state lives in the kit's module store", () => {
	it("reads every provider's sources, and finds the stores, so a passing run is never vacuous", () => {
		const stores = parsedProviders().filter((entry) =>
			entry.files.some((parsed) => /\b(async)?[mM]oduleStore</.test(parsed.source.text)),
		);
		expect(stores.length).toBeGreaterThanOrEqual(9);
	});

	it("leaves staging, settling, probing and forgetting to the kit", () => {
		const offenders: string[] = [];
		for (const { files } of parsedProviders()) {
			for (const parsed of files) {
				for (const declaration of classesOf(parsed.source)) {
					for (const member of declaration.members) {
						const name = member.name?.getText();
						if (name !== undefined && KIT_NOTIFICATIONS.has(name))
							offenders.push(`${where(parsed, member)} ${name}`);
					}
				}
			}
		}

		expect(offenders, "handlersFor stages, settles, probes and forgets through the store").toEqual([]);
	});

	it("reads no module text off disk outside the kit", () => {
		const offenders: string[] = [];
		const reading = new Set<string>();
		for (const { files } of parsedProviders()) {
			for (const parsed of files) {
				const file = relative(PROVIDERS, parsed.file);
				for (const call of callsIn(parsed.source)) {
					const callee = calleeOf(call);
					if (callee === undefined || !CONTENT_READS.has(callee.name)) continue;
					if (callee.name === "file" && callee.receiver !== "Bun") continue;
					if (Object.hasOwn(ALLOWED_READS, file)) reading.add(file);
					else offenders.push(`${where(parsed, call)} ${callee.name}`);
				}
			}
		}

		expect(offenders, "read module text through the store; list a config or asset read in ALLOWED_READS").toEqual(
			[],
		);
		expect(Object.keys(ALLOWED_READS).filter((file) => !reading.has(file))).toEqual([]);
	});

	it("keeps no other state beside the store", () => {
		const offenders: string[] = [];
		for (const { files } of parsedProviders()) {
			for (const parsed of files) {
				for (const declaration of classesOf(parsed.source)) {
					const fields = fieldsOf(declaration);
					if (!fields.some((field) => field.name === "store")) continue;
					for (const field of fields) {
						if (field.name === "store") continue;
						const readonly = hasModifier(field.node, ts.SyntaxKind.ReadonlyKeyword);
						if (!readonly || isCollection(field.init))
							offenders.push(`${where(parsed, field.node)} ${field.name}`);
					}
				}
				for (const statement of parsed.source.statements) {
					if (!ts.isVariableStatement(statement)) continue;
					const list = statement.declarationList;
					if ((list.flags & ts.NodeFlags.Const) === 0) {
						offenders.push(`${where(parsed, statement)} module-level let`);
						continue;
					}
					for (const variable of list.declarations) {
						if (!ts.isIdentifier(variable.name) || !isCollection(variable.initializer)) continue;
						const name = variable.name.text;
						const mutated = callsIn(parsed.source).some((call) => {
							const callee = calleeOf(call);
							return callee?.receiver === name && MUTATORS.has(callee.name);
						});
						if (mutated) offenders.push(`${where(parsed, variable)} ${name}`);
					}
				}
			}
		}

		expect(offenders, "hold module state in the store, and project state in its project value").toEqual([]);
	});
});
