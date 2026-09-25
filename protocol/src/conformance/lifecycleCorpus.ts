// Separate from analysis cases: a verdict lands between two parses, so a case is a script.

import { type LifecycleCase, LifecycleCaseSchema } from "./types.js";

////////////////////////////////
//  Constants

const TYPESCRIPT = "typescript";
const PYTHON = "python";
const GDSCRIPT = "gdscript";
const C = "c";
const CPP = "cpp";
const CSHARP = "csharp";
const RUST = "rust";
const KOTLIN = "kotlin";
const BASH = "bash";

/**
 * One workspace per language: `target` declares `name`, `user` uses it across the file boundary.
 *
 * `refusedText` declares something else, so a provider holding the refused parse loses the name.
 */
const FIXTURES = {
	[TYPESCRIPT]: {
		files: {
			"src/cart.ts": "export function add(left: number, right: number) { return left + right; }\n",
			"src/use.ts": 'import { add } from "./cart";\nexport const total = add(1, 2);\n',
		},
		target: "src/cart.ts",
		user: "src/use.ts",
		name: "add",
		refusedText: "export function sum(left: number, right: number) { return left + right; }\n",
	},
	[PYTHON]: {
		files: {
			"cart.py": "def add(left, right):\n    return left + right\n",
			"use.py": "from cart import add\n\ntotal = add(1, 2)\n",
		},
		target: "cart.py",
		user: "use.py",
		name: "add",
		refusedText: "def sum_of(left, right):\n    return left + right\n",
	},
	[KOTLIN]: {
		files: {
			"src/cart/Cart.kt": "package cart\n\nfun add(left: Int, right: Int): Int = left + right\n",
			"src/cart/Run.kt": "package cart\n\nfun run(): Int = add(1, 2)\n",
		},
		target: "src/cart/Cart.kt",
		user: "src/cart/Run.kt",
		name: "add",
		refusedText: "package cart\n\nfun sum(left: Int, right: Int): Int = left + right\n",
	},
	[RUST]: {
		files: {
			"src/cart.rs": "pub fn add(left: i32, right: i32) -> i32 { left + right }\n",
			"src/lib.rs": "mod cart;\nuse crate::cart::add;\n\npub fn run() -> i32 { add(1, 2) }\n",
		},
		target: "src/cart.rs",
		user: "src/lib.rs",
		name: "add",
		refusedText: "pub fn sum(left: i32, right: i32) -> i32 { left + right }\n",
	},
	[C]: {
		files: {
			"src/cart.h": "int add(int left, int right);\n",
			"src/use.c": '#include "cart.h"\n\nint run(void) { return add(1, 2); }\n',
		},
		target: "src/cart.h",
		user: "src/use.c",
		name: "add",
		refusedText: "int sum(int left, int right);\n",
	},
	[CPP]: {
		files: {
			"src/cart.hpp": "int add(int left, int right);\n",
			"src/use.cpp": '#include "cart.hpp"\n\nint run() { return add(1, 2); }\n',
		},
		target: "src/cart.hpp",
		user: "src/use.cpp",
		name: "add",
		refusedText: "int sum(int left, int right);\n",
	},
	// A using directive, not a partial type: a partial member across files answers ambiguous by
	// design, which is not a binding for the case to follow.
	[CSHARP]: {
		files: {
			"src/item.cs": "namespace Outer.Inner; public class Item {}\n",
			"src/use.cs": "using Outer.Inner; namespace Outer { public class Holder { public Item Value; } }\n",
		},
		target: "src/item.cs",
		user: "src/use.cs",
		name: "Item",
		refusedText: "namespace Outer.Inner; public class Crate {}\n",
	},
	[GDSCRIPT]: {
		files: {
			"project.godot": 'config_version=5\n\n[application]\nconfig/name="cart"\n',
			"src/cart.gd": "class_name Cart\nextends Node\n",
			"src/use.gd": "extends Cart\n\n\nfunc run() -> void:\n\tpass\n",
		},
		target: "src/cart.gd",
		user: "src/use.gd",
		name: "Cart",
		refusedText: "class_name Basket\nextends Node\n",
	},
	[BASH]: {
		files: {
			"src/cart.sh": "add() { :; }\n",
			"src/use.sh": "source ./cart.sh\nrun() { add; }\n",
		},
		target: "src/cart.sh",
		user: "src/use.sh",
		name: "add",
		refusedText: "sum() { :; }\n",
	},
};

const CASES = [
	{
		id: "refused-facts-are-not-held",
		about: "The index let a module go and then refused the parse that followed, so it holds nothing for it. A use of that module must not bind, whether the provider kept the refused facts or read them back off disk, and must bind again once a parse is admitted.",
		expect: "notHeld",
		fixtures: FIXTURES,
	},
	{
		id: "a-refusal-keeps-what-was-admitted",
		about: "A refusal leaves the module's previously admitted facts in the index. A provider that replaced them with the refused parse loses a use the index still resolves.",
		expect: "keepsAdmitted",
		fixtures: FIXTURES,
	},
	{
		id: "probes-and-refusals-are-unseen",
		about: "A probe, refusal, rediscovery, rename or move leaves no trace another module can observe. Each paired trial runs in a fresh process beside a control, and parses, binds, imports and types must match. Disk-byte refusals also assert that the user does not bind facts the index never admitted.",
		expect: "unseen",
		fixtures: FIXTURES,
	},
];

////////////////////////////////
//  Functions & Helpers

export function loadLifecycleCases(): LifecycleCase[] {
	return CASES.map((testCase) => LifecycleCaseSchema.parse(testCase));
}
