// Section banners through the daemon's handlers with each provider that moves declarations.

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
	/** The source after `lone` leaves for a new file. */
	emptied: string;
	/** The new file holding `lone`. */
	created: string;
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
			"export function two() {",
			"\treturn 2;",
			"}",
			"",
		].join("\n"),
		existing: "export const marker = 0;\n",
		emptied: [
			"// Header.",
			"",
			"////////////////////////////////",
			"//  Pair",
			"",
			"export function one() {",
			"\treturn 1;",
			"}",
			"",
			"export function two() {",
			"\treturn 2;",
			"}",
			"",
		].join("\n"),
		created: [
			"////////////////////////////////",
			"//  Values",
			"",
			"export function lone() {",
			"\treturn 1;",
			"}",
			"",
		].join("\n"),
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
			"def two():",
			"    return 2",
			"",
		].join("\n"),
		existing: "MARKER = 0\n",
		// The removed def's two-line separator stays, as Python spaces top-level blocks.
		emptied: [
			"# Header.",
			"",
			"",
			"# ------------------------------",
			"#  Pair",
			"",
			"def one():",
			"    return 1",
			"",
			"",
			"def two():",
			"    return 2",
			"",
		].join("\n"),
		created: ["# ------------------------------", "#  Values", "", "def lone():", "    return 1", ""].join("\n"),
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
			"func lone() -> int:",
			"\treturn 1",
			"",
			"# ------------------------------",
			"#  Pair",
			"",
			"func one() -> int:",
			"\treturn 1",
			"",
			"func two() -> int:",
			"\treturn 2",
			"",
		].join("\n"),
		existing: "extends Node\n",
		emptied: [
			"# Header.",
			"extends Node",
			"",
			"# ------------------------------",
			"#  Pair",
			"",
			"func one() -> int:",
			"\treturn 1",
			"",
			"func two() -> int:",
			"\treturn 2",
			"",
		].join("\n"),
		created: ["# ------------------------------", "#  Values", "", "func lone() -> int:", "\treturn 1", ""].join(
			"\n",
		),
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
	const idOf = (name: string) =>
		service.findByName(name, language.source).find((found) => found.module === language.source)?.symbolId as string;
	return { dispatch, idOf };
}

function texts(files: ReadonlyArray<{ module: string; text: string }>): Record<string, string> {
	return Object.fromEntries(files.map((file) => [file.module, file.text]));
}

////////////////////////////////
//  Tests

describe.each(Object.entries(LANGUAGES))("section banners on a move with the %s provider", (_name, language) => {
	it("move with the last declaration of their section, into a file the move creates", async () => {
		const { dispatch, idOf } = await served(language, { [language.source]: language.text });
		const moved = (await dispatch("previewMove", {
			symbolId: idOf("lone"),
			toModule: language.target,
		})) as ResponseOf<"previewMove">;
		if (!moved.ok) throw new Error(moved.reason);
		expect(texts(moved.files)).toEqual({
			[language.source]: language.emptied,
			[language.target]: language.created,
		});
	}, 60_000);

	it("stay while their section keeps a declaration, and never land in a file that exists", async () => {
		const { dispatch, idOf } = await served(language, {
			[language.source]: language.text,
			[language.target]: language.existing,
		});
		const moved = (await dispatch("previewMove", {
			symbolId: idOf("one"),
			toModule: language.target,
		})) as ResponseOf<"previewMove">;
		if (!moved.ok) throw new Error(moved.reason);
		const after = texts(moved.files);
		expect({
			source: after[language.source]?.includes("Pair"),
			target: after[language.target]?.includes("Pair"),
		}).toEqual({ source: true, target: false });
	}, 60_000);

	it("land in a created file in the line ending its moved text lands in", async () => {
		const crlf = language.text.replaceAll("\n", "\r\n");
		const { dispatch, idOf } = await served(language, { [language.source]: crlf });
		const moved = (await dispatch("previewMove", {
			symbolId: idOf("lone"),
			toModule: language.target,
		})) as ResponseOf<"previewMove">;
		if (!moved.ok) throw new Error(moved.reason);
		const created = texts(moved.files)[language.target] ?? "";
		expect({
			banner: created.includes("Values"),
			mixed: created.includes("\r\n") && /[^\r]\n/.test(created),
		}).toEqual({
			banner: true,
			mixed: false,
		});
	}, 60_000);

	// An arrangement places top-level declarations only, and a GDScript file's are its class's methods.
	it.if(language.provider !== "gdscript")(
		"copy once for two members of one section arranged into a new file",
		async () => {
			const { dispatch, idOf } = await served(language, { [language.source]: language.text });
			const arranged = (await dispatch("previewArrange", {
				toModule: language.target,
				placements: [{ symbolId: idOf("one") }, { symbolId: idOf("two") }],
			})) as ResponseOf<"previewArrange">;
			if (!arranged.ok) throw new Error(arranged.reason);
			const after = texts(arranged.files);
			expect({
				copies: after[language.target]?.split("Pair").length,
				source: after[language.source]?.includes("Pair"),
			}).toEqual({ copies: 2, source: false });
		},
		60_000,
	);
});
