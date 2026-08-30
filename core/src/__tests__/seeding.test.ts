import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type Declaration, KnowledgeGapsSchema, type Literal, type Reference } from "@nyaa-lexicon/protocol";
import type { AttachedComment } from "../commentAttach";
import type { GeneratedVerdict } from "../fileScope";
import { RESERVED_HUBS } from "../knowledge";
import { LexiconService } from "../service";
import { fromText, sourceReader } from "../sourceRead";
import { IndexStore } from "../store";
import { ProviderSupervisor } from "../supervisor";
import { fakeSupervisor } from "./fakeProvider";

////////////////////////////////
//  Helpers

let dir: string;
let store: IndexStore;
let service: LexiconService;

const at = (line: number) => ({ start: { line, character: 0 }, end: { line, character: 8 } });

interface Planted {
	name: string;
	fanIn?: number;
	comment?: boolean;
	literal?: boolean;
	/** A reference from inside the declaration itself, which is no evidence of use. */
	selfRef?: boolean;
	/** Null plants a declaration whose provider gave no verdict. */
	exported?: boolean | null;
}

/** One module of one language; each declaration is called `fanIn` times from a private caller in the file. */
function plant(
	language: string,
	module: string,
	declarations: Planted[],
	generated: GeneratedVerdict | null = { status: "no" },
): string[] {
	const ids = declarations.map((d) => `lexicon ${language} ${module} ${d.name}#`);
	const caller = `lexicon ${language} ${module} Caller#`;
	const decls: Declaration[] = [
		{
			symbolId: caller,
			kind: "function",
			name: "Caller",
			range: at(0),
			selectionRange: at(0),
			visibility: "public",
			exported: false,
		},
		...declarations.map(
			(d, index): Declaration => ({
				symbolId: ids[index] as string,
				kind: "class",
				name: d.name,
				range: at(index + 1),
				selectionRange: at(index + 1),
				visibility: "public",
				...(d.exported === null ? {} : { exported: d.exported ?? true }),
			}),
		),
	];
	const refs: Reference[] = declarations.flatMap((d, index) =>
		Array.from({ length: (d.fanIn ?? 0) + (d.selfRef ? 1 : 0) }, (_, n) => ({
			name: d.name,
			role: "call" as const,
			range: at(100 + index * 50 + n),
			binding: { status: "bound" as const, symbolId: ids[index] as string, provenance: "bound" as const },
			fromId: d.selfRef && n === (d.fanIn ?? 0) ? (ids[index] as string) : caller,
		})),
	);
	const comments: AttachedComment[] = declarations.flatMap((d, index) =>
		d.comment
			? [
					{
						range: at(index + 1),
						raw: `// ${d.name} holds doctrine.`,
						normalized: `${d.name} holds doctrine.`,
						form: "leading" as const,
						placement: "above" as const,
						anchorId: ids[index] as string,
					},
				]
			: [],
	);
	const literals: Literal[] = declarations.flatMap((d, index) =>
		d.literal
			? [
					{
						kind: "string" as const,
						value: `${d.name}.event`,
						range: at(index + 1),
						containerId: ids[index] as string,
					},
				]
			: [],
	);
	store.replaceFile(
		module,
		`h-${module}`,
		decls,
		refs,
		[],
		literals,
		"full",
		comments,
		[],
		[],
		"code",
		[],
		generated,
	);
	return ids;
}

const gaps = (limit = 60) => service.knowledgeGaps(undefined, "describe", limit);
const seededIds = (limit = 60) => gaps(limit).rows.map((row) => row.symbolId);
const names = (declarations: string[], fanIn: (index: number) => number, comment = true): Planted[] =>
	declarations.map((name, index) => ({ name, fanIn: fanIn(index), comment }));

beforeEach(() => {
	dir = mkdtempSync(path.join(tmpdir(), "lexicon-seeding-"));
	store = IndexStore.open(path.join(dir, "index.sqlite")).store;
	service = new LexiconService(
		store,
		new ProviderSupervisor(),
		fromText(() => null),
		dir,
	);
});

afterEach(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

////////////////////////////////
//  Tests

describe("the seeded fallback interleaves languages", () => {
	it("leads with the reserved hubs, then takes one candidate per language in turn, languages by declaration count", () => {
		const ts = plant(
			"typescript",
			"core.ts",
			names(["A", "B", "C", "D", "E", "F", "G", "H"], (index) => 20 - index),
		);
		const kt = plant(
			"kotlin",
			"Console.kt",
			names(["K1", "K2", "K3", "K4"], () => 3),
		);

		const page = gaps(8);
		expect(page).toMatchObject({
			seeded: true,
			filtered: true,
			total: 8,
			seededUnknown: { generated: 0, exported: 0 },
		});
		expect(page.rows.map((row) => row.symbolId)).toEqual([
			...ts.slice(0, RESERVED_HUBS),
			...([ts[5], kt[0], ts[6]] as string[]),
		]);
	});

	it("never seeds a generated container, so the language's best comment-bearing declaration leads it", () => {
		plant(
			"typescript",
			"core.ts",
			names(["A", "B"], (index) => 10 - index),
		);
		const [protocol] = plant("kotlin", "gen/Protocol.kt", [{ name: "Protocol", fanIn: 50 }], { status: "yes" });
		const [console] = plant("kotlin", "Console.kt", [{ name: "Console", fanIn: 1, comment: true }]);

		const seeded = seededIds();
		expect(seeded).not.toContain(protocol as string);
		expect(seeded).toContain(console as string);
		expect(store.generatedOf("gen/Protocol.kt")).toEqual({ status: "yes" });
	});

	it("seeds candidates git could not judge, says how many, and reads the reason back", () => {
		const ids = plant(
			"typescript",
			"core.ts",
			names(["A", "B"], (index) => 5 - index),
			{
				status: "unknown",
				reason: "noGit",
			},
		);

		const page = gaps();
		expect(page.rows.map((row) => row.symbolId)).toEqual(ids);
		expect(page.seededUnknown).toEqual({ generated: 2, exported: 0 });
		expect(store.generatedOf("core.ts")).toEqual({ status: "unknown", reason: "noGit" });
	});

	it("keeps a declaration with no export verdict eligible, counts it on the page only, and drops one exported false", () => {
		const [unknownExport, hidden, plain, late] = plant("python", "tool.py", [
			{ name: "Extract", fanIn: 4, exported: null },
			{ name: "Helper", fanIn: 3, exported: false },
			{ name: "Run", fanIn: 2 },
			{ name: "Late", fanIn: 1, exported: null },
		]);

		const page = gaps(2);
		expect(page.rows.map((row) => row.symbolId)).toEqual([unknownExport as string, plain as string]);
		expect(page.seededUnknown).toEqual({ generated: 0, exported: 1 });
		expect(seededIds()).toEqual([unknownExport as string, plain as string, late as string]);
		expect(seededIds()).not.toContain(hidden as string);
	});

	it("seeds what is still unanswered once every gap has been answered, counting unknowns on the page only", async () => {
		const [hub, next] = plant("typescript", "core.ts", [
			{ name: "Hub", fanIn: 9, comment: true, exported: null },
			{ name: "Next", fanIn: 8, comment: true },
		]);
		const cited = store.declaration(hub as string)?.factId as string;
		await service.recordAnswer(hub as string, "describe", "The hub.", [cited]);

		const page = gaps();
		expect(page).toMatchObject({ seeded: true, total: 1, seededUnknown: { generated: 0, exported: 0 } });
		expect(page.rows.map((row) => row.symbolId)).toEqual([next as string]);
	});

	it("reads a pair the store never writes as no verdict, in the decoder and in the seeding alike", () => {
		const file = path.join(dir, "index.sqlite");
		const ids = plant(
			"typescript",
			"core.ts",
			names(["A"], () => 1),
		);
		store.close();
		const db = new DatabaseSync(file);
		db.exec("UPDATE files SET generated = 'yes', generatedReason = 'stray' WHERE module = 'core.ts'");
		db.close();
		store = IndexStore.open(file).store;
		service = new LexiconService(
			store,
			new ProviderSupervisor(),
			fromText(() => null),
			dir,
		);

		expect(store.generatedOf("core.ts")).toBeNull();
		const page = gaps();
		expect(page.rows.map((row) => row.symbolId)).toEqual(ids);
		expect(page.seededUnknown).toEqual({ generated: 1, exported: 0 });
	});

	it("finishes a column migration that stopped between the two adds", () => {
		const file = path.join(dir, "index.sqlite");
		store.close();
		const db = new DatabaseSync(file);
		db.exec("ALTER TABLE files DROP COLUMN generatedReason");
		db.close();
		store = IndexStore.open(file).store;
		service = new LexiconService(
			store,
			new ProviderSupervisor(),
			fromText(() => null),
			dir,
		);

		const ids = plant(
			"typescript",
			"core.ts",
			names(["A"], () => 1),
			{ status: "unknown", reason: "gitFailed" },
		);
		expect(store.generatedOf("core.ts")).toEqual({ status: "unknown", reason: "gitFailed" });
		expect(seededIds()).toEqual(ids);
	});

	it("orders equal fan-in by id, the same on two runs", () => {
		const ids = plant(
			"kotlin",
			"Console.kt",
			names(["K4", "K2", "K3", "K1"], () => 3),
		);

		const first = seededIds();
		expect(first).toEqual([...ids].sort());
		expect(seededIds()).toEqual(first);
		expect(store.mostReferenced(4).map((row) => row.symbolId)).toEqual([...ids].sort());
	});

	it("seeds a comment-less declaration that carries references or a literal, never one carrying nothing", () => {
		const [called, bare, literal, recursive] = plant("typescript", "core.ts", [
			{ name: "Called", fanIn: 2 },
			{ name: "Bare" },
			{ name: "Literal", literal: true },
			{ name: "Recursive", selfRef: true },
		]);

		expect(seededIds()).toEqual([called as string, literal as string]);
		expect(seededIds()).not.toContain(bare as string);
		expect(seededIds()).not.toContain(recursive as string);
	});

	it("counts a literal as substance in code only, and a heading by the prose under it", () => {
		const field = "lexicon json config.json name.";
		const heading = "lexicon markdown guide.md Principles/";
		const bare = "lexicon markdown guide.md Empty/";
		const declaration = (
			symbolId: string,
			kind: "property" | "heading",
			name: string,
			line: number,
		): Declaration => ({
			symbolId,
			kind,
			name,
			range: at(line),
			selectionRange: at(line),
			visibility: "public",
		});
		store.replaceFile(
			"config.json",
			"h-json",
			[declaration(field, "property", "name", 0)],
			[],
			[],
			[{ kind: "string", value: "switchboard", range: at(0), containerId: field }],
			"full",
			[],
			[],
			[],
			"data",
			[],
			{ status: "no" },
		);
		store.replaceFile(
			"guide.md",
			"h-md",
			[declaration(heading, "heading", "Principles", 0), declaration(bare, "heading", "Empty", 5)],
			[],
			[],
			[],
			"full",
			[],
			[{ range: at(1), text: "No band-aids. Weigh the long-run cost.", fenced: false, anchorId: heading }],
			[],
			"document",
			[],
			{ status: "no" },
		);

		expect(seededIds()).toEqual([heading]);
	});

	it("reads a row written without a verdict as unknown, and says so", () => {
		const ids = plant(
			"typescript",
			"core.ts",
			names(["A"], () => 1),
			null,
		);

		expect(store.generatedOf("core.ts")).toBeNull();
		const page = gaps();
		expect(page.rows.map((row) => row.symbolId)).toEqual(ids);
		expect(page.seededUnknown).toEqual({ generated: 1, exported: 0 });
	});

	it("is read by an older client, which strips the field it does not know", () => {
		plant(
			"typescript",
			"core.ts",
			names(["A"], () => 1),
		);

		const parsed = KnowledgeGapsSchema.omit({ seededUnknown: true }).parse(gaps());
		expect("seededUnknown" in parsed).toBe(false);
		expect(parsed.seeded).toBe(true);
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
		execFileSync("git", ["init", "-q"], { cwd: root });
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
		execFileSync("git", ["init", "-q"], { cwd: root });
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
