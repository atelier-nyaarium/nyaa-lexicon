import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { describeStart, discoverProviders, lexiconRoot, startProviders } from "../providers";
import type { ProviderSupervisor } from "../supervisor";

////////////////////////////////
//  Helpers

const roots: string[] = [];

/** A tree shaped like the repository, so discovery is exercised on layout rather than on names. */
function tree(entrypoints: string[]): string {
	const root = mkdtempSync(path.join(tmpdir(), "lexicon-providers-"));
	roots.push(root);
	writeFileSync(path.join(root, "package.json"), "{}\n");
	for (const name of entrypoints) {
		const dir = path.join(root, "providers", name, "src");
		mkdirSync(dir, { recursive: true });
		writeFileSync(path.join(dir, "main.ts"), "\n");
	}
	mkdirSync(path.join(root, "providers", "no-entrypoint"), { recursive: true });
	return root;
}

/** Starts fine, or throws, depending on what the test is about. Never spawns a process. */
function supervisor(failing: string[] = []): ProviderSupervisor {
	return {
		start: async (spec: { command: string[] }) => {
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

	// The walk-up is the part that differs between running from source and running from dist/, so
	// a wrong marker fails everywhere at once and is worth pinning.
	it("locates this repository from wherever the caller was bundled", () => {
		expect(discoverProviders(lexiconRoot()).length).toBeGreaterThan(0);
	});
});

describe("starting providers", () => {
	it("starts each one and reports what it claimed", async () => {
		const report = await startProviders(supervisor(), "/w", discoverProviders(tree(["alpha", "beta"])));

		expect(report.started.map((s) => s.directory)).toEqual(["alpha", "beta"]);
		expect(report.failed).toEqual([]);
	});

	// One broken tree used to be able to take down answering for every other language, which is the
	// opposite of what running providers as separate processes is for.
	it("keeps the others working when one refuses to start", async () => {
		const report = await startProviders(
			supervisor(["beta"]),
			"/w",
			discoverProviders(tree(["alpha", "beta", "gamma"])),
		);

		expect(report.started.map((s) => s.directory)).toEqual(["alpha", "gamma"]);
		expect(report.failed).toEqual([{ directory: "beta", error: "boom" }]);
	});

	it("says which provider failed rather than reporting a silent short list", async () => {
		const report = await startProviders(supervisor(["beta"]), "/w", discoverProviders(tree(["alpha", "beta"])));
		expect(describeStart(report)).toContain("beta: did not start");
	});
});
