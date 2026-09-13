// Every writer road, through the daemon's handlers, over a module a lossy decode would corrupt.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SymbolSource } from "@nyaa-lexicon/protocol";
import { createDispatch } from "../dispatch";
import { lexiconRoot } from "../providers";
import { LexiconService } from "../service";
import { sourceReader } from "../sourceRead";
import { IndexStore } from "../store";
import { ProviderSupervisor } from "../supervisor";
import { TransactionManager } from "../transactions";
import { WorkspaceGate } from "../workspaceGate";

////////////////////////////////
//  Helpers

const FIXTURE = path.join(lexiconRoot(), "protocol", "src", "conformance", "fixtureProvider.ts");

/** Valid UTF-8 but for `c3 28`, on a line no edit touches. */
const LOSSY = Buffer.from([...Buffer.from("export class Cart {}\n// caf"), 0xc3, 0x28, 0x0a]);

let root: string;
let store: IndexStore;
let supervisor: ProviderSupervisor;
let service: LexiconService;
let dispatch: ReturnType<typeof createDispatch>;

function put(module: string, contents: string | Uint8Array): void {
	writeFileSync(path.join(root, module), contents);
}

function bytes(module: string): Buffer {
	return readFileSync(path.join(root, module));
}

async function indexed(module: string, contents: string | Uint8Array): Promise<void> {
	put(module, contents);
	const outcome = await service.indexFile(module);
	if (outcome.action !== "indexed") throw new Error(`${module}: ${outcome.action}`);
}

function symbol(name: string, module: string): string {
	const found = service.findByName(name, module)[0];
	if (found === undefined) throw new Error(`${module} declares no ${name}`);
	return found.symbolId;
}

beforeEach(async () => {
	root = mkdtempSync(path.join(tmpdir(), "lexicon-lossy-write-"));
	store = IndexStore.open(path.join(root, "index.sqlite")).store;
	supervisor = new ProviderSupervisor();
	await supervisor.start({ command: [process.execPath, "run", FIXTURE], timeoutMs: 30_000 }, root);
	service = new LexiconService(store, supervisor, sourceReader(root), root);
	dispatch = createDispatch(service, {
		gate: new WorkspaceGate(),
		transactions: new TransactionManager(store, root),
	});
	await indexed("a.ref", LOSSY);
	await dispatch("refactorStart", {});
});

afterEach(() => {
	supervisor.stopAll();
	store.close();
	rmSync(root, { recursive: true, force: true });
});

const refusedNaming = (module: string) => expect.stringContaining(module);

////////////////////////////////
//  Tests

describe("a module that is not valid UTF-8", () => {
	it("still reads, and refuses a replace and a no-op span replace, keeping its bytes", async () => {
		const cart = symbol("Cart", "a.ref");
		const seen = (await dispatch("symbolSource", { symbolId: cart })) as SymbolSource;
		if (!seen.found) throw new Error("expected a read");

		const replaced = await dispatch("refactorReplace", {
			symbolId: cart,
			newText: "export class Cart extends Bag",
		});
		const spanned = await dispatch("refactorReplaceSpan", {
			symbolId: cart,
			newText: seen.text,
			expectedSpanHash: seen.spanHash,
			standalone: true,
		});

		expect(replaced).toMatchObject({ replaced: false, reason: refusedNaming("a.ref") });
		expect(spanned).toMatchObject({ replaced: false, reason: refusedNaming("a.ref") });
		expect(bytes("a.ref").equals(LOSSY)).toBe(true);
	});

	it("refuses an insert after a sibling or appended to it, and one into a binary module", async () => {
		const blob = Buffer.from([0x00, 0x01, 0x0a]);
		put("blob.ref", blob);

		const after = await dispatch("refactorInsert", { after: symbol("Cart", "a.ref"), text: "export const X = 1" });
		const appended = await dispatch("refactorInsert", { module: "a.ref", text: "export const X = 1" });
		const binary = await dispatch("refactorInsert", { module: "blob.ref", text: "export const X = 1" });

		expect(after).toMatchObject({ inserted: false, reason: refusedNaming("a.ref") });
		expect(appended).toMatchObject({ inserted: false, reason: refusedNaming("a.ref") });
		expect(binary).toMatchObject({ inserted: false, reason: refusedNaming("blob.ref") });
		expect(bytes("a.ref").equals(LOSSY)).toBe(true);
		expect(bytes("blob.ref").equals(blob)).toBe(true);
	});

	it("refuses a move out of it and a move into it", async () => {
		await indexed("c.ref", "export class Item {}\n");

		const out = await dispatch("refactorMove", { symbolId: symbol("Cart", "a.ref"), toModule: "b.ref" });
		const into = await dispatch("refactorMove", { symbolId: symbol("Item", "c.ref"), toModule: "a.ref" });

		expect(out).toMatchObject({ moved: false, reason: refusedNaming("a.ref") });
		expect(into).toMatchObject({ moved: false, reason: refusedNaming("a.ref") });
		expect(bytes("a.ref").equals(LOSSY)).toBe(true);
		expect(bytes("c.ref").toString("utf8")).toBe("export class Item {}\n");
		expect(existsSync(path.join(root, "b.ref"))).toBe(false);
	});

	it("refuses a rename", async () => {
		const outcome = await dispatch("refactorRename", { symbolId: symbol("Cart", "a.ref"), newName: "Basket" });

		expect(outcome).toMatchObject({ renamed: false, reason: refusedNaming("a.ref") });
		expect(bytes("a.ref").equals(LOSSY)).toBe(true);
	});

	// A plan read some other way still cannot land.
	it("is refused by the writer a step applies through", () => {
		expect(() => service.writeModule("a.ref", "export class Cart {}\n")).toThrow("a.ref");
		expect(bytes("a.ref").equals(LOSSY)).toBe(true);
	});
});

describe("new text holding a lone surrogate", () => {
	const LONE = String.fromCharCode(0xd800);
	const BEFORE = "export class Cart {}\n";

	it("is refused for a replace and an insert, naming the module, with its bytes unchanged", async () => {
		await indexed("w.ref", BEFORE);

		const replaced = await dispatch("refactorReplace", {
			symbolId: symbol("Cart", "w.ref"),
			newText: `export class Cart /* ${LONE} */`,
		});
		const inserted = await dispatch("refactorInsert", { module: "w.ref", text: `export const X = "${LONE}"` });

		expect(replaced).toMatchObject({ replaced: false, reason: refusedNaming("w.ref") });
		expect(inserted).toMatchObject({ inserted: false, reason: refusedNaming("w.ref") });
		expect(bytes("w.ref").toString("utf8")).toBe(BEFORE);
	});

	it("is refused by the writer a step applies through", async () => {
		await indexed("w.ref", BEFORE);

		expect(() => service.writeModule("w.ref", `${BEFORE}${LONE}\n`)).toThrow("w.ref");
		expect(bytes("w.ref").toString("utf8")).toBe(BEFORE);
	});
});

describe("a lossless module with a BOM and non-ASCII text", () => {
	const HEAD = "\u{FEFF}// caf\u{E9} \u{1F600}\n";

	it("is replaced and renamed, keeping every byte outside the edits", async () => {
		await indexed("w.ref", `${HEAD}export class Cart {}\n`);

		const replaced = await dispatch("refactorReplace", {
			symbolId: symbol("Cart", "w.ref"),
			newText: "export class Cart extends Bag",
		});
		const renamed = await dispatch("refactorRename", { symbolId: symbol("Cart", "w.ref"), newName: "Basket" });

		expect(replaced).toMatchObject({ replaced: true });
		expect(renamed).toMatchObject({ renamed: true });
		expect(bytes("w.ref").equals(Buffer.from(`${HEAD}export class Basket extends Bag {}\n`))).toBe(true);
	});
});
