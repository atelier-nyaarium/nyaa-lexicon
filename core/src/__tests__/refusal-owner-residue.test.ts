import { describe, expect, it } from "bun:test";
import { basename, join } from "node:path";
import { codeOnly, coordinatesOf, readSwept, sourceFiles } from "@nyaa-lexicon/protocol";

/**
 * Holds refusals.ts as the only composer of a refusal.
 *
 * Swept only where `reason:` always names one; elsewhere it also names an enum value and a tally
 * field, and the brand guards those slots instead.
 */
const SWEPT = ["knowledge.ts", "answers.ts"].map((name) => join(import.meta.dirname, "..", name));

const OWNER = join(import.meta.dirname, "..", "refusals.ts");

/** Every file that composes a refusal, for the reachability check. */
const NARROWED = ["refactorPlanner.ts", "sourceWorkspace.ts", "service.ts", "transactions.ts", "applyEdits.ts"].map(
	(name) => join(import.meta.dirname, "..", name),
);

const SLOTS = join(import.meta.dirname, "..", "refusalSlots.ts");

/** Each narrowed slot is asserted against the compiler here, which a text sweep cannot do. */
const ASSERTIONS = join(import.meta.dirname, "refusalSlots.types.ts");

/** A literal in the reason slot: `reason: "` / `reason: \`` / `refused: '`, whitespace allowed. */
const INLINE = /\b(reason|refused)\s*:\s*["'`]/g;

/** A constructor reached through the owner's namespace. */
const NAMESPACED = /\brefusal\.(\w+)\(/g;

/** An exported constructor of the owner. */
const EXPORTED = /^export function (\w+)\(/gm;

/** Every spelling that mints the brand by hand; the owner alone may write one. */
const MINTS = [
	/\bas\s+(?:refusal\.)?Refusal\b/,
	/<(?:refusal\.)?Refusal>/,
	/\bsatisfies\s+(?:refusal\.)?Refusal\b/,
	/\bReturnType<typeof refusal\./,
];

const CORE = join(import.meta.dirname, "..");

/** Tests are swept too: a double minting its own refusal is a sentence nobody reviewed. */
const SKIP_DIRS = new Set(["dist", "node_modules", ".tsbuild", "fixtures"]);

/** This file quotes every minting spelling to prove the check fires, so it cannot sweep itself. */
const SELF = import.meta.filename;

/** Comments and string literals stripped, so a cast spelling quoted in prose is not read as one. */
function typesOnly(source: string): string {
	return codeOnly(source)
		.replace(/`(?:\\[\s\S]|[^\\`])*`/g, '""')
		.replace(/'(?:\\[\s\S]|[^\\'])*'/g, '""')
		.replace(/"(?:\\[\s\S]|[^\\"])*"/g, '""');
}

////////////////////////////////
//  Functions & Helpers

/** Each inline literal with its line, so a report names the place. */
export function inlineRefusals(source: string): string[] {
	const coordinates = coordinatesOf(source);
	const found: string[] = [];
	for (const match of source.matchAll(INLINE)) {
		const line = (coordinates.positionAt(match.index)?.line ?? 0) + 1;
		found.push(`line ${line}: ${match[0]}`);
	}
	return found;
}

////////////////////////////////
//  Tests

describe("one module composes every refusal", () => {
	it("finds every swept and narrowed file and the owner, so a passing run is never vacuous", () => {
		for (const file of [...SWEPT, ...NARROWED, OWNER, SLOTS, ASSERTIONS]) expect(readSwept(file)).not.toBeNull();
		const calls = SWEPT.flatMap((file) => [...(readSwept(file) ?? "").matchAll(NAMESPACED)]);
		expect(calls.length).toBeGreaterThanOrEqual(15);
	});

	// A constructor nothing calls and a call naming no constructor are both drift.
	it("has each exported constructor called, and each call naming an export", () => {
		const owner = readSwept(OWNER) ?? "";
		const exported = new Set([...owner.matchAll(EXPORTED)].map((match) => match[1] as string));
		const callers = sourceFiles(CORE, SKIP_DIRS)
			.filter((file) => file !== OWNER)
			.map((file) => readSwept(file) ?? "");
		const named = (name: string) => callers.some((source) => new RegExp(`\\b${name}\\(`).test(source));
		const insideOwner = [...exported].filter((name) =>
			new RegExp(`\\b${name}\\(`).test(owner.replace(EXPORTED, "")),
		);
		const namespaced = new Set(
			SWEPT.flatMap((file) => [...(readSwept(file) ?? "").matchAll(NAMESPACED)].map((m) => m[1] as string)),
		);
		expect([...namespaced].filter((name) => !exported.has(name))).toEqual([]);
		expect([...exported].filter((name) => !named(name) && !insideOwner.includes(name))).toEqual([]);
	});

	// One assertion per slot, so a widened one fails the build rather than this sweep.
	it("asserts every narrowed slot against the compiler", () => {
		const asserted = [...(readSwept(ASSERTIONS) ?? "").matchAll(/^type _\w+ = Assert</gm)];
		expect(asserted.length, "each refusal slot needs its own type assertion").toBeGreaterThanOrEqual(15);
	});

	// The brand makes a raw sentence a type error; a cast is the way past it, in any spelling.
	it("has nobody in core but the owner minting the brand", () => {
		const files = sourceFiles(CORE, SKIP_DIRS);
		expect(files).toContain(OWNER);
		expect(files).toContain(SELF);
		const offenders = files
			.filter((file) => file !== OWNER && file !== SELF)
			.flatMap((file) => {
				const source = typesOnly(readSwept(file) ?? "");
				return MINTS.filter((mint) => mint.test(source)).map((mint) => `${basename(file)}: ${mint.source}`);
			});
		expect(offenders, "minting a refusal belongs to core/src/refusals.ts; call a constructor").toEqual([]);
	});

	it("recognises each minting spelling when planted", () => {
		const planted = [
			"const r = text as Refusal;",
			"const r = <refusal.Refusal>text;",
			"const r = text satisfies Refusal;",
			"const r = text as ReturnType<typeof refusal.needsProse>;",
		];
		for (const line of planted)
			expect(
				MINTS.some((mint) => mint.test(line)),
				line,
			).toBe(true);
	});

	it("catches a planted literal under each of the three shapes", () => {
		expect(inlineRefusals(`return { recorded: false, reason: "an answer needs prose" };`)).toHaveLength(1);
		expect(inlineRefusals("return { symbolId, refused: `nothing to doubt` };")).toHaveLength(1);
		expect(inlineRefusals(`return { ok: false, reason: 'cites none' };`)).toHaveLength(1);
		expect(inlineRefusals(`return { ok: false, reason: refusal.citesNothing() };`)).toHaveLength(0);
		expect(inlineRefusals(`return { recorded: false, reason: check.reason };`)).toHaveLength(0);
	});

	it("has the ledger and the checker composing no refusal of their own", () => {
		const offenders = SWEPT.flatMap((file) => {
			const source = readSwept(file);
			if (source === null) return [];
			return inlineRefusals(source).map((hit) => `${file.split("/").pop()} ${hit}`);
		});
		expect(
			offenders,
			"a knowledge refusal is a named constructor in core/src/refusals.ts; put its result in the reason slot rather than a sentence",
		).toEqual([]);
	});
});
