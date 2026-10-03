import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Declaration } from "@nyaa-lexicon/protocol";
import type { GeneratedVerdict } from "../fileScope";
import { LexiconService } from "../service";
import { sourceReader } from "../sourceRead";
import { IndexStore } from "../store";
import { fakeSupervisor } from "./fakeProvider";
import { gitInit } from "./gitFixture";

////////////////////////////////
//  Helpers

let dir: string;
let store: IndexStore;
let service: LexiconService;

const at = (line: number) => ({ start: { line, character: 0 }, end: { line, character: 8 } });

/** One declaration in a module whose file carries the verdict given; null writes none. */
function plant(module: string, generated: GeneratedVerdict | null = { status: "no" }): void {
	const symbolId = `lexicon typescript ${module} A#`;
	const declaration: Declaration = {
		symbolId,
		kind: "class",
		name: "A",
		range: at(0),
		selectionRange: at(0),
		visibility: "public",
	};
	store.replaceFile({
		module,
		contentHash: `h-${module}`,
		declarations: [declaration],
		references: [],
		imports: [],
		literals: [],
		depth: "full",
		comments: [],
		docs: [],
		notes: [],
		content: "code",
		digests: [],
		generated,
	});
}

beforeEach(() => {
	dir = mkdtempSync(path.join(tmpdir(), "lexicon-verdict-"));
	store = IndexStore.open(path.join(dir, "index.sqlite")).store;
});

afterEach(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

////////////////////////////////
//  Tests

describe("the generated verdict column", () => {
	it("finishes a column migration that stopped between the two adds", () => {
		const file = path.join(dir, "index.sqlite");
		store.close();
		const db = new DatabaseSync(file);
		db.exec("ALTER TABLE files DROP COLUMN generatedReason");
		db.close();
		store = IndexStore.open(file).store;

		plant("core.ts", { status: "unknown", reason: "gitFailed" });
		expect(store.generatedOf("core.ts")).toEqual({ status: "unknown", reason: "gitFailed" });
	});

	it("reads a pair the store never writes, or a row written without a verdict, as no verdict", () => {
		const file = path.join(dir, "index.sqlite");
		plant("core.ts");
		plant("bare.ts", null);
		store.close();
		const db = new DatabaseSync(file);
		db.exec("UPDATE files SET generated = 'yes', generatedReason = 'stray' WHERE module = 'core.ts'");
		db.close();
		store = IndexStore.open(file).store;

		expect(store.generatedOf("core.ts")).toBeNull();
		expect(store.generatedOf("bare.ts")).toBeNull();
	});
});

describe("the indexer records git's verdict on every file it writes", () => {
	let root: string;
	let storeDir: string;

	function put(module: string, text: string): void {
		const full = path.join(root, module);
		mkdirSync(path.dirname(full), { recursive: true });
		writeFileSync(full, text);
	}

	beforeEach(() => {
		root = mkdtempSync(path.join(tmpdir(), "lexicon-seeding-scan-"));
		storeDir = mkdtempSync(path.join(tmpdir(), "lexicon-seeding-store-"));
		store.close();
		store = IndexStore.open(path.join(storeDir, "index.sqlite")).store;
		service = new LexiconService(store, fakeSupervisor(), sourceReader(root), root);
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
		rmSync(storeDir, { recursive: true, force: true });
	});

	it("persists yes on a generated file reached only through an import, and no on its importer, on a scan and on a batch", async () => {
		await gitInit(root);
		put(".gitignore", "dist/\n");
		put(".gitattributes", "dist/** linguist-generated\n");
		put("dist/proto.fake", "export class Proto {}\n");
		put("src/app.fake", 'import "../dist/proto.fake"\nexport class App {}\n');

		await service.indexWorkspace();
		expect(store.generatedOf("src/app.fake")).toEqual({ status: "no" });
		expect(store.generatedOf("dist/proto.fake")).toEqual({ status: "yes" });

		// The batch writes a fresh root and reaches a fresh generated file, so each verdict is its own.
		put("dist/extra.fake", "export class Extra {}\n");
		put("src/other.fake", 'import "../dist/extra.fake"\nexport class Other {}\n');
		await service.applyBatch([{ kind: "changed", module: "src/other.fake", contentHash: null }]);
		expect(store.generatedOf("src/other.fake")).toEqual({ status: "no" });
		expect(store.generatedOf("dist/extra.fake")).toEqual({ status: "yes" });

		// An attributes edit reaches files the batch never re-reads, here the two still reached by import.
		put(".gitattributes", "dist/proto.fake linguist-generated\n");
		await service.applyBatch([{ kind: "changed", module: ".gitattributes", contentHash: null }]);
		expect(store.generatedOf("dist/proto.fake")).toEqual({ status: "yes" });
		expect(store.generatedOf("dist/extra.fake")).toEqual({ status: "no" });
		expect(store.contentHashOf("dist/extra.fake")).not.toBeNull();
	});

	it("gives a file whose parse failed the verdict of the scan that failed it", async () => {
		await gitInit(root);
		put(".gitignore", "dist/\n");
		put("dist/lib.fake", "export class Lib {}\n");
		put("src/app.fake", 'import "../dist/lib.fake"\nexport class App {}\n');
		await service.indexWorkspace();
		expect(store.generatedOf("dist/lib.fake")).toEqual({ status: "no" });

		// The parse fails, so the row keeps its last good facts; the verdict still follows the attributes.
		put(".gitattributes", "dist/lib.fake linguist-generated\n");
		put("dist/lib.fake", "export class Lib {}\nSYNTAX\n");
		await service.indexWorkspace();
		expect(store.parseFailureOf("dist/lib.fake")).not.toBeNull();
		expect(store.declaration("lexicon fake dist/lib.fake Lib#")).not.toBeNull();
		expect(store.generatedOf("dist/lib.fake")).toEqual({ status: "yes" });
	});

	it("persists unknown with its reason where there is no git to ask, and still indexes the file", async () => {
		service = new LexiconService(store, fakeSupervisor({ discover: () => ["app.fake"] }), sourceReader(root), root);
		put("app.fake", "export class App {}\n");

		await service.indexWorkspace();
		expect(store.contentHashOf("app.fake")).not.toBeNull();
		expect(store.generatedOf("app.fake")).toEqual({ status: "unknown", reason: "noGit" });
	});
});
