// Cases about how a file runs: a recognized entry pattern, none, or a candidate a provider cannot decide.

import type { ConformanceCase } from "./types.js";

////////////////////////////////
//  Functions & Helpers

export function roleCases(): ConformanceCase[] {
	return [
		{
			id: "a-file-that-only-declares-is-a-library",
			tier: "fileRoles",
			about: "A file of imports, declarations and declaration initializers has no entry pattern. An initializer that calls code, a prototype of main, an instance Main, and a Kotlin main in a class or on a receiver do not make one.",
			role: { kind: "library" },
			fixtures: {
				typescript: {
					files: {
						"src/cart.ts":
							'import { createLogger } from "./log";\nconst logger = createLogger();\nexport function add(a: number, b: number): number {\n\treturn a + b;\n}\n',
					},
					subject: "src/cart.ts",
				},
				python: {
					files: {
						"src/cart.py":
							'"""Cart helpers."""\nimport logging\n\nlogger = logging.getLogger(__name__)\n\n\ndef add(a, b):\n    return a + b\n\n\nclass Cart:\n    pass\n',
					},
					subject: "src/cart.py",
				},
				bash: {
					files: { "src/cart.sh": "STARTED=$(date +%s)\nadd() {\n  echo $(( $1 + $2 ))\n}\n" },
					subject: "src/cart.sh",
				},
				c: {
					files: { "src/cart.c": "int main(void);\nint add(int a, int b) { return a + b; }\n" },
					subject: "src/cart.c",
				},
				cpp: {
					files: { "src/cart.cpp": "int main();\nint add(int a, int b) { return a + b; }\n" },
					subject: "src/cart.cpp",
				},
				csharp: {
					files: { "src/Cart.cs": "namespace Demo { public class Cart { public void Main() {} } }\n" },
					subject: "src/Cart.cs",
				},
				rust: {
					files: { "src/lib.rs": "pub fn add(a: i32, b: i32) -> i32 {\n    a + b\n}\n" },
					subject: "src/lib.rs",
				},
				kotlin: {
					files: {
						"src/Cart.kt":
							"package cart\n\nfun add(a: Int, b: Int): Int = a + b\n\nclass Cart {\n    @JvmStatic\n    fun main(args: Array<String>) {}\n}\n\nfun String.main() {}\n",
					},
					subject: "src/Cart.kt",
				},
			},
		},
		{
			id: "module-setup-is-not-an-entry",
			tier: "fileRoles",
			about: "A library setting itself up is still a library: exports assigned, imports guarded for type checking or a missing package, a feature detected and filled, other files sourced.",
			role: { kind: "library" },
			fixtures: {
				typescript: {
					files: {
						"src/lib.cjs":
							"function add(a, b) {\n\treturn a + b;\n}\nif (!Array.prototype.at) {\n\tArray.prototype.at = function at(index) {\n\t\treturn this[index];\n\t};\n}\nmodule.exports = { add };\nexports.version = 1;\n",
					},
					subject: "src/lib.cjs",
				},
				python: {
					files: {
						"src/lib.py":
							"from typing import TYPE_CHECKING\n\nif TYPE_CHECKING:\n    from collections.abc import Iterable\n\ntry:\n    import ujson as json\nexcept ImportError:\n    import json\n\n\ndef load(text):\n    return json.loads(text)\n",
					},
					subject: "src/lib.py",
				},
				bash: {
					files: {
						"src/lib.sh":
							'source "$(dirname "$0")/common.sh"\n. ./colors.sh\nif [ -f ./local.sh ]; then\n  source ./local.sh\nfi\n\ngreet() {\n  echo "$1"\n}\n',
					},
					subject: "src/lib.sh",
				},
			},
		},
		{
			id: "a-jvm-static-main-in-an-object-is-an-entry",
			tier: "fileRoles",
			about: "A `@JvmStatic` main in an object or companion object is a JVM entry point.",
			role: { kind: "entry", how: "main", main: "main" },
			fixtures: {
				kotlin: {
					files: {
						"src/App.kt":
							"package app\n\nobject App {\n    @JvmStatic\n    fun main(args: Array<String>) {}\n}\n",
					},
					subject: "src/App.kt",
				},
			},
		},
		{
			id: "a-main-the-runtime-calls-is-an-entry",
			tier: "fileRoles",
			about: "A main the runtime calls makes the file an entry, naming that declaration.",
			role: { kind: "entry", how: "main", main: "main" },
			fixtures: {
				c: {
					files: { "src/main.c": "int main(void) {\n\treturn 0;\n}\n" },
					subject: "src/main.c",
				},
				cpp: {
					files: { "src/main.cpp": "int main() {\n\treturn 0;\n}\n" },
					subject: "src/main.cpp",
				},
				csharp: {
					files: {
						"src/Program.cs":
							"namespace Demo { public static class Program { public static void Main(string[] args) {} } }\n",
					},
					subject: "src/Program.cs",
					role: { kind: "entry", how: "main", main: "Main" },
				},
				rust: {
					files: { "src/main.rs": "fn main() {}\n" },
					subject: "src/main.rs",
				},
				kotlin: {
					files: { "src/Main.kt": "package app\n\nfun main() {}\n" },
					subject: "src/Main.kt",
				},
			},
		},
		{
			id: "a-run-as-program-guard-is-an-entry",
			tier: "fileRoles",
			about: "Code under a run-as-program guard makes the file an entry.",
			role: { kind: "entry", how: "guardedMain" },
			fixtures: {
				typescript: {
					files: { "src/cli.ts": "export function run(): void {}\nif (import.meta.main) run();\n" },
					subject: "src/cli.ts",
				},
				python: {
					files: { "src/cli.py": 'def run():\n    pass\n\n\nif __name__ == "__main__":\n    run()\n' },
					subject: "src/cli.py",
				},
			},
		},
		{
			id: "a-commonjs-main-guard-is-an-entry",
			tier: "fileRoles",
			about: "CommonJS spells the run-as-program guard `require.main === module`.",
			role: { kind: "entry", how: "guardedMain" },
			fixtures: {
				typescript: {
					files: { "src/cli.cjs": "function run() {}\nif (require.main === module) run();\n" },
					subject: "src/cli.cjs",
				},
			},
		},
		{
			id: "a-guard-else-runs-on-import",
			tier: "fileRoles",
			about: "The else of a run-as-program guard runs whenever the file is imported, so code there makes the file a top-level entry.",
			role: { kind: "entry", how: "topLevel" },
			fixtures: {
				typescript: {
					files: {
						"src/cli.cjs": "function run() {}\nif (require.main === module) run();\nelse initialize();\n",
					},
					subject: "src/cli.cjs",
				},
				python: {
					files: {
						"src/cli.py":
							'def run():\n    pass\n\n\nif __name__ == "__main__":\n    run()\nelse:\n    initialize()\n',
					},
					subject: "src/cli.py",
				},
			},
		},
		{
			id: "statements-that-run-on-load-make-an-entry",
			tier: "fileRoles",
			about: "A statement outside any declaration runs on load and makes the file an entry.",
			role: { kind: "entry", how: "topLevel" },
			fixtures: {
				typescript: {
					files: { "src/script.ts": 'console.log("hello");\n' },
					subject: "src/script.ts",
				},
				python: {
					files: { "src/script.py": 'print("hello")\n' },
					subject: "src/script.py",
				},
				bash: {
					files: { "src/script.sh": 'greet() {\n  echo "$1"\n}\ngreet hello\n' },
					subject: "src/script.sh",
				},
			},
		},
		{
			id: "an-entry-candidate-the-provider-cannot-decide-is-unknown",
			tier: "fileRoles",
			about: "A candidate entry the provider's project model cannot place reads unknown, with a reason.",
			role: { kind: "unknown", reason: "NotImplemented" },
			fixtures: {
				rust: {
					files: { "src/lib.rs": "pub fn add() {}\n", "src/bin/tool.rs": "fn main() {}\n" },
					subject: "src/bin/tool.rs",
				},
				csharp: {
					files: { "src/Program.cs": 'System.Console.WriteLine("hello");\n' },
					subject: "src/Program.cs",
				},
			},
		},
	];
}
