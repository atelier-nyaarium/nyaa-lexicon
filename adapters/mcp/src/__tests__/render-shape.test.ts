// Every renderer's markdown shape, checked without pinning a word of it.
//
// Bug class killed: spacing that drifts unseen. A blank line lost or gained between a heading and
// what follows changes how the page reads, and a table with one after its delimiter row stops being
// a table. No wording assertion anywhere notices either.

import { describe, expect, it } from "bun:test";
import * as render from "../render";
import { CASES, textOf } from "./renderCases";

////////////////////////////////
//  Helpers

function rendered(name: string): string[] {
	const fn = (render as Record<string, unknown>)[name] as (...args: unknown[]) => unknown;
	return (CASES[name] ?? []).map((args) => textOf(fn(...args)));
}

/** A delimiter row followed by a blank line, which splits the table from its own rows. */
function brokenTable(text: string): boolean {
	return /^\|[\s|:-]+\|$\n$/m.test(text);
}

////////////////////////////////
//  Tests

describe("what every renderer's markdown must hold", () => {
	const names = Object.keys(render).filter(
		(key) => key.startsWith("render") && typeof (render as Record<string, unknown>)[key] === "function",
	);

	// Without this, a renderer added tomorrow is untested and nothing says so.
	it("exercises every exported renderer", () => {
		expect(names.length).toBeGreaterThan(25);
		expect(names.filter((name) => CASES[name] === undefined)).toEqual([]);
	});

	it("found the fixtures it claims to run", () => {
		const total = Object.values(CASES).reduce((sum, cases) => sum + cases.length, 0);
		expect(total).toBeGreaterThan(60);
	});

	for (const name of Object.keys(CASES)) {
		it(`${name} spaces its sections with one blank line, never two`, () => {
			for (const [index, text] of rendered(name).entries()) {
				expect(text.includes("\n\n\n"), `${name}[${index}] has a doubled blank line`).toBe(false);
			}
		});

		it(`${name} starts and ends on its own text`, () => {
			for (const [index, text] of rendered(name).entries()) {
				expect(text, `${name}[${index}] has a stray edge newline`).toBe(text.trim());
			}
		});

		it(`${name} keeps a table's rows under its delimiter`, () => {
			for (const [index, text] of rendered(name).entries()) {
				expect(brokenTable(text), `${name}[${index}] split a table from its rows`).toBe(false);
			}
		});

		it(`${name} leaves no unresolved interpolation`, () => {
			for (const [index, text] of rendered(name).entries()) {
				expect(text.includes("undefined"), `${name}[${index}] rendered the word undefined`).toBe(false);
				expect(text.includes("[object Object]"), `${name}[${index}] rendered an object`).toBe(false);
			}
		});
	}
});
