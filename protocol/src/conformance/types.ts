// What a conformance case is, and what running one produces.
//
// A case is data, so the corpus is readable by a provider team in any language. Only the runner is
// TypeScript.

import { z } from "zod";
import { ProviderTiersSchema } from "../methods.js";
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
		/**
		 * Which reason an unbound answer must carry. Implies status unbound.
		 *
		 * The reason is the product, so a case can pin it. Without this a provider passes by being
		 * unbound for any reason at all, including one that misdescribes what happened.
		 */
		reason: UnknownReasonSchema.optional(),
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
	})
	.meta({ id: "ConformanceFixture" });

export const ConformanceCaseSchema = z
	.object({
		id: z.string().min(1),
		tier: TierSchema,
		/** Prose for the failure report, so a red case explains itself. */
		about: z.string().min(1),
		/**
		 * Source per language, keyed by the `language` a provider reports at initialize.
		 *
		 * Only the fixture varies. The expectations below are the same sentence about every language,
		 * which is what makes one corpus meaningful across providers that share no syntax.
		 */
		fixtures: z.record(z.string().min(1), ConformanceFixtureSchema),
		declarations: z.array(ExpectedDeclarationSchema).optional(),
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
	})
	.meta({ id: "ConformanceCase" });

export type ConformanceCase = z.infer<typeof ConformanceCaseSchema>;

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
 */
export type CaseOutcome = "passed" | "failed" | "skipped";

export interface CaseResult {
	caseId: string;
	tier: Tier;
	outcome: CaseOutcome;
	/** Why it failed or was skipped. Empty on a pass. */
	problems: string[];
}

export interface SuiteReport {
	providerId: string;
	language: string;
	/** Tiers the provider declared, which decides what was run rather than skipped. */
	tiers: Record<Tier, boolean>;
	results: CaseResult[];
	passed: number;
	failed: number;
	skipped: number;
}
