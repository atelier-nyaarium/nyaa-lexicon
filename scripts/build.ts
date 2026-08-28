// The single release ritual: bump the version, bundle dist/, commit both together.
//
//   bun run build patch|minor|major       # bump, build, commit
//   bun run build --build-only            # bundle at the current version; no bump, no commit
//
// dist/ is COMMITTED because the MCP server runs as `bun dist/main.js` from a plugin copy that
// no host installs dependencies into: Claude Code runs `bun install` in an installed plugin,
// Copilot copies the repository and runs nothing, and the bundle needs neither.
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

import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { codeOnly } from "../protocol/src/residue.js";
import { PROTOCOL_VERSION } from "../protocol/src/version.js";

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
 * Both are bundled for the same reason: a consumer runs them with no install. The conformance CLI
 * counts because a provider team may be a .NET or Python team, and requiring our toolchain to
 * prove their provider would defeat the suite's independence.
 *
 * Built one at a time with an explicit outfile. Passing both to one `bun build` mirrors the source
 * tree into dist/, so `bun dist/main.js` would become `bun dist/adapters/mcp/src/main.js`.
 */
const ENTRYPOINTS = [
	{ source: path.join("adapters", "mcp", "src", "main.ts"), out: "main.js" },
	{ source: path.join("protocol", "src", "conformance", "cli.ts"), out: "conformance.js" },
	{ source: path.join("core", "src", "indexCli.ts"), out: "index-workspace.js" },
	{ source: path.join("core", "src", "gradeCli.ts"), out: "grade.js" },
	{ source: path.join("core", "src", "daemonCli.ts"), out: "daemon.js" },
	{ source: path.join("adapters", "lsp", "src", "main.ts"), out: "lsp.js" },
];
const DIST_DIR = "dist";

/** What the install says about itself, so a client learns what a checkout is without running it. */
const VERSION_FILE = "version.json";

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

/** Names a smoke failure, so the catch can tell one from a bun error bun already printed. */
const SMOKE_FAILURE = "failed to start";

/**
 * The AMD branch of a UMD wrapper, which survives minification because `define.amd` cannot be renamed.
 *
 * Both operand orders and either quote: a minifier writes `"function"==typeof define`, rollup writes
 * single quotes, and `node_modules` holds all four spellings. Widening this needs all four rechecked.
 */
const UMD_WRAPPER_RE =
	/(?:typeof\s+define\s*={2,3}\s*["']function["']|["']function["']\s*={2,3}\s*typeof\s+define)\s*&&\s*define\.amd/;

/**
 * No bundle may carry a UMD wrapper.
 *
 * A wrapper surviving means bun inlined a UMD file rather than resolving the module, so the inner
 * requires are still there: the bundler cannot see them, the runtime runs them, and they resolve against `dist/`
 * where nothing lives. The bundle is clean and dies on launch. Import the package's ESM entry.
 *
 * Static, for two reasons. Minification renames the factory's `require` parameter, so the calls
 * themselves are no longer greppable. And it holds for an entrypoint whose healthy exit is a usage
 * message and a nonzero status, which is every CLI here and none of what `smokeProviders` covers.
 */
function checkBundlesAreSelfContained(root: string): number {
	const bundles: string[] = [];
	function visit(directory: string): void {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const absolute = path.join(directory, entry.name);
			if (entry.isDirectory()) visit(absolute);
			else if (entry.name.endsWith(".js")) bundles.push(absolute);
		}
	}
	visit(path.join(root, DIST_DIR));

	for (const bundle of bundles)
		if (UMD_WRAPPER_RE.test(readFileSync(bundle, "utf8")))
			throw new Error(
				`${path.relative(root, bundle)} ${SMOKE_FAILURE}: it carries a UMD wrapper, whose inner requires resolve against dist/`,
			);

	// A sweep matching nothing reports clean, so the count is asserted rather than the silence.
	if (bundles.length === 0) throw new Error("no bundles found to check; the sweep would report clean over nothing");
	return bundles.length;
}

/**
 * Every bundled provider must actually START on the shipping runtime.
 *
 * Bundling succeeding proves only that the imports resolved. A dependency carrying a native addon,
 * or one reaching for something node lacks, bundles clean and then dies on launch, which
 * `startProviders` records as an outage and skips. The index then reports files in scope and no
 * facts, which reads exactly like a language with nothing in it.
 *
 * Scope is startup only. Whether a provider ANSWERS correctly is what conformance asks, so a
 * failure deferred until the first parseFile is deliberately out of reach here.
 */
function smokeProviders(root: string, providers: Array<{ out: string }>): void {
	for (const entry of providers) {
		const bundle = path.join(root, DIST_DIR, entry.out);
		// The bun running this script is the owner's own first answer; tsc's rootDir keeps the client
		// source out of scripts/, so the owner is not imported here.
		// Closed stdin is a clean shutdown, so a healthy provider loads, starts and exits zero.
		// Import-time death exits nonzero with its reason on stderr, which is the failure hunted here.
		const probe = spawnSync(process.execPath, [bundle], {
			cwd: root,
			input: "",
			encoding: "utf8",
			timeout: 20_000,
		});
		const complaint = (probe.stderr ?? "").trim();
		if (probe.status !== 0 || complaint !== "") {
			// The runtime's own message line, not the echoed source: a minified frame is thousands of columns.
			const lines = complaint.split("\n").map((line) => line.trim());
			const reason = lines.find((line) => /^[A-Za-z]*Error:/.test(line)) ?? lines[0] ?? "";
			const detail = reason.slice(0, 200) || `exit ${probe.status}`;
			throw new Error(`${entry.out} ${SMOKE_FAILURE}: ${detail}`);
		}
		console.log(`smoke ok ${entry.out}`);
	}
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
		file: path.join("adapters", "mcp", "src", "serve.ts"),
		needle: "version: packageJson.version",
		what: "the MCP server's declared version",
	},
	{
		file: path.join("core", "src", "version.ts"),
		needle: "packageJson.version",
		what: "the build version a daemon stamps into its lock",
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
function protocolMajorOf(text: string): string {
	const found = /^export const PROTOCOL_VERSION\s*=\s*"(\d+)\.\d+\.\d+"/m.exec(text);
	if (!found) throw new Error("protocol/src/version.ts no longer states PROTOCOL_VERSION as a plain version");
	return found[1] as string;
}

/**
 * A moved PROTOCOL_VERSION costs a major.
 *
 * Not the reverse: an extraction-correction major retires facts without touching the wire, and
 * demanding a protocol bump there teaches the author to route around this check.
 */
export function checkProtocolRelease(root: string, kind: BumpKind, headVersionSource: string): void {
	const now = protocolMajorOf(readFileSync(path.join(root, "protocol", "src", "version.ts"), "utf8"));
	const before = protocolMajorOf(headVersionSource);
	if (now === before || kind === "major") return;
	throw new Error(
		`PROTOCOL_VERSION moved from major ${before} to ${now}, which breaks the wire, but this is a ${kind} release.\n` +
			`Ship it as a major, or restore the protocol version.`,
	);
}

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

/** The conformance CLI serves provider teams on their own runtime, so it alone stays unguarded. */
const UNGUARDED_ENTRYPOINT = "conformance.js";

/** Every entry point judges its runtime by name before anything else; the build is where the set is known. */
export function checkEntryGuards(root: string): void {
	for (const entry of ENTRYPOINTS) {
		if (entry.out === UNGUARDED_ENTRYPOINT) continue;
		if (codeOnly(readFileSync(path.join(root, entry.source), "utf8")).includes("refuseRuntime(")) continue;
		throw new Error(
			`${entry.source} does not call refuseRuntime, so dist/${entry.out} would die on a builtin instead of naming the runtime it needs.`,
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
	checkEntryGuards(ROOT);

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

		// After the clean-tree gate, so an uncommitted protocol file reads as "commit your work"
		// rather than as a git error from reading HEAD.
		let atHead: string;
		try {
			atHead = git(["show", "HEAD:protocol/src/version.ts"], ROOT);
		} catch {
			console.error("Could not read protocol/src/version.ts at HEAD, so the wire check cannot run.");
			console.error("Commit the protocol package first, or build with --build-only.");
			process.exit(1);
		}
		checkProtocolRelease(ROOT, kind as BumpKind, atHead);
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

	// Package tsc output goes to `.tsbuild`, so a `dist` beside a package.json is always a fossil and
	// nothing here writes one. Walks `targets` rather than a list, so a new package is swept too.
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
		writeFileSync(
			path.join(ROOT, DIST_DIR, VERSION_FILE),
			`${JSON.stringify({ buildVersion: version, protocolVersion: PROTOCOL_VERSION }, null, "\t")}\n`,
		);
		console.log(`wrote ${DIST_DIR}/${VERSION_FILE}: ${version}, protocol ${PROTOCOL_VERSION}`);
		console.log(`self-contained: ${checkBundlesAreSelfContained(ROOT)} bundles`);
		smokeProviders(ROOT, providers);
	} catch (failure) {
		// bun prints its own compiler errors; only a smoke failure needs this script to speak.
		const said = failure instanceof Error ? failure.message : "";
		if (said.includes(SMOKE_FAILURE)) console.error(`\n${said}`);
		if (!buildOnly) {
			// dist/ is committed, so a half-written bundle left beside reverted versions is a lie
			// on disk that a later commit could pick up.
			git(["checkout", "--", ...targets, DIST_DIR], ROOT);
			console.error(`\nbuild failed; reverted ${targets.length} version file(s) and ${DIST_DIR}/ to ${current}`);
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
