import { describe, expect, it } from "bun:test";
import { DAEMON_METHODS } from "../daemonMethods";

/** Every request field that names a module, with a request that is otherwise valid. */
const PATH_FIELDS: Array<[keyof typeof DAEMON_METHODS, string, Record<string, unknown>]> = [
	["moduleDeclarations", "module", {}],
	["indexFile", "module", {}],
	["refactorTrack", "module", {}],
	["planMove", "toModule", { symbolId: "x" }],
	["findComments", "module", { text: "a" }],
	["findDocs", "module", { text: "a" }],
	["resolveImport", "fromModule", { specifier: "./a" }],
	["refactorInsert", "module", { text: "a" }],
	["coChangedWith", "module", {}],
	["findByName", "module", { name: "a" }],
	["knowledgeGaps", "module", {}],
	["findImports", "module", {}],
];

/** Absolute, escaping, and a control character, built at runtime so the file itself stays clean. */
const OUTSIDE = ["../secret.md", "src/../../secret.md", "/etc/passwd", `a${String.fromCharCode(0)}b`];

describe("a module on the wire is the one key the index files under", () => {
	it.each(
		PATH_FIELDS,
	)("%s.%s is normalized, and an escape is refused in the grammar's words", (method, field, rest) => {
		const request = DAEMON_METHODS[method].request;

		expect(request.parse({ ...rest, [field]: "./src/./a.ts" })).toMatchObject({ [field]: "src/a.ts" });
		expect(request.parse({ ...rest, [field]: "src\\a.ts" })).toMatchObject({ [field]: "src/a.ts" });
		expect(request.parse({ ...rest, [field]: "café.ts" })).toMatchObject({ [field]: "café.ts" });

		for (const outside of OUTSIDE) {
			const refused = request.safeParse({ ...rest, [field]: outside });
			expect(refused.success, JSON.stringify(outside)).toBe(false);
			if (refused.success) continue;
			expect(refused.error.issues[0]?.message).toMatch(/module path must/);
		}
	});

	it("keeps an optional module field optional, and a required one required", () => {
		expect(DAEMON_METHODS.findByName.request.parse({ name: "a" })).toEqual({ name: "a" });
		expect(DAEMON_METHODS.findComments.request.parse({ text: "a" })).toEqual({ text: "a" });
		expect(DAEMON_METHODS.findDocs.request.parse({ text: "a" })).toEqual({ text: "a" });
		expect(DAEMON_METHODS.knowledgeGaps.request.parse({})).toEqual({});
		expect(DAEMON_METHODS.findImports.request.parse({})).toEqual({});
		expect(DAEMON_METHODS.refactorInsert.request.parse({ after: "x", text: "a" })).toEqual({
			after: "x",
			text: "a",
		});

		for (const method of ["moduleDeclarations", "indexFile", "refactorTrack", "coChangedWith"] as const) {
			const refused = DAEMON_METHODS[method].request.safeParse({});
			expect(refused.success, method).toBe(false);
			if (!refused.success) expect(refused.error.issues.map((issue) => issue.path.join("."))).toContain("module");
		}
	});

	it("leaves filters that are not paths alone", () => {
		expect(DAEMON_METHODS.searchSymbols.request.parse({ text: "a", within: "../outside" })).toMatchObject({
			within: "../outside",
		});
		expect(DAEMON_METHODS.findImports.request.parse({ moduleRegex: "^\\.\\./" })).toMatchObject({
			moduleRegex: "^\\.\\./",
		});
	});
});
