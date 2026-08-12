// Which projects this machine knows.
//
// Nothing is discovered any more; a workspace exists here because somebody registered it. Which of
// them a given session ASKS about is sessionBinds, and deliberately not persisted here.
//
// Single owner of the registry file; call sites take the whole state or nothing.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { currentHost, type PlatformEnv, stateRoot, workspaceKey } from "./paths.js";

////////////////////////////////
//  Interfaces & Types

export interface RegisteredProject {
	/** Stable directory name for index storage and daemon identity. */
	key: string;
	root: string;
}

interface RegistryFile {
	projects: Array<{ key: string; root: string; name?: string }>;
}

export type RegisterOutcome =
	| { registered: true; project: RegisteredProject; already: boolean }
	| { registered: false; reason: string };

////////////////////////////////
//  Functions & Helpers

function registryFile(host: PlatformEnv): string {
	return path.join(stateRoot(host), "projects.json");
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
			.map(({ key, root }) => ({ key, root }));
	} catch {
		return [];
	}
}

/** Written through a temp file, since a half-written registry reads as nothing registered. */
function writeRegistry(host: PlatformEnv, projects: RegisteredProject[]): void {
	const file = registryFile(host);
	mkdirSync(path.dirname(file), { recursive: true });
	const staging = `${file}.${process.pid}.tmp`;
	const stored = projects.map(({ key, root }) => ({ key, root }));
	writeFileSync(staging, JSON.stringify({ projects: stored } satisfies RegistryFile, null, 2));
	renameSync(staging, file);
}

/** Durable registry lookup. Session-facing names belong to sessionBinds. */
export function findProject(reference: string, projects: RegisteredProject[]): RegisteredProject | null {
	return projects.find((project) => project.key === reference || project.root === reference) ?? null;
}

////////////////////////////////
//  Changing the registry

export function registerProject(
	root: string,
	admit: (root: string) => { admitted: boolean; reason?: string },
	host: PlatformEnv = currentHost(),
): RegisterOutcome {
	const resolved = path.resolve(root);
	const admission = admit(resolved);
	if (!admission.admitted) return { registered: false, reason: admission.reason ?? `${resolved} cannot be indexed` };

	const projects = readRegistry(host);
	const key = workspaceKey(resolved);
	const existing = projects.find((project) => project.key === key);
	if (existing !== undefined) return { registered: true, project: existing, already: true };

	const project: RegisteredProject = { key, root: resolved };
	writeRegistry(host, [...projects, project]);
	return { registered: true, project, already: false };
}

/** Dropped from the registry entirely. The index it built survives until deleted separately. */
export function forgetProject(reference: string, host: PlatformEnv = currentHost()): boolean {
	const projects = readRegistry(host);
	const target = findProject(reference, projects);
	if (target === null) return false;
	writeRegistry(
		host,
		projects.filter((project) => project.key !== target.key),
	);
	return true;
}
