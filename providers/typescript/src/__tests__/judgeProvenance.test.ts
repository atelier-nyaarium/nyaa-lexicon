import { afterEach, describe, expect, it } from "bun:test";
import {
	cleanWorkspaces,
	entering,
	expectShapes,
	type Files,
	judge,
	RUNTIMES,
	reading,
	SCRIPTS,
	verdicts,
} from "./judgeWorkspace.js";

afterEach(cleanWorkspaces);

describe("load-cycle judge: provenance", () => {
	it("reaches a branch of a guard on an input only where a simple test of it, by its type, can go either way", async () => {
		const mode = 'declare const mode: "a" | "b";';
		const maybe = "declare const s: string | undefined;";
		await expectShapes([
			['declare const env: { NODE_ENV?: string };\nif (env.NODE_ENV !== "production") A;', "bad"],
			["declare const pkg: { flag: boolean };\nif (pkg.flag) A;", "bad"],
			[`${mode}\nswitch (mode) { case "a": A; }`, "bad"],
			[`${maybe}\nif (typeof s === "string") A;`, "bad"],
			[`${maybe}\nif (s == null) A;`, "bad"],
			[`${maybe}\nif (s ?? A) {}`, "bad"],
			// A type that admits one outcome decides the test.
			["declare const yes: true;\nif (yes) A;", "bad"],
			['declare const x: "x";\nif (x === "x") A;', "bad"],
			['declare const n: number;\nif (typeof n === "number") A;', "bad"],
			[`${mode}\nif (mode === "c") A;`, "fine"],
			[`${maybe}\nif (typeof s === "number") A;`, "fine"],
			// A type that does not spell its values exactly, or a value computed from an input, decides nothing provable.
			['declare const m: `prefix-${string}`;\nif (m === "wrong") A;', "unknown"],
			['declare const m: Uppercase<string>;\nif (m === "lower") A;', "unknown"],
			[`${mode}\nswitch (mode) { case "a": break; case "b": break; default: A; }`, "fine"],
			["declare const n: number;\nif (n + 1 === 3) A;", "unknown"],
			["if (Math.random() > 0.5) A;", "unknown"],
			["if (Math.random() > 1) A;", "unknown"],
			["const n = Math.random();\nif (Math.abs(n) < 0) A;", "unknown"],
			["const n = Math.random();\nif (Math.min(n, 0) > 1) A;", "unknown"],
			["switch (Math.random()) { case 1: A; }", "unknown"],
			["if (Date.now() % 2 === 0) A;", "unknown"],
			["const f = Math.random() > 0.5;\nif (f === (1 as any)) A;", "unknown"],
			["const n = Math.random();\nif (Number.isNaN(n) === (1 as any)) A;", "unknown"],
			['declare const argv: string[];\nif (new Set(argv).has("--x")) A;', "unknown"],
		]);
	});

	it("includes missing numeric indexes in declared input domains", async () => {
		await expectShapes([
			["declare const xs: number[];\nif (xs[0] === undefined) A;", "bad"],
			["declare const xs: { [key: number]: number };\nif (xs[0] === undefined) A;", "bad"],
			["declare const xs: [number];\nif (xs[0] === undefined) A;", "fine"],
		]);
	});

	it("keeps augmented built-in members opaque", async () => {
		await expectShapes([
			[
				'declare global { interface Object { absent(): void; } }\nif (typeof ({}).absent === "function") A;',
				"unknown",
			],
		]);
	});

	it("keeps missing built-in membership opaque after possible writes", async () => {
		await expectShapes([
			['(Object.prototype as any).extra = 1;\nif ("extra" in {}) A;', "unknown"],
			[
				'interface Bag { extra?: number; }\nconst p = Object.prototype as Bag; p.extra = 1;\nif (typeof ({} as any).extra === "number") A;',
				"unknown",
			],
			[
				'class C {}\nconst p = Object.prototype as unknown as C; p.extra = 1;\nif (typeof ({} as any).extra === "number") A;',
				"unknown",
			],
		]);
	});

	it("keeps built-in lookups opaque after a prototype write", async () => {
		await expectShapes([
			['Object.prototype.toString = undefined as any;\nif (typeof ({}).toString === "function") A;', "unknown"],
			[
				'Object.prototype["toString"] = undefined as any;\nif (typeof ({}).toString === "function") A;',
				"unknown",
			],
			['(Object.prototype).toString = undefined as any;\nif (typeof ({}).toString === "function") A;', "unknown"],
			[
				'Object["prototype"].toString = undefined as any;\nif (typeof ({}).toString === "function") A;',
				"unknown",
			],
			[
				'const p = Object.prototype; p.toString = undefined as any;\nif (typeof ({}).toString === "function") A;',
				"unknown",
			],
			[
				'Object.defineProperty(Object.prototype, "toString", { value: undefined });\nif (typeof ({}).toString === "function") A;',
				"unknown",
			],
			[
				'Reflect.defineProperty(Object.prototype, "toString", { value: undefined });\nif (typeof ({}).toString === "function") A;',
				"unknown",
			],
			[
				'Object.defineProperties(Object.prototype, { toString: { value: undefined } });\nif (typeof ({}).toString === "function") A;',
				"unknown",
			],
			[
				'Object.assign(Object.prototype, { toString: undefined });\nif (typeof ({}).toString === "function") A;',
				"unknown",
			],
			[
				'const p = Object.prototype; Object.defineProperty(p, "toString", { value: undefined });\nif (typeof ({}).toString === "function") A;',
				"unknown",
			],
			[
				'(Object.prototype as any).extra = function () {};\nif (typeof ({} as any).extra === "function") A;',
				"unknown",
			],
			[
				'const p = Object.prototype; p.extra = function () {};\nif (typeof ({} as any).extra === "function") A;',
				"unknown",
			],
			[
				'declare const k: string; Object.prototype[k] = 1;\nif (typeof ({} as any).extra === "function") A;',
				"unknown",
			],
			[
				'Object.defineProperty(Object.prototype, "extra", { value: function () {} });\nif (typeof ({} as any).extra === "function") A;',
				"unknown",
			],
			[
				'Object.assign(Object.prototype, { extra: function () {} });\nif (typeof ({} as any).extra === "function") A;',
				"unknown",
			],
		]);
	});

	it("leaves calls through built-in prototypes unmodeled", async () => {
		await expectShapes([
			['Object.prototype.hasOwnProperty.call({}, "x");\nif (typeof ({}).toString === "function") A;', "unknown"],
		]);
	});

	it("carries switch fallthrough and last-body abrupt completion to the continuation", async () => {
		await expectShapes([
			['declare const m: "x";\nswitch (m) { case "x": case "y": throw 1; } A;', "fine"],
			['declare const m: "x";\nswitch (m) { case "x": default: throw 1; } A;', "fine"],
			[
				'declare const m: "x";\nfunction die() { throw 1; }\nswitch (m) { case "x": case "y": die(); } A;',
				"fine",
			],
		]);
	});

	it("preserves default selection, default fallthrough, and switch breaks", async () => {
		await expectShapes([
			['declare const m: "x" | "y";\nswitch (m) { case "x": break; case "y": break; default: A; }', "fine"],
			['declare const m: "x" | "y";\nswitch (m) { case "x": break; case "y": default: A; }', "unknown"],
			['declare const m: "x";\nswitch (m) { case "x": default: case "y": A; }', "bad"],
			['declare const m: "x";\nswitch (m) { case "x": break; } A;', "bad"],
		]);
	});

	it("keeps switch bodies reachable through fallthrough after domain exhaustion", async () => {
		await expectShapes([
			['declare const m: "x";\nswitch (m) { case "x": case "y": A; }', "bad"],
			['declare const m: null;\nswitch (m) { case null: case "x": A; }', "bad"],
		]);
	});

	it("kills the no-match path after an exhausted switch throws", async () => {
		const files = reading('declare const m: "x";\nswitch (m) { case "x": throw 1; }\nA;');
		for (const [, options] of RUNTIMES)
			expect(await verdicts(files, options, ["a.ts", "b.ts"])).toEqual({ "a.ts": "fine", "b.ts": "fine" });
	});

	it("carries failed switch labels into later case paths", async () => {
		await expectShapes([
			[
				'declare const mode: "x" | "y";\nswitch (mode) { case "x": break; case "y": break; case "x": A; }',
				"fine",
			],
			[
				'declare const mode: "x" | "y";\nfunction die() { throw 1; }\ntry { switch (mode) { case "x": break; case "y": break; case die(): break; } } catch { A; }',
				"fine",
			],
			['declare const mode: any;\nswitch (mode) { case "x": break; case "x": A; }', "unknown"],
		]);
	});

	it("keeps opaque case-label guards before later cases and defaults", async () => {
		await expectShapes([
			[
				'declare const m: "x" | "y"; function label() { if (Math.floor(0) === 0) throw 1; return "x"; } switch (m) { case label(): break; case "y": A; }',
				"unknown",
			],
			[
				'declare const m: "x" | "y"; function label() { if (Math.floor(0) === 0) throw 1; return "x"; } switch (m) { case label(): break; default: A; }',
				"unknown",
			],
		]);
	});

	it("answers unknown where a guard reads what the model lost", async () => {
		const decorated = (body: string, use: string) => `function d(_: any, c: any) { ${body} }\n${use}`;
		await expectShapes([
			// The language's library computes the same each run: it varies only with what it is passed.
			["if (new Set([1]).has(2)) A;", "unknown"],
			["if (Math.max(1, 2) === 3) A;", "unknown"],
			["if (!Math) A;", "fine"],
			['if (/x/.test("y")) A;', "unknown"],
			['const r = /x/;\nif (r.source === "x") A;', "unknown"],
			['function f() {}\nif (`${f}` === "x") A;', "unknown"],
			[`for (const i of [${"0, ".repeat(16)}0]) if (i === 1) A;`, "unknown"],
			[decorated("if (c.access.has({})) A;", "class C { @d x = 1; }"), "unknown"],
			[decorated('if (c.name === "wrong") A;', "const C = @d class {};"), "unknown"],
			[
				"function d(_: any) { return class { static x = 1; }; }\n@d class C { static { if ((this as any).x === 2) A; } }",
				"unknown",
			],
			// What the model folds decides the guard.
			['if ("x" in {}) A;', "fine"],
			["class C {}\nif ((0 as any) instanceof C) A;", "fine"],
			["const a = {};\nconst b = {};\nif (a === b || a !== a) A;", "fine"],
		]);
	});

	it("forgets what code it cannot see may have written, and keeps what a short circuit decides", async () => {
		await expectShapes([
			["const o = { v: 0 };\n[1].forEach(() => { o.v = 1; });\nif (o.v === 0) A;", "unknown"],
			["const o = { v: 0 };\nObject.assign(o, { v: 1 });\nif (o.v === 0) A;", "unknown"],
			["const xs = [1];\nxs.push(2);\nif (xs.length === 1) A;", "unknown"],
			["const o: { v?: number } = { v: 0 };\nif (flag) delete o.v;\nif (o.v === undefined) A;", "unknown"],
			["if (flag && false) A;", "fine"],
			["if (flag || true) A;", "bad"],
		]);
	});

	it("keeps a CommonJS export through unseen code, unless a function or another module assigns it", async () => {
		const files = (c: string): Files => ({
			"c.js": c,
			"a.js": `const c = require("./c");\nrequire("./b");\n[1].forEach(() => {});\nif (c.x === 1) later();\nclass K {}\nfunction later() { return new K(); }\nexports.A = 1;`,
			"b.js": 'require("./a");\nexports.B = 1;',
		});
		const judged = async (c: string) => (await judge(files(c), SCRIPTS, ["a.js", "b.js"], ["a.js"])).verdict;
		expect(await judged("exports.x = 1;")).toBe("bad");
		expect(await judged("exports.x = 1;\nexports.f = () => { exports.z = 2; };")).toBe("bad");
		expect(await judged("exports.x = 1;\nexports.f = () => { exports.x = 2; };")).toBe("unknown");
		expect(await judged("module.exports.x = 1;\nsetTimeout(() => { module.exports.x = 2; });")).toBe("unknown");
	});

	it("keeps independent guards bad and correlated ones unknown", async () => {
		const independent = "declare const other: boolean;\nfunction f() { if (other) return; if (flag) A; }\nf();";
		expect(await entering(independent)).toBe("bad");
		expect(await entering("function f() { if (flag) return; if (flag) A; }\nf();")).toBe("unknown");
		expect(await entering("function f() { if (flag) throw 0; if (flag) A; }\nf();")).toBe("unknown");
	});

	it("carries what a value came from through copies, conditionals, returns, arguments, properties and catches", async () => {
		const state = "const o = { v: 0 };\nif (flag) o.v = 1;";
		await expectShapes([
			[`${state}\nif (!flag && o.v === 1) A;`, "unknown"],
			[`${state}\nconst v = o.v;\nif (!flag && v === 1) A;`, "unknown"],
			[`${state}\nfunction f() { if (!flag && o.v === 1) A; }\nf();`, "unknown"],
			["const v = flag ? 1 : 0;\nif (!flag && v === 1) A;", "unknown"],
			["function f() { if (flag) return 1; return 0; }\nconst v = f();\nif (!flag && v === 1) A;", "unknown"],
			["function f(p: boolean) { if (p) A; }\nif (flag) f(!flag);", "unknown"],
			["const o = { v: flag };\nif (o.v && !flag) A;", "unknown"],
			["try { if (flag) throw 1; } catch { if (!flag) A; }", "unknown"],
			// Independent inputs stay bad.
			["declare const other: boolean;\nconst v = other ? 1 : 0;\nif (flag && v === 1) A;", "bad"],
			["function f(p: boolean) { if (p) A; }\nf(flag);", "bad"],
		]);
	});

	it("leaves a test of state a path the read excludes wrote unknown, and keeps an earlier path's write bad", async () => {
		await expectShapes([
			["const o = { v: 0 };\nif (flag) { o.v = 1; } else { if (o.v === 1) A; }", "unknown"],
			["let v = 0;\nfunction f() { if (flag) { v = 1; return; } if (v === 1) A; }\nf();", "unknown"],
			["const o = { v: 0 };\nif (flag) o.v = 1;\nif (o.v === 1) A;", "bad"],
			["function f() { const o = { v: 0 }; o.v = 1; if (o.v === 1) A; }\nif (flag) f();", "bad"],
		]);
	});
});
