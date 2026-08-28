// The tools that decide which codebases lexicon is talking about.
//
// Nothing is discovered. A project is known because it was registered, which is durable, and asked
// because this session bound it, which is not. The warm index is what outlives the session.

import { currentHost, lockHolderAlive } from "@nyaa-lexicon/client";
import {
	admitWorkspace,
	listProjectStores,
	registerProject,
	type SessionBinds,
	type SessionProject,
	type SessionSyncOutcome,
	sameStore,
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
	/** Keyed by store: a default store by its key, a custom one by its directory. */
	indexTimes?: () => ReadonlyMap<string, number | null>;
	register: (
		root: string,
		stateDir?: string,
	) =>
		| {
				registered: true;
				project: SessionProject;
				already: boolean;
				sync: SessionSyncOutcome;
		  }
		| { registered: false; reason: string };
	bind: SessionBinds["bind"];
	unbind: SessionBinds["unbind"];
}

////////////////////////////////
//  Constants

export const LIST_PROJECTS_DESCRIPTION = `
# \`list_projects\`

List registered projects with their last indexed time and workspace path.

A \`●\` marks projects bound in this session.
`.trim();

export const REGISTER_PROJECT_DESCRIPTION = `
# \`register_project\`

Register a codebase by absolute root path.

Does not index or bind it. \`bind_project\` starts its indexer for this session.
`.trim();

export const BIND_PROJECT_DESCRIPTION = `
# \`bind_project\`

Bind to a project indexer for this session.

Use a project name from \`list_projects\`.
`.trim();

export const UNBIND_PROJECT_DESCRIPTION = `
# \`unbind_project\`

Stop querying a project indexer.
`.trim();

export const ListProjectsInput = {};

export const RegisterProjectInput = {
	root: z.string().min(1).describe(`Absolute workspace root path.`),
	stateDir: z
		.string()
		.min(1)
		.optional()
		.describe(`Absolute directory to hold this project's store, instead of the default.`),
};

export const BindProjectInput = {
	project: z.string().min(1).describe(`Project name shown by \`list_projects\`.`),
};

////////////////////////////////
//  Functions & Helpers

function text(body: string, isError = false): ToolResult {
	return {
		content: [{ type: "text", text: body }],
		...(isError ? { isError: true } : {}),
	};
}

/** How a project's row finds its store in `indexTimes`. */
function storeOf(project: SessionProject): string {
	return project.stateDir ?? project.key;
}

/** Live deps, for production call sites. Binds come from the session, registration from disk. */
export function liveBindingDeps(binds: SessionBinds): BindingDeps {
	return {
		list: () => binds.all(),
		indexTimes: () =>
			new Map(
				listProjectStores(lockHolderAlive).map((store) => [
					store.custom ? store.directory : store.key,
					store.lastIndexedAt,
				]),
			),
		register: (root, stateDir) => {
			const outcome = registerProject(root, (candidate) => admitWorkspace(candidate), currentHost(), stateDir);
			if (!outcome.registered) return outcome;
			const sync = binds.sync();
			const project = binds.all().find((entry) => sameStore(entry, outcome.project));
			if (project === undefined)
				return {
					registered: false,
					reason: "registered project is missing from this session",
				};
			return { registered: true, project, already: outcome.already, sync };
		},
		bind: (reference) => binds.bind(reference),
		unbind: (reference) => binds.unbind(reference),
	};
}

export function nothingBoundMessage(_projects: SessionProject[]): string {
	return `No project is bound. Call \`list_projects\` for the list of projects. Bind with \`bind_project\`.`;
}

////////////////////////////////
//  Tools

export function listProjectsTool(deps: BindingDeps): ToolResult {
	const projects = deps.list();
	if (projects.length === 0) {
		return text(
			`# Projects\n\nNo project is registered. Call \`register_project\` with the absolute path to a codebase's root.`,
		);
	}

	const indexTimes = deps.indexTimes?.() ?? new Map<string, number | null>();
	const rows = projects
		.map((project) => ({
			project,
			lastIndexedAt: indexTimes.get(storeOf(project)) ?? null,
		}))
		.sort((left, right) => {
			const byTime = (right.lastIndexedAt ?? -Infinity) - (left.lastIndexedAt ?? -Infinity);
			return byTime || left.project.name.localeCompare(right.project.name);
		});
	// The store column appears only once some project chose a directory; the default needs no row.
	const anyCustom = projects.some((project) => project.stateDir !== undefined);
	const cells = rows.map(({ project, lastIndexedAt }) => [
		project.bound ? "●" : "",
		project.name,
		lastIndexedAt === null ? "never" : new Date(lastIndexedAt).toISOString().slice(0, 19).replace("T", " "),
		project.root,
		...(anyCustom ? [project.stateDir ?? ""] : []),
	]);
	const headers = ["", "Project", "Last Indexed", "Workspace", ...(anyCustom ? ["Store"] : [])];
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
	return text(`# Projects\n\n${table}`);
}

export function registerProjectTool(deps: BindingDeps, args: { root: string; stateDir?: string }): ToolResult {
	const outcome = deps.register(args.root, args.stateDir);
	if (!outcome.registered) return text(outcome.reason, true);
	const renamed = outcome.sync.renames.map((entry) => `${entry.from} is now ${entry.to} for ${entry.root}.`);
	const recovery = outcome.sync.bindingsCleared
		? `All session bindings were cleared. Call \`list_projects\`, match full roots, then \`bind_project\`.`
		: null;
	const next = recovery ?? `Call \`bind_project\` with ${outcome.project.name} to answer from it.`;
	return text(
		[
			outcome.already ? "# Project already registered" : "# Project registered",
			"",
			`\`${outcome.project.name}\``,
			`\`${outcome.project.root}\``,
			...(outcome.project.stateDir === undefined ? [] : [`Store: \`${outcome.project.stateDir}\``]),
			...renamed,
			"",
			next,
		].join("\n"),
	);
}

export function bindProjectTool(deps: BindingDeps, args: { project: string }): ToolResult {
	const outcome = deps.bind(args.project);
	if (!outcome.bound) return text(outcome.reason, true);
	return text(`# Project bound\n\nBound the \`${outcome.project.name}\` indexer for this session.`);
}

export function unbindProjectTool(deps: BindingDeps, args: { project: string }): ToolResult {
	const outcome = deps.unbind(args.project);
	if (!outcome.bound) return text(outcome.reason, true);
	return text(`# Project unbound\n\nUnbound \`${outcome.project.name}\`.`);
}
