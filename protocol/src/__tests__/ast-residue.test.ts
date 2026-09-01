import { describe, expect, it } from "bun:test";
import { parseSource, reachedCalls } from "../astResidue";

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

	const innocent: Array<[string, string]> = [
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
