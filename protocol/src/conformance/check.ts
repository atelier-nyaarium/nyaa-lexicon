// Comparing a provider's answers against a case's expectations.
//
// Pure, so the hard part of the suite is testable without spawning a process. The runner owns the
// transport and calls in here.

import type { z } from "zod";
import { coordinatesOf } from "../coordinates.js";
import type { CommentSpan, DocRegion, FileFacts, ImportResolution } from "../project.js";
import { parseSymbolId } from "../symbolId.js";
import type { Declaration, Reference } from "../symbols.js";
import type { TypeInfo } from "../values.js";
import type { ConformanceCase, ExpectedDeclarationSchema, ExpectedReferenceSchema } from "./types.js";

////////////////////////////////
//  Interfaces & Types

type ExpectedDeclaration = z.infer<typeof ExpectedDeclarationSchema>;
type ExpectedReference = z.infer<typeof ExpectedReferenceSchema>;

////////////////////////////////
//  Functions & Helpers

/** `kind:name` per descriptor, the form a case states so it never pins the wire string. */
export function describeIdParts(symbolId: string): string[] | null {
	const parsed = parseSymbolId(symbolId);
	if (!parsed) return null;
	if (parsed.local !== undefined) return [`local:${parsed.local}`];
	return parsed.descriptors.map((d) => `${d.kind}:${d.name}`);
}

function checkDeclaration(
	expected: ExpectedDeclaration,
	actual: Declaration,
	byId: Map<string, Declaration>,
): string[] {
	const problems: string[] = [];
	const at = `declaration ${expected.name}`;

	if (expected.kind !== undefined && actual.kind !== expected.kind) {
		problems.push(`${at}: kind is ${actual.kind}, expected ${expected.kind}`);
	}
	if (expected.visibility !== undefined && actual.visibility !== expected.visibility) {
		problems.push(`${at}: visibility is ${actual.visibility}, expected ${expected.visibility}`);
	}
	if (expected.exported !== undefined && actual.exported !== expected.exported) {
		problems.push(`${at}: exported is ${actual.exported}, expected ${expected.exported}`);
	}
	if (expected.container !== undefined) {
		const container = actual.containerId === undefined ? undefined : byId.get(actual.containerId)?.name;
		if (container !== expected.container) {
			problems.push(`${at}: container is ${container ?? "none"}, expected ${expected.container}`);
		}
	}
	if (expected.nameStart !== undefined) {
		const start = actual.selectionRange.start;
		if (start.line !== expected.nameStart.line || start.character !== expected.nameStart.character) {
			problems.push(
				`${at}: name starts at ${start.line}:${start.character}, expected ${expected.nameStart.line}:${expected.nameStart.character}. ` +
					"A character column off by the width of one astral character means this provider is not counting UTF-16 code units.",
			);
		}
	}
	if (expected.descriptors !== undefined) {
		const parts = describeIdParts(actual.symbolId);
		if (parts === null) {
			problems.push(`${at}: symbolId does not parse: ${actual.symbolId}`);
		} else if (parts.join(" ") !== expected.descriptors.join(" ")) {
			problems.push(
				`${at}: descriptors are [${parts.join(", ")}], expected [${expected.descriptors.join(", ")}]`,
			);
		}
	}
	return problems;
}

function checkReference(expected: ExpectedReference, actual: Reference, byId: Map<string, Declaration>): string[] {
	const problems: string[] = [];
	const at = `reference ${expected.name}`;

	if (expected.role !== undefined && actual.role !== expected.role) {
		problems.push(`${at}: role is ${actual.role}, expected ${expected.role}`);
	}

	const wanted =
		expected.status ??
		(expected.bindsTo !== undefined ? "bound" : expected.reason !== undefined ? "unbound" : undefined);
	if (wanted !== undefined && actual.binding.status !== wanted) {
		problems.push(`${at}: binding is ${actual.binding.status}, expected ${wanted}`);
		return problems;
	}

	if (expected.reason !== undefined) {
		if (actual.binding.status !== "unbound") return problems;
		if (actual.binding.reason !== expected.reason) {
			problems.push(`${at}: unbound for ${actual.binding.reason}, expected ${expected.reason}`);
		}
	}

	if (expected.bindsTo !== undefined) {
		if (actual.binding.status !== "bound") return problems;
		const target = byId.get(actual.binding.symbolId)?.name;
		if (target !== expected.bindsTo) {
			problems.push(`${at}: binds to ${target ?? "an unknown symbol"}, expected ${expected.bindsTo}`);
		}
	}
	return problems;
}

////////////////////////////////
//  Case checking

/** Compares one file's facts against a case. Missing expectations are failures, extras are not. */
export function checkFacts(testCase: ConformanceCase, facts: FileFacts, language?: string, source?: string): string[] {
	const problems: string[] = [];
	const byId = new Map(facts.declarations.map((d) => [d.symbolId, d]));

	// A fixture's own declarations REPLACE the case's, matching how imports and typeOf already work.
	const fixture = language === undefined ? undefined : testCase.fixtures[language];
	for (const expected of fixture?.declarations ?? testCase.declarations ?? []) {
		// Matched by name: a case must not know the id, since the id is what varies by provider.
		const matches = facts.declarations.filter((d) => d.name === expected.name);
		if (matches.length === 0) {
			problems.push(`declaration ${expected.name}: not reported`);
			continue;
		}
		// Several same-named declarations pass if ANY satisfies the expectation, since a case
		// naming only a name cannot say which overload it meant.
		const perMatch = matches.map((m) => checkDeclaration(expected, m, byId));
		if (perMatch.every((p) => p.length > 0)) problems.push(...(perMatch[0] as string[]));
	}

	for (const expected of testCase.references ?? []) {
		const matches = facts.references.filter((r) => r.name === expected.name);
		if (matches.length === 0) {
			problems.push(`reference ${expected.name}: not reported`);
			continue;
		}
		const perMatch = matches.map((m) => checkReference(expected, m, byId));
		if (perMatch.every((p) => p.length > 0)) problems.push(...(perMatch[0] as string[]));
	}

	const wantedComments = fixture?.comments ?? testCase.comments;
	if (wantedComments !== undefined) problems.push(...checkComments(wantedComments, facts.comments ?? []));
	// Every span, not only expected ones: right text under a lying range attaches to the wrong symbol.
	if (source !== undefined) problems.push(...checkCommentRanges(source, facts.comments ?? []));

	const documented = fixture?.documentation ?? testCase.documentation;
	if (documented !== undefined) problems.push(...checkDocumentation(documented, facts));

	// The same rule comment spans get: a range that lies attaches prose to the wrong section.
	if (source !== undefined) problems.push(...checkDocRanges(source, facts.docs ?? []));

	return problems;
}

/**
 * A doc comment and its declaration must sit in one of the two shapes core can attach.
 *
 * Either the declaration's range already covers the comment, or the declaration begins on the line
 * after the comment ends. Any third arrangement is not a style difference: it is a language whose
 * documentation silently stops being found, with every suite still green.
 */
function checkDocumentation(expected: { declaration: string; comment: string }, facts: FileFacts): string[] {
	const declaration = facts.declarations.find((item) => item.name === expected.declaration);
	if (declaration === undefined) return [`documentation: declaration ${expected.declaration} is not reported`];

	const comment = (facts.comments ?? []).find((item) => item.text === expected.comment);
	if (comment === undefined) {
		return [`documentation: comment ${JSON.stringify(expected.comment)} is not reported`];
	}

	const covers =
		declaration.range.start.line === comment.range.start.line &&
		declaration.range.start.character === comment.range.start.character;
	const follows = declaration.range.start.line === comment.range.end.line + 1;
	if (covers || follows) return [];

	return [
		`documentation: ${expected.declaration} starts at ${declaration.range.start.line}:${declaration.range.start.character}, ` +
			`which neither covers its doc comment (starting ${comment.range.start.line}:${comment.range.start.character}) ` +
			`nor follows it (ending line ${comment.range.end.line}). Core attaches documentation by those two shapes only.`,
	];
}

/** A span's range must cut its own text back out of the source, or core's position math is fiction. */
/** A doc region's range must slice its own text back, fence delimiters excluded. */
function checkDocRanges(source: string, actual: DocRegion[]): string[] {
	const problems: string[] = [];
	const coordinates = coordinatesOf(source);

	for (const region of actual) {
		const cut = coordinates.sliceRange(region.range);
		if (cut === undefined) {
			problems.push(`doc region ${JSON.stringify(region.text)}: range is outside the file`);
			continue;
		}
		if (cut !== region.text) {
			problems.push(`doc region ${JSON.stringify(region.text)}: range covers ${JSON.stringify(cut)} instead`);
		}
	}
	return problems;
}

function checkCommentRanges(source: string, actual: CommentSpan[]): string[] {
	const problems: string[] = [];
	const coordinates = coordinatesOf(source);

	for (const comment of actual) {
		const cut = coordinates.sliceRange(comment.range);
		if (cut === undefined) {
			problems.push(`comment ${JSON.stringify(comment.text)}: range is outside the file`);
			continue;
		}
		if (cut !== comment.text) {
			problems.push(`comment ${JSON.stringify(comment.text)}: range covers ${JSON.stringify(cut)} instead`);
		}
	}
	return problems;
}

/** Verbatim and multiset: text is compared as written, since a span reaching past its own marker
 * is exactly the bug this catches, and two identical comments are two facts. */
function checkComments(expected: string[], actual: CommentSpan[]): string[] {
	const problems: string[] = [];
	const remaining = actual.map((comment) => comment.text);

	for (const text of expected) {
		const at = remaining.indexOf(text);
		if (at === -1) problems.push(`comment ${JSON.stringify(text)}: not reported`);
		else remaining.splice(at, 1);
	}
	for (const text of remaining) {
		problems.push(`comment ${JSON.stringify(text)}: reported but not a comment here`);
	}
	return problems;
}

/** Compares one import specifier's resolution against a case. */
export function checkImport(
	expected: { specifier: string; status?: string | undefined; module?: string | undefined },
	actual: ImportResolution,
): string[] {
	const problems: string[] = [];
	const at = `import ${expected.specifier}`;

	if (expected.status !== undefined && actual.status !== expected.status) {
		problems.push(`${at}: resolved as ${actual.status}, expected ${expected.status}`);
		return problems;
	}
	if (expected.module !== undefined) {
		if (actual.status !== "resolved") {
			problems.push(`${at}: resolved as ${actual.status}, expected a module`);
		} else if (actual.module !== expected.module) {
			problems.push(`${at}: resolved to ${actual.module}, expected ${expected.module}`);
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
