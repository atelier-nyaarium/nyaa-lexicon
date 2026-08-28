import { describe, expect, it } from "bun:test";
import { coordinatesOf } from "../coordinates";

const ASTRAL = "\u{1F600}";

describe("addressing a position", () => {
	it("refuses a character past the end of its line instead of clamping", () => {
		const at = coordinatesOf("ab\ncd\n");

		expect(at.offsetAt({ line: 0, character: 2 })).toBe(2);
		expect(at.offsetAt({ line: 0, character: 3 })).toBeUndefined();
		expect(at.offsetAt({ line: 0, character: 99 })).toBeUndefined();
	});

	it("refuses a negative character, which arithmetic produces and slice would absorb", () => {
		const at = coordinatesOf("ab\n");

		expect(at.offsetAt({ line: 0, character: -1 })).toBeUndefined();
		expect(at.positionAt(-1)).toBeUndefined();
	});

	it("refuses a line the text does not have", () => {
		expect(coordinatesOf("ab").offsetAt({ line: 1, character: 0 })).toBeUndefined();
	});

	it("addresses the empty line a trailing newline creates", () => {
		const at = coordinatesOf("ab\n");

		expect(at.offsetAt({ line: 1, character: 0 })).toBe(3);
		expect(at.positionAt(3)).toEqual({ line: 1, character: 0 });
	});

	it("addresses the end of a line, since that is where an insertion goes", () => {
		expect(coordinatesOf("ab\ncd").offsetAt({ line: 1, character: 2 })).toBe(5);
	});

	// A line terminator is not content. Allowing a position between them let an edit split the
	// pair, producing a file with a stray carriage return that nothing reads back.
	it("does not let a position land between a carriage return and its newline", () => {
		const at = coordinatesOf("ab\r\ncd");

		expect(at.offsetAt({ line: 0, character: 2 })).toBe(2);
		expect(at.offsetAt({ line: 0, character: 3 })).toBeUndefined();
	});

	it("counts UTF-16 code units, matching the position contract the suite pins", () => {
		const at = coordinatesOf(`${ASTRAL}x`);

		expect(at.offsetAt({ line: 0, character: 2 })).toBe(2);
		expect(at.sliceRange({ start: { line: 0, character: 0 }, end: { line: 0, character: 2 } })).toBe(ASTRAL);
	});

	it("round-trips every offset in a text with mixed line endings", () => {
		const text = "one\ntwo\r\nthree\n";
		const at = coordinatesOf(text);

		for (let offset = 0; offset <= text.length; offset++) {
			const position = at.positionAt(offset);
			if (position === undefined) throw new Error(`no position for offset ${offset}`);
			// A position inside a terminator is not addressable, so only content round-trips.
			const back = at.offsetAt(position);
			if (back !== undefined) expect(back).toBe(offset);
		}
	});

	// The lookup is a binary search, where an off-by-one shows up only at a line boundary and only
	// in a text with enough lines for the halving to matter.
	it("finds the same line a plain scan would, at every offset of a many-line text", () => {
		// Starts come from how the fixture was BUILT, never from re-reading the text, so the oracle
		// is independent of the thing under test and of the owner it belongs to.
		const lines: string[] = [];
		const starts: number[] = [];
		let cursor = 0;
		for (let index = 0; index < 500; index++) {
			const line = index % 7 === 0 ? "" : `line ${index}`;
			starts.push(cursor);
			lines.push(line);
			cursor += line.length + 1;
		}
		const text = lines.join("\n");
		const at = coordinatesOf(text);

		for (let offset = 0; offset <= text.length; offset++) {
			let expected = 0;
			for (let line = starts.length - 1; line >= 0; line--) {
				if ((starts[line] as number) <= offset) {
					expected = line;
					break;
				}
			}
			expect(at.positionAt(offset), `offset ${offset}`).toEqual({
				line: expected,
				character: offset - (starts[expected] as number),
			});
		}
	});

	it("refuses a range that runs backwards", () => {
		const at = coordinatesOf("abcd");
		expect(
			at.offsetsForRange({ start: { line: 0, character: 3 }, end: { line: 0, character: 1 } }),
		).toBeUndefined();
	});

	it("slices exactly the range asked for, across lines", () => {
		expect(
			coordinatesOf("ab\ncd\n").sliceRange({ start: { line: 0, character: 1 }, end: { line: 1, character: 1 } }),
		).toBe("b\nc");
	});

	it("answers one line's content without its terminator, and refuses absent lines", () => {
		const at = coordinatesOf("ab\r\ncd\n");

		expect(at.lineText(0)).toBe("ab");
		expect(at.lineText(1)).toBe("cd");
		expect(at.lineText(2)).toBe("");
		expect(at.lineText(3)).toBeUndefined();
		expect(at.lineCount()).toBe(3);
	});
});
