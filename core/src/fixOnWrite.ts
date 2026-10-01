// The workspace's fix command, run on the files a refactor step wrote.

import { runBounded, systemTimer } from "@nyaa-lexicon/protocol";

////////////////////////////////
//  Constants

/** A formatter's cold start over a handful of files. */
const FIX_TIMEOUT_MS = 60_000;

const FIX_MAX_BYTES = 1024 * 1024;

////////////////////////////////
//  Functions & Helpers

function lastLine(output: Buffer): string {
	return output.toString("utf8").trim().split("\n").at(-1) ?? "";
}

/** Null when the command exited cleanly; otherwise what went wrong, for a step issue. */
export async function runFix(
	workspaceRoot: string,
	argv: readonly string[],
	modules: readonly string[],
): Promise<string | null> {
	const [command, ...args] = argv;
	if (command === undefined || modules.length === 0) return null;
	// `./` keeps a module named like a flag from reading as one.
	const result = await runBounded(command, [...args, ...modules.map((module) => `./${module}`)], {
		cwd: workspaceRoot,
		maxBytes: FIX_MAX_BYTES,
		timeoutMs: FIX_TIMEOUT_MS,
		timer: systemTimer,
	});
	switch (result.kind) {
		case "exited": {
			if (result.code === 0) return null;
			const said = lastLine(result.stderr) || lastLine(result.stdout);
			return `exited with ${result.code ?? result.signal}${said === "" ? "" : `: ${said}`}`;
		}
		case "spawnFailed":
			return `could not start: ${result.error.message}`;
		case "timedOut":
			return `ran past ${FIX_TIMEOUT_MS / 1000} s`;
		case "overflowed":
			return `printed more than ${FIX_MAX_BYTES / 1024 / 1024} MiB`;
	}
}
