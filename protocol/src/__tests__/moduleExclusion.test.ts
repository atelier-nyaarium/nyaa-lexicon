import { describe, expect, it } from "bun:test";
import { exclusionConfirmed } from "../daemonMethods";
import { compileExclusion, globToRegExp, ModuleExclusionSchema } from "../moduleExclusion";

////////////////////////////////
//  Tests

describe("one exclusion matcher", () => {
	const hidden = (modules: string[], exclusion: Parameters<typeof compileExclusion>[0]) =>
		modules.filter(compileExclusion(exclusion));

	it("hides by glob in any case, and keeps what a keep glob carves back out", () => {
		const modules = [".env", "app/.ENV.local", ".env.example", "APP/.Env.Example", "src/env.ts"];
		expect(hidden(modules, { hide: ["**/.env*"], keep: ["**/.env.example"] })).toEqual([".env", "app/.ENV.local"]);
	});

	it("shows an allowed module only when it is spelled exactly, in the id grammar's key", () => {
		const exclusion = ModuleExclusionSchema.parse({ hide: ["**/.env*"], allow: ["./config/.env"] });
		expect(exclusion.allow).toEqual(["config/.env"]);
		expect(hidden(["config/.env", "config/.ENV", "./config/.env", ".env"], exclusion)).toEqual([
			"config/.ENV",
			".env",
		]);
	});

	it("hides a path the id grammar cannot spell", () => {
		expect(hidden(["../.env", "/etc/passwd"], { hide: ["nothing"] })).toEqual(["../.env", "/etc/passwd"]);
	});

	it("bounds what a request may carry", () => {
		expect(ModuleExclusionSchema.safeParse({ hide: [] }).success).toBe(false);
		expect(ModuleExclusionSchema.safeParse({ hide: Array.from({ length: 65 }, () => "*") }).success).toBe(false);
		expect(ModuleExclusionSchema.safeParse({ hide: ["*"], allow: ["../outside"] }).success).toBe(false);
	});

	it("matches case-sensitively unless asked", () => {
		expect(globToRegExp("src/*.TS").test("src/a.ts")).toBe(false);
		expect(globToRegExp("src/*.TS", "i").test("src/a.ts")).toBe(true);
	});
});

describe("an answer confirming its exclusion", () => {
	const exclude = { hide: ["**/.env"] };

	it("is required only of a method that takes one, and only when one was asked", () => {
		expect(exclusionConfirmed("overview", { exclude }, {})).toBe(true);
		expect(exclusionConfirmed("findDocs", {}, { query: {} })).toBe(true);
		expect(exclusionConfirmed("findDocs", { exclude }, { query: {} })).toBe(false);
		expect(exclusionConfirmed("findDocs", { exclude }, null)).toBe(false);
	});

	it("reads the echo where each method writes it", () => {
		expect(exclusionConfirmed("findDocs", { exclude }, { query: { excluded: true } })).toBe(true);
		expect(exclusionConfirmed("searchSymbols", { exclude }, { excluded: true })).toBe(true);
		expect(exclusionConfirmed("findImports", { exclude }, { query: {}, excluded: true })).toBe(true);
	});

	it("needs the echo on every row of an array answer, and none on an empty one", () => {
		const row = { value: "sk-a", kind: "string", files: 2, uses: 2 };
		expect(exclusionConfirmed("sharedLiterals", { exclude }, [{ ...row, excluded: true }])).toBe(true);
		expect(exclusionConfirmed("sharedLiterals", { exclude }, [{ ...row, excluded: true }, row])).toBe(false);
		expect(exclusionConfirmed("sharedLiterals", { exclude }, [])).toBe(true);
	});
});
