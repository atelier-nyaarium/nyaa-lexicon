import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { describeStart, discoverProviders, lexiconRoot, startProviders } from "../providers";
import type { ProviderSpec, ProviderSupervisor } from "../supervisor";

////////////////////////////////
//  Helpers

const roots: string[] = [];

/** A tree shaped like the repository, so discovery is exercised on layout rather than on names. */
function tree(sources: string[], bundled: string[] = []): string {
	const root = mkdtempSync(path.join(tmpdir(), "lexicon-providers-"));
	roots.push(root);
	writeFileSync(path.join(root, "package.json"), "{}\n");
	for (const name of sources) {
		const dir = path.join(root, "providers", name, "src");
		mkdirSync(dir, { recursive: true });
		writeFileSync(path.join(dir, "main.ts"), "\n");
	}
	for (const name of bundled) {
		mkdirSync(path.join(root, "providers", name), { recursive: true });
		const dir = path.join(root, "dist", "providers", name);
		mkdirSync(dir, { recursive: true });
		writeFileSync(path.join(dir, "main.js"), "\n");
	}
	mkdirSync(path.join(root, "providers", "no-entrypoint"), { recursive: true });
	return root;
}

/** Starts fine, or throws, depending on what the test is about. Never spawns a process. */
function supervisor(failing: string[] = [], started: ProviderSpec[] = []): ProviderSupervisor {
	return {
		start: async (spec: ProviderSpec) => {
			started.push(spec);
			const name = spec.command[spec.command.length - 1] ?? "";
			if (failing.some((f) => name.includes(`/${f}/`))) throw new Error("boom");
			return {
				providerId: `${name}-id`,
				language: path.basename(path.dirname(path.dirname(name))),
				extensions: [".x"],
			};
		},
	} as unknown as ProviderSupervisor;
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

////////////////////////////////
//  Tests

describe("finding providers", () => {
	it("finds every provider on disk without being told any of their names", () => {
		const found = discoverProviders(tree(["alpha", "beta", "gamma"]));
		expect(found.map((p) => p.directory)).toEqual(["alpha", "beta", "gamma"]);
	});

	it("ignores a directory with no entrypoint, rather than starting something that is not there", () => {
		expect(discoverProviders(tree(["alpha"])).map((p) => p.directory)).toEqual(["alpha"]);
	});

	it("answers empty for a tree with no providers directory at all", () => {
		const root = mkdtempSync(path.join(tmpdir(), "lexicon-bare-"));
		roots.push(root);
		expect(discoverProviders(root)).toEqual([]);
	});

	it("prefers a bundle over the source and says which runtime each needs", () => {
		const found = discoverProviders(tree(["alpha"], ["beta"]));

		expect(found.map((p) => [p.directory, p.runtime])).toEqual([
			["alpha", "bun"],
			["beta", "node"],
		]);
		expect(found[1]?.command[0]).toBe(process.execPath);
	});

	// The walk-up is the part that differs between running from source and running from dist/, so
	// a wrong marker fails everywhere at once and is worth pinning.
	it("locates this repository from wherever the caller was bundled", () => {
		expect(discoverProviders(lexiconRoot()).length).toBeGreaterThan(0);
	});
});

describe("starting providers", () => {
	it("starts each one and reports what it claimed", async () => {
		const commands = discoverProviders(tree(["alpha", "beta"]));
		const report = await startProviders(supervisor(), "/w", { commands });

		expect(report.started.map((s) => s.directory)).toEqual(["alpha", "beta"]);
		expect(report.failed).toEqual([]);
	});

	// One broken tree used to be able to take down answering for every other language, which is the
	// opposite of what running providers as separate processes is for.
	it("keeps the others working when one refuses to start", async () => {
		const commands = discoverProviders(tree(["alpha", "beta", "gamma"]));
		const report = await startProviders(supervisor(["beta"]), "/w", { commands });

		expect(report.started.map((s) => s.directory)).toEqual(["alpha", "gamma"]);
		expect(report.failed).toEqual([{ directory: "beta", error: "boom" }]);
	});

	it("says which provider failed rather than reporting a silent short list", async () => {
		const commands = discoverProviders(tree(["alpha", "beta"]));
		const report = await startProviders(supervisor(["beta"]), "/w", { commands });
		expect(describeStart(report)).toContain("beta: did not start");
	});

	// Bun gets no flags.
	it("puts node argv after the executable of node providers, with the signals they then handle", async () => {
		const started: ProviderSpec[] = [];
		const commands = discoverProviders(tree(["alpha"], ["beta"]));
		await startProviders(supervisor([], started), "/w", {
			commands,
			node: { argv: ["--report-on-fatalerror"], handles: ["SIGUSR2"] },
		});

		const [alpha, beta] = started;
		expect(alpha?.command[0]).toBe("bun");
		expect(alpha?.command).not.toContain("--report-on-fatalerror");
		expect(alpha?.handles).toBeUndefined();
		expect(beta?.command.slice(0, 2)).toEqual([process.execPath, "--report-on-fatalerror"]);
		expect(beta?.command[2]).toMatch(/dist\/providers\/beta\/main\.js$/);
		expect(beta?.handles).toEqual(["SIGUSR2"]);
	});
});
