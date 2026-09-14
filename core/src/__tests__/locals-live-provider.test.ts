import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { discoverProviders, lexiconRoot, startProviders } from "../providers";
import { LexiconService } from "../service";
import { sourceReader } from "../sourceRead";
import { IndexStore } from "../store";
import { ProviderSupervisor } from "../supervisor";

const TYPESCRIPT_ONLY = discoverProviders(lexiconRoot()).filter((command) => command.directory === "typescript");

const SOURCE = [
	"export const handler = (event: string) => {",
	"\t// arrow local note",
	'\tconst inner = event + "suffix";',
	"\tfunction helper() {",
	"\t\t// helper local note",
	"\t\tconst deep = 1;",
	"\t\treturn deep;",
	"\t}",
	"\treturn inner + helper();",
	"};",
	"",
	"export class Shop {",
	"\ttotal = (amount: number) => {",
	"\t\t// field arrow note",
	"\t\tconst taxed = amount * 2;",
	"\t\treturn taxed;",
	"\t};",
	"\tget price(): number {",
	"\t\t// getter note",
	"\t\tconst p = 3;",
	"\t\treturn p;",
	"\t}",
	"}",
	"",
	"export namespace Acme {",
	"\texport class Line {}",
	"\texport class Cart {",
	"\t\tadd(line: Line): Line {",
	"\t\t\treturn line;",
	"\t\t}",
	"\t}",
	"}",
	"",
].join("\n");

let root: string;
let store: IndexStore;
let supervisor: ProviderSupervisor;

beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), "lexicon-live-locals-"));
	store = IndexStore.open(path.join(root, "index.sqlite")).store;
	supervisor = new ProviderSupervisor();
});

afterEach(() => {
	supervisor.stopAll();
	store.close();
	rmSync(root, { recursive: true, force: true });
});

describe("a real provider's function values and namespaces", () => {
	it.skipIf(TYPESCRIPT_ONLY.length === 0)(
		"keeps arrow and getter locals out of members, their evidence on the function, and namespaces holding nothing",
		async () => {
			mkdirSync(path.join(root, "src"), { recursive: true });
			writeFileSync(path.join(root, "src", "work.ts"), SOURCE);
			execFileSync("git", ["init", "-q"], { cwd: root });
			execFileSync("git", ["add", "-A"], { cwd: root });
			await startProviders(supervisor, root, { commands: TYPESCRIPT_ONLY });
			const service = new LexiconService(store, supervisor, sourceReader(root), root);
			await service.indexWorkspace();

			const scope = service.knowledgeScope({ module: "src/work.ts" });
			expect(scope?.symbols.map((entry) => [entry.symbol.name, entry.depth])).toEqual([
				["handler", 0],
				["total", 1],
				["price", 1],
				["Shop", 0],
				["Line", 0],
				["add", 1],
				["Cart", 0],
			]);

			const idOf = (name: string) => store.declarationsNamed(name)[0]?.symbolId as string;
			const evidence = async (name: string) => {
				const facts = (await service.factsFor(idOf(name)))?.facts ?? [];
				return facts
					.filter((fact) => fact.kind !== "declaration" && fact.kind !== "reference")
					.map((fact) => fact.kind);
			};
			expect(await evidence("handler")).toEqual(["literal", "literal", "comment", "comment"]);
			expect(await evidence("total")).toEqual(["literal", "comment"]);
			expect(await evidence("price")).toEqual(["literal", "comment"]);
			expect(await evidence("Shop")).toEqual([]);

			const line = service.findReferences(idOf("Line"), 50).references;
			expect(line.map((row) => row.topLevel?.name)).toEqual(["Cart", "Cart"]);
			expect(service.describe(idOf("Line"))?.graph.dependents).toBe(1);
		},
		60_000,
	);
});
