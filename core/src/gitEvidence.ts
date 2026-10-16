// Collect repository evidence with bounded Git calls.
// Bound walks through ignored folders.
// Git status may rewrite its index.

import path from "node:path";
import { DEFAULT_EXCLUDED_DIRECTORIES, normalizeModulePath, workspaceFile } from "@nyaa-lexicon/protocol";
import { underExcludedDirectory } from "@nyaa-lexicon/protocol/excludedDirectories";

////////////////////////////////
//  Interfaces & Types

/** One finished git run. */
export interface GitRun {
	code: number | null;
	stdout: string;
}

/** Git output, or null. */
export type GitRunner = (cwd: string, args: readonly string[]) => Promise<GitRun | null>;

/** Git replaces its index by rename, changing its inode. */
export interface FileStamp {
	mtimeMs: number;
	size: number;
	ino: number;
}

export interface DirectoryEntry {
	name: string;
	isDirectory(): boolean;
	isFile(): boolean;
	isSymbolicLink(): boolean;
}

export interface EvidenceFs {
	/** Throws when unreadable. */
	readdir(directory: string): readonly DirectoryEntry[];
	/** Null when absent. */
	stat(file: string): FileStamp | null;
	/** Null when absent or unreadable. */
	readText(file: string): string | null;
	/** Throws when the path cannot resolve. */
	realpath(file: string): string;
}

/** Git configuration environment. */
export interface GitEnvironment {
	HOME?: string | undefined;
	USERPROFILE?: string | undefined;
	XDG_CONFIG_HOME?: string | undefined;
}

export interface GitEvidenceHost {
	git: GitRunner;
	fs: EvidenceFs;
	env: Readonly<GitEnvironment>;
}

export interface GitEvidenceOptions {
	/** Whether includes reach this repository. */
	reaches: (prefix: string) => boolean;
	/** Whether to discover this ignored path. */
	discovers: (module: string) => boolean;
	/** Entry limit for collapsed-folder walks. */
	walkBound?: number;
}

/** absent: no repository; failed: no answer. */
export type RepositoryState = "ok" | "absent" | "failed";

/** Git input with its pre-listing stamp; null means absent. */
export interface ExternalPath {
	kind: "index" | "exclude" | "excludesFile";
	path: string;
	stamp: FileStamp | null;
}

/** Paths are workspace-relative. */
export interface GitRepository {
	/** Repository root; empty for the project. */
	prefix: string;
	state: RepositoryState;
	gitDir: string | null;
	indexPath: string | null;
	/** Tracked files, excluding gitlinks. */
	tracked: ReadonlySet<string>;
	/** Tracked symlink paths. */
	links: ReadonlySet<string>;
	/** Gitlink roots, for exclusion. */
	gitlinks: ReadonlySet<string>;
	untracked: ReadonlySet<string>;
	/** Nested repositories, discovered or not. */
	nested: ReadonlySet<string>;
	/** Ignored files kept by discovery. */
	discovered: ReadonlySet<string>;
	/** Ignored folders not fully walked. */
	undiscovered: ReadonlySet<string>;
	/** Symlinks found in collapsed folders. */
	walkedLinks: ReadonlySet<string>;
	externals: readonly ExternalPath[];
}

interface Located {
	gitDir: string;
	indexPath: string;
	excludePath: string;
}

interface Listing {
	tracked: Set<string>;
	links: Set<string>;
	gitlinks: Set<string>;
	untracked: Set<string>;
	nested: Set<string>;
}

interface Discovery {
	discovered: Set<string>;
	undiscovered: Set<string>;
	walkedLinks: Set<string>;
	nested: Set<string>;
}

////////////////////////////////
//  Constants

/** Entry limit for collapsed-folder walks. */
export const DEFAULT_WALK_BOUND = 100_000;

const LOCATE_ARGS = [
	"rev-parse",
	"--absolute-git-dir",
	"--git-path",
	"index",
	"--git-path",
	"info/exclude",
	"--show-toplevel",
];

// Parse status tags; paths can resemble staged headers.
const LISTING_ARGS = ["ls-files", "-t", "--stage", "--others", "--exclude-standard", "-z"];

const IGNORED_ARGS = ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"];

const STAGED_HEADER = /^(\d{6}) [0-9a-f]+ [0-3]\t/;

const SYMLINK_MODE = "120000";

const GITLINK_MODE = "160000";

////////////////////////////////
//  Functions & Helpers

/** Project first, then reachable nested repositories. */
export async function collectGitEvidence(
	host: GitEvidenceHost,
	workspaceRoot: string,
	options: GitEvidenceOptions,
): Promise<GitRepository[]> {
	return collectRepository(host, workspaceRoot, "", options);
}

export async function collectGitEvidenceAt(
	host: GitEvidenceHost,
	workspaceRoot: string,
	prefix: string,
	options: GitEvidenceOptions,
): Promise<GitRepository[]> {
	return collectRepository(host, workspaceRoot, prefix, options);
}

/** Whether file stamps match. */
export function sameStamp(a: FileStamp | null, b: FileStamp | null): boolean {
	if (a === null || b === null) return a === b;
	return a.mtimeMs === b.mtimeMs && a.size === b.size && a.ino === b.ino;
}

async function collectRepository(
	host: GitEvidenceHost,
	workspaceRoot: string,
	prefix: string,
	options: GitEvidenceOptions,
): Promise<GitRepository[]> {
	const directory = prefix === "" ? workspaceRoot : workspaceFile(workspaceRoot, prefix);
	if (directory === null) return [emptyRepository(prefix, "failed")];
	if (prefix === "" && host.fs.stat(path.join(directory, ".git")) === null) {
		return [emptyRepository(prefix, "absent")];
	}
	const located = await locate(host, directory);
	if (located === null) return [emptyRepository(prefix, "failed")];
	// Stamp before listing to detect intervening changes.
	const externals = stampExternals(host, located);
	const [listed, ignored] = await Promise.all([
		runOk(host, directory, LISTING_ARGS),
		runOk(host, directory, IGNORED_ARGS),
	]);
	const found = {
		...emptyRepository(prefix, "failed"),
		gitDir: located.gitDir,
		indexPath: located.indexPath,
		externals,
	};
	if (listed === null || ignored === null) return [found];
	const listing = parseListing(listed, prefix);
	const discovery = discoverIgnored(
		host,
		workspaceRoot,
		parseIgnored(ignored, prefix),
		new Set([...listing.gitlinks, ...listing.nested]),
		options,
	);
	const nestedRoots = new Set([...listing.nested, ...discovery.nested]);
	const repository: GitRepository = { ...found, ...listing, ...discovery, nested: nestedRoots, state: "ok" };
	const nested = await Promise.all(
		[...nestedRoots]
			.sort()
			.filter((child) => options.reaches(child))
			.map((child) => collectRepository(host, workspaceRoot, child, options)),
	);
	return [repository, ...nested.flat()];
}

function emptyRepository(prefix: string, state: RepositoryState): GitRepository {
	return {
		prefix,
		state,
		gitDir: null,
		indexPath: null,
		tracked: new Set(),
		links: new Set(),
		gitlinks: new Set(),
		untracked: new Set(),
		nested: new Set(),
		discovered: new Set(),
		undiscovered: new Set(),
		walkedLinks: new Set(),
		externals: [],
	};
}

async function runOk(host: GitEvidenceHost, directory: string, args: readonly string[]): Promise<string | null> {
	const result = await host.git(directory, args);
	return result !== null && result.code === 0 ? result.stdout : null;
}

/** Finds Git metadata inputs, including external paths. */
async function locate(host: GitEvidenceHost, directory: string): Promise<Located | null> {
	const stdout = await runOk(host, directory, LOCATE_ARGS);
	if (stdout === null) return null;
	const lines = stdout.split("\n");
	if (lines.at(-1) === "") lines.pop();
	const [gitDir, index, exclude, toplevel] = lines;
	if (lines.length !== 4 || gitDir === undefined || index === undefined || exclude === undefined) return null;
	// Reject .git paths resolving to a parent repository.
	try {
		if (toplevel === undefined || host.fs.realpath(toplevel) !== host.fs.realpath(directory)) return null;
	} catch {
		return null;
	}
	return { gitDir, indexPath: path.resolve(directory, index), excludePath: path.resolve(directory, exclude) };
}

function stampExternals(host: GitEvidenceHost, located: Located): ExternalPath[] {
	const excludesFile = excludesFileFor(host, path.dirname(path.dirname(located.excludePath)));
	const externals: Array<Omit<ExternalPath, "stamp">> = [
		{ kind: "index", path: located.indexPath },
		{ kind: "exclude", path: located.excludePath },
		...(excludesFile === null ? [] : [{ kind: "excludesFile" as const, path: excludesFile }]),
	];
	return externals.map((external) => ({ ...external, stamp: host.fs.stat(external.path) }));
}

/** Global ignore file, configured or default. */
function excludesFileFor(host: GitEvidenceHost, commonDir: string): string | null {
	const home = host.env.HOME ?? host.env.USERPROFILE;
	const configHome = host.env.XDG_CONFIG_HOME ?? (home === undefined ? undefined : path.join(home, ".config"));
	const configs = [
		"/etc/gitconfig",
		...(configHome === undefined ? [] : [path.join(configHome, "git", "config")]),
		...(home === undefined ? [] : [path.join(home, ".gitconfig")]),
		path.join(commonDir, "config"),
	];
	let configured: string | null = null;
	for (const file of configs) {
		const text = host.fs.readText(file);
		configured = (text === null ? null : excludesFileIn(text)) ?? configured;
	}
	if (configured !== null && home !== undefined && configured.startsWith("~/")) {
		configured = path.join(home, configured.slice(2));
	}
	if (configured !== null && path.isAbsolute(configured)) return configured;
	return configHome === undefined ? null : path.join(configHome, "git", "ignore");
}

/** Last `core.excludesFile` value wins. */
function excludesFileIn(text: string): string | null {
	let inCore = false;
	let found: string | null = null;
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (line.startsWith("[")) {
			inCore = /^\[\s*core\s*\]/i.test(line);
			continue;
		}
		const value = inCore ? /^excludesfile\s*=\s*(.*)$/i.exec(line)?.[1] : undefined;
		if (value === undefined) continue;
		const quoted = /^"([^"]*)"/.exec(value);
		found = quoted?.[1] ?? value.replace(/\s*[#;].*$/, "").trim();
	}
	return found === "" ? null : found;
}

/** Null for unspellable module paths. */
function moduleOf(prefix: string, name: string): string | null {
	try {
		return normalizeModulePath(prefix === "" ? name : `${prefix}/${name}`);
	} catch {
		return null;
	}
}

function parseListing(stdout: string, prefix: string): Listing {
	const listing: Listing = {
		tracked: new Set(),
		links: new Set(),
		gitlinks: new Set(),
		untracked: new Set(),
		nested: new Set(),
	};
	for (const line of stdout.split("\0")) {
		if (line.length < 3 || line[1] !== " ") continue;
		const body = line.slice(2);
		if (line[0] === "?") {
			const module = moduleOf(prefix, body);
			if (module !== null) (body.endsWith("/") ? listing.nested : listing.untracked).add(module);
			continue;
		}
		const header = STAGED_HEADER.exec(body);
		if (header === null) continue;
		const module = moduleOf(prefix, body.slice(header[0].length));
		if (module === null) continue;
		if (header[1] === GITLINK_MODE) {
			listing.gitlinks.add(module);
			continue;
		}
		listing.tracked.add(module);
		if (header[1] === SYMLINK_MODE) listing.links.add(module);
	}
	return listing;
}

function parseIgnored(stdout: string, prefix: string): { files: Set<string>; folders: Set<string> } {
	const ignored = { files: new Set<string>(), folders: new Set<string>() };
	for (const entry of stdout.split("\0")) {
		if (entry.length === 0) continue;
		const module = moduleOf(prefix, entry);
		if (module !== null) (entry.endsWith("/") ? ignored.folders : ignored.files).add(module);
	}
	return ignored;
}

/** Discovers selected ignored paths by walking collapsed folders. */
function discoverIgnored(
	host: GitEvidenceHost,
	workspaceRoot: string,
	ignored: { files: Set<string>; folders: Set<string> },
	repositoryRoots: ReadonlySet<string>,
	options: GitEvidenceOptions,
): Discovery {
	const bound = options.walkBound ?? DEFAULT_WALK_BOUND;
	const entries = (directory: string): readonly string[] => {
		const absolute = directory === "" ? workspaceRoot : workspaceFile(workspaceRoot, directory);
		try {
			return absolute === null ? [] : host.fs.readdir(absolute).map((entry) => entry.name);
		} catch {
			return [];
		}
	};
	const boundaries = new Set(repositoryRoots);
	const excluded = (module: string) =>
		underRepository(module, boundaries) || underExcludedDirectory(module, DEFAULT_EXCLUDED_DIRECTORIES, entries);
	const found: Discovery = {
		discovered: new Set(),
		undiscovered: new Set(),
		walkedLinks: new Set(),
		nested: new Set(),
	};
	for (const file of ignored.files) {
		if (!excluded(file) && options.discovers(file)) found.discovered.add(file);
	}
	const walked = new Set<string>();
	// Git listings may include nested folders.
	for (const folder of [...ignored.folders].sort()) {
		if (underWalked(folder, walked) || excluded(`${folder}/entry`)) continue;
		walked.add(folder);
		const nested = new Set<string>();
		const walk = walkFolder(host, workspaceRoot, folder, bound, excluded, options, nested);
		for (const repository of nested) {
			boundaries.add(repository);
			found.nested.add(repository);
		}
		if (walk === null) {
			found.undiscovered.add(folder);
			continue;
		}
		for (const file of walk.files) found.discovered.add(file);
		for (const link of walk.links) found.walkedLinks.add(link);
	}
	return found;
}

function underRepository(module: string, roots: ReadonlySet<string>): boolean {
	for (const root of roots) if (module === root || module.startsWith(`${root}/`)) return true;
	return false;
}

function underWalked(folder: string, walked: ReadonlySet<string>): boolean {
	const segments = folder.split("/");
	for (let at = 1; at < segments.length; at++) {
		if (walked.has(segments.slice(0, at).join("/"))) return true;
	}
	return false;
}

/** Skips walks above the entry limit. */
function walkFolder(
	host: GitEvidenceHost,
	workspaceRoot: string,
	folder: string,
	bound: number,
	excluded: (module: string) => boolean,
	options: GitEvidenceOptions,
	nested: Set<string>,
): { files: string[]; links: string[] } | null {
	const files: string[] = [];
	const links: string[] = [];
	const pending = [folder];
	let read = 0;
	for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
		const directory = workspaceFile(workspaceRoot, current);
		if (directory === null) continue;
		let contents: readonly DirectoryEntry[];
		try {
			contents = host.fs.readdir(directory);
		} catch {
			continue;
		}
		read += contents.length;
		if (read > bound) return null;
		for (const entry of contents) {
			const child = `${current}/${entry.name}`;
			if (entry.isDirectory()) {
				if (options.reaches(child) && hasGitMarker(host, workspaceRoot, child)) {
					nested.add(child);
					continue;
				}
				if (!excluded(`${child}/entry`)) pending.push(child);
				continue;
			}
			const symlink = entry.isSymbolicLink();
			if (!symlink && !entry.isFile()) continue;
			const module = moduleOf("", child);
			if (module === null) continue;
			if (symlink) links.push(module);
			if (options.discovers(module)) files.push(module);
		}
	}
	return { files, links };
}

function hasGitMarker(host: GitEvidenceHost, workspaceRoot: string, module: string): boolean {
	const directory = workspaceFile(workspaceRoot, module);
	return directory !== null && host.fs.stat(path.join(directory, ".git")) !== null;
}
