// What a conformance case is, and what running one produces.
//
// A case is data, so the corpus is readable by a provider team in any language. Only the runner is
// TypeScript.

import { z } from "zod";
import { type ProviderTiers, ProviderTiersSchema } from "../methods.js";
import { MoveBlockedReasonSchema, MoveEditsRequestSchema, MoveRefusalSchema } from "../move.js";
import { EntryHowSchema } from "../project.js";
import { SymbolKindSchema, VisibilitySchema } from "../symbols.js";
import { UnknownReasonSchema } from "../values.js";

////////////////////////////////
//  Schemas

/** Which capability a case exercises. Matches the tiers a provider declares at initialize. */
export const TierSchema = ProviderTiersSchema.keyof().meta({ id: "Tier" });

export type Tier = z.infer<typeof TierSchema>;

/**
 * Expectations are stated by PARSED parts, never by wire string.
 *
 * A wire string would make every grammar change rewrite the corpus, which buries what actually
 * moved. Every field is optional, so a case asserts only what it is about.
 */
export const ExpectedDeclarationSchema = z
	.object({
		name: z.string().min(1),
		kind: SymbolKindSchema.optional(),
		visibility: VisibilitySchema.optional(),
		exported: z.boolean().optional(),
		/** Name of the enclosing declaration, absent for module top level. */
		container: z.string().optional(),
		/** Descriptor chain of the symbol id, as `kind:name` pairs. */
		descriptors: z.array(z.string().min(1)).optional(),
		/**
		 * Where the NAME starts, which is the only way to pin what `character` counts.
		 *
		 * Every candidate unit agrees until a line holds a character above U+FFFF, so a case using
		 * one is the only thing that can tell UTF-16 code units from bytes from codepoints.
		 */
		nameStart: z.object({ line: z.number().int().min(0), character: z.number().int().min(0) }).optional(),
	})
	.meta({ id: "ExpectedDeclaration" });

export const ExpectedReferenceSchema = z
	.object({
		name: z.string().min(1),
		role: z.string().optional(),
		/** What the binding must resolve to: bound, ambiguous, or unbound. */
		status: z.enum(["bound", "ambiguous", "unbound"]).optional(),
		/** Declaration name the binding must land on. Implies status bound. */
		bindsTo: z.string().optional(),
		/** Module the binding must land in, for a use bound across files. Implies status bound. */
		bindsToModule: z.string().optional(),
		/** Name of the declaration the use is written in; `null` for none. */
		from: z.string().nullable().optional(),
		/**
		 * Which reason an unbound answer must carry. Implies status unbound.
		 *
		 * The reason is the product, so a case can pin it. Without this a provider passes by being
		 * unbound for any reason at all, including one that misdescribes what happened.
		 */
		reason: UnknownReasonSchema.optional(),
		/**
		 * The occurrence meant, by its range start, zero-based; `character` omitted matches the line.
		 *
		 * Without it a name written twice passes when either row satisfies the expectation. A position
		 * is one fixture's syntax, so only a case with a single fixture may state it.
		 */
		at: z
			.object({ line: z.number().int().nonnegative(), character: z.number().int().nonnegative().optional() })
			.optional(),
	})
	.superRefine((expected, context) => {
		const binds = expected.bindsTo !== undefined || expected.bindsToModule !== undefined;
		const implied = binds ? "bound" : expected.reason !== undefined ? "unbound" : undefined;
		const status = expected.status ?? implied;
		if ((binds && status !== "bound") || (expected.reason !== undefined && status !== "unbound")) {
			context.addIssue({
				code: "custom",
				message: `reference ${expected.name}: bindsTo and bindsToModule state bound, reason states unbound; one expectation cannot say both`,
			});
		}
	})
	.meta({ id: "ExpectedReference" });

export const ExpectedImportSchema = z
	.object({
		specifier: z.string().min(1),
		status: z.enum(["resolved", "external", "unresolved"]).optional(),
		module: z.string().optional(),
	})
	.meta({ id: "ExpectedImport" });

/**
 * What a type answer must be.
 *
 * `display` pins an exact rendering. `mentions` pins a UNION across languages: Python spells one
 * `Literal['a', 'b']`, TypeScript spells it `"a" | "b"`, and GDScript has no syntax for it at all,
 * so requiring each member to appear states the real expectation, which is that none was dropped.
 * `status` and `reason` pin an honest Unknown.
 */
export const ExpectedTypeSchema = z
	.object({
		name: z.string().min(1),
		display: z.string().min(1).optional(),
		mentions: z.array(z.string().min(1)).optional(),
		status: z.enum(["known", "inferred", "unknown"]).optional(),
		reason: UnknownReasonSchema.optional(),
	})
	.meta({ id: "ExpectedType" });

/** A declaration and the comment above it, named so their ranges can be compared. */
export const DocumentedSchema = z
	.object({
		declaration: z.string().min(1),
		/** Verbatim, matching one of the reported comment spans exactly. */
		comment: z.string().min(1),
	})
	.meta({ id: "Documented" });

/** One stretch of document prose, and which heading owns it. */
export const ExpectedDocRegionSchema = z
	.object({
		/** Verbatim, matching a reported region exactly. */
		text: z.string().min(1),
		/** The heading's name. Absent asserts a region anchored to the module, not merely unchecked. */
		under: z.string().min(1).optional(),
		/** Whether this came from a fenced block. Absent asserts prose. */
		fenced: z.boolean().optional(),
	})
	.meta({ id: "ExpectedDocRegion" });

/**
 * One literal a case expects, by what it MEANS rather than how it is written.
 *
 * `value` is the decoded value, so an escape belongs to the language and never to the expectation:
 * every language spells a tab differently and they all mean one. The range is not stated, because a
 * literal's span covers its quotes while its value does not, so the two can never be compared; the
 * checker asserts the span is inside the file instead, which is the failure that corrupts a rewrite.
 */
export const ExpectedLiteralSchema = z
	.object({
		value: z.string(),
		kind: z.enum(["string", "number", "boolean"]),
	})
	.meta({ id: "ExpectedLiteral" });

export type ExpectedLiteral = z.infer<typeof ExpectedLiteralSchema>;

export const ExpectedRoleSchema = z
	.discriminatedUnion("kind", [
		z.object({ kind: z.literal("library") }),
		z.object({
			kind: z.literal("entry"),
			how: EntryHowSchema,
			/** The main declaration's name and the zero-based line it is named on. */
			main: z.object({ name: z.string().min(1), line: z.number().int().min(0) }).optional(),
		}),
		z.object({ kind: z.literal("unknown"), reason: UnknownReasonSchema.optional() }),
	])
	.meta({ id: "ExpectedRole" });

export type ExpectedRole = z.infer<typeof ExpectedRoleSchema>;

/** One language's source for a case: the repo to write, and which file the case asks about. */
export const ConformanceFixtureSchema = z
	.object({
		files: z.record(z.string().min(1), z.string()),
		subject: z.string().min(1),
		/**
		 * Import expectations only this language can state, replacing the case's when present.
		 *
		 * A specifier and a resolved module path are both syntax: TypeScript says `./item` landing on
		 * `src/item.ts` where Python says `.item` landing on `src/item.py`. The shared sentence is
		 * still "it resolves to a workspace module"; only the spelling is local, so the override
		 * carries the spelling rather than forcing every language to pretend it writes another's.
		 */
		imports: z.array(ExpectedImportSchema).optional(),
		/**
		 * Type expectations only this language can state, replacing the case's when present.
		 *
		 * Same reasoning as `imports`. "Nothing was returned" is one concept spelled `undefined`,
		 * `None` and `null`, so a shared case can say a union must mention it without any language
		 * being made to pretend it writes another's word for it.
		 */
		typeOf: ExpectedTypeSchema.optional(),
		/**
		 * Declaration expectations only this language can state, replacing the case's when present.
		 *
		 * Same reasoning as `imports`. Some sentences can only be said about a declaration whose name
		 * and column are local: "a column counts UTF-16 code units" is shared, while the name it lands
		 * on and the width of the syntax to its left never are.
		 */
		declarations: z.array(ExpectedDeclarationSchema).optional(),
		/**
		 * Comment expectations only this language can state, replacing the case's when present.
		 *
		 * Needed more often than the others: a comment's text IS its syntax, so `#` languages can
		 * never satisfy a `//` expectation. The case-level list serves the curly-brace family and
		 * every other language overrides it.
		 */
		comments: z.array(z.string()).optional(),
		/**
		 * Literal expectations only this language can state, replacing the case's when present.
		 *
		 * Needed as often as comments: a boolean is `True` in one language, `true` in most, and absent
		 * from others entirely, so no shared list survives contact with every fixture.
		 */
		literals: z.array(ExpectedLiteralSchema).optional(),
		/** Doc region expectations only this language can state, replacing the case's when present. */
		docs: z.array(ExpectedDocRegionSchema).optional(),
		/** Overrides the case's role for this language. */
		role: ExpectedRoleSchema.optional(),
		/** Exact declaration names only this language can state, replacing the case's when present. */
		declarationNames: z.array(z.string().min(1)).optional(),
		documentation: DocumentedSchema.optional(),
		/** Which of the fixture's files discovery must list (true) or must leave out (false). */
		discovery: z.record(z.string().min(1), z.boolean()).optional(),
	})
	.meta({ id: "ConformanceFixture" });

export type ConformanceFixture = z.infer<typeof ConformanceFixtureSchema>;

export const ConformanceCaseSchema = z
	.object({
		id: z.string().min(1),
		tier: TierSchema,
		/** Prose for the failure report, so a red case explains itself. */
		about: z.string().min(1),
		/**
		 * Source per language, keyed by the `language` a provider reports at initialize.
		 *
		 * Fixtures vary with syntax. Expectations apply to every applicable language, so one corpus
		 * can cover providers with different syntax.
		 */
		fixtures: z.record(z.string().min(1), ConformanceFixtureSchema),
		/** Source form under test. */
		semanticForm: z.string().min(1).optional(),
		/** Languages expressing this form. */
		applicableLanguages: z.array(z.string().min(1)).min(1).optional(),
		declarations: z.array(ExpectedDeclarationSchema).optional(),
		/**
		 * EXACTLY these declaration names, in order.
		 *
		 * `declarations` above can only say a name IS reported, so a case saying "this yields no
		 * heading" cannot assert it and a phantom declaration passes unnoticed. Stating the whole
		 * list is how a negative claim becomes a check, which is the same exactness `comments` and
		 * `docs` already have.
		 */
		declarationNames: z.array(z.string().min(1)).optional(),
		references: z.array(ExpectedReferenceSchema).optional(),
		imports: z.array(ExpectedImportSchema).optional(),
		/**
		 * Declaration name whose type is asserted.
		 *
		 * `display` pins a known type. `status` and `reason` pin an honest Unknown, which is the half
		 * the suite could not state before: "this must answer unknown, and for THIS reason".
		 *
		 * `mentions` is how a UNION is asserted across languages. Python spells one
		 * `Literal['a', 'b']`, TypeScript spells it `"a" | "b"`, and GDScript has no syntax for it at
		 * all, so pinning a spelling would make a shared case a TypeScript case wearing a shared
		 * name. Requiring each member to appear somewhere states the real expectation, which is that
		 * no member was dropped.
		 */
		typeOf: ExpectedTypeSchema.optional(),
		/**
		 * EXACTLY these comment texts, trimmed, any order, duplicates counted.
		 *
		 * Exact unlike every other expectation here, because the failure worth catching is a false
		 * positive: a marker inside a string passes an at-least check and poisons search.
		 */
		comments: z.array(z.string()).optional(),
		/**
		 * EXACTLY these literals, any order, duplicates counted.
		 *
		 * Exact for the reason comments are, and it bites harder here. A literal reported for a
		 * fragment of program syntax is a false public contract, and a literal missed is a contract
		 * that vanishes; on a minified bundle, where names carry nothing, the literals ARE the API,
		 * so an at-least check would pass a provider that reports half of one.
		 */
		literals: z.array(ExpectedLiteralSchema).optional(),
		/**
		 * EXACTLY these doc regions, in document order.
		 *
		 * Exact for the same reason comments are: the failure worth catching is prose that is not
		 * there, or a fence swallowed into the paragraph beside it.
		 */
		docs: z.array(ExpectedDocRegionSchema).optional(),
		/** Role expected for the subject file. */
		role: ExpectedRoleSchema.optional(),
		/**
		 * A declaration and the comment documenting it, whose RANGES must relate in one of two ways.
		 *
		 * Providers disagree about whether a declaration's range already covers its own doc comment.
		 * Both answers are fine and neither is corrected. A THIRD answer is not fine: core attaches
		 * documentation by exactly these two shapes, so a provider that starts its range anywhere else
		 * loses every doc comment in its language, silently and with a green suite.
		 */
		documentation: DocumentedSchema.optional(),
		/**
		 * What parsing this fixture must say about its syntax.
		 *
		 * `required` is the only check on the `syntaxDiagnostics` claim. A provider that recovers
		 * from anything returns no diagnostic for text that does not compile, so a caller validating
		 * candidate text before writing it reads that silence as approval. Declaring the tier and
		 * then staying quiet is the over-claim this case exists to catch.
		 */
		parseErrors: z.enum(["required", "forbidden"]).optional(),
		/** Whether reading this fixture must leave a `warning` or `info` diagnostic behind. */
		notes: z.enum(["required", "forbidden"]).optional(),
	})
	.superRefine((testCase, context) => {
		if (testCase.tier === "fileRoles") {
			if (testCase.role === undefined) {
				context.addIssue({
					code: "custom",
					message: `case ${testCase.id}: fileRoles needs a role expectation`,
				});
			}
			if (testCase.semanticForm === undefined) {
				context.addIssue({ code: "custom", message: `case ${testCase.id}: fileRoles needs a semanticForm` });
			}
			if (testCase.applicableLanguages === undefined) {
				context.addIssue({
					code: "custom",
					message: `case ${testCase.id}: fileRoles needs applicableLanguages`,
				});
			} else if (new Set(testCase.applicableLanguages).size !== testCase.applicableLanguages.length) {
				context.addIssue({
					code: "custom",
					message: `case ${testCase.id}: applicableLanguages contains duplicates`,
				});
			}
		} else if (testCase.semanticForm !== undefined || testCase.applicableLanguages !== undefined) {
			context.addIssue({
				code: "custom",
				message: `case ${testCase.id}: role applicability belongs to fileRoles`,
			});
		}
		const positioned = (testCase.references ?? []).some((reference) => reference.at !== undefined);
		if (positioned && Object.keys(testCase.fixtures).length > 1) {
			context.addIssue({
				code: "custom",
				message: `case ${testCase.id}: a reference states \`at\`, which is one fixture's syntax, in a case with several fixtures`,
			});
		}
	})
	.meta({ id: "ConformanceCase" });

export type ConformanceCase = z.infer<typeof ConformanceCaseSchema>;

export const MoveExpectationSchema = z
	.discriminatedUnion("kind", [
		z.object({ kind: z.literal("ready"), files: z.record(z.string().min(1), z.string()) }),
		z.object({ kind: z.literal("blocked"), reasons: z.array(MoveBlockedReasonSchema).optional() }),
		z.object({ kind: z.literal("refused"), reason: MoveRefusalSchema }),
	])
	.meta({ id: "MoveExpectation" });

export const MoveFixtureSchema = z
	.object({
		files: z.record(z.string().min(1), z.string()),
		request: MoveEditsRequestSchema,
		expect: MoveExpectationSchema,
	})
	.meta({ id: "MoveFixture" });

export type MoveFixture = z.infer<typeof MoveFixtureSchema>;

export const MoveCaseSchema = z
	.object({
		id: z.string().min(1),
		/** Prose for the failure report, so a red case explains itself. */
		about: z.string().min(1),
		fixtures: z.record(z.string().min(1), MoveFixtureSchema),
	})
	.meta({ id: "MoveCase" });

export type MoveCase = z.infer<typeof MoveCaseSchema>;

/**
 * One module that declares, one that uses it, and text for the parse the index refuses.
 *
 * A fixture in a language is the claim that this provider binds across files. Without that claim
 * the case has nothing to observe, so a language with no fixture skips rather than passing while
 * asserting nothing.
 */
export const LifecycleFixtureSchema = z
	.object({
		files: z.record(z.string().min(1), z.string()),
		/** The module whose facts the index refuses. Its disk text declares `name`. */
		target: z.string().min(1),
		/** The module whose use of `name` must follow what the index holds. */
		user: z.string().min(1),
		/** The declaration in `target` that the use names. */
		name: z.string().min(1),
		/** The target parsed again, declaring anything but `name`; the index refuses these facts. */
		refusedText: z.string().min(1),
	})
	.superRefine((fixture, context) => {
		for (const module of [fixture.target, fixture.user]) {
			if (fixture.files[module] === undefined) {
				context.addIssue({ code: "custom", message: `${module} is not among the fixture's files` });
			}
		}
	})
	.meta({ id: "LifecycleFixture" });

export type LifecycleFixture = z.infer<typeof LifecycleFixtureSchema>;

export const LifecycleCaseSchema = z
	.object({
		id: z.string().min(1),
		/** Prose for the failure report, so a red case explains itself. */
		about: z.string().min(1),
		/**
		 * `notHeld`: a forgotten target does not bind.
		 * `keepsAdmitted`: refusal preserves the admitted binding.
		 * `unseen`: target lifecycle operations leave other-module answers unchanged.
		 */
		expect: z.enum(["notHeld", "keepsAdmitted", "unseen"]),
		fixtures: z.record(z.string().min(1), LifecycleFixtureSchema),
	})
	.meta({ id: "LifecycleCase" });

export type LifecycleCase = z.infer<typeof LifecycleCaseSchema>;

////////////////////////////////
//  Interfaces & Types

/**
 * How a case ended.
 *
 * `skipped` is the one that carries the tiering claim: a provider that does not declare a tier is
 * not failing its cases, it has not reached them. Reporting that as a failure would make an honest
 * partial provider indistinguishable from a broken one.
 *
 * A case with no fixture in the provider's language skips for the same reason, and the gap is the
 * corpus's rather than the provider's.
 *
 * Move is ungated. A provider refusing it as NotImplemented skips, while any implemented answer
 * is checked against the case.
 */
/** `stalled`: machine or process, never answer. */
export type CaseOutcome = "passed" | "failed" | "skipped" | "stalled";

export interface VariantResult {
	name: string;
	description: string;
	outcome: "passed" | "failed";
	problems: string[];
}

export interface CaseResult {
	caseId: string;
	/** `protocol` for checks about the wire contract itself, which no tier can gate. */
	tier: Tier | "protocol";
	outcome: CaseOutcome;
	/** Why it failed, stalled or was skipped. Empty on a pass. */
	problems: string[];
	/** Per-variant results. */
	variants?: VariantResult[];
}

export interface SuiteReport {
	providerId: string;
	language: string;
	/** Tiers the provider declared, which decides what was run rather than skipped. */
	tiers: ProviderTiers;
	results: CaseResult[];
	passed: number;
	failed: number;
	skipped: number;
	stalled: number;
}
