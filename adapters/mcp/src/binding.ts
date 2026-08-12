// The tools that decide which codebases lexicon is talking about.
//
// Nothing is discovered. A project is known because it was registered, which is durable, and asked
// because this session bound it, which is not. The warm index is what outlives the session.

import {
	admitWorkspace,
	listProjectStores,
	processIsAlive,
	registerProject,
	type SessionBinds,
	type SessionProject,
	type SessionSyncOutcome,
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
	list: () => SessionProject[];
	indexTimes?: () => ReadonlyMap<string, number | null>;
	register: (
		root: string,
	) =>
		| { registered: true; project: SessionProject; already: boolean; sync: SessionSyncOutcome }
		| { registered: false; reason: string };
	bind: SessionBinds["bind"];
	unbind: SessionBinds["unbind"];
}

////////////////////////////////
//  Constants

export const LIST_PROJECTS_DESCRIPTION = `
# \`list_projects\`

List registered projects and their last indexed time.

Binding names last for this MCP session. Match full roots after a reload.
`.trim();

export const REGISTER_PROJECT_DESCRIPTION = `
# \`register_project\`

Register a codebase by its absolute root path.

This does not index or bind it. \`bind_project\` does both. Re-registering is safe.
`.trim();

export const BIND_PROJECT_DESCRIPTION = `
# \`bind_project\`

Bind a registered project for this session.

Use the binding name from \`list_projects\`. Multiple projects can be bound.
`.trim();

export const UNBIND_PROJECT_DESCRIPTION = `
# \`unbind_project\`

Stop querying a project. Its registration and index remain.
`.trim();

export const ListProjectsInput = {};

export const RegisterProjectInput = {
	root: z.string().min(1).describe(`Absolute codebase root path.`),
};

export const BindProjectInput = {
	project: z.string().min(1).describe(`Binding name from \`list_projects\`.`),
};

////////////////////////////////
//  Functions & Helpers

function text(body: string, isError = false): ToolResult {
	return { content: [{ type: "text", text: body }], ...(isError ? { isError: true } : {}) };
}

/** Live deps, for production call sites. Binds come from the session, registration from disk. */
export function liveBindingDeps(binds: SessionBinds): BindingDeps {
	return {
		list: () => binds.all(),
		indexTimes: () => new Map(listProjectStores(processIsAlive).map((store) => [store.key, store.lastIndexedAt])),
		register: (root) => {
			const outcome = registerProject(root, (candidate) => admitWorkspace(candidate));
			if (!outcome.registered) return outcome;
			const sync = binds.sync();
			const project = binds.all().find((entry) => entry.key === outcome.project.key);
			if (project === undefined)
				return { registered: false, reason: "registered project is missing from this session" };
			return { registered: true, project, already: outcome.already, sync };
		},
		bind: (reference) => binds.bind(reference),
		unbind: (reference) => binds.unbind(reference),
	};
}

/** What a query says when it has nowhere to look. The only guidance an agent gets, so it names the
 * exact next call rather than describing the situation. */
export function nothingBoundMessage(projects: SessionProject[]): string {
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

	const indexTimes = deps.indexTimes?.() ?? new Map<string, number | null>();
	const rows = projects
		.map((project) => ({
			project,
			lastIndexedAt: indexTimes.get(project.key) ?? null,
		}))
		.sort((left, right) => {
			const byTime = (right.lastIndexedAt ?? -Infinity) - (left.lastIndexedAt ?? -Infinity);
			return byTime || left.project.name.localeCompare(right.project.name);
		});
	const cells = rows.map(({ project, lastIndexedAt }) => [
		project.bound ? "●" : "",
		project.name,
		lastIndexedAt === null ? "never" : new Date(lastIndexedAt).toISOString().slice(0, 19).replace("T", " "),
		project.root,
	]);
	const headers = ["", "Project", "Last Indexed", "Workspace"];
	const widths = headers.map((header, column) =>
		Math.max(header.length, ...cells.map((row) => row[column]?.length ?? 0)),
	);
	const table = [headers, ...cells]
		.map((row) =>
			row
				.map((cell, column) => (column === row.length - 1 ? cell : cell.padEnd(widths[column] ?? cell.length)))
				.join("  "),
		)
		.join("\n");
	const bound = projects.filter((project) => project.bound).length;
	const summary =
		bound === 0
			? "Nothing is bound, so queries have nowhere to look. Call bind_project."
			: bound === 1
				? `1 of ${projects.length} bound; project selectors may be omitted.`
				: `${bound} of ${projects.length} bound; choose projects explicitly, or use \`projects: []\` for all.`;

	return text(`${table}\n\n${summary}`);
}

export function registerProjectTool(deps: BindingDeps, args: { root: string }): ToolResult {
	const outcome = deps.register(args.root);
	if (!outcome.registered) return text(outcome.reason, true);
	const renamed = outcome.sync.renames.map((entry) => `${entry.from} is now ${entry.to} for ${entry.root}.`);
	const recovery = outcome.sync.bindingsCleared
		? "All session bindings were cleared. Call list_projects, match full roots, then bind_project."
		: null;
	if (outcome.already) {
		const next = recovery ?? `Call bind_project with ${outcome.project.name} to answer from it.`;
		return text(
			[`${outcome.project.name} is already registered at ${outcome.project.root}.`, ...renamed, next].join("\n"),
		);
	}

	const next = recovery ?? `Call bind_project with ${outcome.project.name} to answer from it.`;
	return text([`Registered ${outcome.project.name} at ${outcome.project.root}.`, ...renamed, next].join("\n"));
}

export function bindProjectTool(deps: BindingDeps, args: { project: string }): ToolResult {
	const outcome = deps.bind(args.project);
	if (!outcome.bound) return text(outcome.reason, true);
	return text(
		`Bound ${outcome.project.name}. Its index warms on the next query and stays warm for other sessions. The bind itself lasts only this session.`,
	);
}

export function unbindProjectTool(deps: BindingDeps, args: { project: string }): ToolResult {
	const outcome = deps.unbind(args.project);
	if (!outcome.bound) return text(outcome.reason, true);
	return text(`Unbound ${outcome.project.name}. It stays registered and its index is untouched.`);
}
