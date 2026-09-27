import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { coordinatesOf, handlersFor, PROTOCOL_VERSION, type Range } from "@nyaa-lexicon/protocol";
import { parsePowerShellFile } from "../extract.js";
import { PowerShellProvider } from "../main.js";

function workspace(files: Record<string, string>): string {
	const root = mkdtempSync(path.join(os.tmpdir(), "powershell-provider-"));
	for (const [file, text] of Object.entries(files)) {
		const absolute = path.join(root, file);
		mkdirSync(path.dirname(absolute), { recursive: true });
		writeFileSync(absolute, text);
	}
	return root;
}

function provider(files: Record<string, string>) {
	const root = workspace(files);
	const handlers = handlersFor(new PowerShellProvider());
	handlers.initialize({ workspaceRoot: root, protocolVersion: PROTOCOL_VERSION });
	handlers.discoverProject({ workspaceRoot: root });
	const parse = (module: string) => handlers.parseFile({ module, contentHash: "h", text: files[module] as string });
	return { handlers, parse };
}

function sliceOf(text: string, range: Range | undefined): string | undefined {
	return range === undefined ? undefined : coordinatesOf(text).sliceRange(range);
}

describe("declarations", () => {
	const text = [
		"param([string] $Root)",
		"class Animal {",
		"    [string] $Name",
		"    Animal([string] $name) { $this.Name = $name }",
		"    [string] Speak() { return $this.Name }",
		"}",
		"enum Color { Red; Green = 2 }",
		"function Get-Thing {",
		"    param([Parameter(Mandatory)][int] $Count)",
		"    $local = 1",
		"    function Inner { }",
		"}",
		"filter Select-Odd { $_ }",
		"$global:Shared = 1",
		"$total = 0",
		"",
	].join("\n");
	const parsed = parsePowerShellFile("tools.ps1", text);
	const byName = new Map(parsed.declarations.map((declaration) => [declaration.name, declaration]));

	it("declares functions, parameters, classes, members, enums and variables once each", () => {
		expect(parsed.declarations.map((declaration) => `${declaration.kind} ${declaration.name}`)).toEqual([
			"variable Root",
			"class Animal",
			"property Name",
			"constructor Animal",
			"variable name",
			"method Speak",
			"enum Color",
			"constant Red",
			"constant Green",
			"function Get-Thing",
			"variable Count",
			"variable local",
			"function Inner",
			"function Select-Odd",
			"variable Shared",
			"variable total",
		]);
		expect(byName.get("Count")).toMatchObject({ languageKind: "parameter", visibility: "local" });
		expect(byName.get("Inner")?.visibility).toBe("local");
		expect(byName.get("Select-Odd")?.languageKind).toBe("filter");
		expect(byName.get("Shared")?.languageKind).toBe("global");
		expect(byName.get("Green")?.languageKind).toBe("enumMember");
	});

	it("selects each name alone, and signs each header on one line", () => {
		for (const declaration of parsed.declarations) {
			expect(sliceOf(text, declaration.selectionRange)?.toLowerCase()).toBe(declaration.name.toLowerCase());
		}
		expect(byName.get("Get-Thing")?.signature).toBe("function Get-Thing param([Parameter(Mandatory)][int] $Count)");
		expect(byName.get("Speak")?.signature).toBe("[string] Speak()");
		expect(byName.get("Get-Thing")?.metrics).toEqual({ lines: 5, parameters: 1 });
	});

	it("declares what a command or `++` sets, and selects a quoted or escaped name as written", () => {
		const text = [
			"function f { Set-Variable -Name 'Widget' -Value 1 -Scope Global; $n++ }",
			"${a`-b} = 1",
			"",
		].join("\n");
		const declared = parsePowerShellFile("x.ps1", text).declarations;
		expect(declared.map((declaration) => [declaration.name, sliceOf(text, declaration.selectionRange)])).toEqual([
			["f", "f"],
			["Widget", "Widget"],
			["n", "n"],
			["a-b", "a`-b"],
		]);
		// `-Scope Global` lands at the script's top level.
		expect(declared.find((declaration) => declaration.name === "Widget")?.containerId).toBeUndefined();
	});
});

describe("references and binding", () => {
	it("binds a name without regard to case, a local before the script's, and named arguments as PowerShell does", () => {
		const text = [
			"$Count = 1",
			"function Show-It { [CmdletBinding()] param($Name, [Alias('v2')] $Verbose2) $count = 2; $COUNT; $script:Count }",
			"show-it -na x -Verbose -v2 1",
			"function Outer { Get-Inner; function Get-Inner { }; Get-Inner }",
			"",
		].join("\n");
		const parsed = parsePowerShellFile("x.ps1", text);
		const targets = parsed.references
			.filter((reference) => reference.of.kind !== "type")
			.map((reference) => [reference.name, reference.target?.split(" ").at(-1)]);
		// `$count = 2` declares the function's local; `-Verbose` is the common parameter, not a prefix;
		// a function defined in a body counts only after its definition.
		expect(targets).toEqual([
			["COUNT", "Show-It().count."],
			["Count", "Count."],
			["show-it", "Show-It()."],
			["na", "Show-It().(Name)"],
			["Verbose", undefined],
			["v2", "Show-It().(Verbose2)"],
			["Get-Inner", undefined],
			["Get-Inner", "Outer().Get-Inner()."],
		]);
	});

	it("binds members of `$this`, of a type literal, and of a variable whose type is declared or built", () => {
		const text = [
			"class Box { [int] $Size; static [Box] Make() { return [Box]::new() } [int] Grow() { return $this.Size }",
			"  [int] Pick([int] $a) { return $a } [int] Pick([int] $a, [int] $b) { return $b } }",
			"[Box]::Make()",
			"$built = [Box]::new(); $built.Grow(); $built.Pick(1, 2)",
			"[Box] $declared = $null; $declared.Size",
			"$made = New-Object Box; $made.Grow()",
			"",
		].join("\n");
		const parsed = parsePowerShellFile("x.ps1", text);
		const members = parsed.references
			.filter((reference) => reference.of.kind === "member")
			.map((reference) => [reference.name, reference.target?.split(" ").at(-1)]);
		// An overload is picked by argument count.
		expect(members).toEqual([
			["Size", "Box#Size."],
			["Make", "Box#Make()."],
			["Grow", "Box#Grow()."],
			["Pick", "Box#Pick()[2]."],
			["Size", "Box#Size."],
			["Grow", "Box#Grow()."],
		]);
	});

	it("infers a value's class from how it is written: a function's output, a method's type, a chain", () => {
		const text = [
			"class Box { [int] $Size; [Box] Next() { return $this } [void] Grow() { } }",
			"function New-Box { [OutputType([Box])] param() }",
			"function Make-Box { $saved = { return 1 }; [void] $saved; New-Box }",
			"$made = Make-Box; $made.Next().Grow()",
			"$next = $made.Next(); $next.Size",
			"[Box[]] $all = @(); $all[0].Grow()",
			'$count = 1; $name = "n $count"; $big = 0x100000000',
			"",
		].join("\n");
		const parsed = parsePowerShellFile("x.ps1", text);
		const members = parsed.references
			.filter((reference) => reference.of.kind === "member")
			.map((reference) => [reference.name, reference.target?.split(" ").at(-1)]);
		expect(members).toEqual([
			["Next", "Box#Next()."],
			["Grow", "Box#Grow()."],
			["Next", "Box#Next()."],
			["Size", "Box#Size."],
			["Grow", "Box#Grow()."],
		]);
		const types = new Map(parsed.declarations.map((declaration) => [declaration.name, declaration.inferredType]));
		// A script block's `return` is its own, not the function's.
		expect(["Make-Box", "made", "next", "count", "name", "big"].map((name) => types.get(name))).toEqual([
			"Box",
			"Box",
			"Box",
			"int",
			"string",
			"long",
		]);
	});

	it("binds across dot-sourced files and imported modules, and a module shows only its exports", () => {
		const files = {
			"lib/helpers.ps1": "function Get-Help2 { }\n$Setting = 1\n",
			"Mod/Mod.psm1": [
				". $PSScriptRoot/Private.ps1",
				"function Get-Shown { }",
				"function Get-Hidden { }",
				"$Exported = 1",
				"$Kept = 2",
				"Export-ModuleMember -Function Get-[S]* -Variable Exported",
				"",
			].join("\n"),
			"Mod/Private.ps1": "function Get-Private { }\nfunction Get-Sub { }\n",
			"Mod/Mod.psd1": "@{ RootModule = 'Mod.psm1' }\n",
			"run.ps1": [
				". $PSScriptRoot/lib/helpers.ps1",
				"Import-Module Mod",
				"Get-Help2; Get-Shown; Get-Hidden; Get-Private; Get-Sub",
				"$Setting; $Exported; $Kept",
				"",
			].join("\n"),
		};
		const { parse } = provider(files);
		const run = parse("run.ps1");
		const bindings = run.references.map((reference) => [reference.name, reference.binding.status]);
		// The module's list gates what it dot-sources too; a variable leaves only as listed.
		expect(bindings).toEqual([
			["Get-Help2", "bound"],
			["Get-Shown", "bound"],
			["Get-Sub", "bound"],
			["Setting", "bound"],
			["Exported", "bound"],
			["Kept", "unbound"],
		]);
		expect(
			parse("Mod/Mod.psm1").declarations.map((declaration) => [declaration.name, declaration.exported]),
		).toEqual([
			["Get-Shown", true],
			["Get-Hidden", false],
			["Exported", true],
			["Kept", undefined],
		]);
	});

	it("resolves `$PSScriptRoot`, `Join-Path` and module names, and reports externals", () => {
		const files = {
			"a/b.ps1": [
				"using module @{ ModuleName = 'PSReadLine'; ModuleVersion = '2.0' }",
				". (Join-Path $PSScriptRoot c.ps1)",
				"Import-Module Pester",
				". '$PSScriptRoot/literal.ps1'",
				"",
			].join("\n"),
			"a/c.ps1": "",
		};
		const { handlers } = provider(files);
		const facts = parsePowerShellFile("a/b.ps1", files["a/b.ps1"]);
		// A `$` in single quotes expands nothing, so that path is no script root.
		expect(facts.sources.map((source) => source.specifier)).toEqual([
			"PSReadLine",
			"$PSScriptRoot/c.ps1",
			"Pester",
		]);
		expect(handlers.resolveImport({ fromModule: "a/b.ps1", specifier: "$PSScriptRoot/c.ps1" })).toEqual({
			status: "resolved",
			module: "a/c.ps1",
		});
		expect(handlers.resolveImport({ fromModule: "a/b.ps1", specifier: "Pester" })).toEqual({
			status: "external",
			packageName: "Pester",
		});
	});

	it("drops an unbound command, type or member, and keeps an unbound variable", () => {
		const { parse } = provider({ "x.ps1": "Get-ChildItem | ForEach-Object { $_.Name }\n[string] $x = $y\n" });
		expect(parse("x.ps1").references.map((reference) => [reference.name, reference.binding.status])).toEqual([
			["y", "unbound"],
		]);
	});
});

describe("literals, trivia, roles and types", () => {
	it("reports literals by kind, comments with their neighbours, and blank lines", () => {
		const text = "# lead\n\n$a = 'x' # tail\nWrite-Host 42 word $true\n<#\nblock\n#>\n";
		const parsed = parsePowerShellFile("x.ps1", text);
		expect(parsed.literals.map((literal) => [literal.kind, literal.value])).toEqual([
			["string", "x"],
			["number", "42"],
			["string", "word"],
			["boolean", "true"],
		]);
		expect(parsed.comments.map((comment) => [comment.text, comment.codeBefore, comment.codeAfter])).toEqual([
			["# lead", false, false],
			["# tail", true, false],
			["<#\nblock\n#>", false, false],
		]);
		expect(parsed.blankLines).toEqual([1]);
	});

	it("reads a script that runs commands as an entry, and a module or definitions as a library", () => {
		expect(parsePowerShellFile("x.ps1", "function f { }\n$x = 1\n. ./lib.ps1\nImport-Module Foo\n").role).toEqual({
			kind: "library",
		});
		expect(parsePowerShellFile("x.ps1", "Write-Host hi\n").role).toEqual({ kind: "entry", how: "topLevel" });
		expect(parsePowerShellFile("x.psm1", "Write-Host hi\n").role).toEqual({ kind: "library" });
	});

	it("answers a declared or inferred type, and a refused file as a parse error", () => {
		const text = "class Box { }\n[int] $a = 1\n$b = [Box]::new()\n$c = Get-Thing\n";
		const { handlers, parse } = provider({ "x.ps1": text });
		parse("x.ps1");
		const at = (line: number, character: number): Range => ({
			start: { line, character },
			end: { line, character: character + 1 },
		});
		expect(handlers.typeOf({ module: "x.ps1", range: at(1, 7) })).toMatchObject({
			status: "known",
			display: "int",
			provenance: "declared",
		});
		expect(handlers.typeOf({ module: "x.ps1", range: at(2, 1) })).toMatchObject({
			status: "inferred",
			display: "Box",
			basis: "assigned value",
			symbolId: expect.stringContaining("Box#"),
		});
		expect(handlers.typeOf({ module: "x.ps1", range: at(3, 1) })).toMatchObject({ status: "unknown" });
		const broken = parsePowerShellFile("x.ps1", "function f {\n");
		expect(broken.role).toEqual({ kind: "unknown", reason: "ParseError" });
		expect(broken.diagnostics[0]?.severity).toBe("error");
	});
});
