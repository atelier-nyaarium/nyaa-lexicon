import { type SpawnSyncOptionsWithStringEncoding, spawnSync } from "node:child_process";

type Python3Options = Pick<SpawnSyncOptionsWithStringEncoding, "input" | "maxBuffer">;

export class Python3Dispatch {
	private readonly cache = new Map<string, unknown | null>();
	private absentDetail: string;

	constructor(private readonly executable = "python3") {
		this.absentDetail = `Executable not found in $PATH: ${executable}`;
	}

	get unavailableDetail(): string {
		return this.absentDetail;
	}

	runJson<T>(args: string[], options: Python3Options = {}, cacheKey?: string): T | null {
		if (cacheKey !== undefined && this.cache.has(cacheKey)) {
			return this.cache.get(cacheKey) as T | null;
		}

		const result = spawnSync(this.executable, args, { ...options, encoding: "utf8" });
		let value: T | null;
		if (result.error) {
			const error = result.error as NodeJS.ErrnoException;
			if (error.code !== "ENOENT") throw error;
			value = null;
		} else if (result.status !== 0) {
			const detail = result.stderr.trim();
			throw new Error(detail === "" ? `${this.executable} exited with ${result.status}` : detail);
		} else {
			value = JSON.parse(result.stdout) as T;
		}

		if (cacheKey !== undefined) this.cache.set(cacheKey, value);
		return value;
	}
}
