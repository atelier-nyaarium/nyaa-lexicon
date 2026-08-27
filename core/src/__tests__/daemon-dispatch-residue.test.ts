import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.join(import.meta.dirname, "..", "..", "..");

function coreSources(): string[] {
	const files = readdirSync(path.join(ROOT, "core", "src"), { recursive: true })
		.filter((file): file is string => typeof file === "string" && file.endsWith(".ts"))
		.filter((file) => !file.includes("__tests__/"));
	expect(files.length).toBeGreaterThan(0);
	return files;
}

describe("the daemon wire has one owner", () => {
	/**
	 * Bug class killed: a request or response shape declared beside its handler, drifting from the
	 * table a client types against. Dispatch builds no schema, and the generic entry is the one
	 * place a request is parsed.
	 */
	it("keeps daemon schemas and parsing out of dispatch", () => {
		const dispatch = readFileSync(path.join(ROOT, "core", "src", "dispatch.ts"), "utf8");
		expect(dispatch).not.toContain("z.");

		const matches = coreSources().filter((file) =>
			readFileSync(path.join(ROOT, "core", "src", file), "utf8").includes(".parse(params"),
		);
		expect(matches).toEqual(["dispatch.ts"]);
	});

	/**
	 * Bug class killed: an answer typed as anything, which validates every shape and names none.
	 * A field core emits that the table forgot is then stripped on the wire without a failure.
	 */
	it("names every field the daemon answers with", () => {
		const files = ["daemonMethods.ts", "daemonShapes.ts"];
		expect(files.length).toBeGreaterThan(0);
		for (const file of files) {
			const source = readFileSync(path.join(ROOT, "protocol", "src", file), "utf8");
			expect(source, file).not.toContain("z.any(");
			expect(source, file).not.toContain("z.unknown(");
		}
	});
});
