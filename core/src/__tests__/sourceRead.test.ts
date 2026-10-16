import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { hashContent } from "@nyaa-lexicon/protocol";
import {
	type AllowedView,
	fromText,
	MAX_SOURCE_BYTES,
	type PlainView,
	readSource,
	unreadableReason,
	writableSource,
} from "../sourceRead";
import { readingPolicy } from "./reads";

let root: string;

/** Read view with no project rules. */
const viewed = (read: ReturnType<typeof readSource>) => readingPolicy.view(read);

const plain = (text: string, lossless = true): PlainView => ({
	kind: "plain",
	text,
	hash: hashContent(text),
	lossless,
});

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

		expect(viewed(readSource(root, "a.ts"))).toEqual(plain("export const a = 1;\n"));
		expect(viewed(readSource(root, "gone.ts"))).toEqual({ kind: "missing" });
		expect(viewed(readSource(root, "dir"))).toEqual({ kind: "missing" });
	});

	// Git's heuristic: a NUL in the head.
	it("calls a file with a NUL in its head binary, and one past the limit too large", () => {
		writeFileSync(path.join(root, "blob.json"), Buffer.from([0x7b, 0x00, 0x7d]));
		writeFileSync(path.join(root, "big.yml"), Buffer.alloc(MAX_SOURCE_BYTES + 1, 0x61));
		writeFileSync(path.join(root, "edge.yml"), Buffer.alloc(MAX_SOURCE_BYTES, 0x61));

		expect(readSource(root, "blob.json")).toMatchObject({ kind: "binary" });
		expect(readSource(root, "big.yml")).toMatchObject({ kind: "tooLarge", bytes: MAX_SOURCE_BYTES + 1 });
		expect(readSource(root, "edge.yml").kind).toBe("text");
	});

	it("words each refusal once, with the number a reader can act on", () => {
		expect(unreadableReason({ kind: "binary" })).toMatch(/NUL/);
		expect(unreadableReason({ kind: "tooLarge", bytes: 5_000_000 })).toContain("5000000 bytes");
		expect(unreadableReason({ kind: "tooLarge", bytes: 5_000_000 })).toContain(String(MAX_SOURCE_BYTES));
	});

	it("lifts a text-only reader to the full shape", () => {
		const lifted = fromText((module) => (module === "a.ts" ? "text" : module === "lone.ts" ? "\uD800" : null));
		expect(viewed(lifted("a.ts"))).toEqual(plain("text"));
		expect(viewed(lifted("lone.ts"))).toMatchObject({ kind: "plain", lossless: false });
		expect(viewed(lifted("b.ts"))).toEqual({ kind: "missing" });
	});

	it("decodes an invalid sequence leniently and says the decode was lossy", () => {
		writeFileSync(path.join(root, "lossy.ts"), Buffer.from([0x61, 0xc3, 0x28, 0x62, 0x0a]));
		writeFileSync(path.join(root, "truncated.ts"), Buffer.from([0x61, 0xf0, 0x9f, 0x98, 0x41]));
		writeFileSync(path.join(root, "bom.ts"), Buffer.from([0xef, 0xbb, 0xbf, 0x61, 0x0a]));
		writeFileSync(path.join(root, "wide.ts"), "// caf\u{E9} \u{2713} \u{FFFD} \u{1F600}\n");

		expect(viewed(readSource(root, "lossy.ts"))).toEqual(plain("a\u{FFFD}(b\n", false));
		// Equal length does not imply lossless decoding.
		expect(viewed(readSource(root, "truncated.ts"))).toMatchObject({ kind: "plain", lossless: false });
		expect(viewed(readSource(root, "bom.ts"))).toEqual(plain("\u{FEFF}a\n"));
		expect(viewed(readSource(root, "wide.ts"))).toMatchObject({ kind: "plain", lossless: true });
	});
});

describe("reading a workspace file for a writer", () => {
	it("answers lossless text, null for nothing on disk, and a refusal naming the module otherwise", () => {
		expect(writableSource("a.ts", plain("a"))).toEqual({ text: "a" });
		expect(writableSource("a.ts", { kind: "missing" })).toEqual({ text: null });
		const refused: AllowedView[] = [
			plain("a\u{FFFD}", false),
			{ kind: "refused", hash: "h" },
			{ kind: "binary" },
			{ kind: "tooLarge", bytes: MAX_SOURCE_BYTES + 1 },
			{ kind: "outside" },
		];
		for (const view of refused) {
			expect(writableSource("a.ts", view)).toEqual({ refused: expect.stringContaining("a.ts") });
		}
	});
});
