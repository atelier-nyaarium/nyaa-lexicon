import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { handlersFor, hashContent, PROTOCOL_VERSION, parseSymbolId } from "@nyaa-lexicon/protocol";
import { runSuite } from "../../../../protocol/src/conformance/runner.js";
import { type ProbeBatchCase, ProbeBatchCaseSchema } from "../../../../protocol/src/conformance/types.js";
import { GDScriptProvider } from "../main.js";

////////////////////////////////
//  Helpers

const roots: string[] = [];

const PROJECT = 'config_version=5\n\n[application]\nconfig/name="probe"\n';

const FILES = {
	"project.godot": PROJECT,
	"a.gd": "class_name One\nextends Node\n",
	"b.gd": "extends Node\n\n\nfunc run() -> void:\n\tOne.new()\n",
};

/** `a` trades `One` for `Two`, a new `c` declares `Three`, and `b` uses both. */
const PROBE = {
	"a.gd": "class_name Two\nextends Node\n",
	"c.gd": "class_name Three\nextends Node\n",
	"b.gd": 'extends Node\n\nconst Third = preload("res://c.gd")\n\n\nfunc seen() -> void:\n\tpass\n\n\nfunc run() -> void:\n\tTwo.new()\n\tThree.new()\n',
};

function workspace(files: Record<string, string>): string {
	const root = mkdtempSync(path.join(tmpdir(), "lexicon-gdscript-probe-"));
	roots.push(root);
	for (const [module, text] of Object.entries(files)) {
		const full = path.join(root, module);
		mkdirSync(path.dirname(full), { recursive: true });
		writeFileSync(full, text);
	}
	return root;
}

function started() {
	const provider = handlersFor(new GDScriptProvider());
	const root = workspace(FILES);
	provider.initialize({ workspaceRoot: root, protocolVersion: PROTOCOL_VERSION });
	provider.discoverProject({ workspaceRoot: root });
	const held = () =>
		(["a.gd", "b.gd"] as const).map((module) =>
			provider.parseFile({ module, contentHash: hashContent(FILES[module]), text: FILES[module] }),
		);
	return { provider, held };
}

function proposed(files: Record<string, string>) {
	return Object.entries(files).map(([module, text]) => ({ module, contentHash: hashContent(text), text }));
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

////////////////////////////////
//  Tests

describe("batch probe", () => {
	it("reads every proposed text as one view, answers the modules asked, and lands each specifier", async () => {
		const { provider, held } = started();
		const before = held();
		const answer = await provider.probeBatch({ files: proposed(PROBE), answer: ["b.gd", "a.gd"] });
		if (answer.status !== "ready") throw new Error(`the probe was unsupported: ${answer.detail}`);

		const facts = new Map(answer.facts.map((one) => [one.module, one]));
		expect([...facts.keys()]).toEqual(["b.gd", "a.gd"]);
		expect(facts.get("b.gd")?.contentHash).toBe(hashContent(PROBE["b.gd"]));
		expect(facts.get("b.gd")?.declarations.map((declaration) => declaration.name)).toContain("seen");
		const bound = facts
			.get("b.gd")
			?.references.filter((reference) => reference.binding.status === "bound")
			.map((reference) => {
				const binding = reference.binding;
				const target = binding.status === "bound" ? parseSymbolId(binding.symbolId)?.module : undefined;
				return [reference.name, target, reference.origin?.kind];
			});
		expect(bound).toEqual([
			["Two", "a.gd", "declaration"],
			["Three", "c.gd", "declaration"],
			["res://c.gd", "c.gd", undefined],
		]);
		expect(answer.landings).toEqual([
			{
				module: "b.gd",
				specifier: "res://c.gd",
				resolution: { status: "resolved", landing: { kind: "module", module: "c.gd" } },
			},
		]);

		// What the provider holds is unchanged.
		expect(held()).toEqual(before);
		expect(await provider.resolveImport({ fromModule: "b.gd", specifier: "res://c.gd" })).toMatchObject({
			status: "unresolved",
		});
	});

	it("answers an unproposed module at its held text, read against the proposals", async () => {
		const { provider } = started();
		const answer = await provider.probeBatch({
			files: proposed({ "a.gd": "class_name Other\nextends Node\n" }),
			answer: ["b.gd"],
		});
		if (answer.status !== "ready") throw new Error("the probe was unsupported");

		expect(answer.facts.map((one) => [one.module, one.contentHash])).toEqual([
			["b.gd", hashContent(FILES["b.gd"])],
		]);
		// `One` left the proposed `a`.
		expect(answer.facts[0]?.references.find((reference) => reference.name === "One")?.binding).toMatchObject({
			status: "unbound",
		});
	});

	it("is unsupported when an asked module is neither proposed nor held", async () => {
		const { provider } = started();
		const answer = await provider.probeBatch({ files: proposed(PROBE), answer: ["missing.gd"] });
		expect(answer.status).toBe("unsupported");
	});

	it("passes the corpus probe case over the real wire", async () => {
		const testCase: ProbeBatchCase = ProbeBatchCaseSchema.parse({
			id: "probe-batch-reads-one-view",
			about: "The corpus case, with a GDScript fixture.",
			fixtures: {
				gdscript: {
					files: {
						"project.godot": PROJECT,
						"a.gd": "class_name One\nextends Node\n",
						"b.gd": "extends Node\n\n\nfunc run() -> void:\n\tOne.new()\n",
					},
					probe: {
						"a.gd": "class_name Two\nextends Node\n",
						"b.gd": 'extends Node\n\nconst Base = preload("res://a.gd")\n\n\nfunc seen() -> void:\n\tpass\n\n\nfunc run() -> void:\n\tTwo.new()\n',
					},
					answer: ["b.gd"],
					sees: [{ module: "b.gd", declaration: "seen" }],
					bound: [{ module: "b.gd", name: "Two" }],
				},
			},
		});
		const report = await runSuite({
			command: [
				"env",
				"LEXICON_STORE_CHECKS=1",
				process.execPath,
				path.join(import.meta.dirname, "..", "main.ts"),
			],
			cases: [],
			probeBatchCases: [testCase],
		});
		const result = report.results.find((one) => one.caseId === testCase.id);
		expect([result?.outcome, result?.problems]).toEqual(["passed", []]);
	}, 60_000);
});
