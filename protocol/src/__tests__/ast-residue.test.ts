import { describe, expect, it } from "bun:test";
import { instantiates, parseSource, reachedCalls } from "../astResidue";

const FS = new Set(["node:fs", "node:fs/promises"]);
const READERS = new Set(["readFileSync", "readFile"]);

function reached(source: string): string[] {
	return reachedCalls(parseSource("probe.ts", source).source, FS, READERS).map((hit) => hit.name);
}

describe("reachedCalls follows a binding rather than a spelling", () => {
	const laundered: Array<[string, string]> = [
		[
			"a plain named import",
			`import { readFileSync } from "node:fs";\nconst use = (p: string) => readFileSync(p);`,
		],
		["an aliased import", `import { readFileSync as slurp } from "node:fs";\nconst use = (p: string) => slurp(p);`],
		["a namespace member", `import * as fs from "node:fs";\nconst use = (p: string) => fs.readFileSync(p);`],
		[
			"element access on a namespace",
			`import * as fs from "node:fs";\nconst use = (p: string) => fs["readFileSync"](p);`,
		],
		[
			"a variable holding the member",
			`import * as fs from "node:fs";\nconst read = fs.readFileSync;\nconst use = (p: string) => read(p);`,
		],
		[
			"an element-access alias",
			`import * as fs from "node:fs";\nconst read = fs["readFileSync"];\nconst use = (p: string) => read(p);`,
		],
		[
			"a destructure off a namespace",
			`import * as fs from "node:fs";\nconst { readFileSync } = fs;\nconst use = (p: string) => readFileSync(p);`,
		],
		[
			"a chain of aliases",
			`import { readFileSync as a } from "node:fs";\nconst b = a;\nconst c = b;\nconst use = (p: string) => c(p);`,
		],
		[
			"bind",
			`import * as fs from "node:fs";\nconst read = fs.readFileSync.bind(fs);\nconst use = (p: string) => read(p);`,
		],
		["call", `import * as fs from "node:fs";\nconst use = (p: string) => fs.readFileSync.call(null, p);`],
		["apply", `import * as fs from "node:fs";\nconst use = (p: string) => fs.readFileSync.apply(null, [p]);`],
		["require", `const fs = require("node:fs");\nconst use = (p: string) => fs.readFileSync(p);`],
		[
			"a locally required namespace",
			`function use(p: string) {\n\tconst fs = require("node:fs");\n\treturn fs.readFileSync(p);\n}`,
		],
		[
			"a function-scoped var namespace",
			`function use(p: string) {\n\tif (p) { var fs = require("node:fs"); }\n\treturn fs.readFileSync(p);\n}`,
		],
		[
			"a namespace-local var namespace",
			`namespace N {\n\tvar fs = require("node:fs");\n\tfs.readFileSync("x");\n}`,
		],
		[
			"a dynamic import destructure",
			`async function use(p: string) {\n\tconst { readFileSync } = await import("node:fs");\n\treturn readFileSync(p);\n}`,
		],
		[
			"handing the function on rather than calling it",
			`import { readFileSync } from "node:fs";\nconst use = (paths: string[]) => paths.map(readFileSync);`,
		],
	];

	for (const [label, source] of laundered) {
		it(`follows ${label}`, () => {
			expect(reached(source)).not.toHaveLength(0);
		});
	}

	it("leaves a catch binding alone", () => {
		expect(reached(`import * as fs from "node:fs";\ntry {} catch (fs) { fs.readFileSync("x"); }`)).toEqual([]);
	});

	it("keeps an outer namespace visible after an inner block shadow", () => {
		expect(
			reached(
				`import * as fs from "node:fs";\nfunction use(p: string) {\n\t{ const fs = other; fs.readFileSync(p); }\n\treturn fs.readFileSync(p);\n}`,
			),
		).toEqual(["fs.readFileSync"]);
	});

	const innocent: Array<[string, string]> = [
		[
			"a namespace-local var shadowing the import",
			`import * as fs from "node:fs";\nnamespace N {\n\tvar fs = other;\n\tfs.readFileSync("x");\n}`,
		],
		[
			"a named function expression shadowing the namespace",
			`import * as fs from "node:fs";\nconst run = function fs() { fs.readFileSync("x"); };`,
		],
		[
			"a static block var shadowing the namespace",
			`import * as fs from "node:fs";\nclass C { static { var fs = other; fs.readFileSync("x"); } }`,
		],
		[
			"a block-local function shadowing the namespace",
			`import * as fs from "node:fs";\nfunction use() {\n\t{ function fs() {} fs.readFileSync("x"); }\n}`,
		],
		[
			"a block-local class shadowing the namespace",
			`import * as fs from "node:fs";\nfunction use() {\n\t{ class fs {} fs.readFileSync("x"); }\n}`,
		],
		[
			"a same-named local",
			`function readFileSync(p: string) {\n\treturn p;\n}\nconst use = (p: string) => readFileSync(p);`,
		],
		[
			"an injected parameter",
			`function use(readFileSync: (p: string) => string, p: string) {\n\treturn readFileSync(p);\n}`,
		],
		[
			"a parameter SHADOWING the import",
			`import { readFileSync } from "node:fs";\nfunction use(readFileSync: (p: string) => string, p: string) {\n\treturn readFileSync(p);\n}`,
		],
		[
			"the same member on an unrelated module",
			`import { readFileSync } from "./own-helper.js";\nconst use = (p: string) => readFileSync(p);`,
		],
		[
			"a same-named method on another object",
			`const other = { readFileSync: (p: string) => p };\nother.readFileSync("x");`,
		],
	];

	for (const [label, source] of innocent) {
		it(`leaves ${label} alone`, () => {
			expect(reached(source)).toEqual([]);
		});
	}
});

describe("instantiates", () => {
	it("finds a generic call, a qualified one, and a qualified type", () => {
		const found = (source: string) =>
			instantiates(parseSource("probe.ts", source).source, new Set(["moduleStore", "ModuleStore"]));

		expect([
			found(`const store = moduleStore<State>(handlers);`),
			found(`const store = kit.moduleStore<State>(handlers);`),
			found(`let store: kit.ModuleStore<State>;`),
			found(`const store = moduleStore(handlers);`),
		]).toEqual([true, true, true, false]);
	});
});
