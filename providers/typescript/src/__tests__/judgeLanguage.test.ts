import { afterEach, describe, expect, it } from "bun:test";
import {
	type Answered,
	cleanWorkspaces,
	ESM,
	entering,
	expectShapes,
	type Files,
	judge,
	RUNTIMES,
	SCRIPTS,
} from "./judgeWorkspace.js";

afterEach(cleanWorkspaces);

describe("load-cycle judge: language", () => {
	it("walks class definitions when they run and constructions when something constructs", async () => {
		await expectShapes([
			["class K { static x = A; }", "bad"],
			["class K { static { A; } }", "bad"],
			["class K { [String(A)]() {} }", "bad"],
			["class K { x = A; }", "fine"],
			["class K { m() { return A; } }", "fine"],
			["class K { x = A; }\nnew K();", "bad"],
			["class P { constructor() { A; } }\nclass K extends P {}\nnew K();", "bad"],
			["class P { constructor() { A; } }\nclass K extends P {}", "fine"],
			["class P { constructor() { A; } }\nclass K extends P { constructor() { super(); } }\nnew K();", "bad"],
			["class K { static m() { return A; } }\nK.m();", "bad"],
			["class K { get v() { return A; } }\nnew K().v;", "bad"],
			["class K { get v() { return A; } }\nnew K();", "fine"],
		]);
	});

	it("treats computed constructor keys as prototype mutations", async () => {
		await expectShapes([['class C { ["constructor"]() {} }\nif (C.prototype.constructor === C) A;', "fine"]]);
	});

	it("follows calls through call, apply and new, and leaves recursion and depth past the limit unknown", async () => {
		const chain = (depth: number) =>
			[
				"function g0() { A; }",
				...Array.from({ length: depth }, (_, at) => `function g${at + 1}() { g${at}(); }`),
				`g${depth}();`,
			].join("\n");
		await expectShapes([
			["function f() { return A; }\nf.call(null);", "bad"],
			["function f() { return A; }\nf.apply(null, []);", "bad"],
			["function F(this: unknown) { A; }\nnew (F as unknown as new () => object)();", "bad"],
			["function f(n: number): number { return n ? f(n - 1) : 0; }\nf(1);", "unknown"],
			[chain(5), "bad"],
			[chain(9), "unknown"],
		]);
	});

	it("follows control flow through labels, loops, finally blocks and short circuits", async () => {
		await expectShapes([
			["outer: { break outer; A; }", "fine"],
			["outer: { break outer; }\nA;", "bad"],
			["while (true) { break; }\nA;", "bad"],
			["for (;;) { if (flag) break; }\nA;", "bad"],
			["for (;;) {}\nA;", "fine"],
			["try {} finally { A; }", "bad"],
			["function f() { try { return 1; } finally { A; } }\nf();", "bad"],
			["function f() { throw 0; }\ntry { f(); } catch { A; }", "bad"],
			["for (const k in { x: 1 }) A;", "bad"],
			["for (const k in {}) A;", "fine"],
			["const n = null as { f(x: unknown): void } | null;\nn?.f(A);", "fine"],
			["const m = { f(_: unknown) {} };\nm?.f(A);", "bad"],
			["false ? A : 0;", "fine"],
			["true ? A : 0;", "bad"],
			["false && A;", "fine"],
			["null ?? A;", "bad"],
		]);
	});

	it("finds conversion hooks and setters by one lookup up the prototype chain, and leaves hooks it cannot name unknown", async () => {
		const inherits = (members: string) => `const o = { __proto__: { ${members} } } as any;`;
		await expectShapes([
			["const o = { valueOf() { return A; } };\nconst sum = (o as unknown as number) + 1;", "bad"],
			["const o = { toString() { return A; } };\nconst text = `${o}`;", "bad"],
			[`${inherits("valueOf() { return A; }")}\no + 1;`, "bad"],
			[`${inherits("set x(_: unknown) { A; }")}\no.x = 1;`, "bad"],
			["const o = { get x() { return A; } } as { x?: number };\ndelete o.x;\no.x;", "fine"],
			["class P { get x() { return A; } }\nclass C extends P { y = super.x; }\nnew C();", "bad"],
			['const o = { toString() { return "k"; }, valueOf() { return A; } };\n`${o}`;', "fine"],
			["const o = { toString() { return A; } };\nconst p: Record<string, number> = {};\np[o as never];", "bad"],
			["const o = { __proto__: null } as any;\ntry { o + 1; } catch { A; }", "bad"],
			["const o = { [Symbol.toPrimitive]() { return A; } } as any;\no + 1;", "unknown"],
			["const plain = { v: 1 };\nconst text = `${plain.v}`;\nA;", "bad"],
		]);
	});

	it("enumerates own keys in the language's order: indices ascending, then names as they were added", async () => {
		const throwsFirst = 'const o = { get "2"() { throw 1; }, get "1"() { return A; } };';
		const readsLater = 'const o = { get "2"() { return A; }, get "1"() { throw 1; } };';
		await expectShapes([
			[`${throwsFirst}\nconst p = { ...o };`, "bad"],
			[`${throwsFirst}\nconst { ...p } = o;`, "bad"],
			[`${readsLater}\nconst p = { ...o };`, "fine"],
			['for (const k in { b: 1, 1: 1 }) { if (k === "1") break; A; }', "fine"],
			["for (const k in { __proto__() {} }) A;", "bad"],
		]);
	});

	it("throws reading a local before its declaration runs, which each loop pass makes anew", async () => {
		await expectShapes([
			["for (const i of [1]) { function f() { return y; } f(); const y = A; }", "fine"],
			[
				"for (const i of [0, 1]) { function f() { return x; } if (i === 1 && f() === 0) A; const x = i; }",
				"fine",
			],
			["function g() { try { h(); } catch { A; } let y = 1; function h() { return y; } }\ng();", "bad"],
			["function g() { function h() { return y; } h(); A; var y = 1; }\ng();", "bad"],
		]);
	});

	it("assigns fields through an inherited setter only when emit assigns rather than defines them", async () => {
		const shape = "class P { set v(_: number) { A; } }\nclass K extends P { v = 1; }\nnew K();";
		expect(await entering(shape, { ...ESM, useDefineForClassFields: false })).toBe("bad");
		expect(await entering(shape, { ...ESM, useDefineForClassFields: true })).toBe("fine");
	});

	it("reaches only what completion semantics and folded conditions reach", async () => {
		const switching = 'function s(k: string) { switch (k) { case "a": return 1; default: return A; } }';
		await expectShapes([
			["if (false) A;", "fine"],
			["while (false) A;", "fine"],
			["for (const v of []) A;", "fine"],
			["function f() { { return; } A; }\nf();", "fine"],
			["function g(p: number) { if (p === 1) return; A; }\ng(1);", "fine"],
			["function h(p = A) { return p; }\nh(1);", "fine"],
			["function f() { return 1; }\ntry { f(); } catch { A; }", "fine"],
			[`${switching}\ns("a");`, "fine"],
			["A;", "bad"],
			["do { A; } while (false);", "bad"],
			["try { throw 0; } catch { A; }", "bad"],
			["if (flag) A;", "bad"],
			["for (const v of [1]) A;", "bad"],
			["function g(p: number) { if (p === 1) return; A; }\ng(2);", "bad"],
			["function h(p = A) { return p; }\nh();", "bad"],
			[`${switching}\ns("b");`, "bad"],
			['switch (flag ? "a" : "b") { case "a": A; }', "bad"],
			[
				'declare const m: any;\nfunction die(): never { throw 1; }\nswitch (m) { case die(): break; case "x": A; }',
				"fine",
			],
			["try { unseen(); } catch { A; }", "unknown"],
			["for (const v of [1].values()) A;", "unknown"],
			["function f() { if (flag) return; if (flag) A; }\nf();", "unknown"],
			["function h(p = A) { return p; }\nh(unseen as never);", "unknown"],
		]);
	});

	it("defers library callbacks it can name, walks workspace ones, and leaves the rest unknown", async () => {
		await expectShapes([
			["[1].reduce(() => A, 0);", "unknown"],
			["[1, 2].sort(() => A);", "unknown"],
			["[,].map(() => A);", "unknown"],
			["const xs = [1];\n(xs as { map: unknown }).map = (f: () => void) => f();\nxs.map(() => A);", "unknown"],
			["setTimeout(() => A, 0);", "fine"],
			["queueMicrotask(() => A);", "fine"],
			["Promise.resolve().then(() => A);", "fine"],
			['new EventTarget().addEventListener("x", () => A);', "fine"],
			["function setTimeout(f: () => void) { f(); }\nsetTimeout(() => A);", "bad"],
			["const p = { then(f: () => void) { f(); } };\np.then(() => A);", "bad"],
			["const o = { get v() { return A; } };\no.v;", "bad"],
			["new Promise(() => A);", "unknown"],
		]);
	});

	it("reads a decorated member's design type only where metadata names a class", async () => {
		const options = { experimentalDecorators: true, emitDecoratorMetadata: true };
		const decorated = (annotation: string, extra = ""): Files => ({
			"a.ts": 'import "./b";\nexport class C {}\nexport enum E { X }',
			"b.ts": `import { C, E } from "./a";\n${extra}\nfunction dec(_t: object, _k: string) {}\nexport class D { @dec d!: ${annotation}; }\nexport const e: E | undefined = undefined;`,
		});
		for (const [runtime, base] of RUNTIMES) {
			const cases: Array<[Files, Answered["verdict"]]> = [
				[decorated("C"), "bad"],
				[decorated("C[]"), "fine"],
				[decorated("Alias", "type Alias = C;"), "fine"],
				[decorated("C | null"), "unknown"],
				[decorated("C | never"), "unknown"],
				[decorated("E"), "unknown"],
			];
			for (const [files, verdict] of cases) {
				const answer = await judge(files, { ...base, ...options }, ["a.ts", "b.ts"], ["a.ts"]);
				expect({ runtime, d: files["b.ts"], verdict: answer.verdict }).toEqual({
					runtime,
					d: files["b.ts"],
					verdict,
				});
			}
		}
	});

	it("runs a generator's body only when iterated and an async body until its first await", async () => {
		await expectShapes([
			["function* gen() { A; }\ngen();", "fine"],
			["function* gen() { A; }\nfor (const v of gen()) v;", "unknown"],
			["async function run() { A; await 0; }\nrun();", "bad"],
			["async function run() { await 0; A; }\nrun();", "fine"],
		]);
	});

	it("walks a function nothing replaces, and leaves one something replaces unknown", async () => {
		await expectShapes([
			["const o = { f() { return A; } };\no.f();", "bad"],
			["const o = { f() { return A; } };\no.f = () => 1;\no.f();", "unknown"],
			["const loose: any = {};\nloose.f = () => 1;\nconst o = { f() { return A; } };\no.f();", "unknown"],
		]);
	});

	it("lets an async body's throw reject its promise while the caller goes on", async () => {
		await expectShapes([
			["async function f() { throw 1; }\nf().catch(() => {});\nA;", "bad"],
			["async function f() { throw 1; }\ntry { f(); } catch { A; }", "fine"],
		]);
	});

	it("copies own properties through object rest and spread, and reads through a literal's __proto__", async () => {
		const getter = "const o = { get x() { return A; }, y: 1 };";
		await expectShapes([
			[`${getter}\nconst { ...p } = o;`, "bad"],
			[`${getter}\nlet p;\n({ ...p } = o);`, "bad"],
			["const { ...p } = { y: 1 };\nif (p.y === 1) A;", "bad"],
			["const { y, ...p } = { y: 1 };\nif ((p as { y?: number }).y === 1) A;", "fine"],
			["const { ...p } = null as never;\nA;", "fine"],
			["const o = { __proto__: { get x() { return A; } } } as { x: number };\no.x;", "bad"],
			["const o = { __proto__: { f() { return A; } } } as { f(): number };\no.f();", "bad"],
			["const o = { __proto__: { v: 1 } } as { v: number };\nif (o.v === 2) A;", "fine"],
			["const o = { __proto__: unseen } as unknown as { x: number };\no.x;", "unknown"],
		]);
	});

	it("forgets all of an object code it cannot see may redefine, and runs the hooks a function or prototype may hold", async () => {
		await expectShapes([
			['const o = { get x() { return A; } };\nObject.defineProperty(o, "x", { value: 1 });\no.x;', "unknown"],
			[
				"const o = { __proto__: { get x() { return A; } } } as any;\nObject.setPrototypeOf(o, null);\no.x;",
				"unknown",
			],
			[
				'const o = { set x(_: unknown) { A; } };\nObject.defineProperty(o, "x", { value: 1, writable: true });\no.x = 2;',
				"unknown",
			],
			["function f() {}\nf.valueOf = () => A;\n+f;", "unknown"],
			['function f() {}\nf.toString = () => { A; return "x"; };\n({} as any)[f as any];', "unknown"],
			["class C {}\n(C.prototype as any).valueOf = () => A;\n(new C() as any) + 1;", "unknown"],
			["function f() {}\nconst s = `${f}`;\nA;", "bad"],
		]);
	});

	it("gives up on whatever an unmodeled builtin may have changed, rather than model part of it", async () => {
		const frozen = (setup: string, write: string) => `${setup}\ntry { ${write}; } catch { A; }`;
		await expectShapes([
			['const o = { x: 1 };\nReflect.set(o, "x", 2);\nif (o.x === 1) A;', "unknown"],
			["const o: any = {};\nObject.defineProperties(o, { y: { get() { return A; } } });\no.y;", "unknown"],
			[frozen("const o = { x: 1 };\nObject.freeze(o);", "(o as any).x = 2"), "unknown"],
			[frozen("const xs: number[] = [];\nObject.freeze(xs);", "xs[0] = 1"), "unknown"],
			[frozen("function f() {}\nObject.freeze(f);", "(f as any).x = 1"), "unknown"],
			[frozen("class C {}\nObject.freeze(C.prototype);", "(C.prototype as any).x = 1"), "unknown"],
			["const o = { x: 1 };\nif (flag) Object.freeze(o);\nif (!flag) { o.x = 2; A; }", "unknown"],
		]);
		// Outside a try, a write that may throw does not cut the path.
		expect(await entering("const xs: number[] = [];\nObject.freeze(xs);\nxs[0] = 1;\nA;")).toBe("bad");
	});

	it("leaves built-in prototype members opaque and missing members undefined", async () => {
		await expectShapes([
			['if (typeof ({}).toString === "function") A;', "unknown"],
			["class C {}\nif (C.prototype.constructor === C) A;", "bad"],
			['class C {}\nif (typeof C.prototype.toString === "function") A;', "unknown"],
			["if (({} as any).nothing === undefined) A;", "bad"],
			['if (typeof ({}).notThere === "undefined") A;', "bad"],
			["const o = { a: 1 }; if (o.b) A;", "fine"],
			['if (typeof "x".toUpperCase !== "function") A;', "unknown"],
			['if ("toString" in {}) A;', "unknown"],
		]);
	});

	it("follows the language rather than the host: a string's characters, writes to primitives, and folds' limits", async () => {
		await expectShapes([
			['const o = { ..."x" };\nif ((o as any)[0] === "x") A;', "bad"],
			['const { ...o } = "x" as any;\nif (o[0] === "x") A;', "bad"],
			['for (const k in "x" as any) { if (k === "0") A; }', "bad"],
			['for (const c of "ab") { if (c === "b") A; }', "bad"],
			['if ("abc"[1] === "b") A;', "bad"],
			["try { (1 as any).x = 2; } catch { A; }", "bad"],
			["(1 as any).x = 2;\nA;", "fine"],
			["3n ** 1000000n;\nA;", "bad"],
			["try { 2n ** -1n; } catch { A; }", "bad"],
		]);
		// Hand-written CommonJS, strict only where a directive, `alwaysStrict` or module syntax makes TypeScript emit it so.
		const script = (body: string, prologue = ""): Files => ({
			"a.js": 'require("./b");\nexports.A = 1;',
			"b.js": `${prologue}const a = require("./a");\n${body}`,
		});
		const judged = async (files: Files, strict = false) =>
			(await judge(files, { ...SCRIPTS, strict }, ["a.js", "b.js"], ["a.js"])).verdict;
		const module: Files = {
			"a.js": 'import "./b";\nexport const A = 1;',
			"b.js": 'import { A } from "./a";\ntry { (1).x = 2; } catch { A; }',
		};
		expect({
			sloppy: await judged(script("(1).x = 2;\nexports.B = a.A;")),
			directive: await judged(script("(1).x = 2;\nexports.B = a.A;", '"use strict";\n')),
			alwaysStrict: await judged(script("(1).x = 2;\nexports.B = a.A;"), true),
			moduleSyntax: await judged(module),
			sloppyThis: await judged(script("function f() { if (this === undefined) a.A; }\nf();")),
			globalWrite: await judged(script("function f() { this.x = 1; a.A; }\nf();")),
		}).toEqual({
			sloppy: "bad",
			directive: "fine",
			alwaysStrict: "fine",
			moduleSyntax: "bad",
			sloppyThis: "fine",
			globalWrite: "unknown",
		});
	});

	it("evaluates a computed delete's key, and runs what instanceof and in run", async () => {
		await expectShapes([
			["const o: Record<string, number> = {};\ndelete o[A];", "bad"],
			["class C { static [Symbol.hasInstance](_: unknown) { A; return true; } }\n0 instanceof C;", "bad"],
			["class C {}\nconst is = ({}) instanceof C;\nA;", "bad"],
			["try { ({}) instanceof ((() => {}) as any); } catch { A; }", "bad"],
			["class C {}\nif (C.prototype instanceof C) A;", "fine"],
			["class C {}\nclass D extends C {}\nif (D.prototype instanceof C) A;", "bad"],
			["try { 0 instanceof ((() => {}) as any); } catch { A; }", "fine"],
			['try { "p" in (1 as never); } catch { A; }', "bad"],
			['"p" in (1 as never);\nA;', "fine"],
		]);
	});

	it("throws where an operator's fold throws, and leaves a catch unknown where one may", async () => {
		await expectShapes([
			["const x = 1n + (1 as never);\nA;", "fine"],
			["const x = 1n / 0n;\nA;", "fine"],
			["try { const x = 1n + (1 as never); } catch { A; }", "bad"],
			["try { const x = -1n; } catch { A; }", "fine"],
			["try { const x = (unseen as unknown as number) * 2; } catch { A; }", "unknown"],
		]);
	});

	it("takes an object a constructor returns for its instance, and throws where a derived one returns a primitive or leaves this unbound", async () => {
		const getter = "get x() { return A; }";
		const derived = (body: string) =>
			`class P {}\nclass C extends P { constructor() { ${body} } }\ntry { new C(); } catch { A; }`;
		await expectShapes([
			[`class C { constructor() { return { x: 1 } as never; } ${getter} }\nnew C().x;`, "fine"],
			[`class C { constructor() { return 1 as never; } ${getter} }\nnew C().x;`, "bad"],
			[derived("super();"), "fine"],
			[derived("super();\nreturn 1 as never;"), "bad"],
			[derived("return undefined;"), "bad"],
			[derived("return {} as never;"), "fine"],
			[derived("super();\nsuper();"), "bad"],
		]);
	});

	it("binds a literal's items one at a time in for of and for in", async () => {
		await expectShapes([
			["for (const i of [1]) { if (i === 2) A; }", "fine"],
			["for (const i of [1, 2]) { if (i === 2) A; }", "bad"],
			["for (const i of [1, 2]) { if (i === 1) break; A; }", "fine"],
			["for (const i of [1, 2]) { if (i === 1) continue; A; }", "bad"],
			['for (const k in { a: 1, b: 2 }) { if (k === "c") A; }', "fine"],
			['for (const k in { a: 1, b: 2 }) { if (k === "b") A; }', "bad"],
		]);
	});

	it("throws extending what is no constructor before the class body runs, and constructing one once its arguments run", async () => {
		await expectShapes([
			["class C extends (1 as never) { static x = A; }", "fine"],
			["const f = () => 1;\nclass C extends (f as never) { static x = A; }", "fine"],
			["class C extends (null as never) { static x = A; }", "bad"],
			["try { new ((() => {}) as any)(); } catch { A; }", "bad"],
			["try { new ((async function () {}) as any)(); } catch { A; }", "bad"],
			["function F() {}\ntry { new (F as any)(); } catch { A; }", "fine"],
			["try { new ((() => {}) as any)(A); } catch {}", "bad"],
		]);
	});

	it("applies standard decorators, and runs their initializers where TypeScript's emit does", async () => {
		const context = "c: { addInitializer(f: () => void): void }";
		const adds = `function d(_v: unknown, ${context}) { c.addInitializer(() => A); }`;
		const returns = (value: string) => `function d(_v: unknown, _c: unknown) { return ${value}; }`;
		const throwsOnX = 'function d(_v: unknown, c: { name: unknown }) { if (c.name === "x") throw 1; A; }';
		await expectShapes([
			// Within a category, in source order: a computed name waits its turn.
			[`${throwsOnX}\nclass C { @d static y() {} @d static ["x"]() {} }`, "bad"],
			[`${throwsOnX}\nclass C { @d static x() {} @d static ["y"]() {} }`, "fine"],
			["function d(_v: unknown, _c: unknown) { A; }\n@d class C {}", "bad"],
			[`${adds}\n@d class C {}`, "bad"],
			[`${adds}\nclass C { @d static m() {} }`, "bad"],
			[`${adds}\nclass C { @d m() {} }`, "fine"],
			[`${adds}\nclass C { @d m() {} }\nnew C();`, "bad"],
			[`${returns("undefined")}\nclass C { @d static m() { return A; } }\nC.m();`, "bad"],
			[`${returns("() => 1")}\nclass C { @d static m() { return A; } }\nC.m();`, "unknown"],
			[`${returns("(x: number) => A")}\nclass C { @d static x = 1; }`, "bad"],
			[`${returns("(x: number) => A")}\nclass C { @d x = 1; }`, "fine"],
			[`${returns("(x: number) => A")}\nclass C { @d x = 1; }\nnew C();`, "bad"],
			[`${returns("class {}")}\n@d class C { static m() { return A; } }\nC.m();`, "unknown"],
		]);
	});
});
