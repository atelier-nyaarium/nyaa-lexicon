import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	type Binding,
	coordinatesOf,
	FileFactsSchema,
	handlersFor,
	PROTOCOL_VERSION,
	type Range,
} from "@nyaa-lexicon/protocol";
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

/** Each reference a module keeps, with the file and name path it reached. */
function reachedIn(files: Record<string, string>, module: string): Array<[string, unknown]> {
	const tail = (symbolId: string) => symbolId.split(" ").slice(-2).join(" ");
	const reached = (binding: Binding) =>
		binding.status === "bound"
			? tail(binding.symbolId)
			: binding.status === "ambiguous"
				? binding.candidates.map(tail)
				: binding.status;
	return provider(files)
		.parse(module)
		.references.map((reference) => [reference.name, reached(reference.binding)]);
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

	it("an import's member filter lets in only what it names, and nothing of a kind it leaves out", () => {
		const files = {
			"M.psm1": [
				"function Get-A { }",
				"function Get-B { }",
				"function Get-C1 { }",
				"$V = 1",
				"$W = 2",
				"Export-ModuleMember -Function * -Variable *",
				"",
			].join("\n"),
			"run.ps1": "Import-Module ./M.psm1 -Function Get-A, Get-C* -Variable V\nGet-A; Get-B; Get-C1; $V; $W\n",
			"only.ps1": "Import-Module ./M.psm1 -Function Get-A\n$V\n",
		};
		const { parse } = provider(files);
		const statuses = (module: string) =>
			parse(module).references.map((reference) => [reference.name, reference.binding.status]);
		expect([statuses("run.ps1"), statuses("only.ps1")]).toEqual([
			[
				["Get-A", "bound"],
				["Get-C1", "bound"],
				["V", "bound"],
				["W", "unbound"],
			],
			[["V", "unbound"]],
		]);
	});

	it("where a name is read, the last import before it wins; a function body may see any", () => {
		const files = {
			"a.ps1": "function Get-H { param($X) }\n$Value = 'a'\n",
			"b.ps1": "function Get-H { param($Y) }\n$Value = 'b'\n",
			// Its own definition follows its dot-source.
			"c.ps1": ". ./a.ps1\nfunction Get-H { }\n",
			"A.psm1": "function Get-M { }\n",
			"B.psm1": "function Get-M { }\n",
			"run.ps1": [
				". ./a.ps1",
				"Get-H",
				". ./b.ps1",
				"Get-H -X 1 -Y 2",
				"$Value",
				"function Run { Get-H }",
				". ./c.ps1",
				"Get-H",
				"Import-Module ./A.psm1",
				"Import-Module ./B.psm1",
				"Get-M",
				"",
			].join("\n"),
		};
		// `-X` names no parameter of the Get-H that runs, so it drops.
		expect(reachedIn(files, "run.ps1")).toEqual([
			["Get-H", "a.ps1 Get-H()."],
			["Get-H", "b.ps1 Get-H()."],
			["Y", "b.ps1 Get-H().(Y)"],
			["Value", "b.ps1 Value."],
			["Get-H", ["a.ps1 Get-H().", "b.ps1 Get-H().", "c.ps1 Get-H()."]],
			["Get-H", "c.ps1 Get-H()."],
			["Get-M", "B.psm1 Get-M()."],
		]);
	});

	it("a script's own definition and its dot-sources replace each other in order, and shadow a global import", () => {
		const files = {
			"lib.ps1": "function Get-H { param($Theirs) }\n$Value = 'lib'\n",
			"M.psm1":
				"function Get-H { }\nfunction Get-M { }\n$Value = 'm'\nExport-ModuleMember -Function * -Variable Value\n",
			"N.psm1": "function Get-M { }\n",
			"O.psm1": "function Get-M { }\n",
			"run.ps1": [
				"function Get-H { param($Mine) }; $Value = 'run'",
				". ./lib.ps1",
				"Get-H -Mine 1 -Theirs 2; $Value",
				"$Value = 'again'; $Value",
				"function Get-H { }",
				"Import-Module ./M.psm1",
				"Get-H; Get-M; $Value",
				"Import-Module ./N.psm1 -Scope Local",
				"Import-Module ./O.psm1",
				"Get-M",
				"function Run { Get-H }",
				"",
			].join("\n"),
			"late.ps1": ". ./lib.ps1\nImport-Module ./M.psm1\nGet-H\n",
			"W.psm1": "function Get-H { }\nImport-Module ./M.psm1\nGet-H\n",
			"Man/Man.psd1": "@{ RootModule = 'Man.psm1'; ScriptsToProcess = 'init.ps1' }\n",
			"Man/Man.psm1": "function Get-I { }\n",
			"Man/init.ps1": "function Get-I { }\n",
			"stp.ps1": "function Get-I { }\nImport-Module ./Man/Man.psd1\nGet-I\n",
		};
		// A write keeps its variable, a body sees the script's own definition, and a manifest's scripts
		// run in the script's scope.
		expect(["run.ps1", "late.ps1", "W.psm1", "stp.ps1"].map((module) => reachedIn(files, module))).toEqual([
			[
				["Get-H", "lib.ps1 Get-H()."],
				["Theirs", "lib.ps1 Get-H().(Theirs)"],
				["Value", "lib.ps1 Value."],
				["Value", "run.ps1 Value."],
				["Value", "run.ps1 Value."],
				["Get-H", "run.ps1 Get-H()[2]."],
				["Get-M", "M.psm1 Get-M()."],
				["Value", "run.ps1 Value."],
				["Get-M", "N.psm1 Get-M()."],
				["Get-H", "run.ps1 Get-H()[2]."],
			],
			[["Get-H", "lib.ps1 Get-H()."]],
			[["Get-H", "M.psm1 Get-H()."]],
			[["Get-I", "Man/init.ps1 Get-I()."]],
		]);
	});

	it("a prefixed import binds `Verb-PNoun` to the module's `Verb-Noun`, its variables as they are, and no unprefixed command", () => {
		const files = {
			"P.psm1": [
				"function Get-Thing { param($Count) }",
				"function Thing { }",
				"$Shared = 1",
				"Export-ModuleMember -Function * -Variable Shared",
				"",
			].join("\n"),
			"run.ps1": "Import-Module ./P.psm1 -Prefix Pp\nGet-PpThing -Count 1; PpThing; Get-Thing; Thing; $Shared\n",
			"only.ps1": "Import-Module ./P.psm1 -Prefix Pp -Function Get-Thing\nGet-PpThing; PpThing\n",
			"dynamic.ps1": "Import-Module ./P.psm1 -Prefix $p\nGet-PThing; Get-Thing; $Shared\n",
			"object.ps1": "$o = Import-Module ./P.psm1 -AsCustomObject\nGet-Thing\n",
		};
		// The run imports a custom object's members by name too.
		expect(["run.ps1", "only.ps1", "dynamic.ps1", "object.ps1"].map((module) => reachedIn(files, module))).toEqual([
			[
				["Get-PpThing", "P.psm1 Get-Thing()."],
				["Count", "P.psm1 Get-Thing().(Count)"],
				["PpThing", "P.psm1 Thing()."],
				["Shared", "P.psm1 Shared."],
			],
			[["Get-PpThing", "P.psm1 Get-Thing()."]],
			[
				["p", "unbound"],
				["Shared", "P.psm1 Shared."],
			],
			[["Get-Thing", "P.psm1 Get-Thing()."]],
		]);
	});

	it("a manifest's scripts run in the importer's scope, past the module's exports and the import's filter", () => {
		const files = {
			"Mod/Mod.psd1": [
				"@{",
				"    RootModule = 'Mod.psm1'",
				"    FunctionsToExport = @('Get-Mod')",
				"    ScriptsToProcess = 'init.ps1'",
				"}",
				"",
			].join("\n"),
			"Mod/Mod.psm1": "function Get-Mod { }\nfunction Get-Other { }\n",
			"Mod/init.ps1": "function Get-Init { }\n",
			"run.ps1": "Import-Module Mod -Function Get-Mod\nGet-Mod; Get-Other; Get-Init\n",
		};
		expect(
			provider(files)
				.parse("run.ps1")
				.references.map((reference) => [reference.name, reference.binding.status]),
		).toEqual([
			["Get-Mod", "bound"],
			["Get-Init", "bound"],
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
			landing: { kind: "module", module: "a/c.ps1" },
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

describe("import edges", () => {
	const LATER = { priority: 0, amongTransfers: "laterWins", againstLocal: "sourceOrder" };
	const GLOBAL = { priority: -1, amongTransfers: "laterWins", againstLocal: "localWins" };
	const VISIBLE = { kind: "visible" };
	const KNOWN = { status: "known" };
	const UNPROVED = { status: "unknown", reason: "NotImplemented" };
	const RUNTIME = { status: "unknown", reason: "RuntimeConstructed" };

	/** Each edge with its span and name range read back out of the text, in order. */
	function edgesOf(
		module: string,
		text: string,
	): { handlers: ReturnType<typeof provider>["handlers"]; edges: object[] } {
		const { handlers, parse } = provider({ [module]: text });
		const facts = parse(module);
		expect(FileFactsSchema.safeParse(facts).success).toBe(true);
		const edges = facts.imports.flatMap(({ specifier, edges }) =>
			edges.map(({ span, range, ...edge }) => ({
				specifier,
				span: sliceOf(text, span),
				...(range === undefined ? {} : { range: sliceOf(text, range) }),
				...edge,
			})),
		);
		expect(edges.map((edge) => edge.order)).toEqual(edges.map((_, order) => order));
		return { handlers, edges: edges.map(({ order: _order, ...edge }) => edge) };
	}

	it("dot-sources inject, imports bring every export or the members a filter names, and the rest is unproved", () => {
		const text = [
			"using namespace System.Text",
			"using module ./Mod.psm1",
			"using assembly System.Xml",
			". $PSScriptRoot/lib.ps1 -Quiet",
			"Import-Module Pester, PSReadLine",
			"Import-Module Mod -Function Get-A, 'Get-B', Get-C* -Variable $names",
			"Import-Module Mod -Prefix X",
			'Import-Module Mod -Prefix "X$suffix"',
			"Import-Module Here -Scope Local",
			"",
		].join("\n");
		const { handlers, edges } = edgesOf("x.ps1", text);
		// A script's imports land in the global scope, which its own names shadow.
		const brings = (specifier: string, span: string, certainty: object = KNOWN) => ({
			specifier,
			span,
			kind: "wildcard",
			bindsLocally: true,
			selector: VISIBLE,
			conflict: GLOBAL,
			certainty,
		});
		const names = (span: string, name: string) => ({
			specifier: "Mod",
			span,
			range: name,
			kind: "named",
			name,
			bindsLocally: true,
			conflict: GLOBAL,
			certainty: KNOWN,
		});
		expect(edges).toEqual([
			{
				...brings("System.Text", "System.Text"),
				conflict: { priority: 0, amongTransfers: "exclude", againstLocal: "localWins" },
			},
			brings("./Mod.psm1", "./Mod.psm1"),
			{ specifier: "System.Xml", span: "System.Xml", kind: "sideEffect", bindsLocally: false, certainty: KNOWN },
			{ ...brings("$PSScriptRoot/lib.ps1", ". $PSScriptRoot/lib.ps1"), kind: "injection", conflict: LATER },
			brings("Pester", "Pester"),
			brings("PSReadLine", "PSReadLine"),
			names("Get-A", "Get-A"),
			names("'Get-B'", "Get-B"),
			{ ...brings("Mod", "Get-C*"), selector: { kind: "pattern", glob: "Get-C*", caseInsensitive: true } },
			brings("Mod", "$names", RUNTIME),
			brings("Mod", "Mod", UNPROVED),
			brings("Mod", "Mod", RUNTIME),
			{ ...brings("Here", "Here"), conflict: LATER },
		]);
		expect(
			handlers.probeBatch({ files: [{ module: "x.ps1", contentHash: "h", text }], answer: ["x.ps1"] }),
		).toEqual({
			status: "unsupported",
		});
	});

	it("reads a manifest's modules as what it is made of, its required modules as effects, its scripts as injections", () => {
		const text = [
			"@{",
			"    RootModule = 'Mod.psm1'",
			"    NestedModules = @('A.psm1', 'B.psm1')",
			"    RequiredModules = @(@{ ModuleName = 'Req'; ModuleVersion = '1.0' })",
			"    ScriptsToProcess = 'init.ps1'",
			"}",
			"",
		].join("\n");
		const made = (specifier: string) => ({
			specifier,
			span: `'${specifier}'`,
			kind: "wildcard",
			bindsLocally: false,
			selector: VISIBLE,
			certainty: KNOWN,
		});
		const effect = (specifier: string) => ({
			specifier,
			span: `'${specifier}'`,
			kind: "sideEffect",
			bindsLocally: false,
			certainty: KNOWN,
		});
		expect(edgesOf("Mod.psd1", text).edges).toEqual([
			made("Mod.psm1"),
			made("A.psm1"),
			made("B.psm1"),
			effect("Req"),
			{ ...made("init.ps1"), kind: "injection" },
		]);
	});

	it("a path or module name only the run knows is unproved, a module imports into its own scope, and edges keep source order", () => {
		const text = [
			". $scriptPath",
			"Import-Module A, $name",
			"Import-Module Mod -Variable V -Function F",
			"Import-Module G -Global",
			"",
		].join("\n");
		const brings = (specifier: string, certainty: object) => ({
			specifier,
			span: specifier,
			kind: "wildcard",
			bindsLocally: true,
			selector: VISIBLE,
			conflict: LATER,
			certainty,
		});
		const names = (name: string) => ({
			specifier: "Mod",
			span: name,
			range: name,
			kind: "named",
			name,
			bindsLocally: true,
			conflict: LATER,
			certainty: KNOWN,
		});
		expect(edgesOf("x.psm1", text).edges).toEqual([
			{ ...brings("$scriptPath", RUNTIME), span: ". $scriptPath", kind: "injection" },
			brings("A", KNOWN),
			brings("$name", RUNTIME),
			names("V"),
			names("F"),
			{ ...brings("G", KNOWN), conflict: GLOBAL },
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
