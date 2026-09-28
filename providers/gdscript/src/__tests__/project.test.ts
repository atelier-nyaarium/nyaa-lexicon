import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { handlersFor, moduleOf, PROTOCOL_VERSION } from "@nyaa-lexicon/protocol";
import { GDScriptProvider } from "../main.js";

////////////////////////////////
//  Constants

const PROJECT = `; Engine configuration file.
config_version=5

[application]

config/name="roles"
run/main_scene="res://scenes/main.tscn"
config/features=PackedStringArray("4.6", "Forward Plus")

[autoload]

Global="*res://autoload/global.gd"
Hidden="res://autoload/hidden.gd"
Hud="*res://ui/hud.tscn"
Clock="*uid://b4dexjfof7rkj"
Escaped="*res://autoload/\\u0065scaped.gd"
Panel="*uid://panel"
Stripped="res://scenes/stripped.tscn"
Marked="*res://ui/marked.tscn"
MarkedByUid="*uid://marked"
`;

const FILES: Record<string, string> = {
	"project.godot": PROJECT,
	"scenes/main.tscn": `[gd_scene load_steps=2 format=3 uid="uid://main"]

[ext_resource type="PackedScene" uid="uid://base" path="res://scenes/base.tscn" id="1_base"]

[node name="Main" instance=ExtResource("1_base")]
`,
	"scenes/base.tscn": `[gd_scene load_steps=2 format=3 uid="uid://base"]

[ext_resource type="Script" path="res://scenes/base.gd" id="1_abc"]
[ext_resource type="Script" path="res://lib/util.gd" id="2_def"]

[node name="Base" type="Node2D"]
script = ExtResource("1_abc")

[node name="Child" type="Node" parent="."]
script = ExtResource("2_def")
`,
	"scenes/base.gd": "extends Node2D\n",
	"scenes/stripped.tscn": `[gd_scene load_steps=2 format=3]

[ext_resource type="PackedScene" path="res://scenes/quiet.tscn" id="1_quiet"]

[node name="Stripped" instance=ExtResource("1_quiet")]
script = null
`,
	"scenes/quiet.tscn": `[gd_scene load_steps=2 format=3]

[ext_resource type="Script" path="res://scenes/quiet.gd" id="1_q"]

[node name="Quiet" type="Node"]
script = ExtResource("1_q")
`,
	"scenes/quiet.gd": "extends Node\n",
	"ui/panel.tscn": `[gd_scene load_steps=2 format=3 uid="uid://panel"]

[ext_resource type="Script" path="res://ui/panel.gd" id="1_p"]

[node name="Panel" type="Control"]
script = ExtResource("1_p")
`,
	"ui/panel.gd": "extends Control\n",
	"ui/marked.tscn": `${String.fromCodePoint(0xfeff)}[gd_scene load_steps=2 format=3 uid="uid://marked"]

[ext_resource type="Script" path="res://ui/marked.gd" id="1_m"]

[node name="Marked" type="Control"]
script = ExtResource("1_m")
`,
	"ui/marked.gd": "extends Control\n",
	"ui/hud.tscn": `[gd_scene load_steps=2 format=2]

[ext_resource path="res://ui/hud.gd" type="Script" id=1]

[node name="Hud" type="CanvasLayer"]
script = ExtResource( 1 )
`,
	"ui/hud.gd": "extends CanvasLayer\n",
	"autoload/global.gd": "extends Node\n",
	"autoload/hidden.gd": "extends Node\n",
	"autoload/escaped.gd": "extends Node\n",
	"systems/clock.gd": "extends Node\n",
	"systems/clock.gd.uid": "uid://b4dexjfof7rkj\n",
	"tools/build.gd": "extends SceneTree\n\nfunc _initialize():\n\tquit()\n",
	"tools/loop.gd": "@tool\nextends MainLoop\n",
	"lib/util.gd": "class_name Util\nextends RefCounted\n",
	"use.gd": "func run():\n\tGlobal.ping()\n\tHidden.ping()\n\tHud.show()\n\tClock.tick()\n",
	"shadow.gd": "var Global = null\nfunc run():\n\tGlobal.ping()\n",
};

////////////////////////////////
//  Helpers

const roots: string[] = [];

function workspace(files: Record<string, string>) {
	const root = mkdtempSync(path.join(tmpdir(), "lexicon-gdscript-project-"));
	roots.push(root);
	for (const [module, text] of Object.entries(files)) {
		const full = path.join(root, module);
		mkdirSync(path.dirname(full), { recursive: true });
		writeFileSync(full, text);
	}
	const provider = new GDScriptProvider();
	const handlers = handlersFor(provider);
	handlers.initialize({ workspaceRoot: root, protocolVersion: PROTOCOL_VERSION });
	const model = handlers.discoverProject({ workspaceRoot: root });
	const parse = (module: string, depth?: "outline") =>
		handlers.parseFile({ module, contentHash: module, text: files[module] ?? "", ...(depth ? { depth } : {}) });
	// Rewrites a file, then discovers again.
	const rewrite = (module: string, text: string) => {
		writeFileSync(path.join(root, module), text);
		return handlers.discoverProject({ workspaceRoot: root });
	};
	return { provider, model, parse, rewrite };
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

////////////////////////////////
//  Tests

// A scene root's own `script`, `null` included, overrides the scene it inherits. Godot's scene
// loader skips a byte order mark and its uid reader does not, so `MarkedByUid` names nothing.
test("the main scene's root script and every autoload run; only a starred autoload is a global", () => {
	const { provider, model } = workspace(FILES);

	expect(provider.store.project.scopes).toEqual([
		{
			directory: "",
			autoloads: {
				Global: "autoload/global.gd",
				Hud: "ui/hud.gd",
				Clock: "systems/clock.gd",
				Escaped: "autoload/escaped.gd",
				Panel: "ui/panel.gd",
				Marked: "ui/marked.gd",
			},
			entries: [
				"autoload/escaped.gd",
				"autoload/global.gd",
				"autoload/hidden.gd",
				"scenes/base.gd",
				"systems/clock.gd",
				"ui/hud.gd",
				"ui/marked.gd",
				"ui/panel.gd",
			],
		},
	]);
	expect(model.configFiles).toEqual([
		"project.godot",
		"scenes/base.tscn",
		"scenes/main.tscn",
		"scenes/stripped.tscn",
		"systems/clock.gd.uid",
		"ui/hud.tscn",
		"ui/marked.tscn",
		"ui/panel.tscn",
	]);
	expect(model.diagnostics).toEqual([]);
});

test("an entry is the script class the engine instantiates, at either depth; anything else is a library", () => {
	const { parse } = workspace(FILES);
	const role = (module: string, depth?: "outline") => {
		const facts = parse(module, depth);
		const script = facts.declarations.find((declaration) => declaration.containerId === undefined);
		return facts.role?.kind === "entry" && facts.role.how === "main" && facts.role.symbolId === script?.symbolId
			? "entry"
			: facts.role?.kind;
	};

	expect(
		["scenes/base.gd", "autoload/hidden.gd", "tools/build.gd", "tools/loop.gd", "lib/util.gd", "project.godot"].map(
			(module) => role(module),
		),
	).toEqual(["entry", "entry", "entry", "entry", "library", "library"]);
	expect(role("tools/build.gd", "outline")).toBe("entry");
});

test("a singleton binds its global name through a scene or a uid, an unstarred autoload has none, and a member shadows one", () => {
	const { parse } = workspace(FILES);
	const bindings = parse("use.gd")
		.references.filter((reference) => reference.role === "read")
		.map((reference) => [
			reference.name,
			reference.binding.status === "bound" ? moduleOf(reference.binding.symbolId) : reference.binding.status,
		]);
	const shadow = parse("shadow.gd");
	const own = shadow.declarations.find((declaration) => declaration.name === "Global");

	expect(bindings).toEqual([
		["Global", "autoload/global.gd"],
		["Hidden", "unbound"],
		["Hud", "ui/hud.gd"],
		["Clock", "systems/clock.gd"],
	]);
	expect(shadow.references.find((reference) => reference.name === "Global")?.binding).toMatchObject({
		status: "bound",
		symbolId: own?.symbolId,
	});
});

test("the fingerprint moves with a singleton, an entry or a uid, and holds through an unrelated edit or a reorder", () => {
	const { model, rewrite } = workspace(FILES);
	const project = (from: string, to: string) => rewrite("project.godot", PROJECT.replace(from, to)).fingerprint;
	const global = 'Global="*res://autoload/global.gd"';

	const unrelated = [
		rewrite(
			"project.godot",
			`${PROJECT.replace('config/name="roles"', 'config/name="renamed"')}\n[display]\nwindow/size/viewport_width=640\n`,
		).fingerprint,
		rewrite("project.godot", `${PROJECT.replace(`${global}\n`, "")}${global}\n`).fingerprint,
	];
	const moved = [
		project(global, 'Global="res://autoload/global.gd"'),
		project(global, 'Global="*res://autoload/hidden.gd"'),
		project("res://scenes/main.tscn", "res://ui/panel.tscn"),
	];
	rewrite("project.godot", PROJECT);
	const uid = rewrite("systems/clock.gd.uid", "uid://moved\n").fingerprint;

	expect(model.fingerprint).toBeDefined();
	expect(unrelated).toEqual([model.fingerprint, model.fingerprint]);
	expect(new Set([model.fingerprint, ...moved, uid]).size).toBe(5);
});

test("a malformed project.godot keeps the autoloads read before its problem, and says where", () => {
	const { provider, model } = workspace({
		"project.godot": '[autoload]\nFirst="*res://first.gd"\nBroken=Vector2(1,\nLater="*res://later.gd"\n',
		"first.gd": "extends Node\n",
		"later.gd": "extends Node\n",
	});

	expect(provider.store.project.scopes[0]?.autoloads).toEqual({ First: "first.gd" });
	expect(
		model.diagnostics.map((diagnostic) => [diagnostic.severity, diagnostic.path, diagnostic.range?.start.line]),
	).toEqual([["warning", "project.godot", 3]]);
});
