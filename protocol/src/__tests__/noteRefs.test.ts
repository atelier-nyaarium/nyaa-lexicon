import { describe, expect, it } from "bun:test";
import { findRefLinks, findRefs, formatRef, parseRef } from "../noteRefs";

describe("finding refs in a note", () => {
	it("finds written links anywhere in prose, and nothing in code or bare text", () => {
		const text = [
			"Wraps [Cart](ref://src/cart.ts:Cart) mid-sentence, and [add](<ref://src/a b.ts:add>).",
			"A bare ref://src/cart.ts:Cart is text, and so is `[x](ref://src/code.ts:X)`.",
			"```ts",
			"[y](ref://src/fenced.ts:Y)",
			"```",
			"An unclosed `` run leaves [z](ref://src/z.ts:Z) a link` too.",
		].join("\n");
		expect(findRefs(text).map((found) => found.ref)).toEqual([
			"ref://src/cart.ts:Cart",
			"ref://src/a b.ts:add",
			"ref://src/z.ts:Z",
		]);
	});

	it("scans text in time linear in its length, however its brackets, backticks and backslashes fall", () => {
		const shapes: Record<string, (length: number) => string> = {
			"closes with no label": (length) => "](ref://a)".repeat(length / 10),
			"bare destinations with no close": (length) => "](ref://a".repeat(length / 9),
			"angled destinations with no close": (length) => "](<ref://a".repeat(length / 10),
			"backslashes inside a label": (length) => `[${"\\".repeat(length)}](ref://a)`,
			"backtick runs of rising length": (length) => {
				let text = "";
				for (let run = 1; text.length < length; run++) text += `${"`".repeat(run)}a`;
				return text;
			},
		};
		const timed = (text: string) => {
			let best = Number.POSITIVE_INFINITY;
			for (let round = 0; round < 3; round++) {
				const started = performance.now();
				findRefs(text);
				best = Math.min(best, performance.now() - started);
			}
			return best;
		};
		// Linear reads scale 8x; a walk back per link, or a rescan per backtick run, scales 64x.
		for (const [shape, text] of Object.entries(shapes)) {
			expect(timed(text(128_000)) / timed(text(16_000)), shape).toBeLessThan(24);
		}
	});

	it("points at the ref itself in the angle form, and skips escaped brackets and wrapped code spans", () => {
		const text =
			"See [a](<ref://src/a b.ts:A>), \\[b\\](ref://src/b.ts:B), \\[d](ref://src/d.ts:D) and `wrapped\n[c](ref://src/c.ts:C)` here.";
		const found = findRefs(text);
		expect(found.map((entry) => entry.ref)).toEqual(["ref://src/a b.ts:A"]);
		const [first] = found;
		expect(text.slice(first?.index, (first?.index ?? 0) + (first?.ref.length ?? 0))).toBe("ref://src/a b.ts:A");
	});

	it("never lets a code span cross a blank line, LF or CRLF", () => {
		for (const blank of ["\n\n", "\r\n\r\n"]) {
			expect(findRefs(`An open \`tick.${blank}[Cart](ref://a.ref:Cart) and \` later.`).map((f) => f.ref)).toEqual(
				["ref://a.ref:Cart"],
			);
		}
	});

	it("spans each written link whole, bracketed and escaped labels included, and no mermaid click", () => {
		const text = [
			'See [string[]](ref://a.ts:S), [a [b] c](<ref://a.ts:A> "t") and [x \\] y](ref://a.ts:X).',
			"`[z](ref://a.ts:Z)`",
			"```mermaid",
			'  click A "ref://a.ts:M"',
			"```",
		].join("\n");
		expect(findRefLinks(text).map((link) => [text.slice(link.from, link.to), link.label, link.ref])).toEqual([
			["[string[]](ref://a.ts:S)", "string[]", "ref://a.ts:S"],
			['[a [b] c](<ref://a.ts:A> "t")', "a [b] c", "ref://a.ts:A"],
			["[x \\] y](ref://a.ts:X)", "x \\] y", "ref://a.ts:X"],
		]);
	});

	it("finds a mermaid click line and points at the ref itself", () => {
		const text =
			'```mermaid\ngraph TD\n  A-->B\n  click A "ref://src/a.ts:A"\n  click B href "ref://src/b.ts:B"\n```';
		const found = findRefs(text);
		expect(found.map((entry) => entry.ref)).toEqual(["ref://src/a.ts:A", "ref://src/b.ts:B"]);
		for (const entry of found) expect(text.slice(entry.index, entry.index + entry.ref.length)).toBe(entry.ref);
	});
});

describe("parsing a ref", () => {
	it("splits a module and its chain, keeping a qualifier whole", () => {
		expect(parseRef("ref://src/engine.cpp:Physics::World:step")).toEqual({
			ok: true,
			ref: { module: "src/engine.cpp", segments: ["Physics::World", "step"] },
		});
		expect(parseRef("ref://README.md")).toEqual({ ok: true, ref: { module: "README.md", segments: [] } });
	});

	it("refuses text anchors, absolute paths and empty segments", () => {
		for (const ref of ["ref://src/a.ts:A#text", "ref:///etc/hosts", "ref://~/x.ts", "ref://src/a.ts:A:"]) {
			expect(parseRef(ref).ok, ref).toBe(false);
		}
	});

	it("formats what it parses back to the same module and chain, colons and hashes in a path included", () => {
		for (const [module, segments] of [
			["src/a b.ts", ["Cart", "add"]],
			["src/a:b#1.ts", []],
			["src/a(b.ts", []],
			["lib/x (y).rs", ["Physics::World", "step"]],
		] as const) {
			expect(parseRef(formatRef(module, segments))).toEqual({
				ok: true,
				ref: { module, segments: [...segments] },
			});
		}
	});
});
