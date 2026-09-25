// Cases about the source-local role a file has.

import type { ConformanceCase } from "./types.js";

////////////////////////////////
//  Functions & Helpers

export function roleCases(): ConformanceCase[] {
	return [
		{
			id: "a-file-that-only-declares-is-a-library",
			tier: "fileRoles",
			about: "Declarations and their initializers do not make an entry, including a prototype, an instance Main, and a Kotlin main in a class or on a receiver.",
			semanticForm: "declarations-only",
			applicableLanguages: ["typescript", "python", "bash", "c", "cpp", "csharp", "rust", "kotlin"],
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
							'"""Cart helpers."""\n\ndef add(a, b):\n    return a + b\n\n\nclass Cart:\n    pass\n',
					},
					subject: "src/cart.py",
				},
				bash: {
					files: { "src/cart.sh": "add() {\n  echo $(( $1 + $2 ))\n}\n" },
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
			id: "a-header-that-only-declares-is-a-library",
			tier: "fileRoles",
			about: "A header of prototypes, types and inline functions is a library, a main prototype included.",
			semanticForm: "header-declarations-only",
			applicableLanguages: ["c", "cpp"],
			role: { kind: "library" },
			fixtures: {
				c: {
					files: {
						"src/cart.h":
							"#pragma once\nint main(void);\ntypedef struct Cart { int total; } Cart;\nstatic inline int add(int a, int b) { return a + b; }\n",
					},
					subject: "src/cart.h",
				},
				cpp: {
					files: {
						"src/cart.hpp":
							"#pragma once\nint main();\nnamespace cart {\ninline int add(int a, int b) { return a + b; }\n}\n",
					},
					subject: "src/cart.hpp",
				},
			},
		},
		{
			id: "module-setup-is-not-an-entry",
			tier: "fileRoles",
			about: "Assignments used to initialize or export a library stay declarative whatever value they compute.",
			semanticForm: "assignment-setup",
			applicableLanguages: ["typescript", "python", "bash"],
			role: { kind: "library" },
			fixtures: {
				typescript: {
					files: {
						"src/lib.cjs":
							"function add(a, b) {\n\treturn a + b;\n}\nArray.prototype.at = function at(index) {\n\treturn this[index];\n};\nmodule.exports = { add };\nexports.version = 1;\n",
					},
					subject: "src/lib.cjs",
				},
				python: {
					files: {
						"src/lib.py":
							"import logging\n\nlogger = logging.getLogger(__name__)\nVERSION = calculate_version()\n",
					},
					subject: "src/lib.py",
				},
				bash: {
					files: { "src/lib.sh": "STARTED=$(date +%s)\nVERSION=1\n" },
					subject: "src/lib.sh",
				},
			},
		},
		{
			id: "conditional-setup-is-not-an-entry",
			tier: "fileRoles",
			about: "Conditional setup stays declarative when only its branches are considered, including try fallbacks and setup blocks.",
			semanticForm: "conditional-setup",
			applicableLanguages: ["typescript", "python", "bash"],
			role: { kind: "library" },
			fixtures: {
				typescript: {
					files: {
						"src/setup.ts":
							"if (hasFeature()) { Array.prototype.at = function at(index) { return this[index]; }; }\ntry { const optional = loadOptional(); } catch { const fallback = true; } finally { const completed = true; }\n{ const ready = true; }\nsetup: { const enabled = true; }\n",
					},
					subject: "src/setup.ts",
				},
				python: {
					files: {
						"src/setup.py":
							"from typing import TYPE_CHECKING\n\nif TYPE_CHECKING:\n    from collections.abc import Iterable\n\ntry:\n    import ujson as json\nexcept ImportError:\n    import json\n",
					},
					subject: "src/setup.py",
				},
				bash: {
					files: {
						"src/setup.sh": "if test -f ./local.sh; then source ./local.sh; fi\n{ VERSION=1; }\n",
					},
					subject: "src/setup.sh",
				},
			},
		},
		{
			id: "sourced-setup-is-not-an-entry",
			tier: "fileRoles",
			about: "Bash source and dot commands set up a library without making it an entry.",
			semanticForm: "sourced-setup",
			applicableLanguages: ["bash"],
			role: { kind: "library" },
			fixtures: {
				bash: {
					files: { "src/lib.sh": 'source "$(dirname "$0")/common.sh"\n. ./colors.sh\n' },
					subject: "src/lib.sh",
				},
			},
		},
		{
			id: "a-jvm-static-main-in-an-object-is-an-entry",
			tier: "fileRoles",
			about: "A @JvmStatic main in an object is a JVM entry point with its declaration.",
			semanticForm: "jvm-static-main-object",
			applicableLanguages: ["kotlin"],
			role: { kind: "entry", how: "main", main: { name: "main", line: 4 } },
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
			id: "a-jvm-static-main-in-a-companion-object-is-an-entry",
			tier: "fileRoles",
			about: "A @JvmStatic main in a companion object is a JVM entry point with its declaration.",
			semanticForm: "jvm-static-main-companion-object",
			applicableLanguages: ["kotlin"],
			role: { kind: "entry", how: "main", main: { name: "main", line: 5 } },
			fixtures: {
				kotlin: {
					files: {
						"src/App.kt":
							"package app\n\nclass App {\n    companion object {\n        @JvmStatic\n        fun main(args: Array<String>) {}\n    }\n}\n",
					},
					subject: "src/App.kt",
				},
			},
		},
		{
			id: "a-main-the-runtime-calls-is-an-entry",
			tier: "fileRoles",
			about: "A main the runtime calls makes the file an entry, naming that declaration.",
			semanticForm: "runtime-main",
			applicableLanguages: ["c", "cpp", "csharp", "rust", "kotlin"],
			role: { kind: "entry", how: "main", main: { name: "main", line: 0 } },
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
							"namespace Demo {\n\tpublic class Helper { public void Main() {} }\n\tpublic static class Program { public static void Main(string[] args) {} }\n}\n",
					},
					subject: "src/Program.cs",
					role: { kind: "entry", how: "main", main: { name: "Main", line: 2 } },
				},
				rust: {
					files: { "src/main.rs": "fn main() {}\n" },
					subject: "src/main.rs",
				},
				kotlin: {
					files: { "src/Main.kt": "fun main() {}\n" },
					subject: "src/Main.kt",
				},
			},
		},
		{
			id: "a-run-as-program-guard-is-an-entry",
			tier: "fileRoles",
			about: "Code under a run-as-program guard makes the file an entry.",
			semanticForm: "run-as-program-guard",
			applicableLanguages: ["typescript", "python"],
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
			about: "CommonJS spells the run-as-program guard require.main === module.",
			semanticForm: "commonjs-run-as-program-guard",
			applicableLanguages: ["typescript"],
			role: { kind: "entry", how: "guardedMain" },
			fixtures: {
				typescript: {
					files: { "src/cli.cjs": "function run() {}\nif (require.main === module) run();\n" },
					subject: "src/cli.cjs",
				},
			},
		},
		{
			id: "a-guard-nested-in-setup-is-an-entry",
			tier: "fileRoles",
			about: "A run-as-program guard nested in setup remains guardedMain.",
			semanticForm: "run-as-program-guard-nested-in-setup",
			applicableLanguages: ["typescript", "python"],
			role: { kind: "entry", how: "guardedMain" },
			fixtures: {
				typescript: {
					files: { "src/cli.ts": "function run() {}\nif (prepare()) { if (import.meta.main) run(); }\n" },
					subject: "src/cli.ts",
				},
				python: {
					files: {
						"src/cli.py":
							'from typing import TYPE_CHECKING\n\nif TYPE_CHECKING:\n    if __name__ == "__main__":\n        run()\n',
					},
					subject: "src/cli.py",
				},
			},
		},
		{
			id: "a-guard-else-runs-on-import",
			tier: "fileRoles",
			about: "Code in a run-as-program guard else runs on import, making the file a top-level entry.",
			semanticForm: "run-as-program-guard-else-runs",
			applicableLanguages: ["typescript", "python"],
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
			about: "A statement outside declarations that runs on load makes the file a top-level entry.",
			semanticForm: "statements-run-on-load",
			applicableLanguages: ["typescript", "python", "bash"],
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
			about: "A candidate entry the project model cannot place is unknown, with a reason.",
			semanticForm: "unplaceable-entry-candidate",
			applicableLanguages: ["rust", "csharp"],
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
