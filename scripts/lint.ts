// The gate runs BOTH halves and reports both.
//
// Chaining them with `&&` meant a formatting nit stopped the type check from ever running, so the
// tree could hold type errors nobody could see for as long as biome stayed red.

import { spawnSync } from "node:child_process";

interface Half {
	name: string;
	command: string;
	args: string[];
}

const HALVES: Half[] = [
	{ name: "biome", command: "bunx", args: ["biome", "ci", "."] },
	{ name: "tsc", command: "bunx", args: ["tsc", "--build"] },
];

const failed: string[] = [];
for (const half of HALVES) {
	const result = spawnSync(half.command, half.args, { stdio: "inherit" });
	if (result.status !== 0) failed.push(half.name);
}

console.log(failed.length === 0 ? "\nlint: biome ok, tsc ok" : `\nlint FAILED: ${failed.join(", ")}`);
process.exit(failed.length === 0 ? 0 : 1);
