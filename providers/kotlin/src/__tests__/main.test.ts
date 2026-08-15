import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { FileFactsSchema, parseSymbolId } from "@nyaa-lexicon/protocol";
import { afterEach, expect, test } from "vitest";
import { KotlinProvider } from "../main.js";

const roots: string[] = [];

function workspace(files: Record<string, string>): string {
	const root = mkdtempSync(path.join(tmpdir(), "lexicon-kotlin-provider-"));
	roots.push(root);
	for (const [module, text] of Object.entries(files)) {
		const full = path.join(root, module);
		mkdirSync(path.dirname(full), { recursive: true });
		writeFileSync(full, text);
	}
	return root;
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("extracts Kotlin declarations, containers, signatures, KDoc, and metrics", () => {
	const provider = new KotlinProvider();
	provider.initialize(process.cwd());
	const text = [
		"package demo",
		"",
		"/** Cart docs */",
		"data class Cart(val id: Int, private var label: String) {",
		"\tcompanion object { const val LIMIT = 3 }",
		'\tprivate val hidden = "x"',
		'\tsuspend fun fetch(item: Int): String { if (item > 0) return label; return "none" }',
		"\tinner class Detail",
		"}",
		"interface Service",
		"sealed abstract class State",
		"enum class Mode { READY, DONE }",
		"object Registry",
		"typealias Alias = Cart",
		"fun String.ext(): Int = length",
		"internal val visible = true",
		"protected fun hiddenFunction() {}",
	].join("\n");
	const facts = provider.parseFile({ module: "Cart.kt", contentHash: "cart", text });

	const cart = facts.declarations.find((declaration) => declaration.name === "Cart" && declaration.kind === "class");
	const id = facts.declarations.find((declaration) => declaration.name === "id");
	const label = facts.declarations.find((declaration) => declaration.name === "label");
	const fetch = facts.declarations.find((declaration) => declaration.name === "fetch");
	const mode = facts.declarations.find((declaration) => declaration.name === "Mode");
	const alias = facts.declarations.find((declaration) => declaration.name === "Alias");
	const extension = facts.declarations.find((declaration) => declaration.name === "ext");

	expect(cart?.docComment).toBe("Cart docs");
	expect(parseSymbolId(cart?.symbolId ?? "")?.descriptors).toEqual([{ kind: "type", name: "Cart" }]);
	expect(id?.kind).toBe("property");
	expect(id?.containerId).toBe(cart?.symbolId);
	expect(label).toMatchObject({ visibility: "private", exported: false });
	expect(fetch).toMatchObject({ kind: "method", languageKind: "suspend" });
	expect(fetch?.signature).toContain("suspend fun fetch");
	expect(fetch?.metrics?.parameters).toBe(1);
	expect((fetch?.metrics?.branches ?? 0) > 1).toBe(true);
	expect(mode?.kind).toBe("enum");
	expect(
		facts.declarations
			.filter((declaration) => declaration.languageKind === "enumEntry")
			.map((declaration) => declaration.name),
	).toEqual(["READY", "DONE"]);
	expect(alias).toMatchObject({ kind: "class", languageKind: "typealias" });
	expect(extension).toMatchObject({ kind: "function", languageKind: "extensionFunction" });
	expect(extension?.signature).toContain("String.ext");
	expect(facts.declarations.find((declaration) => declaration.name === "visible")).toMatchObject({
		exported: true,
		visibility: "internal",
	});
	expect(facts.declarations.find((declaration) => declaration.name === "hiddenFunction")).toMatchObject({
		exported: false,
		visibility: "protected",
	});
	expect(facts.diagnostics.filter((item) => item.severity === "error")).toHaveLength(0);
});

test("keeps UTF-16 columns after an astral literal", () => {
	const provider = new KotlinProvider();
	provider.initialize(process.cwd());
	const text = 'val before = "😀"; val after = 1\n';
	const facts = provider.parseFile({ module: "positions.kt", contentHash: "positions", text });
	const after = facts.declarations.find((declaration) => declaration.name === "after");

	expect(after?.selectionRange.start).toEqual({ line: 0, character: 23 });
});

test("extracts aliased and star imports with source ranges", () => {
	const provider = new KotlinProvider();
	provider.initialize(process.cwd());
	const text = [
		"package demo",
		"import sample.models.Item as Product",
		"import sample.models.*",
		"",
		"fun use(value: Product): Item = value",
	].join("\n");
	const facts = provider.parseFile({ module: "Use.kt", contentHash: "imports", text });

	expect(facts.imports).toHaveLength(2);
	expect(facts.imports[0]).toMatchObject({
		specifier: "sample.models.Item",
		imported: [{ name: "Item", local: "Product" }],
	});
	expect(facts.imports[1]).toMatchObject({ specifier: "sample.models.*", imported: [{ name: "*" }] });
	expect(facts.imports[0]?.imported[0]?.range).toBeDefined();
	expect(facts.imports[0]?.imported[0]?.localRange).toBeDefined();
});

test("resolves workspace packages, external roots, missing packages, and direct bindings", () => {
	const root = workspace({
		"src/Item.kt": "package sample.models\nclass Item\n",
		"src/Use.kt": [
			"package sample.use",
			"import sample.models.Item as Product",
			"fun use(value: Product): Product = Product()",
		].join("\n"),
	});
	const provider = new KotlinProvider();
	provider.initialize(root);
	const item = provider.parseFile({
		module: "src/Item.kt",
		contentHash: "item",
		text: readFileSync(path.join(root, "src/Item.kt"), "utf8"),
	});
	const useText = readFileSync(path.join(root, "src/Use.kt"), "utf8");
	const use = provider.parseFile({ module: "src/Use.kt", contentHash: "use", text: useText });

	expect(provider.resolveImport({ fromModule: "src/Use.kt", specifier: "sample.models.Item" })).toEqual({
		status: "resolved",
		module: "src/Item.kt",
	});
	expect(provider.resolveImport({ fromModule: "src/Use.kt", specifier: "kotlin.collections.List" })).toMatchObject({
		status: "external",
		packageName: "kotlin.collections.List",
	});
	expect(provider.resolveImport({ fromModule: "src/Use.kt", specifier: "missing.package.Gone" })).toMatchObject({
		status: "unresolved",
		reason: "NotIndexed",
	});
	const itemId = item.declarations.find((declaration) => declaration.name === "Item")?.symbolId;
	expect(
		use.references
			.filter((reference) => reference.name === "Product")
			.some((reference) => reference.binding.status === "bound" && reference.binding.symbolId === itemId),
	).toBe(true);
});

test("makes star-import bindings ambiguous when a package has several files", () => {
	const root = workspace({
		"one.kt": "package sample.star\nclass Thing\n",
		"two.kt": "package sample.star\nclass Thing\n",
		"use.kt": "package sample.use\nimport sample.star.*\nfun use(): Thing = Thing()\n",
	});
	const provider = new KotlinProvider();
	provider.initialize(root);
	const text = readFileSync(path.join(root, "use.kt"), "utf8");
	const facts = provider.parseFile({ module: "use.kt", contentHash: "star", text });
	const thing = facts.references.find((reference) => reference.name === "Thing");

	expect(provider.resolveImport({ fromModule: "use.kt", specifier: "sample.star.*" })).toMatchObject({
		status: "unresolved",
		reason: "Ambiguous",
	});
	expect(thing?.binding).toMatchObject({ status: "unbound", reason: "Ambiguous" });
});

test("reports declared types, literal inference, literal facts, and syntax errors", () => {
	const provider = new KotlinProvider();
	provider.initialize(process.cwd());
	const text = [
		"const val count = 1",
		'val label = "ready"',
		"val enabled = true",
		"val unknown = makeValue()",
		"val declared: Long = 1L",
		"fun answer(value: Int): String { return label }",
	].join("\n");
	const facts = provider.parseFile({ module: "Types.kt", contentHash: "types", text });
	const declaration = (name: string) => facts.declarations.find((item) => item.name === name);

	expect(provider.typeOf({ symbolId: declaration("count")?.symbolId ?? "" })).toMatchObject({
		status: "inferred",
		display: "Int",
	});
	expect(provider.typeOf({ symbolId: declaration("declared")?.symbolId ?? "" })).toMatchObject({
		status: "known",
		display: "Long",
		provenance: "declared",
	});
	expect(provider.typeOf({ symbolId: declaration("unknown")?.symbolId ?? "" })).toMatchObject({
		status: "unknown",
		reason: "NotImplemented",
	});
	expect(provider.typeOf({ symbolId: declaration("answer")?.symbolId ?? "" })).toMatchObject({
		status: "known",
		display: "String",
	});
	expect(facts.literals.map((literal) => literal.kind)).toEqual(["number", "string", "boolean", "number"]);
	expect(facts.literals.every((literal) => literal.containerId !== undefined)).toBe(true);

	const broken = provider.parseFile({ module: "Broken.kt", contentHash: "broken", text: "fun add( {\n" });
	expect(broken.diagnostics.some((item) => item.severity === "error")).toBe(true);
});

test("honors outline depth while retaining declarations, imports, and diagnostics", () => {
	const provider = new KotlinProvider();
	provider.initialize(process.cwd());
	const outline = provider.parseFile({
		module: "Outline.kt",
		contentHash: "outline",
		depth: "outline",
		text: [
			"package demo",
			"import kotlin.collections.List",
			"class Box { fun run(values: List<Int>): String = values.first().toString() }",
			"val count = 1",
		].join("\n"),
	});
	const broken = provider.parseFile({
		module: "BrokenOutline.kt",
		contentHash: "broken-outline",
		depth: "outline",
		text: "class Broken {\n",
	});

	expect(outline.depth).toBe("outline");
	expect(outline.declarations.map((item) => item.name)).toEqual(
		expect.arrayContaining(["demo", "Box", "run", "count"]),
	);
	expect(outline.imports).toMatchObject([{ specifier: "kotlin.collections.List" }]);
	expect(outline.references).toEqual([]);
	expect(outline.literals).toEqual([]);
	expect(broken.depth).toBe("outline");
	expect(broken.diagnostics.some((item) => item.severity === "error")).toBe(true);
	FileFactsSchema.parse(outline);
	FileFactsSchema.parse(broken);
});

test("walks Kotlin files while excluding generated and dependency directories", () => {
	const root = workspace({
		"src/Main.kt": "package demo\n",
		"build/Generated.kt": "package generated\n",
		"node_modules/dep/Dep.kt": "package dep\n",
		".gradle/cache/Cache.kt": "package cache\n",
	});
	const provider = new KotlinProvider();
	provider.initialize(root);

	expect(provider.discoverProject(root)).toMatchObject({ files: ["src/Main.kt"] });
});
