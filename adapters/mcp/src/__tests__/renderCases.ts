// One argument list per renderer, shared by the shape test and by any before-and-after comparison.
//
// The values carry no blank lines of their own, so a doubled newline in a result came from the
// renderer rather than from a fixture.

const SYMBOL = {
	symbolId: "lexicon typescript src/a.ts add().",
	name: "add",
	kind: "function",
	module: "src/a.ts",
	exported: true,
	visibility: "public",
	signature: "function add()",
	lines: { start: 0, end: 4 },
	docComment: "Adds a thing.",
} as const;

const OTHER = { ...SYMBOL, symbolId: "lexicon typescript src/a.ts qty.", name: "qty", kind: "property" } as const;

const RANGE = { start: { line: 3, column: 1 }, end: { line: 5, column: 2 } } as const;
const SPAN = { start: { line: 3, character: 1 }, end: { line: 5, character: 2 } } as const;
const EXACT = { kind: "exact", count: 1 } as const;
const NONE = { kind: "exact", count: 0 } as const;
const CAPPED = { kind: "atLeast", count: 4, reason: "pageCapped" } as const;
const AT = 1_700_000_000;

const ANSWER = {
	question: "why",
	prose: "Because the store is the owner.",
	factId: "lexicon typescript src/a.ts add(). answer why",
	recordedAt: AT,
	model: "test",
	citations: ["lexicon typescript src/a.ts add(). declaration"],
} as const;

const DOUBT = {
	factId: "lexicon typescript src/a.ts add(). doubt why",
	reason: "the body changed",
	by: "test",
} as const;
const ISSUE = { kind: "unresolved", detail: "a name stopped resolving", module: "src/a.ts" } as const;

export const CASES: Record<string, unknown[][]> = {
	renderDescribe: [
		[
			{
				symbol: SYMBOL,
				members: [OTHER],
				comments: [{ line: 2, form: "leading", text: "A note." }],
				moreComments: 3,
				prose: [{ line: 1, fenced: false, text: "Some prose." }],
				moreProse: 2,
				referenceCount: 4,
				hierarchy: { supertypes: [OTHER], subtypes: [OTHER], ancestors: [OTHER], unboundSupertypes: ["Foo"] },
				graph: { fanOut: 6, viaMembers: 3, cycle: ["a", "b"] },
			},
		],
		[
			{
				symbol: { ...SYMBOL, kind: "heading", signature: undefined, docComment: undefined },
				members: [],
				referenceCount: 0,
				hierarchy: { supertypes: [], subtypes: [], ancestors: [], unboundSupertypes: [] },
				graph: { fanOut: 0 },
			},
		],
	],
	renderReferences: [
		[{ total: 0, references: [], truncated: false }],
		[{ total: 3, references: [{ module: "src/a.ts", startLine: 2, role: "call" }], truncated: true }],
	],
	renderType: [
		["add", { status: "known", display: "() => void", provenance: "declared" }],
		["add", { status: "known", display: "() => void", provenance: "inference" }],
		["add", { status: "inferred", display: "string", basis: "a literal" }],
		["add", { status: "unknown", reason: "NotImplemented", detail: "no provider" }],
	],
	renderRenamePlan: [
		[
			{
				symbolId: SYMBOL.symbolId,
				oldName: "add",
				newName: "plus",
				occurrences: 3,
				files: [{ module: "src/a.ts", sites: [{ line: 2, column: 3 }], ownerCalls: [] }],
				blockers: [],
				warnings: [],
			},
		],
		[
			{
				symbolId: SYMBOL.symbolId,
				oldName: "add",
				newName: "plus",
				occurrences: 1,
				files: [{ module: "src/a.ts", sites: [{ line: 2, column: 3 }] }],
				blockers: [{ kind: "shadow", detail: "a local shadows it" }],
				warnings: [{ kind: "dynamic", detail: "named in a string", sites: [{ module: "src/a.ts", line: 3 }] }],
			},
		],
	],
	renderMovePlan: [
		[{ ok: false, reason: "no such module" }],
		[
			{
				ok: true,
				name: "add",
				symbolId: SYMBOL.symbolId,
				fromModule: "src/a.ts",
				toModule: "src/b.ts",
				closure: [SYMBOL, OTHER],
				removal: { start: { line: 1, column: 0 }, end: { line: 8, column: 1 } },
				usedAtSource: false,
				referencing: ["src/c.ts"],
				dependencies: [
					{ name: "helper", origin: { kind: "insideClosure" } },
					{ name: "other", origin: { kind: "workspace", module: "src/d.ts" } },
					{ name: "ext", origin: { kind: "external", via: { specifier: "pkg" } } },
					{ name: "gone", origin: { kind: "unresolved", reason: "NotFound" } },
				],
			},
		],
	],
	renderComments: [
		[{ count: NONE, comments: [] }],
		[
			{
				count: CAPPED,
				comments: [
					{
						module: "src/a.ts",
						range: RANGE,
						raw: "// a note",
						factId: "f1",
						anchor: SYMBOL,
						form: "leading",
					},
				],
			},
		],
	],
	renderDocs: [
		[{ count: NONE, docs: [] }],
		[
			{
				count: EXACT,
				docs: [
					{
						module: "NOTES.md",
						range: RANGE,
						raw: "some text",
						factId: "f2",
						headingPath: ["A", "B"],
						fenced: true,
						anchor: SYMBOL,
					},
				],
			},
		],
	],
	renderLiterals: [
		[{ count: NONE, literals: [] }],
		[
			{
				count: EXACT,
				literals: [
					{
						module: "src/a.ts",
						range: RANGE,
						kind: "string",
						value: "x",
						factId: "f3",
						containerId: SYMBOL.symbolId,
						anchor: SYMBOL,
					},
				],
			},
		],
	],
	renderCoChange: [
		[{ module: "src/a.ts", partners: [], commits: 50, widthLimit: 80 }],
		[
			{
				module: "src/a.ts",
				partners: [{ module: "src/b.ts", together: 3, outOf: 10 }],
				commits: 50,
				widthLimit: 80,
			},
		],
	],
	renderFileHistory: [
		[
			{
				module: "src/a.ts",
				commits: 0,
				linesAdded: 0,
				linesDeleted: 0,
				recent: [],
				firstSeen: null,
				lastTouched: null,
				truncated: false,
			},
		],
		[
			{
				module: "src/a.ts",
				commits: 4,
				linesAdded: 30,
				linesDeleted: 12,
				recent: [{ hash: "abc1234", subject: "did a thing", at: AT, added: 3, deleted: 1 }],
				firstSeen: AT,
				lastTouched: AT,
				truncated: true,
			},
		],
	],
	renderKnowledge: [
		[null, "describe"],
		[{ answer: ANSWER, stale: false, shaky: false, inheritedStale: [], doubtedUpstream: [], doubts: [] }, "why"],
		[
			{
				answer: ANSWER,
				stale: true,
				shaky: true,
				inheritedStale: [ANSWER.citations[0]],
				doubtedUpstream: [ANSWER.citations[0]],
				doubts: [DOUBT],
			},
			"why",
		],
	],
	renderKnowledgeGaps: [
		[{ question: "describe", total: 0, external: 2, rows: [], scope: undefined, seeded: false }, undefined],
		[
			{ question: "describe", total: 0, external: 0, rows: [], scope: { module: "src/a.ts", declarations: 0 } },
			undefined,
		],
		[
			{
				question: "describe",
				total: 3,
				external: 0,
				seeded: true,
				rows: [
					{
						symbolId: SYMBOL.symbolId,
						name: "add",
						kind: "function",
						module: "src/a.ts",
						why: "stale",
						askCount: 2,
						fanIn: 9,
						question: "describe",
					},
				],
			},
			"src",
		],
	],
	renderRecordOutcome: [
		[{ recorded: true, answer: ANSWER, uncovered: [] }],
		[{ recorded: true, answer: ANSWER, uncovered: [ANSWER.citations[0]] }],
		[{ recorded: false, reason: "a citation is stale" }],
	],
	renderInvalidateOutcome: [
		[{ refused: "no such symbol" }],
		[
			{
				symbolId: SYMBOL.symbolId,
				doubted: [{ question: "why", doubt: DOUBT }],
				noAnswer: [],
				gaps: [],
			},
		],
		[{ symbolId: SYMBOL.symbolId, doubted: [], noAnswer: ["contract"], gaps: [] }],
	],
	renderFacts: [
		[{ symbolId: SYMBOL.symbolId, facts: [], truncated: [] }],
		[
			{
				symbolId: SYMBOL.symbolId,
				facts: [
					{ factId: "f1", kind: "answer", module: "src/a.ts", summary: "describe: it adds." },
					{ factId: "f2", kind: "declaration", module: "src/a.ts", summary: "function add()" },
					{ factId: "f3", kind: "reference", module: "src/b.ts", summary: "call" },
				],
				truncated: ["reference"],
			},
		],
	],
	renderMentions: [
		[{ name: "add", mentions: [], commits: 20 }],
		[{ name: "add", mentions: [{ hash: "abc1234", subject: "rename add", at: AT, files: 2 }], commits: 20 }],
	],
	renderImports: [
		[{ imports: [], count: NONE }],
		[{ imports: [{ module: "src/a.ts", specifier: "./b.js", resolved: "src/b.ts" }], count: CAPPED }],
	],
	renderMostReferenced: [[[]], [[{ symbolId: SYMBOL.symbolId, count: 9, declaration: SYMBOL }]]],
	renderSymbolSearch: [
		[{ symbols: [], text: "add", count: NONE }],
		[{ symbols: [SYMBOL], text: "add", count: EXACT }],
		[{ symbols: [SYMBOL], regex: "/a/", count: CAPPED }],
	],
	renderOutline: [
		["src/a.ts", [], undefined],
		["src/a.ts", [SYMBOL, OTHER], { notes: ["a provider note"] }],
	],
	renderSymbolSource: [
		[{ found: false, reason: "the index is stale", stale: true }],
		[{ found: false, reason: "no such symbol" }],
		[
			{
				found: true,
				symbolId: SYMBOL.symbolId,
				name: "add",
				kind: "function",
				module: "src/a.ts",
				range: SPAN,
				text: "const a = 1;",
			},
		],
	],
	renderOverview: [
		[
			{
				files: 2,
				symbols: 2,
				references: 0,
				imports: 0,
				literals: 0,
				modules: 2,
				scope: "12 files",
				index: { state: "ready", done: 0, total: 0, failures: 0, fullFiles: 2, outlineFiles: 0 },
				largest: [{ module: "src/a.ts", symbols: 2 }],
			},
		],
	],
	renderIssues: [[[]], [[ISSUE]]],
	renderRefactorStart: [
		[{ started: true, id: "tx1", rules: ["Track a file before editing it."] }],
		[{ started: false, id: "tx1", reason: "one is already open" }],
	],
	renderRefactorStatus: [
		[{ open: false }],
		[{ open: true, id: "tx2", steps: [], tracked: [], issues: [] }],
		[
			{
				open: true,
				id: "tx1",
				steps: [{ stepNo: 1, kind: "rename", phase: "applied", modules: ["src/a.ts"] }],
				tracked: ["src/a.ts"],
				issues: [ISSUE],
			},
		],
	],
	renderReplaceOutcome: [
		[{ replaced: false, reason: "it did not parse" }],
		[{ replaced: true, module: "src/a.ts", issues: [], reindexed: ["src/a.ts"] }],
	],
	renderInsertOutcome: [
		[{ alreadyInserted: true, module: "src/a.ts" }],
		[{ inserted: false, reason: "it did not parse in place" }],
		[{ inserted: true, module: "src/a.ts", issues: [], reindexed: ["src/a.ts"] }],
	],
	renderMoveOutcome: [
		["src/b.ts", { moved: false, reason: "a site could not be rewritten", issues: [] }],
		[
			"src/b.ts",
			{
				moved: true,
				symbolId: SYMBOL.symbolId,
				modules: ["src/a.ts", "src/b.ts"],
				rewritten: ["src/c.ts"],
				imported: ["src/b.ts"],
				issues: [],
			},
		],
	],
	renderRenameStep: [
		["plus", { renamed: false, reason: "an occurrence could not be rewritten", issues: [] }],
		[
			"plus",
			{
				renamed: true,
				symbolId: SYMBOL.symbolId,
				sites: 3,
				modules: ["src/a.ts"],
				reindexed: ["src/a.ts"],
				issues: [],
			},
		],
	],
	renderRefactorCommit: [
		[{ committed: true, issues: [] }],
		[{ committed: true, issues: [ISSUE] }],
		[{ committed: false, issues: [ISSUE], reason: "issues are outstanding" }],
	],
	renderCandidates: [
		["add", []],
		["add", [SYMBOL]],
		["add", [SYMBOL, { ...SYMBOL, module: "src/b.ts", symbolId: "lexicon typescript src/b.ts add()." }]],
	],
};

/** Renderers answer a string, except `renderIssues`, which answers the lines to splice in. */
export function textOf(answer: unknown): string {
	return Array.isArray(answer) ? answer.join("\n") : String(answer);
}
