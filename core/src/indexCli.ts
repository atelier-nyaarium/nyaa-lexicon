// Index a workspace and answer one question about it, without a daemon or an agent.
//
//   bun run core/src/indexCli.ts <workspace> [symbolName]
//
// The shortest path from a repository to a real answer, which is what makes a claim about this
// tool checkable rather than described.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describeStart, startProviders } from "./providers.js";
import { LexiconService } from "./service.js";
import { IndexStore } from "./store.js";
import { ProviderSupervisor } from "./supervisor.js";

////////////////////////////////
//  Main

async function main(argv: string[]): Promise<void> {
	const [workspace, query] = argv;
	if (workspace === undefined) {
		console.error("usage: index-workspace <workspace> [symbolName]");
		process.exit(2);
	}

	const root = path.resolve(workspace);
	const { store } = IndexStore.open(":memory:");
	const supervisor = new ProviderSupervisor();
	const providers = await startProviders(supervisor, root);
	console.log(`providers:\n${describeStart(providers)}`);

	const service = new LexiconService(
		store,
		supervisor,
		(module) => {
			try {
				return readFileSync(path.join(root, module), "utf8");
			} catch {
				return null;
			}
		},
		root,
	);

	const started = Date.now();
	const outcomes = await service.indexWorkspace();
	const elapsed = Date.now() - started;

	const indexed = outcomes.filter((o) => o.action === "indexed");
	const failures = outcomes.filter((o) => o.failure !== undefined);
	const symbols = indexed.reduce((total, o) => total + (o.declarations ?? 0), 0);
	console.log(`scope: ${service.scopeReport()}`);
	console.log(`${indexed.length} files, ${symbols} symbols, ${elapsed}ms`);
	if (failures.length > 0)
		console.log(`index failures: ${failures.map((o) => `${o.module}: ${o.failure}`).join(", ")}`);

	const skipped = outcomes.filter((o) => o.action === "skipped");
	if (skipped.length > 0) console.log(`${skipped.length} skipped (${skipped[0]?.reason})`);

	if (query !== undefined) {
		const found = service.findByName(query);
		console.log(`\n${found.length} named ${query}:`);
		for (const symbol of found) {
			const described = service.describe(symbol.symbolId);
			console.log(`  ${symbol.kind} ${symbol.name}  ${symbol.module}`);
			console.log(`    ${symbol.signature ?? "(no signature)"}`);
			console.log(`    members ${described?.members.length ?? 0}, used in ${described?.referenceCount ?? 0}`);
		}
	}

	supervisor.stopAll();
	store.close();
}

if (import.meta.main) await main(process.argv.slice(2));
