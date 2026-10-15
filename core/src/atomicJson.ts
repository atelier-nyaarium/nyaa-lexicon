import { randomUUID } from "node:crypto";
import { renameSync, rmSync, writeFileSync } from "node:fs";

const TEMP_SUFFIX = /\.\d+\.[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\.tmp$/i;

export interface AtomicWriteOptions {
	temporaryPath?: string;
}

export interface AtomicJsonWriteOptions extends AtomicWriteOptions {
	space?: number;
}

export function atomicWrite(file: string, content: string, options: AtomicWriteOptions = {}): void {
	const temporary = options.temporaryPath ?? `${file}.${process.pid}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporary, content);
		renameSync(temporary, file);
	} catch (error) {
		try {
			rmSync(temporary, { force: true });
		} catch {
			// Preserve the write or rename error.
		}
		throw error;
	}
}

export function atomicWriteJson(file: string, value: object, options: AtomicJsonWriteOptions = {}): void {
	atomicWrite(file, JSON.stringify(value, null, options.space), options);
}

export function atomicWriteTempTarget(name: string): string | undefined {
	const suffix = TEMP_SUFFIX.exec(name);
	return suffix === null ? undefined : name.slice(0, suffix.index);
}
