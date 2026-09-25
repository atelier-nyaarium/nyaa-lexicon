// Git and child runs for the scripts in this folder.

import { execFileSync } from "node:child_process";

////////////////////////////////
//  Functions & Helpers

/** Trim output; contextualize failures. */
export function git(cwd: string, args: string[], env: Record<string, string> = {}): string {
	try {
		return execFileSync("git", args, {
			cwd,
			encoding: "utf8",
			env: { ...process.env, ...env },
			stdio: ["ignore", "pipe", "pipe"],
		}).trim();
	} catch (error) {
		const stderr = (error as { stderr?: string }).stderr?.trim();
		throw new Error(
			`git ${args.join(" ")} in ${cwd}: ${stderr || (error instanceof Error ? error.message : error)}`,
		);
	}
}

/** Return null on failure. */
export function gitOrNull(cwd: string, args: string[]): string | null {
	try {
		return git(cwd, args);
	} catch {
		return null;
	}
}

/** Throw on child failure. */
export function run(cwd: string, command: string, args: string[], output: "inherit" | "stderr" = "inherit"): void {
	execFileSync(command, args, { cwd, stdio: output === "inherit" ? "inherit" : ["ignore", 2, 2] });
}

/** Let interrupted children unwind. */
export function outliveInterrupts(): void {
	process.on("SIGINT", () => {});
}
