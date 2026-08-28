import {
	composeSymbolId,
	type DaemonMethod,
	type Descriptor,
	type IndexOutcome,
	type ModuleStatus,
	type RequestOf,
	type ResponseOf,
	type StoredDeclaration,
	type SymbolKind,
} from "@nyaa-lexicon/protocol";
import { describe, expect, it } from "vitest";
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

const STATUS: ModuleStatus = {
	module: MODULE,
	exists: true,
	claimed: true,
	provider: "ts",
	indexed: true,
	depth: "full",
};

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
];

function indexed(status: Partial<ModuleStatus> = {}) {
	return stub({ moduleStatus: () => ({ ...STATUS, ...status }), declarationsIn: () => DECLARATIONS });
}

async function exact(segments: string[]) {
	const answer = await resolveChain(indexed(), MODULE, segments);
	if (answer.kind !== "exact") throw new Error(`${segments.join(" > ")} answered ${answer.kind}`);
	return answer.candidate;
}

////////////////////////////////
//  Tests

describe("resolveChain walks a module's declarations", () => {
	it("names one declaration with the containers above it", async () => {
		expect(await exact(["Service", "run"])).toMatchObject({
			symbolId: RUN_METHOD,
			kind: "method",
			containerPath: ["Service"],
			range: { start: at(9, 1) },
			selectionRange: { start: at(9, 1) },
		});
	});

	it("reaches a descendant through layers no segment names", async () => {
		expect(await exact(["Outer", "deep"])).toMatchObject({ symbolId: DEEP, containerPath: ["Outer", "Inner"] });
	});

	it("answers every candidate in document order when a name repeats, choosing none", async () => {
		const answer = await resolveChain(indexed(), MODULE, ["run"]);
		expect(answer.kind).toBe("ambiguous");
		if (answer.kind !== "ambiguous") return;
		expect(answer.candidates.map((candidate) => candidate.symbolId)).toEqual([RUN_METHOD, RUN_FUNCTION]);
	});

	it("picks the n-th match by ordinal, and nothing past the last", async () => {
		expect((await exact(["run[2]"])).symbolId).toBe(RUN_FUNCTION);
		expect(await resolveChain(indexed(), MODULE, ["run[3]"])).toEqual({ kind: "none", reason: "noMatch" });
		expect(await resolveChain(indexed(), MODULE, ["run[0]"])).toEqual({ kind: "none", reason: "noMatch" });
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

	it("reads a qualified segment as a declaration's own dotted name, in either spelling", async () => {
		expect((await exact(["Acme.Services", "Api"])).containerPath).toEqual(["Acme.Services"]);
		expect((await exact(["Acme::Services", "Api"])).symbolId).toBe(API);
		expect((await exact(["Version 1.2"])).symbolId).toBe(VERSION);
		// Separate segments are separate names, and no `Acme` holds a `Services`.
		expect(await resolveChain(indexed(), MODULE, ["Acme", "Services", "Api"])).toEqual({
			kind: "none",
			reason: "noMatch",
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

	it("has nothing to say for a name the chain cannot reach", async () => {
		for (const chain of [
			["Ghost"],
			["Service", "deep"],
			["Service", "run", "arguments", "ghost"],
			["Service", "run", "arguments", "arguments"],
			["arguments"],
			["Outer..Inner"],
		]) {
			expect(await resolveChain(indexed(), MODULE, chain), chain.join(" > ")).toEqual({
				kind: "none",
				reason: "noMatch",
			});
		}
	});

	it("refuses an empty chain or an empty segment without asking", async () => {
		const session = indexed();
		expect(await resolveChain(session, MODULE, [])).toEqual({ kind: "none", reason: "noMatch" });
		expect(await resolveChain(session, MODULE, ["Service", ""])).toEqual({ kind: "none", reason: "noMatch" });
		expect(session.asked).toEqual([]);
	});
});

describe("resolveChain says why a module has nothing to walk", () => {
	it.each([
		[{ exists: false, claimed: false, indexed: false }, "missing"],
		[{ claimed: false, indexed: false, unclaimedReason: "unclaimed" }, "unclaimed"],
		[{ indexed: false }, "unread"],
	] as const)("answers %j as %s before reading any declaration", async (status, reason) => {
		const session = indexed(status);
		expect(await resolveChain(session, MODULE, ["Service"])).toEqual({ kind: "none", reason });
		expect(session.asked).toEqual(["moduleStatus"]);
	});
});

describe("awaitIndexed reads the daemon's outcome", () => {
	function after(outcome: Omit<IndexOutcome, "module">) {
		return awaitIndexed(stub({ indexFile: ({ module }) => ({ module, ...outcome }) }), MODULE);
	}

	it.each([
		[{ action: "indexed", declarations: 3 }, { indexed: true }],
		[{ action: "skipped", reason: "already indexed at this depth" }, { indexed: true }],
		[
			{ action: "skipped", reason: "unclaimed" },
			{ indexed: false, reason: "unclaimed" },
		],
		[
			{ action: "skipped", reason: "claimed by a, b" },
			{ indexed: false, reason: "unclaimed" },
		],
		[
			{ action: "skipped", reason: "denied by scope" },
			{ indexed: false, reason: "unclaimed" },
		],
		[
			{ action: "forgotten", reason: "file is gone" },
			{ indexed: false, reason: "missing" },
		],
		[{ action: "forgotten" }, { indexed: false, reason: "missing" }],
	] as const)("answers %j as %j", async (outcome, answer) => {
		expect(await after(outcome)).toEqual(answer);
	});

	it("throws the provider's reason for a failure, and any skip it does not know", async () => {
		const failed = after({ action: "skipped", reason: "parse failed", failure: "unexpected token at 3:1" });
		await expect(failed).rejects.toThrow(DaemonError);
		await expect(failed).rejects.toThrow("unexpected token at 3:1");

		const unknown = after({ action: "skipped", reason: "outside roots and reachability" });
		await expect(unknown).rejects.toThrow(DaemonError);
		await expect(unknown).rejects.toThrow("outside roots and reachability");
	});
});
