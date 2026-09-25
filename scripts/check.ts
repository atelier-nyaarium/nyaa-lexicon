// The whole gate: corpora in place, then lint and tests. Every part runs and reports.
//
//   bun run check

import { spawnSync } from "node:child_process";
import path from "node:path";

////////////////////////////////
//  Constants

const ROOT = path.join(import.meta.dirname, "..");
const PARTS = ["corpora", "lint", "test"];

////////////////////////////////
//  Main

const results = PARTS.map((part) => {
	console.log(`\n[${part}]`);
	return { part, ok: spawnSync("bun", ["run", part], { cwd: ROOT, stdio: "inherit" }).status === 0 };
});

console.log("");
for (const { part, ok } of results) console.log(`${part}: ${ok ? "ok" : "FAILED"}`);
process.exit(results.every((result) => result.ok) ? 0 : 1);
