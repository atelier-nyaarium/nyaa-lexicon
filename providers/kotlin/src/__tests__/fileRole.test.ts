import { expect, test } from "bun:test";
import { handlersFor, PROTOCOL_VERSION } from "@nyaa-lexicon/protocol";
import { KotlinProvider } from "../main.js";
import { parseKotlin } from "../parse.js";

test("a top-level main is an entry and keeps its declaration id through parse and probe", () => {
	for (const text of ["fun main() {}\n", "fun main(args: Array<String>) {}\n"]) {
		const facts = parseKotlin("Main.kt", text);
		const main = facts.declarations.find(
			(declaration) => declaration.kind === "function" && declaration.name === "main",
		);
		expect(facts.role).toEqual({ kind: "entry", how: "main", symbolId: main?.symbolId });
	}

	const handlers = handlersFor(new KotlinProvider());
	handlers.initialize({ workspaceRoot: process.cwd(), protocolVersion: PROTOCOL_VERSION });
	handlers.discoverProject({ workspaceRoot: process.cwd() });
	const params = { module: "Main.kt", contentHash: "hash", text: "fun main() {}\n" };
	const parsed = handlers.parseFile(params);
	const probed = handlers.probeFile(params);
	expect(parsed.role).toEqual({ kind: "entry", how: "main", symbolId: parsed.declarations[0]?.symbolId });
	expect(probed.role).toEqual(parsed.role);
});

test("only a top-level non-extension main makes an entry", () => {
	const facts = parseKotlin(
		"Library.kt",
		[
			"class App { fun main() {} }",
			"object Runner { fun main(args: Array<String>) {} }",
			"fun helper() { fun main() {} }",
			"fun String.main() {}",
		].join("\n"),
	);

	expect(facts.role).toEqual({ kind: "library" });
});

test("a JvmStatic main in an object is an entry", () => {
	const facts = parseKotlin(
		"App.kt",
		"package app\n\nobject App {\n    @kotlin.jvm.JvmStatic\n    fun main(args: Array<String>) {}\n}\n",
	);
	const main = facts.declarations.find((declaration) => declaration.kind === "method" && declaration.name === "main");

	expect(facts.role).toEqual({ kind: "entry", how: "main", symbolId: main?.symbolId });
});

test("a JvmStatic main in a companion object is an entry", () => {
	const facts = parseKotlin(
		"App.kt",
		"class App {\n    companion object {\n        @JvmStatic\n        fun main(args: Array<String>) {}\n    }\n}\n",
	);
	const main = facts.declarations.find((declaration) => declaration.kind === "method" && declaration.name === "main");

	expect(facts.role).toEqual({ kind: "entry", how: "main", symbolId: main?.symbolId });
});

test("a main in a class or an object without JvmStatic stays a library", () => {
	const facts = parseKotlin(
		"Library.kt",
		["class App { @JvmStatic fun main() {} }", "object Runner { fun main(args: Array<String>) {} }"].join("\n"),
	);

	expect(facts.role).toEqual({ kind: "library" });
});
