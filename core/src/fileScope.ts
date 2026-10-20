// Scope follows project ownership, not every path on disk.
// Ignore rules constrain discovery; explicit paths and imports bypass them unless denied.

import type { ChildProcess } from "node:child_process";
import { type Dirent, existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { canonicalRoot } from "@nyaa-lexicon/client";
import {
	type AdmissionCause,
	type BoundedTimer,
	DEFAULT_EXCLUDED_DIRECTORIES,
	globToRegExp,
	normalizeModulePath,
	runBounded,
	type SecretsConfig,
	workspaceFile,
} from "@nyaa-lexicon/protocol";
import { directoryEntries, underExcludedDirectory } from "@nyaa-lexicon/protocol/excludedDirectories";
import { type Clock, systemClock, type TimerHandle } from "./clock.js";
import { collectGitEvidence, collectGitEvidenceAt, type GitEvidenceHost, type GitRepository } from "./gitEvidence.js";
import type { EvidenceView } from "./policyEvidence.js";
import type { SecretPolicySnapshot } from "./secretPolicy.js";

////////////////////////////////
//  Interfaces & Types

export interface ScopeConfig {
	/** Paths or globs indexed regardless of ignore. The explicit half of the rule. */
	include?: string[];
	/** Paths or globs excluded from automatic roots. Includes still override this list. */
	exclude?: string[];
	/** Paths or globs that must never be indexed, including through imports. */
	deny?: string[];
	/** Generated or shipped modules constrained to their exported surface. */
	bundles?: string[];
	/** A command and its arguments, run with no shell on the files a refactor step wrote. */
	fix?: string[];
	/** A formatter run with no shell: the text on stdin, the result on stdout; `{module}` names the file. */
	fixText?: string[];
	/** Matching globs override built-ins. */
	secrets?: SecretsConfig;
}

export type ScopeConfigRead =
	| { kind: "absent" }
	| { kind: "valid"; config: ScopeConfig }
	| { kind: "invalidSecrets"; config: ScopeConfig; glob: string | null }
	| { kind: "malformed" };

export type GitTracking = { kind: "tracked"; files: Set<string> } | { kind: "noGit" } | { kind: "failed" };

export interface FileScope {
	/** `git` when git answered, `walk` when there is none. A caller states which it got. */
	mode: "git" | "walk";
	/** Whether auto-discovery may index this module. Closure bypasses it deliberately. */
	allows: (module: string) => boolean;
	/** Whether an event extends discovery. */
	admitsEvent: (module: string) => boolean;
	/** Files git knows about, absent in walk mode. */
	known: Set<string> | null;
	include: string[];
	exclude: string[];
	deny: string[];
	/** Whether this module is forbidden from roots and import closure. */
	denies: (module: string) => boolean;
	cause: (module: string, folder?: boolean) => AdmissionCause;
	bundles: string[];
	/** Whether this module must use surface indexing even when it is explicitly included. */
	surface: (module: string) => boolean;
}

export interface CollectedScopeEvidence {
	known: Set<string> | null;
	tracking: GitTracking;
	repositories: readonly GitRepository[];
	modules: ReadonlySet<string>;
	links: ReadonlyMap<string, LinkTarget>;
	aliasesByTarget: ReadonlyMap<string, readonly string[]>;
	targets: ReadonlyMap<string, string>;
	directoryLinks: ReadonlyMap<string, string>;
	ignoredSecrets: Set<string>;
	undiscovered: ReadonlySet<string>;
	entries: ReadonlyMap<string, readonly string[]>;
}

export type LinkTarget =
	| { kind: "file"; target: string }
	| { kind: "directory"; target: string }
	| { kind: "outside" }
	| { kind: "dangling" };

export interface LinkEvidenceFileSystem {
	lstat(file: string): "link" | "other" | null;
	realpath(file: string): string | null;
	isDirectory(file: string): boolean;
}

////////////////////////////////
//  Constants

/** Read from the workspace root when present. Absent is the normal case. */
export const CONFIG_FILE = "lexicon.json";

/** Stops an include glob from walking a deep tree forever. Deeper than any real source layout. */
const MAX_INCLUDE_DEPTH = 12;

/** Never indexed, whatever the config includes. */
const BUILT_IN_DENY = ["**/.git/**"];

/** Bounds every git call, so a wedged process is killed rather than waited on forever. */
const GIT_TIMEOUT_MS = 30_000;

/** Matches the previous execFileSync cap; stdout past this is killed and read as a failure. */
const GIT_MAX_STDOUT_BYTES = 128 * 1024 * 1024;

/** Whether a workspace-relative module is outside the workspace or under a dependency directory. */
export function isExternalModule(workspaceRoot: string, module: string): boolean {
	const root = path.resolve(workspaceRoot);
	const file = workspaceFile(root, module);
	if (file === null) return true;
	return path.relative(root, file).split(path.sep).includes("node_modules");
}

////////////////////////////////
//  Functions & Helpers

/** What one git run answers, or how to run it in a test that proves the timeout kills a wedged one. */
export interface GitRunOptions {
	input?: string;
	/** The executable to spawn. Only ever "git" outside a test standing in a process that hangs. */
	command?: string;
	/** Handed the spawned child, so a test can assert the reap without a second process listing. */
	onSpawn?: (child: ChildProcess) => void;
	/** Overrides `GIT_MAX_STDOUT_BYTES`, for a test proving the cap kills without a real 128MB run. */
	maxStdoutBytes?: number;
	timeoutMs?: number;
}

export type GitRunner = typeof runGit;

/** A `BoundedTimer` over the injected clock, so a fake clock in a test drives the same timeout road. */
function clockTimer(clock: Clock): BoundedTimer {
	return {
		set: (fn, ms) => clock.setTimer(fn, ms),
		clear: (handle) => clock.clearTimer(handle as TimerHandle),
	};
}

/** Runs one command asynchronously, bounded by `GIT_TIMEOUT_MS`, killing and reaping a wedged child rather than waiting on it; null only when nothing answered: a spawn failure, a timeout, or stdout past the cap. */
export async function runGit(
	clock: Clock,
	cwd: string,
	args: string[],
	options: GitRunOptions = {},
): Promise<{ code: number | null; stdout: string } | null> {
	// A repo's own `.git/config` may name an fsmonitor command, which git runs on an index refresh.
	const argv = options.command === undefined ? ["-c", "core.fsmonitor=false", ...args] : args;
	const result = await runBounded(options.command ?? "git", argv, {
		cwd,
		input: options.input,
		maxBytes: options.maxStdoutBytes ?? GIT_MAX_STDOUT_BYTES,
		timeoutMs: options.timeoutMs ?? GIT_TIMEOUT_MS,
		timer: clockTimer(clock),
		onSpawn: options.onSpawn,
	});
	return result.kind === "exited" ? { code: result.code, stdout: result.stdout.toString("utf8") } : null;
}

/** The config's deny globs and the built-in ones. */
export function denyGlobs(config: ScopeConfig): string[] {
	return [...new Set([...BUILT_IN_DENY, ...(config.deny ?? [])])];
}

/** Indexed gitlinks, workspace-relative. */
export async function submoduleRoots(
	workspaceRoot: string,
	clock: Clock = systemClock,
	timeoutMs = GIT_TIMEOUT_MS,
	run: GitRunner = runGit,
): Promise<Set<string> | null> {
	if (!existsSync(path.join(workspaceRoot, ".git"))) return null;
	const result = await run(clock, workspaceRoot, ["ls-files", "--stage", "-z"], { timeoutMs });
	if (result === null || result.code !== 0) return null;
	const roots = new Set<string>();
	for (const line of result.stdout.split("\0")) {
		if (line.length === 0) continue;
		const tab = line.indexOf("\t");
		if (tab === -1) continue;
		if (line.slice(0, tab).split(" ")[0] !== "160000") continue;
		try {
			roots.add(normalizeModulePath(line.slice(tab + 1)));
		} catch {
			// Unspeakable name: out of scope like every other one the id grammar cannot hold.
		}
	}
	return roots;
}

const SUBMODULE_DISCOVERY_MS = 8_000;
const SUBMODULE_DISCOVERY_LIMIT = 256;

/** Initialized recursive submodules and whether every Git read completed. */
export async function discoverSubmodules(
	workspaceRoot: string,
	clock: Clock = systemClock,
	run: GitRunner = runGit,
): Promise<{ roots: string[]; complete: boolean }> {
	let root: string;
	try {
		root = canonicalRoot(workspaceRoot);
	} catch {
		return { roots: [], complete: false };
	}
	if (!existsSync(path.join(root, ".git"))) return { roots: [], complete: true };
	const deadline = clock.now() + SUBMODULE_DISCOVERY_MS;
	const roots = new Set<string>();
	const visited = new Set<string>();
	let complete = true;
	const visit = async (current: string): Promise<void> => {
		const canonical = canonicalRoot(current);
		if (visited.has(canonical)) return;
		if (visited.size >= SUBMODULE_DISCOVERY_LIMIT || clock.now() >= deadline) {
			complete = false;
			return;
		}
		visited.add(canonical);
		const remaining = Math.max(1, Math.min(GIT_TIMEOUT_MS, deadline - clock.now()));
		const gitRoot = await run(clock, canonical, ["rev-parse", "--show-toplevel"], { timeoutMs: remaining });
		if (gitRoot === null || gitRoot.code !== 0 || gitRoot.stdout.trim().length === 0) {
			complete = false;
			return;
		}
		if (canonicalRoot(gitRoot.stdout.trim()) !== canonical) {
			complete = false;
			return;
		}
		const children = await submoduleRoots(
			canonical,
			clock,
			Math.max(1, Math.min(GIT_TIMEOUT_MS, deadline - clock.now())),
			run,
		);
		if (children === null) {
			complete = false;
			return;
		}
		for (const child of children) {
			if (clock.now() >= deadline) {
				complete = false;
				return;
			}
			const childPath = path.resolve(canonical, ...child.split("/"));
			if (!existsSync(childPath) || !existsSync(path.join(childPath, ".git"))) continue;
			const childCanonical = canonicalRoot(childPath);
			const relative = path.relative(root, childCanonical);
			if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
				complete = false;
				continue;
			}
			const childGitRoot = await runGit(clock, childCanonical, ["rev-parse", "--show-toplevel"], {
				timeoutMs: Math.max(1, Math.min(GIT_TIMEOUT_MS, deadline - clock.now())),
			});
			if (
				childGitRoot === null ||
				childGitRoot.code !== 0 ||
				childGitRoot.stdout.trim().length === 0 ||
				canonicalRoot(childGitRoot.stdout.trim()) !== childCanonical
			) {
				complete = false;
				continue;
			}
			roots.add(childCanonical);
			await visit(childCanonical);
		}
	};
	try {
		await visit(root);
	} catch {
		complete = false;
	}
	return { roots: [...roots].sort(), complete };
}

/** The submodule root `module` lies under, or itself if it names one directly; undefined outside every submodule. */
function submoduleOf(module: string, roots: ReadonlySet<string>): string | undefined {
	// Roots come from normalizeModulePath already; a caller's own module must match on the same terms.
	let normalized: string;
	try {
		normalized = normalizeModulePath(module);
	} catch {
		return undefined;
	}
	for (const root of roots) {
		if (normalized === root || normalized.startsWith(`${root}/`)) return root;
	}
	return undefined;
}

/**
 * Splits `modules` into what git may be asked about and what lies under a submodule.
 *
 * `check-ignore` and `check-attr` refuse a pathspec that reaches INTO a submodule, and refuse the
 * WHOLE batch for it, so one such path would otherwise flip the answer for every other path asked
 * alongside it. Null when git cannot say which paths those are.
 */
async function splitBySubmodule(
	workspaceRoot: string,
	clock: Clock,
	modules: readonly string[],
): Promise<{ askable: string[]; underSubmodule: string[] } | null> {
	const roots = await submoduleRoots(workspaceRoot, clock);
	if (roots === null) return null;
	const askable: string[] = [];
	const underSubmodule: string[] = [];
	for (const module of modules) (submoduleOf(module, roots) === undefined ? askable : underSubmodule).push(module);
	return { askable, underSubmodule };
}

/**
 * Which of these paths git's ignore rules exclude, in one git call.
 *
 * Null when git cannot say, so a caller reads rather than drops. Asked only of paths the scope
 * does not already hold, so a churning ignored directory costs one call per burst and no read.
 *
 * A path under a submodule answers not ignored without asking: it belongs to a different
 * repository's rules, and the pathspec would otherwise take the whole call down with it.
 */
export async function gitIgnored(
	workspaceRoot: string,
	modules: Iterable<string>,
	clock: Clock = systemClock,
): Promise<Set<string> | null> {
	const paths = [...new Set(modules)];
	if (paths.length === 0) return new Set();
	if (!existsSync(path.join(workspaceRoot, ".git"))) return null;
	const split = await splitBySubmodule(workspaceRoot, clock, paths);
	if (split === null) return null;
	if (split.askable.length === 0) return new Set();
	const result = await runGit(clock, workspaceRoot, ["check-ignore", "--stdin", "-z"], {
		input: `${split.askable.join("\0")}\0`,
	});
	if (result === null) return null;
	// Exit 1 is git's word that none are ignored; anything else is git unable to say.
	if (result.code === 0) return new Set(result.stdout.split("\0").filter((line) => line.length > 0));
	return result.code === 1 ? new Set() : null;
}

/** Inputs used to derive workspace scope. */
export async function collectScopeEvidence(
	workspaceRoot: string,
	config: ScopeConfig,
	discovers: (module: string) => boolean,
	clock: Clock = systemClock,
	run: GitRunner = runGit,
	walkBound?: number,
	linkFs: LinkEvidenceFileSystem = linkEvidenceFileSystem,
): Promise<CollectedScopeEvidence> {
	const host = gitEvidenceHost(clock, run);
	const repositories = await collectGitEvidence(host, workspaceRoot, {
		reaches: (prefix) => includeReaches(prefix, config.include ?? []),
		discovers,
		...(walkBound === undefined ? {} : { walkBound }),
	});
	return collectScopeEvidenceFromRepositories(workspaceRoot, repositories, linkFs);
}

export async function refreshScopeEvidence(
	workspaceRoot: string,
	config: ScopeConfig,
	discovers: (module: string) => boolean,
	previous: CollectedScopeEvidence,
	options: { full: boolean; prefixes?: readonly string[]; linkModules?: readonly string[] },
	clock: Clock = systemClock,
	run: GitRunner = runGit,
	walkBound?: number,
	linkFs: LinkEvidenceFileSystem = linkEvidenceFileSystem,
): Promise<CollectedScopeEvidence> {
	const host = gitEvidenceHost(clock, run);
	const gitOptions = {
		reaches: (prefix: string) => includeReaches(prefix, config.include ?? []),
		discovers,
		...(walkBound === undefined ? {} : { walkBound }),
	};
	let repositories = [...previous.repositories];
	if (options.full) {
		repositories = await collectGitEvidence(host, workspaceRoot, gitOptions);
	} else {
		for (const prefix of options.prefixes ?? []) {
			const branch = await collectGitEvidenceAt(host, workspaceRoot, prefix, gitOptions);
			repositories =
				prefix === ""
					? []
					: repositories.filter(
							(repository) => repository.prefix !== prefix && !repository.prefix.startsWith(`${prefix}/`),
						);
			repositories.push(...branch);
		}
	}
	return collectScopeEvidenceFromRepositories(workspaceRoot, repositories, linkFs, options.linkModules);
}

export function collectScopeEvidenceFromRepositories(
	workspaceRoot: string,
	repositories: readonly GitRepository[],
	linkFs: LinkEvidenceFileSystem = linkEvidenceFileSystem,
	extraLinkModules: readonly string[] = [],
): CollectedScopeEvidence {
	const root = repositories.find((repository) => repository.prefix === "");
	const rootState = root?.state ?? "absent";
	const known = rootState === "ok" ? new Set<string>() : null;
	const tracked = new Set<string>();
	const ignoredSecrets = new Set<string>();
	const modules = new Set<string>();
	for (const repository of repositories) {
		if (repository.state !== "ok") continue;
		for (const module of repository.tracked) {
			if (owningRepository(module, repositories) !== repository) continue;
			tracked.add(module);
			known?.add(module);
			modules.add(module);
		}
		for (const module of repository.untracked) {
			if (owningRepository(module, repositories) !== repository) continue;
			known?.add(module);
			modules.add(module);
		}
		for (const module of repository.discovered) {
			if (owningRepository(module, repositories) !== repository) continue;
			ignoredSecrets.add(module);
			known?.add(module);
			modules.add(module);
		}
	}
	const tracking: GitTracking =
		rootState === "absent"
			? { kind: "noGit" }
			: rootState === "failed"
				? { kind: "failed" }
				: { kind: "tracked", files: tracked };
	const undiscovered = new Set(repositories.flatMap(({ undiscovered: folders }) => [...folders]));
	const directoryContents = directoryEntries(workspaceRoot);
	const relevantDirectories = new Set<string>([""]);
	for (const module of modules) {
		const segments = module.split("/");
		for (let length = 1; length < segments.length; length++)
			relevantDirectories.add(segments.slice(0, length).join("/"));
	}
	const entrySnapshot = new Map<string, readonly string[]>();
	for (const directory of relevantDirectories) entrySnapshot.set(directory, [...directoryContents(directory)]);
	const linkEvidence = collectLinkEvidence(workspaceRoot, repositories, linkFs, extraLinkModules);
	return {
		known,
		tracking,
		repositories,
		ignoredSecrets,
		undiscovered,
		modules,
		links: linkEvidence.links,
		aliasesByTarget: linkEvidence.aliasesByTarget,
		targets: linkEvidence.targets,
		directoryLinks: linkEvidence.directoryLinks,
		entries: entrySnapshot,
	};
}

function collectLinkEvidence(
	workspaceRoot: string,
	repositories: readonly GitRepository[],
	fs: LinkEvidenceFileSystem,
	extraModules: readonly string[] = [],
): {
	links: Map<string, LinkTarget>;
	aliasesByTarget: Map<string, string[]>;
	targets: Map<string, string>;
	directoryLinks: Map<string, string>;
} {
	let canonicalWorkspace: string;
	try {
		canonicalWorkspace = canonicalRoot(workspaceRoot);
	} catch {
		return { links: new Map(), aliasesByTarget: new Map(), targets: new Map(), directoryLinks: new Map() };
	}
	const candidates = new Set<string>();
	for (const repository of repositories) {
		if (repository.state !== "ok") continue;
		for (const module of repository.links) candidates.add(module);
		for (const module of repository.untracked) candidates.add(module);
		for (const module of repository.discovered) candidates.add(module);
		for (const module of repository.walkedLinks) candidates.add(module);
	}
	for (const module of extraModules) candidates.add(module);
	const links = new Map<string, LinkTarget>();
	const aliasesByTarget = new Map<string, string[]>();
	const targets = new Map<string, string>();
	const directoryLinks = new Map<string, string>();
	for (const module of candidates) {
		const file = workspaceFile(workspaceRoot, module);
		if (file === null || fs.lstat(file) !== "link") continue;
		const real = fs.realpath(file);
		if (real === null) {
			links.set(module, { kind: "dangling" });
			continue;
		}
		const relative = path.relative(canonicalWorkspace, real).split(path.sep).join("/");
		if (relative.length === 0 || relative.startsWith("../") || path.isAbsolute(relative)) {
			links.set(module, { kind: "outside" });
			continue;
		}
		let target: string;
		try {
			target = normalizeModulePath(relative);
		} catch {
			links.set(module, { kind: "outside" });
			continue;
		}
		const directory = fs.isDirectory(real);
		links.set(module, { kind: directory ? "directory" : "file", target });
		targets.set(module, target);
		aliasesByTarget.set(target, [...(aliasesByTarget.get(target) ?? []), module]);
		if (directory) directoryLinks.set(module, target);
	}
	for (const aliases of aliasesByTarget.values()) aliases.sort();
	const sorted = <T>(entries: Map<string, T>) =>
		new Map([...entries].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)));
	return {
		links: sorted(links),
		aliasesByTarget: sorted(aliasesByTarget),
		targets: sorted(targets),
		directoryLinks: sorted(directoryLinks),
	};
}

const linkEvidenceFileSystem: LinkEvidenceFileSystem = {
	lstat: (file) => {
		try {
			return lstatSync(file).isSymbolicLink() ? "link" : "other";
		} catch {
			return null;
		}
	},
	realpath: (file) => {
		try {
			return realpathSync.native(file);
		} catch {
			return null;
		}
	},
	isDirectory: (file) => {
		try {
			return statSync(file).isDirectory();
		} catch {
			return false;
		}
	},
};

function gitEvidenceHost(clock: Clock, run: GitRunner): GitEvidenceHost {
	return {
		git: (cwd, args) => run(clock, cwd, [...args]),
		fs: {
			readdir: (directory) => readdirSync(directory, { withFileTypes: true }),
			stat: (file) => {
				try {
					const stats = statSync(file);
					return { mtimeMs: stats.mtimeMs, size: stats.size, ino: stats.ino };
				} catch {
					return null;
				}
			},
			readText: (file) => {
				try {
					return readFileSync(file, "utf8");
				} catch {
					return null;
				}
			},
			realpath: (file) => realpathSync.native(file),
		},
		env: {
			HOME: process.env["HOME"],
			USERPROFILE: process.env["USERPROFILE"],
			XDG_CONFIG_HOME: process.env["XDG_CONFIG_HOME"],
		},
	};
}

function owningRepository(module: string, repositories: readonly GitRepository[]): GitRepository | null {
	let owner: GitRepository | null = null;
	for (const repository of repositories) {
		const matches =
			repository.prefix === "" || module === repository.prefix || module.startsWith(`${repository.prefix}/`);
		if (matches && (owner === null || repository.prefix.length > owner.prefix.length)) owner = repository;
	}
	if (owner === null) return null;
	for (const repository of repositories) {
		for (const nested of repository.nested) {
			if (module === nested || module.startsWith(`${nested}/`)) {
				const child = repositories.find((candidate) => candidate.prefix === nested);
				if (child === undefined) return null;
				if (child.prefix.length > owner.prefix.length) owner = child;
			}
		}
		for (const gitlink of repository.gitlinks)
			if (module === gitlink || module.startsWith(`${gitlink}/`)) return null;
	}
	return owner;
}

function includeReaches(prefix: string, includes: readonly string[]): boolean {
	return includes.some((glob) => {
		const matcher = globToRegExp(glob);
		if (matcher.test(prefix)) return true;
		const meta = glob.search(/[?*[{]/);
		const literal = (meta === -1 ? glob : glob.slice(0, meta)).replace(/\/$/, "");
		return (
			literal.length === 0 ||
			literal === prefix ||
			literal.startsWith(`${prefix}/`) ||
			prefix.startsWith(`${literal}/`)
		);
	});
}

/** What auto-discovery may index, derived without filesystem reads. */
export function scopeFor(view: EvidenceView, secretPolicy: SecretPolicySnapshot): FileScope {
	const config = view.config;
	const { known, ignoredSecrets, entries: entrySnapshot, repositories } = view.collected;
	const gitlinks = repositories.flatMap((repository) => [...repository.gitlinks]);
	const include = config.include ?? [];
	const exclude = config.exclude ?? [];
	const deny = denyGlobs(config);
	const bundles = config.bundles ?? [];
	const entries = (directory: string) => entrySnapshot.get(directory) ?? [];
	const matchers = include.map((glob) => globToRegExp(glob));
	const excluded = exclude.map((glob) => globToRegExp(glob));
	const denied = deny.map((glob) => globToRegExp(glob));
	const surfaces = bundles.map((glob) => globToRegExp(glob));
	const included = (module: string) => matchers.some((matcher) => matcher.test(module));
	const underGitlink = (module: string) => gitlinks.some((root) => module === root || module.startsWith(`${root}/`));
	const denies = (module: string) => {
		const answer = secretPolicy.answer(module);
		return underGitlink(module) || (answer.kind === "omit" && answer.by === "deny");
	};
	const withinExcludes = (module: string) =>
		!denies(module) && (!excluded.some((matcher) => matcher.test(module)) || included(module));
	const wholeSecrets = (module: string) => {
		if (!withinExcludes(module) || underExcludedDirectory(module, DEFAULT_EXCLUDED_DIRECTORIES, entries))
			return false;
		const answer = secretPolicy.answer(module);
		return answer.kind === "wholeRedact" || (answer.kind === "omit" && answer.by === "secret");
	};
	const allowed = (module: string) => withinExcludes(module);
	const surface = (module: string) => surfaces.some((matcher) => matcher.test(module));
	const cause = (module: string, folder = false): AdmissionCause => {
		const matches = (matcher: RegExp) => matcher.test(module) || (folder && matcher.test(`${module}/`));
		const answer = secretPolicy.answer(module);
		if (
			module.split("/").includes(".git") ||
			(answer.kind === "omit" && answer.by === "deny") ||
			(folder && denied.some(matches))
		)
			return "denied";
		if (underGitlink(module)) return "nestedProject";
		if (!included(module) && excluded.some(matches)) return "excluded";
		for (const repository of repositories)
			for (const nested of repository.nested)
				if (
					(module === nested || module.startsWith(`${nested}/`)) &&
					!repositories.some((candidate) => candidate.prefix === nested)
				)
					return "nestedProject";
		const owner = owningRepository(module, repositories);
		if (owner?.state === "ok") {
			if (owner.ignored.files.has(module)) return "ignored";
			for (const root of owner.ignored.folders)
				if (module === root || module.startsWith(`${root}/`)) return "ignored";
		}
		if (
			!included(module) &&
			underExcludedDirectory(folder ? `${module}/` : module, DEFAULT_EXCLUDED_DIRECTORIES, entries)
		)
			return "excluded";
		return "unlisted";
	};
	if (known === null) {
		return {
			mode: "walk",
			allows: allowed,
			admitsEvent: allowed,
			known: null,
			include,
			exclude,
			deny,
			denies,
			cause,
			bundles,
			surface,
		};
	}
	return {
		mode: "git",
		allows: (module) =>
			allowed(module) &&
			(known.has(module) || included(module) || ignoredSecrets.has(module) || wholeSecrets(module)),
		admitsEvent: (module) =>
			allowed(module) &&
			(included(module) || !underExcludedDirectory(module, DEFAULT_EXCLUDED_DIRECTORIES, entries)),
		known,
		include,
		exclude,
		deny,
		denies,
		cause,
		bundles,
		surface,
	};
}

/** Why git could not say whether a file is generated. */
export type GeneratedReason = "noGit" | "gitFailed";

/** Git's word on a file, three-valued: "could not tell" is never stored as "no". */
export type GeneratedVerdict = { status: "yes" } | { status: "no" } | { status: "unknown"; reason: GeneratedReason };

/**
 * Every module's generated verdict from the repository's Git attributes, in one git call.
 *
 * A path under a submodule answers not generated without asking: it belongs to a different
 * repository's rules, and `check-attr` refuses a pathspec that reaches into one.
 */
export async function generatedVerdicts(
	workspaceRoot: string,
	modules: Iterable<string>,
	clock: Clock = systemClock,
): Promise<Map<string, GeneratedVerdict>> {
	const paths = [...new Set(modules)];
	const verdicts = new Map<string, GeneratedVerdict>();
	if (paths.length === 0) return verdicts;
	if (!existsSync(path.join(workspaceRoot, ".git"))) {
		for (const module of paths) verdicts.set(module, { status: "unknown", reason: "noGit" });
		return verdicts;
	}
	const split = await splitBySubmodule(workspaceRoot, clock, paths);
	if (split === null) {
		for (const module of paths) verdicts.set(module, { status: "unknown", reason: "gitFailed" });
		return verdicts;
	}
	for (const module of split.underSubmodule) verdicts.set(module, { status: "no" });
	if (split.askable.length === 0) return verdicts;
	const result = await runGit(clock, workspaceRoot, ["check-attr", "--stdin", "-z", "linguist-generated"], {
		input: `${split.askable.join("\0")}\0`,
	});
	if (result === null || result.code !== 0) {
		for (const module of split.askable) verdicts.set(module, { status: "unknown", reason: "gitFailed" });
		return verdicts;
	}
	const fields = result.stdout.split("\0");
	const generated = new Set<string>();
	for (let index = 0; index + 2 < fields.length; index += 3) {
		const module = fields[index];
		const value = fields[index + 2];
		// Linguist reads `=false` as not generated, so it is one more way of saying no.
		if (
			module !== undefined &&
			value !== undefined &&
			value !== "unspecified" &&
			value !== "unset" &&
			value !== "false"
		)
			generated.add(module);
	}
	for (const module of split.askable)
		verdicts.set(module, generated.has(module) ? { status: "yes" } : { status: "no" });
	return verdicts;
}

/**
 * Files matching an explicit include, found by walking rather than by asking discovery.
 *
 * Permitting an ignored path is not enough to index it. A provider's own discovery decides what
 * exists, and a TypeScript one reads its tsconfig, which is exactly the file list that omits the
 * build output somebody is trying to point at. So an include ADDS candidates as well as allowing
 * them, or naming a path would not be a way of naming it.
 *
 * Walks only where a glob could match, so an include of `dist/**` never descends into anything else.
 */
export function includedFiles(workspaceRoot: string, globs: string[]): string[] {
	if (globs.length === 0) return [];
	const matchers = globs.map((glob) => globToRegExp(glob));
	const found: string[] = [];

	const walk = (relative: string, depth: number) => {
		if (depth > MAX_INCLUDE_DEPTH) return;
		let entries: Dirent[];
		try {
			entries = readdirSync(path.join(workspaceRoot, relative), { withFileTypes: true });
		} catch {
			return;
		}

		for (const entry of entries) {
			const child = relative === "" ? entry.name : `${relative}/${entry.name}`;
			if (entry.isDirectory()) {
				// Descend only where a glob could still match, so one include never walks the world.
				if (matchers.some((matcher) => matcher.test(child) || couldReach(matcher, child)))
					walk(child, depth + 1);
				continue;
			}
			if (matchers.some((matcher) => matcher.test(child))) found.push(child);
		}
	};

	walk("", 0);
	return found;
}

/** Whether a directory could still lead to a match, so the walk prunes instead of exploring. */
function couldReach(matcher: RegExp, directory: string): boolean {
	return matcher.test(`${directory}/x`) || matcher.test(`${directory}/x/y`);
}

/** One line a caller can print, so "350 files" and "136,000 files" are never confused for each other. */
export function describeScope(scope: FileScope): string {
	if (scope.mode === "walk") return "no git repository; walked the tree with the default ignore list";
	const included = scope.include.length > 0 ? `, plus ${scope.include.length} explicit include(s)` : "";
	const denied = scope.deny.length > 0 ? `, ${scope.deny.length} deny pattern(s)` : "";
	return `${scope.known?.size ?? 0} files${included}${denied}`;
}
