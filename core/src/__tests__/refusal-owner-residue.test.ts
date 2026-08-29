import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { coordinatesOf, readSwept } from "@nyaa-lexicon/protocol";

/**
 * Holds refusals.ts as the only composer of a knowledge refusal.
 *
 * Scoped to the two files that return refusals, because `refused:` and `ok: false` are ordinary
 * outcome shapes elsewhere in core. The token is a string literal opening directly after the
 * reason slot, which an inline sentence carries and a constructor call does not.
 */
const SWEPT = ["knowledge.ts", "answers.ts"].map((name) => join(import.meta.dirname, "..", name));

const OWNER = join(import.meta.dirname, "..", "refusals.ts");

/** A literal in the reason slot: `reason: "` / `reason: \`` / `refused: '`, whitespace allowed. */
const INLINE = /\b(reason|refused)\s*:\s*["'`]/g;

/** A constructor reached through the owner's namespace. */
const CALL = /\brefusal\.(\w+)\(/g;

/** An exported constructor of the owner. */
const EXPORTED = /^export function (\w+)\(/gm;

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

describe("one module composes every knowledge refusal", () => {
	it("finds both swept files and the owner, so a passing run is never vacuous", () => {
		for (const file of [...SWEPT, OWNER]) expect(readSwept(file)).not.toBeNull();
		const calls = SWEPT.flatMap((file) => [...(readSwept(file) ?? "").matchAll(CALL)]);
		expect(calls.length).toBeGreaterThanOrEqual(15);
	});

	// Every constructor has a caller and every call names a constructor, so neither drifts alone.
	it("has each exported constructor called, and each call naming an export", () => {
		const owner = readSwept(OWNER) ?? "";
		const exported = new Set([...owner.matchAll(EXPORTED)].map((match) => match[1] as string));
		const called = new Set(
			SWEPT.flatMap((file) => [...(readSwept(file) ?? "").matchAll(CALL)].map((match) => match[1] as string)),
		);
		const insideOwner = [...exported].filter((name) =>
			new RegExp(`\\b${name}\\(`).test(owner.replace(EXPORTED, "")),
		);
		expect([...called].filter((name) => !exported.has(name))).toEqual([]);
		expect([...exported].filter((name) => !called.has(name) && !insideOwner.includes(name))).toEqual([]);
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
