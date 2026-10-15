import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { atomicWriteJson, atomicWriteTempTarget } from "../atomicJson.js";
import { pruneReports, SELF_REPORT } from "../diagnostics.js";

const roots: string[] = [];

function scratch(): string {
	const root = mkdtempSync(path.join(tmpdir(), "lexicon-atomic-json-"));
	roots.push(root);
	return root;
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("atomic JSON writes", () => {
	it("writes compact or pretty JSON and removes its temporary file", () => {
		const dir = scratch();
		const file = path.join(dir, "state.json");

		atomicWriteJson(file, { state: "fresh" });
		expect(readFileSync(file, "utf8")).toBe('{"state":"fresh"}');
		expect(readdirSync(dir)).toEqual(["state.json"]);

		atomicWriteJson(file, { state: "complete" }, { space: 2 });
		expect(readFileSync(file, "utf8")).toBe(`{
  "state": "complete"
}`);
		expect(readdirSync(dir)).toEqual(["state.json"]);
	});

	it("recognizes its temporary name while rejecting other temp files", () => {
		const target = "report.1.json";
		const temporary = `${target}.42.123e4567-e89b-12d3-a456-426614174000.tmp`;

		expect(atomicWriteTempTarget(temporary)).toBe(target);
		expect(atomicWriteTempTarget(`${target}.tmp`)).toBeUndefined();
		expect(atomicWriteTempTarget(`${target}.42.not-a-uuid.tmp`)).toBeUndefined();
	});

	it("prunes a leftover report written with the shared temporary name", () => {
		const dir = scratch();
		const temporary = `${SELF_REPORT}.42.123e4567-e89b-12d3-a456-426614174000.tmp`;
		writeFileSync(path.join(dir, temporary), "");

		expect(pruneReports(dir)).toEqual([temporary]);
		expect(readdirSync(dir)).toEqual([]);
	});
});
