import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { coordinatesOf, type Declaration, handlersFor, parseSymbolId } from "@nyaa-lexicon/protocol";
import { afterEach, describe, expect, test } from "vitest";
import { KotlinProvider, REFERENCE_ROLES, TIERS } from "../main.js";
import { parseKotlin, SourceCursor } from "../parser.js";

const roots: string[] = [];

function makeWorkspace(files: Record<string, string>): string {
	const root = mkdtempSync(path.join(tmpdir(), "lexicon-kotlin-advanced-"));
	roots.push(root);
	for (const [module, text] of Object.entries(files)) {
		const full = path.join(root, module);
		mkdirSync(path.dirname(full), { recursive: true });
		writeFileSync(full, text);
	}
	return root;
}

function declaration(facts: { declarations: Declaration[] }, name: string, kind?: string) {
	return facts.declarations.find((item) => item.name === name && (kind === undefined || item.kind === kind));
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Kotlin cursor and structure", () => {
	test("rewinds both position and line state", () => {
		const cursor = new SourceCursor("😀\nname");
		const mark = cursor.mark();

		expect(cursor.next()).toBe("😀");
		expect(cursor.next()).toBe("\n");
		expect(cursor.line).toBe(1);
		expect(cursor.character).toBe(0);
		cursor.rewind(mark);
		expect(cursor.offset).toBe(0);
		expect(cursor.line).toBe(0);
		expect(cursor.character).toBe(0);
		expect(cursor.peek()).toBe("😀");
	});

	test("stops a delimited reader before its closing delimiter", () => {
		const cursor = new SourceCursor("body)tail");

		expect(cursor.readUntil(")")).toBe("body");
		expect(cursor.peek()).toBe(")");
		expect(cursor.next()).toBe(")");
		expect(cursor.readUntil("!")).toBe("tail");
	});

	test("parses nested classes, objects, interfaces, and constructors", () => {
		const facts = parseKotlin(
			"Nested.kt",
			[
				"abstract class Outer private constructor(seed: Int) {",
				"\tinner class Inner(val value: String)",
				"\tinterface Contract",
				"\tobject Holder {",
				"\t\tconstructor(value: Int) {}",
				"\t}",
				"}",
			].join("\n"),
		);
		const outer = declaration(facts, "Outer");
		const inner = facts.declarations.find((item) => item.name === "Inner");
		const contract = facts.declarations.find((item) => item.name === "Contract");
		const holder = facts.declarations.find((item) => item.name === "Holder");
		const constructors = facts.declarations.filter((item) => item.kind === "constructor");

		expect(outer?.kind).toBe("class");
		expect(outer?.visibility).toBe("public");
		expect(inner?.containerId).toBe(outer?.symbolId);
		expect(contract?.kind).toBe("interface");
		expect(contract?.containerId).toBe(outer?.symbolId);
		expect(holder?.languageKind).toBe("object");
		expect(holder?.containerId).toBe(outer?.symbolId);
		expect(constructors).toHaveLength(3);
		expect(
			constructors.some((item) => item.languageKind === "primaryConstructor" && item.visibility === "private"),
		).toBe(true);
	});

	test("parses enum arguments and preserves entry ranges", () => {
		const facts = parseKotlin("Enum.kt", "enum class Color { RED(1), GREEN, BLUE }\n");
		const entries = facts.declarations.filter((item) => item.languageKind === "enumEntry");

		expect(entries.map((item) => item.name)).toEqual(["RED", "GREEN", "BLUE"]);
		expect(entries[0]?.range.start.character).toBe(19);
		expect(entries[0]?.range.end.character).toBeGreaterThan(entries[0]?.selectionRange?.end.character ?? 0);
		expect(entries.every((item) => item.kind === "constant" && item.exported === true)).toBe(true);
	});

	test("records extension receivers in signatures and type positions", () => {
		const facts = parseKotlin(
			"Extensions.kt",
			"class Separator\nfun List<Separator>.joinWith(other: String): String = joinToString(other)\n",
		);
		const extension = facts.declarations.find((item) => item.name === "joinWith");
		const typeUses = facts.references.filter((item) => item.reference.role === "typeUse");

		expect(extension?.languageKind).toBe("extensionFunction");
		expect(extension?.signature).toContain("List<Separator>.joinWith");
		expect(typeUses.map((item) => item.reference.name)).toContain("Separator");
	});
});

describe("Kotlin references and binding", () => {
	test("binds same-file calls, member reads, writes, and class construction", () => {
		const provider = new KotlinProvider();
		provider.initialize(process.cwd());
		const text = [
			"class Box {",
			"\tvar value: Int = 0",
			"\tfun read(): Int = value",
			"\tfun write(next: Int) { value = next }",
			"}",
			"fun make(): Box = Box()",
		].join("\n");
		const facts = provider.parseFile({ module: "Binding.kt", contentHash: "binding", text });
		const box = declaration(facts, "Box", "class");
		const value = declaration(facts, "value", "property");
		const read = facts.references.find((item) => item.name === "value" && item.role === "read");
		const write = facts.references.find((item) => item.name === "value" && item.role === "write");
		const construction = facts.references.find((item) => item.name === "Box" && item.role === "instantiate");

		expect(read?.binding).toEqual({ status: "bound", symbolId: value?.symbolId, provenance: "bound" });
		expect(write?.binding).toEqual({ status: "bound", symbolId: value?.symbolId, provenance: "bound" });
		expect(construction?.binding).toEqual({ status: "bound", symbolId: box?.symbolId, provenance: "bound" });
	});

	test("keeps local parameters ahead of same-named top-level declarations", () => {
		const provider = new KotlinProvider();
		provider.initialize(process.cwd());
		const text = ['val value: String = "top"', "fun read(value: Int): Int { return value }"].join("\n");
		const facts = provider.parseFile({ module: "Shadow.kt", contentHash: "shadow", text });
		const parameter = declaration(facts, "value", "variable");
		const reference = facts.references.find((item) => item.name === "value" && item.role === "read");

		expect(parameter?.languageKind).toBe("parameter");
		expect(reference?.binding).toEqual({ status: "bound", symbolId: parameter?.symbolId, provenance: "bound" });
	});

	test("reports call, read, write, instantiate, extends, typeUse, and import roles", () => {
		const facts = parseKotlin(
			"Roles.kt",
			[
				"import sample.Base",
				"class Child : Base() {",
				"\tvar count: Int = 0",
				"\tfun bump() { count += helper() }",
				"}",
				"fun helper(): Int = 1",
			].join("\n"),
		);
		const roles = new Set(facts.references.map((item) => item.reference.role));

		expect([...roles].every((role) => (REFERENCE_ROLES as readonly string[]).includes(role))).toBe(true);
		expect(roles).toEqual(new Set(["import", "extends", "read", "write", "call"]));
	});

	test("binds imported members through a package declaration", () => {
		const root = makeWorkspace({
			"base/Base.kt": "package sample\nopen class Base { fun ping(): Int = 1 }\n",
			"child/Child.kt": "package child\nimport sample.Base\nfun make(): Base = Base()\n",
		});
		const provider = new KotlinProvider();
		provider.initialize(root);
		const baseText = readFileSync(path.join(root, "base/Base.kt"), "utf8");
		const base = provider.parseFile({ module: "base/Base.kt", contentHash: "base", text: baseText });
		const childText = readFileSync(path.join(root, "child/Child.kt"), "utf8");
		const child = provider.parseFile({ module: "child/Child.kt", contentHash: "child", text: childText });
		const baseId = declaration(base, "Base", "class")?.symbolId;
		const refs = child.references.filter((item) => item.name === "Base");

		expect(refs.some((item) => item.binding.status === "bound" && item.binding.symbolId === baseId)).toBe(true);
		expect(
			provider.bind({
				module: "child/Child.kt",
				name: "Base",
				range: refs.at(-1)?.range ?? { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
			}),
		).toMatchObject({ status: "bound", symbolId: baseId });
	});

	test("returns explicit Unknown reasons for external and unindexed references", () => {
		const provider = new KotlinProvider();
		provider.initialize(process.cwd());
		const facts = provider.parseFile({
			module: "Unknown.kt",
			contentHash: "unknown",
			text: "fun run() = externalCall()\n",
		});
		const reference = facts.references.find((item) => item.name === "externalCall");

		expect(reference?.binding).toMatchObject({ status: "unbound", reason: "NotIndexed" });
		expect(
			provider.bind({
				module: "Unknown.kt",
				name: "missing",
				range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
			}),
		).toMatchObject({ status: "unbound", reason: "NotIndexed" });
	});
});

describe("Kotlin types and literals", () => {
	test("answers typeOf by declaration range as well as symbol id", () => {
		const provider = new KotlinProvider();
		provider.initialize(process.cwd());
		const text = 'val count: Int = 1\nfun name(): String = "ok"\n';
		const facts = provider.parseFile({ module: "RangeTypes.kt", contentHash: "range", text });
		const count = declaration(facts, "count");
		const name = declaration(facts, "name");

		expect(count).toBeDefined();
		expect(name).toBeDefined();
		expect(
			provider.typeOf({
				module: "RangeTypes.kt",
				range: count?.selectionRange ?? { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
			}),
		).toMatchObject({ status: "known", display: "Int" });
		expect(
			provider.typeOf({
				module: "RangeTypes.kt",
				range: name?.selectionRange ?? { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
			}),
		).toMatchObject({ status: "known", display: "String" });
	});

	test("does not infer compound property initializers", () => {
		const provider = new KotlinProvider();
		provider.initialize(process.cwd());
		const facts = provider.parseFile({
			module: "Compound.kt",
			contentHash: "compound",
			text: 'val value = 1 + 2\nval text = "a" + "b"\n',
		});

		expect(provider.typeOf({ symbolId: declaration(facts, "value")?.symbolId ?? "" })).toMatchObject({
			status: "unknown",
			reason: "NotImplemented",
		});
		expect(provider.typeOf({ symbolId: declaration(facts, "text")?.symbolId ?? "" })).toMatchObject({
			status: "unknown",
			reason: "NotImplemented",
		});
	});

	test("decodes escaped string values and reports numeric suffixes", () => {
		const facts = parseKotlin("Literals.kt", 'val text = "a\\n\\u0042"\nval big = 2L\nval ratio = 1.5f\n');
		const text = facts.literals.find((literal) => literal.kind === "string");
		const numbers = facts.literals.filter((literal) => literal.kind === "number");

		expect(text?.value).toBe("a\nB");
		expect(numbers.map((literal) => literal.number)).toEqual([2, 1.5]);
	});

	test("does not turn null into a boolean literal", () => {
		const facts = parseKotlin("Null.kt", "val nothing = null\n");

		expect(facts.literals).toEqual([]);
		expect(facts.declarations).toHaveLength(1);
	});

	test("resolves a named declared type when one workspace declaration proves it", () => {
		const root = makeWorkspace({
			"model/Thing.kt": "package model\nclass Thing\n",
			"use/Value.kt": "package use\nimport model.Thing\nval item: Thing = Thing()\n",
		});
		const provider = new KotlinProvider();
		provider.initialize(root);
		const modelText = readFileSync(path.join(root, "model/Thing.kt"), "utf8");
		provider.parseFile({ module: "model/Thing.kt", contentHash: "thing", text: modelText });
		const useText = readFileSync(path.join(root, "use/Value.kt"), "utf8");
		const facts = provider.parseFile({ module: "use/Value.kt", contentHash: "value", text: useText });
		const item = declaration(facts, "item");
		const thing = provider.typeOf({ symbolId: item?.symbolId ?? "" });

		expect(thing).toMatchObject({ status: "known", display: "Thing" });
		expect(thing.status === "known" ? parseSymbolId(thing.symbolId ?? "")?.module : undefined).toBe(
			"model/Thing.kt",
		);
	});
});

describe("Kotlin diagnostics and protocol", () => {
	test("diagnoses unclosed strings, comments, delimiters, and malformed declarations", () => {
		const cases = ['val text = "unterminated', "/* unterminated", "fun run( {", "class {"];

		for (const text of cases) {
			const facts = parseKotlin("Broken.kt", text);
			expect(facts.diagnostics.some((item) => item.severity === "error")).toBe(true);
		}
	});

	test("does not report delimiter errors for nested valid expressions", () => {
		const facts = parseKotlin(
			"Valid.kt",
			"fun run(value: Int): Int { return if (value > 0) listOf(1, 2)[0] else 0 }\n",
		);

		expect(facts.diagnostics).toEqual([]);
	});

	test("reports ranges with line and UTF-16 character coordinates", () => {
		const text = "/* 😀 */ val name = 1\n";
		const facts = parseKotlin("Unicode.kt", text);
		const item = facts.declarations.find((declaration) => declaration.name === "name");

		expect(item).toBeDefined();
		expect(item?.selectionRange?.start).toEqual({ line: 0, character: 13 });
		expect(item?.selectionRange?.end).toEqual({ line: 0, character: 17 });
	});

	test("initializes all tiers and answers every handler", () => {
		const provider = new KotlinProvider();
		const info = provider.initialize(process.cwd());
		const handlers = handlersFor(provider);

		expect(info.language).toBe("kotlin");
		expect(info.extensions).toEqual([".kt"]);
		expect(info.tiers).toEqual(TIERS);
		expect(info.referenceRoles).toEqual([...REFERENCE_ROLES]);
		expect(Object.keys(handlers).sort()).toEqual([
			"bind",
			"discoverProject",
			"initialize",
			"moveEdits",
			"parseFile",
			"renameEdits",
			"resolveImport",
			"shutdown",
			"typeOf",
		]);
	});

	test("refuses write operations with closed protocol reasons", () => {
		const provider = new KotlinProvider();
		provider.initialize(process.cwd());
		const rename = provider.renameEdits({ module: "a.kt", text: "", oldName: "a", newName: "b", sites: [] });
		const move = provider.moveEdits({
			module: "a.kt",
			text: "",
			exists: false,
			symbolId: "lexicon kotlin a.kt a.",
			name: "a",
			fromModule: "a.kt",
			toModule: "b.kt",
			role: {},
			importSites: [],
			dependencies: [],
			sites: [],
		});

		expect(rename).toMatchObject({ status: "refused", reason: "NotImplemented" });
		expect(move).toMatchObject({ status: "refused", reason: "NotImplemented" });
	});

	test("returns project diagnostics for an invalid root", () => {
		const provider = new KotlinProvider();
		const root = path.join(tmpdir(), "kotlin-root-that-is-not-present");

		expect(provider.discoverProject(root)).toMatchObject({ files: [], diagnostics: [{ severity: "error" }] });
	});

	test("uses workspace-relative modules for project files", () => {
		const root = makeWorkspace({ "src/Main.kt": "package demo\n" });
		const provider = new KotlinProvider();
		provider.initialize(root);

		expect(provider.discoverProject(root).files).toEqual(["src/Main.kt"]);
	});

	test("keeps empty files valid and produces no phantom declarations", () => {
		const facts = parseKotlin("Empty.kt", "\n\n");

		expect(facts.declarations).toEqual([]);
		expect(facts.references).toEqual([]);
		expect(facts.imports).toEqual([]);
		expect(facts.literals).toEqual([]);
		expect(facts.diagnostics).toEqual([]);
	});

	test("keeps source slicing compatible with the reported range", () => {
		const text = "fun run(): Int { return 1 }\n";
		const facts = parseKotlin("Slice.kt", text);
		const run = facts.declarations.find((declaration) => declaration.name === "run");
		const coordinates = coordinatesOf(text);

		expect(run).toBeDefined();
		expect(run === undefined ? undefined : coordinates.sliceRange(run.range)).toBe("fun run(): Int { return 1 }");
	});
});
