import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { coordinatesOf } from "@nyaa-lexicon/protocol";
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
			// A span whose range does not cut its own text back out attaches to the wrong symbol,
			// and only real source has the string forms that break that.
			const strayed: string[] = [];
			let spans = 0;
			for (const module of model.files) {
				const text = readFileSync(path.join(corpusRoot, module), "utf8");
				const facts = provider.parseFile({ module, contentHash: "corpus", text });
				const messages = facts.diagnostics
					.filter((item) => item.severity === "error")
					.map((item) => item.message);
				if (messages.length > 0) failures.push({ module, messages });

				const coordinates = coordinatesOf(text);
				for (const comment of facts.comments ?? []) {
					spans++;
					if (coordinates.sliceRange(comment.range) !== comment.text) {
						strayed.push(`${module}: ${JSON.stringify(comment.text)}`);
					}
				}
			}
			console.info(
				`C# corpus: ${model.files.length} files, ${spans} comments in ${Math.round(performance.now() - started)} ms`,
			);
			expect(failures).toEqual([]);
			expect(strayed).toEqual([]);
			expect(spans).toBeGreaterThan(0);
		},
		120_000,
	);
});
