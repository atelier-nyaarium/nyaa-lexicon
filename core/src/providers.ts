// Finding and starting the provider processes.
//
// Core learns nothing about any language here. It finds directories under providers/ and starts
// each one; a provider states its own id, extensions and tiers at initialize. Four entrypoints
// used to hand-roll this, and every one of them hardcoded a single provider, so the other two
// were unreachable from every way of running the tool.

import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { type BunExecutable, bunExecutable, currentHost } from "@nyaa-lexicon/client";
import type { ProviderStarter } from "./providerPort.js";
import type { ProviderClaims } from "./routing.js";
import type { ProviderSpec } from "./supervisor.js";

////////////////////////////////
//  Interfaces & Types

export interface ProviderCommand {
	/** The directory name under providers/. A label for reports, never a routing key. */
	directory: string;
	command: string[];
}

export interface StartOptions {
	commands?: ProviderCommand[];
	runtime?: BunExecutable;
}

export interface StartedProvider {
	directory: string;
	claims: ProviderClaims;
}

export interface StartReport {
	started: StartedProvider[];
	/** A provider that would not start, kept rather than thrown: the others still work. */
	failed: Array<{ directory: string; error: string }>;
}

////////////////////////////////
//  Constants

/** How long a provider gets to answer initialize before it counts as failed to start. */
const START_TIMEOUT_MS = 60_000;

////////////////////////////////
//  Functions & Helpers

/**
 * Walk up for the repository that owns this build.
 *
 * Not derived from `import.meta.dirname` directly: that is `core/src` in source and `dist` in the
 * bundle, so a fixed number of `..` segments is correct in exactly one of the two.
 */
export function lexiconRoot(): string {
	let dir = import.meta.dirname;
	for (let depth = 0; depth < 6; depth++) {
		if (existsSync(path.join(dir, "providers")) && existsSync(path.join(dir, "package.json"))) return dir;
		dir = path.dirname(dir);
	}
	throw new Error("could not locate the lexicon repository from this build");
}

/**
 * Every provider present on disk, discovered rather than listed, so adding one needs no edit here.
 *
 * The bundle is preferred over the source: it runs with no install, which the source cannot, since
 * it imports workspace packages that only resolve when a `node_modules` exists. A host that
 * installs dependencies and one that does not otherwise behave completely differently. Both run on
 * the executable this process runs on.
 */
export function discoverProviders(root = lexiconRoot(), runtime = bunExecutable(currentHost())): ProviderCommand[] {
	assertRuntime(runtime);
	const directory = path.join(root, "providers");
	if (!existsSync(directory)) return [];

	const found: ProviderCommand[] = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;

		const bundled = path.join(root, "dist", "providers", entry.name, "main.js");
		if (existsSync(bundled)) {
			found.push({ directory: entry.name, command: [runtime.executable, bundled] });
			continue;
		}

		const source = path.join(directory, entry.name, "src", "main.ts");
		if (existsSync(source)) found.push({ directory: entry.name, command: [runtime.executable, "run", source] });
	}
	return found.sort((a, b) => a.directory.localeCompare(b.directory));
}

function assertRuntime(runtime: BunExecutable): void {
	if (runtime.kind !== "bun")
		throw new Error(
			`providers cannot start: ${runtime.kind} ${runtime.executable} ${"version" in runtime ? runtime.version : "unknown"}`,
		);
}

function specFor(entry: ProviderCommand): ProviderSpec {
	return { command: entry.command, timeoutMs: START_TIMEOUT_MS };
}

/**
 * Start every discovered provider against one workspace.
 *
 * A provider that fails to start is recorded rather than thrown. A missing python3 or a syntax
 * error in one tree would otherwise take down answering for every other language, which is the
 * opposite of what separate processes are for.
 */
export async function startProviders(
	supervisor: ProviderStarter,
	workspaceRoot: string,
	options: StartOptions = {},
): Promise<StartReport> {
	const runtime = options.runtime ?? bunExecutable(currentHost());
	assertRuntime(runtime);
	const commands = options.commands ?? discoverProviders(undefined, runtime);
	const report: StartReport = { started: [], failed: [] };

	// Concurrent: sequential made the worst case the SUM of every provider's timeout.
	const settled = await Promise.all(
		commands.map(async (entry) => {
			try {
				const claims = await supervisor.start(specFor(entry), workspaceRoot);
				return { entry, claims };
			} catch (error) {
				return { entry, error: error instanceof Error ? error.message : String(error) };
			}
		}),
	);

	// Reported in the order given, not the order they finished, so the list is stable run to run.
	for (const outcome of settled) {
		if ("claims" in outcome) report.started.push({ directory: outcome.entry.directory, claims: outcome.claims });
		else report.failed.push({ directory: outcome.entry.directory, error: outcome.error });
	}
	return report;
}

/** One line per provider, so a caller that starts them can say what it actually got. */
export function describeStart(report: StartReport): string {
	const lines = report.started.map((p) => `  ${p.claims.language}: ${p.claims.extensions.join(" ")}`);
	for (const failure of report.failed) lines.push(`  ${failure.directory}: did not start (${failure.error})`);
	return lines.join("\n");
}
