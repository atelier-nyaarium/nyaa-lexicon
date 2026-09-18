import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ModuleAdmission } from "@nyaa-lexicon/protocol";
import type { MethodRequest, MethodResponse, ProviderPort } from "../providerPort";
import type { ProviderClaims } from "../routing";
import { LexiconService } from "../service";
import { sourceReader } from "../sourceRead";
import { IndexStore } from "../store";
import { fakeSupervisor, parseFake } from "./fakeProvider";
import { gitInit } from "./gitFixture";

////////////////////////////////
//  Helpers

let root: string;
let store: IndexStore;

const claims: ProviderClaims = { providerId: "fake", language: "fake", extensions: [".fake"] };

/** A verdict, the provider it named, and what the index held when it was published. */
interface Published {
	providerId: string;
	verdict: ModuleAdmission;
	storedHash: string | null;
	failure: string | null;
}

function put(module: string, text: string): void {
	const full = path.join(root, module);
	mkdirSync(path.dirname(full), { recursive: true });
	writeFileSync(full, text);
}

/**
 * Reads the index at the moment each verdict is published.
 *
 * Ordering asserted from the store rather than from the source, because "after the commit" is a
 * claim about what a provider can observe, not about where a line sits.
 */
function watching(
	seen: Published[],
	answers?: { parseFile?: (params: MethodRequest<"parseFile">) => unknown },
): {
	port: ProviderPort;
} {
	const base = fakeSupervisor({
		claims: [claims],
		discover: () => ["a.fake", "b.fake"],
		...(answers === undefined
			? {}
			: {
					answers: {
						parseFile: (params) => answers.parseFile?.(params) as MethodResponse<"parseFile">,
					},
				}),
	});
	return {
		port: {
			...base,
			admission: (providerId, _incarnation, verdict) => {
				seen.push({
					providerId,
					verdict,
					storedHash: store.contentHashOf(verdict.module),
					failure: store.parseFailureOf(verdict.module)?.reason ?? null,
				});
			},
		},
	};
}

function serviceOn(port: ProviderPort): LexiconService {
	return new LexiconService(store, port, sourceReader(root), root);
}

beforeEach(async () => {
	root = mkdtempSync(path.join(tmpdir(), "lexicon-admission-"));
	await gitInit(root);
	store = IndexStore.open(path.join(root, "index.sqlite")).store;
});

afterEach(() => {
	store.close();
	rmSync(root, { recursive: true, force: true });
});

////////////////////////////////
//  Tests

describe("the index tells a provider what it did with a parse", () => {
	it("publishes admitted only once the facts are committed", async () => {
		put("a.fake", "export class A {}\n");
		put("b.fake", "export class B {}\n");
		const seen: Published[] = [];
		await serviceOn(watching(seen).port).indexWorkspace();

		expect(seen.map((item) => item.verdict.module).sort()).toEqual(["a.fake", "b.fake"]);
		for (const item of seen) {
			expect(item.verdict.outcome.status).toBe("admitted");
			// The store already holds the bytes the verdict names.
			expect(item.storedHash).toBe(item.verdict.contentHash);
		}
	});

	it("publishes refused for a parse the file's own diagnostics failed, with the index's sentence", async () => {
		put("a.fake", "SYNTAX\n");
		put("b.fake", "export class B {}\n");
		const seen: Published[] = [];
		await serviceOn(watching(seen).port).indexWorkspace();

		const refused = seen.find((item) => item.verdict.module === "a.fake");
		expect(refused?.verdict.outcome).toEqual({ status: "refused", reason: "syntax error" });
		// Recorded before published: the provider is never told a verdict the index has not taken.
		expect(refused?.failure).toBe("syntax error");
		expect(refused?.storedHash).toBeNull();
	});

	// The gap this seam closes: an id the store refuses is decided after the provider answered.
	it("publishes refused for an answer the store would not admit", async () => {
		put("a.fake", "export class A {}\n");
		put("b.fake", "export class B {}\n");
		const seen: Published[] = [];
		const port = watching(seen, {
			parseFile: (params) => {
				const facts = parseFake(params);
				if (params.module !== "a.fake") return facts;
				return {
					...facts,
					declarations: facts.declarations.map((declaration) => ({
						...declaration,
						containerId: "lexicon fake other.fake Ghost.",
					})),
				};
			},
		}).port;
		await serviceOn(port).indexWorkspace();

		const refused = seen.find((item) => item.verdict.module === "a.fake");
		expect(refused?.verdict.outcome.status).toBe("refused");
		expect(refused?.verdict.outcome).toMatchObject({ reason: expect.stringContaining("was refused") });
		expect(refused?.failure).toContain("was refused");
		expect(seen.find((item) => item.verdict.module === "b.fake")?.verdict.outcome.status).toBe("admitted");
	});

	// The store commits nothing on a fault either, and the provider is holding the parse.
	it("publishes refused when the store itself fails to commit", async () => {
		put("a.fake", "export class A {}\n");
		put("b.fake", "export class B {}\n");
		const seen: Published[] = [];
		const service = serviceOn(watching(seen).port);
		store.replaceFile = () => {
			throw new Error("the disk is full");
		};

		const outcomes = await service.indexWorkspace();

		const refused = seen.find((item) => item.verdict.module === "a.fake");
		expect(refused?.verdict.outcome).toMatchObject({
			status: "refused",
			reason: expect.stringContaining("the disk is full"),
		});
		// Recorded before published, through the fault's own road.
		expect(refused?.failure).toContain("the disk is full");
		expect(outcomes.find((outcome) => outcome.module === "a.fake")?.cause).toBe("fault");
	});

	// Routing moves on evidence a scan gathers, and the newcomer has nothing staged to settle.
	it("names the provider that parsed, not the one that owns the module afterwards", async () => {
		put("a.fake", "export class A {}\n");
		const seen: Published[] = [];
		const claims: ProviderClaims[] = [{ providerId: "fake", language: "fake", extensions: [".fake"] }];
		const base = fakeSupervisor({
			claims,
			discover: () => ["a.fake"],
			answers: {
				parseFile: (params) => {
					claims[0] = { providerId: "newcomer", language: "fake", extensions: [".fake"] };
					return parseFake(params);
				},
			},
		});
		const port: ProviderPort = {
			...base,
			admission: (providerId, _incarnation, verdict) => {
				seen.push({ providerId, verdict, storedHash: null, failure: null });
			},
		};

		await serviceOn(port).indexWorkspace();

		expect(seen.map((item) => item.providerId)).toEqual(["fake"]);
	});

	// A restart under the same id holds a fresh ledger, whose staging is not this parse's.
	it("delivers nothing to a process that replaced the one which parsed", async () => {
		put("a.fake", "export class A {}\n");
		const delivered: Array<{ providerId: string; verdict: ModuleAdmission }> = [];
		const incarnation = { current: 1 };
		const port = fakeSupervisor({
			claims: [claims],
			discover: () => ["a.fake"],
			admissions: delivered,
			incarnation,
			answers: {
				parseFile: (params) => {
					// The provider dies and comes back under the same id while the parse is in flight.
					incarnation.current += 1;
					return parseFake(params);
				},
			},
		});

		await serviceOn(port).indexWorkspace();

		expect(delivered).toEqual([]);
	});

	it("delivers to the process that parsed when it is still the one running", async () => {
		put("a.fake", "export class A {}\n");
		const delivered: Array<{ providerId: string; verdict: ModuleAdmission }> = [];
		const port = fakeSupervisor({ claims: [claims], discover: () => ["a.fake"], admissions: delivered });

		await serviceOn(port).indexWorkspace();

		expect(delivered.map((item) => item.verdict.outcome.status)).toEqual(["admitted"]);
	});

	// A verdict names the bytes parsed, so a provider can tell which parse it settles.
	it("names the bytes the index parsed, not the bytes an argument claimed", async () => {
		put("a.fake", "export class A {}\n");
		put("b.fake", "export class B {}\n");
		const seen: Published[] = [];
		const service = serviceOn(watching(seen).port);
		await service.indexWorkspace();
		seen.length = 0;

		put("a.fake", "export class Moved {}\n");
		await service.applyBatch([{ kind: "changed", module: "a.fake", contentHash: "a-lie" }]);

		const published = seen.find((item) => item.verdict.module === "a.fake");
		expect(published?.verdict.contentHash).not.toBe("a-lie");
		expect(published?.verdict.contentHash).toBe(store.contentHashOf("a.fake") ?? "");
	});
});
