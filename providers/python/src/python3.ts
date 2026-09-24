import path from "node:path";
import { fileURLToPath } from "node:url";
import { runBounded, systemTimer } from "@nyaa-lexicon/protocol";

export interface Python3Options {
	input?: string;
	maxBuffer?: number;
}

/** A python3 run that never answers is killed rather than waited on forever. */
const PYTHON3_TIMEOUT_MS = 30_000;

/** Matches the previous spawnSync default; stdout past this is killed and read as a failure. */
const PYTHON3_MAX_BUFFER_BYTES = 200 * 1024 * 1024;

/**
 * This provider's own folder. `python3 -c` imports from its cwd first, so a child started in the
 * indexed repo would load that repo's `json.py` in place of the standard library's.
 */
const PYTHON3_CWD = path.dirname(fileURLToPath(import.meta.url));

export class Python3Dispatch {
	private readonly cache = new Map<string, unknown | null>();
	private absentDetail: string;

	constructor(private readonly executable = "python3") {
		this.absentDetail = `Executable not found in $PATH: ${executable}`;
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

	private async run<T>(args: string[], options: Python3Options): Promise<T | null> {
		const result = await runBounded(this.executable, args, {
			cwd: PYTHON3_CWD,
			input: options.input,
			maxBytes: options.maxBuffer ?? PYTHON3_MAX_BUFFER_BYTES,
			timeoutMs: PYTHON3_TIMEOUT_MS,
			timer: systemTimer,
		});

		switch (result.kind) {
			case "spawnFailed":
				// ENOENT reads as "not found", the same as the synchronous form always answered.
				if (result.error.code === "ENOENT") return null;
				throw result.error;
			case "timedOut":
				throw new Error(`${this.executable} timed out after ${PYTHON3_TIMEOUT_MS}ms`);
			case "overflowed":
				throw new Error(`${this.executable} produced more output than the buffer allows`);
			case "exited":
				if (result.code !== 0) {
					const detail = result.stderr.toString("utf8").trim();
					throw new Error(detail === "" ? `${this.executable} exited with ${result.code}` : detail);
				}
				return JSON.parse(result.stdout.toString("utf8")) as T;
		}
	}
}
