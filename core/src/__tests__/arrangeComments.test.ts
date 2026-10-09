// Standalone comments through the daemon's handlers and each arranging provider.

import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ResponseOf } from "@nyaa-lexicon/protocol";
import { createDispatch } from "../dispatch";
import { LexiconService } from "../service";
import { sourceReader } from "../sourceRead";
import { IndexStore } from "../store";
import { ProviderSupervisor } from "../supervisor";
import { TransactionManager } from "../transactions";

////////////////////////////////
//  Fixtures

interface Language {
	provider: string;
	source: string;
	target: string;
	text: string;
	existing: string;
	anchorName: string;
}

const LANGUAGES: Record<string, Language> = {
	typescript: {
		provider: "typescript",
		source: "src/source.ts",
		target: "src/target.ts",
		text: [
			"// Header.",
			"",
			"////////////////////////////////",
			"//  Values",
			"",
			"// leading",
			"export function lone() {",
			"\treturn 1;",
			"}",
			"",
			"////////////////////////////////",
			"//  Pair",
			"",
			"export function one() {",
			"\treturn 1;",
			"}",
			"",
			"// Note.",
			"",
			"export function two() {",
			"\treturn 2;",
			"}",
			"",
		].join("\n"),
		existing: "export const marker = 0;\n",
		anchorName: "marker",
	},
	python: {
		provider: "python",
		source: "source.py",
		target: "target.py",
		text: [
			"# Header.",
			"",
			"# ------------------------------",
			"#  Values",
			"",
			"# leading",
			"def lone():",
			"    return 1",
			"",
			"",
			"# ------------------------------",
			"#  Pair",
			"",
			"def one():",
			"    return 1",
			"",
			"",
			"# Note.",
			"",
			"",
			"def two():",
			"    return 2",
			"",
		].join("\n"),
		existing: "MARKER = 0\n",
		anchorName: "MARKER",
		// The removed def's two-line separator stays, as Python spaces top-level blocks.
	},
	// The file's own class is the module, so its methods are the top level.
	gdscript: {
		provider: "gdscript",
		source: "source.gd",
		target: "target.gd",
		text: [
			"# Header.",
			"extends Node",
			"",
			"# ------------------------------",
			"#  Values",
			"",
			"# leading",
			"func lone() -> int:",
			"\treturn 1",
			"",
			"# ------------------------------",
			"#  Pair",
			"",
			"func one() -> int:",
			"\treturn 1",
			"",
			"# Note.",
			"",
			"func two() -> int:",
			"\treturn 2",
			"",
		].join("\n"),
		existing: "extends Node\n\nfunc marker() -> int:\n\treturn 0\n",
		anchorName: "marker",
	},
};

let cleanup: (() => void) | null = null;

afterEach(() => {
	cleanup?.();
	cleanup = null;
});

async function served(language: Language, files: Record<string, string>) {
	const root = mkdtempSync(path.join(tmpdir(), `lexicon-banners-${language.provider}-`));
	if (language.provider === "typescript") {
		writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({ include: ["src"] }));
	}
	for (const [module, text] of Object.entries(files)) {
		const file = path.join(root, module);
		mkdirSync(path.dirname(file), { recursive: true });
		writeFileSync(file, text);
	}
	const store = IndexStore.open(path.join(root, "index.sqlite")).store;
	const supervisor = new ProviderSupervisor();
	const provider = path.join(import.meta.dirname, "..", "..", "..", "providers", language.provider, "src", "main.ts");
	await supervisor.start({ command: [process.execPath, "run", provider], timeoutMs: 30_000 }, root);
	const service = new LexiconService(store, supervisor, sourceReader(root), root);
	const dispatch = createDispatch(service, { transactions: new TransactionManager(store, root) });
	for (const module of Object.keys(files)) await service.indexFile(module);
	await dispatch("refactorStart", {});
	cleanup = () => {
		supervisor.stopAll();
		store.close();
		rmSync(root, { recursive: true, force: true });
	};
	const idOf = (name: string) => service.findByName(name).find((found) => found.name === name)?.symbolId as string;
	const factIdOf = (text: string) =>
		store.commentsIn(language.source).find((comment) => comment.raw.includes(text))?.factId as string;
	return { dispatch, idOf, factIdOf };
}

function texts(files: ReadonlyArray<{ module: string; text: string }>): Record<string, string> {
	return Object.fromEntries(files.map((file) => [file.module, file.text]));
}

////////////////////////////////
//  Tests

describe.each(Object.entries(LANGUAGES))("standalone comment moves with the %s provider", (_name, language) => {
	it("leaves a banner when its section empties and moves only a placed comment", async () => {
		const { dispatch, idOf } = await served(language, { [language.source]: language.text });
		const moved = (await dispatch("previewMove", {
			symbolId: idOf("lone"),
			toModule: language.target,
		})) as ResponseOf<"previewMove">;
		if (!moved.ok) throw new Error(moved.reason);
		const after = texts(moved.files);
		expect(after[language.source]?.includes("Values")).toBe(true);
		expect(after[language.target]?.includes("Values")).toBe(false);
	}, 60_000);

	it("moves a comment only when explicitly placed", async () => {
		const { dispatch, factIdOf } = await served(language, {
			[language.source]: language.text,
		});
		const moved = (await dispatch("previewArrange", {
			toModule: language.target,
			placements: [{ factId: factIdOf("Note") }],
		})) as ResponseOf<"previewArrange">;
		if (!moved.ok) throw new Error(moved.reason);
		const after = texts(moved.files);
		expect({
			source: after[language.source]?.includes("Note"),
			target: after[language.target]?.includes("Note"),
			placed: moved.placed,
		}).toMatchObject({
			source: false,
			target: true,
			placed: expect.arrayContaining([expect.objectContaining({ factId: factIdOf("Note") })]),
		});
	}, 60_000);

	it("places comments before and after a declaration", async () => {
		const { dispatch, factIdOf, idOf } = await served(language, {
			[language.source]: language.text,
			[language.target]: language.existing,
		});
		for (const side of ["before", "after"] as const) {
			const result = (await dispatch("previewArrange", {
				toModule: language.target,
				placements: [{ factId: factIdOf("Note"), anchor: { symbolId: idOf(language.anchorName), side } }],
			})) as ResponseOf<"previewArrange">;
			if (!result.ok) throw new Error(result.reason);
			const target = texts(result.files)[language.target] ?? "";
			expect(side === "before").toBe(target.indexOf("Note") < target.indexOf(language.anchorName));
		}
	}, 60_000);

	it("chains a comment after another placed comment", async () => {
		const { dispatch, factIdOf } = await served(language, { [language.source]: language.text });
		const first = factIdOf("Values");
		const second = factIdOf("Pair");
		const result = (await dispatch("previewArrange", {
			toModule: language.target,
			placements: [{ factId: first }, { factId: second, anchor: { factId: first, side: "after" } }],
		})) as ResponseOf<"previewArrange">;
		if (!result.ok) throw new Error(result.reason);
		const target = texts(result.files)[language.target] ?? "";
		expect(target.indexOf("Values")).toBeLessThan(target.indexOf("Pair"));
	}, 60_000);

	it("reorders a comment within its module", async () => {
		const { dispatch, factIdOf, idOf } = await served(language, { [language.source]: language.text });
		const result = (await dispatch("previewArrange", {
			toModule: language.source,
			placements: [{ factId: factIdOf("Note"), anchor: { symbolId: idOf("two"), side: "after" } }],
		})) as ResponseOf<"previewArrange">;
		if (!result.ok) throw new Error(result.reason);
		const source = texts(result.files)[language.source] ?? "";
		expect(source.indexOf("Note")).toBeGreaterThan(source.indexOf("two"));
	}, 60_000);

	it("refuses stale ids and comments attached to declarations", async () => {
		const { dispatch, factIdOf } = await served(language, { [language.source]: language.text });
		const stale = await dispatch("previewArrange", {
			toModule: language.target,
			placements: [{ factId: "lexfact comment stale" }],
		});
		const leading = await dispatch("previewArrange", {
			toModule: language.target,
			placements: [{ factId: factIdOf("leading") }],
		});
		expect(stale).toMatchObject({ ok: false });
		expect(leading).toMatchObject({ ok: false });
	}, 60_000);
});
