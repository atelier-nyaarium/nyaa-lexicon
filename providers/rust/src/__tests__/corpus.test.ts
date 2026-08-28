import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { coordinatesOf } from "@nyaa-lexicon/protocol";
import { RustProvider } from "../main.js";

function rustFiles(directory: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (entry.name === ".git" || entry.name === "target" || entry.name === "node_modules") continue;
		const full = path.join(directory, entry.name);
		if (entry.isDirectory()) files.push(...rustFiles(full));
		else if (entry.isFile() && entry.name.endsWith(".rs")) files.push(full);
	}
	return files.sort();
}

test.skipIf(
	!existsSync(path.join(process.cwd(), "temp/ripgrep")) ||
		rustFiles(path.join(process.cwd(), "temp/ripgrep")).length === 0,
)(
	"parses every Rust file from the guarded ripgrep corpus",
	() => {
		const root = path.join(process.cwd(), "temp/ripgrep");
		const files = rustFiles(root);
		const provider = new RustProvider();
		provider.initialize(root);
		// A span whose range does not cut its own text back out attaches to the wrong symbol, and only
		// real source has the string forms that break that.
		const strayed: string[] = [];
		let spans = 0;
		const parsed = files.map((file) => {
			const module = path.relative(root, file).split(path.sep).join("/");
			const text = readFileSync(file, "utf8");
			const facts = provider.parseFile({ module, contentHash: "corpus", text });
			const coordinates = coordinatesOf(text);
			for (const comment of facts.comments ?? []) {
				spans++;
				if (coordinates.sliceRange(comment.range) !== comment.text) {
					strayed.push(`${module}: ${JSON.stringify(comment.text)}`);
				}
			}
			return facts;
		});
		const errorFiles = parsed
			.filter((facts) => facts.diagnostics.some((diagnostic) => diagnostic.severity === "error"))
			.map((facts) => facts.module);

		expect(parsed).toHaveLength(files.length);
		expect(parsed.every((facts) => facts.module.endsWith(".rs"))).toBe(true);
		expect(parsed.some((facts) => facts.declarations.length > 0)).toBe(true);
		expect(parsed.every((facts) => Array.isArray(facts.references) && Array.isArray(facts.literals))).toBe(true);
		expect(errorFiles).toEqual([]);
		expect(strayed).toEqual([]);
		expect(spans).toBeGreaterThan(0);
	},
	120_000,
);
