import { describe, expect, it } from "bun:test";
import {
	composeSymbolId,
	type DaemonMethod,
	type Descriptor,
	type IndexOutcome,
	type ModuleDeclarations,
	type RequestOf,
	type ResponseOf,
	type StoredDeclaration,
	type SymbolKind,
} from "@nyaa-lexicon/protocol";
import { awaitIndexed } from "../awaitIndexed";
import { resolveChain } from "../chain";
import type { Session } from "../connect";
import { DaemonError } from "../errors";

////////////////////////////////
//  Helpers

type Answers = { [M in DaemonMethod]?: (params: RequestOf<M>) => ResponseOf<M> };

/** A session that answers from a table and remembers what it was asked. */
function stub(answers: Answers): Pick<Session, "ask"> & { asked: string[] } {
	const asked: string[] = [];
	return {
		asked,
		ask: async (method, params) => {
			asked.push(method);
			const answer = answers[method];
			if (answer === undefined) throw new Error(`the stub has no ${method}`);
			return (answer as (p: unknown) => unknown)(params) as never;
		},
	};
}

const MODULE = "src/app.ts";
const HASH = "a".repeat(32);

function id(...descriptors: Descriptor[]): string {
	return composeSymbolId({ language: "ts", module: MODULE, descriptors });
}

function at(line: number, character: number) {
	return { line, character };
}

function declare(
	symbolId: string,
	kind: SymbolKind,
	name: string,
	span: { from: [number, number]; to: [number, number] },
	containerId?: string,
): StoredDeclaration {
	return {
		symbolId,
		factId: `fact ${symbolId}`,
		module: MODULE,
		kind,
		name,
		range: { start: at(...span.from), end: at(...span.to) },
		selectionRange: { start: at(...span.from), end: at(span.from[0], span.from[1] + name.length) },
		visibility: "public",
		...(containerId === undefined ? {} : { containerId }),
	};
}

const OUTER = id({ kind: "namespace", name: "Outer" });
const INNER = id({ kind: "namespace", name: "Outer" }, { kind: "namespace", name: "Inner" });
const DEEP = id(
	{ kind: "namespace", name: "Outer" },
	{ kind: "namespace", name: "Inner" },
	{ kind: "method", name: "deep" },
);
const SERVICE = id({ kind: "type", name: "Service" });
const RUN_METHOD = id({ kind: "type", name: "Service" }, { kind: "method", name: "run" });
const FIRST = id(
	{ kind: "type", name: "Service" },
	{ kind: "method", name: "run" },
	{ kind: "parameter", name: "first" },
);
const SECOND = id(
	{ kind: "type", name: "Service" },
	{ kind: "method", name: "run" },
	{ kind: "parameter", name: "second" },
);
const RUN_FUNCTION = id({ kind: "method", name: "run" });
const ACME = id({ kind: "namespace", name: "Acme.Services" });
const API = id({ kind: "namespace", name: "Acme.Services" }, { kind: "type", name: "Api" });
const COMPUTE = id({ kind: "method", name: "compute" });
const QTY = id({ kind: "method", name: "compute" }, { kind: "parameter", name: "qty" });
const VERSION = id({ kind: "meta", name: "Version 1.2" });
const SETUP = id({ kind: "meta", name: "Node.js setup" });
/** An out-of-line definition: its id names the scope, no declaration in the module does. */
const STEP = id(
	{ kind: "namespace", name: "Physics" },
	{ kind: "type", name: "World" },
	{ kind: "method", name: "step" },
);

/** Handed over out of document order on purpose; the walk sorts. */
const DECLARATIONS: StoredDeclaration[] = [
	declare(RUN_FUNCTION, "function", "run", { from: [15, 0], to: [15, 30] }),
	declare(OUTER, "namespace", "Outer", { from: [0, 0], to: [6, 1] }),
	declare(INNER, "namespace", "Inner", { from: [1, 1], to: [5, 2] }, OUTER),
	declare(DEEP, "function", "deep", { from: [2, 2], to: [4, 3] }, INNER),
	declare(SERVICE, "class", "Service", { from: [8, 0], to: [13, 1] }),
	declare(RUN_METHOD, "method", "run", { from: [9, 1], to: [11, 2] }, SERVICE),
	declare(SECOND, "variable", "second", { from: [9, 20], to: [9, 34] }, RUN_METHOD),
	declare(FIRST, "variable", "first", { from: [9, 5], to: [9, 18] }, RUN_METHOD),
	declare(ACME, "namespace", "Acme.Services", { from: [17, 0], to: [20, 1] }),
	declare(API, "class", "Api", { from: [18, 1], to: [18, 20] }, ACME),
	declare(COMPUTE, "function", "compute", { from: [22, 0], to: [24, 1] }),
	// No containerId: the id grammar alone says whose parameter it is.
	declare(QTY, "variable", "qty", { from: [22, 17], to: [22, 28] }),
	declare(VERSION, "heading", "Version 1.2", { from: [26, 0], to: [27, 0] }),
	declare(SETUP, "heading", "Node.js setup", { from: [28, 0], to: [29, 0] }),
	declare(STEP, "method", "step", { from: [31, 0], to: [33, 1] }),
];

const HELD: ModuleDeclarations = {
	module: MODULE,
	exists: true,
	claimed: true,
	provider: "ts",
	indexed: true,
	depth: "full",
	read: { kind: "text" },
	contentHash: HASH,
	diskHash: HASH,
	declarations: DECLARATIONS,
};

function indexed(held: Partial<ModuleDeclarations> = {}) {
	return stub({ moduleDeclarations: () => ({ ...HELD, ...held }) });
}

async function exact(segments: string[]) {
	const answer = await resolveChain(indexed(), MODULE, segments);
	if (answer.kind !== "exact") throw new Error(`${segments.join(" > ")} answered ${answer.kind}`);
	return answer.candidate;
}

async function none(segments: string[], held: Partial<ModuleDeclarations> = {}) {
	const answer = await resolveChain(indexed(held), MODULE, segments);
	if (answer.kind !== "none") throw new Error(`${segments.join(" > ")} answered ${answer.kind}`);
	return answer;
}

////////////////////////////////
//  Tests

describe("resolveChain walks a module's declarations", () => {
	it("names one declaration with the containers above it, and the hashes on every answer", async () => {
		const answer = await resolveChain(indexed(), MODULE, ["Service", "run"]);
		expect(answer).toMatchObject({
			kind: "exact",
			contentHash: HASH,
			diskHash: HASH,
			candidate: {
				symbolId: RUN_METHOD,
				kind: "method",
				containerPath: ["Service"],
				segments: ["Service", "run"],
				range: { start: at(9, 1) },
				selectionRange: { start: at(9, 1) },
			},
		});
	});

	it("reaches a descendant through layers no segment names", async () => {
		expect(await exact(["Outer", "deep"])).toMatchObject({ symbolId: DEEP, containerPath: ["Outer", "Inner"] });
	});

	it("answers every candidate in document order when a name repeats, each with a chain that reaches it alone", async () => {
		const answer = await resolveChain(indexed(), MODULE, ["run"]);
		expect(answer.kind).toBe("ambiguous");
		if (answer.kind !== "ambiguous") return;
		expect(answer.candidates.map((candidate) => candidate.symbolId)).toEqual([RUN_METHOD, RUN_FUNCTION]);
		for (const candidate of answer.candidates) {
			expect((await exact(candidate.segments)).symbolId).toBe(candidate.symbolId);
		}
		expect(answer.candidates.map((candidate) => candidate.segments)).toEqual([["Service", "run"], ["run[2]"]]);
	});

	it("picks the n-th match by ordinal, and nothing past the last", async () => {
		expect((await exact(["run[2]"])).symbolId).toBe(RUN_FUNCTION);
		expect(await none(["run[3]"])).toMatchObject({ reason: "noMatch", matched: { consumed: 0, count: 2 } });
		expect(await none(["run[0]"])).toMatchObject({ reason: "noMatch", matched: { consumed: 0, count: 2 } });
	});

	it("reads a qualified segment as a run of nested names, in either spelling", async () => {
		for (const chain of [
			["Outer.Inner", "deep"],
			["Outer::Inner", "deep"],
			["Outer", "Inner", "deep"],
		]) {
			expect((await exact(chain)).symbolId).toBe(DEEP);
		}
	});

	it("reads a qualified segment, or a run of segments, as a declaration's own dotted name", async () => {
		expect((await exact(["Acme.Services", "Api"])).containerPath).toEqual(["Acme.Services"]);
		expect((await exact(["Acme::Services", "Api"])).symbolId).toBe(API);
		expect((await exact(["Version 1.2"])).symbolId).toBe(VERSION);
		// Joined, the run is the name in full.
		expect((await exact(["Acme", "Services", "Api"])).symbolId).toBe(API);
		expect((await exact(["Acme", "Services"])).symbolId).toBe(ACME);
	});

	it("never matches a proper prefix of a dotted name", async () => {
		expect(await none(["Node"])).toMatchObject({ reason: "noMatch" });
		expect(await none(["Node.js"])).toMatchObject({ reason: "noMatch" });
		expect(await none(["Version"])).toMatchObject({ reason: "noMatch" });
	});

	it("walks the scope an out-of-line definition names in its id, split or joined", async () => {
		for (const chain of [
			["Physics", "World", "step"],
			["Physics::World::step"],
			["Physics.World", "step"],
			["Physics", "step"],
		]) {
			expect((await exact(chain)).symbolId, chain.join(" > ")).toBe(STEP);
		}
		expect((await exact(["Physics", "World", "step"])).containerPath).toEqual(["Physics", "World"]);
		// The scope is a prefix nothing declares, so it is not a candidate on its own.
		expect(await none(["Physics", "World"])).toMatchObject({
			reason: "noMatch",
			matched: { containerPaths: [["Physics", "World"]], consumed: 2, count: 0 },
			available: ["step"],
		});
	});

	it("spans the parameter list for `arguments`, with no selection range", async () => {
		const span = await exact(["Service", "run", "arguments"]);
		expect(span).toEqual({
			symbolId: RUN_METHOD,
			kind: "method",
			name: "arguments",
			range: { start: at(9, 5), end: at(9, 34) },
			containerPath: ["Service", "run"],
			segments: ["Service", "run", "arguments"],
		});
	});

	it("names one parameter after `arguments`, by the id grammar when the row has no container", async () => {
		expect(await exact(["Service", "run", "arguments", "second"])).toMatchObject({
			symbolId: SECOND,
			containerPath: ["Service", "run"],
		});
		expect((await exact(["compute", "arguments"])).range).toEqual({ start: at(22, 17), end: at(22, 28) });
		expect((await exact(["compute", "arguments", "qty"])).symbolId).toBe(QTY);
	});

	it("lets a later segment settle an earlier ambiguity", async () => {
		// Two `run`s, one with parameters.
		expect((await exact(["run", "arguments"])).symbolId).toBe(RUN_METHOD);
	});

	it("says where the walk stopped and what was there to choose from", async () => {
		expect(await none(["Ghost"])).toMatchObject({
			reason: "noMatch",
			matched: { containerPaths: [], consumed: 0, count: 0 },
			availableTotal: 14,
		});
		expect((await none(["Ghost"])).available.slice(0, 3)).toEqual(["Outer", "Inner", "deep"]);
		expect(await none(["Service", "deep"])).toMatchObject({
			reason: "noMatch",
			matched: { containerPaths: [["Service"]], consumed: 1, count: 0 },
			available: ["run", "first", "second"],
			availableTotal: 3,
		});
		for (const chain of [
			["Service", "run", "arguments", "ghost"],
			["Service", "run", "arguments", "arguments"],
			["arguments"],
			["Outer..Inner"],
		]) {
			expect((await none(chain)).reason, chain.join(" > ")).toBe("noMatch");
		}
	});

	it("refuses an empty chain or an empty segment", async () => {
		expect(await none([])).toMatchObject({ reason: "noMatch", contentHash: HASH });
		expect(await none(["Service", ""])).toMatchObject({ reason: "noMatch" });
	});
});

describe("resolveChain says why a module has nothing to walk", () => {
	it.each([
		[{ exists: false, read: { kind: "missing" }, contentHash: null, diskHash: null, declarations: [] }, "missing"],
		[{ read: { kind: "binary", detail: "not text" }, diskHash: null }, "binary"],
		[{ read: { kind: "tooLarge", detail: "too big" }, diskHash: null }, "tooLarge"],
		[
			{ claimed: false, unclaimedReason: "unclaimed", indexed: false, contentHash: null, declarations: [] },
			"unclaimed",
		],
		[{ failure: "unexpected token", indexed: false, contentHash: null, declarations: [] }, "parseFailed"],
		[{ indexed: false, contentHash: null, declarations: [] }, "unread"],
	] as const)("answers %j as %s from the one snapshot", async (held, reason) => {
		const partial = held as Partial<ModuleDeclarations>;
		const session = indexed(partial);
		const answer = await resolveChain(session, MODULE, ["Service"]);
		expect(answer).toMatchObject({
			kind: "none",
			reason,
			diskHash: Object.hasOwn(partial, "diskHash") ? null : HASH,
		});
		expect(session.asked).toEqual(["moduleDeclarations"]);
	});

	it("carries the reason's detail, and resolves at outline depth past a failed upgrade", async () => {
		expect(
			await none(["Service"], { read: { kind: "binary", detail: "not text: a NUL" }, diskHash: null }),
		).toMatchObject({
			reason: "binary",
			detail: "not text: a NUL",
		});
		expect(await none(["Service"], { claimed: false, unclaimedReason: "denied by scope" })).toMatchObject({
			detail: "denied by scope",
		});
		// Rows at the current hash outrank a recorded failure.
		const answer = await resolveChain(indexed({ failure: "later parse failed", depth: "outline" }), MODULE, [
			"Service",
		]);
		expect(answer.kind).toBe("exact");
	});
});

describe("awaitIndexed reads the daemon's outcome", () => {
	function after(outcome: Omit<IndexOutcome, "module">) {
		return awaitIndexed(stub({ indexFile: ({ module }) => ({ module, ...outcome }) }), MODULE);
	}

	it.each([
		[{ action: "indexed", declarations: 3 }, { indexed: true }],
		[{ action: "skipped", cause: "current", reason: "already indexed at this depth" }, { indexed: true }],
		[
			{ action: "skipped", cause: "unclaimed", reason: "unclaimed" },
			{ indexed: false, reason: "unclaimed", detail: "unclaimed" },
		],
		[
			{ action: "skipped", cause: "unclaimed", reason: "claimed by a, b" },
			{ indexed: false, reason: "unclaimed", detail: "claimed by a, b" },
		],
		[
			{ action: "forgotten", cause: "missing", reason: "file is gone" },
			{ indexed: false, reason: "missing", detail: "file is gone" },
		],
		[
			{ action: "skipped", cause: "binary", reason: "parse failed", failure: "not text" },
			{ indexed: false, reason: "binary", detail: "not text" },
		],
		[
			{ action: "skipped", cause: "tooLarge", reason: "parse failed", failure: "9 bytes" },
			{ indexed: false, reason: "tooLarge", detail: "9 bytes" },
		],
		[
			{ action: "skipped", cause: "parseFailed", reason: "parse failed", failure: "unexpected token at 3:1" },
			{ indexed: false, reason: "parseFailed", detail: "unexpected token at 3:1" },
		],
	] as const)("answers %j as %j", async (outcome, answer) => {
		expect(await after(outcome)).toEqual(answer);
	});

	it("throws only for the daemon's own trouble: a provider outage, or an outcome without a cause", async () => {
		const down = after({
			action: "skipped",
			cause: "providerDown",
			reason: "provider unavailable",
			failure: "ts died",
		});
		await expect(down).rejects.toThrow(DaemonError);
		await expect(down).rejects.toThrow("ts died");

		const unknown = after({ action: "skipped", reason: "outside roots and reachability" });
		await expect(unknown).rejects.toThrow(DaemonError);
		await expect(unknown).rejects.toThrow("outside roots and reachability");
	});
});
