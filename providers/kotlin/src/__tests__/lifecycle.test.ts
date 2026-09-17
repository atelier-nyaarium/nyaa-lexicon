import { afterEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Binding, MAX_SOURCE_BYTES, type ModuleAdmission } from "@nyaa-lexicon/protocol";
import { KotlinProvider } from "../main.js";

const roots: string[] = [];

function workspace(files: Record<string, string | Buffer>): string {
	const root = mkdtempSync(path.join(tmpdir(), "lexicon-kotlin-lifecycle-"));
	roots.push(root);
	for (const [module, text] of Object.entries(files)) put(root, module, text);
	return root;
}

function put(root: string, module: string, text: string | Buffer): void {
	const full = path.join(root, module);
	mkdirSync(path.dirname(full), { recursive: true });
	writeFileSync(full, text);
}

function started(root: string): KotlinProvider {
	const provider = new KotlinProvider();
	provider.initialize(root);
	provider.discoverProject(root);
	return provider;
}

const USE = "package p\n\nfun use(): Foo = Foo()\n";
const FOO = "package p\n\nclass Foo\n";
/** A brace left open at the end of the file is refused. */
const REFUSED = "package p\n\nclass Foo\nclass Extra {\n";
/** Parses cleanly, so only the core's word can refuse it. */
const RENAMED = "package p\n\nclass Bar\n";
const BAR_USE = "package p\n\nval b = Bar()\n";

/** The core's word on a parse. */
function verdict(module: string, contentHash: string, reason?: string): ModuleAdmission {
	return {
		module,
		contentHash,
		outcome: reason === undefined ? { status: "admitted" } : { status: "refused", reason },
	};
}

/** Every binding of `name` in a full parse of `text`, one per use. */
function bindings(provider: KotlinProvider, module: string, text: string, name = "Foo"): Binding[] {
	return provider
		.parseFile({ module, contentHash: "h", text })
		.references.filter((reference) => reference.name === name)
		.map((reference) => reference.binding);
}

/** What the uses answer, each distinct answer once. */
function targets(found: Binding[]): string[] {
	const answers = found.map((binding) =>
		binding.status === "bound"
			? binding.symbolId
			: binding.status === "ambiguous"
				? binding.candidates.join(" | ")
				: "unbound",
	);
	return [...new Set(answers)];
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("discovery", () => {
	test("walks Kotlin sources as workspace-relative modules and skips build, tool and dependency directories", () => {
		const excluded = [
			".git",
			".gradle",
			".idea",
			".kotlin",
			".mvn",
			"build",
			"dist",
			"generated",
			"node_modules",
			"out",
			"target",
		];
		const root = workspace({
			"src/A.kt": "class A\n",
			"src/nested/B.kt": "class B\n",
			"README.kt.txt": "class No\n",
			...Object.fromEntries(excluded.map((directory) => [`${directory}/Hidden.kt`, "class Hidden\n"])),
		});

		expect(started(root).discoverProject(root)).toMatchObject({
			files: ["src/A.kt", "src/nested/B.kt"],
			diagnostics: [],
		});
		expect(new KotlinProvider().discoverProject(path.join(root, "absent"))).toMatchObject({
			files: [],
			diagnostics: [{ severity: "error" }],
		});
	});

	test("binds into files never parsed, and lets a module go when a parse moves it to another package", () => {
		const root = workspace({
			"cart/Cart.kt": "package cart\nclass Cart\n",
			"cart/Run.kt": "package cart\nfun run() { Cart() }\n",
		});
		const provider = started(root);
		const run = "package cart\nfun run() { Cart() }\n";
		expect(targets(bindings(provider, "cart/Run.kt", run, "Cart"))).toEqual(["lexicon kotlin cart/Cart.kt Cart#"]);

		provider.parseFile({ module: "cart/Cart.kt", contentHash: "h", text: "package other\nclass Cart\n" });
		expect(targets(bindings(provider, "cart/Run.kt", run, "Cart"))).toEqual(["unbound"]);
	});

	for (const [label, corpus] of [
		["kotlinx-coroutines", path.resolve("temp/kotlinx-coroutines")],
		["Switchboard android", "/home/nyaarium/projects/switchboard/android"],
	] as const)
		test.skipIf(!existsSync(corpus))(
			`reads every file of ${label} without refusing one`,
			async () => {
				const provider = started(corpus);
				const refused: string[] = [];
				let declarations = 0;
				const files = provider.discoverProject(corpus).files;
				for (const module of files) {
					// Yields, so the timeout can fire.
					await new Promise((resolve) => setImmediate(resolve));
					const facts = provider.parseFile({
						module,
						contentHash: "corpus",
						text: readFileSync(path.join(corpus, module), "utf8"),
					});
					declarations += facts.declarations.length;
					if (facts.diagnostics.some((item) => item.severity === "error")) refused.push(module);
				}

				expect(files.length).toBeGreaterThan(500);
				expect(declarations).toBeGreaterThan(files.length * 10);
				expect(refused).toEqual([]);
			},
			120_000,
		);
});

describe("a module the core lets go of", () => {
	test("leaves the index on a rename, so the new path alone answers", () => {
		const root = workspace({ "a/Foo.kt": FOO, "a/Use.kt": USE });
		const provider = started(root);
		expect(targets(bindings(provider, "a/Use.kt", USE))).toEqual(["lexicon kotlin a/Foo.kt Foo#"]);

		renameSync(path.join(root, "a/Foo.kt"), path.join(root, "a/Bar.kt"));
		provider.forgetModule({ module: "a/Foo.kt" });
		provider.parseFile({ module: "a/Bar.kt", contentHash: "h", text: FOO });

		expect(targets(bindings(provider, "a/Use.kt", USE))).toEqual(["lexicon kotlin a/Bar.kt Foo#"]);
		expect(provider.resolveImport({ fromModule: "a/Use.kt", specifier: "p.Foo" })).toEqual({
			status: "resolved",
			module: "a/Bar.kt",
		});
	});

	test("stays out of the first lookup while its file is still on disk, until it is parsed again", () => {
		const root = workspace({ "a/Foo.kt": FOO, "a/Use.kt": USE });
		const provider = started(root);
		// Forgotten before any lookup, as a scope prune arrives before the first full parse.
		provider.forgetModule({ module: "a/Foo.kt" });
		expect(targets(bindings(provider, "a/Use.kt", USE))).toEqual(["unbound"]);

		provider.parseFile({ module: "a/Foo.kt", contentHash: "h", text: FOO, depth: "outline" });
		expect(targets(bindings(provider, "a/Use.kt", USE))).toEqual(["lexicon kotlin a/Foo.kt Foo#"]);
	});

	test("answers no direct read of its own while its file is still on disk, until it is parsed again", () => {
		const root = workspace({ "a/Foo.kt": FOO });
		const provider = started(root);
		const foo = provider
			.parseFile({ module: "a/Foo.kt", contentHash: "h", text: FOO })
			.declarations.find((item) => item.name === "Foo");
		const range = foo?.selectionRange ?? { start: { line: 2, character: 6 }, end: { line: 2, character: 9 } };
		const read = () => [
			provider.bind({ module: "a/Foo.kt", name: "Foo", range }),
			provider.typeOf({ module: "a/Foo.kt", range }),
			provider.typeOf({ symbolId: foo?.symbolId ?? "" }),
		];
		expect(read()[0]).toEqual({ status: "bound", symbolId: "lexicon kotlin a/Foo.kt Foo#", provenance: "bound" });

		provider.forgetModule({ module: "a/Foo.kt" });
		expect(read().map((answer) => ("reason" in answer ? answer.reason : answer.status))).toEqual([
			"NotIndexed",
			"NotIndexed",
			"NotIndexed",
		]);

		provider.parseFile({ module: "a/Foo.kt", contentHash: "h", text: FOO, depth: "outline" });
		expect(read()[0]).toEqual({ status: "bound", symbolId: "lexicon kotlin a/Foo.kt Foo#", provenance: "bound" });
	});

	test("is dropped by a rediscovery once its file is gone, which reads every other file again", () => {
		const root = workspace({ "a/Foo.kt": FOO, "a/Gone.kt": "package p\n\nclass Gone\n", "a/Use.kt": USE });
		const provider = started(root);
		expect(targets(bindings(provider, "a/Use.kt", USE))).toEqual(["lexicon kotlin a/Foo.kt Foo#"]);

		rmSync(path.join(root, "a/Gone.kt"));
		// Changed on disk with no parse, as a client that is not the core leaves it.
		put(root, "a/Foo.kt", "package p\n\nprivate class Foo\n");
		provider.discoverProject(root);

		expect(targets(bindings(provider, "a/Use.kt", "package p\n\nval g = Gone()\n", "Gone"))).toEqual(["unbound"]);
		expect(targets(bindings(provider, "a/Use.kt", USE))).toEqual(["unbound"]);
	});
});

describe("the index takes only what the core admits", () => {
	test("keeps a module's last admitted declarations when the core refuses the parse", () => {
		const root = workspace({ "a/Foo.kt": FOO, "a/Use.kt": USE });
		const provider = started(root);
		expect(targets(bindings(provider, "a/Use.kt", USE))).toEqual(["lexicon kotlin a/Foo.kt Foo#"]);

		// Clean facts, so only the verdict can turn them away.
		const parsed = provider.parseFile({ module: "a/Foo.kt", contentHash: "renamed", text: RENAMED });
		expect(parsed.diagnostics).toEqual([]);
		expect(targets(bindings(provider, "a/Use.kt", BAR_USE, "Bar"))).toEqual(["lexicon kotlin a/Foo.kt Bar#"]);

		provider.moduleAdmission(verdict("a/Foo.kt", "renamed", "the store refused an id"));

		expect(targets(bindings(provider, "a/Use.kt", USE))).toEqual(["lexicon kotlin a/Foo.kt Foo#"]);
		expect(targets(bindings(provider, "a/Use.kt", BAR_USE, "Bar"))).toEqual(["unbound"]);
	});

	test("keeps what was admitted when a rediscovery reads refused text off disk", () => {
		const root = workspace({ "a/Foo.kt": FOO, "a/Use.kt": USE });
		const provider = started(root);
		expect(targets(bindings(provider, "a/Use.kt", USE))).toEqual(["lexicon kotlin a/Foo.kt Foo#"]);

		put(root, "a/Foo.kt", REFUSED);
		provider.discoverProject(root);

		expect(targets(bindings(provider, "a/Use.kt", USE))).toEqual(["lexicon kotlin a/Foo.kt Foo#"]);
		expect(targets(bindings(provider, "a/Use.kt", "package p\n\nval e = Extra()\n", "Extra"))).toEqual(["unbound"]);
	});

	test("holds nothing for a refused parse, and no later fill or read brings it back", () => {
		const root = workspace({ "a/Foo.kt": FOO, "a/Use.kt": USE });
		const provider = started(root);
		const facts = provider.parseFile({ module: "a/Foo.kt", contentHash: "h", text: FOO });
		const foo = facts.declarations.find((item) => item.name === "Foo");
		provider.moduleAdmission(verdict("a/Foo.kt", "h", "the store refused an id"));

		expect(targets(bindings(provider, "a/Use.kt", USE))).toEqual(["unbound"]);
		expect(provider.typeOf({ symbolId: foo?.symbolId ?? "" })).toMatchObject({ reason: "NotIndexed" });

		provider.discoverProject(root);
		expect(targets(bindings(provider, "a/Use.kt", USE))).toEqual(["unbound"]);

		provider.parseFile({ module: "a/Foo.kt", contentHash: "again", text: FOO });
		expect(targets(bindings(provider, "a/Use.kt", USE))).toEqual(["lexicon kotlin a/Foo.kt Foo#"]);
	});

	test("ignores a verdict naming bytes a later parse replaced", () => {
		const root = workspace({ "a/Foo.kt": FOO, "a/Use.kt": USE });
		const provider = started(root);
		provider.parseFile({ module: "a/Foo.kt", contentHash: "first", text: RENAMED });
		provider.parseFile({ module: "a/Foo.kt", contentHash: "second", text: FOO });

		provider.moduleAdmission(verdict("a/Foo.kt", "first", "the store refused an id"));

		expect(targets(bindings(provider, "a/Use.kt", USE))).toEqual(["lexicon kotlin a/Foo.kt Foo#"]);
	});

	test("never reads a file the core refuses on disk, too large or unparseable", () => {
		const padding = Buffer.alloc(MAX_SOURCE_BYTES, 0x20);
		const root = workspace({
			"a/Huge.kt": Buffer.concat([Buffer.from("package p\n\nclass Foo\n"), padding]),
			"a/Broken.kt": "package p\n\nclass Broken {\n",
			"a/Use.kt": USE,
		});
		const provider = started(root);

		expect(targets(bindings(provider, "a/Use.kt", USE))).toEqual(["unbound"]);
		expect(targets(bindings(provider, "a/Use.kt", "package p\n\nval b = Broken()\n", "Broken"))).toEqual([
			"unbound",
		]);
	});

	test("retries a file it could not read on a later lookup", () => {
		if (process.getuid?.() === 0) return;
		const root = workspace({ "a/Foo.kt": FOO, "a/Use.kt": USE });
		chmodSync(path.join(root, "a/Foo.kt"), 0o000);
		const provider = started(root);
		expect(targets(bindings(provider, "a/Use.kt", USE))).toEqual(["unbound"]);

		chmodSync(path.join(root, "a/Foo.kt"), 0o644);
		expect(targets(bindings(provider, "a/Use.kt", USE))).toEqual(["lexicon kotlin a/Foo.kt Foo#"]);
	});
});

describe("a declared type's symbol", () => {
	const typeOfNamed = (provider: KotlinProvider, module: string, text: string, name: string) => {
		const facts = provider.parseFile({ module, contentHash: "h", text });
		const declaration = facts.declarations.find((candidate) => candidate.name === name);
		return provider.typeOf({ symbolId: declaration?.symbolId ?? "" });
	};

	test("is the one its written type binds to, by import, visibility and qualifier", () => {
		const root = workspace({
			"p/Foo.kt": "package p\n\nclass Foo { class Inner }\n",
			"r/Bar.kt": "package r\n\nprivate class Bar\n",
		});
		const provider = started(root);
		const use = [
			"package q",
			"",
			"import p.Foo",
			"",
			"val imported: Foo? = null",
			"val hidden: Bar? = null",
			"val nested: p.Foo.Inner? = null",
			"",
		].join("\n");
		const unimported = "package q\n\nval x: Foo? = null\n";

		expect(typeOfNamed(provider, "q/Use.kt", use, "imported")).toMatchObject({
			display: "Foo?",
			symbolId: "lexicon kotlin p/Foo.kt Foo#",
		});
		expect(typeOfNamed(provider, "q/Use.kt", use, "hidden")).not.toHaveProperty("symbolId");
		expect(typeOfNamed(provider, "q/Use.kt", use, "nested")).toMatchObject({
			symbolId: "lexicon kotlin p/Foo.kt Foo#Inner#",
		});
		expect(typeOfNamed(provider, "q/Other.kt", unimported, "x")).not.toHaveProperty("symbolId");
	});

	test("follows a declaration added after the walk, as the binding does", () => {
		const root = workspace({ "a/Use.kt": "package p\n\nval x: Foo = Foo()\n" });
		const provider = started(root);
		const use = "package p\n\nval x: Foo = Foo()\n";
		expect(typeOfNamed(provider, "a/Use.kt", use, "x")).not.toHaveProperty("symbolId");

		put(root, "a/Foo.kt", FOO);
		provider.parseFile({ module: "a/Foo.kt", contentHash: "h", text: FOO });

		expect(typeOfNamed(provider, "a/Use.kt", use, "x")).toMatchObject({ symbolId: "lexicon kotlin a/Foo.kt Foo#" });
	});
});
