// Renames through the daemon's handlers with the real TypeScript and Python providers, over files the
// test writes.

import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RenamePlan, ResponseOf } from "@nyaa-lexicon/protocol";
import { rethrown } from "@nyaa-lexicon/protocol/rejection";
import { createDispatch, daemonHandlers } from "../dispatch";
import { recoverSteps } from "../refactorStep";
import { LexiconService } from "../service";
import { sourceReader } from "../sourceRead";
import type { Gate } from "../stepRunners";
import { IndexStore } from "../store";
import { ProviderSupervisor } from "../supervisor";
import { TransactionManager } from "../transactions";

////////////////////////////////
//  Helpers

const PROVIDERS = path.join(import.meta.dirname, "..", "..", "..", "providers");

const TSCONFIG = JSON.stringify({
	compilerOptions: { module: "esnext", moduleResolution: "bundler", strict: true },
	include: ["src"],
});

let root: string;
let store: IndexStore;
let supervisor: ProviderSupervisor;
let service: LexiconService;
let transactions: TransactionManager;
let dispatch: ReturnType<typeof createDispatch>;
/** Every file as the test wrote it. */
let written: Record<string, string>;

function read(module: string): string {
	return readFileSync(path.join(root, module), "utf8");
}

function put(module: string, text: string): void {
	mkdirSync(path.dirname(path.join(root, module)), { recursive: true });
	writeFileSync(path.join(root, module), text);
}

/** Every written file that no longer reads as written, with its text now. */
function changed(): Record<string, string> {
	return Object.fromEntries(
		Object.keys(written)
			.filter((module) => read(module) !== written[module])
			.map((module) => [module, read(module)]),
	);
}

/** Writes the files, starts one provider, indexes every file it claims and opens a refactor unless told not to. */
async function workspace(language: "typescript" | "python", files: Record<string, string>, open = true): Promise<void> {
	root = mkdtempSync(path.join(tmpdir(), `lexicon-rename-${language}-`));
	written = files;
	for (const [module, text] of Object.entries(files)) put(module, text);
	store = IndexStore.open(path.join(root, "index.sqlite")).store;
	supervisor = new ProviderSupervisor();
	const main = path.join(PROVIDERS, language, "src", "main.ts");
	await supervisor.start({ command: [process.execPath, "run", main], timeoutMs: 30_000 }, root);
	service = new LexiconService(store, supervisor, sourceReader(root), root);
	transactions = new TransactionManager(store, root);
	dispatch = createDispatch(service, { transactions });
	const extension = language === "typescript" ? ".ts" : ".py";
	for (const module of Object.keys(files).filter((name) => name.endsWith(extension))) {
		await service.indexFile(module);
	}
	if (open) await dispatch("refactorStart", {});
}

function idOf(name: string, module: string, kind?: string): string {
	const found = service
		.findByName(name, module)
		.find((symbol) => symbol.module === module && (kind === undefined || symbol.kind === kind));
	if (found === undefined) throw new Error(`${module} declares no ${name}`);
	return found.symbolId;
}

async function rename(symbolId: string, newName: string, stops?: string[]) {
	return (await dispatch("refactorRename", {
		symbolId,
		newName,
		...(stops === undefined ? {} : { stops }),
	})) as ResponseOf<"refactorRename">;
}

/** The stoppable export edge in `module`. */
async function stopIn(symbolId: string, newName: string, module: string): Promise<string> {
	const plan = (await dispatch("prepareRename", { symbolId, newName })) as RenamePlan;
	const edge = plan.routes.edges.find((candidate) => candidate.from === module && "stoppable" in candidate);
	if (edge === undefined) throw new Error(`no stoppable edge in ${module}`);
	return edge.id;
}

/** A rename as its own committed refactor, over the bases its preview showed. */
async function committed(symbolId: string, newName: string, stops?: string[]) {
	const request = { symbolId, newName, ...(stops === undefined ? {} : { stops }) };
	const shown = (await dispatch("renameEdits", request)) as ResponseOf<"renameEdits">;
	if (!shown.ok) throw new Error(shown.reason);
	const bases = shown.files.map(({ module, contentHash }) => ({ module, contentHash }));
	return (await dispatch("refactorRenameCommitted", { ...request, bases })) as ResponseOf<"refactorRenameCommitted">;
}

function distinct(values: string[]): string[] {
	return [...new Set(values)];
}

async function eventually(done: () => boolean): Promise<boolean> {
	for (let tries = 0; tries < 400 && !done(); tries++) await Bun.sleep(10);
	return done();
}

/** What `module`'s references to `name` bind to. */
function targetsIn(module: string, name: string): string[] {
	return store
		.referencesIn(module)
		.filter((reference) => reference.name === name)
		.map((reference) => reference.targetId ?? "unbound");
}

afterEach(() => {
	supervisor?.stopAll();
	store?.close();
	if (root !== undefined) rmSync(root, { recursive: true, force: true });
});

////////////////////////////////
//  Tests

describe("a TypeScript rename through the daemon's handlers", () => {
	const CART = "export function total() {\n\treturn 1;\n}\n";
	const RENAMED = "export function amount() {\n\treturn 1;\n}\n";

	it("renames through a barrel's alias and leaves the barrel's own name and its consumers", async () => {
		await workspace("typescript", {
			"tsconfig.json": TSCONFIG,
			"src/cart.ts": CART,
			"src/barrel.ts": 'export { total as sum } from "./cart";\n\nexport function total() {\n\treturn 2;\n}\n',
			"src/use.ts": 'import { sum, total } from "./barrel";\n\nexport const n = sum() + total();\n',
		});

		expect(await rename(idOf("total", "src/cart.ts"), "amount")).toMatchObject({ renamed: true });
		expect(changed()).toEqual({
			"src/cart.ts": RENAMED,
			"src/barrel.ts": 'export { amount as sum } from "./cart";\n\nexport function total() {\n\treturn 2;\n}\n',
		});
	});

	it("leaves a default import spelled as the old name", async () => {
		await workspace("typescript", {
			"tsconfig.json": TSCONFIG,
			"src/cart.ts": "export default function total() {\n\treturn 1;\n}\n",
			"src/use.ts": 'import total from "./cart";\n\nexport const n = total();\n',
		});

		expect(await rename(idOf("total", "src/cart.ts"), "amount")).toMatchObject({ renamed: true });
		expect(changed()).toEqual({ "src/cart.ts": "export default function amount() {\n\treturn 1;\n}\n" });
	});

	it("follows a barrel of barrels and an `as default`, and not a star an explicit export shadows", async () => {
		await workspace("typescript", {
			"tsconfig.json": TSCONFIG,
			"src/cart.ts": CART,
			"src/inner.ts": 'export * from "./cart";\n',
			"src/outer.ts": 'export * from "./inner";\n',
			"src/shadow.ts": 'export * from "./cart";\n\nexport function total() {\n\treturn 3;\n}\n',
			"src/fallback.ts": 'export { total as default } from "./cart";\n',
			"src/use.ts": [
				'import fallback from "./fallback";',
				'import { total } from "./outer";',
				'import { total as shadowed } from "./shadow";',
				"",
				"export const n = total() + shadowed() + fallback();",
				"",
			].join("\n"),
		});

		expect(await rename(idOf("total", "src/cart.ts"), "amount")).toMatchObject({ renamed: true });
		expect(changed()).toEqual({
			"src/cart.ts": RENAMED,
			"src/fallback.ts": 'export { amount as default } from "./cart";\n',
			"src/use.ts": [
				'import fallback from "./fallback";',
				'import { amount } from "./outer";',
				'import { total as shadowed } from "./shadow";',
				"",
				"export const n = amount() + shadowed() + fallback();",
				"",
			].join("\n"),
		});
	});

	describe("a value beside a type of the same name", () => {
		const VALUES = "export const Total = 1;\n\nexport interface Total {\n\tn: number;\n}\n";
		const TYPED = 'import type { Total } from "./barrel";\n\nexport const t: Total = { n: 1 };\n';

		it("renames the value read as a namespace member, and leaves a type-only re-export", async () => {
			await workspace("typescript", {
				"tsconfig.json": TSCONFIG,
				"src/values.ts": VALUES,
				"src/barrel.ts": 'export type { Total } from "./values";\n',
				"src/typed.ts": TYPED,
				"src/valued.ts": 'import * as values from "./values";\n\nexport const v = values.Total + 1;\n',
			});

			expect(await rename(idOf("Total", "src/values.ts", "constant"), "Sum")).toMatchObject({ renamed: true });
			expect(changed()).toEqual({
				"src/values.ts": "export const Sum = 1;\n\nexport interface Total {\n\tn: number;\n}\n",
				"src/valued.ts": 'import * as values from "./values";\n\nexport const v = values.Sum + 1;\n',
			});
		});

		it("renames a namespace member read through the namespace import, past a type of the namespace's name", async () => {
			await workspace("typescript", {
				"tsconfig.json": TSCONFIG,
				"src/values.ts":
					"export namespace Total {\n\texport const n = 1;\n}\n\nexport interface Total {\n\tm: number;\n}\n",
				"src/use.ts": 'import * as values from "./values";\n\nexport const k = values.Total.n + 1;\n',
			});

			expect(await rename(idOf("n", "src/values.ts"), "count")).toMatchObject({ renamed: true });
			expect(changed()).toEqual({
				"src/values.ts":
					"export namespace Total {\n\texport const count = 1;\n}\n\nexport interface Total {\n\tm: number;\n}\n",
				"src/use.ts": 'import * as values from "./values";\n\nexport const k = values.Total.count + 1;\n',
			});
		});

		it("refuses where one re-export carries both", async () => {
			await workspace("typescript", {
				"tsconfig.json": TSCONFIG,
				"src/values.ts": VALUES,
				"src/barrel.ts": 'export { Total } from "./values";\n',
				"src/typed.ts": TYPED,
			});

			expect(await rename(idOf("Total", "src/values.ts", "constant"), "Sum")).toMatchObject({
				renamed: false,
				issues: expect.arrayContaining([expect.objectContaining({ kind: "NameTaken" })]),
			});
			expect(changed()).toEqual({});
		});
	});

	it("renames a member read through `import x = require()`", async () => {
		await workspace("typescript", {
			"tsconfig.json": JSON.stringify({
				compilerOptions: { module: "commonjs", strict: true },
				include: ["src"],
			}),
			"src/cart.ts": CART,
			"src/use.ts": 'import cart = require("./cart");\n\nexport const n = cart.total();\n',
		});

		expect(await rename(idOf("total", "src/cart.ts"), "amount")).toMatchObject({ renamed: true });
		expect(changed()).toEqual({
			"src/cart.ts": RENAMED,
			"src/use.ts": 'import cart = require("./cart");\n\nexport const n = cart.amount();\n',
		});
	});

	it("edits named, aliased and namespace consumers of one barrel, and not a same-named import from elsewhere", async () => {
		await workspace("typescript", {
			"tsconfig.json": TSCONFIG,
			"src/cart.ts": CART,
			"src/other.ts": "export function total() {\n\treturn 2;\n}\n",
			"src/barrel.ts": 'export * from "./cart";\n',
			"src/named.ts": 'import { total } from "./barrel";\n\nexport const a = total();\n',
			"src/aliased.ts": 'import { total as t } from "./barrel";\n\nexport const b = t();\n',
			"src/spaced.ts": 'import * as shop from "./barrel";\n\nexport const c = shop.total();\n',
			"src/unrelated.ts": 'import { total } from "./other";\n\nexport const d = total();\n',
		});

		expect(await rename(idOf("total", "src/cart.ts"), "amount")).toMatchObject({ renamed: true });
		expect(changed()).toEqual({
			"src/cart.ts": RENAMED,
			"src/named.ts": 'import { amount } from "./barrel";\n\nexport const a = amount();\n',
			"src/aliased.ts": 'import { amount as t } from "./barrel";\n\nexport const b = t();\n',
			"src/spaced.ts": 'import * as shop from "./barrel";\n\nexport const c = shop.amount();\n',
		});
	});
});

describe("settling a TypeScript rename", () => {
	const CART = "export function total() {\n\treturn 1;\n}\n";
	const RENAMED = "export function amount() {\n\treturn 1;\n}\n";

	for (const operation of ["refactorUndo", "refactorRevert"] as const) {
		it(`${operation} puts a consumer through an unchanged star barrel back on the declaration`, async () => {
			await workspace("typescript", {
				"tsconfig.json": TSCONFIG,
				"src/cart.ts": CART,
				"src/barrel.ts": 'export * from "./cart";\n',
				"src/use.ts": 'import { total } from "./barrel";\n\nexport const n = total();\n',
			});
			const total = idOf("total", "src/cart.ts");
			expect(await rename(total, "amount")).toMatchObject({ renamed: true });
			expect(distinct(targetsIn("src/use.ts", "amount"))).toEqual([idOf("amount", "src/cart.ts")]);

			const restored =
				operation === "refactorUndo"
					? await dispatch("refactorUndo", {})
					: await dispatch("refactorRevert", { drifted: transactions.status().drifted });

			expect(restored).not.toHaveProperty("issues");
			expect(changed()).toEqual({});
			expect(distinct(targetsIn("src/use.ts", "total"))).toEqual([total]);
		});
	}

	const STOPPED = {
		"tsconfig.json": TSCONFIG,
		"src/cart.ts": CART,
		"src/barrel.ts": 'export { total } from "./cart";\n',
		"src/use.ts": 'import { total } from "./barrel";\n\nexport const n = total();\n',
		"src/direct.ts": 'import { total } from "./cart";\n\nexport const m = total();\n',
	};
	const FORWARD = {
		"src/cart.ts": RENAMED,
		"src/barrel.ts": 'export { amount as total } from "./cart";\n',
		"src/direct.ts": 'import { amount } from "./cart";\n\nexport const m = amount();\n',
	};

	it("keeps a stopped re-export's consumers bound through it, and undo puts every byte back", async () => {
		await workspace("typescript", STOPPED);
		const total = idOf("total", "src/cart.ts");
		const stop = await stopIn(total, "amount", "src/barrel.ts");

		expect(await rename(total, "amount", [stop])).toMatchObject({ renamed: true, stops: [stop] });
		expect(changed()).toEqual(FORWARD);
		expect(distinct(targetsIn("src/use.ts", "total"))).toEqual([idOf("amount", "src/cart.ts")]);
		expect(await dispatch("refactorUndo", {})).toMatchObject({ undone: true });
		expect(changed()).toEqual({});
		expect(distinct(targetsIn("src/use.ts", "total"))).toEqual([total]);
	});

	it("reverses a committed stopped rename byte for byte, collapsing the alias it wrote", async () => {
		await workspace("typescript", STOPPED, false);
		const total = idOf("total", "src/cart.ts");
		const stop = await stopIn(total, "amount", "src/barrel.ts");
		const forward = await committed(total, "amount", [stop]);
		if (!forward.committed) throw new Error(forward.reason);
		expect(changed()).toEqual(FORWARD);

		const { reverse } = forward;
		if (reverse.kind !== "rename") throw new Error("a rename reverses as a rename");
		expect(await committed(reverse.symbolId, reverse.newName)).toMatchObject({ committed: true });
		expect(changed()).toEqual({});
		expect(distinct(targetsIn("src/use.ts", "total"))).toEqual([total]);
	});

	it("plans again for an importer admitted between its plan and its write, and renames it too", async () => {
		await workspace("typescript", {
			"tsconfig.json": TSCONFIG,
			"src/cart.ts": CART,
			"src/use.ts": 'import { total } from "./cart";\n\nexport const n = total();\n',
		});
		const late = 'import { total } from "./cart";\n\nexport const m = total();\n';
		let holds = 0;
		const gate: Gate = {
			ahead: async (work) => {
				await work;
			},
			read: async (work) => work(),
			write: async (work) => {
				holds += 1;
				if (holds === 1) {
					put("src/late.ts", late);
					written["src/late.ts"] = late;
					await service.indexFile("src/late.ts");
				}
				return work();
			},
		};

		const outcome = await daemonHandlers(service, { transactions }).refactorRename.run(
			{ symbolId: idOf("total", "src/cart.ts"), newName: "amount" },
			gate,
		);

		expect(outcome).toMatchObject({ renamed: true });
		expect(holds).toBe(2);
		expect(changed()).toEqual({
			"src/cart.ts": RENAMED,
			"src/use.ts": 'import { amount } from "./cart";\n\nexport const n = amount();\n',
			"src/late.ts": 'import { amount } from "./cart";\n\nexport const m = amount();\n',
		});
	});

	it("puts a module bound to a re-minted id back on the old id after a crash", async () => {
		await workspace("typescript", {
			"tsconfig.json": TSCONFIG,
			"src/cart.ts": "export class Cart {\n\tadd() {\n\t\treturn 1;\n\t}\n}\n",
			"src/make.ts": 'import { Cart } from "./cart";\n\nexport const make = () => new Cart();\n',
			"src/use.ts": 'import { make } from "./make";\n\nexport const n = make().add();\n',
		});
		const add = idOf("add", "src/cart.ts");
		transactions.rebind = () => {
			throw new Error("died before finalizing");
		};

		expect(await rethrown(rename(idOf("Cart", "src/cart.ts"), "Basket"))).toThrow("died before finalizing");
		expect(distinct(targetsIn("src/use.ts", "add"))).not.toEqual([add]);

		const recovered = await recoverSteps(service, new TransactionManager(store, root));

		expect([...recovered.restored].sort()).toEqual(["src/cart.ts", "src/make.ts"]);
		expect(changed()).toEqual({});
		expect(await eventually(() => distinct(targetsIn("src/use.ts", "add")).join() === add)).toBe(true);
	});
});

describe("a Python rename through the daemon's handlers", () => {
	const PACKAGE = {
		"pkg/__init__.py": 'from .cart import total\n\n__all__ = ["total"]\n',
		"pkg/cart.py": "def total():\n    return 1\n",
		"named.py": "from pkg import total\n\nprint(total())\n",
		"starred.py": "from pkg import *\n\nprint(total())\n",
	};

	it("renames through a package's named forward, its `__all__` and a star import", async () => {
		await workspace("python", PACKAGE);

		expect(await rename(idOf("total", "pkg/cart.py"), "amount")).toMatchObject({ renamed: true });
		expect(changed()).toEqual({
			"pkg/__init__.py": 'from .cart import amount\n\n__all__ = ["amount"]\n',
			"pkg/cart.py": "def amount():\n    return 1\n",
			"named.py": "from pkg import amount\n\nprint(amount())\n",
			"starred.py": "from pkg import *\n\nprint(amount())\n",
		});
	});

	it("keeps the package's name at a stop, for its own uses and `__all__` too", async () => {
		const own = 'from .cart import total\n\n__all__ = ["total"]\n\n\ndef double():\n    return total() * 2\n';
		await workspace("python", { ...PACKAGE, "pkg/__init__.py": own });
		const total = idOf("total", "pkg/cart.py");
		const stop = await stopIn(total, "amount", "pkg/__init__.py");

		expect(await rename(total, "amount", [stop])).toMatchObject({ renamed: true });
		expect(changed()).toEqual({
			"pkg/__init__.py": own.replace("import total", "import amount as total"),
			"pkg/cart.py": "def amount():\n    return 1\n",
		});
	});

	it("refuses where a dynamic `__all__` leaves a star import's use unproved", async () => {
		await workspace("python", {
			...PACKAGE,
			"pkg/__init__.py": 'from .cart import total\n\n__all__ = ["total"]\n__all__.append("total")\n',
		});

		expect(await rename(idOf("total", "pkg/cart.py"), "amount")).toMatchObject({ renamed: false });
		expect(changed()).toEqual({});
	});
});
