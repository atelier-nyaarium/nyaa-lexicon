import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { bunCommand } from "@nyaa-lexicon/client";
import { hashBytes, type RefactorWriteFileResult, type RequestOf } from "@nyaa-lexicon/protocol";
import { createDispatch } from "../dispatch";
import { lexiconRoot } from "../providers";
import { LexiconService } from "../service";
import { sourceReader } from "../sourceRead";
import { IndexStore } from "../store";
import { ProviderSupervisor } from "../supervisor";
import { TransactionManager } from "../transactions";

////////////////////////////////
//  Helpers

const FIXTURE = path.join(lexiconRoot(), "protocol", "src", "conformance", "fixtureProvider.ts");

const ORIGINAL = "export class Cart {}\n";
const CART = "lexicon reference a.ref Cart#";
const BASKET = "lexicon reference a.ref Basket#";

let scratch: string;
let root: string;
let outside: string;
let store: IndexStore;
let supervisor: ProviderSupervisor;
let service: LexiconService;
let transactions: TransactionManager;
let dispatch: ReturnType<typeof createDispatch>;

function put(module: string, text: string | Uint8Array): void {
	writeFileSync(path.join(root, module), text);
}

function bytesAt(module: string): Buffer | null {
	const full = path.join(root, module);
	return existsSync(full) ? readFileSync(full) : null;
}

function hash(text: string): string {
	return hashBytes(Buffer.from(text));
}

function write(module: string, text: string | null, expect: string | null): Promise<RefactorWriteFileResult> {
	const content = text === null ? null : { encoding: "text" as const, text };
	const request: RequestOf<"refactorWriteFile"> = { module, content, expect };
	return dispatch("refactorWriteFile", request) as Promise<RefactorWriteFileResult>;
}

beforeEach(async () => {
	scratch = mkdtempSync(path.join(tmpdir(), "lexicon-write-file-"));
	root = path.join(scratch, "workspace");
	outside = path.join(scratch, "outside");
	mkdirSync(root);
	mkdirSync(outside);
	store = IndexStore.open(path.join(scratch, "index.sqlite")).store;
	supervisor = new ProviderSupervisor();
	const launch = bunCommand(
		{ kind: "bun", executable: process.execPath, version: Bun.version },
		{ platform: process.platform, env: { XDG_STATE_HOME: scratch }, home: scratch },
	);
	await supervisor.start({ command: [...launch, "run", FIXTURE], timeoutMs: 30_000 }, root);
	service = new LexiconService(store, supervisor, sourceReader(root), root);
	transactions = new TransactionManager(store, root);
	dispatch = createDispatch(service, { transactions });
	put("a.ref", ORIGINAL);
	await service.indexFile("a.ref");
});

afterEach(() => {
	supervisor.stopAll();
	store.close();
	rmSync(scratch, { recursive: true, force: true });
});

////////////////////////////////
//  Tests

describe("a gated write with no refactor open", () => {
	it("replaces a file's bytes exactly, indexes them, and answers disk's hash and the ledger", async () => {
		const text = "export class Basket {}\r\n";
		const outcome = await write("a.ref", text, hash(ORIGINAL));

		expect(outcome).toEqual({
			written: true,
			contentHash: hash(text),
			refactor: null,
			ledger: transactions.ledger(),
			indexed: true,
		});
		expect(bytesAt("a.ref")?.toString("utf8")).toBe(text);
		expect(store.declaration(BASKET)).not.toBeNull();
		expect(store.declaration(CART)).toBeNull();
	});

	it("creates a file in a new folder, and deletes one", async () => {
		expect(await write("src/deep/b.ref", "export class B {}\n", null)).toMatchObject({ written: true });
		expect(bytesAt("src/deep/b.ref")?.toString("utf8")).toBe("export class B {}\n");

		expect(await write("a.ref", null, hash(ORIGINAL))).toMatchObject({ written: true, contentHash: null });
		expect(bytesAt("a.ref")).toBeNull();
		expect(store.declaration(CART)).toBeNull();
	});

	it("round-trips binary bytes", async () => {
		const binary = Buffer.from([0, 255, 254, 10, 13, 0xc3]);
		const outcome = await dispatch("refactorWriteFile", {
			module: "blob.bin",
			content: { encoding: "base64", bytes: binary.toString("base64") },
			expect: null,
		});

		expect(outcome).toMatchObject({ written: true, contentHash: hashBytes(binary) });
		expect(bytesAt("blob.bin")?.equals(binary)).toBe(true);
	});

	it("never writes through a link planted at the temp name, and leaves a regular file", async () => {
		const victim = path.join(outside, "victim.txt");
		writeFileSync(victim, "keep\n");
		symlinkSync(victim, path.join(root, "a.ref.lexicon-tmp"));
		const outcome = await write("a.ref", "export class Basket {}\n", hash(ORIGINAL));

		expect({
			written: outcome.written,
			victim: readFileSync(victim, "utf8"),
			link: lstatSync(path.join(root, "a.ref")).isSymbolicLink(),
			text: bytesAt("a.ref")?.toString("utf8"),
			leftover: existsSync(path.join(root, "a.ref.lexicon-tmp")),
		}).toEqual({ written: true, victim: "keep\n", link: false, text: "export class Basket {}\n", leftover: false });
	});

	it.skipIf(process.platform === "win32")("keeps the file's permission bits", async () => {
		put("run.sh", "echo one\n");
		chmodSync(path.join(root, "run.sh"), 0o755);
		await write("run.sh", "echo two\n", hash("echo one\n"));

		expect(statSync(path.join(root, "run.sh")).mode & 0o777).toBe(0o755);
	});
});

describe("a gated write that is refused", () => {
	it("writes nothing when disk no longer holds what it expected, and names what it holds", async () => {
		const stale = await write("a.ref", "export class Basket {}\n", hash("something older\n"));
		const exists = await write("a.ref", "export class Basket {}\n", null);

		for (const outcome of [stale, exists]) {
			expect(outcome).toMatchObject({ written: false, refused: "changed", contentHash: hash(ORIGINAL) });
		}
		expect(bytesAt("a.ref")?.toString("utf8")).toBe(ORIGINAL);
	});

	it("writes nothing through a link that leaves the workspace, leaf or folder", async () => {
		writeFileSync(path.join(outside, "secret.ref"), "outside\n");
		symlinkSync(path.join(root, "a.ref"), path.join(root, "swapped.ref"));
		rmSync(path.join(root, "swapped.ref"));
		symlinkSync(path.join(outside, "secret.ref"), path.join(root, "swapped.ref"));
		symlinkSync(outside, path.join(root, "linked"));

		const leaf = await write("swapped.ref", "overwritten\n", hash("outside\n"));
		const folder = await write("linked/secret.ref", "overwritten\n", hash("outside\n"));

		for (const outcome of [leaf, folder]) expect(outcome).toMatchObject({ written: false, refused: "outside" });
		expect(readFileSync(path.join(outside, "secret.ref"), "utf8")).toBe("outside\n");
	});

	it("writes nothing over a directory, a link inside the workspace, or past the size cap", async () => {
		mkdirSync(path.join(root, "folder"));
		symlinkSync(path.join(root, "a.ref"), path.join(root, "alias.ref"));

		expect(await write("folder", "x\n", null)).toMatchObject({ refused: "directory" });
		expect(await write("alias.ref", "x\n", hash(ORIGINAL))).toMatchObject({ refused: "notAFile" });
		expect(await write("big.ref", "x".repeat(4 * 1024 * 1024 + 1), null)).toMatchObject({ refused: "tooLarge" });
		expect(await write("odd.ref", "\uD800\n", null)).toMatchObject({ refused: "unencodable" });
		expect(bytesAt("a.ref")?.toString("utf8")).toBe(ORIGINAL);
		expect(bytesAt("big.ref")).toBeNull();
	});
});

describe("a gated write while a refactor is open", () => {
	it("tracks the file and makes the written bytes its known state, so commit settles them", async () => {
		const { id } = transactions.start();
		const outcome = await write("a.ref", "export class Basket {}\n", hash(ORIGINAL));

		expect(outcome).toMatchObject({ written: true, refactor: { id } });
		expect(transactions.status()).toMatchObject({ tracked: ["a.ref"], edited: ["a.ref"], drifted: [] });
		transactions.commit();
		expect(transactions.settlements(0).settlements[0]?.files).toEqual([
			{ module: "a.ref", opened: hash(ORIGINAL), settled: hash("export class Basket {}\n") },
		]);
	});

	it("is put back by revert to the before-image", async () => {
		transactions.start();
		await write("a.ref", "export class Basket {}\n", hash(ORIGINAL));
		await write("new.ref", "export class New {}\n", null);

		const reverted = await dispatch("refactorRevert", { drifted: transactions.status().drifted });

		expect(reverted).toMatchObject({ reverted: true });
		expect(bytesAt("a.ref")?.toString("utf8")).toBe(ORIGINAL);
		expect(bytesAt("new.ref")).toBeNull();
		expect(store.declaration(CART)).not.toBeNull();
	});

	it("orders against a revert through the gate: a revert behind it settles after it", async () => {
		transactions.start();
		transactions.track("a.ref");
		const writing = write("a.ref", "export class Basket {}\n", hash(ORIGINAL));
		const reverting = dispatch("refactorRevert", { drifted: [] });

		expect(await writing).toMatchObject({ written: true });
		expect(await reverting).toMatchObject({ reverted: true });
		expect(transactions.settlements(0).settlements[0]).toMatchObject({
			outcome: "reverted",
			files: [{ module: "a.ref", opened: hash(ORIGINAL), settled: hash(ORIGINAL) }],
		});
		expect(bytesAt("a.ref")?.toString("utf8")).toBe(ORIGINAL);
	});

	it("orders against a revert through the gate: a write behind it sees the reverted bytes", async () => {
		transactions.start();
		const first = await write("a.ref", "export class Basket {}\n", hash(ORIGINAL));
		expect(first).toMatchObject({ written: true });

		const reverting = dispatch("refactorRevert", { drifted: [] });
		const writing = write("a.ref", "export class Later {}\n", hash("export class Basket {}\n"));

		expect(await reverting).toMatchObject({ reverted: true });
		expect(await writing).toMatchObject({ written: false, refused: "changed", contentHash: hash(ORIGINAL) });
		expect(bytesAt("a.ref")?.toString("utf8")).toBe(ORIGINAL);
	});

	it("leaves the file tracked with drift when the daemon dies between the write and the note", async () => {
		transactions.start();
		const text = "export class Basket {}\n";
		const putBlob = store.putBlob.bind(store);
		store.putBlob = (blobHash, bytes) => {
			if (blobHash === hash(text)) throw new Error("the daemon died");
			putBlob(blobHash, bytes);
		};

		await expect(write("a.ref", text, hash(ORIGINAL))).rejects.toThrow();

		expect(bytesAt("a.ref")?.toString("utf8")).toBe(text);
		expect(transactions.status()).toMatchObject({
			tracked: ["a.ref"],
			edited: [],
			drifted: [{ module: "a.ref", contentHash: hash(text) }],
		});
	});
});
