import { expect, test } from "bun:test";
import { handlersFor, PROTOCOL_VERSION } from "@nyaa-lexicon/protocol";
import { KotlinProvider } from "../main.js";
import { parseKotlin } from "../parse.js";

function mainRole(declarations: { name: string; symbolId: string }[]) {
	const main = declarations.find((declaration) => declaration.name === "main");
	if (main === undefined) throw new Error("no main declaration");
	return { kind: "entry" as const, how: "main" as const, symbolId: main.symbolId };
}

test("a main entry names its declaration through parse and probe: top level, or JvmStatic in an object", () => {
	for (const text of [
		"fun main() {}\n",
		"fun main(args: Array<String>) {}\n",
		"package app\n\nobject App {\n    @kotlin.jvm.JvmStatic\n    fun main(args: Array<String>) {}\n}\n",
		"class App {\n    companion object {\n        @JvmStatic\n        fun main(args: Array<String>) {}\n    }\n}\n",
	]) {
		const facts = parseKotlin("Main.kt", text);
		expect(facts.role).toEqual(mainRole(facts.declarations));
	}

	const handlers = handlersFor(new KotlinProvider());
	handlers.initialize({ workspaceRoot: process.cwd(), protocolVersion: PROTOCOL_VERSION });
	handlers.discoverProject({ workspaceRoot: process.cwd() });
	const params = { module: "Main.kt", contentHash: "hash", text: "fun main() {}\n" };
	const parsed = handlers.parseFile(params);
	expect(parsed.role).toEqual(mainRole(parsed.declarations));
	expect(handlers.probeFile(params).role).toEqual(parsed.role);
});

test("a JvmStatic annotation is the one its written name resolves to through the imports", () => {
	const roles = [
		"import kotlin.jvm.JvmStatic as Entry\nobject App {\n    @Entry\n    fun main() {}\n}\n",
		"object App {\n    @[Suppress JvmStatic]\n    fun main() {}\n}\n",
		"import app.Marker as JvmStatic\nobject App {\n    @JvmStatic\n    fun main() {}\n}\n",
		"object App {\n    @foo.JvmStatic\n    fun main() {}\n}\n",
	].map((text) => parseKotlin("Main.kt", text).role.kind);

	expect(roles).toEqual(["entry", "entry", "library", "library"]);
});

test("a main in a class, a nested function, on a receiver, or without JvmStatic stays a library", () => {
	const facts = parseKotlin(
		"Library.kt",
		[
			"class App { fun main() {} }",
			"class Tool { @JvmStatic fun main() {} }",
			"object Runner { fun main(args: Array<String>) {} }",
			"fun helper() { fun main() {} }",
			"fun String.main() {}",
		].join("\n"),
	);

	expect(facts.role).toEqual({ kind: "library" });
});
