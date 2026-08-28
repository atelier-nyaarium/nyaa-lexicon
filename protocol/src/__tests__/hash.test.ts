import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { hashContent } from "../hash";

describe("hashContent", () => {
	it("is the first 32 hex characters of the sha256 of the decoded text", () => {
		const text = "export const a = 1;\n";
		expect(hashContent(text)).toBe(createHash("sha256").update(text, "utf8").digest("hex").slice(0, 32));
		expect(hashContent(text)).toMatch(/^[0-9a-f]{32}$/);
	});

	it("keeps a BOM and line endings as part of the text", () => {
		expect(hashContent("﻿a\n")).not.toBe(hashContent("a\n"));
		expect(hashContent("a\r\nb")).not.toBe(hashContent("a\nb"));
	});

	it("equals a hash of the raw bytes exactly when they are valid UTF-8", () => {
		const bytes = Buffer.from("café \u{1F600}\n", "utf8");
		expect(hashContent(bytes.toString("utf8"))).toBe(createHash("sha256").update(bytes).digest("hex").slice(0, 32));

		const invalid = Buffer.from([0x61, 0xff, 0x62]);
		expect(hashContent(invalid.toString("utf8"))).not.toBe(
			createHash("sha256").update(invalid).digest("hex").slice(0, 32),
		);
	});
});
