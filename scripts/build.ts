// The single release ritual: bump the version, bundle dist/, commit both together.
//
//   bun run build patch|minor|major       # bump, build, commit
//   bun run build --build-only            # bundle at the current version; no bump, no commit
//
// dist/ is COMMITTED because the MCP server runs as `node dist/main.js`. Windows is the reason
// this exists at all: bun is not reliable enough there to require it of a consumer, so the
// shipped artifact must run on plain node with no install step and no toolchain.
//
// That only holds while the committed bundle matches the committed version, which is why bumping
// and building are one command rather than two. A dist/ built at a version the manifests do not
// claim looks correct and is not.
//
// The root package.json is the source of truth. It is the one file that gets BUMPED; every
// workspace package is SET to whatever it now says, so they cannot drift apart or be bumped by
// different amounts. Set the root by hand first if you want a version this arithmetic would not
// produce.
//
// Sites that DERIVE the version at build time are verified here rather than written. A literal
// version in the server reads as correct right up until the next bump ships a server lying about
// what it is, so replacing a derivation fails this script instead.

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

////////////////////////////////
//  Interfaces & Types

export type BumpKind = "patch" | "minor" | "major";

/** A site that recomputes the version at build time, named by a string that must still appear. */
interface DerivedSite {
	file: string;
	needle: string;
	what: string;
}

////////////////////////////////
//  Constants

const ROOT = path.join(import.meta.dirname, "..");
const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)$/;
const VERSION_FIELD_RE = /"version"\s*:\s*"[^"]*"/g;

/**
 * Both are bundled for the same reason: a consumer runs them on plain node with no bun and no
 * install. The conformance CLI counts because a provider team may be a .NET or Python team, and
 * requiring our toolchain to prove their provider would defeat the suite's independence.
 *
 * Built one at a time with an explicit outfile. Passing both to one `bun build` mirrors the source
 * tree into dist/, so `node dist/main.js` would become `node dist/adapters/mcp/src/main.js`.
 */
const ENTRYPOINTS = [
	{ source: path.join("adapters", "mcp", "src", "main.ts"), out: "main.js" },
	{ source: path.join("protocol", "src", "conformance", "cli.ts"), out: "conformance.js" },
	// Also the only way to run the indexer at all: bun has no `node:sqlite`, so anything touching
	// the store runs on node, bundled.
	{ source: path.join("core", "src", "indexCli.ts"), out: "index-workspace.js" },
	{ source: path.join("core", "src", "gradeCli.ts"), out: "grade.js" },
	{ source: path.join("core", "src", "daemonCli.ts"), out: "daemon.js" },
	{ source: path.join("adapters", "lsp", "src", "main.ts"), out: "lsp.js" },
];
const DIST_DIR = "dist";

/**
 * Providers are bundled too, and for the same reason the server is.
 *
 * Unbundled, they ran as TypeScript source importing `@nyaa-lexicon/protocol` and `typescript`, so
 * they needed a `node_modules` beside them. A host that installs one worked and a host that does
 * not got three providers that started, failed their first import, timed out, and left an index
 * that reported files in scope and zero symbols.
 *
 * Discovered rather than listed, matching how the runtime finds them.
 */
function providerBundles(root: string): Array<{ source: string; out: string; assets: string }> {
	const directory = path.join(root, "providers");
	if (!existsSync(directory)) return [];

	return readdirSync(directory, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && existsSync(path.join(directory, entry.name, "src", "main.ts")))
		.map((entry) => ({
			source: path.join("providers", entry.name, "src", "main.ts"),
			out: path.join("providers", entry.name, "main.js"),
			assets: path.join("providers", entry.name, "src"),
		}));
}

/** Non-TypeScript files a provider reads at runtime, resolved next to its own bundle. */
function copyProviderAssets(root: string, from: string, into: string): string[] {
	const source = path.join(root, from);
	if (!existsSync(source)) return [];

	const copied: string[] = [];
	mkdirSync(path.join(root, into), { recursive: true });
	for (const entry of readdirSync(source, { withFileTypes: true })) {
		if (!entry.isFile() || entry.name.endsWith(".ts")) continue;
		copyFileSync(path.join(source, entry.name), path.join(root, into, entry.name));
		copied.push(path.join(into, entry.name));
	}
	return copied;
}

/** What the marketplace reads. Its version must match package.json or an install goes stale. */
const PLUGIN_MANIFEST = path.join(".claude-plugin", "plugin.json");

const DERIVED_SITES: DerivedSite[] = [
	{
		file: path.join("adapters", "mcp", "src", "main.ts"),
		needle: "version: packageJson.version",
		what: "the MCP server's declared version",
	},
];

////////////////////////////////
//  Functions & Helpers

export function nextVersion(current: string, kind: BumpKind): string {
	const parts = SEMVER_RE.exec(current);
	if (!parts) throw new Error(`${current} is not a plain major.minor.patch version`);
	const [major, minor, patch] = parts.slice(1, 4).map(Number) as [number, number, number];
	if (kind === "major") return `${major + 1}.0.0`;
	if (kind === "minor") return `${major}.${minor + 1}.0`;
	return `${major}.${minor}.${patch + 1}`;
}

/**
 * Rewrite a file's `"version"` field in place, leaving every other byte alone.
 *
 * Textual rather than parse-and-restringify: these files are hand-formatted, and reformatting all
 * of them on every bump would bury the one line that actually changed. Exactly one occurrence is
 * required, because a file with two version fields is one this cannot edit unambiguously, and
 * picking the first would be wrong in a way nobody notices until a release.
 */
export function setVersion(text: string, version: string): string {
	const found = text.match(VERSION_FIELD_RE) ?? [];
	if (found.length !== 1) throw new Error(`expected exactly one "version" field, found ${found.length}`);
	return text.replace(VERSION_FIELD_RE, `"version": "${version}"`);
}

export function readVersion(text: string): string {
	const found = text.match(VERSION_FIELD_RE) ?? [];
	if (found.length !== 1) throw new Error(`expected exactly one "version" field, found ${found.length}`);
	const value = found[0]?.split('"')[3];
	if (value === undefined) throw new Error("could not read the version value");
	return value;
}

/**
 * Expand one `workspaces` entry to the package.json files it covers.
 *
 * A literal entry MUST resolve: it names a package that is supposed to exist, so a miss means this
 * script's view of the repo is stale and the bump would silently skip a package. A trailing-star
 * entry is allowed to match nothing, since `providers/*` is legitimately empty until the first
 * provider lands.
 */
export function expandWorkspaceEntry(root: string, entry: string): string[] {
	if (!entry.endsWith("/*")) {
		const file = path.join(entry, "package.json");
		if (!existsSync(path.join(root, file))) {
			throw new Error(`workspace "${entry}" has no package.json; this script's target list is out of date`);
		}
		return [file];
	}

	const dir = entry.slice(0, -2);
	if (!existsSync(path.join(root, dir))) {
		throw new Error(`workspace directory "${dir}" is gone; this script's target list is out of date`);
	}
	return readdirSync(path.join(root, dir), { withFileTypes: true })
		.filter((e) => e.isDirectory())
		.map((e) => path.join(dir, e.name, "package.json"))
		.filter((file) => existsSync(path.join(root, file)))
		.sort();
}

/**
 * Every file this script writes: the root first (it is the one being bumped), then each package,
 * then the plugin manifest.
 *
 * The manifest is REQUIRED rather than optional. It is what the marketplace reads to decide whether
 * an installed copy is out of date, so a missing one means the plugin never updates, and a stale one
 * means it updates to a version whose bundle it does not have.
 */
export function versionTargets(root: string): string[] {
	const rootManifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
		workspaces?: string[];
	};
	const workspaces = rootManifest.workspaces;
	if (!workspaces || workspaces.length === 0) {
		throw new Error("root package.json declares no workspaces; this script assumes a monorepo");
	}
	if (!existsSync(path.join(root, PLUGIN_MANIFEST))) {
		throw new Error(`${PLUGIN_MANIFEST} is gone; the marketplace reads it to decide what version is installed`);
	}
	return ["package.json", ...workspaces.flatMap((entry) => expandWorkspaceEntry(root, entry)), PLUGIN_MANIFEST];
}

/** Throws unless every derived site still recomputes the version from package.json. */
export function checkDerivedSites(root: string): void {
	for (const site of DERIVED_SITES) {
		const text = readFileSync(path.join(root, site.file), "utf8");
		if (text.includes(site.needle)) continue;
		throw new Error(
			`${site.file} no longer derives ${site.what} from package.json (looked for ${site.needle}).\n` +
				`Either restore the derivation or add the file to this script's target list.`,
		);
	}
}

/** Space-separated fields ahead of the path, per porcelain v2 record type. */
const PATH_FIELD_OFFSET: Record<string, number> = { "1": 8, "2": 9, u: 10 };

function isDistPath(file: string): boolean {
	return file.split("/").includes(DIST_DIR);
}

/**
 * Tracked-but-uncommitted work in the tree, by porcelain v2 record type: `1` ordinary change, `2`
 * rename or copy, `u` unmerged. Untracked (`?`), ignored (`!`), and generated `dist` files are not
 * counted because the build removes and recreates them.
 *
 * This gates the bump so the rollback on a failed build can be a plain `git checkout --`: the only
 * changes to those files are the ones this script just made.
 *
 * Paths are cut by field offset rather than by splitting the whole line, because a path may
 * contain spaces. A rename record trails `<path>\t<origPath>`; the new path is the half that
 * matters here.
 */
export function dirtyTrackedFiles(porcelainV2: string): string[] {
	const dirty: string[] = [];
	for (const line of porcelainV2.split("\n")) {
		const offset = PATH_FIELD_OFFSET[line[0] ?? ""];
		if (offset === undefined || line[1] !== " ") continue;
		let cut = 0;
		for (let seen = 0; seen < offset; seen++) {
			const next = line.indexOf(" ", cut);
			if (next === -1) {
				cut = -1;
				break;
			}
			cut = next + 1;
		}
		if (cut === -1) continue;
		const file = (line.slice(cut).split("\t")[0] ?? "").trim();
		if (file && !isDistPath(file)) dirty.push(file);
	}
	return dirty;
}

function git(args: string[], root: string): string {
	return execFileSync("git", args, { cwd: root, encoding: "utf8" });
}

////////////////////////////////
//  Main

function main(argv: string[]): void {
	const buildOnly = argv.includes("--build-only");
	const kind = argv.find((arg) => !arg.startsWith("-"));

	if (!buildOnly && kind !== "patch" && kind !== "minor" && kind !== "major") {
		console.error("usage: bun run build patch|minor|major");
		console.error("       bun run build --build-only");
		process.exit(2);
	}

	// Before writing anything: a broken derivation means the bump would be incomplete, and half a
	// bump is worse than none (the manifests move, the running server reports the old version).
	checkDerivedSites(ROOT);

	// A clean tree is what makes the rollback below safe. --build-only writes no tracked file, so
	// it has nothing to roll back and no reason to care.
	if (!buildOnly) {
		const dirty = dirtyTrackedFiles(git(["status", "--porcelain=v2", "--branch"], ROOT));
		if (dirty.length > 0) {
			console.error("Commit your work before building. Uncommitted changes to tracked files:");
			for (const file of dirty) console.error(`  ${file}`);
			console.error("\n(untracked files are fine; --build-only skips this check)");
			process.exit(1);
		}
	}

	const targets = versionTargets(ROOT);
	const current = readVersion(readFileSync(path.join(ROOT, targets[0] as string), "utf8"));
	const version = buildOnly ? current : nextVersion(current, kind as BumpKind);

	if (!buildOnly) {
		for (const target of targets) {
			const file = path.join(ROOT, target);
			const text = readFileSync(file, "utf8");
			const was = readVersion(text);
			writeFileSync(file, setVersion(text, version));
			console.log(`set ${target}: ${was} -> ${version}`);
		}
	}
	for (const site of DERIVED_SITES) console.log(`derives ${site.what} from package.json: ${site.file}`);

	// Stale output from a previous run must not survive into the commit.
	rmSync(path.join(ROOT, DIST_DIR), { recursive: true, force: true });

	// Every workspace package's own tsc output goes to `.tsbuild`, never `dist`, so a `dist` beside a
	// package.json is always a fossil: nothing here writes one. Four were once committed by accident
	// and outlived every release since, because nothing ever looked in the package directories. Swept
	// by walking `targets` rather than a hardcoded list, so a package added later is covered too.
	for (const target of targets)
		rmSync(path.join(ROOT, path.dirname(target), DIST_DIR), { recursive: true, force: true });

	const providers = providerBundles(ROOT);
	if (providers.length === 0) throw new Error("no providers found to bundle; the shipped index would find nothing");

	try {
		for (const entry of [...ENTRYPOINTS, ...providers]) {
			const outfile = path.join(DIST_DIR, entry.out);
			execFileSync(
				"bun",
				["build", entry.source, "--outfile", outfile, "--target", "node", "--minify", "--format", "esm"],
				{ cwd: ROOT, stdio: "inherit" },
			);
		}
		for (const entry of providers) {
			const assets = copyProviderAssets(ROOT, entry.assets, path.join(DIST_DIR, path.dirname(entry.out)));
			for (const asset of assets) console.log(`copied ${asset}`);
		}
	} catch {
		// bun already printed the compiler error; a stack trace from this script would only bury it.
		if (!buildOnly) {
			git(["checkout", "--", ...targets], ROOT);
			console.error(`\nbuild failed; reverted ${targets.length} version file(s) to ${current}`);
		} else {
			console.error("\nbuild failed");
		}
		process.exit(1);
	}

	if (buildOnly) {
		console.log(`\nbuilt ${DIST_DIR}/ at ${version}. Nothing bumped, nothing committed.`);
		return;
	}

	git(["add", "--", ...targets, DIST_DIR], ROOT);
	git(["commit", "-m", `Build ${version}`], ROOT);
	console.log(`\n${current} -> ${version}, committed as "Build ${version}". Push to ship.`);
}

if (path.basename(process.argv[1] ?? "") === "build.ts") main(process.argv.slice(2));
