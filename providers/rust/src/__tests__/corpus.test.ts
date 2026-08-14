import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
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

test("parses every Rust file from the guarded ripgrep corpus", ({ skip }) => {
	const root = path.join(process.cwd(), "temp/ripgrep");
	if (!existsSync(root)) {
		skip();
		return;
	}
	const files = rustFiles(root);
	if (files.length === 0) {
		skip();
		return;
	}
	const provider = new RustProvider();
	provider.initialize(root);
	const parsed = files.map((file) => {
		const module = path.relative(root, file).split(path.sep).join("/");
		return provider.parseFile({ module, contentHash: "corpus", text: readFileSync(file, "utf8") });
	});
	const errorFiles = parsed
		.filter((facts) => facts.diagnostics.some((diagnostic) => diagnostic.severity === "error"))
		.map((facts) => facts.module);

	expect(parsed).toHaveLength(files.length);
	expect(parsed.every((facts) => facts.module.endsWith(".rs"))).toBe(true);
	expect(parsed.some((facts) => facts.declarations.length > 0)).toBe(true);
	expect(parsed.every((facts) => Array.isArray(facts.references) && Array.isArray(facts.literals))).toBe(true);
	expect(errorFiles).toEqual([]);
}, 120_000);
