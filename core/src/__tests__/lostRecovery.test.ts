import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Binding } from "@nyaa-lexicon/protocol";
import { REBIND_CAP } from "../indexer";
import { type LiveIndex, startLiveIndex } from "../liveIndex";
import type { MethodRequest } from "../providerPort";
import { LexiconService } from "../service";
import { sourceReader } from "../sourceRead";
import { BATCH_MS, IndexStore, LOST_RETRY_MS } from "../store";
import { type FakeClock, fakeClock } from "./fakeClock";
import { fakeImports, fakeUses } from "./fakeGrammar";
import { fakeSupervisor, parseClasses, parseFake, rangesOf } from "./fakeProvider";
import { gitInit } from "./gitFixture";
import { failingCommit } from "./storeFailures";

////////////////////////////////
//  Helpers

let root: string;
let store: IndexStore;
let clock: FakeClock;
let live: LiveIndex | undefined;

const FOO = "lexicon fake x.fake Foo#";

/** More importers than one batch pays itself, so the pump owes the rest. */
const USERS = Array.from({ length: REBIND_CAP + 6 }, (_, at) => `user${String(at).padStart(2, "0")}.fake`);

function put(module: string, text: string): void {
	writeFileSync(path.join(root, module), text);
}

/** Binds each `use Name` through the file's imports to the class its target declares on disk. */
function bindingService(during: (request: MethodRequest<"parseFile">) => void): LexiconService {
	const provider = fakeSupervisor({
		answers: {
			parseFile: (request) => {
				during(request);
				const parsed = parseFake(request);
				if (request.depth === "outline") return parsed;
				const rangeOf = rangesOf(request.text);
				const bindingOf = (name: string): Binding => {
					for (const { specifier } of fakeImports(request.text)) {
						const target = path.posix.normalize(
							path.posix.join(path.posix.dirname(request.module), specifier),
						);
						const declared = parseClasses(target, readFileSync(path.join(root, target), "utf8"));
						const found = declared.find((each) => each.name === name);
						if (found !== undefined)
							return { status: "bound", symbolId: found.symbolId, provenance: "bound" };
					}
					return { status: "unbound", reason: "NotIndexed" };
				};
				const references = fakeUses(request.text).map(({ name, start, end }) => ({
					name,
					range: rangeOf(start, end),
					role: "read" as const,
					binding: bindingOf(name),
				}));
				return { ...parsed, references };
			},
		},
	});
	return new LexiconService(store, provider, sourceReader(root), root, clock);
}

const unbound = () => USERS.filter((user) => store.referencesIn(user)[0]?.targetId !== FOO).length;

beforeEach(async () => {
	root = mkdtempSync(path.join(tmpdir(), "lexicon-recovery-"));
	await gitInit(root);
	clock = fakeClock();
	store = IndexStore.open(path.join(root, "index.sqlite"), undefined, undefined, clock).store;
});

afterEach(() => {
	live?.stop();
	live = undefined;
	store.close();
	rmSync(root, { recursive: true, force: true });
});

////////////////////////////////
//  Tests

describe("a lost batch", () => {
	it("leaves the session to owe and pay again what the committed store still holds unpaid", async () => {
		put("x.fake", "export class Base {}\n");
		for (const user of USERS) put(user, 'import "./x.fake";\nuse Foo\n');
		const commit = failingCommit(store);
		let losing = false;
		let paid = 0;
		const service = bindingService((request) => {
			if (!losing || !USERS.includes(request.module)) return;
			// The batch's second payment: its commit fails, after the edit itself was committed.
			if (++paid === 2) {
				losing = false;
				commit.arm();
				clock.advance(BATCH_MS);
			}
		});
		await service.indexWorkspace();
		// Edited before watching, so only the injected event carries it.
		put("x.fake", "export class Base {}\nexport class Foo {}\n");
		const errors: unknown[] = [];
		live = startLiveIndex({
			service,
			workspaceRoot: root,
			clock,
			debounceMs: 10,
			onError: (error) => errors.push(error),
		});
		await live.warmed;

		losing = true;
		live.inject("x.fake");
		clock.advance(10);
		await live.settled();
		const afterLoss = unbound();
		clock.advance(LOST_RETRY_MS);
		await live.settled();
		await service.upgradeRemaining();

		expect({ lost: errors.length > 0, afterLoss, repaired: unbound() }).toEqual({
			lost: true,
			afterLoss: USERS.length,
			repaired: 0,
		});
	});

	it("arms a recovery whose run, ended by another fault, is not started again at once", async () => {
		put("a.fake", "export class A {}\n");
		const service = bindingService(() => {});
		await service.indexWorkspace();
		put("a.fake", "export class A { edited }\n");
		failingCommit(store).arm();
		await service.applyBatch([{ kind: "changed", module: "a.fake", contentHash: null }]).catch(() => {});
		let faults = 0;
		const blocked = store.blockedRebinds.bind(store);
		store.blockedRebinds = () => {
			// Every run meets it, until a spin would have met it many times over.
			if (++faults <= 20) throw new Error("the store is closed");
			return blocked();
		};
		clock.advance(LOST_RETRY_MS);
		// A spin holds the event loop until its bound lets the run through.
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(faults).toBe(1);
	});

	it("runs a pump a lost pass started as its own pass, not the lost one's", async () => {
		const service = bindingService(() => {});
		// A debt a restarted provider held, so the pump's start writes.
		store.blockRebind("x.fake", "fake", "outage", "a process long gone");
		let starts = 0;
		const unblock = store.unblockRebinds.bind(store);
		store.unblockRebinds = (modules) => {
			// Past a spin's worth, the write is skipped, so a spin ends and the count shows it.
			if (++starts <= 20) unblock(modules);
		};
		let pumped: Promise<void> = Promise.resolve();
		const pass = store.pass(async () => {
			store.replaceFile({ module: "held.fake", contentHash: "h", declarations: [], references: [] });
			failingCommit(store).arm();
			clock.advance(BATCH_MS);
			pumped = service.upgradeRemaining();
		});
		await pass.catch(() => {});
		await pumped;

		expect(starts).toBe(1);
	});
});
