// The single release ritual: bump the version, bundle dist/, commit both together.
//
//   bun run build patch|minor|major       # bump, build, commit
//   bun run build --build-only            # bundle at the current version; no bump, no commit
//
// dist/ is committed because the MCP server runs from a plugin copy with no host install step.
// The bundle must match the version claimed by every manifest.

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { runBounded } from "../protocol/src/boundedChild.js";
import { OLDEST_CLIENT_MAJOR, PROTOCOL_VERSION } from "../protocol/src/version.js";
import {
	checkBundlesAreSelfContained,
	ENTRYPOINTS,
	providerBundles,
	releaseTimer,
	SMOKE_FAILURE,
	smokeIsolation,
	smokeProviders,
	WORKERS,
} from "./bundleSmoke";
import { outliveInterrupts } from "./child";
import { DIST_DIR } from "./dist";
import { dirtyTrackedFiles, untrackedFiles } from "./releaseState";
import {
	type BumpKind,
	checkDerivedSites,
	checkEntryGuards,
	checkProtocolRelease,
	DERIVED_SITES,
	nextVersion,
	readVersion,
	setVersion,
	versionTargets,
} from "./versionPolicy";

const ROOT = path.join(import.meta.dirname, "..");
const VERSION_FILE = "version.json";

async function git(args: string[]): Promise<string> {
	const result = await runBounded("git", args, {
		cwd: ROOT,
		maxBytes: 32 * 1024 * 1024,
		timeoutMs: 180_000,
		timer: releaseTimer,
	});
	if (result.kind === "exited" && result.code === 0 && result.signal === null) {
		return result.stdout.toString("utf8").trim();
	}
	const stderr = result.kind === "exited" ? result.stderr.toString("utf8").trim() : "";
	const detail =
		result.kind === "spawnFailed"
			? result.error.message
			: result.kind === "timedOut"
				? "timed out"
				: result.kind === "overflowed"
					? "output exceeded the git limit"
					: `exit ${result.code}`;
	throw new Error(`git ${args.join(" ")} in ${ROOT}: ${stderr || detail}`);
}

function copyProviderAssets(root: string, from: string, into: string): string[] {
	const source = path.join(root, from);
	if (!existsSync(source)) return [];
	const files: string[] = readdirSync(source, { withFileTypes: true })
		.filter((entry) => entry.isFile() && !entry.name.endsWith(".ts"))
		.map((entry) => path.join(source, entry.name));
	const manifest = path.join(source, "..", "package.json");
	if (existsSync(manifest)) {
		const declared =
			(JSON.parse(readFileSync(manifest, "utf8")) as { lexiconAssets?: string[] }).lexiconAssets ?? [];
		const resolve = createRequire(manifest).resolve;
		for (const subpath of declared) files.push(resolve(subpath));
	}

	const copied: string[] = [];
	mkdirSync(path.join(root, into), { recursive: true });
	for (const file of files) {
		copyFileSync(file, path.join(root, into, path.basename(file)));
		copied.push(path.join(into, path.basename(file)));
	}
	return copied;
}

async function buildEntry(source: string, out: string): Promise<void> {
	const result = await runBounded(
		process.execPath,
		[
			"build",
			source,
			"--outfile",
			path.join(DIST_DIR, out),
			"--target",
			"node",
			"--minify-syntax",
			"--minify-whitespace",
			"--format",
			"esm",
		],
		{ cwd: ROOT, maxBytes: 32 * 1024 * 1024, timeoutMs: 180_000, timer: releaseTimer },
	);
	if (result.kind === "exited") {
		process.stdout.write(result.stdout);
		process.stderr.write(result.stderr);
		if (result.code === 0 && result.signal === null) return;
		throw new Error(`bun build exited with code ${result.code}`);
	}
	const detail =
		result.kind === "spawnFailed"
			? result.error.message
			: result.kind === "timedOut"
				? "timed out"
				: "output exceeded the build limit";
	throw new Error(`bun build ${detail}`);
}

async function main(argv: string[]): Promise<void> {
	const buildOnly = argv.includes("--build-only");
	const kind = argv.find((arg) => !arg.startsWith("-"));

	if (!buildOnly && kind !== "patch" && kind !== "minor" && kind !== "major") {
		console.error("usage: bun run build patch|minor|major");
		console.error("       bun run build --build-only");
		process.exit(2);
	}

	checkDerivedSites(ROOT);
	checkEntryGuards(ROOT);

	if (!buildOnly) {
		const status = await git(["status", "--porcelain=v2", "--branch"]);
		const dirty = dirtyTrackedFiles(status);
		if (dirty.length > 0) {
			console.error("Commit your work before building. Uncommitted changes to tracked files:");
			for (const file of dirty) console.error(`  ${file}`);
			console.error("\n(--build-only skips this check)");
			process.exit(1);
		}
		const untracked = untrackedFiles(status);
		if (untracked.length > 0) {
			console.error("Add, ignore or remove untracked files; the bundle would ship them without their source:");
			for (const file of untracked) console.error(`  ${file}`);
			process.exit(1);
		}

		let atHead: string;
		try {
			atHead = await git(["show", "HEAD:protocol/src/version.ts"]);
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
	const providers = providerBundles(ROOT);
	if (providers.length === 0) throw new Error("no providers found to bundle; the shipped index would find nothing");

	outliveInterrupts();
	try {
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

		rmSync(path.join(ROOT, DIST_DIR), { recursive: true, force: true });
		for (const target of targets)
			rmSync(path.join(ROOT, path.dirname(target), DIST_DIR), { recursive: true, force: true });

		for (const entry of ENTRYPOINTS) await buildEntry(entry.source, entry.out);
		for (const entry of WORKERS) await buildEntry(entry.source, entry.out);
		for (const entry of providers) await buildEntry(entry.source, entry.out);
		for (const entry of providers) {
			const assets = copyProviderAssets(ROOT, entry.assets, path.join(DIST_DIR, path.dirname(entry.out)));
			for (const asset of assets) console.log(`copied ${asset}`);
		}
		writeFileSync(
			path.join(ROOT, DIST_DIR, VERSION_FILE),
			`${JSON.stringify(
				{ buildVersion: version, protocolVersion: PROTOCOL_VERSION, oldestClientMajor: OLDEST_CLIENT_MAJOR },
				null,
				"\t",
			)}\n`,
		);
		console.log(`wrote ${DIST_DIR}/${VERSION_FILE}: ${version}, protocol ${PROTOCOL_VERSION}`);
		console.log(`self-contained: ${checkBundlesAreSelfContained(ROOT)} bundles`);
		await smokeProviders(ROOT, providers);
		await smokeIsolation(ROOT);
		if (!buildOnly) {
			await git(["add", "--", ...targets, DIST_DIR]);
			await git(["commit", "-m", `Build ${version}`]);
		}
	} catch (failure) {
		const said = failure instanceof Error ? failure.message : "";
		if (said.includes(SMOKE_FAILURE)) console.error(`\n${said}`);
		if (!buildOnly) {
			await git(["reset", "--quiet", "--", ...targets, DIST_DIR]);
			await git(["checkout", "--", ...targets, DIST_DIR]);
			await git(["clean", "-fdq", "--", DIST_DIR]);
			console.error(`\nbuild failed; reverted ${targets.length} version file(s) and ${DIST_DIR}/ to ${current}`);
		} else {
			console.error("\nbuild failed");
		}
		process.exit(1);
	}

	console.log(
		buildOnly
			? `\nbuilt ${DIST_DIR}/ at ${version}. Nothing bumped, nothing committed.`
			: `\n${current} -> ${version}, committed as "Build ${version}". Push to ship.`,
	);
}

if (path.basename(process.argv[1] ?? "") === "build.ts") {
	void main(process.argv.slice(2)).catch((error) => {
		console.error(error);
		process.exitCode = 1;
	});
}
