import { expect, test } from "bun:test";
import path from "node:path";
import { composeSymbolId, coordinatesOf, handlersFor, PROTOCOL_VERSION } from "@nyaa-lexicon/protocol";
import { extractDeclarationsCore, extractReferencesCore } from "../extractCore.js";
import { GDScriptProvider, REFERENCE_ROLES, TIERS } from "../main.js";

function started(root = process.cwd()) {
	const handlers = handlersFor(new GDScriptProvider());
	handlers.initialize({ workspaceRoot: root, protocolVersion: PROTOCOL_VERSION });
	handlers.discoverProject({ workspaceRoot: root });
	return handlers;
}

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

test("an unnamed enum's members are the class's constants, and an enum spans its braces", () => {
	const text = `enum { IDLE, RUNNING = 2 }
enum Mode { A, B = 1 << 2,
	C, D,
	E
}
`;
	const declarations = extractDeclarationsCore("scripts/enums.gd", text, composeSymbolId);
	const shape = declarations.slice(1).map((declaration) => ({
		name: declaration.name,
		container: declarations.find((candidate) => candidate.symbolId === declaration.containerId)?.name,
		lines: `${declaration.range.start.line}-${declaration.range.end.line}`,
	}));
	const references = extractReferencesCore("scripts/enums.gd", text, composeSymbolId);

	expect(shape).toEqual([
		{ name: "IDLE", container: "enums", lines: "0-0" },
		{ name: "RUNNING", container: "enums", lines: "0-0" },
		{ name: "Mode", container: "enums", lines: "1-4" },
		{ name: "A", container: "Mode", lines: "1-1" },
		{ name: "B", container: "Mode", lines: "1-1" },
		{ name: "C", container: "Mode", lines: "2-2" },
		{ name: "D", container: "Mode", lines: "2-2" },
		{ name: "E", container: "Mode", lines: "3-3" },
	]);
	expect(references).toEqual([]);
});

test("a block lambda's body belongs to the variable it initializes, and a class's lambda declares no member", () => {
	const text = `var on_hit = func(amount):
	var scaled = amount * 2
	return scaled
func run():
	var cb := func(a: int) -> int:
		return a
	cb.call(1)
`;
	const declarations = extractDeclarationsCore("scripts/lambdas.gd", text, composeSymbolId);
	const found = (name: string) => declarations.find((declaration) => declaration.name === name);
	const onHit = found("on_hit");

	const references = extractReferencesCore("scripts/lambdas.gd", text, composeSymbolId);
	const read = (name: string) => references.find((reference) => reference.name === name && reference.role === "read");

	expect([onHit, found("cb")].map((declaration) => declaration?.range.end.line)).toEqual([2, 5]);
	expect(found("scaled")).toMatchObject({ kind: "variable", visibility: "local", containerId: onHit?.symbolId });
	expect([read("scaled")?.fromId, read("amount")?.fromId]).toEqual([onHit?.symbolId, onHit?.symbolId]);
	// The lambda's own parameter, not a member to bind.
	expect([read("amount")?.binding, read("a")?.binding]).toMatchObject([
		{ reason: "NotIndexed" },
		{ reason: "NotIndexed" },
	]);
});

test("a match pattern's var binds a local, and a lone underscore names nothing", () => {
	const text = `func run(value):
	match value:
		[var head, _, ..]:
			print(head)
		{"key": var entry}:
			print(entry)
		_:
			pass
`;
	const declarations = extractDeclarationsCore("scripts/match.gd", text, composeSymbolId);
	const references = extractReferencesCore("scripts/match.gd", text, composeSymbolId);
	const run = declarations.find((declaration) => declaration.name === "run");

	expect(
		declarations
			.filter((declaration) => declaration.containerId === run?.symbolId)
			.map((declaration) => [declaration.name, declaration.kind, declaration.signature]),
	).toEqual([
		["value", "variable", undefined],
		["head", "variable", "var head"],
		["entry", "variable", "var entry"],
	]);
	expect(references.map((reference) => `${reference.name}:${reference.role}:${reference.range.start.line}`)).toEqual([
		"value:read:1",
		"print:call:3",
		"head:read:3",
		"print:call:5",
		"entry:read:5",
	]);
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
	expect(solve?.signature).toBe("static func solve(value: int) -> int:");
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
	const word = `przyk${String.fromCodePoint(0x142)}ad`;
	const declarations = extractDeclarationsCore(module, `var ${word} := 1\n`, composeSymbolId);
	const declaration = declarations.find((candidate) => candidate.name === word);

	expect(declaration?.name).toBe(word);
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
				{ kind: "term", name: word },
			],
		}),
	);
});

test("uses UTF-16 units for every emitted GDScript range", () => {
	const provider = started();
	const face = String.fromCodePoint(0x1f600);
	const text = `var target := 1
var face = "${face}"; const Script = preload("res://other.gd")
var face2 = "${face}"; var marker = "hello"; var count = 0xFF; var enabled = true
var face3 = "${face}"; target = target
var face4 = "${face}"; var loaded = load(path)
var face5 = "${face}"; var pathLoaded = load("res://other.gd")
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
	const targetStart = targetLine.indexOf("target", targetLine.indexOf(face));
	const loadStart = loadLine.indexOf("load(", loadLine.indexOf(face));
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

test("extends a property's range through its accessors in every form, and never a local's", () => {
	const declarations = extractDeclarationsCore(
		"scripts/accessor.gd",
		`@export var value: int = 0
	set(value):
		value = value
var speed: float:
	get = get_speed, set = set_speed
var inline: int: get = get_inline
func run():
	var node = 1
	set("value", 2)
`,
		composeSymbolId,
	);
	const lines = (name: string) => {
		const range = declarations.find((declaration) => declaration.name === name)?.range;
		return `${range?.start.line}-${range?.end.line}`;
	};

	expect(declarations.find((declaration) => declaration.name === "value")?.range.end).toEqual({
		line: 2,
		character: "\t\tvalue = value".length,
	});
	expect(["speed", "inline", "node"].map(lines)).toEqual(["3-4", "5-5", "7-7"]);
});

test("treats accessor parameters as local reference candidates, and accessor words as no reference", () => {
	const references = extractReferencesCore(
		"scripts/accessor.gd",
		`var value: int = 0:
	get:
		return value
	set(value):
		value = value
var speed: float: get = get_speed, set = set_speed
func run():
	set("value", get("value"))
`,
		composeSymbolId,
	);

	expect(references.map((reference) => [reference.name, reference.role])).toEqual([
		["int", "typeUse"],
		["value", "read"],
		["value", "write"],
		["value", "read"],
		["float", "typeUse"],
		["get_speed", "read"],
		["set_speed", "read"],
		["set", "call"],
		["get", "call"],
	]);
	const setterBindings = references
		.filter((reference) => reference.name === "value" && reference.range.start.line === 4)
		.map((reference) => reference.binding);
	expect(setterBindings.every((binding) => binding.status === "unbound" && binding.reason === "NotIndexed")).toBe(
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

test("a call before a colon is a call, a node path names no identifier, and a cast takes only its type", () => {
	const text = `func run(item, local):
	if is_valid(item) and item is not Node2D and not local:
		for child in children():
			pass
	var node = $Hud/Label if local else %Health
	local = [%Bar, $"Quoted/Path"].size() % 2
	return item as Array[int]
`;
	const references = extractReferencesCore("scripts/tokens.gd", text, composeSymbolId);
	const named = (role: string) =>
		references.filter((reference) => reference.role === role).map((reference) => reference.name);

	expect(named("call")).toEqual(["is_valid", "children", "size"]);
	expect(named("typeUse")).toEqual(["Node2D", "Array", "int"]);
	expect(named("read")).toEqual(["item", "item", "local", "local", "item"]);
	expect(named("write")).toEqual(["child", "local"]);
});

test("marks a use qualified only when a receiver or path reaches it", () => {
	const text = `class_name Example
extends Node
const Script = preload("res://base.gd")
enum Mode { IDLE }
var inner: Outer.Inner
var count: int = 0
func run() -> void:
	count = Mode.IDLE
	self.count += 1
	super.run()
	GameState.reset()
	var keys = (Mode
		.keys())
	var ratio = 1.e5
`;
	const references = extractReferencesCore("scripts/qualified.gd", text, composeSymbolId);
	const qualified = (name: string) =>
		references.filter((reference) => reference.name === name).map((reference) => reference.qualified);

	expect(references.every((reference) => typeof reference.qualified === "boolean")).toBe(true);
	// Implicit member, then `self.count +=`.
	expect(qualified("count")).toEqual([false, true, true]);
	expect(qualified("Mode")).toEqual([false, false]);
	expect(qualified("IDLE")).toEqual([true]);
	expect(qualified("Outer")).toEqual([false]);
	expect(qualified("Inner")).toEqual([true]);
	expect(qualified("run")).toEqual([true]);
	expect(qualified("GameState")).toEqual([false]);
	expect(qualified("reset")).toEqual([true]);
	expect(qualified("keys")).toEqual([true]);
	expect(qualified("Node")).toEqual([false]);
	expect(qualified("res://base.gd")).toEqual([false]);
	expect(references.some((reference) => reference.name === "e5" && reference.qualified === true)).toBe(false);
});

test("declares exactly the reference roles it emits", () => {
	const handlers = handlersFor(new GDScriptProvider());
	const info = handlers.initialize({ workspaceRoot: process.cwd(), protocolVersion: PROTOCOL_VERSION });
	handlers.discoverProject({ workspaceRoot: process.cwd() });

	expect(info.referenceRoles).toEqual([...REFERENCE_ROLES]);
});

test("binds project class names and unambiguous same-file declarations", () => {
	const provider = started();
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
	if (baseDeclaration === undefined) throw new Error("base declaration missing");
	const helperBinding = helperCall?.binding;
	if (helperBinding === undefined) throw new Error("helper binding missing");

	expect(TIERS.binding).toBe(true);
	expect(extendsReference?.binding).toEqual({
		status: "bound",
		symbolId: baseDeclaration.symbolId,
		provenance: "bound",
	});
	expect(baseRead?.binding).toEqual(extendsReference?.binding);
	expect(helperCall?.binding.status).toBe("bound");
	expect([helperCall?.qualified, memberCall?.qualified, memberWrite?.qualified]).toEqual([false, true, true]);
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
	).toEqual(helperBinding);
	expect(valueRead?.binding).toMatchObject({ status: "unbound", reason: "NotIndexed" });
	expect(
		user.references.some(
			(reference) => reference.binding.status === "unbound" && reference.binding.reason === "RuntimeConstructed",
		),
	).toBe(false);
});

test("binds an inner class extending its outer class", () => {
	const provider = started();
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
	if (outer === undefined) throw new Error("outer declaration missing");

	expect(extendsReference?.binding).toEqual({
		status: "bound",
		symbolId: outer.symbolId,
		provenance: "bound",
	});
});

test("binds a literal path on an inner class extends clause", () => {
	const provider = started();
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
	if (baseDeclaration === undefined) throw new Error("base declaration missing");

	expect(extendsReference?.binding).toEqual({
		status: "bound",
		symbolId: baseDeclaration.symbolId,
		provenance: "bound",
	});
	expect(child.imports).toContainEqual({ specifier: "res://base.gd", imported: [], reExport: false });
});

test("binds literal script paths and preserves dynamic loader uncertainty", () => {
	const provider = started();
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
	if (baseDeclaration === undefined) throw new Error("base declaration missing");

	expect(pathExtends?.name).toBe("res://base.gd");
	expect(pathExtends?.binding).toEqual({
		status: "bound",
		symbolId: baseDeclaration.symbolId,
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
		imported: [
			{
				local: "BaseScript",
				localRange: baseScript?.selectionRange as NonNullable<typeof baseScript>["selectionRange"],
			},
		],
		reExport: false,
	});
	expect(dynamicImport).toEqual({
		specifier: "load(path)",
		imported: [
			{
				local: "loaded",
				localRange: loaded?.selectionRange as NonNullable<typeof loaded>["selectionRange"],
			},
		],
		reExport: false,
	});
	expect(dynamicLoad?.binding).toEqual({
		status: "unbound",
		reason: "RuntimeConstructed",
		detail: "the loader path is computed at runtime",
	});
});

test("reads a loader call from tokens: not a member, not a partial path, and across lines", () => {
	const provider = started();
	const text = `func run(saver, name):
	saver.preload("res://x.gd")
	var level = load("res://levels/" + name)
	var scene = ResourceLoader.load("res://scene.tscn")
const Split = preload(
	"res://split.gd"
)
`;
	const facts = provider.parseFile({ module: "loaders.gd", contentHash: "loaders", text });

	expect(facts.imports.map((entry) => entry.specifier)).toEqual([
		"res://scene.tscn",
		"res://split.gd",
		'load("res://levels/" + name)',
	]);
	expect(facts.references.filter((entry) => entry.role === "import").map((entry) => entry.name)).toEqual([
		"res://scene.tscn",
		"res://split.gd",
	]);
	expect(facts.references.find((entry) => entry.name === "preload")).toMatchObject({ role: "call", qualified: true });
});

test("resolves script resources and classifies other loader paths honestly", () => {
	const fixtureRoot = path.join(process.cwd(), "providers/gdscript/src/__tests__/fixtures/autoload");
	const provider = started(fixtureRoot);
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
	const fixtureRoot = path.join(process.cwd(), "providers/gdscript/src/__tests__/fixtures/autoload");
	const provider = started(fixtureRoot);
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
	if (stateDeclaration === undefined) throw new Error("autoload declaration missing");

	expect(autoloadRead?.role).toBe("read");
	expect(autoloadRead?.binding).toEqual({
		status: "bound",
		symbolId: stateDeclaration.symbolId,
		provenance: "bound",
	});
});

test("reports declared annotation types without inferring initializers", () => {
	const provider = started();
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
	const provider = started();
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

test("binds a preloaded type only from a real const, never from string text", () => {
	const provider = started();
	provider.parseFile({ module: "enemy.gd", contentHash: "enemy", text: "extends Node\n" });
	const quoted = `var doc = """
const Enemy = preload("res://enemy.gd")
"""
var foe: Enemy
`;
	const real = 'const Enemy = preload("res://enemy.gd")\nvar foe: Enemy\n';
	const typeOfFoe = (module: string, text: string) => {
		const facts = provider.parseFile({ module, contentHash: module, text });
		const foe = facts.declarations.find((declaration) => declaration.name === "foe");
		return provider.typeOf({ symbolId: foe?.symbolId ?? "" });
	};

	expect(typeOfFoe("quoted.gd", quoted)).toEqual({ status: "known", display: "Enemy", provenance: "declared" });
	expect(typeOfFoe("real.gd", real)).toMatchObject({ symbolId: expect.stringContaining("enemy.gd") });
});

test("infers a member call on a constructed value as unknown, not as the constructed type", () => {
	const provider = started();
	provider.parseFile({ module: "enemy.gd", contentHash: "enemy", text: "class_name Enemy\nextends Node\n" });
	const text = "var named = Enemy.new().get_name()\nvar made = Enemy.new()\nvar negative = -5\n";
	const facts = provider.parseFile({ module: "calls.gd", contentHash: "calls", text });
	const typeOf = (name: string) => {
		const declaration = facts.declarations.find((candidate) => candidate.name === name);
		return provider.typeOf({ symbolId: declaration?.symbolId ?? "" });
	};

	expect(typeOf("named")).toEqual({
		status: "unknown",
		reason: "NotImplemented",
		detail: "the expression is outside the supported inference subset",
	});
	expect(typeOf("made")).toMatchObject({ status: "inferred", display: "Enemy" });
	expect(typeOf("negative")).toEqual({ status: "inferred", display: "int", basis: "initializer" });
});

test("parses node-path casts, accessor-closed initializers and bare enum members", () => {
	const provider = started();
	provider.parseFile({ module: "lazy.gd", contentHash: "lazy", text: "class_name LazyLoader\nextends Node\n" });
	const text = `@onready var tile_mode := $TileMode as Node2D
@onready var sort_button := %Sort as MenuButton
var loader = LazyLoader.new("res://x.gd"):
	get: return loader
enum State { INSTALLED, AVAILABLE = 5 }
`;
	const facts = provider.parseFile({ module: "nodes.gd", contentHash: "nodes", text });
	const typeOf = (name: string) => {
		const declaration = facts.declarations.find((candidate) => candidate.name === name);
		return provider.typeOf({ symbolId: declaration?.symbolId ?? "" });
	};

	expect(typeOf("tile_mode")).toMatchObject({ status: "inferred", display: "Node2D" });
	expect(typeOf("sort_button")).toMatchObject({ status: "inferred", display: "MenuButton" });
	expect(typeOf("loader")).toMatchObject({ status: "inferred", display: "LazyLoader" });
	expect(typeOf("INSTALLED")).toMatchObject({ status: "unknown", reason: "DynamicallyTyped" });
	expect(typeOf("AVAILABLE")).toEqual({ status: "inferred", display: "int (5)", basis: "initializer" });
});

test("reads statements from tokens: a docstring line and an inline branch colon", () => {
	const provider = started();
	const text = `func documented():
	var note = """
unindented
"""
	return 1

func inline_branch(value):
	if value: return {"a": 1}
	return 2

func either(a, b):
	if(a == null):
		return b
	else:
		return a
`;
	const facts = provider.parseFile({ module: "statements.gd", contentHash: "statements", text });
	const typeOf = (name: string) => {
		const declaration = facts.declarations.find((candidate) => candidate.name === name);
		return provider.typeOf({ symbolId: declaration?.symbolId ?? "" });
	};

	expect(typeOf("documented")).toEqual({ status: "inferred", display: "int (1)", basis: "1 return statement" });
	expect(typeOf("either")).toEqual({
		status: "unknown",
		reason: "DynamicallyTyped",
		detail: "the value of b is not statically known",
	});
	expect(typeOf("inline_branch")).toEqual({
		status: "inferred",
		display: "Dictionary | int (2)",
		basis: "2 return statements",
	});
});

test("infers complete return unions and implicit null", () => {
	const provider = started();
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
	const provider = started();
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
	const provider = started();
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
	const provider = started();
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
	const provider = started();
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

// GDScript has no string-interpolation syntax: `%` and `.format()` read an ordinary string at run
// time, so its placeholder text is already reported verbatim, with nothing to fix.
test("reports a % format string as one literal, its placeholders left verbatim", () => {
	const provider = started();
	const text = 'var cmd = "install %s@%s now" % [name, marketplace]\n';
	const facts = provider.parseFile({ module: "fmt.gd", contentHash: "fmt", text });

	expect(facts.literals.map((literal) => literal.value)).toEqual(["install %s@%s now"]);
});

// One lexer, so no second reading.
test("reads literals through the same scan that masks strings and comments", () => {
	const provider = started();
	const text = `var hash_inside = "a # b"
# a comment with a "quote" and 42
var after = 'x'
var escaped = "q\\"#" # 7
var block = """has 'one' and 99
more"""
var typed = &"name"
var count = 3
`;
	const facts = provider.parseFile({ module: "scan.gd", contentHash: "scan", text });

	expect(facts.literals.map((literal) => literal.value)).toEqual([
		"a # b",
		"x",
		'q"#',
		"has 'one' and 99\nmore",
		"name",
		"3",
	]);
	expect(facts.literals.find((literal) => literal.value === "name")?.range).toEqual({
		start: { line: 6, character: 12 },
		end: { line: 6, character: 19 },
	});
	expect(facts.comments?.map((comment) => comment.text)).toEqual(['# a comment with a "quote" and 42', "# 7"]);
});

// Strings and numbers are gathered separately; containers must still follow source order.
test("attaches a number in an earlier function to that function, not to a later string's", () => {
	const provider = started();
	const text = `func first():
	return 1
func second():
	return "s"
`;
	const facts = provider.parseFile({ module: "order.gd", contentHash: "order", text });
	const container = (value: string) => facts.literals.find((literal) => literal.value === value)?.containerId;
	const id = (name: string) => facts.declarations.find((declaration) => declaration.name === name)?.symbolId;

	expect(container("1")).toBe(id("first"));
	expect(container("s")).toBe(id("second"));
});

test("keeps signal strings as literals while excluding import specifiers", () => {
	const provider = started();
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
	const provider = started();
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

test("counts branches from tokens: a parenthesized condition, a conditional expression and short-circuits", () => {
	const provider = started();
	const text = `func sample(a, b):
	if(a):
		return 1
	var t = 1 if a else 2
	return a and b or t
`;
	const facts = provider.parseFile({ module: "branches.gd", contentHash: "branches", text });
	const sample = facts.declarations.find((declaration) => declaration.name === "sample");

	expect(sample?.metrics).toEqual({ lines: 5, parameters: 2, nesting: 1, branches: 5 });
});

test("reads numbers and string prefixes as whole tokens, not as names", () => {
	const text = 'var a = 0xFF\nvar b = 1e5 + 1.e5\nvar c = r"x"\nvar d = a &&"y"\n';
	const names = extractReferencesCore("scripts/tokens.gd", text, composeSymbolId).map((reference) => reference.name);

	expect(names).toEqual(["a"]);
});

test("a string literal owns its prefix and a raw string keeps its escapes", () => {
	const provider = started();
	const text = 'var raw = r"a\\nb"\nvar both = a &&"x"\n';
	const facts = provider.parseFile({ module: "prefix.gd", contentHash: "prefix", text });

	expect(facts.literals.map((literal) => ({ value: literal.value, start: literal.range.start }))).toEqual([
		{ value: "a\\nb", start: { line: 0, character: 10 } },
		{ value: "x", start: { line: 1, character: 15 } },
	]);
});

// Both inputs below are pathological but legal: the path text also occurs EARLIER in the same
// match, which is the only way to tell a capture offset apart from a search for the same text.
// The old code searched, so it located the class name and the loader word instead of the path.
test("an extends path is located by its capture rather than by searching the match", () => {
	const provider = started();
	const text = 'class Weapon extends "Weapon"\n';

	const facts = provider.parseFile({ module: "weapon.gd", contentHash: "weapon", text });
	const reference = facts.references.find((entry) => entry.role === "extends");

	expect(reference?.name).toBe("Weapon");
	// Inside the quotes at character 22, not the class name at character 6.
	expect(reference?.range.start).toEqual({ line: 0, character: 22 });
});

test("a loader path is located by its capture rather than by searching the match", () => {
	const provider = started();
	const text = 'const Script = preload("load")\n';

	const facts = provider.parseFile({ module: "user.gd", contentHash: "user", text });
	const reference = facts.references.find((entry) => entry.role === "import");

	expect(reference?.name).toBe("load");
	// Inside the quotes at character 24, not the "load" inside "preload" at character 18.
	expect(reference?.range.start).toEqual({ line: 0, character: 24 });
});
