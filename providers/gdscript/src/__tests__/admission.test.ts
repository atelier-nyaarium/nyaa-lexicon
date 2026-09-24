import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Declaration, handlersFor, moduleOf, type Range } from "@nyaa-lexicon/protocol";
import { GDScriptProvider } from "../main.js";

////////////////////////////////
//  Constants

const PROJECT = 'config_version=5\n\n[application]\nconfig/name="cart"\n';
const CART = "class_name Cart\nextends Node\n";
const CART_WITH_COUNT = "class_name Cart\nextends Node\n\nvar count: int = 1\n";
const CART_WITH_TOTAL = "class_name Cart\nextends Node\n\nvar total: float = 2.0\n";
const CRATE = "class_name Crate\nextends Node\n";
const USE = "extends Cart\n\n\nfunc run() -> void:\n\tpass\n";
const TARGET = "src/cart.gd";
const REFUSAL = { status: "refused", reason: "the index refused these facts" } as const;

////////////////////////////////
//  Helpers

const roots: string[] = [];

function started(cartText: string): { provider: GDScriptProvider; root: string } {
	const root = mkdtempSync(path.join(tmpdir(), "lexicon-gdscript-admission-"));
	roots.push(root);
	for (const [module, text] of Object.entries({
		"project.godot": PROJECT,
		[TARGET]: cartText,
		"src/use.gd": USE,
	})) {
		const full = path.join(root, module);
		mkdirSync(path.dirname(full), { recursive: true });
		writeFileSync(full, text);
	}
	const provider = new GDScriptProvider();
	provider.initialize(root);
	provider.discoverProject(root);
	return { provider, root };
}

/** The index's verdict on a parse, through the kit as the wire delivers it. */
function verdict(provider: GDScriptProvider, contentHash: string, refused = false): void {
	handlersFor(provider).moduleAdmission?.({
		module: TARGET,
		contentHash,
		outcome: refused ? REFUSAL : { status: "admitted" },
	});
}

function settle(provider: GDScriptProvider, contentHash: string, text: string, refused = false) {
	const facts = handlersFor(provider).parseFile({ module: TARGET, contentHash, text });
	verdict(provider, contentHash, refused);
	return facts;
}

/** Where the `Cart` supertype in `src/use.gd` lands. */
function cartBindsInto(provider: GDScriptProvider): string | null {
	const facts = provider.parseFile({ module: "src/use.gd", contentHash: "use", text: USE });
	const reference = facts.references.find((candidate) => candidate.name === "Cart");
	if (reference?.binding.status !== "bound") return null;
	return moduleOf(reference.binding.symbolId);
}

function symbolFor(facts: { declarations: Declaration[] }, name: string): string {
	const declaration = facts.declarations.find((candidate) => candidate.name === name);
	if (declaration === undefined) throw new Error(`no declaration named ${name}`);
	return declaration.symbolId;
}

/** The span selecting `Cart` in its own declaration. */
function cartRange(facts: { declarations: Declaration[] }): Range {
	const range = facts.declarations.find((candidate) => candidate.name === "Cart")?.selectionRange;
	if (range === undefined) throw new Error("the class_name declaration carries no selection range");
	return range;
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

////////////////////////////////
//  Tests

test("forgetModule unregisters the module's class_name", () => {
	const { provider } = started(CART);
	settle(provider, "v1", CART);
	expect(cartBindsInto(provider)).toBe(TARGET);

	provider.forgetModule({ module: TARGET });
	expect(cartBindsInto(provider)).toBeNull();
});

test("a forgotten module does not come back through a read of its own bytes", () => {
	const { provider } = started(CART);
	const range = cartRange(settle(provider, "v1", CART));
	expect(provider.bind({ module: TARGET, name: "Cart", range }).status).toBe("bound");

	provider.forgetModule({ module: TARGET });
	expect(provider.bind({ module: TARGET, name: "Cart", range }).status).toBe("unbound");
	expect(cartBindsInto(provider)).toBeNull();
});

test("a fresh workspace reads a module the previous one forgot", () => {
	const { provider, root } = started(CART);
	const range = cartRange(settle(provider, "v1", CART));
	provider.forgetModule({ module: TARGET });

	provider.initialize(root);
	provider.discoverProject(root);
	expect(provider.bind({ module: TARGET, name: "Cart", range }).status).toBe("bound");
});

test("a refusal puts back the module's type facts, not only its bindings", () => {
	const { provider } = started(CART_WITH_COUNT);
	const facts = settle(provider, "v1", CART_WITH_COUNT);
	const count = symbolFor(facts, "count");
	expect(provider.typeOf({ symbolId: count }).status).toBe("known");

	settle(provider, "v2", CART, true);
	expect(provider.typeOf({ symbolId: count }).status).toBe("known");
});

test("answers a probe from the candidate, then from what the index holds, never the candidate or the disk", () => {
	const { provider, root } = started(CART_WITH_COUNT);
	const handlers = handlersFor(provider);
	const count = symbolFor(settle(provider, "old", CART_WITH_COUNT), "count");
	// The file changed on disk and its parse is outstanding across the probe.
	writeFileSync(path.join(root, TARGET), CRATE);
	handlers.parseFile({ module: TARGET, contentHash: "disk", text: CRATE });
	const probed = handlers.probeFile({ module: TARGET, contentHash: "probe", text: CART_WITH_TOTAL });
	const total = symbolFor(probed, "total");
	const answers = () => ({
		cart: cartBindsInto(provider),
		count: provider.typeOf({ symbolId: count }).status,
		total: provider.typeOf({ symbolId: total }).status,
	});
	const staged = answers();
	verdict(provider, "disk", true);

	expect({
		candidate: probed.declarations.map((declaration) => declaration.name),
		staged,
		refused: answers(),
	}).toEqual({
		candidate: ["Cart", "total"],
		staged: { cart: null, count: "unknown", total: "unknown" },
		refused: { cart: TARGET, count: "known", total: "unknown" },
	});
});

test("a forgotten module's types do not come back through a read of its own bytes", () => {
	const { provider } = started(CART_WITH_COUNT);
	const count = symbolFor(settle(provider, "v1", CART_WITH_COUNT), "count");
	expect(provider.typeOf({ symbolId: count }).status).toBe("known");

	provider.forgetModule({ module: TARGET });
	expect(provider.typeOf({ symbolId: count }).status).toBe("unknown");
});
