import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { handlersFor, type ImportResolution, PROTOCOL_VERSION } from "@nyaa-lexicon/protocol";
import { REFERENCE_ROLES, RustProvider, TIERS } from "../main.js";

const roots: string[] = [];

function client(provider: RustProvider) {
	const handlers = handlersFor(provider);
	return {
		handlers,
		initialize: (workspaceRoot: string) =>
			handlers.initialize({ workspaceRoot, protocolVersion: PROTOCOL_VERSION }),
		discoverProject: (workspaceRoot: string) => handlers.discoverProject({ workspaceRoot }),
		parseFile: (params: Parameters<typeof handlers.parseFile>[0]) => handlers.parseFile(params),
		resolveImport: (params: Parameters<typeof handlers.resolveImport>[0]) => handlers.resolveImport(params),
		bind: (params: Parameters<typeof handlers.bind>[0]) => handlers.bind(params),
		typeOf: (params: Parameters<typeof handlers.typeOf>[0]) => handlers.typeOf(params),
		renameEdits: (params: Parameters<typeof handlers.renameEdits>[0]) => handlers.renameEdits(params),
		moveEdits: (params: Parameters<typeof handlers.moveEdits>[0]) => handlers.moveEdits(params),
		forgetModule: (params: { module: string }) => handlers.forgetModule?.(params),
	};
}

function workspace(files: Record<string, string>): string {
	const root = mkdtempSync(path.join(tmpdir(), "lexicon-rust-provider-"));
	roots.push(root);
	for (const [module, text] of Object.entries(files)) {
		const full = path.join(root, module);
		mkdirSync(path.dirname(full), { recursive: true });
		writeFileSync(full, text);
	}
	return root;
}

function landed(module: string): ImportResolution {
	return { status: "resolved", landing: { kind: "module", module } };
}

function rangeAt(text: string, value: string, from = 0) {
	const start = text.indexOf(value, from);
	if (start < 0) throw new Error(`missing test text ${value}`);
	const lineParts = text.slice(0, start).split("\n");
	const line = lineParts.length - 1;
	const character = (lineParts.at(-1) ?? "").length;
	return { start: { line, character }, end: { line, character: character + value.length } };
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("discovers Rust files and excludes generated directories", () => {
	const root = workspace({
		"Cargo.toml": '[package]\nname = "demo"\nversion = "0.1.0"\n',
		"src/lib.rs": "pub mod util;\n",
		"src/util.rs": "pub struct Item;\n",
		"target/generated.rs": "pub struct Generated;\n",
		"node_modules/ignored.rs": "pub struct Ignored;\n",
	});
	const provider = client(new RustProvider());
	const info = provider.initialize(root);
	const model = provider.discoverProject(root);

	expect(info.language).toBe("rust");
	expect(info.extensions).toEqual([".rs"]);
	expect(info).not.toHaveProperty("filenames");
	expect(info.tiers).toEqual(TIERS);
	expect(info.referenceRoles).toEqual([...REFERENCE_ROLES]);
	expect(model.files).toEqual(["src/lib.rs", "src/util.rs"]);
	expect(model.configFiles).toEqual(["Cargo.toml"]);
	expect(model.diagnostics).toEqual([]);
	expect(provider.discoverProject(root).fingerprint).toBe(model.fingerprint);
	writeFileSync(
		path.join(root, "Cargo.toml"),
		'[package]\nname = "demo"\nversion = "0.1.0"\n\n[dependencies]\nserde = "1"\n',
	);
	expect(provider.discoverProject(root).fingerprint).not.toBe(model.fingerprint);
});

test("reports a main role for a known executable crate root", () => {
	const root = workspace({ "main.rs": "fn main() {}\n", "src/main.rs": "fn main() {}\n" });
	const provider = client(new RustProvider());
	provider.initialize(root);
	provider.discoverProject(root);

	for (const module of ["main.rs", "src/main.rs"]) {
		const text = "fn main() {}\n";
		const facts = provider.parseFile({ module, contentHash: module, text });
		const main = facts.declarations.find((declaration) => declaration.name === "main");

		if (main === undefined) throw new Error("main declaration missing");
		const role = { kind: "entry", how: "main", symbolId: main.symbolId } as const;
		expect(facts.role).toEqual(role);
		expect(provider.handlers.probeFile({ module, contentHash: `${module}-probe`, text }).role).toEqual(role);
	}
});

test("reports an entry for a discovered binary, an unknown role for another top-level main, and a library without one", () => {
	const root = workspace({
		"Cargo.toml": '[package]\nname = "demo"\nversion = "0.1.0"\n',
		"src/lib.rs": "pub fn add() {}\nmod child { fn main() {} }\nmod loose;\n",
		"src/loose.rs": "fn main() {}\n",
		"src/bin/tool.rs": "fn main() {}\n",
	});
	const provider = client(new RustProvider());
	provider.initialize(root);
	provider.discoverProject(root);

	expect(
		provider.parseFile({ module: "src/bin/tool.rs", contentHash: "tool", text: "fn main() {}\n" }).role,
	).toMatchObject({ kind: "entry", how: "main" });
	expect(provider.parseFile({ module: "src/loose.rs", contentHash: "loose", text: "fn main() {}\n" }).role).toEqual({
		kind: "unknown",
		reason: "NotImplemented",
	});
	expect(
		provider.parseFile({
			module: "src/lib.rs",
			contentHash: "lib",
			text: "pub fn add() {}\nmod child { fn main() {} }\n",
		}).role,
	).toEqual({ kind: "library" });
});

test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
	"skips unreadable directories during project discovery",
	() => {
		const root = workspace({ "src/lib.rs": "pub struct Visible;\n" });
		const unreadable = path.join(root, "locked");
		mkdirSync(unreadable);
		try {
			chmodSync(unreadable, 0o000);
			const provider = client(new RustProvider());
			const info = provider.initialize(root);

			expect(info.language).toBe("rust");
			expect(provider.discoverProject(root).files).toEqual(["src/lib.rs"]);
		} finally {
			chmodSync(unreadable, 0o700);
		}
	},
);

test("lands a named leaf where its name is looked up, a glob on what it opens, and a lone crate on its root", () => {
	const lib = "extern crate serde;\npub mod util;\nmod inner { pub fn helper() {} }\npub enum Color { Red }\n";
	const root = workspace({
		"Cargo.toml": '[package]\nname = "demo"\nversion = "0.1.0"\n\n[dependencies]\nserde = "1"\n',
		"src/lib.rs": lib,
		"src/util.rs": "pub mod nested;\npub struct Tool;\n",
		"src/util/nested.rs": "pub struct Item;\n",
	});
	const provider = client(new RustProvider());
	provider.initialize(root);
	provider.discoverProject(root);
	const facts = provider.parseFile({ module: "src/lib.rs", contentHash: "lib", text: lib });
	const resolve = (specifier: string, fromModule = "src/lib.rs") => provider.resolveImport({ fromModule, specifier });
	const scopeOf = (name: string): ImportResolution => {
		const scopeId = facts.declarations.find((declaration) => declaration.name === name)?.symbolId ?? name;
		expect(facts.scopeContributions?.some((scope) => scope.scopeId === scopeId)).toBe(true);
		return {
			status: "resolved",
			landing: { kind: "symbolScope", providerId: "rust-provider", scopeId, anchorSymbolId: scopeId },
		};
	};

	expect(resolve("crate::util")).toEqual(landed("src/lib.rs"));
	expect(resolve("crate::util::Tool")).toEqual(landed("src/util.rs"));
	expect(resolve("crate::util::nested::Item")).toEqual(landed("src/util/nested.rs"));
	expect(resolve("super::nested", "src/util/nested.rs")).toEqual(landed("src/util.rs"));
	expect(resolve("crate::util::*")).toEqual(landed("src/util.rs"));
	expect(resolve("self::util::nested::*")).toEqual(landed("src/util/nested.rs"));
	expect(resolve("crate::inner::helper")).toEqual(scopeOf("inner"));
	expect(resolve("crate::inner::*")).toEqual(scopeOf("inner"));
	expect(resolve("Color::Red")).toEqual(scopeOf("Color"));
	expect(resolve("self::Color::*")).toEqual(scopeOf("Color"));
	expect(resolve("serde")).toEqual({ status: "external", packageName: "serde" });
	// Through `extern crate serde`, which also binds the name.
	expect(resolve("serde::Serialize")).toEqual({ status: "external", packageName: "serde" });
	for (const specifier of ["crate::gone", "crate::util::Missing", "crate::inner::hidden"])
		expect(resolve(specifier)).toMatchObject({ status: "unresolved", reason: "NotIndexed" });
});

test("reads dependency names from Cargo.toml's tables, not its text", () => {
	const root = workspace({
		"Cargo.toml": `[package]
name = "demo"
description = """
[dependencies]
fake = "1"
"""

[dependencies] # runtime
serde = { version = "1",
  features = ["derive"] }
"quoted" = "1"
tokio.workspace = true

[dependencies.regex]
version = "1"

[target."cfg(unix)".dependencies]
libc = "0.2"

[dev-dependencies]
proptest = "1"
`,
		"src/lib.rs": "pub fn run() {}\n",
	});
	const provider = client(new RustProvider());
	provider.initialize(root);
	expect(provider.discoverProject(root).diagnostics).toEqual([]);
	const packageOf = (crate: string) => {
		const resolution = provider.resolveImport({ fromModule: "src/lib.rs", specifier: `${crate}::Item` });
		return resolution.status === "external" ? resolution.packageName : null;
	};

	expect(["serde", "quoted", "tokio", "regex", "libc", "proptest"].map(packageOf)).toEqual([
		"serde",
		"quoted",
		"tokio",
		"regex",
		"libc",
		"proptest",
	]);
	expect(["fake", "features", "version"].map(packageOf)).toEqual([null, null, null]);
});

test("reports a Cargo.toml it cannot read as TOML", () => {
	const root = workspace({
		"Cargo.toml": '[dependencies\nserde = "1"\n',
		"src/lib.rs": "pub fn run() {}\n",
	});
	const provider = client(new RustProvider());
	provider.initialize(root);

	expect(provider.discoverProject(root).diagnostics).toEqual([
		expect.objectContaining({ severity: "warning", path: "Cargo.toml" }),
	]);
});

test("binds direct imports across files, and a glob import by the name it supplies", () => {
	const root = workspace({
		"src/lib.rs": `pub mod util;
use crate::util::{Item, Other as Alias};
use crate::util::*;

fn run(value: Item) -> Alias {
    let local = value;
    helper();
    Item { value: local }
}
`,
		"src/util.rs": `pub struct Item { pub value: i32 }
pub struct Other;
pub fn helper() {}
`,
	});
	const provider = client(new RustProvider());
	provider.initialize(root);
	const source = readFileSync(path.join(root, "src/lib.rs"), "utf8");
	const facts = provider.parseFile({ module: "src/lib.rs", contentHash: "lib", text: source });
	const utilText = readFileSync(path.join(root, "src/util.rs"), "utf8");
	const utilFacts = provider.parseFile({ module: "src/util.rs", contentHash: "util", text: utilText });
	const itemReference = facts.references.find(
		(reference) => reference.name === "Item" && reference.range.start.line === 4,
	);
	const helperReference = facts.references.find(
		(reference) => reference.name === "helper" && reference.role === "call",
	);
	const itemDeclaration = utilFacts.declarations.find((declaration) => declaration.name === "Item");
	const aliasReference = facts.references.find(
		(reference) => reference.name === "Alias" && reference.role === "typeUse",
	);

	if (
		itemReference === undefined ||
		helperReference === undefined ||
		itemDeclaration === undefined ||
		aliasReference === undefined
	)
		throw new Error("import references missing");
	expect(itemReference.binding).toEqual({
		status: "bound",
		symbolId: expect.stringContaining("src/util.rs"),
		provenance: "bound",
	});
	expect(aliasReference.binding).toMatchObject({ status: "bound" });
	const helper = utilFacts.declarations.find((declaration) => declaration.name === "helper");
	expect(helperReference.binding).toMatchObject({ status: "bound", symbolId: helper?.symbolId });
	expect(provider.bind({ module: "src/lib.rs", name: "helper", range: helperReference.range })).toMatchObject({
		status: "bound",
	});
	const label = facts.references.find((reference) => reference.name === "value" && reference.range.start.line === 7);
	const field = utilFacts.declarations.find((declaration) => declaration.name === "value");
	expect(label).toMatchObject({ qualified: true, binding: { status: "bound", symbolId: field?.symbolId } });
	expect(provider.bind({ module: "src/lib.rs", name: "Item", range: itemReference.range })).toEqual({
		status: "bound",
		symbolId: itemDeclaration.symbolId,
		provenance: "bound",
	});
});

test("supplies a module glob's top-level items, not those of a same-named module inside it", () => {
	const root = workspace({
		"src/lib.rs": "mod util;\nuse crate::util::*;\nfn run() { top(); inner(); }\n",
		"src/util.rs": "pub mod util { pub fn inner() {} }\npub fn top() {}\n",
	});
	const provider = client(new RustProvider());
	provider.initialize(root);
	const text = (module: string) => readFileSync(path.join(root, module), "utf8");
	const util = provider.parseFile({ module: "src/util.rs", contentHash: "util", text: text("src/util.rs") });
	const lib = provider.parseFile({ module: "src/lib.rs", contentHash: "lib", text: text("src/lib.rs") });
	const bindingOf = (name: string) => lib.references.find((reference) => reference.name === name)?.binding;

	expect(bindingOf("top")).toMatchObject({
		status: "bound",
		symbolId: util.declarations.find((declaration) => declaration.name === "top")?.symbolId,
	});
	expect(bindingOf("inner")).toMatchObject({ status: "unbound" });
});

// Each call consults the glob, which asks whether lib.rs declares Token.
test("binds every call through a glob import of a costly sibling module", () => {
	const locals = Array.from({ length: 1500 }, (_, index) => `    let v${index} = ${index};`).join("\n");
	const calls = Array.from({ length: 1000 }, (_, index) => `        c${index}();`).join("\n");
	const root = workspace({
		"src/lib.rs": `mod glob;\npub enum Token { Literal }\nfn filler() {\n${locals}\n}\n`,
		"src/glob.rs": `mod tests {\n    use super::super::Token::*;\n    fn run() {\n        let token = Literal;\n${calls}\n    }\n}\n`,
	});
	const provider = client(new RustProvider());
	provider.initialize(root);
	const lib = provider.parseFile({
		module: "src/lib.rs",
		contentHash: "lib",
		text: readFileSync(path.join(root, "src/lib.rs"), "utf8"),
	});
	const glob = provider.parseFile({
		module: "src/glob.rs",
		contentHash: "glob",
		text: readFileSync(path.join(root, "src/glob.rs"), "utf8"),
	});
	const bindings = glob.references.filter((reference) => reference.role === "call").map((call) => call.binding);
	const variant = lib.declarations.find((declaration) => declaration.name === "Literal");

	expect(bindings).toHaveLength(1000);
	expect(new Set(bindings.map((binding) => JSON.stringify(binding)))).toEqual(new Set([JSON.stringify(bindings[0])]));
	expect(bindings[0]).toMatchObject({ status: "unbound", reason: "NotIndexed" });
	expect(glob.references.find((reference) => reference.name === "Literal")?.binding).toMatchObject({
		status: "bound",
		symbolId: variant?.symbolId,
	});
}, 5_000);

test("answers a base-module symbol import from the text the store holds", () => {
	const root = workspace({
		"src/lib.rs": "mod glob;\npub enum Token { Literal }\n",
		"src/glob.rs": "use super::Token;\n",
	});
	const provider = client(new RustProvider());
	provider.initialize(root);
	const ask = () => provider.resolveImport({ fromModule: "src/glob.rs", specifier: "super::Token" });

	expect(ask()).toEqual(landed("src/lib.rs"));
	writeFileSync(path.join(root, "src/lib.rs"), "mod glob;\npub enum Other { Literal }\n");
	expect(ask()).toEqual(landed("src/lib.rs"));
	provider.parseFile({
		module: "src/lib.rs",
		contentHash: "changed",
		text: "mod glob;\npub enum Other { Literal }\n",
	});
	expect(ask()).toMatchObject({ status: "unresolved", reason: "NotIndexed" });
});

test("answers every protocol method, including explicit refusals", () => {
	const provider = new RustProvider();
	const handlers = handlersFor(provider);
	const info = handlers.initialize({ workspaceRoot: "/workspace", protocolVersion: "1.0.0" });
	const rename = handlers.renameEdits({ module: "src/lib.rs", text: "", oldName: "a", newName: "b", sites: [] });
	const move = handlers.moveEdits({
		module: "src/lib.rs",
		text: "",
		exists: false,
		symbolId: "lexicon rust src/lib.rs a.",
		name: "a",
		fromModule: "src/lib.rs",
		toModule: "src/new.rs",
		role: {},
		importSites: [],
		dependencies: [],
		sites: [],
	});

	expect(info.language).toBe("rust");
	expect(rename).toMatchObject({ status: "refused", reason: "NotImplemented" });
	expect(move).toMatchObject({ status: "refused", reason: "NotImplemented" });
	expect(
		handlers.probeBatch({
			files: [{ module: "src/lib.rs", contentHash: "probe", text: "pub fn a() {}\n" }],
			answer: ["src/lib.rs"],
		}),
	).toEqual({ status: "unsupported" });
	expect(handlers.shutdown({})).toEqual({});
});

test("honors outline depth for declarations and imports only", () => {
	const provider = client(new RustProvider());
	provider.initialize("/workspace");
	const facts = provider.parseFile({
		module: "src/lib.rs",
		contentHash: "outline",
		depth: "outline",
		text: `use std::fmt::Display;
pub struct Item;
fn run(value: Item) {
    use std::io::Write;
    fn nested() {}
    let local = |x: u8| x;
    println!("value");
}
`,
	});
	const item = facts.declarations.find((declaration) => declaration.name === "Item");

	expect(facts.depth).toBe("outline");
	expect(item).toBeDefined();
	expect(facts.declarations.map((declaration) => declaration.name)).toEqual(["Item", "run", "nested"]);
	expect(facts.imports.map((entry) => entry.specifier)).toEqual(["std::fmt::Display", "std::io::Write"]);
	expect(facts.references).toEqual([]);
	expect(facts.literals).toEqual([]);
	if (item === undefined) throw new Error("outline declaration missing");
	expect(provider.typeOf({ symbolId: item.symbolId })).toMatchObject({ status: "unknown" });
});

test("reports outline syntax diagnostics", () => {
	const provider = client(new RustProvider());
	provider.initialize("/workspace");
	const facts = provider.parseFile({
		module: "src/broken.rs",
		contentHash: "outline-broken",
		depth: "outline",
		text: "pub fn broken(\n",
	});

	expect(facts.depth).toBe("outline");
	expect(facts.diagnostics.some((diagnostic) => diagnostic.severity === "error")).toBe(true);
	expect(facts.references).toEqual([]);
	expect(facts.literals).toEqual([]);
});

test("typeOf accepts a declaration range and reports unknown inputs honestly", () => {
	const root = workspace({ "src/lib.rs": "pub const LIMIT: i32 = 1;\n" });
	const provider = client(new RustProvider());
	provider.initialize(root);
	const text = readFileSync(path.join(root, "src/lib.rs"), "utf8");
	const facts = provider.parseFile({ module: "src/lib.rs", contentHash: "limit", text });
	const limit = facts.declarations.find((declaration) => declaration.name === "LIMIT");
	if (limit === undefined) throw new Error("constant declaration missing");

	expect(provider.typeOf({ module: "src/lib.rs", range: rangeAt(text, "LIMIT") })).toMatchObject({
		status: "known",
		display: "i32",
	});
	expect(
		provider.typeOf({
			module: "missing.rs",
			range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
		}),
	).toMatchObject({ status: "unknown", reason: "NotIndexed" });
	expect(provider.typeOf({ symbolId: limit.symbolId })).toEqual({
		status: "known",
		display: "i32",
		provenance: "declared",
	});
});

test("reads each target's own module tree, and a name in scope before a crate of that name", () => {
	const root = workspace({
		"Cargo.toml": '[package]\nname = "demo"\nversion = "0.1.0"\n\n[dependencies]\nfoo = "1"\ndep = "1"\n',
		"src/lib.rs": "pub mod util;\nmod foo;\nmod dep { pub struct Item; }\nfn run() { ::dep::Item; dep::Item; }\n",
		"src/foo.rs": "pub struct Local;\n",
		"src/util.rs": '#[path = "moved.rs"]\npub mod thing;\n',
		"src/moved.rs": "pub struct Thing;\n",
		"src/util/thing.rs": "pub struct Thing;\n",
		"src/main.rs": "mod cli;\nfn main() {}\n",
		"src/cli.rs": "pub struct Cli;\n",
		"src/bin/tool/main.rs": "mod helper;\nfn main() {}\n",
		"src/bin/tool/helper.rs": "pub struct Helper;\n",
		"tests/it.rs": "mod common;\n",
		"tests/common/mod.rs": "pub struct Common;\n",
	});
	const provider = client(new RustProvider());
	provider.initialize(root);
	provider.discoverProject(root);
	const resolve = (fromModule: string, specifier: string) => provider.resolveImport({ fromModule, specifier });

	expect(resolve("src/util.rs", "crate::util::thing::Thing")).toEqual(landed("src/moved.rs"));
	expect(resolve("src/cli.rs", "crate::cli::Cli")).toEqual(landed("src/cli.rs"));
	expect(resolve("src/cli.rs", "crate::util")).toMatchObject({ status: "unresolved" });
	expect(resolve("src/main.rs", "demo::util::thing::Thing")).toEqual(landed("src/moved.rs"));
	expect(resolve("src/bin/tool/helper.rs", "crate::helper::Helper")).toEqual(landed("src/bin/tool/helper.rs"));
	expect(resolve("tests/it.rs", "crate::common::Common")).toEqual(landed("tests/common/mod.rs"));
	expect(resolve("src/lib.rs", "foo::Local")).toEqual(landed("src/foo.rs"));
	expect(resolve("src/lib.rs", "::foo::Local")).toEqual({ status: "external", packageName: "foo" });
	const text = readFileSync(path.join(root, "src/lib.rs"), "utf8");
	const facts = provider.parseFile({ module: "src/lib.rs", contentHash: "lib", text });
	const items = facts.references
		.filter((reference) => reference.name === "Item")
		.map((reference) => reference.binding);
	expect(items).toMatchObject([
		{ status: "unbound", reason: "ExternalDependency" },
		{ status: "bound", symbolId: expect.stringContaining(" dep/Item#") },
	]);
	expect(
		provider.parseFile({ module: "src/bin/tool/main.rs", contentHash: "tool", text: "mod helper;\nfn main() {}\n" })
			.role,
	).toMatchObject({ kind: "entry" });
});

test("resolves only the files the module tree declares, beside files, in module directories or by path", () => {
	const root = workspace({
		"src/lib.rs": 'pub mod feature;\nmod inline {\n    #[path = "elsewhere.rs"]\n    pub mod moved;\n}\n',
		"src/feature/mod.rs": "pub mod item;\npub mod leaf;\npub struct Feature;\n",
		"src/feature/item.rs": "pub struct Item;\n",
		"src/feature/leaf.rs": "pub struct Leaf;\n",
		"src/feature/hidden.rs": "pub struct Hidden;\n",
		"src/inline/elsewhere.rs": "pub struct Moved;\n",
		"src/inline/moved.rs": "pub struct Moved;\n",
	});
	const provider = client(new RustProvider());
	provider.initialize(root);
	provider.discoverProject(root);

	expect(provider.resolveImport({ fromModule: "src/lib.rs", specifier: "crate::feature::*" })).toEqual(
		landed("src/feature/mod.rs"),
	);
	expect(provider.resolveImport({ fromModule: "src/feature/mod.rs", specifier: "self::item::Item" })).toEqual(
		landed("src/feature/item.rs"),
	);
	expect(provider.resolveImport({ fromModule: "src/feature/item.rs", specifier: "super::leaf::Leaf" })).toEqual(
		landed("src/feature/leaf.rs"),
	);
	expect(provider.resolveImport({ fromModule: "src/lib.rs", specifier: "feature::Feature" })).toEqual(
		landed("src/feature/mod.rs"),
	);
	expect(
		provider.resolveImport({ fromModule: "src/feature/mod.rs", specifier: "self::hidden::Hidden" }),
	).toMatchObject({
		status: "unresolved",
	});
	expect(provider.resolveImport({ fromModule: "src/lib.rs", specifier: "crate::inline::moved::Moved" })).toEqual(
		landed("src/inline/elsewhere.rs"),
	);
});

test("discovers multiple Cargo roots and resolves crate paths within the nearest root, never another crate's", () => {
	const root = workspace({
		"Cargo.toml":
			'[package]\nname = "tool"\nversion = "0.1.0"\nautotests = false\n\n[[bin]]\nname = "tool"\npath = "crates/core/main.rs"\n\n[workspace]\nmembers = ["crates/*"]\n',
		"crates/core/main.rs": "mod app;\n",
		"crates/core/app.rs": "pub struct App;\n",
		"tests/it.rs": "",
		"crates/one/Cargo.toml": '[package]\nname = "one-lib"\nversion = "0.1.0"\n\n[dependencies]\nwalkdir = "2"\n',
		"crates/one/src/lib.rs": "pub mod item;\n",
		"crates/one/src/item.rs": "pub struct One;\n",
		"crates/two/Cargo.toml":
			'[package]\nname = "two"\nversion = "0.1.0"\n\n[lib]\nname = "second"\n\n[dependencies]\nfirst = { package = "one-lib", path = "../one" }\nwalkdir = "2"\n',
		"crates/two/src/lib.rs": "pub mod item;\n",
		"crates/two/src/item.rs": "pub struct Two;\n",
		"crates/two/target/ignored.rs": "pub struct Ignored;\n",
	});
	const provider = client(new RustProvider());
	const info = provider.initialize(root);
	const model = provider.discoverProject(root);

	expect(info.language).toBe("rust");
	expect(model.files).toContain("crates/one/src/lib.rs");
	expect(model.files).toContain("crates/two/src/lib.rs");
	expect(model.files).not.toContain("crates/two/target/ignored.rs");
	expect(model.configFiles).toEqual(["Cargo.toml", "crates/one/Cargo.toml", "crates/two/Cargo.toml"]);
	expect(provider.resolveImport({ fromModule: "crates/two/src/lib.rs", specifier: "first::item::*" })).toEqual(
		landed("crates/one/src/item.rs"),
	);
	expect(provider.resolveImport({ fromModule: "crates/two/src/lib.rs", specifier: "first" })).toEqual(
		landed("crates/one/src/lib.rs"),
	);
	for (const [fromModule, specifier] of [
		["crates/two/src/lib.rs", "one_lib::item"],
		["crates/one/src/lib.rs", "second::item"],
	] as const)
		expect(provider.resolveImport({ fromModule, specifier })).toMatchObject({ status: "unresolved" });
	expect(provider.resolveImport({ fromModule: "crates/two/src/lib.rs", specifier: "walkdir::WalkDir" })).toEqual({
		status: "external",
		packageName: "walkdir",
	});
	const one = provider.parseFile({ module: "crates/one/src/item.rs", contentHash: "one", text: "pub struct One;\n" });
	const two = provider.parseFile({
		module: "crates/two/src/lib.rs",
		contentHash: "two",
		text: "pub mod item;\nfn f(x: first::item::One, w: walkdir::DirEntry) { w.path(); }\n",
	});
	const bindingOf = (name: string) => two.references.find((reference) => reference.name === name)?.binding;
	expect(bindingOf("One")).toMatchObject({ symbolId: one.declarations[0]?.symbolId });
	expect(bindingOf("path")).toMatchObject({ status: "unbound", reason: "ExternalDependency" });
	expect(provider.resolveImport({ fromModule: "crates/two/src/lib.rs", specifier: "crate::item::*" })).toEqual(
		landed("crates/two/src/item.rs"),
	);
	expect(provider.resolveImport({ fromModule: "crates/core/app.rs", specifier: "crate::app::App" })).toEqual(
		landed("crates/core/app.rs"),
	);
	expect(provider.resolveImport({ fromModule: "tests/it.rs", specifier: "crate::item" })).toMatchObject({
		status: "unresolved",
	});
});

test("reports standard and Cargo dependency roots as external", () => {
	const root = workspace({
		"Cargo.toml": `[package]
name = "demo"
version = "0.1.0"

[dependencies]
serde = "1"

[dev-dependencies]
pretty_assertions = "1"

[build-dependencies]
cc = "1"
grep-searcher = { path = "crates/searcher" }
`,
		"src/lib.rs": "",
	});
	const provider = client(new RustProvider());
	provider.initialize(root);
	provider.discoverProject(root);

	for (const [specifier, packageName] of [
		["std::fmt", "std"],
		["serde::Serialize", "serde"],
		["pretty_assertions::assert_eq", "pretty_assertions"],
		["cc::Build", "cc"],
		["grep_searcher::Searcher", "grep_searcher"],
		["::std::io::{self, Read}", "std"],
	] as const) {
		expect(provider.resolveImport({ fromModule: "src/lib.rs", specifier })).toEqual({
			status: "external",
			packageName,
		});
	}
});

test("binds parameters and locals in their containing function", () => {
	const root = workspace({
		"src/lib.rs": `pub fn run(mut value: i32) {
    let local = value;
    value = local;
}
`,
	});
	const provider = client(new RustProvider());
	provider.initialize(root);
	const text = readFileSync(path.join(root, "src/lib.rs"), "utf8");
	const facts = provider.parseFile({ module: "src/lib.rs", contentHash: "scope", text });
	const writes = facts.references.filter((reference) => reference.name === "value" && reference.role === "write");
	const localRead = facts.references.find((reference) => reference.name === "local" && reference.role === "read");
	const parameter = facts.declarations.find(
		(declaration) => declaration.name === "value" && declaration.languageKind === "parameter",
	);
	const local = facts.declarations.find((declaration) => declaration.name === "local");

	if (writes.length !== 1 || localRead === undefined || parameter === undefined || local === undefined)
		throw new Error("scope facts missing");
	expect(writes[0]?.binding).toEqual({
		status: "bound",
		symbolId: parameter.symbolId,
		provenance: "bound",
	});
	expect(localRead.binding).toEqual({ status: "bound", symbolId: local.symbolId, provenance: "bound" });
	expect(provider.bind({ module: "src/lib.rs", name: "local", range: localRead.range })).toEqual({
		status: "bound",
		symbolId: local.symbolId,
		provenance: "bound",
	});
});

test("binds qualified methods and members through a same-file type, an imported one, its aliases and its impls anywhere", () => {
	const root = workspace({
		"Cargo.toml": '[package]\nname = "demo"\nversion = "0.1.0"\n',
		"src/lib.rs": `pub mod util;
pub mod extra;
use crate::util::{External, Alias};
struct Local;
impl Local { fn make() -> Self { Local } }
fn run(alias: Alias) { Local::make(); External::make(); alias.more(); Alias::make(); alias.renamed(); }
`,
		"src/util.rs": `pub struct External;
impl External { pub fn make() -> Self { External } }
pub type Inner = External;
pub type Alias = Inner;
`,
		"src/extra.rs": `use crate::util::External;
use crate::util::External as Renamed;
impl External { pub fn more(&self) {} }
impl Renamed { pub fn renamed(&self) {} }
`,
	});
	const provider = client(new RustProvider());
	provider.initialize(root);
	provider.discoverProject(root);
	const lib = readFileSync(path.join(root, "src/lib.rs"), "utf8");
	const util = readFileSync(path.join(root, "src/util.rs"), "utf8");
	const extra = readFileSync(path.join(root, "src/extra.rs"), "utf8");
	provider.parseFile({ module: "src/util.rs", contentHash: "external", text: util });
	const impls = provider.parseFile({ module: "src/extra.rs", contentHash: "extra", text: extra });
	const facts = provider.parseFile({ module: "src/lib.rs", contentHash: "qualified", text: lib });
	const bindings = (name: string) =>
		facts.references.filter((reference) => reference.name === name).map((reference) => reference.binding);
	const idIn = (declarations: typeof facts.declarations, name: string) =>
		declarations.find((declaration) => declaration.name === name)?.symbolId;
	const [local, external, aliased] = bindings("make");

	expect(local).toMatchObject({ symbolId: idIn(facts.declarations, "make") });
	expect(external).toMatchObject({ status: "bound" });
	expect(external).not.toEqual(local);
	expect(aliased).toEqual(external);
	expect(bindings("more")).toMatchObject([{ symbolId: idIn(impls.declarations, "more") }]);
	expect(bindings("renamed")).toMatchObject([{ symbolId: idIn(impls.declarations, "renamed") }]);
});

// The container id would name nothing in this parse, which the core refuses to store.
test("contains every impl item in its impl block, wherever the type is declared", () => {
	const root = workspace({
		"src/lib.rs": `pub mod util;
use crate::util::External;
struct Local;
impl Local { fn make() -> Self { Local } }
impl External {
    fn extra(&self) {}
}
impl Later { fn early(&self) { self.late() } }
impl Later { fn late(&self) {} }
struct Later;
`,
		"src/util.rs": "pub struct External;\n",
	});
	const provider = client(new RustProvider());
	provider.initialize(root);
	const lib = readFileSync(path.join(root, "src/lib.rs"), "utf8");
	const facts = provider.parseFile({ module: "src/lib.rs", contentHash: "foreign-impl", text: lib });
	const named = (name: string) => facts.declarations.find((declaration) => declaration.name === name);
	const impls = facts.declarations.filter((declaration) => declaration.languageKind === "impl");
	const late = facts.references.find((reference) => reference.name === "late");

	expect(impls.map((declaration) => declaration.name)).toEqual([
		"impl Local",
		"impl External",
		"impl Later",
		"impl Later",
	]);
	expect(new Set(impls.map((declaration) => declaration.symbolId)).size).toBe(4);
	expect(
		impls.every((declaration) => declaration.kind === "namespace" && declaration.containerId === undefined),
	).toBe(true);
	expect(named("make")?.containerId).toBe(impls[0]?.symbolId);
	expect(named("extra")?.containerId).toBe(impls[1]?.symbolId);
	expect(named("extra")?.symbolId).toContain("External#extra");
	expect(impls[1]?.memberInsertLine).toBe(6);
	expect(named("late")?.containerId).toBe(impls[3]?.symbolId);
	expect(late?.binding).toMatchObject({ status: "bound", symbolId: named("late")?.symbolId });
});

test("returns explicit reasons for external, missing, and runtime constructed bindings", () => {
	const root = workspace({
		"src/lib.rs": `use std::fmt::Display;
use crate::missing::Gone;
fn run() { println!("value"); }
`,
	});
	const provider = client(new RustProvider());
	provider.initialize(root);
	const text = readFileSync(path.join(root, "src/lib.rs"), "utf8");
	const facts = provider.parseFile({ module: "src/lib.rs", contentHash: "reasons", text });
	const display = facts.references.find((reference) => reference.name === "Display" && reference.role === "import");
	const gone = facts.references.find((reference) => reference.name === "Gone" && reference.role === "import");
	const println = facts.references.find((reference) => reference.name === "println" && reference.role === "call");

	expect(display?.binding).toMatchObject({ status: "unbound", reason: "ExternalDependency" });
	expect(gone?.binding).toMatchObject({ status: "unbound", reason: "NotIndexed" });
	expect(println?.binding).toMatchObject({ status: "unbound", reason: "RuntimeConstructed" });
});

test("answers declared, inferred, literal, and unresolved type queries", () => {
	const root = workspace({
		"src/lib.rs": `struct Cart;
fn build() -> Cart { Cart }
const COUNT: i32 = 1;
const NAME = "cart";
fn run() { let flag = true; let value = build(); }
`,
	});
	const provider = client(new RustProvider());
	provider.initialize(root);
	const text = readFileSync(path.join(root, "src/lib.rs"), "utf8");
	const facts = provider.parseFile({ module: "src/lib.rs", contentHash: "types", text });
	const cart = facts.declarations.find((declaration) => declaration.name === "Cart");
	const build = facts.declarations.find((declaration) => declaration.name === "build");
	const count = facts.declarations.find((declaration) => declaration.name === "COUNT");
	const name = facts.declarations.find((declaration) => declaration.name === "NAME");
	const flag = facts.declarations.find((declaration) => declaration.name === "flag");

	if (cart === undefined || build === undefined || count === undefined || name === undefined || flag === undefined)
		throw new Error("type declarations missing");
	expect(provider.typeOf({ symbolId: build.symbolId })).toMatchObject({ status: "known", display: "fn() -> Cart" });
	expect(provider.typeOf({ symbolId: count.symbolId })).toMatchObject({ status: "known", display: "i32" });
	expect(provider.typeOf({ symbolId: name.symbolId })).toMatchObject({ status: "inferred", display: "&str" });
	expect(provider.typeOf({ symbolId: flag.symbolId })).toMatchObject({ status: "inferred", display: "bool" });
	expect(provider.typeOf({ symbolId: cart.symbolId })).toMatchObject({ status: "unknown", reason: "NotImplemented" });
});

test("rejects a module path outside the workspace without reading it", () => {
	const provider = client(new RustProvider());
	provider.initialize("/workspace");

	expect(
		provider.bind({
			module: "../outside.rs",
			name: "Thing",
			range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
		}),
	).toEqual({ status: "unbound", reason: "NotIndexed", detail: "module is not indexed" });
	expect(
		provider.typeOf({
			module: "../outside.rs",
			range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
		}),
	).toEqual({ status: "unknown", reason: "NotIndexed", detail: "module is not indexed" });
});

test("wires handlers to the same provider instance", () => {
	const root = workspace({ "src/lib.rs": "pub fn add() {}\n" });
	const provider = new RustProvider();
	const handlers = handlersFor(provider);
	const initialized = handlers.initialize({ workspaceRoot: root, protocolVersion: "1.0.0" });
	const discovered = handlers.discoverProject({ workspaceRoot: root });
	const parsed = handlers.parseFile({ module: "src/lib.rs", contentHash: "handlers", text: "pub fn add() {}\n" });
	const add = parsed.declarations.find((declaration) => declaration.name === "add");

	if (add === undefined) throw new Error("handler declaration missing");
	expect(initialized.providerId).toBe("rust-provider");
	expect(discovered.files).toEqual(["src/lib.rs"]);
	expect(parsed.references).toEqual([]);
	expect(
		handlers.bind({
			module: "src/lib.rs",
			name: "add",
			range: add.selectionRange as NonNullable<typeof add.selectionRange>,
		}),
	).toEqual({ status: "bound", symbolId: add.symbolId, provenance: "bound" });
	expect(handlers.typeOf({ symbolId: add.symbolId })).toMatchObject({ status: "known" });
	expect(handlers.resolveImport({ fromModule: "src/lib.rs", specifier: "crate::missing" })).toMatchObject({
		status: "unresolved",
	});
});

test("reports an honest project diagnostic for missing roots", () => {
	const provider = client(new RustProvider());
	const missing = path.join(tmpdir(), "rust-provider-root-does-not-exist");

	const model = provider.discoverProject(missing);

	expect(model.files).toEqual([]);
	expect(model.configFiles).toEqual([]);
	expect(model.externalRoots).toEqual([]);
	expect(model.diagnostics).toHaveLength(1);
	expect(model.diagnostics[0]).toMatchObject({ severity: "error", path: missing });
});

test("keeps Cargo.lock in the project model and excludes all generated roots", () => {
	const root = workspace({
		"Cargo.toml": '[package]\nname = "demo"\nversion = "0.1.0"\n',
		"Cargo.lock": "version = 3\n",
		"src/lib.rs": "",
		".git/objects/generated.rs": "pub struct Git;\n",
		".idea/generated.rs": "pub struct Idea;\n",
		"vendor/generated.rs": "pub struct Vendor;\n",
		"node_modules/generated.rs": "pub struct Node;\n",
		"src/ok.rs": "pub struct Ok;\n",
	});
	const provider = client(new RustProvider());
	const model = provider.discoverProject(root);

	expect(model.configFiles).toEqual(["Cargo.toml", "Cargo.lock"]);
	expect(model.files).toEqual(["src/lib.rs", "src/ok.rs"]);
	expect(model.diagnostics).toEqual([]);
});

test("forwards a re-exporting use declaration and keeps visibility distinctions", () => {
	const root = workspace({
		"src/lib.rs": `pub struct Item;
pub use crate::item::Other;
pub(crate) fn internal() {}
pub(super) const LIMIT: i32 = 1;
fn private() {}
`,
		"src/item.rs": "pub struct Other;\n",
	});
	const provider = client(new RustProvider());
	provider.initialize(root);
	const text = readFileSync(path.join(root, "src/lib.rs"), "utf8");
	const facts = provider.parseFile({ module: "src/lib.rs", contentHash: "visibility", text });
	const item = facts.declarations.find((declaration) => declaration.name === "Item");
	const internal = facts.declarations.find((declaration) => declaration.name === "internal");
	const limit = facts.declarations.find((declaration) => declaration.name === "LIMIT");
	const privateDeclaration = facts.declarations.find((declaration) => declaration.name === "private");

	if (item === undefined || internal === undefined || limit === undefined || privateDeclaration === undefined)
		throw new Error("visibility declarations missing");
	expect(item.visibility).toBe("public");
	expect(item.exported).toBe(true);
	expect(internal.visibility).toBe("internal");
	expect(internal.exported).toBe(true);
	expect(limit.visibility).toBe("internal");
	expect(limit.exported).toBe(true);
	expect(privateDeclaration.visibility).toBe("private");
	expect(privateDeclaration.exported).toBe(false);
	expect(facts.exports?.find((edge) => edge.name === "Other")).toMatchObject({
		form: "forward",
		target: { kind: "import", span: facts.imports[0]?.edges[0]?.span },
	});
});

test("resolves a declared type symbol from a return annotation", () => {
	const root = workspace({
		"src/lib.rs": `pub struct Cart;
pub fn build() -> Cart { Cart }
`,
	});
	const provider = client(new RustProvider());
	provider.initialize(root);
	const text = readFileSync(path.join(root, "src/lib.rs"), "utf8");
	const facts = provider.parseFile({ module: "src/lib.rs", contentHash: "return", text });
	const cart = facts.declarations.find((declaration) => declaration.name === "Cart");
	const build = facts.declarations.find((declaration) => declaration.name === "build");

	if (cart === undefined || build === undefined) throw new Error("return declarations missing");
	expect(provider.typeOf({ symbolId: build.symbolId })).toEqual({
		status: "known",
		display: "fn() -> Cart",
		symbolId: cart.symbolId,
		provenance: "declared",
	});
});

test("returns a parse error for an empty import specifier and refuses edits by reason", () => {
	const provider = client(new RustProvider());
	provider.initialize("/workspace");

	expect(provider.resolveImport({ fromModule: "src/lib.rs", specifier: "" })).toEqual({
		status: "unresolved",
		reason: "ParseError",
		detail: "the import path is empty",
	});
	expect(
		provider.renameEdits({
			module: "src/lib.rs",
			text: "fn old() {}",
			oldName: "old",
			newName: "new",
			sites: [],
		}),
	).toEqual({
		status: "refused",
		reason: "NotImplemented",
		detail: "Rust rename edits are not implemented",
	});
	expect(
		provider.moveEdits({
			module: "src/lib.rs",
			text: "",
			exists: false,
			symbolId: "lexicon rust src/lib.rs old().",
			name: "old",
			fromModule: "src/lib.rs",
			toModule: "src/new.rs",
			role: {},
			importSites: [],
			dependencies: [],
			sites: [],
		}),
	).toMatchObject({ status: "refused", reason: "NotImplemented" });
});

const CART = "pub fn add(left: i32, right: i32) -> i32 { left + right }\n";
const LIB = "mod cart;\nuse crate::cart::add;\n\npub fn run() -> i32 { add(1, 2) }\n";

/** Where `add` lands in `run`, reparsing the user each time. */
function callsAdd(provider: ReturnType<typeof client>): string | undefined {
	const facts = provider.parseFile({ module: "src/lib.rs", contentHash: "lib", text: LIB });
	const call = facts.references.find((candidate) => candidate.name === "add" && candidate.role === "call");
	return call?.binding.status === "bound" ? call.binding.symbolId : undefined;
}

/** The type of what `run`'s call to `add` binds into. */
function addType(provider: ReturnType<typeof client>): string | undefined {
	const symbolId = callsAdd(provider);
	const type = symbolId === undefined ? undefined : provider.typeOf({ symbolId });
	return type?.status === "known" ? type.display : undefined;
}

function cartWorkspace(): ReturnType<typeof client> {
	const root = workspace({ "src/cart.rs": CART, "src/lib.rs": LIB });
	const provider = client(new RustProvider());
	provider.initialize(root);
	return provider;
}

/** The index's verdict on a parse, through the kit as the wire delivers it. */
function verdict(provider: ReturnType<typeof client>, module: string, contentHash: string, refusal?: string): void {
	provider.handlers.moduleAdmission?.({
		module,
		contentHash,
		outcome: refusal === undefined ? { status: "admitted" } : { status: "refused", reason: refusal },
	});
}

/** Parses through the kit and settles the index's verdict on it. */
function settle(
	provider: ReturnType<typeof client>,
	module: string,
	text: string,
	contentHash: string,
	refusal?: string,
): void {
	provider.handlers.parseFile({ module, contentHash, text });
	verdict(provider, module, contentHash, refusal);
}

test("stops binding into a module the index forgot, and binds again once a parse is admitted", () => {
	const provider = cartWorkspace();
	settle(provider, "src/cart.rs", CART, "cart");
	expect(callsAdd(provider)).toBe("lexicon rust src/cart.rs add().");

	provider.forgetModule({ module: "src/cart.rs" });
	expect(callsAdd(provider)).toBeUndefined();

	settle(provider, "src/cart.rs", CART, "cart-2");
	expect(callsAdd(provider)).toBe("lexicon rust src/cart.rs add().");
});

test("holds nothing for a module whose first parse the index refused", () => {
	const provider = cartWorkspace();
	settle(provider, "src/cart.rs", CART, "cart", "an id the index could not read");

	expect(callsAdd(provider)).toBeUndefined();
});

test("answers a probe from the candidate, then binds into what the index holds, never the candidate or the disk", () => {
	const disk = "pub fn add() -> u8 { 0 }\n";
	const root = workspace({ "src/cart.rs": CART, "src/lib.rs": LIB });
	const provider = client(new RustProvider());
	provider.initialize(root);
	const handlers = provider.handlers;
	settle(provider, "src/cart.rs", CART, "cart-1");
	// The file changed on disk and its parse is outstanding across the probe.
	writeFileSync(path.join(root, "src/cart.rs"), disk);
	handlers.parseFile({ module: "src/cart.rs", contentHash: "cart-2", text: disk });
	const probed = handlers.probeFile({ module: "src/cart.rs", contentHash: "probe", text: "pub fn probed() {}\n" });
	const outstanding = addType(provider);
	verdict(provider, "src/cart.rs", "cart-2", "refused");

	expect({
		candidate: probed.declarations.map((declaration) => declaration.name),
		outstanding,
		settled: addType(provider),
	}).toEqual({ candidate: ["probed"], outstanding: "fn() -> u8", settled: "fn(i32, i32) -> i32" });
});

test("lets a new workspace fill a module the previous one withheld", () => {
	const root = workspace({ "src/cart.rs": CART, "src/lib.rs": LIB });
	const provider = client(new RustProvider());
	provider.initialize(root);
	provider.forgetModule({ module: "src/cart.rs" });
	expect(callsAdd(provider)).toBeUndefined();

	provider.initialize(root);

	expect(callsAdd(provider)).toBe("lexicon rust src/cart.rs add().");
});

test("resolves a base-module symbol import against what the index holds, not the disk", () => {
	const root = workspace({
		"src/lib.rs": "mod glob;\npub enum Token { Literal }\n",
		"src/glob.rs": "use super::Token;\n",
	});
	const provider = client(new RustProvider());
	provider.initialize(root);
	const ask = () => provider.resolveImport({ fromModule: "src/glob.rs", specifier: "super::Token" });
	const token = "mod glob;\npub enum Token { Literal }\n";

	expect(ask()).toEqual(landed("src/lib.rs"));

	provider.forgetModule({ module: "src/lib.rs" });
	expect(ask()).toMatchObject({ status: "unresolved", reason: "NotIndexed" });

	settle(provider, "src/lib.rs", token, "lib");
	expect(ask()).toEqual(landed("src/lib.rs"));

	settle(provider, "src/lib.rs", token, "lib-2", "an id the index could not read");
	expect(ask()).toEqual(landed("src/lib.rs"));
});
