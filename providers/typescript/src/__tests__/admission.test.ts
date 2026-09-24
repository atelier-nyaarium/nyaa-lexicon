import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { TypeScriptProvider } from "../main";

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

/** Parses the target and settles the index's verdict on it. */
function settle(provider: TypeScriptProvider, module: string, text: string, hash: string, refusal?: string): void {
	provider.parseFile({ module, contentHash: hash, text });
	provider.moduleAdmission({
		module,
		contentHash: hash,
		outcome: refusal === undefined ? { status: "admitted" } : { status: "refused", reason: refusal },
	});
}

/** Where `add` lands when `src/use.ts` is parsed now. */
function addBinding(provider: TypeScriptProvider) {
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
		const provider = new TypeScriptProvider();
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

	it("stages nothing for a probe, so a later refusal still puts back what the index held", () => {
		const provider = new TypeScriptProvider();
		provider.initialize(workspace(CART));
		settle(provider, "src/cart.ts", CART["src/cart.ts"], "cart-1");
		// A candidate and its restore, as a cursor on unsaved text asks.
		provider.parseFile({ module: "src/cart.ts", contentHash: "probe", text: "export const x = 1;\n", probe: true });
		provider.parseFile({ module: "src/cart.ts", contentHash: "cart-1", text: CART["src/cart.ts"], probe: true });
		settle(provider, "src/cart.ts", "export function renamed() {}\n", "cart-2", "refused");

		expect(addBinding(provider).status).toBe("bound");
	});

	it("refuses to resolve an import into a module the index holds nothing for", () => {
		const provider = new TypeScriptProvider();
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
		const provider = new TypeScriptProvider();
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
		const provider = new TypeScriptProvider();
		provider.initialize(root);
		settle(provider, "src/thing.ts", "export function base() {}\n", "base", "refused");
		// Reads the Program back while only the disk answers for the dropped module.
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
		const provider = new TypeScriptProvider();
		provider.initialize(root);
		// Builds the Program, which reads cart.ts off the disk as it stands now.
		provider.parseFile({ module: "src/use.ts", contentHash: "use", text: CART["src/use.ts"] });

		const grown = `${CART["src/cart.ts"]}export class Marker {}\n`;
		writeFileSync(path.join(root, "src/cart.ts"), grown);
		const facts = provider.parseFile({ module: "src/cart.ts", contentHash: "cart-grown", text: grown });
		expect(facts.declarations.map((declaration) => declaration.name)).toContain("Marker");
	});

	it("parses the bytes it is handed rather than the newer bytes on disk", () => {
		const root = workspace(CART);
		const provider = new TypeScriptProvider();
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
		const provider = new TypeScriptProvider();
		provider.initialize(root);
		// A refused first parse has no text to put back, so the module drops to the disk.
		settle(provider, "src/cart.ts", `${CART["src/cart.ts"]}export class Refused {}\n`, "cart-refused", "refused");

		const grown = `${CART["src/cart.ts"]}export class Grown {}\n`;
		writeFileSync(path.join(root, "src/cart.ts"), grown);
		// Reads the Program back while only the disk answers for the dropped module.
		provider.parseFile({ module: "src/use.ts", contentHash: "use", text: CART["src/use.ts"] });

		const facts = provider.parseFile({ module: "src/cart.ts", contentHash: "cart-grown", text: grown });
		const names = facts.declarations.map((declaration) => declaration.name);
		expect(names).toContain("Grown");
		expect(names).not.toContain("Refused");
	});

	it("builds the Program once for a parse of changed text after an invalidation left none built", () => {
		const root = workspace(CART);
		const provider = new TypeScriptProvider();
		provider.initialize(root);
		// The refused parse builds once; the refusal drops the overlay and invalidates without building.
		settle(provider, "src/cart.ts", `${CART["src/cart.ts"]}export class Refused {}\n`, "cart-refused", "refused");

		const grown = `${CART["src/cart.ts"]}export class Grown {}\n`;
		writeFileSync(path.join(root, "src/cart.ts"), grown);
		provider.parseFile({ module: "src/cart.ts", contentHash: "cart-grown", text: grown });
		// Read after the parse, since reading the stats builds whatever is invalidated.
		expect(provider.programStats().programGenerations).toBe(2);
	});
});
