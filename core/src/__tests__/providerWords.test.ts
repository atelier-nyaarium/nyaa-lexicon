// Every provider's announced vocabulary. Not discoverProviders(): that prefers dist/ over source.

import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ProviderCommand } from "../providers";
import { lexiconRoot, startProviders } from "../providers";
import { ProviderSupervisor } from "../supervisor";

////////////////////////////////
//  Helpers

function sourceCommands(): ProviderCommand[] {
	const providersDir = path.join(lexiconRoot(), "providers");
	return readdirSync(providersDir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => ({
			directory: entry.name,
			command: [process.execPath, "run", path.join(providersDir, entry.name, "src", "main.ts")],
		}))
		.filter((entry) => existsSync(entry.command[2] as string))
		.sort((a, b) => a.directory.localeCompare(b.directory));
}

let supervisor: ProviderSupervisor;

afterEach(() => {
	supervisor?.stopAll();
});

////////////////////////////////
//  Tests

describe("every provider's announced vocabulary", () => {
	it("sorts each list, never repeats a word, never places one in two lists, and states keywords iff code", async () => {
		supervisor = new ProviderSupervisor();
		const commands = sourceCommands();
		expect(commands.length).toBeGreaterThan(0);
		const report = await startProviders(supervisor, tmpdir(), { commands });
		expect(report.failed, JSON.stringify(report.failed)).toEqual([]);

		for (const { claims } of report.started) {
			const words = supervisor.words(claims.providerId);
			expect(words, claims.providerId).toBeDefined();
			if (words === undefined) continue;

			for (const list of [words.keywords, words.builtins, words.literals]) {
				expect(list, claims.providerId).toEqual([...list].sort());
				expect(new Set(list).size, claims.providerId).toBe(list.length);
			}

			const builtins = new Set(words.builtins);
			const literals = new Set(words.literals);
			const overlap = [
				...words.keywords.filter((word) => builtins.has(word) || literals.has(word)),
				...words.builtins.filter((word) => literals.has(word)),
			];
			expect(overlap, claims.providerId).toEqual([]);

			// Absent means code, same reading checkWordsDeclared gives it in the conformance runner.
			const isDataFormat = claims.content !== undefined && claims.content !== "code";
			if (isDataFormat) {
				expect(words.keywords, claims.providerId).toEqual([]);
				expect(words.builtins, claims.providerId).toEqual([]);
			} else {
				expect(words.keywords.length, claims.providerId).toBeGreaterThan(0);
			}
		}
	}, 60_000);
});
