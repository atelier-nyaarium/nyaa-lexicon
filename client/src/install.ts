// Where lexicon is, and what it is: the record that points at an install, the file an install
// writes about itself, and which install beside another is the newest.
//
// The record only points. Its root is trusted no further than the version file found under it,
// so a checkout that moved is reported rather than spawned from.

import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
	type InstallRecord,
	InstallRecordSchema,
	type InstallVersion,
	InstallVersionSchema,
} from "@nyaa-lexicon/protocol";
import { bundleFiles } from "./discover.js";
import { isRelease, newerBuild } from "./lock.js";
import { canonicalRoot, currentHost, type PlatformEnv, stateRoot } from "./paths.js";

////////////////////////////////
//  Interfaces & Types

export interface InstallBeside {
	root: string;
	version: string;
}

////////////////////////////////
//  Constants

const RECORD_FILE = "install.json";

/** Written by the build beside the bundles. */
const VERSION_FILE = path.join("dist", "version.json");

/** A bundle younger than this may still be mid-write; spawning from it runs half a program. */
export const INSTALL_SETTLE_MS = 3_000;

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

/** Every bundle under `root` has sat unmodified since `settledBefore`, epoch milliseconds. */
export function bundlesSettled(root: string, settledBefore: number): boolean {
	const files = bundleFiles(root);
	if (files === null) return false;
	try {
		return Math.max(...files.map((file) => statSync(file).mtimeMs)) <= settledBefore;
	} catch {
		return false;
	}
}

/** The version a root's own manifest claims, or null when it does not say. */
function manifestVersion(root: string): string | null {
	const parsed = readJson(path.join(root, "package.json"));
	const version = (parsed as { version?: unknown } | undefined)?.version;
	return typeof version === "string" ? version : null;
}

/**
 * The directory name, the manifest and the version file all name `version`, and the daemon bundle
 * is there. A bundle compiled as another version writes that version into its lock, which clients
 * then replace, which respawns a daemon that hands over here again: a loop, cut by refusing it.
 */
function installAgrees(root: string, version: string): boolean {
	if (readInstallVersion(root)?.buildVersion !== version || manifestVersion(root) !== version) return false;
	try {
		return lstatSync(path.join(root, "dist", "daemon.js")).isFile();
	} catch {
		return false;
	}
}

/**
 * Versioned-install layout only, where each release sits in a directory named exactly its version:
 * the newest settled install beside `root`, `root` itself included whether or not it still exists.
 * Null when `root` is not named for a release, since a sibling of a source checkout is not an
 * install of it.
 */
export function newestInstallBeside(root: string, settledBefore: number): InstallBeside | null {
	if (!isRelease(path.basename(root))) return null;
	const parent = path.dirname(root);

	let entries: string[];
	try {
		entries = readdirSync(parent);
	} catch {
		return null;
	}

	let best: InstallBeside | null = null;
	for (const entry of entries) {
		if (!isRelease(entry) || (best !== null && !newerBuild(entry, best.version))) continue;
		const candidate = path.join(parent, entry);
		if (!installAgrees(candidate, entry) || !bundlesSettled(candidate, settledBefore)) continue;
		best = { root: candidate, version: entry };
	}
	return best;
}
