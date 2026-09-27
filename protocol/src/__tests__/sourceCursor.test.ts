import { describe, expect, it } from "bun:test";
import { coordinatesOf } from "../coordinates.js";
import { SourceCursor } from "../sourceCursor.js";

////////////////////////////////
//  Fixtures

const HOSTILE = [
	"",
	"a",
	"a\nb",
	"a\r\nb\r\n",
	"lone\rreturn\r",
	"\r\r\n\n\r",
	"😀x\n😀\r\n😀",
	`${String.fromCodePoint(0xfeff)}bom\nline`,
	"tab\tform\fvertical\v sep para\u0085next",
	"high\uD800alone\nlow\uDC00alone",
];

////////////////////////////////
//  Tests

describe("SourceCursor", () => {
	it("reports the position coordinatesOf gives at every offset it reaches", () => {
		for (const text of HOSTILE) {
			const coordinates = coordinatesOf(text);
			const cursor = new SourceCursor(text);
			const seen: unknown[] = [];
			const expected: unknown[] = [];
			for (;;) {
				seen.push({ offset: cursor.offset, ...cursor.position });
				expected.push({ offset: cursor.offset, ...coordinatesOf(text).positionAt(cursor.offset) });
				if (!cursor.good()) break;
				cursor.next();
			}
			expect({ text, seen }).toEqual({ text, seen: expected });
			expect(cursor.offset).toBe(text.length);
			expect(coordinates.lineCount()).toBe(cursor.line + 1);
		}
	});

	it("starts mid-text at that offset's position, reads whole code points, and rewinds line and column", () => {
		const text = "ab\n😀c\nd";
		const cursor = new SourceCursor(text, 3);
		expect(cursor.position).toEqual({ line: 1, character: 0 });
		const mark = cursor.mark();
		expect(cursor.next()).toBe("😀");
		expect(cursor.position).toEqual({ line: 1, character: 2 });
		expect(cursor.readWhile((character) => character !== "\n")).toBe("c");
		expect(cursor.take("\nd")).toBe(true);
		expect(cursor.span(mark)).toEqual({
			startOffset: 3,
			endOffset: 8,
			start: { line: 1, character: 0 },
			end: { line: 2, character: 1 },
		});
		cursor.rewind(mark);
		expect({ offset: cursor.offset, ...cursor.position }).toEqual({ offset: 3, line: 1, character: 0 });
		expect(cursor.take("😀d")).toBe(false);
		expect(cursor.offset).toBe(3);
	});

	it("never reads past its end", () => {
		const cursor = new SourceCursor("ab😀cd", 0, 3);
		expect(cursor.readWhile(() => true)).toBe("ab\uD83D");
		expect(cursor.good()).toBe(false);
		expect(cursor.peek()).toBe("");
		expect(cursor.next()).toBe("");
	});
});
