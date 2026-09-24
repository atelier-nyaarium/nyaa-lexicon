import { afterEach, describe, expect, it } from "bun:test";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path, { join, relative } from "node:path";
import { codeOnly, readSwept, runBounded, sourceFiles, systemTimer } from "@nyaa-lexicon/protocol";
import { bunCommand, RUNTIME_BUNFIG, RUNTIME_TSCONFIG } from "../launch";
import type { PlatformEnv } from "../paths";

////////////////////////////////
//  Fixtures

const REPO = join(import.meta.dirname, "..", "..", "..");
const RUNTIME = { kind: "bun", executable: process.execPath, version: Bun.version } as const;
const scratch: string[] = [];

function dir(prefix: string): string {
	const made = mkdtempSync(path.join(tmpdir(), prefix));
	scratch.push(made);
	return made;
}

function hostAt(state: string): PlatformEnv {
	return { platform: "linux", env: { XDG_STATE_HOME: state }, home: state, execPath: process.execPath };
}

afterEach(() => {
	for (const made of scratch.splice(0)) rmSync(made, { recursive: true, force: true });
});

////////////////////////////////
//  Tests

describe("starting bun", () => {
	it("passes lexicon's own settings files and turns off .env loading and auto-install", () => {
		const state = dir("lexicon-launch-state-");
		const root = path.join(state, "nyaa-lexicon");

		expect(bunCommand(RUNTIME, hostAt(state))).toEqual([
			process.execPath,
			`--config=${path.join(root, "runtime.bunfig.toml")}`,
			`--tsconfig-override=${path.join(root, "runtime.tsconfig.json")}`,
			"--no-env-file",
			"--no-install",
		]);
		expect([
			readFileSync(path.join(root, "runtime.bunfig.toml"), "utf8"),
			readFileSync(path.join(root, "runtime.tsconfig.json"), "utf8"),
		]).toEqual([RUNTIME_BUNFIG, RUNTIME_TSCONFIG]);
	});

	it("rewrites a settings file holding other text, and replaces a symlink without following it", () => {
		const state = dir("lexicon-launch-state-");
		const root = path.join(state, "nyaa-lexicon");
		mkdirSync(root, { recursive: true });
		const elsewhere = path.join(state, "elsewhere.json");
		writeFileSync(elsewhere, '{ "compilerOptions": { "paths": {} } }\n');
		writeFileSync(path.join(root, "runtime.bunfig.toml"), 'preload = ["./evil.ts"]\n');
		symlinkSync(elsewhere, path.join(root, "runtime.tsconfig.json"));

		bunCommand(RUNTIME, hostAt(state));

		expect({
			bunfig: readFileSync(path.join(root, "runtime.bunfig.toml"), "utf8"),
			tsconfigIsFile: lstatSync(path.join(root, "runtime.tsconfig.json")).isFile(),
			tsconfig: readFileSync(path.join(root, "runtime.tsconfig.json"), "utf8"),
			elsewhere: readFileSync(elsewhere, "utf8"),
		}).toEqual({
			bunfig: RUNTIME_BUNFIG,
			tsconfigIsFile: true,
			tsconfig: RUNTIME_TSCONFIG,
			elsewhere: '{ "compilerOptions": { "paths": {} } }\n',
		});
	});

	it("keeps a folder's bunfig preload and .env out of a process started inside it", async () => {
		const state = dir("lexicon-launch-state-");
		const hostile = dir("lexicon-launch-hostile-");
		const marker = path.join(hostile, "preload-ran");
		writeFileSync(path.join(hostile, "bunfig.toml"), 'preload = ["./evil.ts"]\n');
		writeFileSync(
			path.join(hostile, "evil.ts"),
			`require("node:fs").writeFileSync(${JSON.stringify(marker)}, "");\n`,
		);
		writeFileSync(path.join(hostile, ".env"), "LEXICON_LAUNCH_CANARY=leaked\n");
		const probe = path.join(state, "probe.js");
		writeFileSync(probe, 'process.stdout.write(process.env.LEXICON_LAUNCH_CANARY ?? "absent");\n');

		const [executable, ...args] = bunCommand(RUNTIME, hostAt(state));
		const run = await runBounded(executable as string, [...args, probe], {
			cwd: hostile,
			maxBytes: 1024,
			timeoutMs: 20_000,
			timer: systemTimer,
		});

		expect({
			kind: run.kind,
			canary: run.kind === "exited" ? run.stdout.toString("utf8") : null,
			preloadRan: existsSync(marker),
		}).toEqual({ kind: "exited", canary: "absent", preloadRan: false });
	});

	it("matches the settings files the plugin's own launch uses", () => {
		const mcp = JSON.parse(readFileSync(join(REPO, ".mcp.json"), "utf8")) as {
			mcpServers: Record<string, { args: string[] }>;
		};
		const args = Object.values(mcp.mcpServers).flatMap((server) => server.args);

		expect({
			bunfig: readFileSync(join(REPO, "launch", "bunfig.toml"), "utf8"),
			tsconfig: readFileSync(join(REPO, "launch", "tsconfig.json"), "utf8"),
			flags: args.filter((arg) => arg.startsWith("--")).slice(0, 4),
		}).toEqual({
			bunfig: RUNTIME_BUNFIG,
			tsconfig: RUNTIME_TSCONFIG,
			flags: [
				"--config=${CLAUDE_PLUGIN_ROOT}/launch/bunfig.toml",
				"--tsconfig-override=${CLAUDE_PLUGIN_ROOT}/launch/tsconfig.json",
				"--no-env-file",
				"--no-install",
			],
		});
	});
});

// A bun argv built anywhere else would skip the settings files and flags.
describe("one owner for bun argv", () => {
	const SWEPT = ["client/src", "core/src", "adapters/mcp/src", "adapters/lsp/src"].map((d) => join(REPO, d));
	const OWNERS = new Set(["client/src/launch.ts"]);
	const SKIP_DIRS = new Set(["__tests__", "dist", "node_modules", ".tsbuild", "tmp"]);
	/** The executable leading an argv or a spawn call; a mention inside a message is not one. */
	const LEADS_ARGV = /\.executable\s*[,\]]/;

	it("fires on an argv or a spawn call led by an executable", () => {
		expect(
			["[runtime.executable, bundle]", "spawn(resolved.executable, args)", "`at ${runtime.executable}`"].map(
				(code) => LEADS_ARGV.test(code),
			),
		).toEqual([true, true, false]);
	});

	it("finds source files to check, so a passing run is never vacuous", () => {
		for (const swept of SWEPT) expect(sourceFiles(swept, SKIP_DIRS).length, swept).toBeGreaterThan(0);
	});

	it("builds a bun argv only in launch.ts", () => {
		const offenders: string[] = [];
		for (const swept of SWEPT) {
			for (const file of sourceFiles(swept, SKIP_DIRS)) {
				const name = relative(REPO, file);
				if (OWNERS.has(name)) continue;
				const source = readSwept(file);
				if (source !== null && LEADS_ARGV.test(codeOnly(source))) offenders.push(name);
			}
		}

		expect(offenders, "start bun through bunCommand in client/src/launch.ts").toEqual([]);
	});
});
