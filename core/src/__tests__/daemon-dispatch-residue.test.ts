import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { callsTo, memberCalls, memberReads, parseSource, usesName } from "@nyaa-lexicon/protocol/ast";
import type ts from "typescript";

const ROOT = path.join(import.meta.dirname, "..", "..", "..");

function coreSources(): string[] {
	const files = readdirSync(path.join(ROOT, "core", "src"), { recursive: true })
		.filter((file): file is string => typeof file === "string" && file.endsWith(".ts"))
		.filter((file) => !file.includes("__tests__/"));
	expect(files.length).toBeGreaterThan(0);
	return files;
}

const parsed = (file: string) => parseSource(file, readFileSync(file, "utf8")).source;

/** `x.parse(params ...)`: a request's params parsed against a schema. */
function parsesParams(source: ts.SourceFile): boolean {
	return memberCalls(source, ["parse"]).some(({ node }) => {
		const first = (node.parent as ts.CallExpression).arguments[0];
		return first !== undefined && usesName(first, "params");
	});
}

describe("the daemon wire has one owner", () => {
	/**
	 * Bug class killed: a request or response shape declared beside its handler, drifting from the
	 * table a client types against. Dispatch builds no schema, and the generic entry is the one
	 * place a request is parsed.
	 */
	it("keeps daemon schemas and parsing out of dispatch", () => {
		const dispatch = parsed(path.join(ROOT, "core", "src", "dispatch.ts"));
		expect(memberReads(dispatch).filter(({ receiver }) => receiver === "z")).toEqual([]);

		const matches = coreSources().filter((file) => parsesParams(parsed(path.join(ROOT, "core", "src", file))));
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
			const source = parsed(path.join(ROOT, "protocol", "src", file));
			expect(callsTo(source, "any", "z"), file).toEqual([]);
			expect(callsTo(source, "unknown", "z"), file).toEqual([]);
		}
	});
});
