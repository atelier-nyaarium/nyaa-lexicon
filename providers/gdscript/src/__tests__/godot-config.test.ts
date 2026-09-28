import { describe, expect, test } from "bun:test";
import { type ConfigSection, extResourceOf, readConfig, readConfigResult, stringOf } from "../godot-config.js";

////////////////////////////////
//  Helpers

function section(sections: ConfigSection[] | null, name: string): ConfigSection {
	const found = sections?.find((candidate) => candidate.name === name);
	if (found === undefined) throw new Error(`no section ${name}`);
	return found;
}

////////////////////////////////
//  Tests

describe("Godot's text resource format", () => {
	test("reads project settings: keys with slashes, escapes, multi-line strings and every value form", () => {
		const text = `; Engine configuration file.
config_version=5

[application]

config/name="Name with \\"quotes\\" and \\\\ a \\u00e9"
run/main_scene = "res://main.tscn"
config/features=PackedStringArray("4.6", "Forward Plus")
config/description="line one
line two"

[input]

jump={
"deadzone": 0.5,
"events": [Object(InputEventKey,"resource_local_to_scene":false,"keycode":32)]
}

[rendering]

environment/defaults/default_clear_color=Color(0.3, 0.3, 0.3, 1)
limits/time/time_rollover_secs=-inf
theme/accent=#ff00aa
`;
		const sections = readConfig(text, { simpleTags: true });
		const application = section(sections, "application").properties;

		expect(sections?.map((candidate) => candidate.name)).toEqual(["", "application", "input", "rendering"]);
		expect(section(sections, "").properties.get("config_version")).toEqual({ kind: "number", text: "5" });
		expect([
			stringOf(application.get("config/name")),
			stringOf(application.get("run/main_scene")),
			stringOf(application.get("config/description")),
		]).toEqual([
			`Name with "quotes" and \\ a ${String.fromCodePoint(0xe9)}`,
			"res://main.tscn",
			"line one\nline two",
		]);
		expect(application.get("config/features")).toEqual({
			kind: "call",
			name: "PackedStringArray",
			arguments: [
				{ kind: "string", value: "4.6" },
				{ kind: "string", value: "Forward Plus" },
			],
		});
		expect(section(sections, "input").properties.get("jump")?.kind).toBe("dictionary");
		expect([...section(sections, "rendering").properties.values()].map((value) => value.kind)).toEqual([
			"call",
			"word",
			"color",
		]);
	});

	test("reads a scene's tags, fields, resources and properties", () => {
		const text = `[gd_scene load_steps=3 format=3 uid="uid://abc"]

[ext_resource type="Script" uid="uid://s" path="res://a.gd" id="1_a"]
[ext_resource path="res://b.tscn" type="PackedScene" id=2]

[sub_resource type="GDScript" id="GDScript_x"]
script/source = "extends Node
func f():
	print(\\"]\\")
"

[node name="Root" type="Node2D" groups=["enemies", "saveable"]]
script = ExtResource("1_a")
metadata/_edit_group_ = true
typed = Array[ExtResource("1_a")]([])

[node name="Child" parent="." instance=ExtResource( 2 )]
`;
		const sections = readConfig(text);
		const nodes = sections?.filter((candidate) => candidate.name === "node") ?? [];

		expect(sections?.map((candidate) => candidate.name)).toEqual([
			"",
			"gd_scene",
			"ext_resource",
			"ext_resource",
			"sub_resource",
			"node",
			"node",
		]);
		expect(stringOf(section(sections, "gd_scene").fields.get("uid"))).toBe("uid://abc");
		expect(nodes.map((node) => [node.fields.has("parent"), extResourceOf(node.properties.get("script"))])).toEqual([
			[false, "1_a"],
			[true, undefined],
		]);
		expect(extResourceOf(nodes[1]?.fields.get("instance"))).toBe("2");
		expect(readConfig(text, { tags: 1 })?.map((candidate) => candidate.name)).toEqual(["", "gd_scene"]);
		expect(nodes[0]?.fields.get("groups")).toEqual({
			kind: "array",
			items: [
				{ kind: "string", value: "enemies" },
				{ kind: "string", value: "saveable" },
			],
		});
	});

	// VariantParser sets escaping on every backslash, so `\\]` still escapes the bracket.
	test("a simple tag is its raw name to an unescaped bracket, and a structured one its words", () => {
		const text = "[my section.with:odd name]\na=1\n[input_devices.pointing]\nb=2\n[x\\]y\\\\]z]\nc=3\n";

		expect(readConfig(text, { simpleTags: true })?.map((candidate) => candidate.name)).toEqual([
			"",
			"my section.with:odd name",
			"input_devices.pointing",
			"x\\]y\\\\]z",
		]);
		expect(readConfigResult("[x\\\\]\nc=3\n", { simpleTags: true }).problem).toBeDefined();
		expect(readConfig("[input_devices.pointing]\nb=2\n")?.map((candidate) => candidate.name)).toEqual([
			"",
			"input_devices.pointing",
		]);
	});

	test("a problem ends the read, and what came before it stands", () => {
		const broken = readConfigResult('[first]\na="kept"\n[second]\nb=Vector2(1,\nc="lost"\n', { simpleTags: true });
		const unclosed = readConfigResult('a="never closed\n');

		expect(broken.sections.map((candidate) => [candidate.name, [...candidate.properties.keys()]])).toEqual([
			["", []],
			["first", ["a"]],
			["second", []],
		]);
		expect(broken.problem?.position.line).toBe(4);
		expect(unclosed.problem?.position).toEqual({ line: 0, character: 2 });
		expect(readConfig('a="never closed\n')).toBeNull();
	});

	test("nesting past the limit is a problem, not a crash", () => {
		const read = readConfigResult(`deep=${"[".repeat(5000)}`);

		expect(read.problem).toBeDefined();
		expect(read.sections.map((candidate) => candidate.name)).toEqual([""]);
	});
});
