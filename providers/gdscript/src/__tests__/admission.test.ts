import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Declaration, handlersFor, moduleOf, PROTOCOL_VERSION, type Range } from "@nyaa-lexicon/protocol";
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

function started(cartText: string) {
	const root = mkdtempSync(path.join(tmpdir(), "lexicon-gdscript-store-"));
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
	const handlers = handlersFor(provider);
	handlers.initialize({ workspaceRoot: root, protocolVersion: PROTOCOL_VERSION });
	handlers.discoverProject({ workspaceRoot: root });
	return { handlers, provider, root };
}

function verdict(
	handlers: ReturnType<typeof started>["handlers"],
	module: string,
	contentHash: string,
	refused = false,
): void {
	handlers.moduleAdmission?.({
		module,
		contentHash,
		outcome: refused ? REFUSAL : { status: "admitted" },
	});
}

function settle(
	handlers: ReturnType<typeof started>["handlers"],
	module: string,
	contentHash: string,
	text: string,
	refused = false,
) {
	const facts = handlers.parseFile({ module, contentHash, text });
	verdict(handlers, module, contentHash, refused);
	return facts;
}

function cartBindsInto(handlers: ReturnType<typeof started>["handlers"]): string | null {
	const facts = settle(handlers, "src/use.gd", "use", USE);
	const reference = facts.references.find((candidate) => candidate.name === "Cart");
	if (reference?.binding.status !== "bound") return null;
	return moduleOf(reference.binding.symbolId);
}

function symbolFor(facts: { declarations: Declaration[] }, name: string): string {
	const declaration = facts.declarations.find((candidate) => candidate.name === name);
	if (declaration === undefined) throw new Error(`no declaration named ${name}`);
	return declaration.symbolId;
}

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

test("forgetting through the wire removes a module's class_name and prevents a fill", () => {
	const { handlers } = started(CART);
	const facts = settle(handlers, TARGET, "v1", CART);
	const range = cartRange(facts);
	expect(cartBindsInto(handlers)).toBe(TARGET);

	handlers.forgetModule?.({ module: TARGET });
	expect(handlers.bind({ module: TARGET, name: "Cart", range }).status).toBe("unbound");
	expect(cartBindsInto(handlers)).toBeNull();
	expect(handlers.resolveImport({ fromModule: "src/use.gd", specifier: `res://${TARGET}` })).toMatchObject({
		status: "unresolved",
		reason: "NotIndexed",
	});
});

test("a fresh initialize can read a module the prior index forgot", () => {
	const { handlers, root } = started(CART);
	const facts = settle(handlers, TARGET, "v1", CART);
	const range = cartRange(facts);
	handlers.forgetModule?.({ module: TARGET });

	handlers.initialize({ workspaceRoot: root, protocolVersion: PROTOCOL_VERSION });
	handlers.discoverProject({ workspaceRoot: root });
	expect(handlers.bind({ module: TARGET, name: "Cart", range }).status).toBe("bound");
});

test("a refusal preserves the held module's type facts", () => {
	const { handlers } = started(CART_WITH_COUNT);
	const facts = settle(handlers, TARGET, "v1", CART_WITH_COUNT);
	const count = symbolFor(facts, "count");
	expect(handlers.typeOf({ symbolId: count }).status).toBe("known");

	settle(handlers, TARGET, "v2", CART, true);
	expect(handlers.typeOf({ symbolId: count }).status).toBe("known");
});

test("outline fills and full reads contribute the same class_name entries", () => {
	const { handlers, provider } = started(CART_WITH_COUNT);
	const key = "scoped:\0Cart";
	const outlineEntry = provider.store.get(key)[0];
	const outline = provider.store.peek(TARGET);
	if (outlineEntry === undefined || outline === undefined) throw new Error("outline fill did not hold Cart");
	expect({ depth: provider.store.text(TARGET)?.depth, references: outline.references }).toEqual({
		depth: "outline",
		references: [],
	});

	handlers.parseFile({ module: TARGET, contentHash: "full", text: CART_WITH_COUNT });
	verdict(handlers, TARGET, "full");
	const fullEntry = provider.store.get(key)[0];
	const full = provider.store.peek(TARGET);
	if (fullEntry === undefined || full === undefined) throw new Error("full parse did not hold Cart");
	expect({
		sameEntry: fullEntry,
		depth: provider.store.text(TARGET)?.depth,
		hasReferences: full.references.length > 0,
	}).toEqual({
		sameEntry: outlineEntry,
		depth: "full",
		hasReferences: true,
	});
});

test("rediscovery indexes class names and autoloads by the nearest project scope", () => {
	const { handlers, provider, root } = started(CART);
	writeFileSync(path.join(root, "project.godot"), `${PROJECT}\n[autoload]\nRootGlobal = "*res://src/cart.gd"\n`);
	writeFileSync(path.join(root, "common.gd"), "class_name Common\nextends Node\n");
	const nested = path.join(root, "nested");
	mkdirSync(nested, { recursive: true });
	writeFileSync(
		path.join(nested, "project.godot"),
		'[application]\nconfig/name="nested"\n\n[autoload]\nNestedGlobal = "res://state.gd"\n',
	);
	writeFileSync(path.join(nested, "common.gd"), "class_name Common\nextends Node\n");
	writeFileSync(path.join(nested, "state.gd"), "extends Node\n");

	const model = handlers.discoverProject({ workspaceRoot: root });
	expect(model.configFiles).toEqual(["nested/project.godot", "project.godot"]);
	expect(provider.store.project.scopes).toEqual([
		{ directory: "", autoloads: { RootGlobal: "src/cart.gd" } },
		{ directory: "nested", autoloads: { NestedGlobal: "nested/state.gd" } },
	]);
	expect(provider.store.get("scoped:\0Common").map((declaration) => moduleOf(declaration.symbolId))).toEqual([
		"common.gd",
	]);
	expect(provider.store.get("scoped:nested\0Common").map((declaration) => moduleOf(declaration.symbolId))).toEqual([
		"nested/common.gd",
	]);
});

test("a probe answers from its candidate, then from what the index holds", () => {
	const { handlers, root } = started(CART_WITH_COUNT);
	const count = symbolFor(settle(handlers, TARGET, "old", CART_WITH_COUNT), "count");
	writeFileSync(path.join(root, TARGET), CRATE);
	handlers.parseFile({ module: TARGET, contentHash: "disk", text: CRATE });
	const probed = handlers.probeFile({ module: TARGET, contentHash: "probe", text: CART_WITH_TOTAL });
	const total = symbolFor(probed, "total");
	const answers = () => ({
		cart: cartBindsInto(handlers),
		count: handlers.typeOf({ symbolId: count }).status,
		total: handlers.typeOf({ symbolId: total }).status,
	});
	const staged = answers();
	verdict(handlers, TARGET, "disk", true);

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

test("a forgotten module's types do not return through a fill", () => {
	const { handlers } = started(CART_WITH_COUNT);
	const count = symbolFor(settle(handlers, TARGET, "v1", CART_WITH_COUNT), "count");
	expect(handlers.typeOf({ symbolId: count }).status).toBe("known");

	handlers.forgetModule?.({ module: TARGET });
	expect(handlers.typeOf({ symbolId: count }).status).toBe("unknown");
});
