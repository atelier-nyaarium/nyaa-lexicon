import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { coordinatesOf, type Range } from "@nyaa-lexicon/protocol";
import { parseBash } from "../extract.js";
import { BashProvider } from "../main.js";

const BOM = String.fromCodePoint(0xfeff);

function workspace(files: Record<string, string>): string {
	const root = mkdtempSync(path.join(os.tmpdir(), "bash-provider-"));
	for (const [file, text] of Object.entries(files)) {
		const absolute = path.join(root, file);
		mkdirSync(path.dirname(absolute), { recursive: true });
		writeFileSync(absolute, text);
	}
	return root;
}

function provider(files: Record<string, string>): BashProvider {
	const bash = new BashProvider();
	bash.initialize(workspace(files));
	return bash;
}

function sliceOf(text: string, range: Range): string | undefined {
	return coordinatesOf(text).sliceRange(range);
}

describe("declarations", () => {
	const text = [
		"#!/bin/bash",
		"LIMIT=3",
		"readonly ROOT=/srv",
		"export -x TOKEN=abc",
		"declare -a ITEMS=(a b)",
		"alias ll='ls -l'",
		"deploy() {",
		"\tlocal target=$1",
		"\tLIMIT=4",
		"\tcount=0",
		"}",
		"function retry { :; }",
		"for host in a b; do :; done",
		"",
	].join("\n");
	const parsed = parseBash("bin/deploy.sh", text);
	const byName = new Map(parsed.declarations.map((declaration) => [declaration.name, declaration]));

	test("functions, variables, constants, aliases, locals, and loop variables are declared once each", () => {
		expect(parsed.declarations.map((declaration) => declaration.name)).toEqual([
			"LIMIT",
			"ROOT",
			"TOKEN",
			"ITEMS",
			"ll",
			"deploy",
			"target",
			"count",
			"retry",
			"host",
		]);
		expect(byName.get("deploy")?.symbolId).toBe("lexicon bash bin/deploy.sh deploy().");
		expect(byName.get("LIMIT")?.symbolId).toBe("lexicon bash bin/deploy.sh LIMIT.");
		expect(byName.get("target")?.symbolId).toBe("lexicon bash bin/deploy.sh deploy().target.");
		expect(byName.get("target")?.containerId).toBe(byName.get("deploy")?.symbolId);
		expect(byName.get("target")?.visibility).toBe("local");
		// An assignment inside a function without `local` is the file's global.
		expect(byName.get("count")?.containerId).toBeUndefined();
		expect(byName.get("ROOT")?.kind).toBe("constant");
		expect(byName.get("TOKEN")?.exported).toBe(true);
		expect(byName.get("ITEMS")?.declaredType).toBe("array");
		expect(byName.get("ll")).toMatchObject({ kind: "function", languageKind: "alias" });
		expect(byName.get("retry")?.kind).toBe("function");
		expect(byName.get("deploy")?.metrics).toEqual({ lines: 5 });
	});

	test("a second assignment of a declared name is a write, not a second declaration", () => {
		const wire = provider({ "bin/deploy.sh": text }).parseFile({ module: "bin/deploy.sh", contentHash: "h", text });
		const writes = wire.references.filter((reference) => reference.role === "write");
		expect(writes).toEqual([
			{
				name: "LIMIT",
				range: { start: { line: 8, character: 1 }, end: { line: 8, character: 6 } },
				role: "write",
				binding: { status: "bound", symbolId: "lexicon bash bin/deploy.sh LIMIT.", provenance: "bound" },
				fromId: "lexicon bash bin/deploy.sh deploy().",
			},
		]);
		expect(wire.declarations.filter((declaration) => declaration.name === "LIMIT")).toHaveLength(1);
	});

	test("every selection range slices its own name back out", () => {
		for (const declaration of parsed.declarations) {
			expect(sliceOf(text, declaration.selectionRange as Range)).toBe(declaration.name);
		}
	});
});

describe("references and literals", () => {
	const text = [
		`greet() { echo "hello $NAME" "\${GREETING:-hi}" '# not $NAME' $'tab\\there'; }`,
		"NAME=world",
		"greet",
		"ls -l 42",
		`echo $HOME \${#NAME} $1 $?`,
		"",
	].join("\n");
	const parsed = parseBash("greet.sh", text);

	test("expansions read their variable, quoted text is a literal, and the two never overlap", () => {
		const reads = parsed.references.filter((reference) => reference.role === "read");
		expect(reads.map((reference) => reference.name)).toEqual(["NAME", "GREETING", "HOME", "NAME"]);
		for (const reference of reads) expect(sliceOf(text, reference.range)).toBe(reference.name);
		expect(parsed.literals.map((literal) => literal.value)).toEqual(["# not $NAME", "tab\there", "world", "42"]);
		expect(parsed.literals.find((literal) => literal.value === "42")).toMatchObject({ kind: "number", number: 42 });
		// A quoted literal's range spans its quotes, so the slice is the spelling and the value is the text.
		expect(parsed.literals.map((literal) => sliceOf(text, literal.range))).toEqual([
			"'# not $NAME'",
			"$'tab\\there'",
			"world",
			"42",
		]);
	});

	test("a call names a function of the file and a program is not a reference", () => {
		const calls = parsed.references.filter((reference) => reference.role === "call");
		expect(calls.map((reference) => [reference.name, reference.target !== undefined])).toEqual([
			["echo", false],
			["greet", true],
			["ls", false],
			["echo", false],
		]);
		const wire = provider({ "greet.sh": text }).parseFile({ module: "greet.sh", contentHash: "h", text });
		expect(
			wire.references.filter((reference) => reference.role === "call").map((reference) => reference.name),
		).toEqual(["greet"]);
		const home = wire.references.find((reference) => reference.name === "HOME");
		expect(home?.binding).toMatchObject({ status: "unbound", reason: "NotIndexed" });
		expect(wire.references.find((reference) => reference.name === "NAME")?.binding).toMatchObject({
			status: "bound",
		});
	});

	test("a use before the assignment still binds, since a function body runs later", () => {
		const first = parsed.references.find((reference) => reference.name === "NAME");
		expect(first?.target).toBe("lexicon bash greet.sh NAME.");
	});
});

describe("sourcing", () => {
	const lib = "helper() { :; }\nSHARED=1\n";
	const main = 'source ./lib.sh\n. /etc/profile\nsource "$HOME/rc"\nsource ./gone.sh\nhelper\necho $SHARED\n';
	const bash = provider({ "bin/main.sh": main, "bin/lib.sh": lib });
	const facts = bash.parseFile({ module: "bin/main.sh", contentHash: "h", text: main });

	test("each source is an import, resolved beside the file, external outside it, or unresolved", () => {
		expect(facts.imports.map((entry) => entry.specifier)).toEqual([
			"./lib.sh",
			"/etc/profile",
			'"$HOME/rc"',
			"./gone.sh",
		]);
		expect(bash.resolveImport({ fromModule: "bin/main.sh", specifier: "./lib.sh" })).toEqual({
			status: "resolved",
			module: "bin/lib.sh",
		});
		expect(bash.resolveImport({ fromModule: "bin/main.sh", specifier: "/etc/profile" })).toMatchObject({
			status: "external",
		});
		expect(bash.resolveImport({ fromModule: "bin/main.sh", specifier: '"$HOME/rc"' })).toMatchObject({
			status: "unresolved",
			reason: "RuntimeConstructed",
		});
		expect(bash.resolveImport({ fromModule: "bin/main.sh", specifier: "./gone.sh" })).toMatchObject({
			status: "unresolved",
		});
	});

	test("a function and a variable from the sourced file bind across the boundary", () => {
		const helper = facts.references.find((reference) => reference.name === "helper");
		expect(helper?.binding).toEqual({
			status: "bound",
			symbolId: "lexicon bash bin/lib.sh helper().",
			provenance: "bound",
		});
		expect(facts.references.find((reference) => reference.name === "SHARED")?.binding).toMatchObject({
			status: "bound",
			symbolId: "lexicon bash bin/lib.sh SHARED.",
		});
	});
});

describe("diagnostics, types, and positions", () => {
	test("a parse error is an error with its position, and an unclosed heredoc is bash's warning", () => {
		const broken = parseBash("a.sh", 'echo "unterminated\n');
		expect(broken.diagnostics).toHaveLength(1);
		expect(broken.diagnostics[0]).toMatchObject({ severity: "error", range: { start: { line: 0, character: 5 } } });

		const open = parseBash("b.sh", "cat <<EOF\nnever closed\n");
		expect(open.diagnostics.map((diagnostic) => diagnostic.severity)).toEqual(["warning"]);
		const closed = parseBash("c.sh", "cat <<EOF\nline $X\nEOF\necho done\n");
		expect(closed.diagnostics).toEqual([]);
		expect(closed.references.map((reference) => reference.name)).toEqual(["cat", "X", "echo"]);
	});

	test("two heredocs on one line take their own bodies, and a byte order mark shifts every range", () => {
		const two = parseBash("h.sh", "cat <<A <<B\na\nA\nb\nB\necho $Z\n");
		expect(two.literals.map((literal) => literal.value)).toEqual(["a\n", "b\n"]);
		expect(two.diagnostics).toEqual([]);
		const bom = `${BOM}X=1\necho $X\n`;
		const parsed = parseBash("bom.sh", bom);
		expect(parsed.declarations.map((declaration) => declaration.name)).toEqual(["X"]);
		expect(sliceOf(bom, parsed.declarations[0]?.selectionRange as Range)).toBe("X");
		expect(parsed.references.find((reference) => reference.role === "read")?.target).toBe("lexicon bash bom.sh X.");
	});

	test("arithmetic, read, declare -g, and export reach the variables they touch", () => {
		const text = [
			"echo $((X + 1))",
			"for ((i=0;i<3;i++)); do :; done",
			"read -r -p 'name: ' line",
			"f() { local Y=1; declare -g Y; export X; }",
			"",
		].join("\n");
		const parsed = parseBash("a.sh", text);
		const names = parsed.declarations.map((declaration) => `${declaration.name}:${declaration.visibility}`);
		// `export X` on a name never assigned still creates the exported variable, as bash does.
		expect(names).toEqual(["i:public", "line:public", "f:public", "Y:local", "Y:public", "X:public"]);
		const reads = parsed.references
			.filter((reference) => reference.role === "read")
			.map((reference) => reference.name);
		expect(reads).toEqual(["X", "i"]);
		const writes = parsed.references
			.filter((reference) => reference.role === "write")
			.map((reference) => reference.name);
		expect(writes).toEqual(["i"]);
		expect(parsed.declarations.find((declaration) => declaration.name === "X")?.exported).toBe(true);
		for (const reference of parsed.references) expect(sliceOf(text, reference.range)).toBe(reference.name);
	});

	test("declare says a type and every other variable is a string at run time", () => {
		const text = "declare -i COUNT=1\nNAME=x\nreadonly NAME\n";
		const bash = provider({ "t.sh": text });
		const facts = bash.parseFile({ module: "t.sh", contentHash: "h", text });
		expect(facts.literals.map((literal) => literal.value)).toEqual(["1", "x"]);
		expect(facts.declarations.find((declaration) => declaration.name === "NAME")?.kind).toBe("constant");
		expect(bash.typeOf({ symbolId: "lexicon bash t.sh COUNT." })).toMatchObject({
			status: "known",
			display: "integer",
		});
		expect(bash.typeOf({ symbolId: "lexicon bash t.sh NAME." })).toMatchObject({
			status: "unknown",
			reason: "DynamicallyTyped",
		});
		expect(bash.typeOf({ symbolId: "lexicon bash t.sh GONE." })).toMatchObject({
			status: "unknown",
			reason: "NotIndexed",
		});
	});

	test("a here-document body is a literal only when nothing in it expands, and <<- drops its tabs", () => {
		const text = [
			"cat <<EOF",
			"hello $NAME",
			"EOF",
			"cat <<'Q'",
			"kept $NAME",
			"Q",
			"cat <<-T",
			"\tone",
			"\t\ttwo",
			"\tT",
			"",
		].join("\n");
		const parsed = parseBash("h.sh", text);
		expect(parsed.references.filter((reference) => reference.role === "read").map((r) => r.name)).toEqual(["NAME"]);
		expect(parsed.literals.map((literal) => [literal.value, sliceOf(text, literal.range)])).toEqual([
			["kept $NAME\n", "kept $NAME\n"],
			["one\ntwo\n", "\tone\n\t\ttwo\n"],
		]);
		expect(parsed.diagnostics).toEqual([]);
	});

	test("bind answers for a reference or a declaration at a position", () => {
		const text = "f() { :; }\nf\n";
		const bash = provider({ "b.sh": text });
		bash.parseFile({ module: "b.sh", contentHash: "h", text });
		const at = (line: number, character: number) => ({ start: { line, character }, end: { line, character } });
		expect(bash.bind({ module: "b.sh", name: "f", range: at(1, 0) })).toMatchObject({
			status: "bound",
			symbolId: "lexicon bash b.sh f().",
		});
		expect(bash.bind({ module: "b.sh", name: "f", range: at(0, 0) })).toMatchObject({ status: "bound" });
		expect(bash.bind({ module: "b.sh", name: "g", range: at(1, 0) })).toMatchObject({ status: "unbound" });
	});
});

describe("scopes", () => {
	/** Each declaration as `id:visibility`, ids without the module prefix. */
	function shape(module: string, text: string) {
		const parsed = parseBash(module, text);
		const strip = (id: string) => id.replace(`lexicon bash ${module} `, "");
		return {
			declarations: parsed.declarations.map(
				(declaration) => `${strip(declaration.symbolId)}:${declaration.visibility}`,
			),
			references: parsed.references.map((reference) => [
				reference.name,
				reference.role,
				reference.target === undefined ? null : strip(reference.target),
			]),
			diagnostics: parsed.diagnostics.map((diagnostic) => diagnostic.message),
		};
	}

	test("a subshell and each side of a pipe keep their assignments; a brace group does not", () => {
		const text =
			"( SUB=1 ); echo $SUB\nPIPE=1 | cat\necho $PIPE\n{ BRACE=1; }; echo $BRACE\nf() ( X=1; )\necho $X\n";
		const shaped = shape("s.sh", text);
		expect(shaped.declarations).toEqual([
			"SUB.:local",
			"PIPE.:local",
			"BRACE.:public",
			"f().:public",
			"f().X.:local",
		]);
		expect(shaped.references.filter(([, role]) => role === "read")).toEqual([
			["SUB", "read", null],
			["PIPE", "read", null],
			["BRACE", "read", "BRACE."],
			["X", "read", null],
		]);
	});

	test("a read reaches the enclosing function's local until its own is declared", () => {
		const text = [
			"outer() {",
			"\tlocal O=outer",
			"\tinner() {",
			'\t\techo "$O"',
			"\t\tlocal O=inner",
			'\t\techo "$O"',
			"\t}",
			"\tinner",
			"}",
			"",
		].join("\n");
		expect(shape("n.sh", text).references.filter(([name]) => name === "O")).toEqual([
			["O", "read", "outer().O."],
			["O", "read", "inner().O."],
		]);
	});

	test("a function defined twice is two symbols, each with its own locals, and a call reaches the last", () => {
		const text = "f() { local x=1; echo $x; }\nf() { local x=2; echo $x; }\nf\ng() { f; }\n";
		const shaped = shape("d.sh", text);
		expect(shaped.declarations).toEqual([
			"f().:public",
			"f().x.:local",
			"f()[2].:public",
			"f()[2].x.:local",
			"g().:public",
		]);
		expect(shaped.references.filter(([name]) => name !== "echo")).toEqual([
			["x", "read", "f().x."],
			["x", "read", "f()[2].x."],
			["f", "call", "f()[2]."],
			["f", "call", "f()[2]."],
		]);
	});

	test("a top-level call reaches only a definition before it; a call in a function reaches any", () => {
		const shaped = shape("c.sh", "later\nlater() { :; }\nlater\ng() { later; }\nmy-func() { :; }\nmy-func\n");
		expect(shaped.references.filter(([, role]) => role === "call")).toEqual([
			["later", "call", null],
			["later", "call", "later()."],
			["later", "call", "later()."],
			["my-func", "call", "my-func()."],
		]);
	});

	test("declare -g and a function definition stay inside their subshell", () => {
		const shaped = shape(
			"g.sh",
			"( declare -g Y=2; f() { :; }; f )\necho $Y\nf\nfunction .hidden { :; }\n.hidden\n",
		);
		expect(shaped.declarations).toEqual(["Y.:local", "f().:local", "`.hidden`().:public"]);
		expect(shaped.references.filter(([name]) => name !== "echo")).toEqual([
			["f", "call", "f()."],
			["Y", "read", null],
			["f", "call", null],
			[".hidden", "call", "`.hidden`()."],
		]);
	});

	test("a nested function reaches the enclosing function's local wherever it was declared", () => {
		const shaped = shape("y.sh", "outer() {\n\tinner() { echo $DYN; }\n\tlocal DYN=1\n\tinner\n}\n");
		expect(shaped.references.filter(([name]) => name === "DYN")).toEqual([["DYN", "read", "outer().DYN."]]);
	});

	test("every assignment in a let word writes its name", () => {
		const shaped = shape("l.sh", 'let "a=1, b=2" c=d=3 e[1]++\n');
		expect(shaped.declarations).toEqual(["a.:public", "b.:public", "c.:public", "d.:public", "e.:public"]);
	});

	test("local outside a function is bash's error, and unset writes what it removes", () => {
		const shaped = shape("u.sh", "local TOP=bad\nNAME=1\nunset NAME\nunset -f gone\n");
		expect(shaped.diagnostics).toEqual(["local: can only be used in a function"]);
		expect(shaped.declarations).toEqual(["NAME.:public"]);
		expect(shaped.references).toEqual([
			["NAME", "write", "NAME."],
			["gone", "write", null],
		]);
	});

	test("special parameters, name listings, and subscripts read what bash reads", () => {
		const text = `echo "$_ $1 $0" \${!prefix*} \${!ARR[@]} \${ARR[i+1]} \${MAP[$k]} \${Y:=d}\nARR[j]=x\n`;
		const shaped = shape("p.sh", text);
		expect(shaped.declarations).toEqual(["Y.:public", "ARR.:public"]);
		expect(shaped.references.filter(([, role]) => role === "read").map(([name]) => name)).toEqual([
			"ARR",
			"ARR",
			"i",
			"MAP",
			"k",
			"j",
		]);
	});
});

describe("builtins that write", () => {
	test("printf -v, mapfile, readarray, getopts, let, read -a, and coproc name their variables", () => {
		const text = [
			'printf -v P "%s" v',
			"mapfile -t M",
			'readarray -d "" R',
			'getopts "ab:" OPT',
			'let "L = 1" LP++ ++LQ n',
			"read -a ARR",
			"coproc NAME { :; }",
			"",
		].join("\n");
		const parsed = parseBash("b.sh", text);
		expect(parsed.declarations.map((declaration) => [declaration.name, declaration.declaredType ?? null])).toEqual([
			["P", null],
			["M", "array"],
			["R", "array"],
			["OPT", null],
			["L", null],
			["LP", null],
			["LQ", null],
			["ARR", "array"],
			["NAME", "array"],
		]);
		expect(parsed.references.map((reference) => [reference.name, reference.role])).toEqual([["n", "read"]]);
		for (const declaration of parsed.declarations) {
			expect(sliceOf(text, declaration.selectionRange as Range)).toBe(declaration.name);
		}
	});

	test("printing and function forms of the declaring builtins declare nothing, and a nameref names its target", () => {
		const text = [
			"declare -p NAME",
			"export -n NAME",
			"export -f func",
			"declare 'QUOTED=v'",
			"alias -- -dash='x'",
			`f() { local -n ref=NAME; echo \${!ref}; }`,
			"",
		].join("\n");
		const bash = provider({ "d.sh": text });
		const facts = bash.parseFile({ module: "d.sh", contentHash: "h", text });
		expect(facts.declarations.map((declaration) => declaration.name)).toEqual(["QUOTED", "-dash", "f", "ref"]);
		expect(facts.references.map((reference) => [reference.name, reference.role, reference.binding.status])).toEqual(
			[
				["NAME", "read", "unbound"],
				["NAME", "read", "unbound"],
				["ref", "read", "bound"],
			],
		);
		expect(bash.typeOf({ symbolId: "lexicon bash d.sh f().ref." })).toMatchObject({
			status: "known",
			display: "name reference",
		});
	});
});

describe("comments", () => {
	const commentsOf = (text: string) => {
		const parsed = parseBash("c.sh", text);
		for (const comment of parsed.comments) expect(sliceOf(text, comment.range)).toBe(comment.text);
		return parsed.comments.map((comment) => comment.text);
	};

	test("a hash opens a comment only outside words, quotes, expansions, and heredoc bodies", () => {
		const text = [
			"#!/bin/bash",
			`a="# no" b='# no' c=$'# no' d=plain#no e="\${x#no}" f=$((2#101))`,
			'echo a#b "$(echo \'# no\')" `echo "# no"` @(x|#no) {a,#no} # yes one',
			"cat <<EOF # yes two",
			"# no",
			"EOF",
			"x=(",
			"\ta # yes three",
			")",
			"(( y = 2#101 ))",
			"for ((i=16#a; i<20; i++)); do :; done",
			"a#b() { :; }",
			"[[ $z == '#no' ]] # yes four",
			"",
		].join("\n");
		expect(commentsOf(text)).toEqual(["#!/bin/bash", "# yes one", "# yes two", "# yes three", "# yes four"]);
	});

	test("a substitution holds comments, a return is not comment text, and an unterminated string holds none", () => {
		expect(commentsOf('x="$(\n# inner\ntrue)"\n')).toEqual(["# inner"]);
		expect(commentsOf("# lead\r\necho x # tail\r\n")).toEqual(["# lead", "# tail"]);
		expect(commentsOf('echo "unterminated\n# after\n')).toEqual([]);
		expect(commentsOf("cat <<'#'\nbody\n#\necho done # yes\n")).toEqual(["# yes"]);
	});
});

describe("the wire face", () => {
	test("a CRLF file's ranges land on line content, and a value keeps the carriage return bash keeps", () => {
		const text = "X=1\r\nf() {\r\n\t:\r\n}\r\necho $X\r\n";
		const parsed = parseBash("crlf.sh", text);
		for (const declaration of parsed.declarations) {
			expect(sliceOf(text, declaration.selectionRange as Range)).toBe(declaration.name);
			expect(sliceOf(text, declaration.range)).toBeDefined();
		}
		expect(parsed.literals.map((literal) => [literal.value, sliceOf(text, literal.range)])).toEqual([["1\r", "1"]]);
	});

	test("a name sourced through a sourced file binds, and a file sourced twice is not ambiguous", () => {
		const files = {
			"main.sh": "source ./one.sh\nsource ./two.sh\necho $THIRD\n",
			"one.sh": "source ./third.sh\n",
			"two.sh": "source ./third.sh\nsource ./one.sh\n",
			"third.sh": "THIRD=1\n",
		};
		const facts = provider(files).parseFile({ module: "main.sh", contentHash: "h", text: files["main.sh"] });
		expect(facts.references.find((reference) => reference.name === "THIRD")?.binding).toMatchObject({
			status: "bound",
			symbolId: "lexicon bash third.sh THIRD.",
		});
	});

	test("discovery claims the extensions and the exact filenames, and skips what is not bash", () => {
		const root = workspace({
			"bin/run.sh": "",
			"lib/tools.bash": "",
			".bashrc": "",
			".zshrc": "",
			"node_modules/m/setup.sh": "",
			"README.md": "",
		});
		const project = new BashProvider().discoverProject(root);
		expect([...project.files].sort()).toEqual([".bashrc", "bin/run.sh", "lib/tools.bash"]);
		expect(project.diagnostics).toEqual([]);

		const missing = new BashProvider().discoverProject(path.join(root, "gone"));
		expect(missing.files).toEqual([]);
		expect(missing.diagnostics.map((diagnostic) => diagnostic.severity)).toEqual(["error"]);
	});

	test("rename and move are refused as not implemented", () => {
		const bash = provider({ "a.sh": "value=1\n" });
		const refused = { status: "refused", reason: "NotImplemented" };
		expect(
			bash.renameEdits({ module: "a.sh", text: "value=1\n", oldName: "value", newName: "next", sites: [] }),
		).toMatchObject(refused);
		expect(
			bash.moveEdits({
				module: "a.sh",
				text: "value=1\n",
				exists: true,
				symbolId: "lexicon bash a.sh value.",
				name: "value",
				fromModule: "a.sh",
				toModule: "b.sh",
				role: {},
				importSites: [],
				dependencies: [],
				sites: [],
			}),
		).toMatchObject(refused);
	});

	test("a declaring builtin's attribute is the type, and an assignment yields one literal unless it is an array", () => {
		const text = [
			"declare -A MAP=([a]=1)",
			"f() { local -i n=2; typeset -a LIST=(x y); }",
			"LIMIT=3",
			"X=1 true",
			"",
		].join("\n");
		const bash = provider({ "t.sh": text });
		const facts = bash.parseFile({ module: "t.sh", contentHash: "h", text });
		expect(facts.literals.map((literal) => literal.value)).toEqual(["2", "3", "1"]);
		const display = (symbolId: string) => bash.typeOf({ symbolId });
		expect(display("lexicon bash t.sh MAP.")).toMatchObject({ status: "known", display: "associative array" });
		expect(display("lexicon bash t.sh f().n.")).toMatchObject({ status: "known", display: "integer" });
		expect(display("lexicon bash t.sh f().LIST.")).toMatchObject({ status: "known", display: "array" });
		expect(display("lexicon bash t.sh LIMIT.")).toMatchObject({ status: "unknown", reason: "DynamicallyTyped" });
		expect(
			bash.typeOf({
				module: "t.sh",
				range: { start: { line: 0, character: 11 }, end: { line: 0, character: 11 } },
			}),
		).toMatchObject({ status: "known", display: "associative array" });
	});

	test("typeOf and bind answer for a file the daemon has not sent yet", () => {
		const bash = provider({ "late.sh": "declare -i N=1\n" });
		const at = { start: { line: 0, character: 11 }, end: { line: 0, character: 11 } };
		expect(bash.typeOf({ symbolId: "lexicon bash late.sh N." })).toMatchObject({
			status: "known",
			display: "integer",
		});
		expect(bash.bind({ module: "late.sh", name: "N", range: at })).toMatchObject({
			status: "bound",
			symbolId: "lexicon bash late.sh N.",
		});
		expect(bash.bind({ module: "absent.sh", name: "N", range: at })).toMatchObject({
			status: "unbound",
			reason: "NotIndexed",
		});
	});

	test("a name declared in the file wins over the same name in a sourced file", () => {
		const lib = "helper() { :; }\nSHARED=lib\n";
		const main = "source ./lib.sh\nhelper() { :; }\nhelper\nSHARED=main\necho $SHARED\n";
		const facts = provider({ "main.sh": main, "lib.sh": lib }).parseFile({
			module: "main.sh",
			contentHash: "h",
			text: main,
		});
		const bindings = facts.references
			.filter((reference) => reference.role !== "import")
			.map((reference) => [
				reference.name,
				reference.binding.status === "bound" ? reference.binding.symbolId : null,
			]);
		expect(bindings).toEqual([
			["helper", "lexicon bash main.sh helper()."],
			["SHARED", "lexicon bash main.sh SHARED."],
		]);
	});
});
