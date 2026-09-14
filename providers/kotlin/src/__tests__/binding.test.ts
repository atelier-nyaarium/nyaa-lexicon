import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Binding } from "@nyaa-lexicon/protocol";
import { KotlinProvider, REFERENCE_ROLES } from "../main.js";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A bound target as `module descriptors`, a sorted list when ambiguous, null when unbound. */
type Target = string | string[] | null;

function target(binding: Binding): Target {
	const short = (id: string): string => id.replace(/^lexicon kotlin /u, "");
	if (binding.status === "bound") return short(binding.symbolId);
	if (binding.status === "ambiguous") return binding.candidates.map(short);
	return null;
}

function workspace(files: Record<string, string>): string {
	const root = mkdtempSync(path.join(tmpdir(), "lexicon-kotlin-binding-"));
	roots.push(root);
	for (const [name, text] of Object.entries(files)) {
		const full = path.join(root, name);
		mkdirSync(path.dirname(full), { recursive: true });
		writeFileSync(full, text);
	}
	return root;
}

/** Every reference in `module` as `line:name:role` to its targets, in source order. */
function bindings(files: Record<string, string>, module: string): Map<string, Target[]> {
	const provider = new KotlinProvider();
	provider.initialize(workspace(files));
	const facts = provider.parseFile({ module, contentHash: "h", text: files[module] as string });
	const found = new Map<string, Target[]>();
	for (const reference of facts.references) {
		const key = `${reference.range.start.line}:${reference.name}:${reference.role}`;
		found.set(key, [...(found.get(key) ?? []), target(reference.binding)]);
	}
	return found;
}

/** Several uses on one line with the same name and role. */
function each(...targets: Target[]): { each: Target[] } {
	return { each: targets };
}

function expectTargets(found: Map<string, Target[]>, expected: Record<string, Target | { each: Target[] }>): void {
	for (const [key, want] of Object.entries(expected)) {
		const wanted = want !== null && typeof want === "object" && "each" in want ? want.each : [want];
		expect({ key, got: found.get(key) }).toEqual({ key, got: wanted });
	}
}

const PACKAGE = [
	"package a",
	"val limit = 1",
	"var count = 0",
	"val it = 2",
	"val field = 3",
	"val value = 4",
	"val seed = 5",
	"val tag = 6",
	"fun run() = 7",
	"class Item",
	"",
].join("\n");

describe("Kotlin locals", () => {
	test("every binder shadows a package name within its scope and only there", () => {
		const found = bindings(
			{
				"a/Pkg.kt": PACKAGE,
				"a/Use.kt": [
					"package a",
					"fun use(list: List<Int>) {",
					"    list.forEach { limit -> println(limit) }",
					"    list.forEach { (count, tag) -> println(count + tag) }",
					"    for (count in list) println(count)",
					"    for ((limit, seed) in pairs) println(limit + seed)",
					"    try { } catch (limit: Exception) { println(limit) }",
					"    val (seed, tag) = Pair(1, 2)",
					"    println(seed + tag + count)",
					"    when (val value = list) { else -> value }",
					"    list.map { it + limit }",
					"}",
					"fun <Item> pick(value: Item): Item = value",
					"val o = object : Runnable { val tag = 1; override fun run() { println(tag) } }",
					"",
				].join("\n"),
			},
			"a/Use.kt",
		);
		expectTargets(found, {
			"2:limit:read": "a/Use.kt use().(limit)",
			"3:count:read": "a/Use.kt use().(count)",
			"3:tag:read": "a/Use.kt use().(tag)",
			"4:count:read": "a/Use.kt use().(count@1)",
			"5:limit:read": "a/Use.kt use().(limit@1)",
			"5:seed:read": "a/Use.kt use().(seed)",
			"6:limit:read": "a/Use.kt use().(limit@2)",
			"8:seed:read": "a/Use.kt use().(seed@1)",
			"8:tag:read": "a/Use.kt use().(tag@1)",
			"8:count:read": "a/Pkg.kt count.",
			"9:value:read": "a/Use.kt use().value.",
			"10:it:read": null,
			"10:limit:read": "a/Pkg.kt limit.",
			"12:Item:typeUse": each("a/Use.kt pick().[Item]", "a/Use.kt pick().[Item]"),
			"12:value:read": "a/Use.kt pick().(value)",
			"13:tag:read": "a/Use.kt o.tag.",
		});
	});

	test("a block local is visible after its declaration and inside its block", () => {
		const found = bindings(
			{
				"a/Pkg.kt": PACKAGE,
				"a/Use.kt": [
					"package a",
					"fun f(): Int {",
					"    println(limit)",
					"    val limit = limit + 1",
					"    if (true) { val count = 1; return count + limit }",
					"    return count",
					"}",
					"",
				].join("\n"),
			},
			"a/Use.kt",
		);
		expectTargets(found, {
			"2:limit:read": "a/Pkg.kt limit.",
			"3:limit:read": "a/Pkg.kt limit.",
			"4:count:read": "a/Use.kt f().count.",
			"4:limit:read": "a/Use.kt f().limit.",
			"5:count:read": "a/Pkg.kt count.",
		});
	});

	test("constructor parameters reach initializers, never member bodies", () => {
		const found = bindings(
			{
				"a/Pkg.kt": `${PACKAGE}open class Base(v: Int)\ninterface Source\n`,
				"a/Use.kt": [
					"package a",
					"class K(limit: Int, seed: Source) : Base(limit), Source by seed {",
					"    val doubled = limit * 2",
					"    init { println(limit) }",
					"    fun f() = limit",
					"    val g: Int get() = limit",
					"    constructor(count: String) : this(count.length, seed)",
					"    var v: Int = 0",
					"        set(value) { field = value }",
					"}",
					"",
				].join("\n"),
			},
			"a/Use.kt",
		);
		expectTargets(found, {
			"1:limit:read": "a/Use.kt K#K().(limit)",
			"1:seed:read": "a/Use.kt K#K().(seed)",
			"2:limit:read": "a/Use.kt K#K().(limit)",
			"3:limit:read": "a/Use.kt K#K().(limit)",
			"4:limit:read": "a/Pkg.kt limit.",
			"5:limit:read": "a/Pkg.kt limit.",
			"6:count:read": "a/Use.kt K#K(1).(count)",
			"6:seed:read": "a/Pkg.kt seed.",
			"8:field:write": null,
			"8:value:read": "a/Use.kt K#v.(value)",
		});
	});
});

describe("Kotlin implicit receivers", () => {
	test("members, companion members and inherited members rank above the package", () => {
		const found = bindings(
			{
				"a/Pkg.kt": `${PACKAGE}fun make() = 0\nclass Node\n`,
				"a/Base.kt": "package a\nopen class Base {\n    val limit = 5\n    class Node\n}\n",
				"a/Sub.kt": [
					"package a",
					"class Sub : Base() {",
					"    companion object { fun make() = 1 }",
					"    fun read() = limit",
					"    fun build() = make()",
					"    fun root(): Node? = null",
					"    class Nested { fun peek() = make() + count }",
					"}",
					"",
				].join("\n"),
			},
			"a/Sub.kt",
		);
		expectTargets(found, {
			"3:limit:read": "a/Base.kt Base#limit.",
			"4:make:call": "a/Sub.kt Sub#Companion#make().",
			"5:Node:typeUse": "a/Base.kt Base#Node#",
			"6:make:call": "a/Sub.kt Sub#Companion#make().",
			"6:count:read": "a/Pkg.kt count.",
		});
	});

	test("a nested class sees no outer instance member", () => {
		const found = bindings(
			{
				"a/Pkg.kt": PACKAGE,
				"a/Use.kt": [
					"package a",
					"class Outer {",
					"    val limit = 1",
					"    class Nested { fun f() = limit }",
					"    inner class Inner { fun f() = limit }",
					"}",
					"",
				].join("\n"),
			},
			"a/Use.kt",
		);
		expectTargets(found, {
			"3:limit:read": "a/Pkg.kt limit.",
			"4:limit:read": "a/Use.kt Outer#limit.",
		});
	});

	test("an extension receiver's members bind, and an extension needs its receiver in scope", () => {
		const found = bindings(
			{
				"a/Pkg.kt": `${PACKAGE}fun Box.grow() = 1\n`,
				"a/Box.kt": "package a\nclass Box { val limit = 4 }\n",
				"a/Use.kt": [
					"package a",
					"fun Box.twice() = limit * grow()",
					"fun loose() = grow()",
					"class Holder : Box() { fun g() = grow() }",
					"",
				].join("\n"),
			},
			"a/Use.kt",
		);
		expectTargets(found, {
			"1:limit:read": "a/Box.kt Box#limit.",
			"1:grow:call": "a/Pkg.kt grow().",
			"2:grow:call": null,
			"3:grow:call": "a/Pkg.kt grow().",
		});
	});

	test("this, a labelled this and super walk the class and its supertypes", () => {
		const found = bindings(
			{
				"a/Base.kt": "package a\nopen class Base { open fun size() = 1 }\nfun size() = 3\n",
				"a/Use.kt": [
					"package a",
					"class Sub : Base() {",
					"    override fun size() = super.size() + this@Sub.size() + this.size()",
					"}",
					"",
				].join("\n"),
			},
			"a/Use.kt",
		);
		expect(found.get("2:size:call")).toEqual([
			"a/Base.kt Base#size().",
			"a/Use.kt Sub#size().",
			"a/Use.kt Sub#size().",
		]);
	});
});

describe("Kotlin member visibility", () => {
	const V = [
		"package a",
		"open class V {",
		"    private val limit = 10",
		"    protected val tag = 11",
		"    fun own() = limit + tag + this.tag",
		"    fun String.member() = limit + tag",
		"    private class Secret",
		"    companion object { private const val seed = 12 }",
		"    fun fromCompanion() = seed",
		"    class Nested { fun peek() = seed }",
		"}",
		"fun V.ext() = limit + tag + this.limit",
		"fun ref() = V::limit",
		"val anon = object : V() { fun g() = tag + limit }",
		"class Unrelated { val s = V.Secret::class; fun u() = V.seed }",
		"",
	].join("\n");

	test("private binds only inside its class, protected inside it or a subclass, through any receiver", () => {
		expectTargets(bindings({ "a/Pkg.kt": PACKAGE, "a/V.kt": V }, "a/V.kt"), {
			"4:limit:read": "a/V.kt V#limit.",
			"4:tag:read": each("a/V.kt V#tag.", "a/V.kt V#tag."),
			"5:limit:read": "a/V.kt V#limit.",
			"5:tag:read": "a/V.kt V#tag.",
			"8:seed:read": "a/V.kt V#Companion#seed.",
			"9:seed:read": "a/V.kt V#Companion#seed.",
			"11:limit:read": each("a/Pkg.kt limit.", null),
			"11:tag:read": "a/Pkg.kt tag.",
			"12:limit:read": null,
			"13:tag:read": "a/V.kt V#tag.",
			"13:limit:read": "a/Pkg.kt limit.",
			"14:Secret:read": null,
			"14:seed:read": null,
		});
	});

	test("a subclass in another file sees protected members and never private ones", () => {
		const sub = "package a\nclass Sub : V() { fun s() = tag + super.tag + limit + this.limit }\n";
		expectTargets(bindings({ "a/Pkg.kt": PACKAGE, "a/V.kt": V, "a/Sub.kt": sub }, "a/Sub.kt"), {
			"1:tag:read": each("a/V.kt V#tag.", "a/V.kt V#tag."),
			"1:limit:read": each("a/Pkg.kt limit.", null),
		});
	});
});

describe("Kotlin accessibility on every lookup path", () => {
	const A = [
		"package p",
		"import p.A.Hidden",
		"import p.A.*",
		"open class A {",
		"    private open class Hidden { val deep = 1 }",
		"    protected open class Prot { val deep = 2 }",
		"    open class Open { val deep = 3 }",
		"    companion object { private open class Kept { val deep = 4 } }",
		"    class In : Hidden() { fun f() = deep }",
		"    class Own : Companion.Kept() { fun f() = deep }",
		"}",
		"class Out : A.Hidden() { fun f() = deep; fun g(h: Hidden, o: Open) = h }",
		"class Far : A.Companion.Kept() { fun f() = deep }",
		"private fun secret() = 1",
		"fun near() = p.secret() + secret()",
		"",
	].join("\n");
	const USE = [
		"package q",
		"import p.A.Hidden",
		"import p.secret",
		"import p.A",
		"class Sub : A() {",
		"    class Inner : A.Prot() { fun f() = deep }",
		"}",
		"class Stranger : A.Prot() { fun f() = deep }",
		"fun far() = p.secret()",
		"",
	].join("\n");

	test("an import, a star import and a package path admit only what the file may name", () => {
		expectTargets(bindings({ "p/A.kt": A, "q/Use.kt": USE }, "p/A.kt"), {
			"1:Hidden:import": null,
			"11:Hidden:typeUse": null,
			"11:Open:typeUse": "p/A.kt A#Open#",
			"14:secret:call": each("p/A.kt secret().", "p/A.kt secret()."),
		});
		expectTargets(bindings({ "p/A.kt": A, "q/Use.kt": USE }, "q/Use.kt"), {
			"1:Hidden:import": null,
			"2:secret:import": null,
			"8:secret:call": null,
		});
	});

	test("a star import admits its members where it is written, not at a use inside a subclass", () => {
		const base =
			"package p\nopen class Base { companion object { protected const val CP = 3; const val OPEN = 4 } }\n";
		const use = [
			"package q",
			"import p.Base.*",
			"class Sub : p.Base() {",
			"    class Nested { fun f() = CP + OPEN }",
			"    fun g() = CP",
			"}",
			"",
		].join("\n");
		expectTargets(bindings({ "p/Base.kt": base, "q/Use.kt": use }, "q/Use.kt"), {
			"3:CP:read": null,
			"3:OPEN:read": "p/Base.kt Base#Companion#OPEN.",
			"4:CP:read": "p/Base.kt Base#Companion#CP.",
		});
	});

	test("a written type admits private, companion-private and protected classifiers only where Kotlin does", () => {
		expectTargets(bindings({ "p/A.kt": A, "q/Use.kt": USE }, "p/A.kt"), {
			"8:deep:read": "p/A.kt A#Hidden#deep.",
			"9:deep:read": "p/A.kt A#Companion#Kept#deep.",
			"11:deep:read": null,
			"12:deep:read": null,
		});
		expectTargets(bindings({ "p/A.kt": A, "q/Use.kt": USE }, "q/Use.kt"), {
			"5:deep:read": "p/A.kt A#Prot#deep.",
			"7:deep:read": null,
		});
	});

	test("resolveImport refuses a private nested class from its own file and from another", () => {
		const provider = new KotlinProvider();
		provider.initialize(workspace({ "p/A.kt": A, "q/Use.kt": USE }));
		const resolve = (fromModule: string, specifier: string) => provider.resolveImport({ fromModule, specifier });

		expect([resolve("p/A.kt", "p.A.Hidden"), resolve("q/Use.kt", "p.A.Hidden")]).toMatchObject([
			{ status: "unresolved", reason: "NotIndexed" },
			{ status: "unresolved", reason: "NotIndexed" },
		]);
		expect(resolve("q/Use.kt", "p.A.Open")).toEqual({ status: "resolved", module: "p/A.kt" });
	});
});

describe("Kotlin top-level tiers", () => {
	test("explicit imports, then the package including this file, then star imports pooled", () => {
		const found = bindings(
			{
				"util/Log.kt": "package util\nfun log(message: String) {}\nclass Thing\nclass Starred\n",
				"c/Starred.kt": "package c\nclass Starred\nclass Only\n",
				"a/Thing.kt": "package a\nclass Only\n",
				"a/Use.kt": [
					"package a",
					"import util.log",
					"import util.*",
					"import c.*",
					"fun log(message: String) {}",
					'fun go(t: Thing, s: Starred, o: Only) = log("x")',
					"",
				].join("\n"),
			},
			"a/Use.kt",
		);
		expectTargets(found, {
			"5:Thing:typeUse": "util/Log.kt Thing#",
			"5:Starred:typeUse": ["c/Starred.kt Starred#", "util/Log.kt Starred#"],
			"5:Only:typeUse": "a/Thing.kt Only#",
			"5:log:call": "util/Log.kt log().",
		});
	});

	test("a called value stops the walk instead of reaching a function further out", () => {
		const found = bindings(
			{
				"a/Pkg.kt": `${PACKAGE}fun handler() = 1\n`,
				"a/Use.kt": "package a\nfun f(handler: () -> Int) = handler()\n",
			},
			"a/Use.kt",
		);
		expectTargets(found, { "1:handler:call": null });
	});
});

describe("Kotlin imports", () => {
	test("an import records its names and ranges, and an alias binds where the original name does not", () => {
		const root = workspace({
			"src/Item.kt": "package sample.models\nclass Item\n",
			"src/Use.kt":
				"package sample.use\nimport sample.models.Item as Product\nimport sample.models.*\nfun use(value: Product): Product = Product()\n",
		});
		const provider = new KotlinProvider();
		provider.initialize(root);
		const text = readFileSync(path.join(root, "src/Use.kt"), "utf8");
		const facts = provider.parseFile({ module: "src/Use.kt", contentHash: "h", text });
		const [alias, star] = facts.imports;

		expect(alias).toMatchObject({
			specifier: "sample.models.Item",
			imported: [{ name: "Item", local: "Product" }],
		});
		expect(alias?.imported[0]?.range).not.toEqual(alias?.imported[0]?.localRange);
		expect(star).toMatchObject({ specifier: "sample.models.*", imported: [{ name: "*" }] });
		expect(
			facts.references
				.filter((reference) => reference.name === "Product" && reference.role !== "import")
				.map((reference) => target(reference.binding)),
		).toEqual(["src/Item.kt Item#", "src/Item.kt Item#", "src/Item.kt Item#"]);
	});

	test("resolveImport names the declaring file, the deepest package, an external root or a closed reason", () => {
		const root = workspace({
			"src/one.kt": "package org.example.models\nclass One\n",
			"src/two.kt": "package org.example\nclass Two\n",
			"dup/a.kt": "package duplicate\nclass A\n",
			"dup/b.kt": "package duplicate\nclass A\n",
		});
		const provider = new KotlinProvider();
		provider.initialize(root);
		const resolve = (specifier: string) => provider.resolveImport({ fromModule: "use.kt", specifier });

		expect(resolve("org.example.models.One")).toEqual({ status: "resolved", module: "src/one.kt" });
		expect(resolve("org.example.Two")).toEqual({ status: "resolved", module: "src/two.kt" });
		expect(resolve("org.example.models.*")).toEqual({ status: "resolved", module: "src/one.kt" });
		expect(resolve("java.time.Instant")).toEqual({ status: "external", packageName: "java.time.Instant" });
		expect(resolve("org.missing.Type")).toMatchObject({ status: "unresolved", reason: "NotIndexed" });
		expect(resolve("duplicate.A")).toMatchObject({ status: "unresolved", reason: "Ambiguous" });
		expect(resolve("duplicate.*")).toMatchObject({ status: "unresolved", reason: "Ambiguous" });
		expect(resolve("")).toMatchObject({ status: "unresolved", reason: "ParseError" });
	});

	test("an external import blocks lower tiers, and an unindexed name answers NotIndexed", () => {
		const provider = new KotlinProvider();
		provider.initialize(workspace({ "a/Pkg.kt": "package a\nclass Instant\n" }));
		const facts = provider.parseFile({
			module: "a/Use.kt",
			contentHash: "h",
			text: "package a\nimport java.time.Instant\nfun f(i: Instant) = missing()\n",
		});
		const reason = (name: string) => {
			const binding = facts.references.find(
				(reference) => reference.name === name && reference.role !== "import",
			)?.binding;
			return binding?.status === "unbound" ? binding.reason : binding?.status;
		};

		expect([reason("Instant"), reason("missing")]).toEqual(["ExternalDependency", "NotIndexed"]);
	});
});

describe("Kotlin qualified names", () => {
	test("a type reaches nested classifiers, entries, object and companion members, never instance members", () => {
		const found = bindings(
			{
				"a/Box.kt": [
					"package a",
					"class Box { companion object { val size = 1 }; val width = 2; class Inner }",
					"object Registry { fun lookup() = 1 }",
					"enum class Color { RED; fun lower() = 1 }",
					"",
				].join("\n"),
				"x/Use.kt": [
					"package x",
					"import a.Box",
					"import a.Registry",
					"import a.Color.*",
					"fun f(b: Box) = Box.size + Box.width + Registry.lookup() + b.width + RED.ordinal + lower()",
					"fun g(): Box.Inner? = null",
					"val h = Box::width",
					"",
				].join("\n"),
			},
			"x/Use.kt",
		);
		expectTargets(found, {
			"4:size:read": "a/Box.kt Box#Companion#size.",
			"4:width:read": each(null, null),
			"4:lookup:call": "a/Box.kt Registry#lookup().",
			"4:RED:read": "a/Box.kt Color#RED.",
			"4:lower:call": null,
			"5:Inner:typeUse": "a/Box.kt Box#Inner#",
			"6:width:read": "a/Box.kt Box#width.",
		});
	});

	test("a star import of a class provides a supertype, whose members then bind", () => {
		const found = bindings(
			{
				"a/Outer.kt": "package a\nclass Outer {\n    open class Nested { val deep = 1 }\n}\n",
				"b/Use.kt": "package b\nimport a.Outer.*\nclass Sub : Nested() { fun h() = deep }\n",
			},
			"b/Use.kt",
		);
		expectTargets(found, {
			"2:Nested:extends": "a/Outer.kt Outer#Nested#",
			"2:deep:read": "a/Outer.kt Outer#Nested#deep.",
		});
	});

	test("a qualifier spelling a package resolves through the index", () => {
		const found = bindings(
			{
				"b/c/Thing.kt": "package b.c\nopen class Thing { companion object { fun create() = 1 } }\n",
				"a/Thing.kt": "package a\nclass Thing\n",
				"a/Use.kt": "package a\nclass Sub : b.c.Thing()\nfun f() = b.c.Thing.create()\n",
			},
			"a/Use.kt",
		);
		expectTargets(found, {
			"1:Thing:extends": "b/c/Thing.kt Thing#",
			"2:Thing:read": "b/c/Thing.kt Thing#",
			"2:create:call": "b/c/Thing.kt Thing#Companion#create().",
		});
	});

	test("a qualifier chain of twenty thousand links binds without overflowing", () => {
		const text = `package a\nobject Box { val next = 1 }\nfun f() = Box${".next".repeat(20000)}\n`;
		const found = bindings({ "a/Use.kt": text }, "a/Use.kt");
		expect(found.get("2:next:read")?.slice(0, 2)).toEqual(["a/Use.kt Box#next.", null]);
	});
});

describe("Kotlin reference roles", () => {
	test("a compound write and its read bind apart, and a read prefers a value to a function", () => {
		const found = bindings(
			{
				"a/Counter.kt": "package a\nobject Counter {\n    var hits = 0\n    fun hits(): Int = hits\n}\n",
				"a/Use.kt":
					"package a\nfun bump() { Counter.hits += 1; Counter.hits++; f(limit = 3) }\nfun f(limit: Int) = !check(limit)\nfun check(x: Int) = true\n",
			},
			"a/Use.kt",
		);
		expectTargets(found, {
			"1:hits:read": each("a/Counter.kt Counter#hits.", "a/Counter.kt Counter#hits."),
			"1:hits:write": each("a/Counter.kt Counter#hits.", "a/Counter.kt Counter#hits."),
			"2:check:call": "a/Use.kt check().",
		});
		expect(found.has("1:limit:write")).toBe(false);
	});

	test("a file can hold every declared role, and nothing outside them", () => {
		const provider = new KotlinProvider();
		provider.initialize(process.cwd());
		const facts = provider.parseFile({
			module: "Roles.kt",
			contentHash: "h",
			text: "import sample.Base\nclass Child : Base() { var count: Int = 0; fun bump() { count += helper() } }\nfun helper(): Child = Child()\n",
		});

		expect(new Set(facts.references.map((reference) => reference.role))).toEqual(new Set(REFERENCE_ROLES));
	});

	test("keywords, labels, this@ and a named argument's label are not references", () => {
		const provider = new KotlinProvider();
		provider.initialize(process.cwd());
		const facts = provider.parseFile({
			module: "Words.kt",
			contentHash: "h",
			text: [
				"class Box {",
				"    val lazyValue by lazy { 1 }",
				"    var stored: Int = 0",
				"        get() = field",
				"        set(value) { field = value }",
				"    fun f(xs: List<Int>, limit: Int) {",
				"        outer@ for (x in xs) { if (x > 0) break@outer }",
				"        try { g(limit = 3) } catch (e: Exception) { } finally { }",
				"        this@Box.stored = 1",
				"    }",
				"    fun g(limit: Int) = limit",
				"}",
				"",
			].join("\n"),
		});
		const names = facts.references.map((reference) => `${reference.name}:${reference.role}`);

		expect(names.filter((name) => /^(by|get|set|catch|finally|outer|Box|this|limit:write)\b/u.test(name))).toEqual(
			[],
		);
		expect(names).toContain("limit:read");
	});

	test("a local owns its initializer, an accessor its body, a class its supertype arguments", () => {
		const provider = new KotlinProvider();
		provider.initialize(process.cwd());
		const facts = provider.parseFile({
			module: "Owners.kt",
			contentHash: "h",
			text: [
				"open class Base(v: Int)",
				"val seed = 1",
				"class Sub : Base(seed) {",
				"    val size: Int get() = seed",
				"    fun f() { val doubled = seed * 2; println(doubled) }",
				"}",
				"",
			].join("\n"),
		});
		const owners = facts.references
			.filter((reference) => reference.name === "seed" || reference.name === "doubled")
			.map((reference) => `${reference.name}<-${reference.fromId?.split(" ").at(-1)}`);

		expect(owners).toEqual(["seed<-Sub#", "seed<-Sub#size.", "seed<-Sub#f().doubled.", "doubled<-Sub#f()."]);
	});

	test("bind answers a reference or declaration by range, and NotIndexed for anything else", () => {
		const root = workspace({
			"base/Base.kt": "package sample\nopen class Base\n",
			"child/Child.kt": "package child\nimport sample.Base\nfun make(): Base = Base()\n",
		});
		const provider = new KotlinProvider();
		provider.initialize(root);
		const at = (line: number, character: number) => ({ start: { line, character }, end: { line, character } });

		expect(provider.bind({ module: "child/Child.kt", name: "Base", range: at(2, 20) })).toMatchObject({
			status: "bound",
			symbolId: "lexicon kotlin base/Base.kt Base#",
		});
		expect(provider.bind({ module: "child/Child.kt", name: "make", range: at(2, 5) })).toMatchObject({
			status: "bound",
			symbolId: "lexicon kotlin child/Child.kt make().",
		});
		expect(provider.bind({ module: "child/Child.kt", name: "missing", range: at(0, 0) })).toMatchObject({
			status: "unbound",
			reason: "NotIndexed",
		});
		expect(provider.bind({ module: "../outside.kt", name: "Base", range: at(0, 0) })).toMatchObject({
			status: "unbound",
			reason: "NotIndexed",
		});
	});

	test("a soft keyword spelled as a name binds as a name", () => {
		const found = bindings(
			{
				"a/Soft.kt": [
					"package a",
					"val open = 1",
					"fun open(value: Int) = value",
					"class Names { val sealed = 2 }",
					"fun use(data: Names) = open + open(2) + data.sealed",
					"",
				].join("\n"),
			},
			"a/Soft.kt",
		);
		expectTargets(found, {
			"4:open:read": "a/Soft.kt open.",
			"4:open:call": "a/Soft.kt open().",
			"4:data:read": "a/Soft.kt use().(data)",
		});
	});

	test("a delegate followed by braces owns a class body, not a trailing lambda", () => {
		const found = bindings(
			{
				"a/Pkg.kt": `${PACKAGE}interface Source\n`,
				"a/Use.kt": "package a\nclass A(val d: Source) : Source by d {\n    fun f() = d\n}\n",
			},
			"a/Use.kt",
		);
		expectTargets(found, { "1:d:read": "a/Use.kt A#d.", "2:d:read": "a/Use.kt A#d." });
	});
});
