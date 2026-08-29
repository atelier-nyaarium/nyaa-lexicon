import { describe, expect, it } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { codeOnly, readSwept } from "../residue";

/** Holds providerKit.ts as the one walk, path conversion and handler table a provider entry point uses. */
const PROVIDERS = join(import.meta.dirname, "..", "..", "..", "providers");

/** Entry points, plus the one discovery module that lives beside its entry point. */
function swept(): string[] {
	const mains = readdirSync(PROVIDERS, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => join(PROVIDERS, entry.name, "src", "main.ts"));
	return [...mains, join(PROVIDERS, "rust", "src", "project.ts")];
}

/** A private walk, a private path conversion, or a private handler table. */
const PRIVATE = [/\breaddirSync\(/, /\bpath\.relative\(/, /\bfunction handlersFor\(/];

////////////////////////////////
//  Tests

describe("one kit scaffolds every provider", () => {
	it("finds every provider entry point, so a passing sweep is never vacuous", () => {
		expect(swept().length).toBeGreaterThanOrEqual(12);
	});

	it("has no entry point walking the workspace, converting a path, or wiring handlers itself", () => {
		const offenders: string[] = [];
		for (const file of swept()) {
			const source = readSwept(file);
			if (source === null) continue;
			const code = codeOnly(source);
			for (const pattern of PRIVATE) {
				if (pattern.test(code)) offenders.push(`${file.slice(PROVIDERS.length + 1)}: ${pattern.source}`);
			}
		}

		expect(
			offenders,
			"walks, path conversion and the handler table belong to protocol/src/providerKit.ts: discoverByWalk, walkWorkspace, workspaceModule, workspaceFile, handlersFor",
		).toEqual([]);
	});
});
