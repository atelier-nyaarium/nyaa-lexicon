// The workspace's fix commands: `fix` on the files a refactor step wrote, `fixText` on text before it is written.

import { type BoundedResult, runBounded, systemTimer } from "@nyaa-lexicon/protocol";

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

function bounds(workspaceRoot: string) {
	return { cwd: workspaceRoot, maxBytes: FIX_MAX_BYTES, timeoutMs: FIX_TIMEOUT_MS, timer: systemTimer };
}

/** What went wrong, for a run that did not exit cleanly. */
function failureOf(result: BoundedResult): string {
	switch (result.kind) {
		case "exited": {
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

/** Null when the command exited cleanly; otherwise what went wrong, for a step issue. */
export async function runFix(
	workspaceRoot: string,
	argv: readonly string[],
	modules: readonly string[],
): Promise<string | null> {
	const [command, ...args] = argv;
	if (command === undefined || modules.length === 0) return null;
	// `./` keeps a module named like a flag from reading as one.
	const result = await runBounded(
		command,
		[...args, ...modules.map((module) => `./${module}`)],
		bounds(workspaceRoot),
	);
	return result.kind === "exited" && result.code === 0 ? null : failureOf(result);
}

/** The text as the formatter prints it, or what went wrong. */
export async function runFixText(
	workspaceRoot: string,
	argv: readonly string[],
	module: string,
	text: string,
): Promise<{ text: string } | { failed: string }> {
	const [command, ...args] = argv.map((part) => part.replaceAll("{module}", `./${module}`));
	if (command === undefined) return { failed: "is empty" };
	const result = await runBounded(command, args, { ...bounds(workspaceRoot), input: text });
	if (result.kind !== "exited" || result.code !== 0) return { failed: failureOf(result) };
	const formatted = result.stdout.toString("utf8");
	// Nothing printed for real text means it wrote elsewhere.
	return formatted === "" && text !== "" ? { failed: "printed nothing" } : { text: formatted };
}
