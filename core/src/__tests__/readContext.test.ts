import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ancestryOf } from "../locals.js";
import { type DeclarationReads, factsMovedSince, ReadContext } from "../readContext.js";
import { type FactsStamp, IndexStore, type StoredDeclaration } from "../store.js";
import { fakeClock } from "./fakeClock";

const SHOP = "shop.ref";
const OTHER = "other.ref";
const ABSENT = "lexicon reference shop.ref gone().";

const IDS = {
	shop: "lexicon reference shop.ref Shop#",
	open: "lexicon reference shop.ref Shop#open().",
	amount: "lexicon reference shop.ref Shop#open().(amount)",
	total: "lexicon reference shop.ref Shop#open().total.",
	helper: "lexicon reference shop.ref helper().",
	twin: "lexicon reference other.ref Shop#",
	load: "lexicon reference other.ref Shop#load().",
	api: "lexicon reference api.ref Api/",
	writer: "lexicon reference writer.ref Api/Writer#",
};

function declare(
	symbolId: string,
	module: string,
	kind: StoredDeclaration["kind"],
	name: string,
	line: number,
	extra: { containerId?: string; visibility?: StoredDeclaration["visibility"] } = {},
): StoredDeclaration {
	return {
		symbolId,
		factId: symbolId,
		module,
		kind,
		name,
		range: { start: { line, character: 0 }, end: { line, character: 1 } },
		visibility: extra.visibility ?? "public",
		...(extra.containerId === undefined ? {} : { containerId: extra.containerId }),
	};
}

/** Two modules naming one class alike, so reading the wrong module's rows shows. */
const ROWS: StoredDeclaration[] = [
	declare(IDS.shop, SHOP, "class", "Shop", 0),
	declare(IDS.open, SHOP, "method", "open", 2, { containerId: IDS.shop }),
	declare(IDS.amount, SHOP, "variable", "amount", 3, { containerId: IDS.open, visibility: "local" }),
	declare(IDS.total, SHOP, "variable", "total", 4, { containerId: IDS.open, visibility: "fileLocal" }),
	declare(IDS.helper, SHOP, "function", "helper", 8),
	declare(IDS.twin, OTHER, "class", "Shop", 0),
	declare(IDS.load, OTHER, "method", "load", 1, { containerId: IDS.twin }),
];

const inShop = ROWS.filter((row) => row.module === SHOP);

interface Counting extends DeclarationReads {
	modules: string[];
	ids: string[];
	/** What each module's rows stand committed as; absent means not indexed. */
	stamps: Map<string, FactsStamp>;
}

function reads(rows: readonly StoredDeclaration[] = ROWS): Counting {
	const modules: string[] = [];
	const ids: string[] = [];
	const stamps = new Map<string, FactsStamp>();
	return {
		modules,
		ids,
		stamps,
		declaration: (symbolId) => {
			ids.push(symbolId);
			return rows.find((row) => row.symbolId === symbolId) ?? null;
		},
		declarationsIn: (module) => {
			modules.push(module);
			return rows.filter((row) => row.module === module);
		},
		declarationsNamed: (name) => rows.filter((row) => row.name === name),
		stampOf: (module) => stamps.get(module) ?? null,
	};
}

describe("a read context reads each module once", () => {
	it("loads one module however many things a read asks about it", () => {
		const source = reads();
		const context = new ReadContext(source);

		context.declaredChildren(IDS.shop);
		context.localsOwnedBy(IDS.open);
		context.descendantIds(IDS.shop);
		context.heldIn(SHOP);
		context.heldBy(SHOP, undefined);
		context.holds(SHOP, IDS.open);

		expect(source.modules).toEqual([SHOP]);
	});

	it("remembers an id the index does not hold", () => {
		const source = reads();
		const context = new ReadContext(source);

		expect(context.summaryOf(ABSENT)).toBeNull();
		expect(context.summaryOf(ABSENT)).toBeNull();

		expect(source.ids).toEqual([ABSENT]);
	});

	it("serves an id out of the module snapshot that held it", () => {
		const source = reads();
		const context = new ReadContext(source);
		context.membersOf(SHOP, undefined);

		expect(context.summaryOf(IDS.open)?.name).toBe("open");

		expect(source.ids).toEqual([]);
	});
});

describe("a read context stamps what it read", () => {
	it("stamps a module once, at its first touch by id or by module", () => {
		const source = reads();
		source.stamps.set(SHOP, { depth: "outline", indexedAt: 1 });
		const context = new ReadContext(source);

		context.declaration(IDS.open);
		source.stamps.set(SHOP, { depth: "full", indexedAt: 2 });
		context.heldIn(SHOP);
		context.declaration(IDS.load);
		context.declaration(ABSENT);

		expect(context.seen()).toEqual([
			{ module: SHOP, stamp: { depth: "outline", indexedAt: 1 } },
			{ module: OTHER, stamp: null },
		]);
	});

	// A hash cannot see any of these: the bytes never changed.
	it("names the modules committed again since: upgraded, re-parsed, indexed, or forgotten", () => {
		const source = reads();
		source.stamps.set(SHOP, { depth: "outline", indexedAt: 1 });
		source.stamps.set(OTHER, { depth: "full", indexedAt: 1 });
		source.stamps.set("gone.ref", { depth: "full", indexedAt: 1 });
		const context = new ReadContext(source);
		for (const module of [SHOP, OTHER, "gone.ref", "fresh.ref"]) context.heldIn(module);

		expect(factsMovedSince(context.seen(), source)).toEqual([]);

		source.stamps.set(SHOP, { depth: "full", indexedAt: 1 });
		source.stamps.set(OTHER, { depth: "full", indexedAt: 2 });
		source.stamps.delete("gone.ref");
		source.stamps.set("fresh.ref", { depth: "full", indexedAt: 3 });

		expect(factsMovedSince(context.seen(), source)).toEqual([SHOP, OTHER, "gone.ref", "fresh.ref"]);
	});

	// The clock is the stamp's other source, and a frozen one would read two commits as one.
	it("names a module committed twice in one instant with the read between, against the real store", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "lexicon-stamp-"));
		const store = IndexStore.open(path.join(dir, "index.sqlite"), undefined, undefined, fakeClock()).store;
		const commit = (rows: StoredDeclaration[]) =>
			store.replaceFile({ module: SHOP, contentHash: "same-bytes", declarations: rows, references: [] });
		try {
			commit([inShop[0] as StoredDeclaration]);
			const context = new ReadContext(store);
			context.heldIn(SHOP);
			commit([inShop[0] as StoredDeclaration, inShop[4] as StoredDeclaration]);

			expect(factsMovedSince(context.seen(), store)).toEqual([SHOP]);
		} finally {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("a read context answers the topology of the module holding an id", () => {
	it("reads each module's own nesting", () => {
		const context = new ReadContext(reads());

		expect(context.declaredChildren(IDS.shop).map((row) => row.name)).toEqual(["open"]);
		expect(context.declaredChildren(IDS.twin).map((row) => row.name)).toEqual(["load"]);
	});

	it("answers nothing nested for an id the index does not hold", () => {
		const context = new ReadContext(reads());

		expect(context.declaredChildren(ABSENT)).toEqual([]);
		expect(context.localsOwnedBy(ABSENT)).toEqual([]);
		expect(context.descendantIds(ABSENT)).toEqual(new Set([ABSENT]));
	});
});

describe("a read context answers what a declaration owns", () => {
	it("gives a holder its own id and the locals beneath it", () => {
		const context = new ReadContext(reads());

		expect(context.ownedIds(IDS.open)).toEqual([IDS.open, IDS.amount, IDS.total]);
		expect(context.ownedIds(IDS.helper)).toEqual([IDS.helper]);
	});
});

describe("a read context answers what a module holds", () => {
	it("lists every row in source order, and says which ids are its own", () => {
		const context = new ReadContext(reads());

		expect(context.heldIn(SHOP).map((row) => row.name)).toEqual(["Shop", "open", "amount", "total", "helper"]);
		expect(context.holds(SHOP, IDS.open)).toBe(true);
		expect(context.holds(SHOP, IDS.twin)).toBe(false);
	});

	it("answers direct children by container, locals included and grandchildren excluded", () => {
		const context = new ReadContext(reads());

		expect(context.heldBy(SHOP, IDS.shop).map((row) => row.name)).toEqual(["open"]);
		expect(context.heldBy(SHOP, IDS.open).map((row) => row.name)).toEqual(["amount", "total"]);
		expect(context.heldBy(SHOP, undefined).map((row) => row.name)).toEqual(["Shop", "helper"]);
		expect(context.heldBy(SHOP, ABSENT)).toEqual([]);
	});

	it("keeps a grouping at the level it is declared, where members see through it", () => {
		const namespace = declare(IDS.api, SHOP, "namespace", "Api", 0);
		const writer = declare(IDS.writer, SHOP, "class", "Writer", 1, { containerId: IDS.api });
		const context = new ReadContext(reads([namespace, writer]));

		expect(context.heldBy(SHOP, undefined).map((row) => row.name)).toEqual(["Api"]);
		expect(context.heldBy(SHOP, IDS.api).map((row) => row.name)).toEqual(["Writer"]);
		expect(context.membersOf(SHOP, undefined).map((row) => row.name)).toEqual(["Writer"]);
	});
});

describe("a read context reads a grouping above a declaration", () => {
	it("follows a container into another module, which a module's own rows cannot", () => {
		const namespace = declare(IDS.api, "api.ref", "namespace", "Api", 0);
		const writer = declare(IDS.writer, "writer.ref", "class", "Writer", 0, { containerId: IDS.api });
		const context = new ReadContext(reads([namespace, writer]));

		expect(context.spansModules(writer)).toBe(true);
	});

	it("says a declaration under no grouping spans nothing", () => {
		const context = new ReadContext(reads());

		expect(context.spansModules(inShop[0] as StoredDeclaration)).toBe(false);
		expect(context.spansModules(inShop[1] as StoredDeclaration)).toBe(false);
	});

	// Memoized, so a lost guard times out here rather than throwing.
	it("returns on a container chain that loops rather than walking it", () => {
		const first = declare("a", SHOP, "class", "A", 0, { containerId: "b" });
		const second = declare("b", SHOP, "class", "B", 1, { containerId: "a" });
		const context = new ReadContext(reads([first, second]));

		expect(context.spansModules(first)).toBe(false);
		expect(context.ancestorsOf(first).map((row) => row.name)).toEqual(["B"]);
	});

	it("stops the walk where the caller refuses a container", () => {
		const outer = declare(IDS.api, SHOP, "namespace", "Api", 0);
		const inner = declare(IDS.writer, SHOP, "class", "Writer", 1, { containerId: IDS.api });
		const context = new ReadContext(reads([outer, inner]));

		expect(context.ancestorsOf(inner).map((row) => row.name)).toEqual(["Api"]);
		expect(context.ancestorsOf(inner, (held) => held.kind === "class")).toEqual([]);
	});
});

describe("the container walk", () => {
	it("stops on a chain that loops rather than following it", () => {
		const first = declare("a", SHOP, "class", "A", 0, { containerId: "b" });
		const second = declare("b", SHOP, "class", "B", 1, { containerId: "a" });
		let asked = 0;
		const walked = ancestryOf(first, (symbolId) => {
			if (++asked > 4) throw new Error("followed a loop");
			return [first, second].find((row) => row.symbolId === symbolId) ?? null;
		});

		expect(walked.cyclic).toBe(true);
		expect(walked.ancestors.map((row) => row.name)).toEqual(["B"]);
	});

	it("stops where the resolver has no container, and calls that no loop", () => {
		const child = declare("a", SHOP, "class", "A", 0, { containerId: "missing" });

		expect(ancestryOf(child, () => null)).toEqual({ ancestors: [], cyclic: false });
	});
});
