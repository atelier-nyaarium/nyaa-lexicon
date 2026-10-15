import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { canonicalRoot } from "@nyaa-lexicon/client";
import { ProjectIndexStateSchema } from "@nyaa-lexicon/protocol";
import { atomicWriteJson } from "./atomicJson.js";

export class ProjectIndexMarker {
	constructor(
		private readonly file: string,
		private readonly root?: string,
	) {}

	belongsToRoot(): boolean | undefined {
		if (this.root === undefined) return undefined;
		let raw: string;
		try {
			raw = readFileSync(this.file, "utf8");
		} catch {
			return undefined;
		}
		try {
			const parsed = ProjectIndexStateSchema.safeParse(JSON.parse(raw));
			return parsed.success && parsed.data.root === canonicalRoot(this.root) ? true : undefined;
		} catch {
			return undefined;
		}
	}

	exists(): boolean {
		return existsSync(this.file);
	}

	publish(indexedAt: number): void {
		if (this.root === undefined) return;
		mkdirSync(path.dirname(this.file), { recursive: true });
		atomicWriteJson(this.file, { version: 1, root: canonicalRoot(this.root), indexedAt });
	}

	clear(): void {
		rmSync(this.file, { force: true });
	}
}
