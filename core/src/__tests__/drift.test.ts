import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { bundleStamp } from "@nyaa-lexicon/client";
import { afterEach, describe, expect, it } from "vitest";
import { driftedTo } from "../drift";

////////////////////////////////
//  Helpers

const made: string[] = [];

function installDir(): string {
	const dir = mkdtempSync(path.join(tmpdir(), "lexicon-drift-"));
	made.push(dir);
	return dir;
}

/** Backdated, since a bundle must sit still before it counts as a target. */
function backdate(file: string): void {
	const past = new Date(Date.now() - 60_000);
	utimesSync(file, past, past);
}

/** A version directory that can actually serve: bundle plus a manifest agreeing with its name. */
function install(parent: string, version: string, options: { bundle?: boolean; manifest?: string } = {}): string {
	const root = path.join(parent, version);
	mkdirSync(path.join(root, "dist"), { recursive: true });
	if (options.bundle !== false) {
		const bundle = path.join(root, "dist", "daemon.js");
		writeFileSync(bundle, `// ${version}\n`);
		backdate(bundle);
	}
	writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: options.manifest ?? version }));
	return root;
}

function checkout(parent: string, name: string): string {
	const root = path.join(parent, name);
	mkdirSync(path.join(root, "dist"), { recursive: true });
	writeFileSync(path.join(root, "dist", "daemon.js"), "// dev\n");
	backdate(path.join(root, "dist", "daemon.js"));
	return root;
}

function sight(root: string, stampAtStart: string | null = bundleStamp(root)) {
	return driftedTo({ workspaceRoot: "/w", root, version: "1.13.0", stampAtStart });
}

afterEach(() => {
	for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

////////////////////////////////
//  Tests

// The plugin cache installs each version into its own frozen directory, so a running daemon's own
// files never change; the news of an update is a newer sibling.
describe("noticing a newer sibling install", () => {
	it("finds the newest runnable sibling, skipping ones without a bundle", () => {
		const parent = installDir();
		const root = install(parent, "1.13.0");
		install(parent, "1.14.0");
		install(parent, "1.15.0");
		install(parent, "1.16.0", { bundle: false });

		expect(sight(root)?.root).toBe(path.join(parent, "1.15.0"));
		expect(sight(root)?.why).toContain("1.15.0");
	});

	it("ignores older siblings and non-version directories", () => {
		const parent = installDir();
		const root = install(parent, "1.13.0");
		install(parent, "1.12.0");
		install(parent, "1.14.0garbage");
		mkdirSync(path.join(parent, "not-a-version", "dist"), { recursive: true });

		expect(sight(root)).toBeNull();
	});

	// A bundle compiled as some OTHER version writes that version into its lock, which clients then
	// replace, which respawns the daemon that hands over here again: a loop.
	it("refuses a sibling whose manifest disagrees with its directory name", () => {
		const parent = installDir();
		const root = install(parent, "1.13.0");
		install(parent, "1.14.0", { manifest: "1.13.0" });

		expect(sight(root)).toBeNull();
	});

	// Handing over to a bundle mid-write spawns half a program.
	it("waits out a sibling whose bundle is still being written", () => {
		const parent = installDir();
		const root = install(parent, "1.13.0");
		const fresh = install(parent, "1.14.0");
		const now = new Date();
		utimesSync(path.join(fresh, "dist", "daemon.js"), now, now);

		expect(sight(root)).toBeNull();
	});

	// A source checkout's root is not named by version, so the sibling scan must stay out of it: a
	// sibling checkout of something newer is not an install of this build.
	it("never scans siblings when the root is not a versioned directory", () => {
		const parent = installDir();
		const root = checkout(parent, "my-checkout");
		install(parent, "9.9.9");

		expect(sight(root)).toBeNull();
	});
});

// A source checkout rebuilds dist/ in place, so the stamp recorded at start is the tell.
describe("noticing a rebuild under the running daemon", () => {
	it("points at its own root once the bundle changes and settles", () => {
		const parent = installDir();
		const root = checkout(parent, "checkout");
		const stampAtStart = bundleStamp(root);
		writeFileSync(path.join(root, "dist", "daemon.js"), "// v2, longer\n");
		backdate(path.join(root, "dist", "daemon.js"));

		expect(sight(root, stampAtStart)?.root).toBe(root);
	});

	it("waits while the rebuilt bundle is still fresh enough to be mid-write", () => {
		const parent = installDir();
		const root = checkout(parent, "checkout");
		const stampAtStart = bundleStamp(root);
		writeFileSync(path.join(root, "dist", "daemon.js"), "// v2, still being written\n");

		expect(sight(root, stampAtStart)).toBeNull();
	});

	it("stays put while the bundle is the one it started on", () => {
		const parent = installDir();
		const root = checkout(parent, "checkout");

		expect(sight(root)).toBeNull();
	});

	// Nothing recorded means nothing to compare, never a restart on a guess.
	it("stays put with no stamp recorded at start", () => {
		const parent = installDir();
		const root = checkout(parent, "checkout");

		expect(sight(root, null)).toBeNull();
	});
});
