// The graded dogfood: ask a real repository questions whose right answers are already known, and
// print pass or fail per check.
//
//   bun dist/grade.js <path to a switchboard checkout>
//
// Producing output is not the same as producing right output, so every check here names an
// expected answer a reader can verify by opening the file.
//
// The checks below are written against switchboard specifically, naming symbols and the files
// they live in, so pointing this at anything else fails every check rather than grading it.

import { existsSync } from "node:fs";
import path from "node:path";
import { refuseRuntime } from "@nyaa-lexicon/client";
import { systemClock } from "./clock.js";
import { startProviders } from "./providers.js";
import { LexiconService } from "./service.js";
import { sourceReader } from "./sourceRead.js";
import { IndexStore } from "./store.js";
import { ProviderSupervisor } from "./supervisor.js";

////////////////////////////////
//  Interfaces & Types

interface Check {
	name: string;
	run: (service: LexiconService) => Promise<{ ok: boolean; detail: string } | { skip: string }>;
}

////////////////////////////////
//  Constants

const CHECKS: Check[] = [
	{
		name: "finds a function in the file its own map names",
		run: async (service) => {
			const found = service.findByName("refusalError");
			const module = found[0]?.module ?? "none";
			return {
				ok: found.length === 1 && module === "src/gateway/boardAuthority.ts",
				detail: `${found.length} match, in ${module}`,
			};
		},
	},
	{
		name: "reports a class with its real members",
		run: async (service) => {
			const found = service.findByName("SessionStore")[0];
			if (!found) return { ok: false, detail: "SessionStore was not indexed" };
			const described = service.describe(found.symbolId);
			const members = described?.members.map((m) => m.name) ?? [];
			return {
				ok: members.includes("mint") && members.includes("forget"),
				detail: `${members.length} members, includes mint and forget: ${members.includes("mint") && members.includes("forget")}`,
			};
		},
	},
	{
		name: "resolves a relative import to the real file",
		run: async (service) => {
			const resolution = await service.resolveImport("src/gateway/boardStore.ts", "./boardAuthority.js");
			return {
				ok: resolution.status === "resolved" && resolution.module === "src/gateway/boardAuthority.ts",
				detail: JSON.stringify(resolution),
			};
		},
	},
	{
		name: "resolves through a barrel to the barrel file",
		run: async (service) => {
			const resolution = await service.resolveImport("src/gateway/boardStore.ts", "../shared/schemas.js");
			return {
				ok: resolution.status === "resolved" && resolution.module === "src/shared/schemas.ts",
				detail: JSON.stringify(resolution),
			};
		},
	},
	{
		name: "calls an installed dependency external, not unresolved",
		run: async (service) => {
			const resolution = await service.resolveImport("src/shared/schemas.ts", "zod");
			return { ok: resolution.status === "external", detail: JSON.stringify(resolution) };
		},
	},
	{
		name: "separates exported from file-local in a real file",
		run: async (service) => {
			const exported = service.findByName("refusalError")[0]?.exported;
			return { ok: exported === true, detail: `refusalError exported: ${exported}` };
		},
	},
	{
		// The whole reverse-lookup story. A name match would find these too, so the check is the TIER:
		// `bound` means real edges, and anything less means we are guessing from spelling.
		name: "reverse lookup finds callers, on bound edges rather than name matches",
		run: async (service) => {
			const target = service.findByName("refusalError")[0];
			if (target === undefined) return { ok: false, detail: "refusalError was not indexed" };
			const found = service.findReferences(target.symbolId);
			return {
				ok: found.total > 0 && found.tier === "bound",
				detail: `${found.total} references, tier ${found.tier}`,
			};
		},
	},
	{
		name: "answers a declared type",
		run: async (service) => {
			const target = service.findByName("refusalError")[0];
			if (target === undefined) return { ok: false, detail: "refusalError was not indexed" };
			const described = service.describe(target.symbolId);
			const signature = described?.symbol.signature;
			return { ok: signature !== undefined, detail: `signature: ${signature ?? "none"}` };
		},
	},
];

////////////////////////////////
//  Main

async function main(argv: string[]): Promise<void> {
	const refused = refuseRuntime("the lexicon grader");
	if (refused !== null) {
		console.error(refused);
		process.exit(1);
	}

	const [target] = argv;
	if (target === undefined || !existsSync(target)) {
		console.error("usage: grade <path to a switchboard checkout>");
		console.error("the checks name switchboard's own symbols, so they only grade that repository");
		process.exit(2);
	}
	const TARGET = path.resolve(target);

	// An entry point that builds no daemon reads the system clock by name.
	const clock = systemClock;
	const { store } = IndexStore.open(":memory:", undefined, undefined, clock);
	const supervisor = new ProviderSupervisor(clock);
	await startProviders(supervisor, TARGET);

	const service = new LexiconService(store, supervisor, sourceReader(TARGET), TARGET, clock);

	const outcomes = await service.indexWorkspace();
	const indexed = outcomes.filter((o) => o.action === "indexed").length;
	console.log(`indexed ${indexed} files from ${TARGET}\n`);

	let failed = 0;
	for (const check of CHECKS) {
		const result = await check.run(service);
		if ("skip" in result) {
			console.log(`SKIP  ${check.name}\n        ${result.skip}`);
			continue;
		}
		if (!result.ok) failed++;
		console.log(`${result.ok ? "PASS" : "FAIL"}  ${check.name}\n        ${result.detail}`);
	}

	supervisor.stopAll();
	store.close();
	process.exit(failed === 0 ? 0 : 1);
}

if (import.meta.main) await main(process.argv.slice(2));
