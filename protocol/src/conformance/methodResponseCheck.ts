import type { ProbeBatchResponse } from "../methods.js";
import type { ImportResolution } from "../project.js";
import type { TypeInfo } from "../values.js";
import type { ProbeBatchFixture } from "./types.js";

/** Compares one import specifier's resolution against a case, landing kind and scope included. */
export function checkImport(
	expected: {
		specifier: string;
		status?: string | undefined;
		module?: string | undefined;
		landing?: string | undefined;
		scopeId?: string | undefined;
	},
	actual: ImportResolution,
): string[] {
	const problems: string[] = [];
	const at = `import ${expected.specifier}`;

	if (expected.status !== undefined && actual.status !== expected.status) {
		problems.push(`${at}: resolved as ${actual.status}, expected ${expected.status}`);
		return problems;
	}
	const kind = expected.landing ?? (expected.module === undefined ? undefined : "module");
	if (kind === undefined && expected.scopeId === undefined) return problems;
	if (actual.status !== "resolved") {
		problems.push(`${at}: resolved as ${actual.status}, expected a landing`);
		return problems;
	}
	const landing = actual.landing;
	if (kind !== undefined && landing.kind !== kind) {
		problems.push(`${at}: landed in a ${landing.kind}, expected a ${kind}`);
	} else if (landing.kind === "module") {
		if (expected.module !== undefined && landing.module !== expected.module) {
			problems.push(`${at}: resolved to ${landing.module}, expected ${expected.module}`);
		}
	} else if (expected.scopeId !== undefined && landing.scopeId !== expected.scopeId) {
		problems.push(`${at}: landed in scope ${landing.scopeId}, expected ${expected.scopeId}`);
	}
	return problems;
}

/**
 * A ready batch probe against its fixture: one facts per asked module at its proposed or disk text's
 * hash, one landing per distinct module and specifier, and the proposed texts read as one view.
 */
export function checkProbeBatch(
	fixture: ProbeBatchFixture,
	answer: Extract<ProbeBatchResponse, { status: "ready" }>,
	hashOf: (text: string) => string,
): string[] {
	const problems: string[] = [];
	for (const module of fixture.answer) {
		const answered = answer.facts.filter((facts) => facts.module === module);
		const text = fixture.probe[module] ?? fixture.files[module] ?? "";
		if (answered.length !== 1) problems.push(`${module}: ${answered.length} facts answered, expected one`);
		else if (answered[0]?.contentHash !== hashOf(text)) problems.push(`${module}: facts for another text`);
	}
	for (const facts of answer.facts) {
		if (!fixture.answer.includes(facts.module)) problems.push(`${facts.module}: answered, not asked`);
	}

	const key = (module: string, specifier: string) => JSON.stringify([module, specifier]);
	const wanted = new Set(
		answer.facts.flatMap((facts) => facts.imports.map((statement) => key(facts.module, statement.specifier))),
	);
	const landed = answer.landings.map((landing) => key(landing.module, landing.specifier));
	if (new Set(landed).size !== landed.length) problems.push("a landing is answered twice");
	for (const each of wanted) if (!landed.includes(each)) problems.push(`no landing for ${each}`);
	for (const each of landed) if (!wanted.has(each)) problems.push(`landing ${each} answers no import`);

	for (const seen of fixture.sees) {
		const facts = answer.facts.find((one) => one.module === seen.module);
		if (!facts?.declarations.some((declaration) => declaration.name === seen.declaration)) {
			problems.push(`${seen.module}: ${seen.declaration} was not read from the proposed text`);
		}
	}
	for (const use of fixture.bound ?? []) {
		const facts = answer.facts.find((one) => one.module === use.module);
		const named = facts?.references.filter((reference) => reference.name === use.name) ?? [];
		if (named.length === 0 || named.some((reference) => reference.binding.status !== "bound")) {
			problems.push(`${use.module}: ${use.name} does not bind across the proposed texts`);
		}
	}
	return problems;
}

/** Compares a type answer against a case, including an expected honest Unknown. */
export function checkType(
	expected: {
		name: string;
		display?: string | undefined;
		mentions?: string[] | undefined;
		status?: string | undefined;
		reason?: string | undefined;
	},
	actual: TypeInfo,
): string[] {
	const problems: string[] = [];
	const at = `type of ${expected.name}`;
	const wanted = expected.status ?? (expected.reason !== undefined ? "unknown" : undefined);

	if (wanted !== undefined && actual.status !== wanted) {
		return [`${at}: status is ${actual.status}, expected ${wanted}`];
	}
	if (expected.reason !== undefined) {
		if (actual.status !== "unknown") return problems;
		if (actual.reason !== expected.reason) {
			problems.push(`${at}: unknown for ${actual.reason}, expected ${expected.reason}`);
		}
		return problems;
	}
	if (expected.display !== undefined) {
		if (actual.status === "unknown") {
			problems.push(`${at}: unknown (${actual.reason}), expected ${expected.display}`);
		} else if (actual.display !== expected.display) {
			problems.push(`${at}: ${actual.display}, expected ${expected.display}`);
		}
	}

	// Each member separately, so the failure names the one that was dropped rather than printing
	// two long union strings and leaving a reader to diff them.
	for (const member of expected.mentions ?? []) {
		if (actual.status === "unknown") {
			problems.push(`${at}: unknown (${actual.reason}), expected a type mentioning ${member}`);
		} else if (!actual.display.includes(member)) {
			problems.push(`${at}: ${actual.display} does not mention ${member}`);
		}
	}
	return problems;
}
