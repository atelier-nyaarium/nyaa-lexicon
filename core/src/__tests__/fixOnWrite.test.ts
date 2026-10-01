import { afterEach, beforeEach, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readScopeConfig } from "../fileScope";
import { runFix } from "../fixOnWrite";

let root: string;

/** Appends a line to each file it is given, or fails when the first one is `./bad.ts`. */
const FIXER = `
const files = process.argv.slice(2);
if (files[0] === "./bad.ts") { console.error("cannot fix bad.ts"); process.exit(3); }
for (const file of files) await Bun.write(file, (await Bun.file(file).text()) + "// fixed\\n");
`;

beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), "lexicon-fix-"));
	writeFileSync(path.join(root, "fixer.ts"), FIXER);
	writeFileSync(path.join(root, "a.ts"), "a\n");
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

it("runs the configured command on the written files and says how a failed run went", async () => {
	writeFileSync(path.join(root, "lexicon.json"), JSON.stringify({ fix: [process.execPath, "fixer.ts"] }));
	const argv = readScopeConfig(root).fix ?? [];
	const clean = await runFix(root, argv, ["a.ts"]);
	const failed = await runFix(root, argv, ["bad.ts"]);
	const missing = await runFix(root, ["no-such-fixer-anywhere"], ["a.ts"]);
	writeFileSync(path.join(root, "lexicon.json"), JSON.stringify({ fix: ["biome", 1] }));

	expect({
		clean,
		text: readFileSync(path.join(root, "a.ts"), "utf8"),
		failed,
		missing: missing?.startsWith("could not start"),
		malformed: readScopeConfig(root).fix,
	}).toEqual({
		clean: null,
		text: "a\n// fixed\n",
		failed: "exited with 3: cannot fix bad.ts",
		missing: true,
		malformed: undefined,
	});
});
