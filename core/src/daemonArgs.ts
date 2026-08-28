// The daemon's command line, parsed explicitly so an unknown flag is refused rather than ignored.
//
//   daemon <workspace> [--warm] [--state-dir <dir>]

////////////////////////////////
//  Interfaces & Types

export interface DaemonArgs {
	workspace: string;
	/** Scan at start, because the predecessor was warm. */
	warm: boolean;
	/** A store directory of the caller's choosing; absent means the default under the state root. */
	stateDir?: string;
}

export type ParsedDaemonArgs = { ok: true; args: DaemonArgs } | { ok: false; problem: string };

////////////////////////////////
//  Constants

export const DAEMON_USAGE = "usage: daemon <workspace> [--warm] [--state-dir <dir>]";

////////////////////////////////
//  Functions & Helpers

export function parseDaemonArgs(argv: string[]): ParsedDaemonArgs {
	let workspace: string | undefined;
	let warm = false;
	let stateDir: string | undefined;

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === undefined) break;
		if (arg === "--warm") {
			warm = true;
		} else if (arg === "--state-dir") {
			const value = argv[i + 1];
			if (value === undefined) return { ok: false, problem: "--state-dir needs a directory" };
			if (stateDir !== undefined) return { ok: false, problem: "--state-dir given twice" };
			stateDir = value;
			i++;
		} else if (arg.startsWith("--")) {
			return { ok: false, problem: `unknown flag ${arg}` };
		} else if (workspace === undefined) {
			workspace = arg;
		} else {
			return { ok: false, problem: `unexpected argument ${arg}; one workspace is served per daemon` };
		}
	}

	if (workspace === undefined) return { ok: false, problem: "no workspace given" };
	return { ok: true, args: { workspace, warm, ...(stateDir === undefined ? {} : { stateDir }) } };
}
