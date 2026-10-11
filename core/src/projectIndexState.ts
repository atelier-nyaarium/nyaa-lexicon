import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { canonicalRoot } from "@nyaa-lexicon/client";
import { ProjectIndexStateSchema } from "@nyaa-lexicon/protocol";

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
		const temporary = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
		mkdirSync(path.dirname(this.file), { recursive: true });
		try {
			writeFileSync(temporary, JSON.stringify({ version: 1, root: canonicalRoot(this.root), indexedAt }));
			renameSync(temporary, this.file);
		} finally {
			rmSync(temporary, { force: true });
		}
	}

	clear(): void {
		rmSync(this.file, { force: true });
	}
}
