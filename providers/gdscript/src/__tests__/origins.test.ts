import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	applyEdits,
	type Binding,
	handlersFor,
	hashContent,
	PROTOCOL_VERSION,
	type RenameSite,
} from "@nyaa-lexicon/protocol";
import { GDScriptProvider } from "../main.js";

const roots: string[] = [];

function started(files: Record<string, string>) {
	const root = mkdtempSync(path.join(tmpdir(), "lexicon-gdscript-origins-"));
	roots.push(root);
	for (const [module, text] of Object.entries(files)) {
		const full = path.join(root, module);
		mkdirSync(path.dirname(full), { recursive: true });
		writeFileSync(full, text);
	}
	const handlers = handlersFor(new GDScriptProvider());
	handlers.initialize({ workspaceRoot: root, protocolVersion: PROTOCOL_VERSION });
	handlers.discoverProject({ workspaceRoot: root });
	return handlers;
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const USER = `extends Base
const Other = preload("res://base.gd")
var count := 0
func helper() -> void:
	pass
func run(target: Node) -> void:
	helper()
	count = 1
	var made := Base.new()
	Twin.new()
	GameState.reset()
	var typed: Other
	target.helper()
`;

test("proves a declaration origin through lexical scope or a lone class_name, and nothing else", () => {
	const provider = started({
		"project.godot":
			'config_version=5\n\n[application]\nconfig/name="origins"\n\n[autoload]\nGameState="*res://state.gd"\n',
		"base.gd": "class_name Base\nextends Node\n",
		"other.gd": "class_name Other\nextends Node\n",
		"twin_a.gd": "class_name Twin\nextends Node\n",
		"twin_b.gd": "class_name Twin\nextends Node\n",
		"state.gd": "extends Node\n",
		"user.gd": USER,
	});
	const facts = provider.parseFile({ module: "user.gd", contentHash: "user", text: USER });
	const shown = (references: typeof facts.references) =>
		references.map((reference) => [reference.name, reference.range.start.line]);

	expect(shown(facts.references.filter((reference) => reference.origin?.kind === "declaration"))).toEqual([
		["Base", 0],
		["helper", 6],
		["count", 7],
		["Base", 8],
	]);
	// Bound through an autoload, past a same-file const, or by a path: no proof.
	expect(
		shown(
			facts.references.filter(
				(reference) => reference.binding.status === "bound" && reference.origin === undefined,
			),
		),
	).toEqual([
		["GameState", 10],
		["Other", 11],
		["res://base.gd", 1],
	]);
	expect(facts.references.find((reference) => reference.name === "Twin")?.binding).toMatchObject({
		status: "unbound",
		reason: "Ambiguous",
	});
});

const PROJECT = 'config_version=5\n\n[application]\nconfig/name="members"\n';

const LOADED = `static func foo() -> void:
	pass
func inst() -> void:
	pass
const C = 1
static var sv := 2
var iv := 3
enum E { A }
enum { LOOSE }
class Inner:
	pass
signal sig
`;

const LOADER = `const D = preload("res://d.gd")
func run(foo: int) -> void:
	D.foo()
	print(D.C, D.E, D.LOOSE)
	D.sv += foo
	var made: D.Inner = D.Inner.new()
	D.inst()
	print(D.iv, D.sig)
	D.missing()
`;

test("binds a class member reached through a const preload, keeping that edge as its origin", () => {
	const provider = started({ "project.godot": PROJECT, "d.gd": LOADED, "user.gd": LOADER });
	const loaded = provider.parseFile({ module: "d.gd", contentHash: "d", text: LOADED });
	const facts = provider.parseFile({ module: "user.gd", contentHash: "user", text: LOADER });
	const edge = facts.imports[0]?.edges[0];
	if (edge === undefined) throw new Error("preload edge missing");
	const names = new Map(loaded.declarations.map((declaration) => [declaration.symbolId, declaration.name]));
	const outcome = (binding: Binding) => {
		if (binding.status === "bound") return names.get(binding.symbolId);
		return binding.status === "unbound" ? binding.reason : binding.status;
	};
	const traced = facts.references.filter((reference) => reference.origin?.kind === "import");

	expect(traced.map((reference) => reference.origin)).toEqual(
		traced.map((reference) => ({ kind: "import", span: edge.span, path: [reference.name] })),
	);
	// An instance member through the class, or one the script lacks, proves nothing.
	expect(traced.map(({ name, range, role, binding }) => [name, range.start.line, role, outcome(binding)])).toEqual([
		["foo", 2, "call", "foo"],
		["C", 3, "read", "C"],
		["E", 3, "read", "E"],
		["LOOSE", 3, "read", "LOOSE"],
		["sv", 4, "read", "sv"],
		["sv", 4, "write", "sv"],
		["Inner", 5, "typeUse", "Inner"],
		["Inner", 5, "read", "Inner"],
		["inst", 6, "call", "DynamicallyTyped"],
		["iv", 7, "read", "DynamicallyTyped"],
		["sig", 7, "read", "DynamicallyTyped"],
		["missing", 8, "call", "DynamicallyTyped"],
	]);
});

const NESTED = `static func foo() -> void:
	const HIDDEN = 0
enum E { A }
class Inner:
	const K = 1
	static func make() -> void:
		pass
	func inst() -> void:
		pass
	class Deeper:
		const Q = 2
`;

const THROUGH = `const D = preload("res://d.gd")
func run() -> void:
	print(D.E.A, D.Inner.K, D.Inner.Deeper.Q)
	D.Inner.make()
	D.Inner.inst()
	print(D.E.A.x, D.foo.HIDDEN)
func local() -> void:
	const L = preload("res://d.gd")
	L.foo()
	if true:
		const M = preload("res://d.gd")
		M.foo()
	M.foo()
	N.foo()
	const N = preload("res://d.gd")
func twice() -> void:
	if true:
		const T = preload("res://d.gd")
		T.foo()
	else:
		const T = preload("res://d.gd")
func captured() -> void:
	const P = preload("res://d.gd")
	var made := func(P): P.foo()
`;

test("binds a static path through types, and a member through a local const preload whose block holds it", () => {
	const provider = started({ "project.godot": PROJECT, "d.gd": NESTED, "user.gd": THROUGH });
	const loaded = provider.parseFile({ module: "d.gd", contentHash: "d", text: NESTED });
	const facts = provider.parseFile({ module: "user.gd", contentHash: "user", text: THROUGH });
	const spans = new Map(facts.imports.map((statement, at) => [JSON.stringify(statement.edges[0]?.span), at]));
	const names = new Map(loaded.declarations.map((declaration) => [declaration.symbolId, declaration.name]));
	const outcome = (binding: Binding) => {
		if (binding.status === "bound") return names.get(binding.symbolId);
		return binding.status === "unbound" ? binding.reason : binding.status;
	};

	// Each row: the preload edge by order, then the path it names.
	expect(
		facts.references
			.filter((reference) => reference.qualified === true)
			.map(({ name, range, binding, origin }) => [
				name,
				range.start.line,
				origin?.kind === "import" ? [spans.get(JSON.stringify(origin.span)), origin.path] : origin,
				outcome(binding),
			]),
	).toEqual([
		["E", 2, [0, ["E"]], "E"],
		["A", 2, [0, ["E", "A"]], "A"],
		["Inner", 2, [0, ["Inner"]], "Inner"],
		["K", 2, [0, ["Inner", "K"]], "K"],
		["Inner", 2, [0, ["Inner"]], "Inner"],
		["Deeper", 2, [0, ["Inner", "Deeper"]], "Deeper"],
		["Q", 2, [0, ["Inner", "Deeper", "Q"]], "Q"],
		["Inner", 3, [0, ["Inner"]], "Inner"],
		["make", 3, [0, ["Inner", "make"]], "make"],
		["Inner", 4, [0, ["Inner"]], "Inner"],
		// An instance member, or a path through a value, proves nothing.
		["inst", 4, [0, ["Inner", "inst"]], "DynamicallyTyped"],
		["E", 5, [0, ["E"]], "E"],
		["A", 5, [0, ["E", "A"]], "A"],
		["x", 5, [0, ["E", "A", "x"]], "DynamicallyTyped"],
		["foo", 5, [0, ["foo"]], "foo"],
		["HIDDEN", 5, [0, ["foo", "HIDDEN"]], "DynamicallyTyped"],
		["foo", 8, [1, ["foo"]], "foo"],
		["foo", 11, [2, ["foo"]], "foo"],
		// Past its block, before its statement, one of two, or under a lambda parameter: not that local.
		["foo", 12, undefined, "DynamicallyTyped"],
		["foo", 13, undefined, "DynamicallyTyped"],
		["foo", 18, undefined, "DynamicallyTyped"],
		["foo", 23, undefined, "DynamicallyTyped"],
	]);
});

test("renames a preload member site, and the probe binds it to the renamed member", async () => {
	const provider = started({ "project.godot": PROJECT, "d.gd": LOADED, "user.gd": LOADER });
	const texts: Record<string, string> = { "d.gd": LOADED, "user.gd": LOADER };
	const held = Object.fromEntries(
		Object.entries(texts).map(([module, text]) => [
			module,
			provider.parseFile({ module, contentHash: module, text }),
		]),
	);
	const foo = held["d.gd"]?.declarations.find((declaration) => declaration.name === "foo");
	if (foo?.selectionRange === undefined) throw new Error("foo missing");

	const proposed = Object.entries(texts).map(([module, text]) => {
		const sites: RenameSite[] = (held[module]?.references ?? [])
			.filter((reference) => reference.binding.status === "bound" && reference.binding.symbolId === foo.symbolId)
			.map((reference) => ({ range: reference.range, role: reference.role }));
		if (module === "d.gd") sites.push({ range: foo.selectionRange as NonNullable<typeof foo.selectionRange> });
		const answer = provider.renameEdits({ module, text, oldName: "foo", newName: "bar", sites });
		if (answer.status !== "ready" || answer.blocked.length > 0) throw new Error(`${module} was not renamed`);
		const rewritten = applyEdits(text, answer.edits);
		if ("problem" in rewritten) throw new Error(rewritten.problem);
		return { module, contentHash: hashContent(rewritten.text), text: rewritten.text };
	});

	expect(proposed.find((file) => file.module === "user.gd")?.text).toBe(LOADER.replace("D.foo()", "D.bar()"));
	const probe = await provider.probeBatch({ files: proposed, answer: ["d.gd", "user.gd"] });
	if (probe.status !== "ready") throw new Error("the probe was unsupported");
	const [loaded, user] = probe.facts;
	const bar = loaded?.declarations.find((declaration) => declaration.name === "bar");
	const use = user?.references.find((reference) => reference.name === "bar");
	if (bar === undefined) throw new Error("bar missing from the proposed d.gd");

	expect(use?.binding).toEqual({ status: "bound", symbolId: bar.symbolId, provenance: "bound" });
	expect(use?.origin).toMatchObject({ kind: "import", path: ["bar"] });
});
