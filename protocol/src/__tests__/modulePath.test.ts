import { describe, expect, it } from "bun:test";
import type { z } from "zod";
import { DAEMON_METHODS } from "../daemonMethods";
import { METHOD_SCHEMAS, NOTIFICATION_SCHEMAS } from "../methods";

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
	["scopeSymbols", "module", {}],
	["findImports", "module", {}],
	["searchSymbols", "module", {}],
	["findLiterals", "module", { value: "a" }],
	["findReferences", "module", { symbolId: "x" }],
];

/** Absolute, escaping, and a control character, built at runtime so the file itself stays clean. */
const OUTSIDE = ["../secret.md", "src/../../secret.md", "/etc/passwd", `a${String.fromCharCode(0)}b`];

const PATH_SCHEMA_CASES = [
	[
		"provider project scope",
		METHOD_SCHEMAS.discoverProject.request,
		{ workspaceRoot: "/workspace", scope: ["./src/./a.ts"] },
		{ workspaceRoot: "/workspace", scope: ["src/a.ts"] },
	],
	[
		"provider parse request",
		METHOD_SCHEMAS.parseFile.request,
		{ module: "./src/./a.ts", contentHash: "h", text: "" },
		{ module: "src/a.ts", contentHash: "h", text: "" },
	],
	[
		"provider probe request sharing parse schema",
		METHOD_SCHEMAS.probeFile.request,
		{ module: "./src/./a.ts", contentHash: "h", text: "" },
		{ module: "src/a.ts", contentHash: "h", text: "" },
	],
	[
		"provider probe batch",
		METHOD_SCHEMAS.probeBatch.request,
		{
			files: [{ module: "./src/./a.ts", contentHash: "h", text: "" }],
			answer: ["./src/./a.ts"],
		},
		{ files: [{ module: "src/a.ts", contentHash: "h", text: "" }], answer: ["src/a.ts"] },
	],
	[
		"provider load cycle preview",
		METHOD_SCHEMAS.prepareLoadCyclePreview.request,
		{
			files: [{ module: "./src/./a.ts", base: null, contentHash: "h", text: "" }],
			answer: ["./src/./a.ts"],
		},
		{ files: [{ module: "src/a.ts", base: null, contentHash: "h", text: "" }], answer: ["src/a.ts"] },
	],
	[
		"provider import resolution",
		METHOD_SCHEMAS.resolveImport.request,
		{ fromModule: "./src/./a.ts", specifier: "./b" },
		{ fromModule: "src/a.ts", specifier: "./b" },
	],
	[
		"provider bind",
		METHOD_SCHEMAS.bind.request,
		{
			module: "./src/./a.ts",
			range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
			name: "a",
		},
		{ module: "src/a.ts", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, name: "a" },
	],
	[
		"provider type lookup",
		METHOD_SCHEMAS.typeOf.request,
		{ module: "./src/./a.ts", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } },
		{ module: "src/a.ts", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } },
	],
	[
		"provider rename edits",
		METHOD_SCHEMAS.renameEdits.request,
		{ module: "./src/./a.ts", text: "", oldName: "a", newName: "b", sites: [] },
		{ module: "src/a.ts", text: "", oldName: "a", newName: "b", sites: [] },
	],
	[
		"provider move edits and nested origin",
		METHOD_SCHEMAS.moveEdits.request,
		{
			module: "./src/./a.ts",
			text: "",
			exists: true,
			symbolId: "id",
			name: "a",
			fromModule: "./src/./a.ts",
			toModule: "./src/./b.ts",
			role: {},
			importSites: [],
			dependencies: [
				{ name: "b", origin: { kind: "workspaceModule", symbolId: "other", module: "./lib/./b.ts" } },
			],
			sites: [],
		},
		{
			module: "src/a.ts",
			text: "",
			exists: true,
			symbolId: "id",
			name: "a",
			fromModule: "src/a.ts",
			toModule: "src/b.ts",
			role: {},
			importSites: [],
			dependencies: [{ name: "b", origin: { kind: "workspaceModule", symbolId: "other", module: "lib/b.ts" } }],
			sites: [],
		},
	],
	[
		"provider arrange edits",
		METHOD_SCHEMAS.arrangeEdits.request,
		{
			module: "./src/./a.ts",
			text: "",
			exists: true,
			fromModule: "./src/./a.ts",
			toModule: "./src/./b.ts",
			members: [],
			importSites: [],
			dependencies: [],
		},
		{
			module: "src/a.ts",
			text: "",
			exists: true,
			fromModule: "src/a.ts",
			toModule: "src/b.ts",
			members: [],
			importSites: [],
			dependencies: [],
		},
	],
	[
		"provider import edits",
		METHOD_SCHEMAS.importEdits.request,
		{ module: "./src/./a.ts", text: "", name: "b", fromModule: "./lib/./b.ts" },
		{ module: "src/a.ts", text: "", name: "b", fromModule: "lib/b.ts" },
	],
	[
		"provider load cycle judgment",
		METHOD_SCHEMAS.judgeLoadCycle.request,
		{ members: [{ module: "./src/./a.ts", contentHash: "h" }], entries: ["./src/./a.ts"] },
		{ members: [{ module: "src/a.ts", contentHash: "h" }], entries: ["src/a.ts"] },
	],
	[
		"provider forget notification",
		NOTIFICATION_SCHEMAS.forgetModule,
		{ module: "./src/./a.ts" },
		{ module: "src/a.ts" },
	],
	[
		"provider release notification",
		NOTIFICATION_SCHEMAS.releaseModule,
		{ module: "./src/./a.ts" },
		{ module: "src/a.ts" },
	],
	[
		"provider admission notification",
		NOTIFICATION_SCHEMAS.moduleAdmission,
		{ module: "./src/./a.ts", contentHash: "h", outcome: { status: "admitted" } },
		{ module: "src/a.ts", contentHash: "h", outcome: { status: "admitted" } },
	],
	[
		"provider index roots notification",
		NOTIFICATION_SCHEMAS.indexRoots,
		{ roots: ["./src/./a.ts"] },
		{ roots: ["src/a.ts"] },
	],
	[
		"daemon module cycles",
		DAEMON_METHODS.moduleCycles.request,
		{ module: "./src/./a.ts" },
		{ module: "src/a.ts", limit: 20 },
	],
	[
		"daemon module problems",
		DAEMON_METHODS.moduleProblems.request,
		{ module: "./src/./a.ts" },
		{ module: "src/a.ts" },
	],
	[
		"daemon relation candidates",
		DAEMON_METHODS.relationCandidates.request,
		{ module: "./src/./a.ts" },
		{ module: "src/a.ts" },
	],
	[
		"daemon revert drift",
		DAEMON_METHODS.refactorRevert.request,
		{ drifted: [{ module: "./src/./a.ts", contentHash: null }] },
		{ drifted: [{ module: "src/a.ts", contentHash: null }] },
	],
	[
		"daemon admitted modules",
		DAEMON_METHODS.admittedModules.request,
		{ modules: ["./src/./a.ts"] },
		{ modules: ["src/a.ts"] },
	],
	[
		"shared daemon ByModule request",
		DAEMON_METHODS.indexFile.request,
		{ module: "./src/./a.ts" },
		{ module: "src/a.ts" },
	],
] satisfies Array<[string, z.ZodType, unknown, unknown]>;

describe("a module on the wire is the one key the index files under", () => {
	it.each(PATH_SCHEMA_CASES)("normalizes workspace paths in %s", (_name, schema, input, expected) => {
		expect(schema.parse(input)).toEqual(expected);
	});

	it.each(PATH_FIELDS)(
		"%s.%s is normalized, and an escape is refused in the grammar's words",
		(method, field, rest) => {
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
		},
	);

	it("keeps an optional module field optional, and a required one required", () => {
		expect(DAEMON_METHODS.findByName.request.parse({ name: "a" })).toEqual({ name: "a" });
		expect(DAEMON_METHODS.findComments.request.parse({ text: "a" })).toEqual({ text: "a" });
		expect(DAEMON_METHODS.findDocs.request.parse({ text: "a" })).toEqual({ text: "a" });
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

	it("keeps note and relation authors optional", () => {
		expect(
			DAEMON_METHODS.writeNote.request.safeParse({ symbolId: "s", text: "", expectedRevision: 0 }).success,
		).toBe(true);
		expect(
			DAEMON_METHODS.writeRelation.request.safeParse({
				symbolId: "s",
				otherId: "other",
				action: "state",
				expectedRevision: 0,
			}).success,
		).toBe(true);
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
