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

////////////////////////////////
//  Functions & Helpers

function baseName(root: string): string {
	return path.basename(path.resolve(root)).replace(/[^A-Za-z0-9._-]/g, "-") || "project";
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

function compact(projects: RegisteredProject[]): SessionProject[] {
	const counts = new Map<string, number>();
	for (const project of projects) {
		const base = baseName(project.root);
		counts.set(base, (counts.get(base) ?? 0) + 1);
	}

	const ordinals = new Map<string, number>();
	const used = new Set<string>();
	return projects.map((project) => {
		const base = baseName(project.root);
		if ((counts.get(base) ?? 0) === 1) {
			return { ...project, name: allocateName(base, used, 2), bound: false };
		}
		const ordinal = (ordinals.get(base) ?? 0) + 1;
		ordinals.set(base, ordinal);
		return { ...project, name: allocateName(`${base}-${ordinal}`, used, 2), bound: false };
	});
}

function uniqueProjects(projects: RegisteredProject[]): RegisteredProject[] {
	const keys = new Set<string>();
	return projects.filter((project) => {
		if (keys.has(project.key)) return false;
		keys.add(project.key);
		return true;
	});
}

export function createSessionBinds(readAll: () => RegisteredProject[]): SessionBinds {
	const keys = new Set<string>();
	let catalog = compact(uniqueProjects(readAll()));
	const assignedNames = new Map(catalog.map((project) => [project.key, project.name]));
	const reservedNames = new Set(catalog.map((project) => project.name));

	const reconcile = (): SessionSyncOutcome => {
		const projects = uniqueProjects(readAll());
		const currentKeys = new Set(projects.map((project) => project.key));
		for (const key of keys) {
			if (!currentKeys.has(key)) keys.delete(key);
		}

		const previous = new Map(catalog.map((project) => [project.key, project]));
		const addedKeys = new Set(
			projects.filter((project) => !previous.has(project.key)).map((project) => project.key),
		);
		const counts = new Map<string, number>();
		const addedBases = new Set<string>();
		for (const project of projects) {
			const base = baseName(project.root);
			counts.set(base, (counts.get(base) ?? 0) + 1);
			if (addedKeys.has(project.key)) addedBases.add(base);
		}

		const renameKeys = new Set<string>();
		for (const project of projects) {
			const prior = previous.get(project.key);
			const base = baseName(project.root);
			if (prior?.name === base && addedBases.has(base) && (counts.get(base) ?? 0) > 1) {
				renameKeys.add(project.key);
			}
		}

		// A name that disappeared during this session stays reserved. Otherwise a stale selector could
		// silently start naming a different root before the next MCP restart compacts the namespace.
		const used = new Set(reservedNames);
		for (const project of projects) {
			const prior = previous.get(project.key);
			if (prior !== undefined && !renameKeys.has(project.key)) used.add(prior.name);
		}

		const renames: ProjectRename[] = [];
		catalog = projects.map((project) => {
			const prior = previous.get(project.key);
			if (prior !== undefined && !renameKeys.has(project.key)) {
				return { ...project, name: prior.name, bound: keys.has(project.key) };
			}

			const base = baseName(project.root);
			const collides = (counts.get(base) ?? 0) > 1;
			const assigned = assignedNames.get(project.key);
			if (prior === undefined && assigned !== undefined && (!collides || assigned !== base)) {
				return { ...project, name: assigned, bound: keys.has(project.key) };
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

			if (prior !== undefined) renames.push({ key: project.key, root: project.root, from: prior.name, to: name });
			assignedNames.set(project.key, name);
			reservedNames.add(name);
			return { ...project, name, bound: keys.has(project.key) };
		});

		const bindingsCleared = renames.some((rename) => keys.has(rename.key));
		if (bindingsCleared) keys.clear();
		return { renames, bindingsCleared };
	};

	const flagged = (): SessionProject[] => {
		reconcile();
		return catalog.map((project) => ({ ...project, bound: keys.has(project.key) }));
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
			keys.add(target.key);
			return { bound: true, project: { ...target, bound: true } };
		},

		unbind(reference) {
			reconcile();
			const target = catalog.find((project) => project.name === reference);
			if (target === undefined) return { bound: false, reason: `no project called ${reference}` };
			keys.delete(target.key);
			return { bound: true, project: { ...target, bound: false } };
		},
	};
}
