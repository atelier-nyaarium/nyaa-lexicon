import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Binding, ReferenceRole, SymbolKind } from "@nyaa-lexicon/protocol";
import { IndexReadModel } from "../indexReads";
import { LexiconService } from "../service";
import { fromText } from "../sourceRead";
import { IndexStore } from "../store";
import { fakeSupervisor } from "./fakeProvider";
import { edge, landed } from "./importEdges";

////////////////////////////////
//  Helpers

let dir: string;
let store: IndexStore;
let reads: IndexReadModel;

const at = (line: number) => ({ start: { line, character: 0 }, end: { line, character: 8 } });

const LEDGER = "lexicon reference a.ref Ledger#";
const WRITE = `${LEDGER}write().`;
const FIELD_VALUES = `${LEDGER}fieldValues().`;
const VALUES = `${WRITE}values.`;
const FIELD = `${FIELD_VALUES}field.`;
const HELPER = "lexicon reference b.ref helper().";
const BOOT = "lexicon reference b.ref boot().";
const LOOP = "lexicon reference c.ref loop().";
const TWIN = "lexicon reference c.ref twin().";

function declared(symbolId: string, kind: SymbolKind, name: string, line: number, containerId?: string) {
	return {
		symbolId,
		kind,
		name,
		range: at(line),
		selectionRange: at(line),
		visibility: "public" as const,
		...(containerId === undefined ? {} : { containerId }),
	};
}

/** A null `fromId` writes the site at module level. */
function use(name: string, role: ReferenceRole, fromId: string | null, line: number, binding: Binding | string) {
	return {
		name,
		range: at(line),
		role,
		...(fromId === null ? {} : { fromId }),
		binding:
			typeof binding === "string"
				? ({ status: "bound", symbolId: binding, provenance: "bound" } as const)
				: binding,
	};
}

function plant(): void {
	store.replaceFile({
		module: "a.ref",
		contentHash: "a1",
		declarations: [
			declared(LEDGER, "class", "Ledger", 0),
			declared(WRITE, "method", "write", 1, LEDGER),
			declared(VALUES, "variable", "values", 2, WRITE),
			declared(FIELD_VALUES, "method", "fieldValues", 5, LEDGER),
			declared(FIELD, "variable", "field", 6, FIELD_VALUES),
		],
		references: [
			use("fieldValues", "call", VALUES, 2, FIELD_VALUES),
			use("helper", "call", WRITE, 3, HELPER),
			use("Ledger", "typeUse", WRITE, 3, LEDGER),
			use("boot", "call", WRITE, 4, BOOT),
			use("field", "read", FIELD_VALUES, 7, FIELD),
			use("trim", "call", FIELD_VALUES, 7, { status: "unbound", reason: "ExternalDependency" }),
			use("ok", "read", FIELD_VALUES, 8, {
				status: "ambiguous",
				candidates: [WRITE, HELPER],
				provenance: "bound",
			}),
			use("refusal", "read", FIELD_VALUES, 8, { status: "unbound", reason: "NotIndexed" }),
			use("helper", "call", FIELD_VALUES, 9, HELPER),
		],
	});
	store.replaceFile({
		module: "b.ref",
		contentHash: "b1",
		declarations: [declared(HELPER, "function", "helper", 0), declared(BOOT, "function", "boot", 2)],
		references: [use("Ledger", "instantiate", BOOT, 3, LEDGER), use("Ledger", "typeUse", BOOT, 3, LEDGER)],
	});
}

beforeEach(() => {
	dir = mkdtempSync(path.join(tmpdir(), "lexicon-edges-"));
	store = IndexStore.open(path.join(dir, "index.sqlite")).store;
	reads = new IndexReadModel(store);
	plant();
});

afterEach(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

////////////////////////////////
//  Tests

describe("a call written in a local", () => {
	it("belongs to the method owning the local, in both directions", () => {
		expect({
			callers: reads.callHierarchy(FIELD_VALUES).incoming.map((edge) => edge.symbol.name),
			callees: reads.callHierarchy(WRITE).outgoing.map((edge) => edge.symbol.name),
		}).toEqual({ callers: ["write"], callees: ["fieldValues", "helper", "boot"] });
	});
});

describe("a method's edges", () => {
	it("group its callers, and fold its locals, library names, unbound names and namespaces", () => {
		const edges = reads.symbolEdges(FIELD_VALUES, new Map([["refusal", { module: "refusals.ref" }]]));

		expect({
			incoming: edges.incoming.groups.map((group) => [group.role, group.peers.map((peer) => peer.symbol?.name)]),
			outgoing: edges.outgoing.groups.map((group) => [group.role, group.peers.map((peer) => peer.symbol?.name)]),
			internal: edges.outgoing.internal,
			modules: edges.outgoing.modules,
			library: edges.outgoing.library.names.map((entry) => entry.name),
			unresolved: edges.outgoing.unresolved.names.map((entry) => entry.name),
		}).toEqual({
			incoming: [["call", ["write"]]],
			outgoing: [["call", ["helper"]]],
			internal: 1,
			modules: [{ module: "refusals.ref", sites: 1 }],
			library: ["trim"],
			unresolved: ["ok"],
		});
	});

	it("reads a namespace it cannot place, or an ambiguous name, as unresolved", () => {
		const { outgoing } = reads.symbolEdges(FIELD_VALUES, new Map([["ok", { module: "x.ref" }]]));

		expect({ modules: outgoing.modules, unresolved: outgoing.unresolved.names.map((entry) => entry.name) }).toEqual(
			{
				modules: [],
				unresolved: ["ok", "refusal"],
			},
		);
	});
});

describe("a class's edges", () => {
	it("count what created it by role, set its own uses apart, and merge its members' uses", () => {
		const edges = reads.symbolEdges(LEDGER, new Map());

		expect({
			incoming: edges.incoming.groups.map((group) => [
				group.role,
				group.peers.map((peer) => [peer.symbol?.name, peer.roles]),
			]),
			self: edges.incoming.internal,
			helper: edges.outgoing.groups.find((group) => group.role === "call")?.peers[0],
			internal: edges.outgoing.internal,
		}).toEqual({
			incoming: [["instantiate", [["boot", { instantiate: 1, typeUse: 1 }]]]],
			self: 1,
			helper: expect.objectContaining({
				symbol: expect.objectContaining({ name: "helper" }),
				sites: 2,
				holders: 2,
			}),
			internal: 3,
		});
	});

	it("caps each group while counting every peer", () => {
		const edges = reads.symbolEdges(LEDGER, new Map(), 1);
		const calls = edges.outgoing.groups.find((group) => group.role === "call");

		expect({ shown: calls?.peers.length, total: calls?.total }).toEqual({ shown: 1, total: 2 });
	});
});

describe("a recursive function's edges", () => {
	/** loop calls itself, twin, helper and a symbol no longer indexed; c.ref calls loop at module level. */
	it("count recursion as internal, a top-level caller by module, and rank its own file first", () => {
		store.replaceFile({
			module: "c.ref",
			contentHash: "c1",
			declarations: [declared(LOOP, "function", "loop", 0), declared(TWIN, "function", "twin", 5)],
			references: [
				use("loop", "call", LOOP, 1, LOOP),
				use("helper", "call", LOOP, 2, HELPER),
				use("twin", "call", LOOP, 3, TWIN),
				use("gone", "call", LOOP, 4, "lexicon reference z.ref gone()."),
				use("loop", "call", null, 7, LOOP),
			],
		});

		const edges = reads.symbolEdges(LOOP, new Map());

		expect({
			self: edges.incoming.internal,
			callers: edges.incoming.groups.map((group) => group.peers.map((peer) => [peer.symbol?.name, peer.module])),
			callees: edges.outgoing.groups.map((group) => group.peers.map((peer) => peer.symbol?.name)),
			unresolved: edges.outgoing.unresolved.names.map((entry) => entry.name),
		}).toEqual({
			self: 1,
			callers: [[[undefined, "c.ref"]]],
			callees: [["twin", "helper"]],
			unresolved: ["gone"],
		});
	});
});

describe("namespace imports", () => {
	it("count a namespace or require name toward its module and a package's toward library; a default or twice-bound name stays unresolved", async () => {
		const RUN = "lexicon ts src/app.ts run().";
		const binding = (
			specifier: string,
			local: string,
			kind: "namespace" | "require" | "default",
			line: number,
		) => ({
			specifier,
			edges: [edge(kind, at(line), { local, localRange: at(line) })],
		});
		store.replaceFile({
			module: "src/app.ts",
			contentHash: "s1",
			declarations: [declared(RUN, "function", "run", 2)],
			references: ["lib", "fs", "dflt", "twice"].map((name, line) =>
				use(name, "read", RUN, line + 3, { status: "unbound", reason: "NotIndexed" }),
			),
			imports: [
				binding("./lib", "lib", "namespace", 10),
				binding("fs", "fs", "require", 11),
				binding("./dflt", "dflt", "default", 12),
				binding("./one", "twice", "namespace", 13),
				binding("./two", "twice", "namespace", 14),
			],
		});
		const service = new LexiconService(
			store,
			fakeSupervisor({
				claims: [{ providerId: "fake", language: "fake", extensions: [".ts"] }],
				answers: {
					resolveImport: (params) =>
						params.specifier.startsWith(".")
							? landed(`src/${params.specifier.slice(2)}.ts`)
							: { status: "external", packageName: params.specifier },
				},
			}),
			fromText(() => null),
			dir,
		);

		const { outgoing } = await service.symbolEdges(RUN);

		expect({
			modules: outgoing.modules.map((entry) => entry.module),
			library: outgoing.library.names.map((entry) => entry.name),
			unresolved: outgoing.unresolved.names.map((entry) => entry.name),
		}).toEqual({ modules: ["src/lib.ts"], library: ["fs"], unresolved: ["dflt", "twice"] });
	});
});
