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

import { execFileSync } from "node:child_process";
import { type Dirent, existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

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

////////////////////////////////
//  Functions & Helpers

/**
 * Turn one glob into a matcher.
 *
 * `**` crosses directory separators and `*` does not, which is the distinction that makes
 * `src/*.ts` and `src/**\/*.ts` mean different things. Everything else is escaped, so a dot in a
 * pattern matches a dot rather than any character.
 */
export function globToRegExp(glob: string): RegExp {
	let out = "";
	for (let i = 0; i < glob.length; i++) {
		const char = glob[i] as string;

		// The separator next to a ** is part of it. `dist/**` has to match `dist` itself, or naming
		// a directory would fail to name the directory, and `a/**/b` has to match `a/b` with nothing
		// in between.
		if (char === "/" && glob[i + 1] === "*" && glob[i + 2] === "*") {
			if (glob[i + 3] === "/") {
				out += "/(?:.*/)?";
				i += 3;
				continue;
			}
			out += "(?:/.*)?";
			i += 2;
			continue;
		}

		if (char === "*") {
			if (glob[i + 1] === "*") {
				out += glob[i + 2] === "/" ? "(?:.*/)?" : ".*";
				i += glob[i + 2] === "/" ? 2 : 1;
				continue;
			}
			out += "[^/]*";
			continue;
		}
		out += char.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
	}
	return new RegExp(`^${out}$`);
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
export function gitFiles(workspaceRoot: string): Set<string> | null {
	if (!existsSync(path.join(workspaceRoot, ".git"))) return null;
	try {
		const stdout = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
			cwd: workspaceRoot,
			maxBuffer: 128 * 1024 * 1024,
			encoding: "utf8",
		});
		return new Set(stdout.split("\0").filter((line) => line.length > 0));
	} catch {
		return null;
	}
}

/** What auto-discovery is allowed to index, and how that was decided. */
export function fileScopeFor(workspaceRoot: string, config = readScopeConfig(workspaceRoot)): FileScope {
	const known = gitFiles(workspaceRoot);
	const include = config.include ?? [];
	const exclude = config.exclude ?? [];
	const deny = config.deny ?? [];
	const bundles = config.bundles ?? [];
	const matchers = include.map(globToRegExp);
	const excluded = exclude.map(globToRegExp);
	const denied = deny.map(globToRegExp);
	const surfaces = bundles.map(globToRegExp);
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

/** Files marked generated by the repository's Git attributes. */
export function generatedFiles(workspaceRoot: string, modules: Iterable<string>): Set<string> {
	if (!existsSync(path.join(workspaceRoot, ".git"))) return new Set();
	const paths = [...new Set(modules)];
	if (paths.length === 0) return new Set();
	try {
		const stdout = execFileSync("git", ["check-attr", "--stdin", "-z", "linguist-generated"], {
			cwd: workspaceRoot,
			input: `${paths.join("\0")}\0`,
			maxBuffer: 128 * 1024 * 1024,
			encoding: "utf8",
		});
		const fields = stdout.split("\0");
		const generated = new Set<string>();
		for (let index = 0; index + 2 < fields.length; index += 3) {
			const module = fields[index];
			const value = fields[index + 2];
			if (module !== undefined && value !== undefined && value !== "unspecified" && value !== "unset")
				generated.add(module);
		}
		return generated;
	} catch {
		return new Set();
	}
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
	const matchers = globs.map(globToRegExp);
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
	return `${scope.known?.size ?? 0} files git tracks or does not ignore${included}${denied}`;
}
