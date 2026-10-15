import { CASE_METADATA, type ConformanceFixture, hashOf } from "./caseSupport.js";
import type { ProviderSession } from "./providerSession.js";
import type { ConformanceCase } from "./types.js";

type FactChecks = {
	checkFacts: typeof import("./check.js").checkFacts;
	checkImport: typeof import("./check.js").checkImport;
	checkType: typeof import("./check.js").checkType;
};

////////////////////////////////
//  Running

/** A fixture's discovery expectations against the files the provider listed. */
function discoveryProblems(fixture: ConformanceFixture, files: string[]): string[] {
	const problems: string[] = [];
	for (const [file, expected] of Object.entries(fixture.discovery ?? {})) {
		const listed = files.includes(file);
		if (listed !== expected) {
			problems.push(
				expected ? `discovery did not list ${file}` : `discovery listed ${file}, which is not claimed`,
			);
		}
	}
	return problems;
}

async function runCase(
	session: ProviderSession,
	testCase: ConformanceCase,
	fixture: ConformanceFixture,
	language: string,
	checks: FactChecks,
	declaredRoles?: readonly string[],
	/** Required by `fileRoles` for code parses. */
	owesRole = false,
): Promise<string[]> {
	const problems: string[] = [];
	const { checkFacts, checkImport, checkType } = checks;
	const text = fixture.files[fixture.subject];
	if (text === undefined) return [`subject ${fixture.subject} is not among the fixture's files`];

	// Derived by EXCLUSION, so the failure direction is a wasted parse rather than a silent pass.
	// Naming the expectations that need facts meant forgetting one made its cases run while
	// asserting nothing, which has happened here to six cases at once. Naming the fields that are
	// NOT expectations inverts it: a field nobody classifies simply costs one more parse.
	const stated = Object.keys({ ...testCase, ...fixture }).filter((key) => !CASE_METADATA.has(key));

	const expectedType = fixture.typeOf ?? testCase.typeOf;
	// One parse per case, since several checks want the same facts and a provider is free to answer
	// a second identical request differently once its own state has moved on.
	const parses = stated.length > 0;
	const facts = parses
		? await session.call("parseFile", { module: fixture.subject, contentHash: hashOf(text), text })
		: null;

	if (facts) {
		problems.push(...checkFacts(testCase, facts, language, text));
		if (owesRole && facts.role === undefined) problems.push("role: fileRoles is declared, but this parse has none");
		// A declared role list is a promise about coverage, so emitting outside it is the same
		// over-claim as declaring a tier that is not built. Undeclared coverage stays unchecked.
		if (declaredRoles !== undefined) {
			for (const role of new Set(facts.references.map((reference) => reference.role))) {
				if (!declaredRoles.includes(role)) {
					problems.push(`reference role ${role} is emitted but not declared at initialize`);
				}
			}
		}
	}

	if (facts && testCase.parseErrors) {
		const errors = facts.diagnostics.filter((diagnostic) => diagnostic.severity === "error");

		if (testCase.parseErrors === "required" && errors.length === 0) {
			problems.push("syntaxDiagnostics is declared but unparseable text produced no error diagnostic");
		}
		if (testCase.parseErrors === "forbidden" && errors.length > 0) {
			problems.push(`valid text produced ${errors.length} error diagnostic(s): ${errors[0]?.message}`);
		}
	}

	if (facts && testCase.notes) {
		const notes = facts.diagnostics.filter((diagnostic) => diagnostic.severity !== "error");
		if (testCase.notes === "required" && notes.length === 0) {
			problems.push("text worth a note produced no warning or info diagnostic");
		}
		if (testCase.notes === "forbidden" && notes.length > 0) {
			problems.push(`text produced ${notes.length} note(s) where none was expected: ${notes[0]?.message}`);
		}
	}

	// The fixture's own list wins when it has one, since a specifier is this language's syntax.
	for (const expected of fixture.imports ?? testCase.imports ?? []) {
		const resolution = await session.call("resolveImport", {
			fromModule: fixture.subject,
			specifier: expected.specifier,
		});
		problems.push(...checkImport(expected, resolution));
	}

	if (facts && expectedType) {
		const target = facts.declarations.find((d) => d.name === expectedType.name);
		if (!target) {
			problems.push(`type of ${expectedType.name}: the declaration was not reported`);
		} else {
			problems.push(...checkType(expectedType, await session.call("typeOf", { symbolId: target.symbolId })));
		}
	}

	return problems;
}

export { discoveryProblems, runCase };
