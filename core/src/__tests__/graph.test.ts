import { describe, expect, it } from "vitest";
import { findCycles } from "../graph";

////////////////////////////////
//  Helpers

function edges(...pairs: Array<[string, string]>) {
	return pairs.map(([from, to]) => ({ from, to }));
}

/** Members have no meaningful order, so every assertion compares sorted sets. */
function membersOf(cycles: Array<{ members: string[] }>): string[][] {
	return cycles.map((cycle) => [...cycle.members].sort()).sort((a, b) => (a[0] ?? "").localeCompare(b[0] ?? ""));
}

////////////////////////////////
//  Tests

describe("finding cycles", () => {
	it("finds nothing in a chain", () => {
		expect(findCycles(edges(["a", "b"], ["b", "c"]))).toEqual([]);
	});

	it("finds a two-symbol loop", () => {
		expect(membersOf(findCycles(edges(["a", "b"], ["b", "a"])))).toEqual([["a", "b"]]);
	});

	it("finds a longer loop as one component rather than several", () => {
		const found = findCycles(edges(["a", "b"], ["b", "c"], ["c", "a"]));
		expect(membersOf(found)).toEqual([["a", "b", "c"]]);
	});

	// A symbol sitting alone is not a cycle; one that genuinely calls itself is. Collapsing those
	// two would report every ordinary function as a loop.
	it("tells recursion apart from a symbol merely sitting alone", () => {
		expect(membersOf(findCycles(edges(["a", "a"])))).toEqual([["a"]]);
		expect(findCycles(edges(["a", "b"]))).toEqual([]);
	});

	it("separates two independent loops", () => {
		const found = findCycles(edges(["a", "b"], ["b", "a"], ["x", "y"], ["y", "x"]));
		expect(membersOf(found)).toEqual([
			["a", "b"],
			["x", "y"],
		]);
	});

	it("finds a loop reachable only through a chain", () => {
		const found = findCycles(edges(["start", "a"], ["a", "b"], ["b", "a"]));
		expect(membersOf(found)).toEqual([["a", "b"]]);
	});

	// Written iteratively for exactly this: a recursive Tarjan blows the stack on a real workspace,
	// where a chain thousands of symbols long is ordinary rather than pathological.
	it("survives a chain far deeper than a call stack would allow", () => {
		const deep: Array<[string, string]> = [];
		for (let i = 0; i < 20_000; i++) deep.push([`n${i}`, `n${i + 1}`]);
		deep.push(["n20000", "n0"]);

		const found = findCycles(edges(...deep));
		expect(found).toHaveLength(1);
		expect(found[0]?.members).toHaveLength(20_001);
	});
});
