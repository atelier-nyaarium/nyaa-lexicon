import { describe, expect, it } from "bun:test";
import { QUESTION_CLASSES, type QuestionClass, questionsFor } from "../daemonShapes.js";
import { SymbolKindSchema } from "../symbols.js";

////////////////////////////////
//  Helpers

/** Strictly increasing positions in QUESTION_CLASSES, which is the order every caller relies on. */
function isOrdered(questions: readonly QuestionClass[]): boolean {
	let last = -1;
	for (const question of questions) {
		const at = QUESTION_CLASSES.indexOf(question);
		if (at <= last) return false;
		last = at;
	}
	return true;
}

////////////////////////////////
//  Tests

describe("questionsFor", () => {
	it("gives a running kind every question, in order", () => {
		for (const kind of ["function", "method", "constructor", "operator"] as const) {
			const questions = questionsFor({ kind, visibility: "public" });
			expect(questions).toEqual(QUESTION_CLASSES);
		}
	});

	it("drops relate and effects from a value-like kind", () => {
		for (const kind of ["constant", "variable"] as const) {
			expect(questionsFor({ kind, visibility: "public" })).toEqual(["describe", "why", "contract", "usage"]);
		}
	});

	it("drops usage and effects from a class-like kind, but keeps relate", () => {
		for (const kind of ["class", "struct"] as const) {
			expect(questionsFor({ kind, visibility: "public" })).toEqual([
				"describe",
				"why",
				"relate",
				"contract",
				"usage",
			]);
		}
	});

	it("drops effects and usage from a shape-like kind", () => {
		for (const kind of ["interface", "enum"] as const) {
			expect(questionsFor({ kind, visibility: "public" })).toEqual(["describe", "why", "relate", "contract"]);
		}
	});

	it("gives a field-like kind only describe and contract", () => {
		for (const kind of ["property", "field", "event"] as const) {
			expect(questionsFor({ kind, visibility: "public" })).toEqual(["describe", "contract"]);
		}
	});

	it("gives a grouping kind only describe and why", () => {
		for (const kind of ["file", "module", "namespace", "package"] as const) {
			expect(questionsFor({ kind, visibility: "public" })).toEqual(["describe", "why"]);
		}
	});

	it("gives a typeParameter or a heading only describe", () => {
		for (const kind of ["typeParameter", "heading"] as const) {
			expect(questionsFor({ kind, visibility: "public" })).toEqual(["describe"]);
		}
	});

	it("has none for a local, whatever the kind", () => {
		expect(questionsFor({ kind: "function", visibility: "local" })).toEqual([]);
		expect(questionsFor({ kind: "class", visibility: "local" })).toEqual([]);
	});

	it("covers every kind the wire declares, each in QUESTION_CLASSES order", () => {
		for (const kind of SymbolKindSchema.options) {
			const questions = questionsFor({ kind, visibility: "public" });
			expect(questions.length).toBeGreaterThan(0);
			expect(isOrdered(questions)).toBe(true);
		}
	});
});
