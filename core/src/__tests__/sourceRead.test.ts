import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fromText, MAX_SOURCE_BYTES, readSource, textOf, unreadableReason, writableSource } from "../sourceRead";

let root: string;

beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), "lexicon-read-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("reading a workspace file for indexing", () => {
	it("answers text for a text file, and missing for what is not a file", () => {
		writeFileSync(path.join(root, "a.ts"), "export const a = 1;\n");
		mkdirSync(path.join(root, "dir"));

		expect(readSource(root, "a.ts")).toEqual({ kind: "text", text: "export const a = 1;\n", lossless: true });
		expect(readSource(root, "gone.ts")).toEqual({ kind: "missing" });
		expect(readSource(root, "dir")).toEqual({ kind: "missing" });
	});

	// Git's heuristic: a NUL in the head.
	it("calls a file with a NUL in its head binary, and one past the limit too large", () => {
		writeFileSync(path.join(root, "blob.json"), Buffer.from([0x7b, 0x00, 0x7d]));
		writeFileSync(path.join(root, "big.yml"), Buffer.alloc(MAX_SOURCE_BYTES + 1, 0x61));
		writeFileSync(path.join(root, "edge.yml"), Buffer.alloc(MAX_SOURCE_BYTES, 0x61));

		expect(readSource(root, "blob.json")).toEqual({ kind: "binary" });
		expect(readSource(root, "big.yml")).toEqual({ kind: "tooLarge", bytes: MAX_SOURCE_BYTES + 1 });
		expect(readSource(root, "edge.yml").kind).toBe("text");
	});

	it("words each refusal once, with the number a reader can act on", () => {
		expect(unreadableReason({ kind: "binary" })).toMatch(/NUL/);
		expect(unreadableReason({ kind: "tooLarge", bytes: 5_000_000 })).toContain("5000000 bytes");
		expect(unreadableReason({ kind: "tooLarge", bytes: 5_000_000 })).toContain(String(MAX_SOURCE_BYTES));
	});

	it("lifts a text-only reader and lowers a read back to text", () => {
		const lifted = fromText((module) => (module === "a.ts" ? "text" : module === "lone.ts" ? "\uD800" : null));
		expect(lifted("a.ts")).toEqual({ kind: "text", text: "text", lossless: true });
		expect(lifted("lone.ts")).toMatchObject({ kind: "text", lossless: false });
		expect(lifted("b.ts")).toEqual({ kind: "missing" });
		expect(textOf({ kind: "text", text: "t", lossless: false })).toBe("t");
		expect(textOf({ kind: "binary" })).toBeNull();
	});

	it("decodes an invalid sequence leniently and says the decode was lossy", () => {
		writeFileSync(path.join(root, "lossy.ts"), Buffer.from([0x61, 0xc3, 0x28, 0x62, 0x0a]));
		writeFileSync(path.join(root, "truncated.ts"), Buffer.from([0x61, 0xf0, 0x9f, 0x98, 0x41]));
		writeFileSync(path.join(root, "bom.ts"), Buffer.from([0xef, 0xbb, 0xbf, 0x61, 0x0a]));
		writeFileSync(path.join(root, "wide.ts"), "// caf\u{E9} \u{2713} \u{FFFD} \u{1F600}\n");

		expect(readSource(root, "lossy.ts")).toEqual({ kind: "text", text: "a\u{FFFD}(b\n", lossless: false });
		// A lossy decode the same length as its bytes.
		expect(readSource(root, "truncated.ts")).toMatchObject({ kind: "text", lossless: false });
		expect(readSource(root, "bom.ts")).toEqual({ kind: "text", text: "\u{FEFF}a\n", lossless: true });
		expect(readSource(root, "wide.ts")).toMatchObject({ kind: "text", lossless: true });
	});
});

describe("reading a workspace file for a writer", () => {
	it("answers lossless text, null for nothing on disk, and a refusal naming the module otherwise", () => {
		expect(writableSource("a.ts", { kind: "text", text: "a", lossless: true })).toEqual({ text: "a" });
		expect(writableSource("a.ts", { kind: "missing" })).toEqual({ text: null });
		for (const read of [
			{ kind: "text", text: "a\u{FFFD}", lossless: false },
			{ kind: "binary" },
			{ kind: "tooLarge", bytes: MAX_SOURCE_BYTES + 1 },
		] as const) {
			expect(writableSource("a.ts", read)).toEqual({ refused: expect.stringContaining("a.ts") });
		}
	});
});
