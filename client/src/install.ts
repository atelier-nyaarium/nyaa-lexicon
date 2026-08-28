// Where lexicon is, and what it is: the record that points at an install, and the file an install
// writes about itself.
//
// The record only points. Its root is trusted no further than the version file found under it,
// so a checkout that moved is reported rather than spawned from.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
	type InstallRecord,
	InstallRecordSchema,
	type InstallVersion,
	InstallVersionSchema,
} from "@nyaa-lexicon/protocol";
import { canonicalRoot, currentHost, type PlatformEnv, stateRoot } from "./paths.js";

////////////////////////////////
//  Constants

const RECORD_FILE = "install.json";

/** Written by the build beside the bundles. */
const VERSION_FILE = path.join("dist", "version.json");

////////////////////////////////
//  Functions & Helpers

/** One per state root, so each environment remembers its own install. */
export function installRecordFile(host: PlatformEnv): string {
	return path.join(stateRoot(host), RECORD_FILE);
}

/** Staged then renamed, since a half-written record reads as no install at all. */
export function writeInstallRecord(root: string, host: PlatformEnv = currentHost()): void {
	const file = installRecordFile(host);
	mkdirSync(path.dirname(file), { recursive: true });
	const staging = `${file}.${process.pid}.tmp`;
	const record: InstallRecord = { root: canonicalRoot(root), when: Date.now() };
	writeFileSync(staging, JSON.stringify(record, null, 2));
	renameSync(staging, file);
}

function readJson(file: string): unknown {
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return undefined;
	}
}

/** Absent and malformed both mean nothing is known. */
export function readInstallRecord(host: PlatformEnv = currentHost()): InstallRecord | null {
	const parsed = InstallRecordSchema.safeParse(readJson(installRecordFile(host)));
	return parsed.success ? parsed.data : null;
}

/** What the install under `root` says it is, or null when nothing built is there. */
export function readInstallVersion(root: string): InstallVersion | null {
	const parsed = InstallVersionSchema.safeParse(readJson(path.join(root, VERSION_FILE)));
	return parsed.success ? parsed.data : null;
}
