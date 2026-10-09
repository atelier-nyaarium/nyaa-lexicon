import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { hashContent, type JudgeLoadCycleAnswer } from "@nyaa-lexicon/protocol";
import { MAX_DOWNSTREAM } from "../judge/model.js";
import { judgeLoadCycle, releaseLoadCycle } from "../judge/session.js";
import { harness } from "./harness.js";
import {
	CJS,
	cleanWorkspaces,
	ESM,
	type Files,
	indexed,
	judge,
	judgeIndexed,
	RUNTIMES,
	reading,
	roots,
	SCRIPTS,
	verdicts,
} from "./judgeWorkspace.js";

afterEach(cleanWorkspaces);

describe("load-cycle judge", () => {
	it("judges a barrel by which re-export loads first, from each entry", async () => {
		const barrel = (first: string, second: string): Files => ({
			"index.ts": `export * from "./${first}";\nexport * from "./${second}";`,
			"a.ts": 'import { B } from "./index";\nexport const A = B + 1;',
			"b.ts": "export const B = 1;",
		});
		for (const [, options] of RUNTIMES) {
			expect(await verdicts(barrel("a", "b"), options, ["index.ts", "a.ts"])).toEqual({
				"index.ts": "bad",
				"a.ts": "fine",
			});
			expect(await verdicts(barrel("b", "a"), options, ["index.ts", "a.ts"])).toEqual({
				"index.ts": "fine",
				"a.ts": "fine",
			});
		}
	});

	it("names the entry, the members' order, the reader, the target and the calls of a hazard", async () => {
		const range = (line: number, start: number, end: number) => ({
			start: { line, character: start },
			end: { line, character: end },
		});
		const answer = await judge(reading("function f() { return A; }\nf();"), ESM, ["a.ts", "b.ts"], ["a.ts"]);
		expect(answer.bad).toEqual([
			{
				entry: "a.ts",
				order: ["b.ts", "a.ts"],
				reader: { module: "b.ts", range: range(3, 22, 23), name: "A" },
				target: { module: "a.ts", name: "A", kind: "const", symbolId: "lexicon typescript a.ts A." },
				calls: [{ module: "b.ts", range: range(4, 0, 1), name: "f" }],
			},
		]);
		expect(answer.evidence.map((row) => [row.module, row.contentHash])).toEqual(
			Object.entries(reading("")).map(([module]) => [
				module,
				hashContent(reading("function f() { return A; }\nf();")[module] ?? ""),
			]),
		);
	});

	it("names the declaration a target reads by the id the index gives it", async () => {
		const enumMember = 'import "./b";\nexport enum E { X = f(), Y = 2 }\nfunction f(): number { return E.Y; }';
		const namespaceMember =
			'import "./b";\nexport namespace N {\nexport const b = f();\nexport const a = 1;\nfunction f() { return a; }\n}';
		const loaded = 'import "./a";\nexport {};';
		const cases: Array<[string, Files, object, string, { module: string; name: string }]> = [
			["binding", reading("A;"), ESM, "a.ts", { module: "a.ts", name: "A" }],
			["enum member", { "a.ts": enumMember, "b.ts": loaded }, ESM, "a.ts", { module: "a.ts", name: "Y" }],
			[
				"namespace member",
				{ "a.ts": namespaceMember, "b.ts": loaded },
				ESM,
				"a.ts",
				{ module: "a.ts", name: "a" },
			],
			[
				"export renamed",
				{
					"a.ts": 'import "./b";\nconst a = 1;\nexport { a as b };',
					"b.ts": 'import { b } from "./a";\nb;\nexport {};',
				},
				CJS,
				"a.ts",
				{ module: "a.ts", name: "a" },
			],
			[
				"import",
				{
					"a.ts": 'import { f } from "./b";\nf();\nexport {};',
					"b.ts": 'import "./a";\nimport { C } from "./c";\nexport function f() { return C; }',
					"c.ts": "export const C = 1;",
				},
				CJS,
				"b.ts",
				{ module: "c.ts", name: "C" },
			],
		];
		for (const [shape, files, options, entry, expected] of cases) {
			const { answer, declared } = await judgeIndexed(files, options, ["a.ts", "b.ts"], [entry]);
			const target = answer.bad[0]?.target;
			expect({ shape, declares: declared.get(target?.symbolId ?? "") }).toEqual({ shape, declares: expected });
		}
	});

	it("reports a hazard a member reads, and only an unknown for one a downstream module reads", async () => {
		const files = (body: string): Files => ({
			"a.ts": `import "./b";\n${body}`,
			"b.ts": 'import { f } from "./a";\nf();\nexport {};',
			"c.ts": "export const C = 1;\nexport function g() { return C; }",
		});
		const downstream = 'import { g } from "./c";\nexport function f() { return g(); }';
		const member = 'import { C } from "./c";\nexport function f() { return C; }';
		expect((await judge(files(downstream), ESM, ["a.ts", "b.ts"], ["a.ts"])).verdict).toBe("unknown");
		expect((await judge(files(member), ESM, ["a.ts", "b.ts"], ["a.ts"])).verdict).toBe("bad");
	});

	it("reads a namespace import's exports and a re-export's live getters as they stand", async () => {
		const namespace = (shape: string): Files => ({
			"a.ts": 'import "./b";\nexport const A = 1;\nexport function f() { return 1; }',
			"b.ts": `import * as a from "./a";\n${shape}\nexport {};`,
		});
		const named = (first: string, second: string): Files => ({
			"index.ts": `export { ${first} } from "./${first.toLowerCase()}";\nexport { ${second} } from "./${second.toLowerCase()}";`,
			"a.ts": 'import { B } from "./index";\nexport const A = B;',
			"b.ts": "export const B = 1;",
		});
		for (const [runtime, options] of RUNTIMES) {
			const found = {
				runtime,
				read: (await judge(namespace("a.A;"), options, ["a.ts", "b.ts"], ["a.ts"])).verdict,
				called: (await judge(namespace("a.f();"), options, ["a.ts", "b.ts"], ["a.ts"])).verdict,
				after: (await judge(named("B", "A"), options, ["index.ts", "a.ts"], ["index.ts"])).verdict,
				before: (await judge(named("A", "B"), options, ["index.ts", "a.ts"], ["index.ts"])).verdict,
			};
			expect(found).toEqual({ runtime, read: "bad", called: "fine", after: "fine", before: "bad" });
		}
	});

	it("sets an enum's members as their initializers run", async () => {
		const files = (members: string): Files => ({
			"a.ts": `import "./b";\nexport enum E { ${members} }\nfunction f(): number { return E.Y; }`,
			"b.ts": 'import "./a";\nexport {};',
		});
		for (const [, options] of RUNTIMES) {
			expect((await judge(files("X = f(), Y = 2"), options, ["a.ts", "b.ts"], ["a.ts"])).verdict).toBe("bad");
			expect((await judge(files("Y = 2, X = f()"), options, ["a.ts", "b.ts"], ["a.ts"])).verdict).toBe("fine");
		}
	});

	it("answers unknown past its step budget", async () => {
		const levels = Array.from({ length: 8 }, (_, at) => `function f${at + 1}() { ${`f${at}();`.repeat(6)} }`);
		const shape = ["function f0() { return 1; }", ...levels, "f8();"].join("\n");
		const answer = await judge(reading(shape), ESM, ["a.ts", "b.ts"], ["a.ts"]);
		expect(answer).toMatchObject({ verdict: "unknown", unknowns: [{ reason: "budget" }] });
	});

	it("reads a base class where a definition extends it", async () => {
		const files = (shape: string): Files => ({
			"a.ts": 'import "./b";\nexport class Base {}',
			"b.ts": `import { Base } from "./a";\n${shape}\nexport {};`,
		});
		for (const [, options] of RUNTIMES) {
			expect((await judge(files("class K extends Base {}"), options, ["a.ts", "b.ts"], ["a.ts"])).verdict).toBe(
				"bad",
			);
			const later = "function make() { return class extends Base {}; }";
			expect((await judge(files(later), options, ["a.ts", "b.ts"], ["a.ts"])).verdict).toBe("fine");
		}
	});

	it("publishes `export =` when its statement completes, read through the object `import = require` captured", async () => {
		const files: Files = {
			"a.ts": 'import b = require("./b");\nexport = { A: 1, b };',
			"b.ts": 'import a = require("./a");\nexport const seen = a.A;',
		};
		expect(await verdicts(files, CJS, ["a.ts", "b.ts"])).toEqual({ "a.ts": "bad", "b.ts": "fine" });
	});

	it("answers in slices against the Program its first slice pinned, and forgets a released token", async () => {
		const files = reading("A;");
		const { provider, request } = indexed(files, ESM, ["a.ts", "b.ts"], ["a.ts"]);
		const host = { ...provider.provider.loadCycleHost(), sliceMs: 0 };
		const project = provider.provider.store.project;
		const released = judgeLoadCycle(project, host, request);
		if (!("partial" in released)) throw new Error("expected a partial answer");
		releaseLoadCycle(project, released.partial);
		expect(judgeLoadCycle(project, host, { ...request, partial: released.partial })).toMatchObject({
			verdict: "unknown",
			unknowns: [{ reason: "budget" }],
		});
		let answer = judgeLoadCycle(project, host, request);
		// The module changes between slices; the judgment keeps reading the Program it pinned.
		provider.parseFile({ module: "b.ts", contentHash: hashContent("export {};"), text: "export {};" });
		let slices = 1;
		while ("partial" in answer) {
			answer = judgeLoadCycle(project, host, { ...request, partial: answer.partial });
			slices++;
		}
		provider.shutdown();
		expect(slices).toBeGreaterThan(2);
		expect(answer.verdict).toBe("bad");
		expect(answer.evidence.find((row) => row.module === "b.ts")?.contentHash).toBe(
			hashContent(files["b.ts"] ?? ""),
		);
	});

	it("loads nothing through a phantom edge, and through it once isolated modules keep it", async () => {
		const interfaces: Files = {
			"a.ts": 'export { I } from "./b";\nexport const A = 1;',
			"b.ts": 'import { A } from "./a";\nexport interface I {}\nexport const B = A;',
		};
		const constEnum: Files = {
			"a.ts": 'import { E } from "./b";\nexport const A = E.X;',
			"b.ts": 'import { A } from "./a";\nexport const enum E { X = 1 }\nexport const B = A;',
		};
		for (const [, options] of RUNTIMES) {
			expect((await judge(interfaces, options, ["a.ts", "b.ts"], ["a.ts"])).verdict).toBe("fine");
			expect((await judge(constEnum, options, ["a.ts", "b.ts"], ["a.ts"])).verdict).toBe("fine");
			const isolated = { ...options, isolatedModules: true };
			expect((await judge(constEnum, isolated, ["a.ts", "b.ts"], ["a.ts"])).verdict).toBe("bad");
		}
	});

	it("leaves the rest of a CommonJS walk unknown after a require under an unfolded condition", async () => {
		const files = (load: string): Files => ({
			"a.js": `const flag = Math.random() > 0.5;\n${load}\nexports.A = 1;`,
			"b.js": 'const a = require("./a");\nexports.B = a.A;',
		});
		const correlated = 'if (flag) require("./b");\nif (!flag) require("./b");';
		expect((await judge(files(correlated), SCRIPTS, ["a.js", "b.js"], ["a.js"])).verdict).toBe("unknown");
		expect((await judge(files('require("./b");'), SCRIPTS, ["a.js", "b.js"], ["a.js"])).verdict).toBe("bad");
	});

	it("reads `export default f` as its own binding and `export { f as default }` as f", async () => {
		const files = (exported: string): Files => ({
			"a.ts": `import "./b";\nfunction f() { return 1; }\n${exported}`,
			"b.ts": 'import g from "./a";\ng();\nexport {};',
		});
		for (const [, options] of RUNTIMES) {
			expect((await judge(files("export default f;"), options, ["a.ts", "b.ts"], ["a.ts"])).verdict).toBe("bad");
			expect((await judge(files("export { f as default };"), options, ["a.ts", "b.ts"], ["a.ts"])).verdict).toBe(
				"fine",
			);
		}
	});

	it("initializes declarators left to right and namespace members where they stand", async () => {
		const files = (body: string): Files => ({
			"a.ts": `import "./b";\n${body}`,
			"b.ts": 'import "./a";\nexport {};',
		});
		const namespace = (first: string, second: string) =>
			`export namespace N {\n${first}\n${second}\nfunction f() { return a; }\n}`;
		for (const [, options] of RUNTIMES) {
			const judged = async (body: string) =>
				(await judge(files(body), options, ["a.ts", "b.ts"], ["a.ts"])).verdict;
			expect(await judged("function useA() { return a; }\nexport const a = 1, b = useA();")).toBe("fine");
			expect(await judged("function useA() { return a; }\nexport const b = useA(), a = 1;")).toBe("bad");
			expect(await judged(namespace("export const a = 1;", "export const b = f();"))).toBe("fine");
			expect(await judged(namespace("export const b = f();", "export const a = 1;"))).toBe("bad");
		}
	});

	it("follows CommonJS exports objects by identity and each property by its assignment", async () => {
		const replaced: Files = {
			"a.js": 'exports.x = 1;\nrequire("./b");\nmodule.exports = { x: 2 };',
			"b.js": 'const a = require("./a");\nexports.seen = a.x;',
		};
		expect(await verdicts(replaced, SCRIPTS, ["a.js", "b.js"])).toEqual({ "a.js": "fine", "b.js": "fine" });
		const late: Files = {
			"a.js": 'require("./b");\nexports.y = 1;',
			"b.js": 'const a = require("./a");\nexports.seen = a.y;',
		};
		expect(await verdicts(late, SCRIPTS, ["a.js", "b.js"])).toEqual({ "a.js": "bad", "b.js": "fine" });
		const unseen = (first: string): Files => ({
			"a.js": `${first}\nrequire("./b");\nexports.x = 2;`,
			"b.js": 'const a = require("./a");\nexports.seen = a.x;',
		});
		// Code the walk cannot see may have assigned it already.
		const callback = "[1].forEach(() => { exports.x = 1; });";
		expect((await judge(unseen(callback), SCRIPTS, ["a.js", "b.js"], ["a.js"])).verdict).toBe("unknown");
		const uncalled = "function later() { exports.x = 1; }";
		expect((await judge(unseen(uncalled), SCRIPTS, ["a.js", "b.js"], ["a.js"])).verdict).toBe("bad");
	});

	it("runs a require in an ECMAScript module where it stands, not in the loader's order", async () => {
		const files = (body: string): Files => ({
			"a.ts": body,
			"b.ts": 'import { A } from "./a";\nexport const B = A;',
		});
		expect(
			(await judge(files('export const A = 1;\nrequire("./b");'), ESM, ["a.ts", "b.ts"], ["a.ts"])).verdict,
		).toBe("fine");
		expect(
			(await judge(files('require("./b");\nexport const A = 1;'), ESM, ["a.ts", "b.ts"], ["a.ts"])).verdict,
		).toBe("bad");
	});

	it("validates each import occurrence by the landing its own resolution mode gives", async () => {
		const files: Files = {
			"package.json": JSON.stringify({
				name: "self",
				type: "module",
				imports: { "#b": { import: "./b.js", require: "./b-cjs.cjs" } },
			}),
			"a.mts": 'import { B } from "#b";\nimport other = require("#b");\nexport const A = [B, other.other];',
			"b.ts": "export const B = 1;",
			"b-cjs.cts": "export const other = 1;",
		};
		const answer = await judge(files, { module: "NodeNext", moduleResolution: "NodeNext" }, ["a.mts"], ["a.mts"]);
		const landings = answer.evidence.find((row) => row.module === "a.mts")?.landings ?? [];
		expect(landings.map(({ range, landing }) => [range.start.line, landing])).toEqual([
			[0, { kind: "module", module: "b.ts" }],
			[1, { kind: "module", module: "b-cjs.cts" }],
		]);
	});

	it("lists what the writes scan read as evidence, except modules outside the index, whose writes still count", async () => {
		const called = "const o = { f() { return A; } };\no.f();";
		const writes = "const q: any = {};\nq.f = () => 1;\nexport {};";
		const answered = async (c: string, imports?: string, scope?: string[]) => {
			const files: Files = { ...reading(called, imports), "c.ts": c };
			const answer = await judge(files, ESM, ["a.ts", "b.ts"], ["a.ts"], scope);
			return { verdict: answer.verdict, c: answer.evidence.find((row) => row.module === "c.ts") };
		};
		const listed = (text: string) => ({ module: "c.ts", contentHash: hashContent(text), landings: [] });
		const scope = ["a.ts", "b.ts"];
		const reaching = 'import { A } from "./a";\nimport type {} from "./c";';
		expect(await answered("export {};")).toEqual({ verdict: "bad", c: listed("export {};") });
		expect(await answered("export {};", undefined, scope)).toEqual({ verdict: "bad", c: undefined });
		expect(await answered(writes, undefined, scope)).toEqual({ verdict: "unknown", c: undefined });
		// An import from a module the index holds brings it in, as the index's own import walk does.
		expect(await answered("export {};", reaching, scope)).toEqual({ verdict: "bad", c: listed("export {};") });
	});

	it("answers over a writes scan past the downstream budget, which counts only modules the walk read", async () => {
		const files: Files = reading("A;");
		for (let at = 0; at <= MAX_DOWNSTREAM; at++) files[`more/m${at}.ts`] = "export {};";
		const answer = await judge(files, ESM, ["a.ts", "b.ts"], ["a.ts"], ["a.ts", "b.ts", "tsconfig.json"]);
		expect(answer.verdict).toBe("bad");
		expect(answer.evidence.map((row) => row.module).sort()).toEqual(["a.ts", "b.ts"]);
		const pending = await judge(files, ESM, ["a.ts", "b.ts"], ["a.ts"], Object.keys(files));
		expect({ verdict: pending.verdict, rows: pending.evidence.length }).toEqual({
			verdict: "bad",
			rows: MAX_DOWNSTREAM + 3,
		});
	});

	it("keeps each slice short over a module of thousands of imports", async () => {
		const files: Files = {
			"a.ts": `${'import "./b";\n'.repeat(6000)}export const A = 1;`,
			"b.ts": 'import "./a";\nexport {};',
		};
		const { provider, request } = indexed(files, ESM, ["a.ts", "b.ts"], ["a.ts"]);
		const host = { ...provider.provider.loadCycleHost(), sliceMs: 0 };
		const project = provider.provider.store.project;
		let longest = 0;
		let answer: JudgeLoadCycleAnswer | undefined;
		do {
			const started = performance.now();
			const partial = answer !== undefined && "partial" in answer ? { partial: answer.partial } : {};
			answer = judgeLoadCycle(project, host, { ...request, ...partial });
			longest = Math.max(longest, performance.now() - started);
		} while ("partial" in answer);
		provider.shutdown();
		expect(answer.verdict).toBe("fine");
		expect(longest).toBeLessThan(150);
	});

	it("answers a module system it does not model, and a Program not yet built, as unknown", async () => {
		const mixed = await judge(
			{ "a.mts": 'import "./b.cjs";\nexport {};', "b.cts": 'import "./a.mjs";\nexport {};' },
			{ module: "NodeNext", moduleResolution: "NodeNext" },
			["a.mts", "b.cts"],
			["a.mts"],
		);
		expect(mixed.unknowns).toEqual([{ reason: "runtime" }]);
		const provider = harness();
		const root = mkdtempSync(path.join(tmpdir(), "lexicon-ts-judge-"));
		roots.push(root);
		writeFileSync(path.join(root, "a.ts"), "export {};");
		provider.initialize(root);
		const cold = await provider.handlers.judgeLoadCycle?.({
			members: [{ module: "a.ts", contentHash: hashContent("export {};") }],
			entries: ["a.ts"],
		});
		expect(cold).toMatchObject({ verdict: "unknown", unknowns: [{ reason: "notReady" }] });
	});
});
