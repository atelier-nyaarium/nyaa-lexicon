// Comparing a provider's answers against a case's expectations.
//
// Pure, so the hard part of the suite is testable without spawning a process. The runner owns the
// transport and calls in here.

import type { z } from "zod";
import { comparePositions, coordinatesOf } from "../coordinates.js";
import type { ProbeBatchResponse } from "../methods.js";
import type {
	CommentSpan,
	DocRegion,
	ExportTarget,
	FileFacts,
	FileRole,
	ImportEdge,
	ImportResolution,
	Literal,
} from "../project.js";
import { parseSymbolId } from "../symbolId.js";
import type { Declaration, Range, Reference } from "../symbols.js";
import type { TypeInfo } from "../values.js";
import type {
	ConformanceCase,
	ExpectedDeclarationSchema,
	ExpectedDocRegionSchema,
	ExpectedExport,
	ExpectedLiteral,
	ExpectedReferenceSchema,
	ExpectedRole,
	ExpectedTrivia,
	ProbeBatchFixture,
} from "./types.js";

////////////////////////////////
//  Interfaces & Types

type ExpectedDeclaration = z.infer<typeof ExpectedDeclarationSchema>;
type ExpectedReference = z.infer<typeof ExpectedReferenceSchema>;
type ExpectedDocRegion = z.infer<typeof ExpectedDocRegionSchema>;

////////////////////////////////
//  Functions & Helpers

/**
 * `kind:name` per descriptor, the form a case states so it never pins the wire string.
 *
 * A disambiguator is appended in parens when one is present, because it is the ONLY thing telling
 * two same-named siblings apart. Dropping it would leave the grammar's whole reason for existing
 * unassertable, with both ids reading identically to a case.
 */
export function describeIdParts(symbolId: string): string[] | null {
	const parsed = parseSymbolId(symbolId);
	if (!parsed) return null;
	if (parsed.local !== undefined) return [`local:${parsed.local}`];
	return parsed.descriptors.map(
		(d) => `${d.kind}:${d.name}${d.disambiguator === undefined ? "" : `(${d.disambiguator})`}`,
	);
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
		const start = actual.selectionRange?.start;
		if (start === undefined) {
			problems.push(
				`${at}: has no name span, but the case expects the name at ${expected.nameStart.line}:${expected.nameStart.character}`,
			);
		} else if (start.line !== expected.nameStart.line || start.character !== expected.nameStart.character) {
			problems.push(
				`${at}: name starts at ${start.line}:${start.character}, expected ${expected.nameStart.line}:${expected.nameStart.character}. ` +
					"A character column off by the width of one astral character means this provider is not counting UTF-16 code units.",
			);
		}
	}
	if (
		expected.memberInsertLine !== undefined &&
		actual.memberInsertLine !== (expected.memberInsertLine ?? undefined)
	) {
		problems.push(
			`${at}: memberInsertLine is ${actual.memberInsertLine ?? "absent"}, expected ${expected.memberInsertLine ?? "absent"}`,
		);
	}
	if (expected.signature !== undefined && actual.signature !== expected.signature) {
		problems.push(
			`${at}: signature is ${JSON.stringify(actual.signature ?? null)}, expected ${JSON.stringify(expected.signature)}`,
		);
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

function checkReference(
	expected: ExpectedReference,
	actual: Reference,
	byId: Map<string, Declaration>,
	facts: FileFacts,
): string[] {
	const problems: string[] = [];
	const at = referenceLabel(expected);

	if (expected.from !== undefined) {
		const owner = actual.fromId === undefined ? null : (byId.get(actual.fromId)?.name ?? actual.fromId);
		if (owner !== expected.from)
			problems.push(`${at}: written in ${owner ?? "no declaration"}, expected ${expected.from}`);
	}

	problems.push(...checkOrigin(expected, actual, facts));

	const wanted =
		expected.status ??
		(expected.bindsTo !== undefined || expected.bindsToModule !== undefined
			? "bound"
			: expected.reason !== undefined
				? "unbound"
				: undefined);
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

	if (actual.binding.status !== "bound") return problems;
	const parsed = parseSymbolId(actual.binding.symbolId);
	const elsewhere = parsed !== null && parsed.module !== facts.module;
	if (expected.bindsToModule !== undefined && parsed?.module !== expected.bindsToModule) {
		problems.push(`${at}: binds in ${parsed?.module ?? "an unknown module"}, expected ${expected.bindsToModule}`);
	}
	if (expected.bindsTo !== undefined) {
		// Cross-file id trusted by name only when the case names the file.
		const target =
			elsewhere && expected.bindsToModule !== undefined
				? parsed.descriptors.at(-1)?.name
				: byId.get(actual.binding.symbolId)?.name;
		if (target !== expected.bindsTo) {
			problems.push(`${at}: binds to ${target ?? "an unknown symbol"}, expected ${expected.bindsTo}`);
		}
	}
	return problems;
}

/** At the stated occurrence, or anywhere. */
function placed(expected: ExpectedReference, actual: Reference): boolean {
	const { at } = expected;
	if (at === undefined) return true;
	const start = actual.range.start;
	return start.line === at.line && (at.character === undefined || start.character === at.character);
}

/** A stated role selects its rows; import and export rows answer only their own. */
function selected(expected: ExpectedReference, actual: Reference): boolean {
	if (expected.role !== undefined) return actual.role === expected.role;
	return actual.role !== "import" && actual.role !== "export";
}

function referenceLabel(expected: ExpectedReference): string {
	const { at } = expected;
	if (at === undefined) return `reference ${expected.name}`;
	return `reference ${expected.name} at ${at.line}${at.character === undefined ? "" : `:${at.character}`}`;
}

/** What a case could state to split two rows. */
function narrowing(expected: ExpectedReference, left: Reference, right: Reference): string {
	if (comparePositions(left.range.start, right.range.start) !== 0) {
		if (expected.at === undefined) return "; state `at`";
		if (expected.at.character === undefined) return "; state `at` with a character";
	}
	return left.role !== right.role && expected.role === undefined ? "; state `role`" : "";
}

/** Never emission order: range, then role, then first problem. */
function checkedInSourceOrder<Row extends { range: Range; role?: string }>(
	rows: Row[],
	check: (row: Row) => string[],
): Array<{ row: Row; problems: string[] }> {
	const byText = (left = "", right = ""): number => (left < right ? -1 : left > right ? 1 : 0);
	return rows
		.map((row) => ({ row, problems: check(row) }))
		.sort(
			(left, right) =>
				comparePositions(left.row.range.start, right.row.range.start) ||
				comparePositions(left.row.range.end, right.row.range.end) ||
				byText(left.row.role, right.row.role) ||
				byText(left.problems[0], right.problems[0]),
		);
}

function sameRange(left: Range, right: Range): boolean {
	return comparePositions(left.start, right.start) === 0 && comparePositions(left.end, right.end) === 0;
}

/** The import edges written at exactly this span. */
function edgesAt(facts: FileFacts, span: Range): ImportEdge[] {
	return facts.imports.flatMap((statement) => statement.edges).filter((edge) => sameRange(edge.span, span));
}

/** How a case names an edge: its local binding, else its source name, else `*`. */
function bindingOf(edge: ImportEdge): string {
	return edge.local ?? edge.name ?? "*";
}

function targetNameOf(target: ExportTarget, facts: FileFacts, byId: Map<string, Declaration>): string | undefined {
	if (target.kind === "symbol") return byId.get(target.symbolId)?.name;
	if (target.kind === "import") return edgesAt(facts, target.span).map(bindingOf)[0];
	return undefined;
}

/** EXACTLY these export edges, any order. */
function checkExports(expected: readonly ExpectedExport[], facts: FileFacts, byId: Map<string, Declaration>): string[] {
	if (facts.exports === undefined) return ["exports: not reported"];
	const left = facts.exports.map((edge) => ({
		edge,
		targetName: targetNameOf(edge.target, facts, byId),
		sourceName: edge.target.kind === "import" ? edgesAt(facts, edge.target.span)[0]?.name : undefined,
	}));
	const problems: string[] = [];
	for (const wanted of expected) {
		const at = left.findIndex(
			({ edge, targetName, sourceName }) =>
				edge.form === wanted.form &&
				edge.name === wanted.name &&
				edge.target.kind === wanted.target &&
				(wanted.targetName === undefined || targetName === wanted.targetName) &&
				(wanted.sourceName === undefined || sourceName === wanted.sourceName),
		);
		if (at === -1) problems.push(`export ${wanted.form} ${wanted.name ?? "*"}: not reported as expected`);
		else left.splice(at, 1);
	}
	for (const { edge } of left) problems.push(`export ${edge.form} ${edge.name ?? "*"}: reported, not expected`);
	return problems;
}

/** An import target or origin names exactly one edge, or core cannot follow it. */
function checkEdgeLinks(facts: FileFacts): string[] {
	const problems: string[] = [];
	for (const edge of facts.exports ?? []) {
		const count = edge.target.kind === "import" ? edgesAt(facts, edge.target.span).length : 1;
		if (count !== 1) problems.push(`export ${edge.name ?? "*"}: its import target matches ${count} edges`);
	}
	for (const reference of facts.references) {
		const count = reference.origin?.kind === "import" ? edgesAt(facts, reference.origin.span).length : 1;
		if (count !== 1) problems.push(`reference ${reference.name}: its origin matches ${count} edges`);
	}
	return problems;
}

function checkOrigin(expected: ExpectedReference, actual: Reference, facts: FileFacts): string[] {
	const wanted = expected.origin;
	const origin = actual.origin;
	const at = referenceLabel(expected);
	if (wanted === undefined) return [];
	if (origin === undefined) return [`${at}: no origin, expected one`];
	if (wanted === "declaration") {
		return origin.kind === "declaration" ? [] : [`${at}: resolves through an import, expected its declaration`];
	}
	if (origin.kind !== "import") return [`${at}: resolves to its declaration, expected through ${wanted.through}`];
	const through = edgesAt(facts, origin.span).map(bindingOf);
	const problems = through.includes(wanted.through)
		? []
		: [`${at}: resolves through ${through.join(", ") || "no edge"}, expected ${wanted.through}`];
	const path = (origin.path ?? []).join(".");
	const wantedPath = (wanted.path ?? []).join(".");
	if (path !== wantedPath) problems.push(`${at}: reached through .${path}, expected .${wantedPath}`);
	return problems;
}

////////////////////////////////
//  Case checking

/** Compares one file's facts against a case. Missing expectations are failures, extras are not. */
export function checkFacts(testCase: ConformanceCase, facts: FileFacts, language?: string, source?: string): string[] {
	const problems: string[] = [];
	const byId = new Map(facts.declarations.map((d) => [d.symbolId, d]));

	// Universal: an id minted twice is a declaration the store would silently drop.
	const minted = new Set<string>();
	for (const declaration of facts.declarations) {
		if (minted.has(declaration.symbolId)) {
			problems.push(`declaration ${declaration.name}: id ${declaration.symbolId} is minted twice in one file`);
		}
		minted.add(declaration.symbolId);
		// Universal: a signature is one line. A literal may hold a double space.
		const signature = declaration.signature;
		if (signature !== undefined && (signature !== signature.trim() || /[^\S ]/.test(signature))) {
			problems.push(`declaration ${declaration.name}: signature ${JSON.stringify(signature)} is not one line`);
		}
	}

	problems.push(...checkEdgeLinks(facts));

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
		const checked = checkedInSourceOrder(matches, (match) => checkDeclaration(expected, match, byId));
		if (checked.every((entry) => entry.problems.length > 0)) problems.push(...(checked[0]?.problems ?? []));
	}

	const wantedNames = fixture?.declarationNames ?? testCase.declarationNames;
	if (wantedNames !== undefined) {
		const reported = facts.declarations.map((d) => d.name);
		// Element-wise: no separator exists that a name cannot itself contain, NUL included.
		const same =
			reported.length === wantedNames.length && wantedNames.every((name, index) => name === reported[index]);
		if (!same) {
			problems.push(`declarations: expected exactly [${wantedNames.join(", ")}], got [${reported.join(", ")}]`);
		}
	}

	for (const expected of testCase.references ?? []) {
		const label = referenceLabel(expected);
		const named = facts.references.filter((r) => r.name === expected.name && placed(expected, r));
		const checked = checkedInSourceOrder(
			named.filter((r) => selected(expected, r)),
			(match) => checkReference(expected, match, byId, facts),
		);
		if (checked.length === 0) {
			const roles = [...new Set(named.map((r) => r.role))].sort();
			problems.push(
				`${label}: not reported${roles.length === 0 ? "" : ` as ${expected.role ?? "a use"}, only as ${roles.join(", ")}`}`,
			);
			continue;
		}
		const passing = checked.find((entry) => entry.problems.length === 0);
		const failing = checked.find((entry) => entry.problems.length > 0);
		if (passing === undefined) problems.push(...(failing?.problems ?? []));
		else if (failing !== undefined) {
			// Disagreeing rows fail.
			const where = ({ row }: { row: Reference }) =>
				`${row.role} at ${row.range.start.line}:${row.range.start.character}`;
			problems.push(
				`${label}: rows disagree, ${where(passing)} passes and ${where(failing)} fails (${failing.problems[0]})${narrowing(expected, passing.row, failing.row)}`,
			);
		}
	}

	const wantedExports = fixture?.exports ?? testCase.exports;
	if (wantedExports !== undefined) problems.push(...checkExports(wantedExports, facts, byId));

	const wantedComments = fixture?.comments ?? testCase.comments;
	if (wantedComments !== undefined) problems.push(...checkComments(wantedComments, facts.comments ?? []));
	// Every span, not only expected ones: right text under a lying range attaches to the wrong symbol.
	if (source !== undefined) problems.push(...checkCommentRanges(source, facts.comments ?? []));
	if (source !== undefined) problems.push(...checkTriviaAgainstSource(source, facts.comments ?? []));
	const wantedTrivia = fixture?.commentTrivia ?? testCase.commentTrivia;
	if (wantedTrivia !== undefined) problems.push(...checkTrivia(wantedTrivia, facts.comments ?? []));

	const wantedBlank = fixture?.blankLines ?? testCase.blankLines;
	if (wantedBlank !== undefined) problems.push(...checkBlankLines(wantedBlank, facts.blankLines));
	if (source !== undefined && facts.blankLines !== undefined) {
		problems.push(...checkBlankLinesAgainstSource(source, facts.blankLines));
	}

	const wantedLiterals = fixture?.literals ?? testCase.literals;
	if (wantedLiterals !== undefined) problems.push(...checkLiterals(wantedLiterals, facts.literals ?? []));
	// Every literal, not only expected ones: a span outside the file corrupts any rewrite through it.
	if (source !== undefined) problems.push(...checkLiteralRanges(source, facts.literals ?? []));

	const documented = fixture?.documentation ?? testCase.documentation;
	if (documented !== undefined) problems.push(...checkDocumentation(documented, facts));

	const wantedDocs = fixture?.docs ?? testCase.docs;
	if (wantedDocs !== undefined) problems.push(...checkDocs(wantedDocs, facts.docs ?? [], byId));
	// The same rule comment spans get: a range that lies attaches prose to the wrong section.
	if (source !== undefined) problems.push(...checkDocRanges(source, facts.docs ?? [], byId));

	const wantedRole = fixture?.role ?? testCase.role;
	if (wantedRole !== undefined) problems.push(...checkRole(wantedRole, facts.role, byId));

	return problems;
}

function checkRole(expected: ExpectedRole, actual: FileRole | undefined, byId: Map<string, Declaration>): string[] {
	if (actual === undefined) return [`role: expected ${expected.kind}, got none`];
	if (actual.kind !== expected.kind) return [`role: expected ${expected.kind}, got ${actual.kind}`];
	if (expected.kind === "unknown" && actual.kind === "unknown") {
		return expected.reason === undefined || expected.reason === actual.reason
			? []
			: [`role: expected reason ${expected.reason}, got ${actual.reason}`];
	}
	if (expected.kind !== "entry" || actual.kind !== "entry") return [];
	const problems: string[] = [];
	if (actual.how !== expected.how) problems.push(`role: expected how ${expected.how}, got ${actual.how}`);
	const main = actual.how === "main" ? byId.get(actual.symbolId) : undefined;
	if (actual.how === "main" && main === undefined) {
		problems.push(`role: symbolId ${actual.symbolId} names no declaration in the file`);
	}
	if (expected.main !== undefined) {
		const { name, line } = expected.main;
		const at = main === undefined ? undefined : (main.selectionRange ?? main.range);
		// A same-named decoy on another line is not the entry.
		if (main?.name !== name || at === undefined || line < at.start.line || line > at.end.line) {
			const got = main === undefined || at === undefined ? "none" : `${main.name} on line ${at.start.line}`;
			problems.push(`role: expected main ${name} on line ${line}, got ${got}`);
		}
	}
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
/**
 * Exactly these regions, in document order.
 *
 * Order matters here where it does not for comments: prose, then a fence, then more prose is one
 * section, and a provider that merges or reorders them has changed what the section says.
 */
function checkDocs(expected: ExpectedDocRegion[], actual: DocRegion[], byId: Map<string, Declaration>): string[] {
	const problems: string[] = [];
	if (expected.length !== actual.length) {
		problems.push(`docs: expected ${expected.length} region(s), got ${actual.length}`);
	}

	for (const [index, want] of expected.entries()) {
		const got = actual[index];
		if (got === undefined) {
			problems.push(`docs[${index}]: expected ${JSON.stringify(want.text)}, got nothing`);
			continue;
		}
		if (got.text !== want.text) {
			problems.push(`docs[${index}]: expected ${JSON.stringify(want.text)}, got ${JSON.stringify(got.text)}`);
		}
		if (got.fenced !== (want.fenced ?? false)) {
			problems.push(`docs[${index}] ${JSON.stringify(want.text)}: fenced is ${got.fenced}`);
		}
		// By name, because a case must not know an id: that is what varies between providers.
		const under = got.anchorId === undefined ? undefined : byId.get(got.anchorId)?.name;
		if (want.under === undefined && under !== undefined) {
			problems.push(
				`docs[${index}] ${JSON.stringify(want.text)}: expected no heading, got ${JSON.stringify(under)}`,
			);
		}
		if (want.under !== undefined && under !== want.under) {
			problems.push(
				`docs[${index}] ${JSON.stringify(want.text)}: expected under ${JSON.stringify(want.under)}, got ${JSON.stringify(under)}`,
			);
		}
	}
	return problems;
}

/**
 * Every region slices its own text back, and the regions PARTITION the document.
 *
 * Disjoint and ascending is the property a store can rely on. Overlapping regions would index the
 * same bytes twice, so one search returns the same prose as two facts, and a reordered set is a
 * provider that has changed what the document says while every text matched.
 */
function checkDocRanges(source: string, actual: DocRegion[], byId: Map<string, Declaration>): string[] {
	const problems: string[] = [];
	const coordinates = coordinatesOf(source);
	let previous: DocRegion | undefined;

	for (const region of actual) {
		const at = `doc region ${JSON.stringify(region.text)}`;
		const cut = coordinates.sliceRange(region.range);
		if (cut === undefined) {
			problems.push(`${at}: range is outside the file`);
			continue;
		}
		if (cut !== region.text) problems.push(`${at}: range covers ${JSON.stringify(cut)} instead`);

		if (previous !== undefined && comparePositions(region.range.start, previous.range.end) < 0) {
			problems.push(
				`${at}: starts before ${JSON.stringify(previous.text)} ends, so the regions are not disjoint`,
			);
		}
		previous = region;

		// An anchor naming nothing here reads downstream as module-level prose, which is a different
		// claim from the one the provider made.
		if (region.anchorId !== undefined) {
			const heading = byId.get(region.anchorId);
			if (heading === undefined) problems.push(`${at}: anchorId names no declaration in this file`);
			else if (heading.kind !== "heading")
				problems.push(`${at}: anchorId names a ${heading.kind}, not a heading`);
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

/** Trivia as core reads it: an absent field is true. */
function triviaOf(comment: CommentSpan): { codeBefore: boolean; codeAfter: boolean } {
	return { codeBefore: comment.codeBefore ?? true, codeAfter: comment.codeAfter ?? true };
}

/** Expectations pair with reported comments in source order, so a repeated text checks each copy. */
function checkTrivia(expected: ExpectedTrivia[], actual: CommentSpan[]): string[] {
	const problems: string[] = [];
	const ordered = [...actual].sort(
		(a, b) => a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character,
	);
	const taken = new Set<CommentSpan>();
	for (const want of expected) {
		const found = ordered.find((comment) => comment.text === want.comment && !taken.has(comment));
		if (found !== undefined) taken.add(found);
		if (found === undefined) {
			problems.push(`comment ${JSON.stringify(want.comment)}: not reported, so its trivia cannot be checked`);
			continue;
		}
		const got = triviaOf(found);
		if (got.codeBefore !== want.codeBefore || got.codeAfter !== want.codeAfter) {
			problems.push(
				`comment ${JSON.stringify(want.comment)}: codeBefore ${got.codeBefore} and codeAfter ${got.codeAfter}, expected ${want.codeBefore} and ${want.codeAfter}`,
			);
		}
	}
	return problems;
}

/**
 * Whitespace-only text beside a comment proves there is no code on that side. Text may be another
 * comment, so the reverse does not hold.
 */
function checkTriviaAgainstSource(source: string, actual: CommentSpan[]): string[] {
	const problems: string[] = [];
	const coordinates = coordinatesOf(source);
	for (const comment of actual) {
		const first = coordinates.lineText(comment.range.start.line);
		const last = coordinates.lineText(comment.range.end.line);
		if (first === undefined || last === undefined) continue;
		const { codeBefore, codeAfter } = triviaOf(comment);
		if (codeBefore && first.slice(0, comment.range.start.character).trim() === "") {
			problems.push(
				`comment ${JSON.stringify(comment.text)}: only whitespace precedes it, but codeBefore is true`,
			);
		}
		if (codeAfter && last.slice(comment.range.end.character).trim() === "") {
			problems.push(`comment ${JSON.stringify(comment.text)}: only whitespace follows it, but codeAfter is true`);
		}
	}
	return problems;
}

/** Exact and ordered. */
function checkBlankLines(expected: number[], actual: number[] | undefined): string[] {
	if (actual === undefined) return [`blankLines: not reported, expected ${JSON.stringify(expected)}`];
	return JSON.stringify(actual) === JSON.stringify(expected)
		? []
		: [`blankLines: ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`];
}

/** A reported blank line holds only whitespace. A whitespace line inside a literal is not blank, so the converse is unchecked. */
function checkBlankLinesAgainstSource(source: string, actual: number[]): string[] {
	const coordinates = coordinatesOf(source);
	return actual.flatMap((line) => {
		const text = coordinates.lineText(line);
		if (text === undefined) return [`blankLines: line ${line} is outside the file`];
		return text.trim() === "" ? [] : [`blankLines: line ${line} holds ${JSON.stringify(text.trim())}`];
	});
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

/**
 * Decoded value and kind, as a multiset: two identical literals are two facts.
 *
 * Compared on the decoded value rather than the source spelling, so one expectation survives every
 * language's escaping. A number's value is its spelling as written, since `1e3` and `1000` are the
 * same number and not the same literal.
 */
function checkLiterals(expected: ExpectedLiteral[], actual: Literal[]): string[] {
	const problems: string[] = [];
	const show = (literal: { kind: string; value: string }) => `${literal.kind} ${JSON.stringify(literal.value)}`;
	const remaining = actual.map((literal) => ({ kind: literal.kind, value: literal.value }));

	for (const want of expected) {
		const at = remaining.findIndex((literal) => literal.kind === want.kind && literal.value === want.value);
		if (at === -1) problems.push(`literal ${show(want)}: not reported`);
		else remaining.splice(at, 1);
	}
	for (const literal of remaining) {
		problems.push(`literal ${show(literal)}: reported but not a literal here`);
	}
	return problems;
}

/**
 * Every reported literal's range must sit inside the file.
 *
 * Weaker than the comment rule on purpose: a literal's span covers its quotes and its value does
 * not, so the two cannot be compared without teaching this checker every language's escaping. A
 * range reaching past the file is the failure worth catching anyway, since a rewrite through it
 * cuts the wrong bytes.
 */
function checkLiteralRanges(source: string, actual: Literal[]): string[] {
	const coordinates = coordinatesOf(source);
	const problems: string[] = [];
	for (const literal of actual) {
		const cut = coordinates.sliceRange(literal.range);
		if (cut === undefined) {
			problems.push(`literal ${JSON.stringify(literal.value)}: range is outside the file`);
			continue;
		}
		if (cut === "") problems.push(`literal ${JSON.stringify(literal.value)}: range is empty`);
	}
	return problems;
}

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
