// Cargo packages, the crates they build and depend on, and the files `mod` declarations load.

import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import {
	type Diagnostic,
	hashContent,
	type ModuleStore,
	OPEN_READ_POLICY,
	type ProjectModel,
	type ReadPolicy,
	walkWorkspace,
} from "@nyaa-lexicon/protocol";
import type { ParsedFile } from "./model.js";
import { isValueToken, tokenize } from "./tokens.js";

////////////////////////////////
//  Interfaces & Types

export type TargetKind = "lib" | "bin" | "test" | "example" | "bench" | "build";

export interface RustTarget {
	kind: TargetKind;
	/** Its package's directory. */
	package: string;
	/** The crates its code names, each to a workspace library's root, or null outside the workspace. */
	externs: ReadonlyMap<string, string | null>;
}

export interface RustProjectState {
	root: string;
	files: string[];
	/** The same files, for membership. */
	fileSet: ReadonlySet<string>;
	configFiles: string[];
	/** Each crate root file, to the target it builds. */
	targets: ReadonlyMap<string, RustTarget>;
}

/** Where a `mod` declaration's file is, or where an impl's target is written: one store index row. */
export interface RustEntry {
	module: string;
	/** The declaring `mod` item's symbol id. */
	declaration?: string;
}

/** A crate in a module's extern prelude. */
export type ExternCrate = { kind: "workspace"; root: string } | { kind: "external" };

type TomlTable = Record<string, unknown>;

interface Package {
	directory: string;
	manifest: TomlTable;
	/** The library it builds, when its root file is in the workspace. */
	library?: { name: string; root: string };
}

////////////////////////////////
//  Constants

export const RUST_EXTENSIONS = [".rs"] as const;

const EXCLUDED_DIRECTORIES = new Set([".git", ".hg", ".svn", ".idea", "node_modules", "target", "vendor"]);

const STANDARD_CRATES = new Set(["alloc", "core", "proc_macro", "std", "test"]);

const DEPENDENCY_TABLES = ["dependencies", "dev-dependencies", "build-dependencies"];

/** Target arrays, the directory Cargo discovers each kind in and the flag that turns that off. */
const TARGET_KINDS = [
	{ kind: "bin", array: "bin", directory: "src/bin", auto: "autobins" },
	{ kind: "test", array: "test", directory: "tests", auto: "autotests" },
	{ kind: "example", array: "example", directory: "examples", auto: "autoexamples" },
	{ kind: "bench", array: "bench", directory: "benches", auto: "autobenches" },
] as const;

/** Files a workspace without a manifest builds crates from. */
const LOOSE_ROOTS = new Map<string, TargetKind>([
	["lib.rs", "lib"],
	["main.rs", "bin"],
	["src/lib.rs", "lib"],
	["src/main.rs", "bin"],
]);

////////////////////////////////
//  Functions & Helpers

/**
 * A path's segments, to its first `{`, `*` or `as`; whether a leading `::` starts it at the crates,
 * and whether a `*` ends it.
 */
export function pathSegments(specifier: string): { absolute: boolean; segments: string[]; glob: boolean } {
	const segments: string[] = [];
	const tokens = tokenize(specifier).tokens;
	let glob = false;
	for (const token of tokens) {
		if (isValueToken(token, "::")) continue;
		glob = isValueToken(token, "*");
		if (token.kind !== "identifier" || isValueToken(token, "as")) break;
		segments.push(token.value);
	}
	return { absolute: isValueToken(tokens[0], "::"), segments, glob };
}

/**
 * The file `mod name;` loads, declared in `file` inside the inline modules `inline`, or null when the
 * workspace has none. A crate root or `mod.rs` holds its children beside it, any other file in a
 * directory of its own name; a `path` attribute is relative to the file's directory, or inside inline
 * modules to where their children would be.
 */
export function moduleFileOf(
	file: string,
	modRs: boolean,
	inline: readonly string[],
	name: string,
	pathAttribute: string | undefined,
	files: ReadonlySet<string>,
): string | null {
	const directory = path.posix.dirname(file);
	const children = modRs ? directory : path.posix.join(directory, path.posix.basename(file, ".rs"));
	const candidates =
		pathAttribute === undefined
			? [`${path.posix.join(children, ...inline, name)}.rs`, path.posix.join(children, ...inline, name, "mod.rs")]
			: [path.posix.join(inline.length === 0 ? directory : path.posix.join(children, ...inline), pathAttribute)];
	return (
		candidates.map((candidate) => path.posix.normalize(candidate)).find((candidate) => files.has(candidate)) ?? null
	);
}

/** Crate roots and `mod.rs` files keep their children beside them. */
export function isModRs(module: string, project: RustProjectState): boolean {
	return path.posix.basename(module) === "mod.rs" || project.targets.has(module);
}

function isTable(value: unknown): value is TomlTable {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fieldAt(table: unknown, key: string): unknown {
	return isTable(table) ? table[key] : undefined;
}

function stringAt(table: unknown, key: string): string | undefined {
	const value = fieldAt(table, key);
	return typeof value === "string" ? value : undefined;
}

/** Code spells `my-crate` as `my_crate`. */
function codeName(name: string): string {
	return name.replaceAll("-", "_");
}

/** A manifest path from its directory, as the workspace spells modules. */
function manifestPath(directory: string, written: string): string {
	return path.posix.normalize(path.posix.join(directory, written.replaceAll("\\", "/")));
}

/** Top-level and `[target.<cfg>]` dependency tables. */
function dependencyTables(manifest: TomlTable): TomlTable[] {
	const { target } = manifest;
	const targets = isTable(target) ? Object.values(target).filter(isTable) : [];
	return [manifest, ...targets].flatMap((scope) => DEPENDENCY_TABLES.map((name) => scope[name]).filter(isTable));
}

/** The manifest in `directory`, when the scope lets it be read. */
function readManifest(
	root: string,
	directory: string,
	policy: ReadPolicy,
): { manifest?: TomlTable; diagnostics: Diagnostic[] } {
	const cargo = path.join(root, directory, "Cargo.toml");
	if (!existsSync(cargo) || !statSync(cargo).isFile() || !policy.readable(cargo)) return { diagnostics: [] };
	try {
		const manifest: unknown = Bun.TOML.parse(readFileSync(cargo, "utf8"));
		return isTable(manifest) ? { manifest, diagnostics: [] } : { diagnostics: [] };
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		const message = `Cargo.toml is not TOML, so no crate is external: ${detail}`;
		return { diagnostics: [{ severity: "warning", message, path: manifestPath(directory, "Cargo.toml") }] };
	}
}

/** The workspace root and every directory above a discovered file, where a manifest may be. */
function sourceDirectories(files: readonly string[]): string[] {
	const directories = new Set<string>([""]);
	for (const file of files) {
		const parts = file.split("/").slice(0, -1);
		for (let length = 1; length <= parts.length; length++) directories.add(parts.slice(0, length).join("/"));
	}
	return [...directories].sort();
}

/** The workspace a package inherits `dep.workspace = true` entries from: its own, else the nearest above. */
function workspaceOf(
	directory: string,
	manifests: ReadonlyMap<string, TomlTable>,
): { directory: string; manifest: TomlTable } | undefined {
	for (let at: string | undefined = directory; at !== undefined; at = at === "" ? undefined : parentOf(at)) {
		const manifest = manifests.get(at);
		if (manifest !== undefined && isTable(fieldAt(manifest, "workspace"))) return { directory: at, manifest };
	}
	return undefined;
}

function parentOf(directory: string): string {
	const parent = path.posix.dirname(directory);
	return parent === "." ? "" : parent;
}

/** A package's crate roots, written and discovered, by kind. */
function packageTargets(
	pack: Package,
	files: readonly string[],
	fileSet: ReadonlySet<string>,
): Map<string, TargetKind> {
	const { manifest, directory } = pack;
	const settings = fieldAt(manifest, "package");
	const packageName = stringAt(settings, "name");
	const roots = new Map<string, TargetKind>();
	const add = (file: string | undefined, kind: TargetKind) => {
		if (file !== undefined && fileSet.has(file) && !roots.has(file)) roots.set(file, kind);
	};
	add(pack.library?.root, "lib");
	for (const { kind, array, directory: home, auto } of TARGET_KINDS) {
		const written = manifest[array];
		for (const target of Array.isArray(written) ? written.filter(isTable) : []) {
			const explicit = stringAt(target, "path");
			const name = stringAt(target, "name");
			if (explicit !== undefined) add(manifestPath(directory, explicit), kind);
			else if (name !== undefined) {
				add(manifestPath(directory, `${home}/${name}.rs`), kind);
				add(manifestPath(directory, `${home}/${name}/main.rs`), kind);
				if (kind === "bin" && name === packageName) add(manifestPath(directory, "src/main.rs"), kind);
			}
		}
		if (fieldAt(settings, auto) === false) continue;
		if (kind === "bin") add(manifestPath(directory, "src/main.rs"), kind);
		const prefix = manifestPath(directory, home);
		for (const file of files) {
			if (!file.startsWith(`${prefix}/`)) continue;
			const rest = file.slice(prefix.length + 1).split("/");
			if (rest.length === 1 || (rest.length === 2 && rest[1] === "main.rs")) add(file, kind);
		}
	}
	const build = fieldAt(settings, "build");
	if (build !== false) add(manifestPath(directory, typeof build === "string" ? build : "build.rs"), "build");
	return roots;
}

/** A package's dependencies by the name its code uses, each to a workspace library root or null. */
function packageExterns(
	pack: Package,
	packages: ReadonlyMap<string, Package>,
	workspace: { directory: string; manifest: TomlTable } | undefined,
): Map<string, string | null> {
	const shared = fieldAt(fieldAt(workspace?.manifest, "workspace"), "dependencies");
	const externs = new Map<string, string | null>();
	for (const table of dependencyTables(pack.manifest)) {
		for (const [key, value] of Object.entries(table)) {
			// `dep.workspace = true` takes the workspace's entry, whose path is from its root.
			const inherited = fieldAt(value, "workspace") === true;
			const entry = inherited ? fieldAt(shared, key) : value;
			const written = stringAt(entry, "path");
			const from = inherited ? (workspace?.directory ?? "") : pack.directory;
			const target = written === undefined ? undefined : packages.get(manifestPath(from, written));
			// Unrenamed, code names a library by its own name; `package =` renames it to the key.
			const renamed = stringAt(entry, "package") !== undefined || stringAt(value, "package") !== undefined;
			const name = !renamed && target?.library !== undefined ? target.library.name : codeName(key);
			externs.set(name, target?.library?.root ?? null);
		}
	}
	return externs;
}

function emptyState(root: string): RustProjectState {
	return { root, files: [], fileSet: new Set(), configFiles: [], targets: new Map() };
}

/** Every crate root: each package's targets, seeing its dependencies and, beside its library, the library. */
function workspaceTargets(
	root: string,
	files: string[],
	fileSet: ReadonlySet<string>,
	policy: ReadPolicy,
	configFiles: string[],
	diagnostics: Diagnostic[],
): Map<string, RustTarget> {
	// Every manifest over the sources: workspace members, and packages that are workspaces of their own.
	const manifests = new Map<string, TomlTable>();
	for (const directory of sourceDirectories(files)) {
		const read = readManifest(root, directory, policy);
		diagnostics.push(...read.diagnostics);
		if (read.manifest === undefined) continue;
		manifests.set(directory, read.manifest);
		if (directory !== "") configFiles.push(manifestPath(directory, "Cargo.toml"));
	}
	const packages = new Map<string, Package>();
	const addPackage = (directory: string, manifest: TomlTable) => {
		const settings = fieldAt(manifest, "package");
		if (!isTable(settings)) return;
		const { lib } = manifest;
		const name = stringAt(lib, "name") ?? stringAt(settings, "name");
		const libraryRoot = manifestPath(directory, stringAt(lib, "path") ?? "src/lib.rs");
		packages.set(directory, {
			directory,
			manifest,
			...(name === undefined || !fileSet.has(libraryRoot)
				? {}
				: { library: { name: codeName(name), root: libraryRoot } }),
		});
	};
	for (const [directory, manifest] of manifests) addPackage(directory, manifest);
	const targets = new Map<string, RustTarget>();
	for (const pack of packages.values()) {
		const externs = packageExterns(pack, packages, workspaceOf(pack.directory, manifests));
		const withLibrary = new Map(externs);
		if (pack.library !== undefined) withLibrary.set(pack.library.name, pack.library.root);
		for (const [file, kind] of packageTargets(pack, files, fileSet))
			if (!targets.has(file))
				targets.set(file, { kind, package: pack.directory, externs: kind === "lib" ? externs : withLibrary });
	}
	if (manifests.size === 0)
		for (const [file, kind] of LOOSE_ROOTS)
			if (fileSet.has(file)) targets.set(file, { kind, package: path.posix.dirname(file), externs: new Map() });
	return targets;
}

/** What binding reads beyond each file's text: the crate roots, their kinds and what each names. */
function fingerprintOf(targets: ReadonlyMap<string, RustTarget>): string {
	const digest = [...targets]
		.sort(([left], [right]) => (left < right ? -1 : 1))
		.map(([file, target]) => [file, target.kind, target.package, [...target.externs].sort()]);
	return hashContent(JSON.stringify(digest));
}

export function discoverRustProject(
	workspaceRoot: string,
	policy = OPEN_READ_POLICY,
): { state: RustProjectState; model: ProjectModel } {
	const root = path.resolve(workspaceRoot);
	const missing = !existsSync(root) ? "does not exist" : !statSync(root).isDirectory() ? "is not a directory" : null;
	if (missing !== null) {
		return {
			state: emptyState(root),
			model: {
				files: [],
				externalRoots: [],
				configFiles: [],
				diagnostics: [{ severity: "error", message: `workspace root ${missing}: ${root}`, path: root }],
			},
		};
	}
	const files = walkWorkspace(root, { extensions: RUST_EXTENSIONS, excludedDirectories: EXCLUDED_DIRECTORIES }).files;
	const fileSet = new Set(files);
	const configFiles = ["Cargo.toml", "Cargo.lock"].filter((file) => existsSync(path.join(root, file)));
	const diagnostics: Diagnostic[] = [];
	const targets = workspaceTargets(root, files, fileSet, policy, configFiles, diagnostics);
	return {
		state: { root, files, fileSet, configFiles, targets },
		model: { files, externalRoots: [], configFiles, diagnostics, fingerprint: fingerprintOf(targets) },
	};
}

////////////////////////////////
//  Class

/** The crates a module belongs to and names, read from the targets and the `mod` declarations indexed. */
export class RustProjectResolver {
	constructor(private readonly store: ModuleStore<ParsedFile, RustProjectState, RustEntry>) {}

	private get state(): RustProjectState {
		return this.store.project;
	}

	get root(): string {
		return this.state.root;
	}

	get files(): ReadonlySet<string> {
		return this.state.fileSet;
	}

	target(root: string): RustTarget | undefined {
		return this.state.targets.get(root);
	}

	isModRs(module: string): boolean {
		return isModRs(module, this.state);
	}

	/** The `mod` declarations that load `module`. */
	declarers(module: string): readonly RustEntry[] {
		return this.store.get(`declares:${module}`);
	}

	/** The one crate root whose module tree holds `module`, or null when none or several do. */
	crateRootOf(module: string): string | null {
		return this.store.memo(`rust-crate-root:${module}`, () => {
			const roots = new Set<string>();
			const seen = new Set<string>([module]);
			const pending = [module];
			for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
				if (this.state.targets.has(current)) {
					roots.add(current);
					continue;
				}
				for (const { module: parent } of this.declarers(current))
					if (!seen.has(parent)) {
						seen.add(parent);
						pending.push(parent);
					}
			}
			return roots.size === 1 ? ([...roots][0] as string) : null;
		});
	}

	/** What a crate name in `fromModule`'s extern prelude names, if anything. */
	externCrate(fromModule: string, name: string): ExternCrate | undefined {
		if (STANDARD_CRATES.has(name)) return { kind: "external" };
		const root = this.crateRootOf(fromModule);
		const extern = root === null ? undefined : this.state.targets.get(root)?.externs.get(name);
		if (extern === undefined) return undefined;
		return extern === null ? { kind: "external" } : { kind: "workspace", root: extern };
	}
}
