import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { LexiconService } from "../service";
import { fromText } from "../sourceRead";
import { IndexStore } from "../store";
import { ProviderSupervisor } from "../supervisor";
import { type FakeClock, fakeClock } from "./fakeClock";

////////////////////////////////
//  Helpers

let dir: string;
let store: IndexStore;
let service: LexiconService;
let clock: FakeClock;

const CART = "lexicon reference a.ref Cart#";
const at = (line: number) => ({ start: { line, character: 0 }, end: { line, character: 8 } });

beforeEach(() => {
	dir = mkdtempSync(path.join(tmpdir(), "lexicon-clock-"));
	clock = fakeClock(1_700_000_000_000);
	store = IndexStore.open(path.join(dir, "index.sqlite"), undefined, undefined, clock).store;
	service = new LexiconService(
		store,
		new ProviderSupervisor(clock),
		fromText(() => null),
		dir,
		clock,
	);
	store.replaceFile({
		module: "a.ref",
		contentHash: "h1",
		declarations: [
			{ symbolId: CART, kind: "class", name: "Cart", range: at(0), selectionRange: at(0), visibility: "public" },
		],
		references: [],
	});
});

afterEach(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

////////////////////////////////
//  Tests

describe("one clock through the daemon's composition", () => {
	it("stamps the note, its subject, its doubt and its confirmation from the one clock", () => {
		const written = clock.now();
		service.writeNote({ symbolId: CART, text: "Holds items.", expectedRevision: 0 });
		expect(service.readNote(CART)?.authoredAt).toBe(written);
		expect(store.subjects.forAddress(CART)?.boundAt).toBe(written);

		clock.advance(60_000);
		const doubted = clock.now();
		service.doubtNote(CART, "checkout was rewritten", 1);
		expect(service.readNote(CART)?.doubt?.at).toBe(doubted);

		clock.advance(60_000);
		const confirmed = clock.now();
		service.confirmNote(CART, 1);
		expect(service.readNote(CART)).toMatchObject({ confirmedAt: confirmed, doubt: null });
	});
});
