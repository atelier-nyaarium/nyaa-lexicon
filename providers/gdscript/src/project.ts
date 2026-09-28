// Owns the project model: each `project.godot` scope, its singletons, and the scripts the engine runs.

import { readFileSync } from "node:fs";
import path from "node:path";
import {
	type Diagnostic,
	hashContent,
	normalizeModulePath,
	OPEN_READ_POLICY,
	type ProjectModel,
	type ReadPolicy,
} from "@nyaa-lexicon/protocol";
import { type ConfigValue, extResourceOf, readConfigResult, stringOf } from "./godot-config.js";
import type { GDScriptProject, GDScriptScope } from "./module.js";
import { discoverProjectCore } from "./projectCore.js";

//////// Constants

const AUTOLOAD_SECTIONS = new Set(["autoload", "autoload_prepend"]);

/** Inherited scenes followed before giving up. */
const MAX_SCENE_DEPTH = 32;

//////// Helpers

/** An `ext_resource` id; Godot 3 wrote a number. */
function idOf(value: ConfigValue | undefined): string | undefined {
	return value?.kind === "number" ? value.text : stringOf(value);
}

/** By key, so order in `project.godot` moves no fingerprint. */
function sortedEntries(entries: Array<[string, string]>): Array<[string, string]> {
	return entries.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
}

//////// Scope reader

/** One `project.godot` and the scenes and sidecars it names. */
class ScopeReader {
	private readonly projectRoot: string;
	/** Read once per scope, when a `uid://` path first needs them. */
	private sidecars: Map<string, string> | undefined;
	private scenes: Map<string, string> | undefined;
	/** Each `uid://` path read, and its module; empty when none. */
	readonly resolvedUids = new Map<string, string>();

	constructor(
		private readonly workspaceRoot: string,
		private readonly directory: string,
		private readonly resources: readonly string[],
		private readonly consulted: Set<string>,
		private readonly diagnostics: Diagnostic[],
		private readonly policy: ReadPolicy,
	) {
		this.projectRoot = path.resolve(workspaceRoot, ...directory.split("/").filter(Boolean));
	}

	read(): GDScriptScope {
		const autoloads: Record<string, string> = {};
		const entries = new Set<string>();
		const config = this.directory === "" ? "project.godot" : `${this.directory}/project.godot`;
		const text = this.readText(config);
		const read = text === undefined ? { sections: [] } : readConfigResult(text, { simpleTags: true });
		if (read.problem !== undefined) {
			const { position, message } = read.problem;
			this.diagnostics.push({
				severity: "warning",
				message: `project.godot is read only up to a problem: ${message}`,
				range: { start: position, end: position },
				path: config,
			});
		}
		for (const section of read.sections) {
			if (section.name === "application") {
				const main = this.script(stringOf(section.properties.get("run/main_scene")), 0);
				if (main !== undefined) entries.add(main);
			}
			if (!AUTOLOAD_SECTIONS.has(section.name)) continue;
			for (const [name, value] of section.properties) {
				const target = stringOf(value);
				if (target === undefined) continue;
				// Only a starred autoload is a singleton with a global name.
				const singleton = target.startsWith("*");
				const script = this.script(singleton ? target.slice(1) : target, 0);
				if (script === undefined) continue;
				entries.add(script);
				if (singleton) autoloads[name] = script;
			}
		}
		return { directory: this.directory, autoloads, entries: [...entries].sort() };
	}

	/** A script path's module, or a scene's root script. */
	private script(resource: string | undefined, depth: number): string | undefined {
		const module = resource === undefined ? undefined : this.resolve(resource);
		if (module === undefined) return undefined;
		if (module.endsWith(".gd")) return module;
		return module.endsWith(".tscn") && depth < MAX_SCENE_DEPTH ? this.sceneScript(module, depth) : undefined;
	}

	/** The root node's script; an inherited scene's when the root has no `script` property. */
	private sceneScript(scene: string, depth: number): string | undefined {
		const text = this.readText(scene);
		if (text === undefined) return undefined;
		const resources = new Map<string, string>();
		for (const section of readConfigResult(text, { skipByteOrderMark: true }).sections) {
			if (section.name === "ext_resource") {
				const id = idOf(section.fields.get("id"));
				const target = stringOf(section.fields.get("path")) ?? stringOf(section.fields.get("uid"));
				if (id !== undefined && target !== undefined) resources.set(id, target);
				continue;
			}
			if (section.name !== "node" || section.fields.has("parent")) continue;
			// `null` or a built-in script overrides the inherited one too.
			if (section.properties.has("script")) {
				const script = extResourceOf(section.properties.get("script"));
				const module = script === undefined ? undefined : this.resolve(resources.get(script) ?? "");
				return module?.endsWith(".gd") ? module : undefined;
			}
			const inherited = extResourceOf(section.fields.get("instance"));
			return inherited === undefined ? undefined : this.script(resources.get(inherited), depth + 1);
		}
		return undefined;
	}

	/** A workspace module for a `res://` or `uid://` path. */
	private resolve(resource: string): string | undefined {
		if (resource.startsWith("uid://")) return this.uidModule(resource);
		if (!resource.startsWith("res://")) return undefined;
		const absolute = path.resolve(this.projectRoot, ...resource.slice("res://".length).split("/"));
		const relative = path.relative(this.workspaceRoot, absolute);
		if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
		return relative.split(path.sep).join("/");
	}

	private uidModule(uid: string): string | undefined {
		const module = this.uidTarget(uid);
		this.resolvedUids.set(uid, module ?? "");
		return module;
	}

	/** From `.uid` sidecars, then scene headers. */
	private uidTarget(uid: string): string | undefined {
		this.sidecars ??= this.sidecarUids();
		const sidecar = this.sidecars.get(uid);
		if (sidecar !== undefined) {
			this.consulted.add(sidecar);
			return sidecar.slice(0, -".uid".length);
		}
		this.scenes ??= this.sceneUids();
		const scene = this.scenes.get(uid);
		if (scene !== undefined) this.consulted.add(scene);
		return scene;
	}

	private sidecarUids(): Map<string, string> {
		const uids = new Map<string, string>();
		for (const sidecar of this.owned(".uid")) {
			const uid = this.readText(sidecar, false)?.trim();
			if (uid?.startsWith("uid://") === true) uids.set(uid, sidecar);
		}
		return uids;
	}

	/** Scene uids from header tags; Godot's uid reader skips no byte order mark. */
	private sceneUids(): Map<string, string> {
		const uids = new Map<string, string>();
		for (const scene of this.owned(".tscn")) {
			const text = this.readText(scene, false);
			const header = text === undefined ? undefined : readConfigResult(text, { tags: 1 }).sections[1];
			const uid = header?.name === "gd_scene" ? stringOf(header.fields.get("uid")) : undefined;
			if (uid !== undefined && !uids.has(uid)) uids.set(uid, scene);
		}
		return uids;
	}

	/** Resources under this project with the extension. */
	private owned(extension: string): string[] {
		const prefix = this.directory === "" ? "" : `${this.directory}/`;
		return this.resources.filter((resource) => resource.startsWith(prefix) && resource.endsWith(extension));
	}

	private readText(module: string, consult = true): string | undefined {
		const file = path.resolve(this.workspaceRoot, ...module.split("/"));
		if (!this.policy.readable(file)) return undefined;
		try {
			const text = readFileSync(file, "utf8");
			if (consult) this.consulted.add(module);
			return text;
		} catch {
			return undefined;
		}
	}
}

//////// Functions

export function discoverProject(workspaceRoot: string, policy = OPEN_READ_POLICY): ProjectModel {
	return discoverGDScriptProject(workspaceRoot, policy).model;
}

export function discoverGDScriptProject(
	workspaceRoot: string,
	policy = OPEN_READ_POLICY,
): { model: ProjectModel; project: GDScriptProject } {
	const root = path.resolve(workspaceRoot);
	const { projectDirectories, resources, ...model } = discoverProjectCore(root, normalizeModulePath);
	const consulted = new Set<string>();
	const diagnostics = [...model.diagnostics];
	const readers = projectDirectories.map(
		(directory) => new ScopeReader(root, directory, resources, consulted, diagnostics, policy),
	);
	const scopes = readers.map((reader) => reader.read());
	const fingerprint = hashContent(
		JSON.stringify(
			scopes.map((scope, index) => ({
				directory: scope.directory,
				singletons: sortedEntries(Object.entries(scope.autoloads)),
				entries: scope.entries,
				uids: sortedEntries([...(readers[index]?.resolvedUids ?? [])]),
			})),
		),
	);
	return {
		model: { ...model, diagnostics, configFiles: [...consulted].sort(), fingerprint },
		project: { scopes },
	};
}
