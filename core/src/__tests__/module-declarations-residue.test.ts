import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { codeOnly } from "@nyaa-lexicon/protocol";

/**
 * `moduleDeclarations` answers one snapshot: the read, both hashes, the failure and the rows. That
 * holds only while the module runs to completion, so no `await` and no `async` may enter it.
 */
const MODULE = path.join(import.meta.dirname, "..", "moduleDeclarations.ts");

describe("the module snapshot runs to completion", () => {
	it("reads a real module, so a passing run is never vacuous", () => {
		expect(readFileSync(MODULE, "utf8").length).toBeGreaterThan(200);
	});

	it("holds no await and no async", () => {
		const code = codeOnly(readFileSync(MODULE, "utf8"));
		const offenders = ["await", "async"].filter((token) => new RegExp(`\\b${token}\\b`).test(code));

		expect(offenders, "a suspension point lets a watcher batch land between the read and the rows").toEqual([]);
	});
});
