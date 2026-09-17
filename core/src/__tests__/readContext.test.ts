import { describe, expect, it } from "bun:test";
import { ancestryOf } from "../locals.js";
import { type DeclarationReads, ReadContext } from "../readContext.js";
import type { StoredDeclaration } from "../store.js";

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
}

function reads(rows: readonly StoredDeclaration[] = ROWS): Counting {
	const modules: string[] = [];
	const ids: string[] = [];
	return {
		modules,
		ids,
		declaration: (symbolId) => {
			ids.push(symbolId);
			return rows.find((row) => row.symbolId === symbolId) ?? null;
		},
		declarationsIn: (module) => {
			modules.push(module);
			return rows.filter((row) => row.module === module);
		},
		declarationsNamed: (name) => rows.filter((row) => row.name === name),
	};
}

describe("a read context reads each module once", () => {
	it("loads one module however many things a read asks about it", () => {
		const source = reads();
		const context = new ReadContext(source);

		context.declaredChildren(IDS.shop);
		context.localsOwnedBy(IDS.open);
		context.descendantIds(IDS.shop);

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
