import { describe, expect, it } from "bun:test";
import { RouteEdgeSchema, StoredFactSchema } from "../daemonShapes";
import { exportFactId, importFactId } from "../factId";
import { ExportSchema, ImportEdgeSchema } from "../project";

////////////////////////////////
//  Helpers

const SPAN = { start: { line: 0, character: 0 }, end: { line: 0, character: 9 } };

const NAME = { start: { line: 0, character: 9 }, end: { line: 0, character: 12 } };

const EXCLUDE = { priority: 0, amongTransfers: "exclude", againstLocal: "localWins" } as const;

const LATER = { priority: 0, amongTransfers: "laterWins", againstLocal: "sourceOrder" } as const;

const edge = <T extends object>(fields: T) =>
	({ span: SPAN, certainty: { status: "known" }, order: 0, ...fields }) as const;

/** `export { add } from "./a"`: the import edge binds nothing; the export forwards it. */
const FORWARDED = edge({ kind: "named", name: "add", range: NAME, bindsLocally: false } as const);

const FORWARD = edge({
	form: "forward",
	name: "add",
	range: NAME,
	target: { kind: "import", span: SPAN },
	conflict: EXCLUDE,
} as const);

const ROUTE = {
	fact: "export",
	id: exportFactId("src/b.ts", FORWARD),
	from: "src/b.ts",
	form: "forward",
	name: "add",
	state: "renamed",
} as const;

////////////////////////////////
//  Tests

describe("what an edge may say", () => {
	it("takes the transfers languages write", () => {
		const imports = [
			FORWARDED,
			// Python `from .m import *`
			edge({ kind: "wildcard", bindsLocally: true, selector: { kind: "allList" }, conflict: LATER }),
			// C `#include "m.h"`
			edge({ kind: "injection", bindsLocally: true, selector: { kind: "visible" }, conflict: EXCLUDE }),
			// `export * as ns from "./m"`
			edge({ kind: "namespace", local: "ns", localRange: NAME, bindsLocally: false }),
			// `import "./polyfill"`
			edge({ kind: "sideEffect", bindsLocally: false }),
		];
		const exports = [
			FORWARD,
			edge({
				form: "star",
				target: FORWARD.target,
				selector: { kind: "names", names: ["add"] },
				conflict: EXCLUDE,
			}),
			edge({
				form: "default",
				name: "default",
				target: { kind: "unknown", reason: "NotIndexed" },
				conflict: EXCLUDE,
			}),
			edge({
				form: "assignment",
				target: { kind: "symbol", symbolId: "lexicon ts src/a.ts add()." },
				conflict: EXCLUDE,
			}),
		];

		expect(imports.filter((one) => !ImportEdgeSchema.safeParse(one).success)).toEqual([]);
		expect(exports.filter((one) => !ExportSchema.safeParse(one).success)).toEqual([]);
		expect(RouteEdgeSchema.safeParse(ROUTE).success).toBe(true);
	});

	it("refuses an edge its form contradicts", () => {
		const stored = { fact: "import", factId: importFactId("src/c.ts", "./a", FORWARDED), module: "src/c.ts" };
		const refused = [
			ExportSchema.safeParse({ ...FORWARD, target: { kind: "unknown", reason: "NotIndexed" } }),
			ExportSchema.safeParse({ ...FORWARD, selector: { kind: "names", names: [] } }),
			ImportEdgeSchema.safeParse(
				edge({
					kind: "wildcard",
					local: "m",
					localRange: NAME,
					bindsLocally: true,
					selector: { kind: "allList" },
					conflict: LATER,
				}),
			),
			ImportEdgeSchema.safeParse({ ...FORWARDED, bindsLocally: true }),
			RouteEdgeSchema.safeParse({ ...ROUTE, state: "unknown", landing: { kind: "module", module: "src/a.ts" } }),
			StoredFactSchema.safeParse({ ...stored, specifier: "./a", landing: null, ...FORWARDED, name: undefined }),
		];

		expect(refused.map((result) => result.success)).toEqual(refused.map(() => false));
	});
});
