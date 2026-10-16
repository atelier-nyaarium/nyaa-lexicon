// Policy-controlled file reads.

import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import { hashContent } from "./hash.js";
import { assessSecretText, type ReadableSecretRule } from "./secretDecision.js";
import { type SecretAccess, SecretJudge, type SecretPolicyWire } from "./secretJudge.js";
import type { SecretFormat } from "./secretSyntax.js";
import { firstLineOf } from "./shebang.js";
import { readWorkspaceFile, type SourceFileRead } from "./sourceFile.js";
import { workspaceModule } from "./workspacePath.js";

////////////////////////////////
//  Interfaces & Types

export type SecretReaders = Readonly<Record<string, SecretFormat>>;

/** Provider workspace read policy. */
export interface ReadPolicy {
	readonly revision: string;
	access(module: string): SecretAccess;
	/** Whether a workspace module may be read. */
	admits(module: string): boolean;
	/** Readable without exposing guarded text. */
	exists(fileName: string): boolean;
	/** Text only when applicable readers find no selection. */
	readText(fileName: string): string | undefined;
	/** Head only after whole-file admission. */
	readHead(fileName: string): string | undefined;
	/** Contents only when applicable readers find no selection. */
	readModule(fileName: string): SourceFileRead | undefined;
}

interface ReadTarget {
	absolute: string;
	module: string | null;
	realModule: string | null;
	realPath: string | null;
	root: string;
	readModule: string;
}

////////////////////////////////
//  Class

/** Policy state follows wire revisions. */
export class ReadPolicyState implements ReadPolicy {
	private root = "";
	private realRoot: string | null = null;
	private judge: SecretJudge | null = null;
	private readers: SecretReaders;
	private readonly ledger = new Map<string, { module: string; real: string }>();
	private readonly verdicts = new Map<string, boolean>();

	constructor(readers: SecretReaders = {}) {
		this.readers = readers;
	}

	get revision(): string {
		return this.judge?.revision ?? "";
	}

	setReaders(readers: SecretReaders): void {
		this.readers = readers;
		this.verdicts.clear();
	}

	reset(root: string, wire?: SecretPolicyWire): void {
		this.root = path.resolve(root);
		this.realRoot = null;
		this.judge = wire === undefined ? null : SecretJudge.from(wire);
		this.ledger.clear();
		this.verdicts.clear();
	}

	install(wire: SecretPolicyWire): string[] {
		const next = SecretJudge.from(wire);
		const previous = this.judge;
		const changed = new Set<string>();
		for (const { module, real } of this.ledger.values()) {
			if (this.signature(previous, module, real) !== this.signature(next, module, real)) changed.add(module);
		}
		this.judge = next;
		this.verdicts.clear();
		return [...changed].sort();
	}

	access(module: string): SecretAccess {
		this.record(module, module);
		return this.judge?.access(module) ?? "open";
	}

	admits(module: string): boolean {
		return this.access(module) !== "closed";
	}

	exists(fileName: string): boolean {
		const target = this.target(fileName);
		if (target === undefined) return false;
		if (target.module === null) return this.regular(target.realPath);
		const answer = this.answer(target);
		if (answer === null || answer.kind === "omit" || answer.kind === "wholeRedact") return false;
		if (answer.kind === "matchers") return this.readText(fileName) !== undefined;
		return this.regular(target.realPath);
	}

	readText(fileName: string): string | undefined {
		const read = this.readModule(fileName);
		return read?.kind === "text" ? read.text : undefined;
	}

	readHead(fileName: string): string | undefined {
		const text = this.readText(fileName);
		return text === undefined ? undefined : firstLineOf(text);
	}

	readModule(fileName: string): SourceFileRead | undefined {
		const target = this.target(fileName);
		if (target === undefined) return undefined;
		if (target.module === null) {
			const read = readWorkspaceFile(target.root, target.readModule);
			return read.kind === "outside" ? undefined : read;
		}
		const answer = this.answer(target);
		if (answer === null || answer.kind === "omit" || answer.kind === "wholeRedact") return undefined;
		const read = readWorkspaceFile(target.root, target.readModule);
		if (read.kind === "outside") return undefined;
		if (answer.kind === "plain") return read;
		if (read.kind !== "text") return undefined;
		return this.textIsPlain(target, answer.rule, answer.stamp, read.text) ? read : undefined;
	}

	////////////////////////////////
	//  Reads

	private target(fileName: string): ReadTarget | undefined {
		if (this.root === "") return undefined;
		const absolute = path.resolve(this.root, fileName);
		let realRoot: string;
		try {
			this.realRoot ??= realpathSync(this.root);
			realRoot = this.realRoot;
		} catch {
			return undefined;
		}
		const module = workspaceModule(this.root, absolute);
		let realPath: string | null = null;
		try {
			realPath = realpathSync(absolute);
		} catch {
			if (module === null) return undefined;
		}
		if (module !== null) {
			const realModule = realPath === null ? module : workspaceModule(realRoot, realPath);
			if (realPath !== null && realModule === null) return undefined;
			this.record(module, realModule ?? module);
			return { absolute, module, realModule, realPath, root: this.root, readModule: module };
		}
		if (realPath === null) return undefined;
		const realModule = workspaceModule(realRoot, realPath);
		if (realModule !== null) {
			this.record(realModule, realModule);
			return {
				absolute,
				module: realModule,
				realModule,
				realPath,
				root: this.root,
				readModule: realModule,
			};
		}
		return {
			absolute,
			module: null,
			realModule: null,
			realPath,
			root: path.dirname(realPath),
			readModule: path.basename(realPath),
		};
	}

	private answer(target: ReadTarget) {
		if (target.module === null || this.judge === null) return null;
		return this.judge.answerThrough(target.module, target.realModule ?? target.module);
	}

	private textIsPlain(target: ReadTarget, rule: ReadableSecretRule, stamp: string, text: string): boolean {
		if (target.module === null) return true;
		const formats = Object.values(this.readers).filter(
			(format) => format.matches(target.module as string) || format.matches(target.realModule ?? ""),
		);
		if (formats.length === 0) return false;
		const hash = hashContent(text);
		return formats.every((format) => {
			const key = JSON.stringify([format.id, stamp, hash]);
			const cached = this.verdicts.get(key);
			if (cached !== undefined) return cached;
			let plain = false;
			try {
				plain = assessSecretText(format, rule, text).kind === "plain";
			} catch {
				plain = false;
			}
			this.verdicts.set(key, plain);
			return plain;
		});
	}

	private record(module: string, real: string): void {
		this.ledger.set(JSON.stringify([module, real]), { module, real });
	}

	private signature(judge: SecretJudge | null, module: string, real: string): string {
		if (judge === null) return "";
		const answer = judge.answerThrough(module, real);
		return `${answer.kind}:${answer.stamp}`;
	}

	private regular(file: string | null): boolean {
		if (file === null) return false;
		try {
			return statSync(file).isFile();
		} catch {
			return false;
		}
	}
}

////////////////////////////////
//  Functions & Helpers

export function createReadPolicyState(readers: SecretReaders = {}): ReadPolicyState {
	return new ReadPolicyState(readers);
}

export function readPolicy(root: string, wire: SecretPolicyWire, readers: SecretReaders = {}): ReadPolicyState {
	const policy = createReadPolicyState(readers);
	policy.reset(root, wire);
	return policy;
}

/** Reads stay blocked until installation. */
export const OPEN_READ_POLICY: ReadPolicy = {
	revision: "",
	access: () => "open",
	admits: () => true,
	exists: () => false,
	readText: () => undefined,
	readHead: () => undefined,
	readModule: () => undefined,
};
