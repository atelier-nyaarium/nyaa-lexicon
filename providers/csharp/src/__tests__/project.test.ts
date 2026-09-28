import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CsharpProvider } from "../main.js";
import { frameworkSymbols } from "../msbuild.js";
import { startProvider } from "./harness.js";

const roots: string[] = [];

function write(root: string, files: Record<string, string>): void {
	for (const [module, text] of Object.entries(files)) {
		const full = path.join(root, module);
		mkdirSync(path.dirname(full), { recursive: true });
		writeFileSync(full, text);
	}
}

function workspace(files: Record<string, string>): string {
	const root = mkdtempSync(path.join(tmpdir(), "lexicon-csharp-project-"));
	roots.push(root);
	write(root, files);
	return root;
}

/** A class holding one field per symbol, each under `#if` that symbol. */
function gated(name: string, symbols: readonly string[], prefix = ""): string {
	const fields = symbols.map((symbol) => `#if ${symbol}\nint ${symbol.toLowerCase()};\n#endif`);
	return `${prefix}class ${name} {\n${fields.join("\n")}\n}\n`;
}

/** The symbols a file reads with, as the fields its sections keep. */
function kept(handlers: ReturnType<typeof startProvider>, root: string, module: string): string[] {
	const text = readFileSync(path.join(root, module), "utf8");
	return handlers
		.parseFile({ module, contentHash: `${module}:${text.length}`, text })
		.declarations.filter((item) => item.kind === "field")
		.map((item) => item.name.toUpperCase());
}

const PROBES = [
	"MODERN",
	"LEGACY_API",
	"FROM_PROPS",
	"SHIPPING",
	"TANGLED",
	"DEBUG",
	"TRACE",
	"NET",
	"NET8_0",
	"NET8_0_OR_GREATER",
	"NET6_0_OR_GREATER",
	"NET9_0_OR_GREATER",
	"NETSTANDARD",
	"NETFRAMEWORK",
	"OLD_DEBUG",
	"OLD_RELEASE",
	"LOCAL",
];

const PROPS = [
	"<Project>",
	"  <PropertyGroup>",
	"    <DefineConstants>$(DefineConstants);FROM_PROPS</DefineConstants>",
	"  </PropertyGroup>",
	"</Project>",
].join("\n");

const SDK_PROJECT = [
	'<Project Sdk="Microsoft.NET.Sdk">',
	"  <PropertyGroup>",
	"    <TargetFrameworks Condition=\"'$(OtherFrameworks)' == ''\">net8.0;netstandard2.0</TargetFrameworks>",
	"  </PropertyGroup>",
	"  <PropertyGroup Condition=\"'$(TargetFramework)' == 'net8.0'\">",
	"    <DefineConstants>$(DefineConstants);MODERN</DefineConstants>",
	"  </PropertyGroup>",
	"  <PropertyGroup Condition=\"'$(TargetFramework)' == 'netstandard2.0'\">",
	"    <DefineConstants>$(DefineConstants);LEGACY_API</DefineConstants>",
	"  </PropertyGroup>",
	"  <PropertyGroup Condition=\"'$(Configuration)' != 'Debug'\">",
	"    <DefineConstants>$(DefineConstants);SHIPPING</DefineConstants>",
	"  </PropertyGroup>",
	"  <PropertyGroup Condition=\"'$(TargetFramework)' == 'net8.0' And '$(Extra)' == ''\">",
	"    <DefineConstants>$(DefineConstants);TANGLED</DefineConstants>",
	"  </PropertyGroup>",
	"</Project>",
].join("\n");

const LEGACY_PROJECT = [
	'<Project ToolsVersion="15.0" xmlns="http://schemas.microsoft.com/developer/msbuild/2003">',
	'  <Import Project="$(MSBuildExtensionsPath)\\$(MSBuildToolsVersion)\\Microsoft.Common.props" Condition="Exists(\'$(MSBuildExtensionsPath)\\$(MSBuildToolsVersion)\\Microsoft.Common.props\')" />',
	"  <PropertyGroup>",
	"    <Configuration Condition=\" '$(Configuration)' == '' \">Release</Configuration>",
	"    <Platform Condition=\" '$(Platform)' == '' \">AnyCPU</Platform>",
	"    <TargetFrameworkVersion>v4.7.2</TargetFrameworkVersion>",
	"  </PropertyGroup>",
	"  <PropertyGroup Condition=\" '$(Configuration)|$(Platform)' == 'Debug|AnyCPU' \">",
	"    <DefineConstants>$(DefineConstants);DEBUG;TRACE;OLD_DEBUG</DefineConstants>",
	"  </PropertyGroup>",
	"  <PropertyGroup Condition=\" '$(Configuration)|$(Platform)' == 'Release|AnyCPU' \">",
	"    <DefineConstants>TRACE;OLD_RELEASE</DefineConstants>",
	"  </PropertyGroup>",
	'  <Import Project="$(MSBuildToolsPath)\\Microsoft.CSharp.targets" />',
	"</Project>",
].join("\n");

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("C# project symbols", () => {
	it("reads each file with its nearest project's symbols for Debug and the first target framework", () => {
		const root = workspace({
			"Directory.Build.props": PROPS,
			"lib/Lib.csproj": SDK_PROJECT,
			"lib/Code.cs": gated("Code", PROBES),
			"lib/deep/Deep.cs": gated("Deep", ["MODERN"]),
			"lib/Undo.cs": gated("Undo", ["MODERN", "LOCAL"], "#undef MODERN\n#define LOCAL\n"),
			"old/Old.csproj": LEGACY_PROJECT,
			"old/Old.cs": gated("Old", PROBES),
			"loose/Loose.cs": gated("Loose", PROBES, "#define LOCAL\n"),
		});
		const handlers = startProvider(new CsharpProvider(), root);
		expect(kept(handlers, root, "lib/Code.cs")).toEqual([
			"MODERN",
			"FROM_PROPS",
			"DEBUG",
			"TRACE",
			"NET",
			"NET8_0",
			"NET8_0_OR_GREATER",
			"NET6_0_OR_GREATER",
		]);
		expect(kept(handlers, root, "lib/deep/Deep.cs")).toEqual(["MODERN"]);
		expect(kept(handlers, root, "lib/Undo.cs")).toEqual(["LOCAL"]);
		expect(kept(handlers, root, "old/Old.cs")).toEqual(["FROM_PROPS", "DEBUG", "TRACE", "OLD_DEBUG"]);
		expect(kept(handlers, root, "loose/Loose.cs")).toEqual(["LOCAL"]);
		const model = handlers.discoverProject({ workspaceRoot: root });
		expect(model.configFiles).toEqual([
			"Directory.Build.props",
			"lib/Directory.Build.props",
			"lib/Lib.csproj",
			"old/Directory.Build.props",
			"old/Old.csproj",
		]);
		expect(model.diagnostics.map((item) => [item.severity, item.path, item.range?.start.line])).toEqual([
			["warning", "lib/Lib.csproj", 13],
		]);
	});

	it("follows props up the tree, guarded imports and Choose, and warns of what it cannot read", () => {
		const constants = (symbol: string) =>
			`<PropertyGroup><DefineConstants>$(DefineConstants);${symbol}</DefineConstants></PropertyGroup>`;
		const root = workspace({
			"Directory.Build.props": `<Project>${constants("ROOT_PROPS")}</Project>`,
			"src/Directory.Build.props": [
				"<Project>",
				"<Import Project=\"$([MSBuild]::GetPathOfFileAbove('Directory.Build.props', '$(MSBuildThisFileDirectory)../'))\" />",
				'<Import Project="..\\build\\common.props" Condition="Exists(\'..\\build\\common.props\')" />',
				'<Import Project="..\\build\\missing.props" Condition="Exists(\'..\\build\\missing.props\')" />',
				constants("SRC_PROPS"),
				"</Project>",
			].join("\n"),
			"build/common.props": [
				"<Project><Choose>",
				`<When Condition="'$(Configuration)' == 'Release'">${constants("CHOSEN_RELEASE")}</When>`,
				`<Otherwise>${constants("CHOSEN_OTHER")}</Otherwise>`,
				"</Choose></Project>",
			].join("\n"),
			"src/App/App.csproj": `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net6.0</TargetFramework></PropertyGroup></Project>`,
			"src/App/Twin.csproj": `<Project Sdk="Microsoft.NET.Sdk">${constants("TWIN")}</Project>`,
			"src/App/A.cs": gated("A", ["ROOT_PROPS", "SRC_PROPS", "CHOSEN_RELEASE", "CHOSEN_OTHER", "NET6_0", "TWIN"]),
			"src/Broken/Broken.csproj": "<Project><PropertyGroup></Project>",
			"src/Broken/B.cs": gated("B", ["DEBUG", "ROOT_PROPS", "SRC_PROPS"]),
		});
		const handlers = startProvider(new CsharpProvider(), root);
		expect(kept(handlers, root, "src/App/A.cs")).toEqual(["ROOT_PROPS", "SRC_PROPS", "CHOSEN_OTHER", "NET6_0"]);
		expect(kept(handlers, root, "src/Broken/B.cs")).toEqual([]);
		const model = handlers.discoverProject({ workspaceRoot: root });
		expect(model.configFiles).toEqual([
			"Directory.Build.props",
			"build/common.props",
			"build/missing.props",
			"src/App/App.csproj",
			"src/App/Directory.Build.props",
			"src/App/Twin.csproj",
			"src/Broken/Broken.csproj",
			"src/Directory.Build.props",
		]);
		expect(model.diagnostics.map((item) => [item.severity, item.path])).toEqual([
			["warning", "src/App/Twin.csproj"],
			["warning", "src/Broken/Broken.csproj"],
		]);
	});

	it("reads a recognized import's own condition, reserved properties and !Exists, and stops a deep import chain", () => {
		const chain = Array.from({ length: 80 }, (_, index) => [
			`chain/c${index}.props`,
			`<Project><Import Project="c${index + 1}.props" /><PropertyGroup><DefineConstants>$(DefineConstants);C${index}</DefineConstants></PropertyGroup></Project>`,
		]);
		const root = workspace({
			"Directory.Build.props": PROPS,
			"off/Off.csproj": [
				'<Project ToolsVersion="15.0">',
				"  <Import Project=\"$(MSBuildExtensionsPath)\\$(MSBuildToolsVersion)\\Microsoft.Common.props\" Condition=\"'$(MSBuildProjectExtension)' == '.vbproj'\" />",
				"  <PropertyGroup Condition=\"'$(MSBuildProjectName)' == 'Off'\"><DefineConstants>NAMED</DefineConstants></PropertyGroup>",
				"  <PropertyGroup Condition=\"!Exists('missing.txt')\"><DefineConstants>$(DefineConstants);NO_FILE</DefineConstants></PropertyGroup>",
				"</Project>",
			].join("\n"),
			"off/Off.cs": gated("Off", ["FROM_PROPS", "NAMED", "NO_FILE"]),
			"deep/Deep.csproj": '<Project Sdk="Microsoft.NET.Sdk"><Import Project="..\\chain\\c0.props" /></Project>',
			"deep/Deep.cs": gated("Deep", ["C0", "C62", "C63", "C64", "C79"]),
			...Object.fromEntries(chain),
		});
		const handlers = startProvider(new CsharpProvider(), root);
		expect(kept(handlers, root, "off/Off.cs")).toEqual(["NAMED", "NO_FILE"]);
		// The chain keeps what it read before its limit.
		expect(kept(handlers, root, "deep/Deep.cs")).toEqual(["C0", "C62", "C63"]);
		const model = handlers.discoverProject({ workspaceRoot: root });
		expect(model.configFiles).toContain("off/missing.txt");
		expect(model.diagnostics.map((item) => [item.severity, item.path])).toEqual([["warning", "chain/c63.props"]]);
	});

	it("drops TRACE when a project replaces DefineConstants, and reparses when its symbols move", () => {
		const project = (constants: string, authors = "") =>
			`<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net472</TargetFramework><DefineConstants>${constants}</DefineConstants>${authors}</PropertyGroup></Project>`;
		const root = workspace({
			"app/App.csproj": project("FIRST"),
			"app/App.cs": gated("App", [
				"FIRST",
				"SECOND",
				"LATE",
				"TRACE",
				"DEBUG",
				"NETFRAMEWORK",
				"NET472",
				"NET48",
			]),
		});
		const handlers = startProvider(new CsharpProvider(), root);
		const discover = () => handlers.discoverProject({ workspaceRoot: root });
		const before = discover();
		// Absent props it looked for are listed, so one appearing later is noticed.
		expect(before.configFiles).toEqual(["Directory.Build.props", "app/App.csproj", "app/Directory.Build.props"]);
		expect(kept(handlers, root, "app/App.cs")).toEqual(["FIRST", "DEBUG", "NETFRAMEWORK", "NET472"]);
		write(root, { "app/App.csproj": project("FIRST", "<Authors>Someone</Authors>") });
		expect(discover().fingerprint).toBe(before.fingerprint);
		write(root, { "app/App.csproj": project("$(DefineConstants);SECOND") });
		const second = discover().fingerprint;
		expect(second).not.toBe(before.fingerprint);
		expect(kept(handlers, root, "app/App.cs")).toEqual(["SECOND", "TRACE", "DEBUG", "NETFRAMEWORK", "NET472"]);
		write(root, {
			"Directory.Build.props":
				"<Project><PropertyGroup><DefineConstants>LATE</DefineConstants></PropertyGroup></Project>",
		});
		expect(discover().fingerprint).not.toBe(second);
		expect(kept(handlers, root, "app/App.cs")).toEqual([
			"SECOND",
			"LATE",
			"TRACE",
			"DEBUG",
			"NETFRAMEWORK",
			"NET472",
		]);
	});

	it.each([
		["net472", ["NETFRAMEWORK", "NET472", "NET20_OR_GREATER", "NET472_OR_GREATER"], ["NET48_OR_GREATER", "NET"]],
		[
			"netstandard2.0",
			["NETSTANDARD", "NETSTANDARD2_0", "NETSTANDARD1_0_OR_GREATER"],
			["NETSTANDARD2_1_OR_GREATER"],
		],
		["netcoreapp3.1", ["NETCOREAPP", "NETCOREAPP3_1", "NETCOREAPP2_1_OR_GREATER"], ["NET", "NET5_0_OR_GREATER"]],
		[
			"net10.0",
			["NET", "NETCOREAPP", "NET10_0", "NET5_0_OR_GREATER", "NETCOREAPP3_1_OR_GREATER"],
			["NETCOREAPP10_0"],
		],
		["net8.0-ios17.2", ["NET8_0", "IOS", "IOS17_2", "IOS17_2_OR_GREATER"], ["NET9_0_OR_GREATER"]],
		["net20", ["NET20", "NET20_OR_GREATER", "NET11_OR_GREATER", "NET10_OR_GREATER"], ["NET35_OR_GREATER"]],
		["net10.0-windows", ["WINDOWS", "WINDOWS7_0", "WINDOWS7_0_OR_GREATER"], ["WINDOWS8_0_OR_GREATER"]],
		[
			"net8.0-windows10.0.19041.0",
			[
				"WINDOWS",
				"WINDOWS10_0_19041_0",
				"WINDOWS10_0_19041_0_OR_GREATER",
				"WINDOWS10_0_17763_0_OR_GREATER",
				"WINDOWS8_0_OR_GREATER",
				"WINDOWS7_0_OR_GREATER",
			],
			["WINDOWS10_0_22000_0_OR_GREATER"],
		],
		["uap10.0", [], ["UAP"]],
	])("names the SDK's implicit symbols for %s", (moniker, present, absent) => {
		const symbols = frameworkSymbols(moniker);
		expect(symbols).toEqual(expect.arrayContaining(present));
		for (const symbol of absent) expect(symbols).not.toContain(symbol);
	});
});
