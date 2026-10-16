import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	discoverCompileDatabases,
	discoverIncludeDirectories,
	findWorkspaceInclude,
	forcedIncludeDirectories,
	includeSearchDirectories,
} from "../includeSearch.js";
import { readPolicy } from "../readPolicy.js";
import { secretWire } from "./secretWire.js";

function workspace(run: (root: string) => void): void {
	const root = mkdtempSync(path.join(os.tmpdir(), "lexicon-include-search-"));
	try {
		run(root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

describe("include search primitives", () => {
	test("finds the root database and build databases in name order", () => {
		workspace((root) => {
			mkdirSync(path.join(root, "build-z"));
			mkdirSync(path.join(root, "build-a"));
			mkdirSync(path.join(root, "other"));
			for (const name of [
				"compile_commands.json",
				"build-z/compile_commands.json",
				"build-a/compile_commands.json",
				"other/compile_commands.json",
			])
				writeFileSync(path.join(root, name), "[]");

			expect(discoverCompileDatabases(root)).toEqual([
				path.join(root, "compile_commands.json"),
				path.join(root, "build-a/compile_commands.json"),
				path.join(root, "build-z/compile_commands.json"),
			]);
		});
	});

	test("walks permitted include directories and honors exclusions and read policy", () => {
		workspace((root) => {
			for (const name of ["include", "src/include", ".git/include", "private/include"])
				mkdirSync(path.join(root, name), { recursive: true });
			const policy = readPolicy(root, secretWire(["private/**"]));

			expect(discoverIncludeDirectories(root, { anywhere: [".git"] }, policy)).toEqual([
				path.join(root, "include"),
				path.join(root, "src/include"),
			]);
		});
	});

	test("orders quoted, angle, fallback, and forced searches", () => {
		const root = "/workspace";
		const fallback = ["/workspace/include", root];
		const search = {
			includerDirectory: true,
			quote: ["/quote"],
			user: ["/user"],
			system: ["/system"],
			after: ["/after"],
		};

		expect(includeSearchDirectories(root, fallback, search, "src/unit.c", "quoted")).toEqual([
			"/workspace/src",
			"/quote",
			"/user",
			"/system",
			"/after",
		]);
		expect(includeSearchDirectories(root, fallback, search, "src/unit.c", "angle")).toEqual([
			"/user",
			"/system",
			"/after",
		]);
		expect(includeSearchDirectories(root, fallback, undefined, "src/unit.c", "quoted")).toEqual([
			"/workspace/src",
			...fallback,
		]);
		expect(includeSearchDirectories(root, fallback, undefined, "src/unit.c", "angle")).toEqual(fallback);
		expect(forcedIncludeDirectories("/build", search)).toEqual(["/build", "/quote", "/user", "/system", "/after"]);
	});

	test("skips denied candidates and reports outside files", () => {
		workspace((root) => {
			mkdirSync(path.join(root, "private"));
			mkdirSync(path.join(root, "include"));
			writeFileSync(path.join(root, "private/api.h"), "");
			writeFileSync(path.join(root, "include/api.h"), "");
			const outside = mkdtempSync(path.join(os.tmpdir(), "lexicon-outside-"));
			try {
				writeFileSync(path.join(outside, "api.h"), "");
				expect(
					findWorkspaceInclude(
						root,
						readPolicy(root, secretWire(["private/**"])),
						[path.join(root, "private"), path.join(root, "include")],
						"api.h",
					),
				).toEqual({ module: "include/api.h" });
				expect(findWorkspaceInclude(root, readPolicy(root, secretWire()), [outside], "api.h")).toEqual({
					outside: true,
				});
			} finally {
				rmSync(outside, { recursive: true, force: true });
			}
		});
	});
});
