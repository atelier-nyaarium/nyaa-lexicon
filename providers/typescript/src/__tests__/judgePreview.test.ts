import { afterEach, describe, expect, it } from "bun:test";
import { hashContent } from "@nyaa-lexicon/protocol";
import { expirePreviews } from "../judge/preview.js";
import { cleanWorkspaces, indexed } from "./judgeWorkspace.js";

afterEach(cleanWorkspaces);

describe("prepared load-cycle overlays", () => {
	it("reuses a frozen Program and writes scan for two cycles, measuring preparation apart from judgment", async () => {
		const source = {
			"a.ts": 'import "./b";\nexport const A = 1;',
			"b.ts": 'import { A } from "./a";\nexport const B = A;',
			"c.ts": 'import "./d";\nexport const C = 1;',
			"d.ts": 'import { C } from "./c";\nexport const D = C;',
		};
		const { provider, request } = indexed(
			source,
			{ module: "ESNext", moduleResolution: "Bundler" },
			["a.ts", "b.ts", "c.ts", "d.ts"],
			["a.ts", "c.ts"],
		);
		const indexedProgram = provider.provider.store.project.analyzer;
		const stats = provider.programStats();
		const proposed = 'import "./b";\nexport const A = 2;';
		const preparationStarted = performance.now();
		const prepared = await provider.handlers.prepareLoadCyclePreview?.({
			files: [
				{
					module: "a.ts",
					base: request.members[0]!.contentHash,
					contentHash: hashContent(proposed),
					text: proposed,
				},
			],
			answer: ["a.ts", "b.ts", "c.ts", "d.ts"],
		});
		const preparationMs = performance.now() - preparationStarted;
		expect(prepared?.status).toBe("ready");
		if (prepared?.status !== "ready") return;
		const concurrent = await provider.handlers.prepareLoadCyclePreview?.({
			files: [
				{
					module: "a.ts",
					base: request.members[0]!.contentHash,
					contentHash: hashContent(proposed),
					text: proposed,
				},
			],
			answer: ["a.ts", "b.ts", "c.ts", "d.ts"],
		});
		expect(concurrent?.status).toBe("ready");
		if (concurrent?.status !== "ready") return;
		expect(concurrent.preview).not.toBe(prepared.preview);
		expect(prepared.facts.find((facts) => facts.module === "a.ts")?.contentHash).toBe(hashContent(proposed));
		const wrongToken = await provider.handlers.judgeLoadCycle?.({
			preview: `${prepared.preview}-other`,
			members: [{ module: "a.ts", contentHash: hashContent(proposed) }],
			entries: ["a.ts"],
		});
		expect(wrongToken).toMatchObject({ preview: `${prepared.preview}-other`, verdict: "unknown" });
		const judgmentStarted = performance.now();
		let answer = await provider.handlers.judgeLoadCycle?.({
			preview: prepared.preview,
			members: [
				{ module: "a.ts", contentHash: hashContent(proposed) },
				{ module: "b.ts", contentHash: request.members[1]!.contentHash },
			],
			entries: ["a.ts"],
		});
		while (answer !== undefined && "partial" in answer)
			answer = await provider.handlers.judgeLoadCycle?.({
				preview: prepared.preview,
				members: [
					{ module: "a.ts", contentHash: hashContent(proposed) },
					{ module: "b.ts", contentHash: request.members[1]!.contentHash },
				],
				entries: ["a.ts"],
				partial: answer.partial,
			});
		const judgmentMs = performance.now() - judgmentStarted;
		expect(answer).toMatchObject({ preview: prepared.preview });
		expect(Number.isFinite(preparationMs) && preparationMs >= 0).toBe(true);
		expect(Number.isFinite(judgmentMs) && judgmentMs >= 0).toBe(true);
		const project = provider.provider.store.project;
		const context = project.previews.get(prepared.preview);
		const preparedProgram = context?.programs.values().next().value;
		const writesScan = preparedProgram === undefined ? undefined : project.writes.get(preparedProgram);
		expect(writesScan).toBeDefined();
		const reused = await provider.handlers.judgeLoadCycle?.({
			preview: prepared.preview,
			members: [
				{ module: "c.ts", contentHash: request.members[2]!.contentHash },
				{ module: "d.ts", contentHash: request.members[3]!.contentHash },
			],
			entries: ["c.ts"],
		});
		expect(reused).toMatchObject({ preview: prepared.preview });
		expect(preparedProgram === undefined ? undefined : project.writes.get(preparedProgram)).toBe(writesScan);
		expect(provider.provider.store.project.analyzer).toBe(indexedProgram);
		expect(provider.programStats()).toEqual(stats);
		provider.handlers.releaseLoadCyclePreview?.({ preview: prepared.preview });
		provider.handlers.releaseLoadCyclePreview?.({ preview: concurrent.preview });
		const expired = await provider.handlers.judgeLoadCycle?.({
			preview: prepared.preview,
			members: [{ module: "a.ts", contentHash: hashContent(proposed) }],
			entries: ["a.ts"],
		});
		expect(expired).toMatchObject({ preview: prepared.preview, verdict: "unknown" });
	});

	it("expires a retained overlay and its partial judgments", async () => {
		const { provider, request } = indexed(
			{ "a.ts": "export const A = 1;" },
			{ module: "ESNext" },
			["a.ts"],
			["a.ts"],
		);
		const prepared = await provider.handlers.prepareLoadCyclePreview?.({
			files: [
				{
					module: "a.ts",
					base: request.members[0]!.contentHash,
					contentHash: hashContent("export const A = 2;"),
					text: "export const A = 2;",
				},
			],
			answer: ["a.ts"],
		});
		if (prepared?.status !== "ready") throw new Error("preview preparation failed");
		expirePreviews(provider.provider.store.project, Number.MAX_SAFE_INTEGER);
		const answer = await provider.handlers.judgeLoadCycle?.({
			preview: prepared.preview,
			members: [{ module: "a.ts", contentHash: hashContent("export const A = 2;") }],
			entries: ["a.ts"],
		});
		expect(answer).toMatchObject({ preview: prepared.preview, verdict: "unknown" });
	});

	it("refuses a preparation whose base no longer matches the admitted text", async () => {
		const { provider } = indexed({ "a.ts": "export const A = 1;" }, { module: "ESNext" }, ["a.ts"], ["a.ts"]);
		const prepared = await provider.handlers.prepareLoadCyclePreview?.({
			files: [
				{
					module: "a.ts",
					base: "stale",
					contentHash: hashContent("export const A = 2;"),
					text: "export const A = 2;",
				},
			],
			answer: ["a.ts"],
		});
		expect(prepared).toMatchObject({ status: "unknown", reason: "evidence" });
	});

	it("resolves an unchanged importer through a created module in the prepared overlay", async () => {
		const { provider } = indexed(
			{ "a.ts": 'import { B } from "./new";\nexport const A = B;' },
			{ module: "ESNext", moduleResolution: "Bundler" },
			["a.ts"],
			["a.ts"],
			["a.ts"],
		);
		const text = "export const B = 1;";
		const prepared = await provider.handlers.prepareLoadCyclePreview?.({
			files: [{ module: "new.ts", base: null, contentHash: hashContent(text), text }],
			answer: ["a.ts", "new.ts"],
		});
		expect(prepared?.status).toBe("ready");
		if (prepared?.status !== "ready") return;
		expect(prepared.facts.find((facts) => facts.module === "new.ts")?.contentHash).toBe(hashContent(text));
		expect(prepared.landings).toContainEqual(
			expect.objectContaining({
				module: "a.ts",
				specifier: "./new",
				resolution: { status: "resolved", landing: { kind: "module", module: "new.ts" } },
			}),
		);
		provider.handlers.releaseLoadCyclePreview?.({ preview: prepared.preview });
	});

	it("disposes evicted, released and expired previews back to the starting service count", async () => {
		const { provider, request } = indexed(
			{ "a.ts": 'import "./b";', "b.ts": "export const B = 1;" },
			{ module: "ESNext", moduleResolution: "Bundler" },
			["a.ts", "b.ts"],
			["a.ts"],
		);
		const project = provider.provider.store.project;
		const startingServices = project.languageServices.size;
		const proposed = 'import "./b";\nexport const A = 2;';
		const tokens: string[] = [];
		for (let index = 0; index < 12; index++) {
			const prepared = await provider.handlers.prepareLoadCyclePreview?.({
				files: [
					{
						module: "a.ts",
						base: request.members[0]!.contentHash,
						contentHash: hashContent(proposed),
						text: proposed,
					},
				],
				answer: ["a.ts", "b.ts"],
			});
			if (prepared?.status !== "ready") throw new Error("preview preparation failed");
			tokens.push(prepared.preview);
		}
		expect(project.previews.size).toBe(8);
		expect(project.languageServices.size).toBe(startingServices + 8);
		for (const preview of tokens) provider.handlers.releaseLoadCyclePreview?.({ preview });
		expirePreviews(project, Number.MAX_SAFE_INTEGER);
		expect(project.previews.size).toBe(0);
		expect(project.judgments.size).toBe(0);
		expect(project.languageServices.size).toBe(startingServices);
	});
});
