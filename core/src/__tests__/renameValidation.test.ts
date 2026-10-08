import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	composeSymbolId,
	type Declaration,
	type FileFacts,
	type ProbeBatchResponse,
	type Range,
	type Reference,
} from "@nyaa-lexicon/protocol";
import type { ProviderProbe } from "../providerProbe";
import { proveRename, type RenameCandidate } from "../renameValidation";
import { IndexStore } from "../store";
import { direct, forwarding, landed, named } from "./importEdges";

////////////////////////////////
//  Helpers

let dir: string;
let store: IndexStore;

function idOf(module: string, name: string): string {
	return composeSymbolId({ language: "ts", module, descriptors: [{ kind: "term", name }] });
}

function at(line: number, start: number, length = 1): Range {
	return { start: { line, character: start }, end: { line, character: start + length } };
}

function declared(module: string, name: string): Declaration {
	return {
		symbolId: idOf(module, name),
		kind: "variable",
		name,
		range: at(0, 0, name.length),
		selectionRange: at(0, 0, name.length),
		visibility: "public",
		exported: true,
	};
}

const N = idOf("d.ts", "N");
const M = idOf("d.ts", "Mm");
const Q = idOf("q.ts", "Q");

/** A read of `name` at `range`, bound to `target` through the import spanning `span`; ambiguous when `target` is "ambiguous". */
function use(name: string, range: Range, target: string | null, span: Range): Reference {
	const binding: Reference["binding"] =
		target === null
			? { status: "unbound", reason: "NotIndexed" }
			: target === "ambiguous"
				? { status: "ambiguous", candidates: [N, Q], provenance: "bound" }
				: { status: "bound", symbolId: target, provenance: "bound" };
	return { name, range, role: "read", binding, origin: { kind: "import", span } };
}

/** `d.ts` declares `name`; `use.ts` imports it and reads it, then `Q` beside it on one line, plus `extra`, all through that import. */
function facts(name: string, extra: Reference[] = [], first: string | null = idOf("d.ts", name)): FileFacts[] {
	const declaration = declared("d.ts", name);
	const span = at(0, 9, name.length);
	const through = (each: Reference): Reference => ({ ...each, origin: { kind: "import", span } });
	return [
		{
			module: "d.ts",
			contentHash: `d ${name}`,
			declarations: [declaration],
			references: [],
			imports: [],
			exports: [direct(declaration)],
			literals: [],
			diagnostics: [],
		},
		{
			module: "use.ts",
			contentHash: `use ${name}`,
			declarations: [],
			references: [
				use(name, at(1, 0, name.length), first, span),
				use("Q", at(1, name.length + 3), Q, span),
				...extra.map(through),
			],
			imports: [named("./d", name, span)],
			literals: [],
			diagnostics: [],
		},
	];
}

function write(all: readonly FileFacts[]): void {
	for (const each of all) {
		store.replaceFile({
			module: each.module,
			contentHash: each.contentHash,
			declarations: each.declarations,
			references: each.references,
			imports: each.imports,
			exports: each.exports,
			provider: "fake",
			resolutions: new Map(each.module === "use.ts" ? [["./d", landed("d.ts")]] : []),
		});
	}
	store.settleProjections();
}

/** A provider that answers each batch with `answer`. */
function probing(answer: ProbeBatchResponse): ProviderProbe {
	const never = () => Promise.reject(new Error("not asked"));
	return {
		owner: () => ({ owned: true, providerId: "fake" }),
		declares: () => false,
		words: () => null,
		parseCandidate: never,
		renameEdits: never,
		moveEdits: never,
		arrangeEdits: never,
		importEdits: never,
		probeBatch: async () => answer,
	};
}

/** N to Mm, one character longer, so what follows a site on its line moves. */
const RENAME: RenameCandidate = {
	proposed: [
		{ module: "d.ts", before: "N", text: "Mm", edits: [{ range: at(0, 0), newText: "Mm" }] },
		{
			module: "use.ts",
			before: 'import { N } from "./d";\nN + Q;\nMm;\n',
			text: 'import { Mm } from "./d";\nMm + Q;\nMm;\n',
			edits: [
				{ range: at(0, 9), newText: "Mm" },
				{ range: at(1, 0), newText: "Mm" },
			],
		},
	],
	affected: ["d.ts", "use.ts"],
	idMap: new Map([[N, M]]),
	subject: N,
	sites: new Map([
		["d.ts", [{ range: at(0, 0) }]],
		[
			"use.ts",
			[
				{ range: at(0, 9), role: "import" },
				{ range: at(1, 0), role: "read" },
			],
		],
	]),
	projected: [
		{
			landing: { kind: "module", module: "d.ts" },
			rows: [{ name: "Mm", origin: { kind: "symbol", symbolId: N }, certainty: { status: "known" } }],
		},
	],
};

function ready(all: FileFacts[]): ProbeBatchResponse {
	return {
		status: "ready",
		facts: all,
		landings: [{ module: "use.ts", specifier: "./d", resolution: landed("d.ts") }],
	};
}

async function sitesOf(answer: ProbeBatchResponse): Promise<unknown> {
	return (await proveRename(store, probing(answer), RENAME)).map(({ kind, sites }) => ({ kind, sites }));
}

beforeEach(() => {
	dir = mkdtempSync(path.join(tmpdir(), "lexicon-proof-"));
	store = IndexStore.open(path.join(dir, "index.sqlite")).store;
	write(facts("N", [use("Mm", at(2, 0, 2), null, at(0, 9))]));
});

afterEach(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

////////////////////////////////
//  Tests

describe("proving a rename before it writes", () => {
	it("passes when every use binds as planned past the edits, and leaves the index as it was", async () => {
		const blockers = await proveRename(
			store,
			probing(ready(facts("Mm", [use("Mm", at(2, 0, 2), null, at(0, 9))]))),
			RENAME,
		);

		expect(blockers).toEqual([]);
		expect(store.declarationsIn("d.ts").map((row) => row.name)).toEqual(["N"]);
	});

	it("matches a compound assignment's read and write by role, refusing a captured read", async () => {
		const both = (read: string): Reference[] => [
			use("Mm", at(2, 0, 2), null, at(0, 9)),
			use("Q", at(3, 0), read, at(0, 9)),
			{ ...use("Q", at(3, 0), Q, at(0, 9)), role: "write" },
		];
		write(facts("N", both(Q)));

		expect({
			kept: await sitesOf(ready(facts("Mm", both(Q)))),
			captured: await sitesOf(ready(facts("Mm", both(M)))),
		}).toEqual({
			kept: [],
			captured: [{ kind: "ProofUnavailable", sites: [{ module: "use.ts", line: 4 }] }],
		});
	});

	it("refuses a capture, a lost exposure, an old declaration left standing, an export off the plan, or a provider that cannot prove its share", async () => {
		const [declaring, using] = facts("Mm", [use("Mm", at(2, 0, 2), null, at(0, 9))]) as [FileFacts, FileFacts];
		const old = declared("d.ts", "N");

		expect({
			captured: await sitesOf(ready(facts("Mm", [use("Mm", at(2, 0, 2), M, at(0, 9))]))),
			hidden: await sitesOf(ready([{ ...declaring, exports: [] }, using])),
			standing: await sitesOf(ready([{ ...declaring, declarations: [...declaring.declarations, old] }, using])),
			leaked: await sitesOf(
				ready([declaring, { ...using, exports: [forwarding("forward", at(0, 9, 2), { name: "Z" })] }]),
			),
			unsupported: await sitesOf({ status: "unsupported", detail: "no proof" }),
		}).toEqual({
			captured: [{ kind: "ProofUnavailable", sites: [{ module: "use.ts", line: 3 }] }],
			hidden: [{ kind: "ProofUnavailable", sites: [{ module: "d.ts", line: 1 }] }],
			standing: [{ kind: "ProofUnavailable", sites: [{ module: "d.ts", line: 1 }] }],
			leaked: [{ kind: "ProofUnavailable", sites: [{ module: "use.ts", line: 1 }] }],
			unsupported: [{ kind: "ProofUnavailable", sites: [{ module: "d.ts", line: 1 }] }],
		});
	});

	it("refuses a site that was ambiguous and binds nothing after, and passes one the rename resolves", async () => {
		write(facts("N", [use("Mm", at(2, 0, 2), null, at(0, 9))], "ambiguous"));
		const extra = [use("Mm", at(2, 0, 2), null, at(0, 9))];

		expect({
			dangling: await sitesOf(ready(facts("Mm", extra, null))),
			resolved: await sitesOf(ready(facts("Mm", extra))),
		}).toEqual({
			dangling: [{ kind: "ProofUnavailable", sites: [{ module: "use.ts", line: 2 }] }],
			resolved: [],
		});
	});

	it("finds a site's use anywhere in the text its edit wrote, as a shorthand expands", async () => {
		const [declaring, using] = facts("Mm", [use("Mm", at(2, 0, 2), null, at(0, 9))]) as [FileFacts, FileFacts];
		const span = at(0, 9, 2);
		const expanded: FileFacts = {
			...using,
			references: [
				use("N", at(1, 0), null, span),
				use("Mm", at(1, 3, 2), M, span),
				use("Q", at(1, 8), Q, span),
				use("Mm", at(2, 0, 2), null, span),
			],
		};
		const [, plain] = RENAME.proposed as [unknown, RenameCandidate["proposed"][number]];
		const candidate: RenameCandidate = {
			...RENAME,
			proposed: [
				RENAME.proposed[0] as RenameCandidate["proposed"][number],
				{
					...plain,
					text: 'import { Mm } from "./d";\nN: Mm + Q;\nMm;\n',
					edits: [
						{ range: at(0, 9), newText: "Mm" },
						{ range: at(1, 0), newText: "N: Mm" },
					],
				},
			],
		};

		expect(await proveRename(store, probing(ready([declaring, expanded])), candidate)).toEqual([]);
	});
});
