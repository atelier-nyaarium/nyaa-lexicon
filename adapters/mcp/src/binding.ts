// The tools that decide which codebases lexicon is talking about.
//
// Nothing is discovered. A project is known because it was registered and asked because it was
// bound, and both live on disk, so every session sees the same set and shares one hot index.

import {
	admitWorkspace,
	bindProject,
	type RegisteredProject,
	readRegistry,
	registerProject,
	unbindProject,
} from "@nyaa-lexicon/core";
import { z } from "zod";

////////////////////////////////
//  Interfaces & Types

interface ToolResult {
	content: Array<{ type: "text"; text: string }>;
	isError?: boolean;
}

/** Injected so tests drive the registry without touching a real state directory. */
export interface BindingDeps {
	list: () => RegisteredProject[];
	register: (root: string) => ReturnType<typeof registerProject>;
	bind: (reference: string) => ReturnType<typeof bindProject>;
	unbind: (reference: string) => ReturnType<typeof unbindProject>;
}

////////////////////////////////
//  Constants

export const LIST_PROJECTS_DESCRIPTION = `
Every codebase lexicon knows about, and which are bound right now.

Bound projects are the ones every other tool answers from. Start here when a query says nothing is
bound, then bind_project the one you mean. A codebase that is not listed has never been registered;
register_project adds it.
`.trim();

export const REGISTER_PROJECT_DESCRIPTION = `
Teach lexicon about a codebase, by absolute path to its root.

Registering does not index it and does not make it answerable; bind_project does both. Use this once
per codebase. Registering an already-known project is safe and simply reports it.
`.trim();

export const BIND_PROJECT_DESCRIPTION = `
Make a registered project one of the codebases queries answer from.

Binding is what makes an index hot, and it persists, so other sessions share the same warm index
rather than each building one. Several projects can be bound at once; every query then answers from
each, labelled by project.
`.trim();

export const UNBIND_PROJECT_DESCRIPTION = `
Stop answering queries from this project. It stays registered and its index survives.
`.trim();

export const ListProjectsInput = {};

export const RegisterProjectInput = {
	root: z.string().min(1).describe("Absolute path to the codebase's root directory"),
};

export const BindProjectInput = {
	project: z.string().min(1).describe("Project name or key, exactly as list_projects reports it"),
};

////////////////////////////////
//  Functions & Helpers

function text(body: string, isError = false): ToolResult {
	return { content: [{ type: "text", text: body }], ...(isError ? { isError: true } : {}) };
}

/** Live deps, for production call sites. */
export function liveBindingDeps(): BindingDeps {
	return {
		list: () => readRegistry(),
		register: (root) => registerProject(root, (candidate) => admitWorkspace(candidate)),
		bind: (reference) => bindProject(reference),
		unbind: (reference) => unbindProject(reference),
	};
}

/** What a query says when it has nowhere to look. The only guidance an agent gets, so it names the
 * exact next call rather than describing the situation. */
export function nothingBoundMessage(projects: RegisteredProject[]): string {
	if (projects.length === 0) {
		return "No project is registered, so there is nothing to answer from. Call register_project with the absolute path to the codebase's root, then bind_project.";
	}
	const names = projects.map((project) => project.name).join(", ");
	return `No project is bound, so there is nothing to answer from. Registered: ${names}. Call bind_project with one of those, or register_project for a codebase not listed.`;
}

////////////////////////////////
//  Tools

export function listProjectsTool(deps: BindingDeps): ToolResult {
	const projects = deps.list();
	if (projects.length === 0) {
		return text("No project is registered. Call register_project with the absolute path to a codebase's root.");
	}

	const rows = projects.map(
		(project) => `${project.bound ? "BOUND  " : "       "}${project.name}\n  ${project.root}`,
	);
	const bound = projects.filter((project) => project.bound).length;
	const summary =
		bound === 0
			? "Nothing is bound, so queries have nowhere to look. Call bind_project."
			: `${bound} of ${projects.length} bound; queries answer from ${bound === 1 ? "it" : "each of them"}.`;

	return text(`${rows.join("\n")}\n\n${summary}`);
}

export function registerProjectTool(deps: BindingDeps, args: { root: string }): ToolResult {
	const outcome = deps.register(args.root);
	if (!outcome.registered) return text(outcome.reason, true);
	if (outcome.already) {
		return text(`${outcome.project.name} is already registered. Call bind_project to answer from it.`);
	}
	return text(`Registered ${outcome.project.name} at ${outcome.project.root}. Call bind_project to answer from it.`);
}

export function bindProjectTool(deps: BindingDeps, args: { project: string }): ToolResult {
	const outcome = deps.bind(args.project);
	if (!outcome.bound) return text(outcome.reason, true);
	return text(`Bound ${outcome.project.name}. Its index warms on the next query and stays warm for other sessions.`);
}

export function unbindProjectTool(deps: BindingDeps, args: { project: string }): ToolResult {
	const outcome = deps.unbind(args.project);
	if (!outcome.bound) return text(outcome.reason, true);
	return text(`Unbound ${outcome.project.name}. It stays registered and its index is untouched.`);
}
