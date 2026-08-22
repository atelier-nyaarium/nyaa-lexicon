import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { handlersFor, REFERENCE_ROLES, RustProvider, TIERS } from "../main.js";

const roots: string[] = [];

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
	const provider = new RustProvider();
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
});

test("skips unreadable directories during project discovery", ({ skip }) => {
	if (process.platform === "win32" || process.getuid?.() === 0) {
		skip();
		return;
	}
	const root = workspace({ "src/lib.rs": "pub struct Visible;\n" });
	const unreadable = path.join(root, "locked");
	mkdirSync(unreadable);
	try {
		chmodSync(unreadable, 0o000);
		const provider = new RustProvider();
		const info = provider.initialize(root);

		expect(info.language).toBe("rust");
		expect(provider.discoverProject(root).files).toEqual(["src/lib.rs"]);
	} finally {
		chmodSync(unreadable, 0o700);
	}
});

test("resolves Rust module paths and distinguishes external crates", () => {
	const root = workspace({
		"Cargo.toml": '[package]\nname = "demo"\nversion = "0.1.0"\n\n[dependencies]\nserde = "1"\n',
		"src/lib.rs": "pub mod util;\n",
		"src/util.rs": "pub mod nested;\n",
		"src/util/nested.rs": "pub struct Item;\n",
	});
	const provider = new RustProvider();
	provider.initialize(root);
	provider.discoverProject(root);

	expect(provider.resolveImport({ fromModule: "src/lib.rs", specifier: "crate::util" })).toEqual({
		status: "resolved",
		module: "src/util.rs",
	});
	expect(provider.resolveImport({ fromModule: "src/lib.rs", specifier: "crate::util::nested::Item" })).toEqual({
		status: "resolved",
		module: "src/util/nested.rs",
	});
	expect(provider.resolveImport({ fromModule: "src/util/nested.rs", specifier: "super::nested" })).toEqual({
		status: "resolved",
		module: "src/util/nested.rs",
	});
	expect(provider.resolveImport({ fromModule: "src/lib.rs", specifier: "serde::Serialize" })).toEqual({
		status: "external",
		packageName: "serde",
	});
	expect(provider.resolveImport({ fromModule: "src/lib.rs", specifier: "crate::gone" })).toMatchObject({
		status: "unresolved",
		reason: "NotIndexed",
	});
});

test("binds direct imports across files and makes glob bindings ambiguous", () => {
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
	const provider = new RustProvider();
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
	expect(helperReference.binding.status).toBe("ambiguous");
	expect(provider.bind({ module: "src/lib.rs", name: "helper", range: helperReference.range })).toMatchObject({
		status: "ambiguous",
	});
	expect(provider.bind({ module: "src/lib.rs", name: "Item", range: itemReference.range })).toEqual({
		status: "bound",
		symbolId: itemDeclaration.symbolId,
		provenance: "bound",
	});
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
	expect(handlers.shutdown({})).toEqual({});
});

test("honors outline depth for declarations and imports only", () => {
	const provider = new RustProvider();
	provider.initialize("/workspace");
	const facts = provider.parseFile({
		module: "src/lib.rs",
		contentHash: "outline",
		depth: "outline",
		text: `use std::fmt::Display;
pub struct Item;
fn run(value: Item) { println!("value"); }
`,
	});
	const item = facts.declarations.find((declaration) => declaration.name === "Item");

	expect(facts.depth).toBe("outline");
	expect(item).toBeDefined();
	expect(facts.imports).toHaveLength(1);
	expect(facts.imports[0]).toMatchObject({
		specifier: "std::fmt::Display",
		imported: [{ name: "Display", local: "Display", range: expect.any(Object), localRange: expect.any(Object) }],
		reExport: false,
	});
	expect(facts.references).toEqual([]);
	expect(facts.literals).toEqual([]);
	if (item === undefined) throw new Error("outline declaration missing");
	expect(provider.typeOf({ symbolId: item.symbolId })).toMatchObject({ status: "unknown" });
});

test("reports outline syntax diagnostics", () => {
	const provider = new RustProvider();
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
	const provider = new RustProvider();
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

test("resolves file modules beside files and inside module directories", () => {
	const root = workspace({
		"src/lib.rs": "pub mod feature;\n",
		"src/feature/mod.rs": "pub mod item;\npub struct Feature;\n",
		"src/feature/item.rs": "pub struct Item;\n",
		"src/feature/leaf.rs": "pub struct Leaf;\n",
	});
	const provider = new RustProvider();
	provider.initialize(root);
	provider.discoverProject(root);

	expect(provider.resolveImport({ fromModule: "src/lib.rs", specifier: "crate::feature" })).toEqual({
		status: "resolved",
		module: "src/feature/mod.rs",
	});
	expect(provider.resolveImport({ fromModule: "src/feature/mod.rs", specifier: "self::item::Item" })).toEqual({
		status: "resolved",
		module: "src/feature/item.rs",
	});
	expect(provider.resolveImport({ fromModule: "src/feature/item.rs", specifier: "super::leaf::Leaf" })).toEqual({
		status: "resolved",
		module: "src/feature/leaf.rs",
	});
	expect(provider.resolveImport({ fromModule: "src/lib.rs", specifier: "feature::Feature" })).toEqual({
		status: "resolved",
		module: "src/feature/mod.rs",
	});
});

test("discovers multiple Cargo roots and resolves crate paths within the nearest root", () => {
	const root = workspace({
		"Cargo.toml": '[workspace]\nmembers = ["crates/one", "crates/two"]\n',
		"crates/one/Cargo.toml": '[package]\nname = "one"\nversion = "0.1.0"\n',
		"crates/one/src/lib.rs": "pub mod item;\n",
		"crates/one/src/item.rs": "pub struct One;\n",
		"crates/two/Cargo.toml": '[package]\nname = "two"\nversion = "0.1.0"\n',
		"crates/two/src/lib.rs": "pub mod item;\n",
		"crates/two/src/item.rs": "pub struct Two;\n",
		"crates/two/target/ignored.rs": "pub struct Ignored;\n",
	});
	const provider = new RustProvider();
	const info = provider.initialize(root);
	const model = provider.discoverProject(root);

	expect(info.language).toBe("rust");
	expect(model.files).toContain("crates/one/src/lib.rs");
	expect(model.files).toContain("crates/two/src/lib.rs");
	expect(model.files).not.toContain("crates/two/target/ignored.rs");
	expect(provider.resolveImport({ fromModule: "crates/two/src/lib.rs", specifier: "crate::item" })).toEqual({
		status: "resolved",
		module: "crates/two/src/item.rs",
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
`,
		"src/lib.rs": "",
	});
	const provider = new RustProvider();
	provider.initialize(root);
	provider.discoverProject(root);

	for (const [specifier, packageName] of [
		["std::fmt", "std"],
		["serde::Serialize", "serde"],
		["pretty_assertions::assert_eq", "pretty_assertions"],
		["cc::Build", "cc"],
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
	const provider = new RustProvider();
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

test("binds qualified methods through a same-file type and an imported type", () => {
	const root = workspace({
		"src/lib.rs": `pub mod util;
use crate::util::External;
struct Local;
impl Local { fn make() -> Self { Local } }
fn run() { Local::make(); External::make(); }
`,
		"src/util.rs": `pub struct External;
impl External { pub fn make() -> Self { External } }
`,
	});
	const provider = new RustProvider();
	provider.initialize(root);
	const lib = readFileSync(path.join(root, "src/lib.rs"), "utf8");
	const util = readFileSync(path.join(root, "src/util.rs"), "utf8");
	const facts = provider.parseFile({ module: "src/lib.rs", contentHash: "qualified", text: lib });
	provider.parseFile({ module: "src/util.rs", contentHash: "external", text: util });
	const calls = facts.references.filter((reference) => reference.role === "call" && reference.name === "make");
	const localMethod = facts.declarations.find((declaration) => declaration.name === "make");

	if (calls.length !== 2 || localMethod === undefined) throw new Error("qualified calls missing");
	expect(calls[0]?.binding).toEqual({
		status: "bound",
		symbolId: localMethod.symbolId,
		provenance: "bound",
	});
	expect(calls[1]?.binding.status).toBe("bound");
	expect(calls[1]?.binding).not.toEqual(calls[0]?.binding);
});

// The container id would name nothing in this parse, which the core refuses to store.
test("names no container for an impl of a type declared in another file", () => {
	const root = workspace({
		"src/lib.rs": `pub mod util;
use crate::util::External;
struct Local;
impl Local { fn make() -> Self { Local } }
impl External { fn extra(&self) {} }
`,
		"src/util.rs": "pub struct External;\n",
	});
	const provider = new RustProvider();
	provider.initialize(root);
	const lib = readFileSync(path.join(root, "src/lib.rs"), "utf8");
	const facts = provider.parseFile({ module: "src/lib.rs", contentHash: "foreign-impl", text: lib });
	const local = facts.declarations.find((declaration) => declaration.name === "Local");
	const make = facts.declarations.find((declaration) => declaration.name === "make");
	const extra = facts.declarations.find((declaration) => declaration.name === "extra");

	expect(make?.containerId).toBe(local?.symbolId);
	expect(extra?.containerId).toBeUndefined();
	expect(extra?.symbolId).toContain("External#extra");
});

test("returns explicit reasons for external, missing, and runtime constructed bindings", () => {
	const root = workspace({
		"src/lib.rs": `use std::fmt::Display;
use crate::missing::Gone;
fn run() { println!("value"); }
`,
	});
	const provider = new RustProvider();
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
	const provider = new RustProvider();
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
	const provider = new RustProvider();
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
			range: add.selectionRange,
		}),
	).toEqual({ status: "bound", symbolId: add.symbolId, provenance: "bound" });
	expect(handlers.typeOf({ symbolId: add.symbolId })).toMatchObject({ status: "known" });
	expect(handlers.resolveImport({ fromModule: "src/lib.rs", specifier: "crate::missing" })).toMatchObject({
		status: "unresolved",
	});
});

test("reports an honest project diagnostic for missing roots", () => {
	const provider = new RustProvider();
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
	const provider = new RustProvider();
	const model = provider.discoverProject(root);

	expect(model.configFiles).toEqual(["Cargo.toml", "Cargo.lock"]);
	expect(model.files).toEqual(["src/lib.rs", "src/ok.rs"]);
	expect(model.diagnostics).toEqual([]);
});

test("marks re-exporting use declarations and keeps visibility distinctions", () => {
	const root = workspace({
		"src/lib.rs": `pub struct Item;
pub use crate::item::Other;
pub(crate) fn internal() {}
pub(super) const LIMIT: i32 = 1;
fn private() {}
`,
		"src/item.rs": "pub struct Other;\n",
	});
	const provider = new RustProvider();
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
	expect(facts.imports[0]?.reExport).toBe(true);
});

test("resolves a declared type symbol from a return annotation", () => {
	const root = workspace({
		"src/lib.rs": `pub struct Cart;
pub fn build() -> Cart { Cart }
`,
	});
	const provider = new RustProvider();
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
	const provider = new RustProvider();
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
