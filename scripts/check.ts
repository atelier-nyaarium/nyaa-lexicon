// The whole gate: corpora, lint, then tests against a fresh build of this tree's dist/, restored
// afterwards. Every part runs and reports; an interrupt skips the rest.
//
//   bun run check

import { spawnSync } from "node:child_process";
import path from "node:path";
import { withBuiltDist } from "./dist";

////////////////////////////////
//  Interfaces & Types

export interface PartResult {
	part: string;
	ok: boolean;
}

////////////////////////////////
//  Constants

const ROOT = path.join(import.meta.dirname, "..");
const PARTS = ["corpora", "lint", "test"];

////////////////////////////////
//  Functions & Helpers

/** Live tests run the bundles, so `test` runs inside a fresh build. */
export function check(
	root: string,
	output: "inherit" | "ignore" = "inherit",
	interrupted: () => boolean = () => false,
): PartResult[] {
	const passes = (part: string) => spawnSync("bun", ["run", part], { cwd: root, stdio: output }).status === 0;
	return PARTS.map((part) => {
		if (interrupted()) return { part, ok: false };
		if (output === "inherit") console.log(`\n[${part}]`);
		if (part !== "test") return { part, ok: passes(part) };
		try {
			return { part, ok: withBuiltDist([root], () => passes(part)) };
		} catch (error) {
			console.error(error instanceof Error ? error.message : error);
			return { part, ok: false };
		}
	});
}

////////////////////////////////
//  Main

/** Children take an interrupt; this process stays to restore dist/. */
export function checkHere(root: string): PartResult[] {
	let interrupted = false;
	process.on("SIGINT", () => {
		interrupted = true;
	});
	return check(root, "inherit", () => interrupted);
}

if (import.meta.main) {
	const results = checkHere(ROOT);
	console.log("");
	for (const { part, ok } of results) console.log(`${part}: ${ok ? "ok" : "FAILED"}`);
	process.exit(results.every((result) => result.ok) ? 0 : 1);
}
