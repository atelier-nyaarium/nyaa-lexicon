import path from "node:path";
import { composeSymbolId, coordinatesOf } from "@nyaa-lexicon/protocol";
import { expect, test } from "vitest";
import { extractDeclarationsCore, extractReferencesCore } from "../extractCore.js";
import { GDScriptProvider, REFERENCE_ROLES, TIERS } from "../main.js";

function rangeAt(text: string, offset: number) {
	const position = coordinatesOf(text).positionAt(offset);
	if (position === undefined) throw new Error(`test offset is outside text: ${offset}`);
	return { start: position, end: position };
}

test("extracts the GDScript declaration forms used by the project", () => {
	const declarations = extractDeclarationsCore(
		"scripts/example.gd",
		`class_name Example\nextends RefCounted\n\n@export var title: String = ""\nconst LIMIT := 2\nsignal changed(value: String)\nenum State { READY, DONE = 2 }\nfunc run(value: int) -> void:\n\tvar _local := value\n\nclass Inner:\n\tfunc call() -> void:\n\t\tpass\n`,
		composeSymbolId,
	);

	expect(declarations.map((declaration) => declaration.name)).toEqual([
		"Example",
		"title",
		"LIMIT",
		"changed",
		"State",
		"READY",
		"DONE",
		"run",
		"value",
		"_local",
		"Inner",
		"call",
	]);
	// The script IS the class: a one-line root range once made a class-level move relocate only
	// the class_name line and orphan every member behind it.
	expect(declarations.find((declaration) => declaration.name === "Example")?.range).toEqual({
		start: { line: 0, character: 0 },
		end: { line: 12, character: "\t\tpass".length },
	});
	expect(declarations.find((declaration) => declaration.name === "changed")?.kind).toBe("event");
	expect(declarations.find((declaration) => declaration.name === "_local")?.visibility).toBe("local");
	expect(declarations.find((declaration) => declaration.name === "call")?.containerId).toBe(
		declarations.find((declaration) => declaration.name === "Inner")?.symbolId,
	);
	expect(declarations.every((declaration) => declaration.exported === undefined)).toBe(true);
});

test("extends block declaration ranges through their owned bodies", () => {
	const text = `func add(a, b):
	var sum := a + b
	return sum

class Inner:
	var value := 1
	func get_value():
		return value

var after := 0
`;
	const declarations = extractDeclarationsCore("scripts/ranges.gd", text, composeSymbolId);
	const add = declarations.find((declaration) => declaration.name === "add");
	const inner = declarations.find((declaration) => declaration.name === "Inner");

	expect(add?.range).toEqual({
		start: { line: 0, character: 0 },
		end: { line: 2, character: "\treturn sum".length },
	});
	expect(inner?.range).toEqual({
		start: { line: 4, character: 0 },
		end: { line: 7, character: "\t\treturn value".length },
	});
});

test("uses a method range for complete symbol source", () => {
	const text = `func add(a, b):
	return a + b
`;
	const declarations = extractDeclarationsCore("scripts/source.gd", text, composeSymbolId);
	const method = declarations.find((declaration) => declaration.name === "add");
	if (method === undefined) throw new Error("method declaration missing");

	const source = coordinatesOf(text).sliceRange(method.range);
	if (source === undefined) throw new Error("method range is outside test text");
	expect(source).toBe("func add(a, b):\n\treturn a + b");
});

test("ends emitted CRLF ranges before the line terminator", () => {
	const declarations = extractDeclarationsCore("crlf.gd", "func run():\r\n\tpass\r\n", composeSymbolId);
	const run = declarations.find((declaration) => declaration.name === "run");

	expect(run?.range).toEqual({
		start: { line: 0, character: 0 },
		end: { line: 1, character: "\tpass".length },
	});
});

test("attaches consecutive GDScript documentation comments to declarations", () => {
	const declarations = extractDeclarationsCore(
		"scripts/docs.gd",
		`## Script docs [br]
## [codeblock]
## print("hello")
extends Node
class_name Documented

## Runs the task.
## [param value] Input value.
func run(value: int) -> void:
	pass

## Speed in meters.
var speed: float

## Emits when finished.
signal finished

## Maximum value.
const LIMIT: int = 3

## Nested helper.
class Inner:
	pass

## State values.
enum State { READY, DONE }

## Separated from the declaration.

var separated: int
# This is an ordinary comment.
var plain: int
`,
		composeSymbolId,
	);
	const docOf = (name: string) => declarations.find((declaration) => declaration.name === name)?.docComment;

	expect(docOf("Documented")).toBe('Script docs [br]\n[codeblock]\nprint("hello")');
	expect(docOf("run")).toBe("Runs the task.\n[param value] Input value.");
	expect(docOf("speed")).toBe("Speed in meters.");
	expect(docOf("finished")).toBe("Emits when finished.");
	expect(docOf("LIMIT")).toBe("Maximum value.");
	expect(docOf("Inner")).toBe("Nested helper.");
	expect(docOf("State")).toBe("State values.");
	expect(docOf("separated")).toBeUndefined();
	expect(docOf("plain")).toBeUndefined();
});

test("attaches script documentation after a file header comment", () => {
	const declarations = extractDeclarationsCore(
		"scripts/header-docs.gd",
		`# Copyright notice
## Script description.
class_name HeaderDocs
extends Node
`,
		composeSymbolId,
	);

	expect(declarations[0]?.name).toBe("HeaderDocs");
	expect(declarations[0]?.docComment).toBe("Script description.");
});

test("keeps the shared declaration corpus shape usable", () => {
	const declarations = extractDeclarationsCore(
		"src/cart.ts",
		"export class Cart {}\nexport function add() {}\nexport const LIMIT = 1;\n",
		composeSymbolId,
	);

	expect(declarations.map((declaration) => [declaration.name, declaration.kind, declaration.exported])).toEqual([
		["Cart", "class", true],
		["add", "function", true],
		["LIMIT", "constant", true],
	]);
});

test("keeps multiline function locals inside the function", () => {
	const module = "scripts/multiline.gd";
	const declarations = extractDeclarationsCore(
		module,
		`class_name Example
static func solve(
	value: int,
) -> int:
	var local := value

var after := 1
`,
		composeSymbolId,
	);
	const solve = declarations.find((declaration) => declaration.name === "solve");
	const local = declarations.find((declaration) => declaration.name === "local");

	expect(solve?.range.end).toEqual({ line: 4, character: "\tvar local := value".length });
	expect(solve?.signature).toBe("static func solve(\nvalue: int,\n) -> int:");
	expect(local?.kind).toBe("variable");
	expect(local?.containerId).toBe(solve?.symbolId);
	expect(declarations.filter((declaration) => declaration.name === "local")).toHaveLength(1);
});

test("extracts every semicolon-separated local declaration", () => {
	const declarations = extractDeclarationsCore(
		"scripts/semicolon.gd",
		`func run():
	var R := 0; var L := 2; var B := 1; var F := 3
`,
		composeSymbolId,
	);
	const run = declarations.find((declaration) => declaration.name === "run");
	const locals = ["R", "L", "B", "F"].map((name) => declarations.find((declaration) => declaration.name === name));

	expect(locals.map((declaration) => declaration?.name)).toEqual(["R", "L", "B", "F"]);
	expect(locals.map((declaration) => declaration?.kind)).toEqual(["variable", "variable", "variable", "variable"]);
	expect(locals.every((declaration) => declaration?.containerId === run?.symbolId)).toBe(true);
});

test("extracts typed and untyped for bindings as local variables", () => {
	const declarations = extractDeclarationsCore(
		"scripts/loops.gd",
		`func run(items: Array[Node]) -> void:
		for item in items:
			for index: int in range(2):
				print(item, index)
`,
		composeSymbolId,
	);
	const run = declarations.find((declaration) => declaration.name === "run");
	const item = declarations.find((declaration) => declaration.name === "item");
	const index = declarations.find((declaration) => declaration.name === "index");

	expect(item?.kind).toBe("variable");
	expect(index?.kind).toBe("variable");
	expect(item?.visibility).toBe("local");
	expect(index?.visibility).toBe("local");
	expect(item?.containerId).toBe(run?.symbolId);
	expect(index?.containerId).toBe(run?.symbolId);
});

test("extracts named function parameters with owned symbol ids", () => {
	const module = "scripts/parameters.gd";
	const text = `class_name Parameters
func run(
	plain,
	typed: int,
	with_default: String = "x",
	inferred := false,
) -> void:
	print(plain, typed, with_default, inferred)

class Inner:
	func nested(value: Node) -> void:
		print(value)

func generic(items: Dictionary[String, int]) -> void:
	print(items)

var callback = func(lambda_value: int):
	return lambda_value

signal changed(signal_value: String)
`;
	const declarations = extractDeclarationsCore(module, text, composeSymbolId);
	const declaration = (name: string) => declarations.find((candidate) => candidate.name === name);
	const run = declaration("run");
	const nested = declaration("nested");
	const plain = declaration("plain");
	const typed = declaration("typed");
	const withDefault = declaration("with_default");
	const inferred = declaration("inferred");
	const value = declaration("value");
	const generic = declaration("generic");
	const items = declaration("items");

	expect([plain, typed, withDefault, inferred, value].map((candidate) => candidate?.kind)).toEqual([
		"variable",
		"variable",
		"variable",
		"variable",
		"variable",
	]);
	expect([plain, typed, withDefault, inferred, value].every((candidate) => candidate?.visibility === "local")).toBe(
		true,
	);
	expect([plain, typed, withDefault, inferred].every((candidate) => candidate?.containerId === run?.symbolId)).toBe(
		true,
	);
	expect(value?.containerId).toBe(nested?.symbolId);
	expect(items?.containerId).toBe(generic?.symbolId);
	expect(generic?.metrics?.parameters).toBe(1);
	expect(typed?.range.end).toEqual({ line: 3, character: 11 });
	expect(withDefault?.range.end).toEqual({ line: 4, character: 21 });
	expect(inferred?.range.end).toEqual({ line: 5, character: 9 });
	expect(plain?.selectionRange).toEqual({
		start: { line: 2, character: 1 },
		end: { line: 2, character: 6 },
	});
	expect(plain?.symbolId).toBe(
		composeSymbolId({
			language: "gdscript",
			module,
			descriptors: [
				{ kind: "type", name: "Parameters" },
				{ kind: "method", name: "run" },
				{ kind: "parameter", name: "plain" },
			],
		}),
	);
	expect(value?.symbolId).toBe(
		composeSymbolId({
			language: "gdscript",
			module,
			descriptors: [
				{ kind: "type", name: "Parameters" },
				{ kind: "type", name: "Inner" },
				{ kind: "method", name: "nested" },
				{ kind: "parameter", name: "value" },
			],
		}),
	);
	expect(declaration("lambda_value")).toBeUndefined();
	expect(declaration("signal_value")).toBeUndefined();
});

test("preserves Unicode identifier names and symbol identity", () => {
	const module = "scripts/unicode.gd";
	const declarations = extractDeclarationsCore(module, "var przykład := 1\n", composeSymbolId);
	const declaration = declarations.find((candidate) => candidate.name === "przykład");

	expect(declaration?.name).toBe("przykład");
	expect(declaration?.selectionRange).toEqual({
		start: { line: 0, character: 4 },
		end: { line: 0, character: 12 },
	});
	expect(declaration?.symbolId).toBe(
		composeSymbolId({
			language: "gdscript",
			module,
			descriptors: [
				{ kind: "type", name: "unicode" },
				{ kind: "term", name: "przykład" },
			],
		}),
	);
});

test("uses UTF-16 units for every emitted GDScript range", () => {
	const provider = new GDScriptProvider();
	provider.initialize("/workspace");
	const text = `var target := 1
var face = "😀"; const Script = preload("res://other.gd")
var face2 = "😀"; var marker = "hello"; var count = 0xFF; var enabled = true
var face3 = "😀"; target = target
var face4 = "😀"; var loaded = load(path)
var face5 = "😀"; var pathLoaded = load("res://other.gd")
`;
	const facts = provider.parseFile({ module: "ranges.gd", contentHash: "ranges", text });
	const lines = text.split("\n");
	const scriptLine = lines[1] as string;
	const markerLine = lines[2] as string;
	const targetLine = lines[3] as string;
	const loadLine = lines[4] as string;
	const pathLine = lines[5] as string;
	const script = facts.declarations.find((declaration) => declaration.name === "Script");
	const marker = facts.literals.find((literal) => literal.value === "hello");
	const count = facts.literals.find((literal) => literal.value === "0xFF");
	const enabled = facts.literals.find((literal) => literal.value === "true");
	const imported = facts.imports.find((entry) => entry.specifier === "res://other.gd");
	const targetStart = targetLine.indexOf("target", targetLine.indexOf("😀"));
	const loadStart = loadLine.indexOf("load(", loadLine.indexOf("😀"));
	const pathStart = pathLine.indexOf("res://");
	const targetReferences = facts.references.filter(
		(reference) => reference.name === "target" && reference.range.start.line === 3,
	);

	expect(script?.range).toEqual({
		start: { line: 1, character: 0 },
		end: { line: 1, character: scriptLine.length },
	});
	expect(script?.selectionRange).toEqual({
		start: { line: 1, character: scriptLine.indexOf("Script") },
		end: { line: 1, character: scriptLine.indexOf("Script") + "Script".length },
	});
	expect(imported?.imported[0]?.localRange).toEqual(script?.selectionRange);
	expect(marker?.range).toEqual({
		start: { line: 2, character: markerLine.indexOf('"hello"') },
		end: { line: 2, character: markerLine.indexOf('"hello"') + '"hello"'.length },
	});
	expect(count?.range).toEqual({
		start: { line: 2, character: markerLine.indexOf("0xFF") },
		end: { line: 2, character: markerLine.indexOf("0xFF") + "0xFF".length },
	});
	expect(enabled?.range).toEqual({
		start: { line: 2, character: markerLine.indexOf("true") },
		end: { line: 2, character: markerLine.indexOf("true") + "true".length },
	});
	expect(targetReferences).toHaveLength(2);
	expect(targetReferences.map((reference) => reference.range)).toEqual([
		{
			start: { line: 3, character: targetStart },
			end: { line: 3, character: targetStart + "target".length },
		},
		{
			start: { line: 3, character: targetStart + "target".length + 3 },
			end: { line: 3, character: targetStart + "target".length * 2 + 3 },
		},
	]);
	const loadReference = facts.references.find((reference) => reference.name === "load" && reference.role === "call");
	expect(loadReference?.range).toEqual({
		start: { line: 4, character: loadStart },
		end: { line: 4, character: loadStart + "load".length },
	});
	const pathReference = facts.references.find(
		(reference) =>
			reference.name === "res://other.gd" && reference.role === "import" && reference.range.start.line === 5,
	);
	expect(pathReference?.range).toEqual({
		start: { line: 5, character: pathStart },
		end: { line: 5, character: pathStart + "res://other.gd".length },
	});
});

test("extends accessor-bodied property ranges through the accessor body", () => {
	const declarations = extractDeclarationsCore(
		"scripts/accessor.gd",
		`@export var value: int = 0
	set(value):
		value = value
var after: int = 1
`,
		composeSymbolId,
	);
	const value = declarations.find((declaration) => declaration.name === "value");

	expect(value?.kind).toBe("property");
	expect(value?.range.end).toEqual({ line: 2, character: "\t\tvalue = value".length });
});

test("treats accessor parameters as local reference candidates", () => {
	const references = extractReferencesCore(
		"scripts/accessor.gd",
		`var value: int = 0
	set(value):
		value = value
`,
		composeSymbolId,
	);

	expect(references.map((reference) => [reference.name, reference.role])).toEqual([
		["int", "typeUse"],
		["value", "write"],
		["value", "read"],
	]);
	const valueBindings = references
		.filter((reference) => reference.name === "value")
		.map((reference) => reference.binding);
	expect(valueBindings.every((binding) => binding.status === "unbound" && binding.reason === "NotIndexed")).toBe(
		true,
	);
});

test("does not extract declarations from triple-quoted strings", () => {
	const declarations = extractDeclarationsCore(
		"scripts/strings.gd",
		`var description = """
func fake():
	var fake_local := 1
"""
func real():
	var real_local := 2
`,
		composeSymbolId,
	);

	expect(declarations.map((declaration) => declaration.name)).toEqual([
		"strings",
		"description",
		"real",
		"real_local",
	]);
});

test("classifies calls, reads, writes, extends, and type uses without binding guesses", () => {
	const module = "scripts/references.gd";
	const text = `class_name Example
extends Node
var count: int = 0
func run(value: int) -> void:
	count += value
	var local := helper(value)
	for item: Node in items:
		local = item
		item.method()
	if item is Node:
		helper()
`;
	const references = extractReferencesCore(module, text, composeSymbolId);
	const roles = (name: string, role: string) =>
		references.filter((reference) => reference.name === name && reference.role === role);

	expect(references.filter((reference) => reference.role === "call").map((reference) => reference.name)).toEqual([
		"helper",
		"method",
		"helper",
	]);
	expect(roles("count", "read")).toHaveLength(1);
	expect(roles("count", "write")).toHaveLength(1);
	expect(roles("local", "write")).toHaveLength(1);
	expect(roles("item", "read")).toHaveLength(3);
	expect(roles("item", "write")).toHaveLength(1);
	expect(references.filter((reference) => reference.role === "extends").map((reference) => reference.name)).toEqual([
		"Node",
	]);
	expect(references.filter((reference) => reference.role === "typeUse").map((reference) => reference.name)).toEqual([
		"int",
		"int",
		"void",
		"Node",
		"Node",
	]);
	expect(references.every((reference) => reference.binding.status === "unbound")).toBe(true);
	expect(roles("value", "read")[0]?.binding).toMatchObject({ reason: "NotIndexed" });
	expect(roles("local", "write")[0]?.binding).toMatchObject({ reason: "NotIndexed" });
	expect(roles("helper", "call")[0]?.binding).toMatchObject({ reason: "NotImplemented" });
	expect(
		references.some(
			(reference) => reference.binding.status === "unbound" && reference.binding.reason === "RuntimeConstructed",
		),
	).toBe(false);
	expect(roles("method", "call")[0]?.fromId).toBe(roles("helper", "call")[0]?.fromId);
});

test("declares exactly the reference roles it emits", () => {
	const info = new GDScriptProvider().initialize("/workspace");

	expect(info.referenceRoles).toEqual([...REFERENCE_ROLES]);
});

test("binds project class names and unambiguous same-file declarations", () => {
	const provider = new GDScriptProvider();
	provider.initialize("/workspace");
	const base = provider.parseFile({
		module: "base.gd",
		contentHash: "base",
		text: "class_name Base\nextends Node\n",
	});
	const user = provider.parseFile({
		module: "user.gd",
		contentHash: "user",
		text: `extends Base
var state: int = 0
func helper() -> void:
	pass
func run(target: Node, value: int) -> void:
	var local := Base.new()
	helper()
	target.helper()
	target.state = 1
	local = value
`,
	});
	const baseDeclaration = base.declarations.find((declaration) => declaration.name === "Base");
	const extendsReference = user.references.find((reference) => reference.role === "extends");
	const baseRead = user.references.find((reference) => reference.name === "Base" && reference.role === "read");
	const helperCall = user.references.find((reference) => reference.name === "helper");
	const memberCall = user.references.find(
		(reference) => reference.name === "helper" && reference.range.start.line === 7,
	);
	const memberWrite = user.references.find((reference) => reference.name === "state" && reference.role === "write");
	const valueRead = user.references.find((reference) => reference.name === "value" && reference.role === "read");

	expect(TIERS.binding).toBe(true);
	expect(extendsReference?.binding).toEqual({
		status: "bound",
		symbolId: baseDeclaration?.symbolId,
		provenance: "bound",
	});
	expect(baseRead?.binding).toEqual(extendsReference?.binding);
	expect(helperCall?.binding.status).toBe("bound");
	// The bind pass searched and found nothing, so it answers WHY rather than repeating the
	// parse-time "not implemented": a member hangs off a receiver whose type is unknown.
	expect(memberCall?.binding).toMatchObject({ status: "unbound", reason: "DynamicallyTyped" });
	expect(memberWrite?.binding).toMatchObject({ status: "unbound", reason: "DynamicallyTyped" });
	expect(
		provider.bind({
			module: "user.gd",
			name: "helper",
			range: helperCall?.range ?? { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
		}),
	).toEqual(helperCall?.binding);
	expect(valueRead?.binding).toMatchObject({ status: "unbound", reason: "NotIndexed" });
	expect(
		user.references.some(
			(reference) => reference.binding.status === "unbound" && reference.binding.reason === "RuntimeConstructed",
		),
	).toBe(false);
});

test("binds an inner class extending its outer class", () => {
	const provider = new GDScriptProvider();
	provider.initialize("/workspace");
	const facts = provider.parseFile({
		module: "nested.gd",
		contentHash: "nested",
		text: `class Outer:
	class Inner extends Outer:
		pass
`,
	});
	const outer = facts.declarations.find((declaration) => declaration.name === "Outer");
	const extendsReference = facts.references.find((reference) => reference.role === "extends");

	expect(extendsReference?.binding).toEqual({
		status: "bound",
		symbolId: outer?.symbolId,
		provenance: "bound",
	});
});

test("binds a literal path on an inner class extends clause", () => {
	const provider = new GDScriptProvider();
	provider.initialize("/workspace");
	const base = provider.parseFile({
		module: "base.gd",
		contentHash: "base",
		text: "class_name Base\nextends Node\n",
	});
	const child = provider.parseFile({
		module: "child.gd",
		contentHash: "child",
		text: `class Child extends "res://base.gd":
		pass
`,
	});
	const baseDeclaration = base.declarations.find((declaration) => declaration.name === "Base");
	const extendsReference = child.references.find((reference) => reference.role === "extends");

	expect(extendsReference?.binding).toEqual({
		status: "bound",
		symbolId: baseDeclaration?.symbolId,
		provenance: "bound",
	});
	expect(child.imports).toContainEqual({ specifier: "res://base.gd", imported: [], reExport: false });
});

test("binds literal script paths and preserves dynamic loader uncertainty", () => {
	const provider = new GDScriptProvider();
	provider.initialize("/workspace");
	const base = provider.parseFile({
		module: "base.gd",
		contentHash: "base",
		text: "class_name Base\nextends Node\n",
	});
	const user = provider.parseFile({
		module: "user.gd",
		contentHash: "user",
		text: `extends "res://base.gd"
const BaseScript = preload("res://base.gd")
const RelativeScript = preload("base.gd")
func run(path: String) -> void:
	var loaded = load(path)
`,
	});
	const baseDeclaration = base.declarations.find((declaration) => declaration.name === "Base");
	const pathExtends = user.references.find((reference) => reference.role === "extends");
	const pathImport = user.references.find((reference) => reference.role === "import");
	const relativeImport = user.references.find((reference) => reference.name === "base.gd");
	const dynamicLoad = user.references.find((reference) => reference.name === "load");
	const baseScript = user.declarations.find((declaration) => declaration.name === "BaseScript");
	const loaded = user.declarations.find((declaration) => declaration.name === "loaded");
	const scriptImport = user.imports.find((entry) => entry.specifier === "res://base.gd" && entry.imported.length > 0);
	const extendsImport = user.imports.find(
		(entry) => entry.specifier === "res://base.gd" && entry.imported.length === 0,
	);
	const dynamicImport = user.imports.find((entry) => entry.specifier === "load(path)");

	expect(pathExtends?.name).toBe("res://base.gd");
	expect(pathExtends?.binding).toEqual({
		status: "bound",
		symbolId: baseDeclaration?.symbolId,
		provenance: "bound",
	});
	expect(pathImport?.binding).toEqual(pathExtends?.binding);
	expect(relativeImport?.binding).toEqual(pathExtends?.binding);
	expect(extendsImport).toEqual({
		specifier: "res://base.gd",
		imported: [],
		reExport: false,
	});
	expect(scriptImport).toEqual({
		specifier: "res://base.gd",
		imported: [{ local: "BaseScript", localRange: baseScript?.selectionRange }],
		reExport: false,
	});
	expect(dynamicImport).toEqual({
		specifier: "load(path)",
		imported: [{ local: "loaded", localRange: loaded?.selectionRange }],
		reExport: false,
	});
	expect(dynamicLoad?.binding).toEqual({
		status: "unbound",
		reason: "RuntimeConstructed",
		detail: "the loader path is computed at runtime",
	});
});

test("resolves script resources and classifies other loader paths honestly", () => {
	const provider = new GDScriptProvider();
	const fixtureRoot = path.join(process.cwd(), "providers/gdscript/src/__tests__/fixtures/autoload");
	provider.initialize(fixtureRoot);
	provider.parseFile({
		module: "state.gd",
		contentHash: "state",
		text: "class_name State\nextends Node\n",
	});

	expect(provider.resolveImport({ fromModule: "user.gd", specifier: "res://state.gd" })).toEqual({
		status: "resolved",
		module: "state.gd",
	});
	expect(provider.resolveImport({ fromModule: "user.gd", specifier: "state.gd" })).toEqual({
		status: "resolved",
		module: "state.gd",
	});
	expect(provider.resolveImport({ fromModule: "user.gd", specifier: "scene.tscn" })).toEqual({
		status: "external",
		packageName: "scene.tscn",
	});
	expect(provider.resolveImport({ fromModule: "user.gd", specifier: "missing.gd" })).toMatchObject({
		status: "unresolved",
		reason: "NotIndexed",
	});
	expect(provider.resolveImport({ fromModule: "user.gd", specifier: "load(path)" })).toEqual({
		status: "unresolved",
		reason: "RuntimeConstructed",
		detail: "the loader path is computed at runtime",
	});
});

test("binds autoload reads to the registered script root", () => {
	const provider = new GDScriptProvider();
	const fixtureRoot = path.join(process.cwd(), "providers/gdscript/src/__tests__/fixtures/autoload");
	provider.initialize(fixtureRoot);
	const state = provider.parseFile({
		module: "state.gd",
		contentHash: "state",
		text: "class_name State\nextends Node\n",
	});
	const user = provider.parseFile({
		module: "user.gd",
		contentHash: "user",
		text: "func run() -> void:\n\tGameState.reset()\n",
	});
	const stateDeclaration = state.declarations.find((declaration) => declaration.name === "State");
	const autoloadRead = user.references.find((reference) => reference.name === "GameState");

	expect(autoloadRead?.role).toBe("read");
	expect(autoloadRead?.binding).toEqual({
		status: "bound",
		symbolId: stateDeclaration?.symbolId,
		provenance: "bound",
	});
});

test("reports declared annotation types without inferring initializers", () => {
	const provider = new GDScriptProvider();
	provider.initialize("/workspace");
	const text = `class_name Types
extends Node
const LIMIT: int = 3
var speed: float = 5.0
var names: Array[String] = []
var settings: Dictionary = {}
var target: Types
var inferred = 5
var shorthand := 5
func run(n: int) -> void:
	pass
`;
	const facts = provider.parseFile({ module: "types.gd", contentHash: "types", text });
	const typesDeclaration = facts.declarations.find((candidate) => candidate.name === "Types");
	const typeOf = (name: string) => {
		const declaration = facts.declarations.find((candidate) => candidate.name === name);
		return provider.typeOf({ symbolId: declaration?.symbolId ?? "" });
	};

	expect(TIERS.types).toBe(true);
	expect(typeOf("LIMIT")).toEqual({ status: "known", display: "int", provenance: "declared" });
	expect(typeOf("speed")).toEqual({ status: "known", display: "float", provenance: "declared" });
	expect(typeOf("names")).toEqual({ status: "known", display: "Array[String]", provenance: "declared" });
	expect(typeOf("settings")).toEqual({ status: "known", display: "Dictionary", provenance: "declared" });
	expect(typeOf("target")).toEqual({
		status: "known",
		display: "Types",
		provenance: "declared",
		symbolId: typesDeclaration?.symbolId,
	});
	expect(typeOf("inferred")).toEqual({ status: "inferred", display: "int", basis: "initializer" });
	expect(typeOf("shorthand")).toEqual({ status: "inferred", display: "int", basis: "initializer" });
	expect(provider.typeOf({ module: "types.gd", range: rangeAt(text, text.indexOf("n: int")) })).toEqual({
		status: "known",
		display: "int",
		provenance: "declared",
	});
	expect(typeOf("run")).toEqual({ status: "known", display: "void", provenance: "declared" });
});

test("attaches indexed symbols to declared and inferred script types", () => {
	const provider = new GDScriptProvider();
	provider.initialize("/workspace");
	const base = provider.parseFile({
		module: "base.gd",
		contentHash: "base",
		text: "class_name Base\nextends Node\n",
	});
	const text = `const Script = preload("res://base.gd")
var annotated: Base
var inferred = Script.new()
var engine: Node2D
`;
	const facts = provider.parseFile({ module: "user.gd", contentHash: "user", text });
	const baseDeclaration = base.declarations.find((declaration) => declaration.name === "Base");
	const typeOf = (name: string) => {
		const declaration = facts.declarations.find((candidate) => candidate.name === name);
		return provider.typeOf({ symbolId: declaration?.symbolId ?? "" });
	};

	expect(typeOf("annotated")).toEqual({
		status: "known",
		display: "Base",
		provenance: "declared",
		symbolId: baseDeclaration?.symbolId,
	});
	expect(typeOf("Script")).toEqual({
		status: "inferred",
		display: "Base",
		basis: "initializer",
		symbolId: baseDeclaration?.symbolId,
	});
	expect(typeOf("inferred")).toEqual({
		status: "inferred",
		display: "Base",
		basis: "initializer",
		symbolId: baseDeclaration?.symbolId,
	});
	expect(typeOf("engine")).toEqual({ status: "known", display: "Node2D", provenance: "declared" });
});

test("infers complete return unions and implicit null", () => {
	const provider = new GDScriptProvider();
	provider.initialize("/workspace");
	const text = `func pick(a, b):
	if a:
		return "foo"
	elif b:
		return "bar"
	return "baz"

func partial(flag):
	if flag:
		return "known"
	return get_value()

func push_error_path(flag):
	if flag:
		push_error("bad")

func assert_path(flag):
	if flag:
		assert flag

func ternary(flag):
	return "yes+no" if flag else "no+yes"

func typed_param(value: int):
	return value
`;
	const facts = provider.parseFile({ module: "inference.gd", contentHash: "inference", text });
	const typeOf = (name: string) => {
		const declaration = facts.declarations.find((candidate) => candidate.name === name);
		return provider.typeOf({ symbolId: declaration?.symbolId ?? "" });
	};

	expect(typeOf("pick")).toEqual({
		status: "inferred",
		display: 'String ("foo" | "bar" | "baz")',
		basis: "3 return statements",
	});
	expect(typeOf("partial")).toMatchObject({ status: "unknown", reason: "NotImplemented" });
	expect(typeOf("push_error_path")).toEqual({
		status: "inferred",
		display: "null",
		basis: "0 return statements with implicit null",
	});
	expect(typeOf("assert_path")).toEqual({
		status: "inferred",
		display: "null",
		basis: "0 return statements with implicit null",
	});
	expect(typeOf("ternary")).toEqual({
		status: "inferred",
		display: 'String ("yes+no" | "no+yes")',
		basis: "1 return statement",
	});
	expect(typeOf("typed_param")).toEqual({
		status: "inferred",
		display: "int",
		basis: "1 return statement",
	});
	const typedParameter = facts.declarations.find((candidate) => candidate.name === "value");
	if (typedParameter === undefined) throw new Error("typed parameter declaration missing");
	expect(provider.typeOf({ symbolId: typedParameter.symbolId })).toEqual({
		status: "known",
		display: "int",
		provenance: "declared",
	});
});

test("treats match wildcard coverage as control flow", () => {
	const provider = new GDScriptProvider();
	provider.initialize("/workspace");
	const text = `func covered(value):
	match value:
		1:
			return "one"
		_:
			return "other"

func uncovered(value):
	match value:
		1:
			return "one"
`;
	const facts = provider.parseFile({ module: "match.gd", contentHash: "match", text });
	const typeOf = (name: string) => {
		const declaration = facts.declarations.find((candidate) => candidate.name === name);
		return provider.typeOf({ symbolId: declaration?.symbolId ?? "" });
	};

	expect(typeOf("covered")).toEqual({
		status: "inferred",
		display: 'String ("one" | "other")',
		basis: "2 return statements",
	});
	expect(typeOf("uncovered")).toEqual({
		status: "inferred",
		display: 'String ("one") | null',
		basis: "1 return statement and implicit null",
	});
});

test("bounds recursive inference and refuses awaited results", () => {
	const provider = new GDScriptProvider();
	provider.initialize("/workspace");
	const text = `func recursive():
	return recursive()

func awaited():
	return await recursive()

func explicit_null():
	return null
`;
	const facts = provider.parseFile({ module: "limits.gd", contentHash: "limits", text });
	const typeOf = (name: string) => {
		const declaration = facts.declarations.find((candidate) => candidate.name === name);
		return provider.typeOf({ symbolId: declaration?.symbolId ?? "" });
	};

	expect(typeOf("recursive")).toEqual({
		status: "unknown",
		reason: "RecursionLimit",
		detail: "function inference reached a recursive call or depth limit",
	});
	expect(typeOf("awaited")).toEqual({
		status: "unknown",
		reason: "NotImplemented",
		detail: "await changes the returned value and is not inferred",
	});
	expect(typeOf("explicit_null")).toEqual({
		status: "inferred",
		display: "null",
		basis: "1 return statement",
	});
});

test("infers literal and shorthand initializers", () => {
	const provider = new GDScriptProvider();
	provider.initialize("/workspace");
	const text = `var limit = 1
const NAME = "x"
var shorthand := false
var values = [1, 2]
`;
	const facts = provider.parseFile({ module: "initializers.gd", contentHash: "initializers", text });
	const typeOf = (name: string) => {
		const declaration = facts.declarations.find((candidate) => candidate.name === name);
		return provider.typeOf({ symbolId: declaration?.symbolId ?? "" });
	};

	expect(typeOf("limit")).toEqual({ status: "inferred", display: "int", basis: "initializer" });
	expect(typeOf("NAME")).toEqual({ status: "inferred", display: 'String ("x")', basis: "initializer" });
	expect(typeOf("shorthand")).toEqual({ status: "inferred", display: "bool", basis: "initializer" });
	expect(typeOf("values")).toEqual({ status: "inferred", display: "Array", basis: "initializer" });
});

test("extracts decoded literals without treating node paths as literals", () => {
	const provider = new GDScriptProvider();
	provider.initialize("/workspace");
	const text = `const HEX = 0xFF
var escaped = "a\\nb"
var enabled = true
var node = $Player/Sprite
var unique = %UniqueName
var typed_name = &"thing_happened"
var typed_path = ^"Player/Sprite"
var script = preload("res://other.gd")
var multiline = """first
second"""
func use():
	return "inside"
`;
	const facts = provider.parseFile({ module: "literals.gd", contentHash: "literals", text });
	const values = facts.literals.map((literal) => ({
		kind: literal.kind,
		value: literal.value,
		number: literal.number,
	}));

	expect(values).toEqual([
		{ kind: "number", value: "0xFF", number: 255 },
		{ kind: "string", value: "a\nb", number: undefined },
		{ kind: "boolean", value: "true", number: undefined },
		{ kind: "string", value: "thing_happened", number: undefined },
		{ kind: "string", value: "Player/Sprite", number: undefined },
		{ kind: "string", value: "first\nsecond", number: undefined },
		{ kind: "string", value: "inside", number: undefined },
	]);
	expect(facts.imports).toEqual([
		{
			specifier: "res://other.gd",
			imported: [
				{ local: "script", localRange: { start: { line: 7, character: 4 }, end: { line: 7, character: 10 } } },
			],
			reExport: false,
		},
	]);
	const multiline = facts.literals.find((literal) => literal.value === "first\nsecond");
	expect(multiline?.range).toEqual({ start: { line: 8, character: 16 }, end: { line: 9, character: 9 } });
	const use = facts.declarations.find((declaration) => declaration.name === "use");
	expect(facts.literals.find((literal) => literal.value === "inside")?.containerId).toBe(use?.symbolId);
});

test("keeps signal strings as literals while excluding import specifiers", () => {
	const provider = new GDScriptProvider();
	provider.initialize("/workspace");
	const text = `const script = preload("res://other.gd")
var mentioned = "res://mentioned.gd"
signal thing_happened
func connect_signal():
	connect("thing_happened", Callable(self, "handler"))
`;
	const facts = provider.parseFile({ module: "search.gd", contentHash: "search", text });

	expect(facts.literals.map((literal) => literal.value)).toEqual(["res://mentioned.gd", "thing_happened", "handler"]);
	expect(facts.imports).toEqual([
		{
			specifier: "res://other.gd",
			imported: [
				{ local: "script", localRange: { start: { line: 0, character: 6 }, end: { line: 0, character: 12 } } },
			],
			reExport: false,
		},
	]);
});

test("reports declaration size and control-flow metrics", () => {
	const provider = new GDScriptProvider();
	provider.initialize("/workspace");
	const text = `var value = 1
func sample(first, second):
	if first:
		return "yes"
	match second:
		1:
			return false
		_:
			return true
`;
	const facts = provider.parseFile({ module: "metrics.gd", contentHash: "metrics", text });
	const sample = facts.declarations.find((declaration) => declaration.name === "sample");
	const value = facts.declarations.find((declaration) => declaration.name === "value");

	expect(sample?.metrics).toEqual({ lines: 8, parameters: 2, nesting: 1, branches: 4 });
	expect(value?.metrics).toEqual({ lines: 1 });
});

// Both inputs below are pathological but legal: the path text also occurs EARLIER in the same
// match, which is the only way to tell a capture offset apart from a search for the same text.
// The old code searched, so it located the class name and the loader word instead of the path.
test("an extends path is located by its capture rather than by searching the match", () => {
	const provider = new GDScriptProvider();
	provider.initialize("/workspace");
	const text = 'class Weapon extends "Weapon"\n';

	const facts = provider.parseFile({ module: "weapon.gd", contentHash: "weapon", text });
	const reference = facts.references.find((entry) => entry.role === "extends");

	expect(reference?.name).toBe("Weapon");
	// Inside the quotes at character 22, not the class name at character 6.
	expect(reference?.range.start).toEqual({ line: 0, character: 22 });
});

test("a loader path is located by its capture rather than by searching the match", () => {
	const provider = new GDScriptProvider();
	provider.initialize("/workspace");
	const text = 'const Script = preload("load")\n';

	const facts = provider.parseFile({ module: "user.gd", contentHash: "user", text });
	const reference = facts.references.find((entry) => entry.role === "import");

	expect(reference?.name).toBe("load");
	// Inside the quotes at character 24, not the "load" inside "preload" at character 18.
	expect(reference?.range.start).toEqual({ line: 0, character: 24 });
});
