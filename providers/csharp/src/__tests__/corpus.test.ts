import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CsharpProvider } from "../main.js";

const corpusRoot = path.join(process.cwd(), "temp/newtonsoft-json");
const corpusTest = existsSync(corpusRoot) ? it : it.skip;

describe("Newtonsoft.Json corpus", () => {
	corpusTest(
		"parses every C# file without error diagnostics",
		() => {
			const provider = new CsharpProvider();
			provider.initialize(corpusRoot);
			const model = provider.discoverProject(corpusRoot);
			expect(model.diagnostics).toEqual([]);
			expect(model.files.length).toBeGreaterThan(0);
			const started = performance.now();
			const failures: Array<{ module: string; messages: string[] }> = [];
			for (const module of model.files) {
				const facts = provider.parseFile({
					module,
					contentHash: "corpus",
					text: readFileSync(path.join(corpusRoot, module), "utf8"),
				});
				const messages = facts.diagnostics
					.filter((item) => item.severity === "error")
					.map((item) => item.message);
				if (messages.length > 0) failures.push({ module, messages });
			}
			console.info(`C# corpus: ${model.files.length} files in ${Math.round(performance.now() - started)} ms`);
			expect(failures).toEqual([]);
		},
		120_000,
	);
});
