import path from "node:path";
import { fileURLToPath } from "node:url";
import { runBounded, systemTimer } from "@nyaa-lexicon/protocol";

export interface Python3Options {
	input?: string;
	maxBuffer?: number;
}

/** A launcher and the arguments before the script's own. */
export interface Python3Command {
	command: string;
	prefix: string[];
}

/** A python3 run that never answers is killed rather than waited on forever. */
const PYTHON3_TIMEOUT_MS = 30_000;

/** Windows' App Installer alias exits with this when no Python is installed. */
const STORE_ALIAS_EXIT = 9009;

/** Matches the previous spawnSync default; stdout past this is killed and read as a failure. */
const PYTHON3_MAX_BUFFER_BYTES = 200 * 1024 * 1024;

/**
 * This provider's own folder. `python3 -c` imports from its cwd first, so a child started in the
 * indexed repo would load that repo's `json.py` in place of the standard library's.
 */
const PYTHON3_CWD = path.dirname(fileURLToPath(import.meta.url));

/** On Windows, `python3` is often the Store alias; the `py` launcher picks Python 3. */
export function python3Commands(platform: NodeJS.Platform = process.platform): Python3Command[] {
	return platform === "win32"
		? [
				{ command: "py", prefix: ["-3"] },
				{ command: "python", prefix: [] },
			]
		: [{ command: "python3", prefix: [] }];
}

export class Python3Dispatch {
	private readonly cache = new Map<string, unknown | null>();
	private readonly candidates: Python3Command[];
	private readonly absentDetail: string;
	/** Index of the first candidate that ran. */
	private found = 0;

	constructor(executable: string | Python3Command[] = python3Commands()) {
		this.candidates = typeof executable === "string" ? [{ command: executable, prefix: [] }] : executable;
		const names = this.candidates.map(({ command }) => command).join(", ");
		this.absentDetail = `Executable not found in $PATH: ${names}`;
	}

	get unavailableDetail(): string {
		return this.absentDetail;
	}

	async runJson<T>(args: string[], options: Python3Options = {}, cacheKey?: string): Promise<T | null> {
		if (cacheKey !== undefined && this.cache.has(cacheKey)) {
			return this.cache.get(cacheKey) as T | null;
		}

		const value = await this.run<T>(args, options);
		if (cacheKey !== undefined) this.cache.set(cacheKey, value);
		return value;
	}

	/** Falls through absent candidates; the first that runs is kept. */
	private async run<T>(args: string[], options: Python3Options): Promise<T | null> {
		for (let at = this.found; at < this.candidates.length; at++) {
			const { command, prefix } = this.candidates[at] as Python3Command;
			const result = await runBounded(command, [...prefix, ...args], {
				cwd: PYTHON3_CWD,
				input: options.input,
				maxBytes: options.maxBuffer ?? PYTHON3_MAX_BUFFER_BYTES,
				timeoutMs: PYTHON3_TIMEOUT_MS,
				timer: systemTimer,
			});

			switch (result.kind) {
				case "spawnFailed":
					// ENOENT reads as "not found", the same as the synchronous form always answered.
					if (result.error.code === "ENOENT") continue;
					throw result.error;
				case "timedOut":
					throw new Error(`${command} timed out after ${PYTHON3_TIMEOUT_MS}ms`);
				case "overflowed":
					throw new Error(`${command} produced more output than the buffer allows`);
				case "exited":
					if (result.code === STORE_ALIAS_EXIT) continue;
					this.found = at;
					if (result.code !== 0) {
						const detail = result.stderr.toString("utf8").trim();
						throw new Error(detail === "" ? `${command} exited with ${result.code}` : detail);
					}
					return JSON.parse(result.stdout.toString("utf8")) as T;
			}
		}
		return null;
	}
}
