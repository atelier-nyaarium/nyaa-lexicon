// Which registered projects THIS session is asking about.
//
// Held in memory on purpose: a bind says what the agent in front of you is working on, and that
// dies with the session. Registration is the durable half. The INDEX stays warm either way, so a
// re-bind costs a call rather than a rescan.

import { findProject, type RegisteredProject } from "./projectRegistry.js";

////////////////////////////////
//  Interfaces & Types

export type BindOutcome = { bound: true; project: RegisteredProject } | { bound: false; reason: string };

export interface SessionBinds {
	/** Every registered project, each flagged with whether this session bound it. */
	all: () => RegisteredProject[];
	bound: () => RegisteredProject[];
	bind: (reference: string) => BindOutcome;
	unbind: (reference: string) => BindOutcome;
}

////////////////////////////////
//  Functions & Helpers

export function createSessionBinds(readAll: () => RegisteredProject[]): SessionBinds {
	const keys = new Set<string>();
	const flagged = (): RegisteredProject[] =>
		readAll().map((project) => ({ ...project, bound: keys.has(project.key) }));

	return {
		all: flagged,
		bound: () => flagged().filter((project) => project.bound),

		bind(reference) {
			const target = findProject(reference, readAll());
			if (target === null) {
				return {
					bound: false,
					reason: `no project called ${reference}; call list_projects, or register_project first`,
				};
			}
			keys.add(target.key);
			return { bound: true, project: { ...target, bound: true } };
		},

		unbind(reference) {
			const target = findProject(reference, readAll());
			if (target === null) return { bound: false, reason: `no project called ${reference}` };
			keys.delete(target.key);
			return { bound: true, project: { ...target, bound: false } };
		},
	};
}
