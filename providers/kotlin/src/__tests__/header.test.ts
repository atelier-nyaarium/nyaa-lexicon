import { describe, expect, test } from "bun:test";
import { FOLD_MARK } from "@nyaa-lexicon/protocol";
import { parseKotlin } from "../parse.js";

/** Kotlin's template opener, spelled apart from a TypeScript placeholder. */
const D = "$";

function fold(open: string, close: string): string {
	return `${open}${FOLD_MARK}${close}`;
}

/** Signatures by `kind name`, a repeat numbered from 2. */
function signatures(text: string): Map<string, string | undefined> {
	const found = new Map<string, string | undefined>();
	for (const item of parseKotlin("demo/Header.kt", text).declarations) {
		const key = `${item.kind} ${item.name}`;
		let repeat = 1;
		while (found.has(repeat === 1 ? key : `${key} ${repeat}`)) repeat++;
		found.set(repeat === 1 ? key : `${key} ${repeat}`, item.signature);
	}
	return found;
}

describe("signatures are whole headers on one line", () => {
	test("callables keep annotations, modifiers, multi-line parameters and return types, without comments", () => {
		const found = signatures(
			[
				"package demo",
				"",
				"/** Loads. */",
				"@Throws(IOException::class)",
				"// between",
				"suspend fun <T : Any> load(",
				"    path: String, // wide",
				"    /* note */ retries: Int,",
				"): Result<T> where T : Comparable<T> {",
				"    return fetch(path)",
				"}",
				"",
				"class Holder @Inject private constructor(",
				"    private val name: String,",
				"    count: Int = 3,",
				") {",
				"    constructor(",
				"        name: String,",
				"    ) : this(",
				"        name,",
				"        1,",
				"    ) { println(name) }",
				"}",
				"",
			].join("\n"),
		);

		expect(Object.fromEntries(found)).toMatchObject({
			"function load":
				"@Throws(IOException::class) suspend fun <T : Any> load(path: String, retries: Int): Result<T> where T : Comparable<T>",
			"variable path": "path: String",
			"variable retries": "retries: Int",
			"typeParameter T": "T : Any",
			"class Holder": "class Holder @Inject private constructor(private val name: String, count: Int = 3)",
			"constructor Holder": "constructor(private val name: String, count: Int = 3)",
			"property name": "private val name: String",
			"variable count": "count: Int = 3",
			"constructor Holder 2": "constructor(name: String) : this(name, 1)",
		});
	});

	test("types run to their body, supertypes and primary constructor included", () => {
		const found = signatures(
			[
				"package demo",
				"",
				"@Serializable",
				"/* opens */ data class Box<T>(",
				"    val size: Int,",
				") : Base<T>(),",
				"    Shape /* before body */ {",
				"}",
				"",
				"@Target(allowedTargets = [AnnotationTarget.CLASS, AnnotationTarget.FUNCTION])",
				"annotation class Tag",
				"",
				"enum class Color(val rgb: Int) {",
				"    RED(0xFF0000),",
				"    GREEN(0x00FF00) {",
				'        override fun toString() = "g"',
				"    },",
				'    BLUE { override fun toString() = "b" };',
				"}",
				"",
				'@Suppress("unused") typealias Names = Map<String, List<Int>>',
				"",
			].join("\n"),
		);

		expect(Object.fromEntries(found)).toMatchObject({
			"class Box": "@Serializable data class Box<T>(val size: Int) : Base<T>(), Shape",
			"constructor Box": "Box<T>(val size: Int)",
			"property size": "val size: Int",
			"class Tag": `@Target(allowedTargets = ${fold("[", "]")}) annotation class Tag`,
			"enum Color": "enum class Color(val rgb: Int)",
			"constant RED": "RED(0xFF0000)",
			"constant GREEN": "GREEN(0x00FF00)",
			"constant BLUE": "BLUE",
			"class Names": '@Suppress("unused") typealias Names = Map<String, List<Int>>',
		});
	});

	test("values keep their initializer with literal containers folded; parameters keep theirs", () => {
		const found = signatures(
			[
				"package demo",
				"",
				"class Store {",
				"    @JvmField",
				"    val items = arrayOf(",
				"        1,",
				"        2,",
				"    )",
				"    val handler = { value: Int ->",
				"        value + 1",
				"    }",
				"    val runner = object : Runnable {",
				"        override fun run() {}",
				"    }",
				"    val anon = fun(x: Int): Int { return x }",
				"    val short = fun(y: Int) = y + 1",
				"    val chained = listOf(1).map { it + 1 }.filter { it > 0 }",
				"    val lazyValue by lazy { compute() }",
				"    val empty: () -> Unit = {}",
				"    var counter: Int = 0 // count",
				"        private set",
				"    val isEmpty: Boolean get() = counter == 0",
				"    fun apply(block: () -> Unit = { println() }) = block()",
				"}",
				"",
			].join("\n"),
		);

		expect(Object.fromEntries(found)).toMatchObject({
			"property items": "@JvmField val items = arrayOf(1, 2)",
			"property handler": `val handler = ${fold("{", "}")}`,
			"property runner": `val runner = object : Runnable ${fold("{", "}")}`,
			"property anon": `val anon = fun(x: Int): Int ${fold("{", "}")}`,
			"property short": "val short = fun(y: Int) = y + 1",
			"property chained": `val chained = listOf(1).map ${fold("{", "}")}.filter ${fold("{", "}")}`,
			"property lazyValue": `val lazyValue by lazy ${fold("{", "}")}`,
			"property empty": "val empty: () -> Unit = {}",
			"property counter": "var counter: Int = 0",
			"property isEmpty": "val isEmpty: Boolean",
			"method apply": `fun apply(block: () -> Unit = ${fold("{", "}")})`,
			"variable block": "block: () -> Unit = { println() }",
		});
		expect([...found.values()].filter((signature) => signature?.includes("\n"))).toEqual([]);
	});

	test("literals keep their whitespace as written, a line break or tab escaped, templates whole", () => {
		const found = signatures(
			[
				"package demo",
				"",
				'val SEP = "a  b"',
				'val DOC = """one',
				'  two"""',
				`val RAW = """a  ${D}SEP\tb"""`,
				`val NAME = "x  ${D}{SEP.map { it }}  y"`,
				"val CH = '\\t'",
				'inline fun f(vararg items: Int, @Suppress("a  b") name: String = "p  q") {}',
				"",
			].join("\n"),
		);

		expect(Object.fromEntries(found)).toMatchObject({
			"property SEP": 'val SEP = "a  b"',
			"property DOC": 'val DOC = """one\\n  two"""',
			"property RAW": `val RAW = """a  ${D}SEP\\tb"""`,
			"property NAME": `val NAME = "x  ${D}{SEP.map { it }}  y"`,
			"property CH": "val CH = '\\t'",
			"function f": 'inline fun f(vararg items: Int, @Suppress("a  b") name: String = "p  q")',
			"variable items": "vararg items: Int",
			"variable name": '@Suppress("a  b") name: String = "p  q"',
		});
	});
});
