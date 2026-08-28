// Which registered projects THIS session is asking about.
//
// Held in memory on purpose: a bind says what the agent in front of you is working on, and that
// dies with the session. Registration is the durable half. The INDEX stays warm either way, so a
// re-bind costs a call rather than a rescan.

import path from "node:path";
import type { RegisteredProject } from "./projectRegistry.js";

////////////////////////////////
//  Interfaces & Types

export interface SessionProject extends RegisteredProject {
	name: string;
	bound: boolean;
}

export interface ProjectRename extends RegisteredProject {
	from: string;
	to: string;
}

export interface SessionSyncOutcome {
	renames: ProjectRename[];
	bindingsCleared: boolean;
}

export type BindOutcome = { bound: true; project: SessionProject } | { bound: false; reason: string };

export interface SessionBinds {
	/** Every registered project, each flagged with whether this session bound it. */
	all: () => SessionProject[];
	bound: () => SessionProject[];
	bind: (reference: string) => BindOutcome;
	unbind: (reference: string) => BindOutcome;
	sync: () => SessionSyncOutcome;
}

/** One workspace, however many stores it has. Names are minted per workspace. */
interface Workspace {
	key: string;
	root: string;
}

interface NamedWorkspace extends Workspace {
	name: string;
}

////////////////////////////////
//  Functions & Helpers

/** One string per store, for maps and sets: the default directory is spelled by its absence. */
export function storeIdentity(project: RegisteredProject): string {
	return project.stateDir === undefined ? project.key : `${project.key}@${project.stateDir}`;
}

function baseName(root: string): string {
	return path.basename(path.resolve(root)).replace(/[^A-Za-z0-9._-]/g, "-") || "project";
}

function storeName(dir: string): string {
	return path.basename(dir).replace(/[^A-Za-z0-9._-]/g, "-") || "store";
}

function allocateName(desired: string, used: Set<string>, firstSuffix: number): string {
	if (!used.has(desired)) {
		used.add(desired);
		return desired;
	}
	for (let suffix = firstSuffix; ; suffix++) {
		const candidate = `${desired}-${suffix}`;
		if (used.has(candidate)) continue;
		used.add(candidate);
		return candidate;
	}
}

function compact(workspaces: Workspace[]): NamedWorkspace[] {
	const counts = new Map<string, number>();
	for (const workspace of workspaces) {
		const base = baseName(workspace.root);
		counts.set(base, (counts.get(base) ?? 0) + 1);
	}

	const ordinals = new Map<string, number>();
	const used = new Set<string>();
	return workspaces.map((workspace) => {
		const base = baseName(workspace.root);
		if ((counts.get(base) ?? 0) === 1) {
			return { ...workspace, name: allocateName(base, used, 2) };
		}
		const ordinal = (ordinals.get(base) ?? 0) + 1;
		ordinals.set(base, ordinal);
		return { ...workspace, name: allocateName(`${base}-${ordinal}`, used, 2) };
	});
}

function uniqueProjects(projects: RegisteredProject[]): RegisteredProject[] {
	const seen = new Set<string>();
	return projects.filter((project) => {
		const identity = storeIdentity(project);
		if (seen.has(identity)) return false;
		seen.add(identity);
		return true;
	});
}

/** One per key, in first-seen order, so a workspace is named once however many stores it has. */
function workspacesOf(projects: RegisteredProject[]): Workspace[] {
	const seen = new Set<string>();
	const workspaces: Workspace[] = [];
	for (const project of projects) {
		if (seen.has(project.key)) continue;
		seen.add(project.key);
		workspaces.push({ key: project.key, root: project.root });
	}
	return workspaces;
}

/** A default store wears its workspace's name; a custom one appends its directory's basename
 * after a colon, which no workspace name contains, so the two kinds never collide. */
function nameStores(projects: RegisteredProject[], named: NamedWorkspace[], bound: Set<string>): SessionProject[] {
	const workspaceNames = new Map(named.map((workspace) => [workspace.key, workspace.name]));
	const used = new Set(workspaceNames.values());
	return projects.map((project) => {
		const prefix = workspaceNames.get(project.key) ?? baseName(project.root);
		const name =
			project.stateDir === undefined ? prefix : allocateName(`${prefix}:${storeName(project.stateDir)}`, used, 2);
		return { ...project, name, bound: bound.has(storeIdentity(project)) };
	});
}

export function createSessionBinds(readAll: () => RegisteredProject[]): SessionBinds {
	const bound = new Set<string>();
	const initial = uniqueProjects(readAll());
	let named = compact(workspacesOf(initial));
	let catalog = nameStores(initial, named, bound);
	const assignedNames = new Map(named.map((workspace) => [workspace.key, workspace.name]));
	const reservedNames = new Set(named.map((workspace) => workspace.name));

	const reconcile = (): SessionSyncOutcome => {
		const projects = uniqueProjects(readAll());
		const present = new Set(projects.map(storeIdentity));
		for (const identity of bound) {
			if (!present.has(identity)) bound.delete(identity);
		}

		const workspaces = workspacesOf(projects);
		const previous = new Map(named.map((workspace) => [workspace.key, workspace]));
		const addedKeys = new Set(
			workspaces.filter((workspace) => !previous.has(workspace.key)).map((workspace) => workspace.key),
		);
		const counts = new Map<string, number>();
		const addedBases = new Set<string>();
		for (const workspace of workspaces) {
			const base = baseName(workspace.root);
			counts.set(base, (counts.get(base) ?? 0) + 1);
			if (addedKeys.has(workspace.key)) addedBases.add(base);
		}

		const renameKeys = new Set<string>();
		for (const workspace of workspaces) {
			const prior = previous.get(workspace.key);
			const base = baseName(workspace.root);
			if (prior?.name === base && addedBases.has(base) && (counts.get(base) ?? 0) > 1) {
				renameKeys.add(workspace.key);
			}
		}

		// A name that disappeared during this session stays reserved. Otherwise a stale selector could
		// silently start naming a different root before the next MCP restart compacts the namespace.
		const used = new Set(reservedNames);
		for (const workspace of workspaces) {
			const prior = previous.get(workspace.key);
			if (prior !== undefined && !renameKeys.has(workspace.key)) used.add(prior.name);
		}

		named = workspaces.map((workspace) => {
			const prior = previous.get(workspace.key);
			if (prior !== undefined && !renameKeys.has(workspace.key)) return { ...workspace, name: prior.name };

			const base = baseName(workspace.root);
			const collides = (counts.get(base) ?? 0) > 1;
			const assigned = assignedNames.get(workspace.key);
			if (prior === undefined && assigned !== undefined && (!collides || assigned !== base)) {
				return { ...workspace, name: assigned };
			}
			let name: string;
			if (collides) {
				let suffix = 1;
				while (used.has(`${base}-${suffix}`)) suffix++;
				name = `${base}-${suffix}`;
				used.add(name);
			} else {
				name = allocateName(base, used, 2);
			}
			assignedNames.set(workspace.key, name);
			reservedNames.add(name);
			return { ...workspace, name };
		});

		// A rename is any store whose name moved, whether its workspace was renamed or a sibling
		// store with the same basename came or went.
		const priorNames = new Map(catalog.map((project) => [storeIdentity(project), project.name]));
		catalog = nameStores(projects, named, bound);
		const renames: ProjectRename[] = [];
		for (const project of catalog) {
			const prior = priorNames.get(storeIdentity(project));
			if (prior === undefined || prior === project.name) continue;
			const { name, bound: _bound, ...registered } = project;
			renames.push({ ...registered, from: prior, to: name });
		}

		const bindingsCleared = renames.some((rename) => bound.has(storeIdentity(rename)));
		if (bindingsCleared) bound.clear();
		return { renames, bindingsCleared };
	};

	const flagged = (): SessionProject[] => {
		reconcile();
		return catalog.map((project) => ({ ...project, bound: bound.has(storeIdentity(project)) }));
	};

	return {
		all: flagged,
		bound: () => flagged().filter((project) => project.bound),
		sync: reconcile,

		bind(reference) {
			reconcile();
			const target = catalog.find((project) => project.name === reference);
			if (target === undefined) {
				return {
					bound: false,
					reason: `no project called ${reference}; call list_projects, or register_project first`,
				};
			}
			bound.add(storeIdentity(target));
			return { bound: true, project: { ...target, bound: true } };
		},

		unbind(reference) {
			reconcile();
			const target = catalog.find((project) => project.name === reference);
			if (target === undefined) return { bound: false, reason: `no project called ${reference}` };
			bound.delete(storeIdentity(target));
			return { bound: true, project: { ...target, bound: false } };
		},
	};
}
