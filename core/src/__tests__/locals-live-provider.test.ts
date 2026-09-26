import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { lexiconRoot, startProviders } from "../providers";
import { LexiconService } from "../service";
import { sourceReader } from "../sourceRead";
import { IndexStore } from "../store";
import { ProviderSupervisor } from "../supervisor";
import { gitAdd, gitInit } from "./gitFixture";

/** Uses source, not build. */
function sourceProvider(name: string) {
	const main = path.join(lexiconRoot(), "providers", name, "src", "main.ts");
	return existsSync(main) ? [{ directory: name, command: [process.execPath, "run", main] }] : [];
}

const TYPESCRIPT = [
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

const CSHARP = [
	"namespace Acme",
	"{",
	"    public class Shop",
	"    {",
	"        public Func<int, int> Tax = amount =>",
	"        {",
	"            var taxed = amount * 2;",
	"            return taxed;",
	"        };",
	"",
	"        public void Run()",
	"        {",
	"            Action go = () => { };",
	"        }",
	"    }",
	"}",
	"",
].join("\n");

const KOTLIN = [
	"package shop",
	"",
	"class Shop {",
	"    val total = run {",
	"        class Line {",
	"            fun price(): Int {",
	"                // price note",
	"                return 1",
	"            }",
	"        }",
	"        Line().price()",
	"    }",
	"",
	"    val label: String",
	"        get() {",
	'            val prefix = "x"',
	"            return prefix",
	"        }",
	"",
	"    fun checkout() {}",
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

async function indexed(files: Record<string, string>, providers: string[]): Promise<LexiconService> {
	for (const [module, text] of Object.entries(files)) {
		mkdirSync(path.dirname(path.join(root, module)), { recursive: true });
		writeFileSync(path.join(root, module), text);
	}
	await gitInit(root);
	await gitAdd(root, "-A");
	await startProviders(supervisor, root, { commands: providers.flatMap(sourceProvider) });
	const service = new LexiconService(store, supervisor, sourceReader(root), root);
	await service.indexWorkspace();
	return service;
}

const idOf = (name: string) => store.declarationsNamed(name)[0]?.symbolId as string;

describe("a real provider's function values and namespaces", () => {
	it.skipIf(sourceProvider("typescript").length === 0)(
		"keeps arrow and getter locals out of members, their evidence on the function, and namespaces holding nothing",
		async () => {
			const service = await indexed({ "src/work.ts": TYPESCRIPT }, ["typescript"]);

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

	it.skipIf(sourceProvider("csharp").length === 0)(
		"keeps what a C# lambda declares out of its class's members",
		async () => {
			const service = await indexed({ "Shop.cs": CSHARP }, ["csharp"]);

			const scope = service.knowledgeScope({ module: "Shop.cs" });
			expect(scope?.symbols.map((entry) => [entry.symbol.name, entry.depth])).toEqual([
				["Tax", 1],
				["Run", 1],
				["Shop", 0],
			]);
			expect(scope?.localsExcluded).toBe(1);
			expect(service.describe(idOf("Shop"))?.members.map((member) => member.name)).toEqual(["Tax", "Run"]);
		},
		60_000,
	);

	it.skipIf(sourceProvider("kotlin").length === 0)(
		"keeps what a Kotlin property's initializer and getter declare out of members",
		async () => {
			const service = await indexed({ "src/Shop.kt": KOTLIN }, ["kotlin"]);

			const scope = service.knowledgeScope({ module: "src/Shop.kt" });
			expect(scope?.symbols.map((entry) => [entry.symbol.name, entry.depth])).toEqual([
				["total", 1],
				["label", 1],
				["checkout", 1],
				["Shop", 0],
			]);

			const evidence = async (name: string) => {
				const facts = (await service.factsFor(idOf(name)))?.facts ?? [];
				return facts
					.filter((fact) => fact.kind !== "declaration" && fact.kind !== "reference")
					.map((fact) => fact.kind);
			};
			expect(await evidence("total")).toEqual(["literal", "comment"]);
			expect(await evidence("label")).toEqual(["literal"]);
			expect(await evidence("Shop")).toEqual([]);
		},
		60_000,
	);
});

const CATALOG = [
	"export const CATALOG = [",
	"\t{",
	"\t\trun: async (input: string) => {",
	"\t\t\tconst result = await work(input);",
	"\t\t\treturn result;",
	"\t\t},",
	"\t},",
	"];",
	"",
	"export function work(value: string): Promise<string> {",
	"\tconst doubled = value + value;",
	"\treturn Promise.resolve(doubled);",
	"}",
	"",
	"export class Shop {",
	"\tcount = 0;",
	"\tadd(): number {",
	"\t\treturn this.count;",
	"\t}",
	"}",
	"",
].join("\n");

const CATALOG_USER = ['import { Shop, work } from "./catalog";', "", 'work("a");', "new Shop().add();", ""].join("\n");

describe("an outline", () => {
	it.skipIf(sourceProvider("typescript").length === 0)(
		"lists what a file declares, never a local in any body, each row counted as describe counts it",
		async () => {
			const service = await indexed({ "src/catalog.ts": CATALOG, "src/use.ts": CATALOG_USER }, ["typescript"]);

			const outline = service.outline("src/catalog.ts");
			expect(outline.map((row) => row.name)).toEqual(["CATALOG", "work", "Shop", "count", "add"]);
			for (const row of outline) {
				expect([row.name, row.referenceCount]).toEqual([
					row.name,
					service.describe(row.symbolId)?.referenceCount,
				]);
			}
			expect(outline.find((row) => row.name === "work")?.referenceCount).toBe(2);
		},
		60_000,
	);
});

describe("a real provider's data", () => {
	it.each([
		["json", "config.json", '{ "server": { "port": 80, "tls": { "cert": "a.pem" } } }\n'],
		["yaml", "config.yml", "server:\n  port: 80\n  tls:\n    cert: a.pem\n"],
	])(
		"lists a %s file's nested keys as members",
		async (provider, module, text) => {
			if (sourceProvider(provider).length === 0) return;
			const service = await indexed({ [module]: text }, [provider]);

			const scope = service.knowledgeScope({ module });
			expect(scope?.symbols.map((entry) => [entry.symbol.name, entry.depth])).toEqual([
				["port", 1],
				["cert", 2],
				["tls", 1],
				["server", 0],
			]);
			expect(scope?.localsExcluded).toBe(0);
			expect(service.describe(idOf("server"))?.members.map((member) => member.name)).toEqual(["port", "tls"]);
			expect(service.describe(idOf("tls"))?.members.map((member) => member.name)).toEqual(["cert"]);
		},
		60_000,
	);
});
