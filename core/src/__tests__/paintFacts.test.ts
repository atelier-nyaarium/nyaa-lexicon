import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { coordinatesOf, hashContent, type Range } from "@nyaa-lexicon/protocol";
import { PaintReads } from "../paintFacts";
import { liveProbe } from "../providerProbe";
import { IndexStore } from "../store";
import { fakeSupervisor, parseFake } from "./fakeProvider";
import { edge, forwarding, landed } from "./importEdges";

////////////////////////////////
//  Fixture

const CLAIMS = { providerId: "fake", language: "fake", extensions: [".fake"] };
const WORDS = { keywords: ["class", "function"], builtins: [], literals: ["true"] };

const TEXT = ["export class Widget {}", "export function build() {", "  return Widget.create();", "}"].join("\n");

const coords = coordinatesOf(TEXT);

/** A range over the fixture text, found by substring rather than hand-counted columns. */
function span(needle: string, from = 0): Range {
	const start = TEXT.indexOf(needle, from);
	if (start === -1) throw new Error(`${JSON.stringify(needle)} not found in the fixture text`);
	const range = coords.rangeAt(start, start + needle.length);
	if (range === undefined) throw new Error(`${needle} is unaddressable in the fixture text`);
	return range;
}

const WIDGET = "lexicon fake a.fake Widget#";
const BUILD = "lexicon fake a.fake build#";

/** Two declarations and two references, written straight to the store as a provider's output would land. */
function plantModule(store: IndexStore): void {
	store.replaceFile({
		module: "a.fake",
		contentHash: hashContent(TEXT),
		declarations: [
			{
				symbolId: WIDGET,
				kind: "class",
				name: "Widget",
				range: span("export class Widget {}"),
				selectionRange: span("Widget"),
				visibility: "public",
			},
			{
				symbolId: BUILD,
				kind: "function",
				name: "build",
				range: span("export function build() {"),
				selectionRange: span("build"),
				visibility: "public",
			},
		],
		references: [
			{
				name: "Widget",
				range: span("Widget", TEXT.indexOf("return")),
				role: "read",
				fromId: BUILD,
				binding: { status: "bound", symbolId: WIDGET, provenance: "bound" },
			},
			{
				name: "create",
				range: span("create"),
				role: "call",
				fromId: BUILD,
				binding: { status: "unbound", reason: "NotIndexed" },
			},
		],
	});
}

let dir: string;
let store: IndexStore;

beforeEach(() => {
	dir = mkdtempSync(path.join(tmpdir(), "lexicon-paint-"));
	store = IndexStore.open(path.join(dir, "index.sqlite")).store;
});

afterEach(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

////////////////////////////////
//  Tests

describe("moduleFacts", () => {
	it("answers the store's rows, a declaration's range sliced to its own name", () => {
		plantModule(store);
		const probe = liveProbe(fakeSupervisor({ claims: [CLAIMS], words: WORDS }));
		const reads = new PaintReads(store, probe, () => 0);

		const facts = reads.moduleFacts("a.fake");
		if (!facts.known) throw new Error("a.fake should be known");

		expect(facts.depth).toBe("full");
		expect(facts.contentHash).toBe(hashContent(TEXT));
		expect(facts.words).toEqual(WORDS);
		expect(
			facts.declarations.map((declaration) => ({
				kind: declaration.kind,
				name: coords.sliceRange(declaration.range),
			})),
		).toEqual([
			{ kind: "class", name: "Widget" },
			{ kind: "function", name: "build" },
		]);
		expect(facts.references).toEqual([
			{ role: "read", range: span("Widget", TEXT.indexOf("return")), bound: true },
			{ role: "call", range: span("create"), bound: false },
		]);
		expect(facts.literals).toEqual([]);
		expect(facts.comments).toEqual([]);
	});

	it("refuses an unindexed module the way fileNotes refuses one", () => {
		const probe = liveProbe(fakeSupervisor({ claims: [CLAIMS], words: WORDS }));
		const reads = new PaintReads(store, probe, () => 0);

		expect(reads.moduleFacts("ghost.fake")).toEqual({ module: "ghost.fake", known: false, reason: "notIndexed" });
	});

	it("refuses an indexed module no running provider currently owns", () => {
		plantModule(store);
		const probe = liveProbe(fakeSupervisor({ claims: [] }));
		const reads = new PaintReads(store, probe, () => 0);

		expect(reads.moduleFacts("a.fake")).toEqual({ module: "a.fake", known: false, reason: "unowned" });
	});

	it("says outline before the upgrade, empty references, and full with rows after it", () => {
		const probe = liveProbe(fakeSupervisor({ claims: [CLAIMS], words: WORDS }));
		const reads = new PaintReads(store, probe, () => 0);
		const widget = "lexicon fake b.fake Widget#";
		const declaration = {
			symbolId: widget,
			kind: "class" as const,
			name: "Widget",
			range: span("export class Widget {}"),
			selectionRange: span("Widget"),
			visibility: "public" as const,
		};

		// The outline pass: a declaration, no references yet.
		store.replaceFile({
			module: "b.fake",
			contentHash: hashContent(TEXT),
			depth: "outline",
			declarations: [declaration],
			references: [],
		});

		const outline = reads.moduleFacts("b.fake");
		if (!outline.known) throw new Error("b.fake should be known");
		expect(outline.depth).toBe("outline");
		expect(outline.references).toEqual([]);

		// The upgrade re-commits at full depth, with the reference the outline pass could not extract.
		store.replaceFile({
			module: "b.fake",
			contentHash: hashContent(TEXT),
			declarations: [declaration],
			references: [
				{
					name: "Widget",
					range: span("Widget", TEXT.indexOf("return")),
					role: "read",
					fromId: widget,
					binding: { status: "bound", symbolId: widget, provenance: "bound" },
				},
			],
		});

		const full = reads.moduleFacts("b.fake");
		if (!full.known) throw new Error("b.fake should still be known");
		expect(full.depth).toBe("full");
		expect(full.references).toHaveLength(1);
	});
});

describe("parseFacts", () => {
	it("answers facts for the handed text, a declaration present only there, and leaves the store untouched", async () => {
		plantModule(store);
		const candidate = "export class Widget {}\nexport class Basket {}\n";
		const candidateCoords = coordinatesOf(candidate);
		const probe = liveProbe(fakeSupervisor({ claims: [CLAIMS], words: WORDS }));
		const reads = new PaintReads(store, probe, () => 0);

		const parsed = await reads.parseFacts("a.fake", candidate);
		if (!parsed.ok) throw new Error(parsed.reason);

		expect(parsed.depth).toBe("full");
		expect(parsed.contentHash).toBe(hashContent(candidate));
		expect(parsed.words).toEqual(WORDS);
		expect(parsed.declarations.map((declaration) => candidateCoords.sliceRange(declaration.range))).toEqual([
			"Widget",
			"Basket",
		]);

		// Nothing was written: the store still answers the rows it held before the candidate.
		const stillOld = reads.moduleFacts("a.fake");
		if (!stillOld.known) throw new Error("a.fake should still be known");
		expect(stillOld.declarations.map((declaration) => coords.sliceRange(declaration.range))).toEqual([
			"Widget",
			"build",
		]);
	});

	it("refuses when the candidate has a syntax error, naming the reason", async () => {
		plantModule(store);
		const probe = liveProbe(fakeSupervisor({ claims: [CLAIMS], words: WORDS }));
		const reads = new PaintReads(store, probe, () => 0);

		const parsed = await reads.parseFacts("a.fake", "SYNTAX export class X {}");

		expect(parsed.ok).toBe(false);
		if (parsed.ok) throw new Error("unreachable");
		expect(parsed.reason).toContain("the candidate does not parse: syntax error");
	});

	it("refuses a module no provider owns", async () => {
		const probe = liveProbe(fakeSupervisor({ claims: [] }));
		const reads = new PaintReads(store, probe, () => 0);

		const parsed = await reads.parseFacts("a.fake", "export class X {}");

		expect(parsed.ok).toBe(false);
		if (parsed.ok) throw new Error("unreachable");
		expect(parsed.reason).toContain("no provider owns a.fake");
	});
});

describe("symbolAt", () => {
	/** Counts probes; `refuse` answers every candidate with an error diagnostic. */
	function probing(options: { claims?: (typeof CLAIMS)[]; refuse?: boolean } = {}) {
		let generation = 0;
		const probes: string[] = [];
		const supervisor = fakeSupervisor({
			claims: options.claims ?? [CLAIMS],
			words: WORDS,
			answers: {
				probeFile: (request) => {
					probes.push(request.text);
					const facts = parseFake(request);
					return options.refuse === true
						? { ...facts, diagnostics: [{ severity: "error" as const, message: "syntax error" }] }
						: facts;
				},
			},
		});
		const reads = new PaintReads(store, liveProbe(supervisor), () => generation);
		const ask = async (request: { contentHash?: string; text?: string; line?: number }, module = "a.fake") => {
			const reply = await reads.symbolAt({
				module,
				position: { line: request.line ?? 0, character: 14 },
				...request,
			});
			return "needsText" in reply ? "needsText" : reply.found ? `${reply.via} ${reply.symbolId}` : reply.reason;
		};
		return { ask, probes, move: () => generation++ };
	}

	const DIRTY = `${TEXT}\nexport class Extra {}`;

	it("says an unstored module is not indexed or unowned, even handed text, and asks no provider", async () => {
		const claimed = probing();
		const unclaimed = probing({ claims: [] });

		expect([
			await claimed.ask({ text: DIRTY }, "ghost.fake"),
			await unclaimed.ask({ contentHash: hashContent(DIRTY) }, "ghost.fake"),
			claimed.probes.length + unclaimed.probes.length,
		]).toEqual(["notIndexed", "unowned", 0]);
	});

	it("answers stored bytes from the store, other bytes once handed, then kept by hash until the generation moves", async () => {
		plantModule(store);
		const p = probing();
		const answers = [
			await p.ask({ contentHash: hashContent(TEXT) }),
			await p.ask({ contentHash: hashContent(DIRTY) }),
			await p.ask({ text: DIRTY }),
			await p.ask({ contentHash: hashContent(DIRTY), line: 4 }),
		];
		const probesBeforeMove = p.probes.length;
		p.move();

		expect({ answers, probesBeforeMove, afterMove: await p.ask({ contentHash: hashContent(DIRTY) }) }).toEqual({
			answers: [
				`declaration ${WIDGET}`,
				"needsText",
				"declaration lexicon fake a.fake Widget#",
				"declaration lexicon fake a.fake Extra#",
			],
			probesBeforeMove: 1,
			afterMove: "needsText",
		});
	});

	it("keeps no refused candidate, so its bytes are asked for again", async () => {
		plantModule(store);
		const p = probing({ refuse: true });

		expect([await p.ask({ text: DIRTY }), await p.ask({ contentHash: hashContent(DIRTY) })]).toEqual([
			"unparsed",
			"needsText",
		]);
	});

	it("follows an imported name through aliases and re-exports to the declaration it imports", async () => {
		const LIB = "export class Widget { Missing }";
		const lib = coordinatesOf(LIB);
		const libWidget = "lexicon fake lib.fake Widget#";
		store.replaceFile({
			module: "lib.fake",
			contentHash: hashContent(LIB),
			declarations: [
				{
					symbolId: libWidget,
					kind: "class",
					name: "Widget",
					range: lib.rangeAt(0, LIB.length) as Range,
					visibility: "public",
					exported: true,
				},
				{
					symbolId: `${libWidget}Missing.`,
					kind: "property",
					name: "Missing",
					range: lib.rangeAt(LIB.indexOf("Missing"), LIB.indexOf("Missing") + 7) as Range,
					visibility: "public",
					containerId: libWidget,
				},
				{
					symbolId: "lexicon fake lib.fake default#",
					kind: "class",
					name: "default",
					range: lib.rangeAt(0, 6) as Range,
					visibility: "public",
					exported: true,
				},
			],
			references: [],
		});
		const nowhere = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };
		const line = (at: number) => ({ start: { line: at, character: 0 }, end: { line: at, character: 1 } });
		store.replaceFile({
			module: "barrel.fake",
			contentHash: hashContent("barrel"),
			// Unexported, so the star re-export's Widget still answers.
			declarations: [
				{
					symbolId: "lexicon fake barrel.fake Widget#",
					kind: "class",
					name: "Widget",
					range: nowhere,
					visibility: "public",
					exported: false,
				},
			],
			references: [],
			imports: [
				{
					specifier: "./lib",
					edges: [edge("named", line(1), { name: "Widget", range: line(1), bindsLocally: false })],
				},
				{
					specifier: "./lib",
					edges: [
						edge("wildcard", line(2), {
							selector: { kind: "allButDefault" },
							bindsLocally: false,
							order: 1,
						}),
					],
				},
				{
					specifier: "./lib",
					edges: [
						edge("wildcard", line(3), { selector: { kind: "visible" }, bindsLocally: false, order: 2 }),
					],
				},
			],
			exports: [
				forwarding("forward", line(1), { name: "Thing", range: line(1) }),
				forwarding("star", line(2), { order: 1 }),
				forwarding("namespace", line(3), { name: "ns", range: line(3), order: 2 }),
			],
			resolutions: new Map([["./lib", landed("lib.fake")]]),
		});
		const MAIN = 'import Def, { Thing as Alias, Widget, ns, Missing } from "./barrel";';
		const main = coordinatesOf(MAIN);
		const at = (needle: string) =>
			main.rangeAt(MAIN.indexOf(needle), MAIN.indexOf(needle) + needle.length) as Range;
		store.replaceFile({
			module: "main.fake",
			contentHash: hashContent(MAIN),
			declarations: [],
			references: [],
			imports: [
				{
					specifier: "./barrel",
					edges: [
						edge("default", at("Def"), { local: "Def", localRange: at("Def") }),
						edge("named", at("Thing"), {
							name: "Thing",
							range: at("Thing"),
							local: "Alias",
							localRange: at("Alias"),
							order: 1,
						}),
						edge("named", at("Widget"), { name: "Widget", range: at("Widget"), order: 2 }),
						edge("named", at("ns"), { name: "ns", range: at("ns"), order: 3 }),
						edge("named", at("Missing"), { name: "Missing", range: at("Missing"), order: 4 }),
					],
				},
			],
			resolutions: new Map([["./barrel", landed("barrel.fake")]]),
		});
		store.settleProjections();
		const reads = new PaintReads(store, liveProbe(fakeSupervisor({ claims: [CLAIMS], words: WORDS })), () => 0);
		const under = async (needle: string) => {
			const reply = await reads.symbolAt({ module: "main.fake", position: at(needle).start });
			return "needsText" in reply ? "needsText" : reply.found ? `${reply.via} ${reply.symbolId}` : reply.reason;
		};

		expect({
			sourceName: await under("Thing"),
			alias: await under("Alias"),
			throughStar: await under("Widget"),
			namespace: await under("ns"),
			member: await under("Missing"),
			defaultThroughStar: await under("Def"),
		}).toEqual({
			sourceName: `reference ${libWidget}`,
			alias: `reference ${libWidget}`,
			throughStar: `reference ${libWidget}`,
			namespace: "noSymbol",
			member: "noSymbol",
			defaultThroughStar: "noSymbol",
		});
	});

	it("follows an imported name through a scope landing to the one member carrying it", async () => {
		const LIB = "class Widget {}";
		const widget = "lexicon fake lib.fake Widget#";
		store.replaceFile({
			module: "lib.fake",
			contentHash: hashContent(LIB),
			declarations: [
				{
					symbolId: widget,
					kind: "class",
					name: "Widget",
					range: coordinatesOf(LIB).rangeAt(0, LIB.length) as Range,
					visibility: "public",
				},
			],
			references: [],
			provider: "fake",
			scopeContributions: [{ kind: "packageScope", scopeId: "com.acme", members: [widget] }],
		});
		const MAIN = 'import { Widget } from "com.acme";';
		const main = coordinatesOf(MAIN);
		const at = main.rangeAt(MAIN.indexOf("Widget"), MAIN.indexOf("Widget") + 6) as Range;
		store.replaceFile({
			module: "main.fake",
			contentHash: hashContent(MAIN),
			declarations: [],
			references: [],
			imports: [{ specifier: "com.acme", edges: [edge("named", at, { name: "Widget", range: at })] }],
			provider: "fake",
			resolutions: new Map([
				[
					"com.acme",
					{ status: "resolved", landing: { kind: "packageScope", providerId: "fake", scopeId: "com.acme" } },
				],
			]),
		});
		const reads = new PaintReads(store, liveProbe(fakeSupervisor({ claims: [CLAIMS], words: WORDS })), () => 0);
		const reply = await reads.symbolAt({ module: "main.fake", position: at.start });

		expect("found" in reply && reply.found ? reply.symbolId : reply).toBe(widget);
	});
});
