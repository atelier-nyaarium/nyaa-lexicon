// Which projects this machine knows.
//
// Nothing is discovered any more; a workspace exists here because somebody registered it. Which of
// them a given session ASKS about is sessionBinds, and deliberately not persisted here.
//
// Single owner of the registry file; call sites take the whole state or nothing.

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
	canonicalRoot,
	currentHost,
	type PlatformEnv,
	stateRoot,
	workspaceKey,
	workspacePaths,
} from "@nyaa-lexicon/client";
import { Database } from "./database.js";
import { admitStateDir } from "./workspaceAdmission.js";

////////////////////////////////
//  Interfaces & Types

/** One store: a workspace in a directory. The default directory is spelled by its absence, so
 * one workspace may hold a default entry and any number of custom ones. */
export interface RegisteredProject {
	/** Stable directory name for index storage and daemon identity. */
	key: string;
	root: string;
	/** A store directory of the project's choosing, canonical and absolute. */
	stateDir?: string;
}

interface RegistryFile {
	projects: Array<{ key: string; root: string; stateDir?: string; name?: string }>;
}

export type RegisterOutcome =
	| { registered: true; project: RegisteredProject; already: boolean }
	| { registered: false; reason: string };

/** Admission as the registry needs it, so a test can inject a verdict without a filesystem. */
export type AdmitVerdict = { admitted: boolean; reason?: string };

////////////////////////////////
//  Functions & Helpers

function registryFile(host: PlatformEnv): string {
	return path.join(stateRoot(host), "projects.json");
}

/** A SQLite write transaction serializes registry read-modify-write across processes. */
function withRegistryLock<T>(host: PlatformEnv, work: () => T): T {
	const file = path.join(stateRoot(host), "projects.lock.sqlite");
	mkdirSync(path.dirname(file), { recursive: true });
	const db = Database.open(file, undefined, 4_000);
	let locked = false;
	try {
		db.exec("BEGIN IMMEDIATE");
		locked = true;
		const result = work();
		db.exec("COMMIT");
		locked = false;
		return result;
	} catch (error) {
		if (locked) {
			try {
				db.exec("ROLLBACK");
			} catch {
				// Closing the connection releases a transaction SQLite could not roll back.
			}
		}
		throw error;
	} finally {
		db.close();
	}
}

function entryOf(key: string, root: string, stateDir: string | undefined): RegisteredProject {
	return stateDir === undefined ? { key, root } : { key, root, stateDir };
}

/** Whether two entries name one store. */
export function sameStore(left: RegisteredProject, right: RegisteredProject): boolean {
	return left.key === right.key && left.stateDir === right.stateDir;
}

/** Absent, unreadable and malformed all mean the same thing: nothing registered yet. */
export function readRegistry(host: PlatformEnv = currentHost()): RegisteredProject[] {
	let raw: string;
	try {
		raw = readFileSync(registryFile(host), "utf8");
	} catch {
		return [];
	}
	try {
		const parsed = JSON.parse(raw) as RegistryFile;
		if (!Array.isArray(parsed.projects)) return [];
		return parsed.projects
			.filter((entry) => typeof entry?.key === "string" && typeof entry?.root === "string")
			.map(({ key, root, stateDir }) => entryOf(key, root, typeof stateDir === "string" ? stateDir : undefined));
	} catch {
		return [];
	}
}

/** Written through a temp file, since a half-written registry reads as nothing registered. */
function writeRegistry(host: PlatformEnv, projects: RegisteredProject[]): void {
	const file = registryFile(host);
	mkdirSync(path.dirname(file), { recursive: true });
	const staging = `${file}.${process.pid}.${randomUUID()}.tmp`;
	const stored = projects.map(({ key, root, stateDir }) => entryOf(key, root, stateDir));
	try {
		writeFileSync(staging, JSON.stringify({ projects: stored } satisfies RegistryFile, null, 2));
		renameSync(staging, file);
	} finally {
		rmSync(staging, { force: true });
	}
}

/**
 * Durable registry lookup. A key or a root names the DEFAULT store only; a custom store is
 * named by its directory. Session-facing names belong to sessionBinds.
 */
export function findProject(reference: string, projects: RegisteredProject[]): RegisteredProject | null {
	const defaults = projects.filter((project) => project.stateDir === undefined);
	const byKey = defaults.find((project) => project.key === reference);
	if (byKey !== undefined) return byKey;
	// Roots and directories are stored canonical, so a spelling through a link finds them too.
	const resolved = canonicalRoot(reference);
	return (
		defaults.find((project) => project.root === resolved) ??
		projects.find((project) => project.stateDir === resolved) ??
		null
	);
}

////////////////////////////////
//  Changing the registry

export function registerProject(
	root: string,
	admit: (root: string) => AdmitVerdict,
	host: PlatformEnv = currentHost(),
	stateDir?: string,
	admitDir: (dir: string) => AdmitVerdict = admitStateDir,
): RegisterOutcome {
	const resolved = canonicalRoot(root);
	const admission = admit(resolved);
	if (!admission.admitted) return { registered: false, reason: admission.reason ?? `${resolved} cannot be indexed` };

	let directory: string | undefined;
	if (stateDir !== undefined) {
		const dirAdmission = admitDir(stateDir);
		if (!dirAdmission.admitted) {
			return { registered: false, reason: dirAdmission.reason ?? `${stateDir} cannot hold a store` };
		}
		// Admission created it if it was absent, so the canonical path exists to be read.
		directory = canonicalRoot(stateDir);
		// The default directory spelled out is still the default store, not a second one.
		if (directory === workspacePaths(host, resolved).dir) directory = undefined;
	}

	return withRegistryLock(host, () => {
		const projects = readRegistry(host);
		const project = entryOf(workspaceKey(resolved), resolved, directory);
		const existing = projects.find((candidate) => sameStore(candidate, project));
		if (existing !== undefined) return { registered: true, project: existing, already: true };
		writeRegistry(host, [...projects, project]);
		return { registered: true, project, already: false };
	});
}

/** Dropped from the registry entirely. The index it built survives until deleted separately. */
export function forgetProject(reference: string, host: PlatformEnv = currentHost()): boolean {
	return withRegistryLock(host, () => {
		const projects = readRegistry(host);
		const target = findProject(reference, projects);
		if (target === null) return false;
		writeRegistry(
			host,
			projects.filter((project) => !sameStore(project, target)),
		);
		return true;
	});
}
