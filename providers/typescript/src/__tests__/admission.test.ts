import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { harness } from "./harness.js";

////////////////////////////////
//  Helpers

const roots: string[] = [];

const CART = {
	"src/cart.ts": "export function add(left: number, right: number) { return left + right; }\n",
	"src/use.ts": 'import { add } from "./cart";\nexport const total = add(1, 2);\n',
};

function workspace(files: Record<string, string>): string {
	const root = mkdtempSync(path.join(tmpdir(), "lexicon-typescript-admission-"));
	roots.push(root);
	for (const [module, text] of Object.entries(files)) {
		const full = path.join(root, module);
		mkdirSync(path.dirname(full), { recursive: true });
		writeFileSync(full, text);
	}
	return root;
}

function verdict(provider: ReturnType<typeof harness>, module: string, hash: string, refusal?: string): void {
	provider.handlers.moduleAdmission?.({
		module,
		contentHash: hash,
		outcome: refusal === undefined ? { status: "admitted" } : { status: "refused", reason: refusal },
	});
}

function settle(
	provider: ReturnType<typeof harness>,
	module: string,
	text: string,
	hash: string,
	refusal?: string,
): void {
	provider.handlers.parseFile({ module, contentHash: hash, text });
	verdict(provider, module, hash, refusal);
}

function addBinding(provider: ReturnType<typeof harness>) {
	const facts = provider.parseFile({
		module: "src/use.ts",
		contentHash: "use",
		text: CART["src/use.ts"],
	});
	const reference = facts.references.find((candidate) => candidate.name === "add" && candidate.role !== "import");
	if (reference === undefined) throw new Error("use.ts does not reference add");
	return reference.binding;
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

////////////////////////////////
//  Tests

describe("a use follows what the index holds, not what the parse emitted", () => {
	it("stops binding into a module the index forgot, and binds again once a parse is admitted", () => {
		const provider = harness();
		provider.initialize(workspace(CART));
		settle(provider, "src/cart.ts", CART["src/cart.ts"], "cart-1");
		expect(addBinding(provider).status).toBe("bound");

		provider.forgetModule({ module: "src/cart.ts" });
		const withheld = addBinding(provider);
		expect(withheld.status).toBe("unbound");
		expect(withheld.status === "unbound" ? withheld.reason : undefined).toBe("NotIndexed");

		settle(provider, "src/cart.ts", CART["src/cart.ts"], "cart-2");
		expect(addBinding(provider).status).toBe("bound");
	});

	it("never binds into a file the core would refuse, before the core has parsed it", () => {
		const bindingInto = (files: Record<string, string>, user: string, name: string) => {
			const provider = harness();
			provider.initialize(workspace(files));
			const text = files[user] as string;
			const reference = provider
				.parseFile({ module: user, contentHash: user, text })
				.references.find((candidate) => candidate.name === name && candidate.role !== "import");
			const binding = reference?.binding;
			return binding?.status === "unbound" ? binding.reason : binding?.status;
		};

		expect({
			typescript: bindingInto(
				{ ...CART, "src/cart.ts": `${CART["src/cart.ts"]}const broken = ;\n` },
				"src/use.ts",
				"add",
			),
			annotatedJavaScript: bindingInto(
				{
					"src/cart.js": "export function add(left: number, right) { return left + right; }\n",
					"src/use.js": 'import { add } from "./cart.js";\nexport const total = add(1, 2);\n',
				},
				"src/use.js",
				"add",
			),
			plainJavaScript: bindingInto(
				{
					"src/cart.js": "export function add(left, right) { return left + right; }\n",
					"src/use.js": 'import { add } from "./cart.js";\nexport const total = add(1, 2);\n',
				},
				"src/use.js",
				"add",
			),
			malformedBundle: bindingInto(
				{
					"src/bundle.min.js": "export function run(){return 1}\nexport const x=(;",
					"src/use.js": 'import { run } from "./bundle.min.js";\nexport const value = run();\n',
				},
				"src/use.js",
				"run",
			),
		}).toEqual({
			typescript: "NotIndexed",
			annotatedJavaScript: "NotIndexed",
			plainJavaScript: "bound",
			malformedBundle: "NotIndexed",
		});
	});

	it("answers a probe from the candidate, then binds into what the index holds, never the candidate or the disk", () => {
		const root = workspace(CART);
		const provider = harness();
		provider.initialize(root);
		const handlers = provider.handlers;
		settle(provider, "src/cart.ts", CART["src/cart.ts"], "cart-1");
		// The index verdict is pending during the probe.
		writeFileSync(path.join(root, "src/cart.ts"), "export function renamed() {}\n");
		handlers.parseFile({ module: "src/cart.ts", contentHash: "cart-2", text: "export function renamed() {}\n" });
		const probed = handlers.probeFile({
			module: "src/cart.ts",
			contentHash: "probe",
			text: "export const x = 1;\n",
		});
		verdict(provider, "src/cart.ts", "cart-2", "refused");

		expect({
			candidate: probed.declarations.map((declaration) => declaration.name),
			add: addBinding(provider).status,
		}).toEqual({ candidate: ["x"], add: "bound" });
	});

	it("drops the Program root a probe gave a file outside the project, before and after the analyzer exists", () => {
		const ambient = "interface GlobalThing { value: string }\n";
		const use = "export const value: GlobalThing = { value: 'x' };\n";
		const files = {
			"tsconfig.json": JSON.stringify({ include: ["src/**/*.ts"] }),
			"src/use.ts": use,
			"loose.d.ts": ambient,
		};
		const answers = [false, true].map((warm) => {
			const provider = harness();
			provider.initialize(workspace(files));
			if (warm) provider.parseFile({ module: "src/use.ts", contentHash: "use", text: use });
			const rootsBefore = provider.provider.store.get("root").length;
			provider.handlers.probeFile({ module: "loose.d.ts", contentHash: "probe", text: ambient });
			const bound = provider
				.parseFile({ module: "src/use.ts", contentHash: "use", text: use })
				.references.find((reference) => reference.name === "GlobalThing")?.binding.status;
			return { roots: provider.provider.store.get("root").length - rootsBefore, bound };
		});

		expect(answers).toEqual([
			{ roots: 0, bound: "unbound" },
			{ roots: 0, bound: "unbound" },
		]);
	});

	it("refuses to resolve an import into a module the index holds nothing for", () => {
		const provider = harness();
		provider.initialize(workspace(CART));
		settle(provider, "src/cart.ts", CART["src/cart.ts"], "cart-1");
		expect(provider.resolveImport({ fromModule: "src/use.ts", specifier: "./cart" })).toMatchObject({
			status: "resolved",
			module: "src/cart.ts",
		});

		provider.forgetModule({ module: "src/cart.ts" });
		const after = provider.resolveImport({ fromModule: "src/use.ts", specifier: "./cart" });
		expect(after.status).toBe("unresolved");
		expect(after.status === "unresolved" ? after.reason : undefined).toBe("NotIndexed");
	});

	it("parses its own bytes after a refusal dropped the module's text", () => {
		const provider = harness();
		provider.initialize(workspace({ "src/thing.ts": "export function base() {}\n" }));
		settle(provider, "src/thing.ts", "export function alpha() {}\n", "alpha", "refused");

		const facts = provider.parseFile({
			module: "src/thing.ts",
			contentHash: "beta",
			text: "export function beta() {}\n",
		});
		const names = facts.declarations.map((declaration) => declaration.name);
		expect(names).toContain("beta");
		expect(names).not.toContain("alpha");
	});

	it("parses its own bytes when a refusal dropped the text and the file then changed on disk", () => {
		const root = workspace({
			"src/thing.ts": "export function base() {}\n",
			"src/other.ts": "export const other = 1;\n",
		});
		const provider = harness();
		provider.initialize(root);
		settle(provider, "src/thing.ts", "export function base() {}\n", "base", "refused");
		// Disk supplies text after the refusal.
		provider.parseFile({ module: "src/other.ts", contentHash: "other", text: "export const other = 1;\n" });

		writeFileSync(path.join(root, "src/thing.ts"), "export function renamed() {}\n");
		const facts = provider.parseFile({
			module: "src/thing.ts",
			contentHash: "renamed",
			text: "export function renamed() {}\n",
		});
		expect(facts.declarations.map((declaration) => declaration.name)).toContain("renamed");
	});
});

describe("a parse answers for the bytes it carries", () => {
	it("parses the bytes it is handed after the Program read the file from disk and the file then changed", () => {
		const root = workspace(CART);
		const provider = harness();
		provider.initialize(root);
		// Build before changing cart.ts on disk.
		provider.parseFile({ module: "src/use.ts", contentHash: "use", text: CART["src/use.ts"] });

		const grown = `${CART["src/cart.ts"]}export class Marker {}\n`;
		writeFileSync(path.join(root, "src/cart.ts"), grown);
		const facts = provider.parseFile({ module: "src/cart.ts", contentHash: "cart-grown", text: grown });
		expect(facts.declarations.map((declaration) => declaration.name)).toContain("Marker");
	});

	it("parses the bytes it is handed rather than the newer bytes on disk", () => {
		const root = workspace(CART);
		const provider = harness();
		provider.initialize(root);
		provider.parseFile({ module: "src/use.ts", contentHash: "use", text: CART["src/use.ts"] });

		writeFileSync(path.join(root, "src/cart.ts"), `${CART["src/cart.ts"]}export class Newer {}\n`);
		const handed = `${CART["src/cart.ts"]}export class Handed {}\n`;
		const facts = provider.parseFile({ module: "src/cart.ts", contentHash: "cart-handed", text: handed });
		const names = facts.declarations.map((declaration) => declaration.name);
		expect(names).toContain("Handed");
		expect(names).not.toContain("Newer");
	});

	it("parses new disk text after a refused overlay was dropped and the Program read the disk again", () => {
		const root = workspace(CART);
		const provider = harness();
		provider.initialize(root);
		// First refusal leaves disk text as the fallback.
		settle(provider, "src/cart.ts", `${CART["src/cart.ts"]}export class Refused {}\n`, "cart-refused", "refused");

		const grown = `${CART["src/cart.ts"]}export class Grown {}\n`;
		writeFileSync(path.join(root, "src/cart.ts"), grown);
		// Disk supplies text after the refusal.
		provider.parseFile({ module: "src/use.ts", contentHash: "use", text: CART["src/use.ts"] });

		const facts = provider.parseFile({ module: "src/cart.ts", contentHash: "cart-grown", text: grown });
		const names = facts.declarations.map((declaration) => declaration.name);
		expect(names).toContain("Grown");
		expect(names).not.toContain("Refused");
	});

	it("builds the Program once for a parse of changed text after an invalidation left none built", () => {
		const root = workspace(CART);
		const provider = harness();
		provider.initialize(root);
		// First parse builds; refusal drops held text and invalidates.
		settle(provider, "src/cart.ts", `${CART["src/cart.ts"]}export class Refused {}\n`, "cart-refused", "refused");

		const grown = `${CART["src/cart.ts"]}export class Grown {}\n`;
		writeFileSync(path.join(root, "src/cart.ts"), grown);
		provider.parseFile({ module: "src/cart.ts", contentHash: "cart-grown", text: grown });
		// Stats access builds the invalidated Program.
		expect(provider.programStats().programGenerations).toBe(2);
	});
});
