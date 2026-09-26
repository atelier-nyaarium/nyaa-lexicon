// Which files are this project's, as opposed to merely present on the disk under it.
//
// Measured on one real repository: git saw 350 files where the tree held 136,333, because a
// devcontainer mounts a whole home directory inside it. Without a floor here, a provider that walks
// the tree indexes somebody else's plugins and reports it as a fact about your code. The same
// absence is what would let a secrets file in, since the only thing standing in the way was a
// hardcoded list of six directory names.
//
// THE RULE: ignore governs DISCOVERY, not REACHABILITY. Auto-discovery never walks into ignored
// territory. An explicitly named path is indexed unless denied. And anything an indexed file imports is
// followed, even into ignored territory, because a generated file you import is part of your
// program while a `.env` nobody imports never becomes reachable.

import type { ChildProcess } from "node:child_process";
import { type Dirent, existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
	type BoundedTimer,
	globToRegExp,
	normalizeModulePath,
	runBounded,
	workspaceFile,
} from "@nyaa-lexicon/protocol";
import { type Clock, systemClock, type TimerHandle } from "./clock.js";

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
}

export interface FileScope {
	/** `git` when git answered, `walk` when there is none. A caller states which it got. */
	mode: "git" | "walk";
	/** Whether auto-discovery may index this module. Closure bypasses it deliberately. */
	allows: (module: string) => boolean;
	/** Files git knows about, absent in walk mode. */
	known: Set<string> | null;
	include: string[];
	exclude: string[];
	deny: string[];
	/** Whether this module is forbidden from roots and import closure. */
	denies: (module: string) => boolean;
	bundles: string[];
	/** Whether this module must use surface indexing even when it is explicitly included. */
	surface: (module: string) => boolean;
}

////////////////////////////////
//  Constants

/** Read from the workspace root when present. Absent is the normal case. */
export const CONFIG_FILE = "lexicon.json";

/** Stops an include glob from walking a deep tree forever. Deeper than any real source layout. */
const MAX_INCLUDE_DEPTH = 12;

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
}

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
		timeoutMs: GIT_TIMEOUT_MS,
		timer: clockTimer(clock),
		onSpawn: options.onSpawn,
	});
	return result.kind === "exited" ? { code: result.code, stdout: result.stdout.toString("utf8") } : null;
}

/** Explicit includes and excludes from `lexicon.json`, or none. */
export function readScopeConfig(workspaceRoot: string): ScopeConfig {
	const file = path.join(workspaceRoot, CONFIG_FILE);
	if (!existsSync(file)) return {};
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8")) as {
			include?: unknown;
			exclude?: unknown;
			deny?: unknown;
			bundles?: unknown;
		};
		const paths = (value: unknown): string[] =>
			Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
		return {
			include: paths(parsed.include),
			exclude: paths(parsed.exclude),
			deny: paths(parsed.deny),
			bundles: paths(parsed.bundles),
		};
	} catch {
		return {};
	}
}

/**
 * The files git considers part of the project: tracked, plus untracked ones it does not ignore.
 *
 * Asked of git rather than reimplemented. A gitignore has negation patterns, nested files and `**`
 * semantics that are genuinely easy to get subtly wrong, and git is already the authority.
 *
 * Null when this is not a git repository, which is a different answer from an empty project.
 */
export async function gitFiles(workspaceRoot: string, clock: Clock = systemClock): Promise<Set<string> | null> {
	if (!existsSync(path.join(workspaceRoot, ".git"))) return null;
	const result = await runGit(clock, workspaceRoot, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
	if (result === null || result.code !== 0) return null;
	// The id grammar's key, or out of scope: a name it cannot spell would index under one key and
	// be asked about under another.
	return new Set(
		result.stdout.split("\0").flatMap((line) => {
			if (line.length === 0) return [];
			try {
				return [normalizeModulePath(line)];
			} catch {
				return [];
			}
		}),
	);
}

/**
 * This repository's submodule roots, workspace-relative.
 *
 * Read from each gitlink's own stage entry (mode `160000`) in `git ls-files --stage`, the same
 * authority `gitFiles` already asks, rather than parsing `.gitmodules`: a registration there can
 * lag or outlive the actual index, and the mode is exactly what `check-ignore` and `check-attr`
 * refuse to cross. Null when git cannot say.
 */
export async function submoduleRoots(workspaceRoot: string, clock: Clock = systemClock): Promise<Set<string> | null> {
	if (!existsSync(path.join(workspaceRoot, ".git"))) return null;
	const result = await runGit(clock, workspaceRoot, ["ls-files", "--stage", "-z"]);
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

/** What auto-discovery is allowed to index, and how that was decided. */
export async function fileScopeFor(
	workspaceRoot: string,
	config = readScopeConfig(workspaceRoot),
	clock: Clock = systemClock,
): Promise<FileScope> {
	const known = await gitFiles(workspaceRoot, clock);
	const include = config.include ?? [];
	const exclude = config.exclude ?? [];
	const deny = config.deny ?? [];
	const bundles = config.bundles ?? [];
	const matchers = include.map((glob) => globToRegExp(glob));
	const excluded = exclude.map((glob) => globToRegExp(glob));
	const denied = deny.map((glob) => globToRegExp(glob));
	const surfaces = bundles.map((glob) => globToRegExp(glob));
	const included = (module: string) => matchers.some((matcher) => matcher.test(module));
	const denies = (module: string) => denied.some((matcher) => matcher.test(module));
	const allowed = (module: string) =>
		!denies(module) && (!excluded.some((matcher) => matcher.test(module)) || included(module));
	const surface = (module: string) => surfaces.some((matcher) => matcher.test(module));

	// Walk mode has no git root set and leans on the watcher's weaker ignore list.
	if (known === null) {
		return { mode: "walk", allows: allowed, known: null, include, exclude, deny, denies, bundles, surface };
	}
	return {
		mode: "git",
		allows: (module) => allowed(module) && (known.has(module) || included(module)),
		known,
		include,
		exclude,
		deny,
		denies,
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
