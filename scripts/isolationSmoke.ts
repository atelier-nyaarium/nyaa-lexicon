// Indexes a hostile workspace through the client's launch path, from inside it, and fails if the
// workspace ran anything inside lexicon: a bunfig preload, a .env, or a json.py standing in for
// Python's. It also fails if a tracked link out of the workspace let an outside canary into the
// store. Run by the release build after the bundle; meaningful only against a fresh dist/.
//
//   bun scripts/isolationSmoke.ts

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { connect, type Session } from "../client/src/index.js";

////////////////////////////////
//  Constants

const ROOT = path.join(import.meta.dirname, "..");
const READY_TIMEOUT_MS = 120_000;
const ABSENT_PACKAGE = "zzz_lexicon_absent_package";

////////////////////////////////
//  Functions & Helpers

interface Hostile {
	workspace: string;
	markers: string;
	leaked: string;
	canary: string;
}

function hostileWorkspace(scratch: string): Hostile {
	const workspace = path.join(scratch, "workspace");
	const markers = path.join(scratch, "markers");
	const outside = path.join(scratch, "outside");
	const leaked = path.join(workspace, "leaked-state");
	const canary = `lexicon-canary-${randomUUID()}`;
	mkdirSync(workspace);
	mkdirSync(markers);
	mkdirSync(outside);
	const files: Record<string, string> = {
		"bunfig.toml": 'preload = ["./evil.ts"]\n',
		"evil.ts": `require("node:fs").writeFileSync(${JSON.stringify(path.join(markers, "bunfig-preload"))}, "");\n`,
		".env": `XDG_STATE_HOME=${leaked}\n`,
		"json.py": `open(${JSON.stringify(path.join(markers, "json.py"))}, "w").close()\n`,
		"main.py": `import ${ABSENT_PACKAGE}\n`,
		"main.ts": "import { canary } from './linked-dir/canary';\nexport const greet = (): string => canary;\n",
	};
	for (const [name, text] of Object.entries(files)) writeFileSync(path.join(workspace, name), text);
	writeFileSync(path.join(outside, "canary.ts"), `// ${canary}\nexport const canary = "${canary}";\n`);
	writeFileSync(path.join(outside, "canary.md"), `# ${canary}\n`);
	symlinkSync(path.join(outside, "canary.ts"), path.join(workspace, "linked.ts"));
	symlinkSync(path.join(outside, "canary.md"), path.join(workspace, "linked.md"));
	symlinkSync(outside, path.join(workspace, "linked-dir"));
	git(workspace, ["init", "-q"]);
	git(workspace, ["add", "-A"]);
	return { workspace, markers, leaked, canary };
}

function git(cwd: string, args: string[]): void {
	const run = spawnSync("git", ["-c", "core.fsmonitor=false", ...args], { cwd, encoding: "utf8", timeout: 30_000 });
	if (run.status !== 0) throw new Error(`git ${args[0]} failed: ${(run.stderr ?? "").trim() || run.status}`);
}

/** Files under the state dir containing the canary, WAL included. */
function holdingCanary(dir: string, canary: string): string[] {
	const needle = Buffer.from(canary, "utf8");
	return readdirSync(dir, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => path.join(entry.parentPath, entry.name))
		.filter((file) => readFileSync(file).includes(needle));
}

async function waitReady(session: Session): Promise<void> {
	const deadline = Date.now() + READY_TIMEOUT_MS;
	for (;;) {
		try {
			if ((await session.indexStatus({})).state === "ready") return;
		} catch {}
		if (Date.now() > deadline) throw new Error(`the index was not ready within ${READY_TIMEOUT_MS} ms`);
		await Bun.sleep(250);
	}
}

////////////////////////////////
//  Main

async function main(): Promise<void> {
	const scratch = mkdtempSync(path.join(os.tmpdir(), "lexicon-isolation-"));
	const { workspace, markers, leaked, canary } = hostileWorkspace(scratch);
	const stateDir = path.join(scratch, "state");
	// A .env only sets a variable the process lacks, so the canary needs it absent.
	delete process.env["XDG_STATE_HOME"];
	const previousCwd = process.cwd();
	// A spawned daemon starts where this process stands, as under an agent's MCP server.
	process.chdir(workspace);
	const holdOpen = setInterval(() => {}, 1_000);
	let session: Session | null = null;
	try {
		session = await connect({ workspaceRoot: workspace, lexiconRoot: ROOT, stateDir });
		await session.indexWorkspace({}).catch(() => {});
		await waitReady(session);
		// Runs the Python provider's `python3 -c` probes, which import json.
		await session.resolveImport({ fromModule: "main.py", specifier: ABSENT_PACKAGE });

		const ran = readdirSync(markers);
		const leakedEnv = readdirSync(workspace).includes(path.basename(leaked));
		if (ran.length > 0 || leakedEnv) {
			const what = [...ran, ...(leakedEnv ? [".env"] : [])].join(", ");
			throw new Error(`the workspace ran code inside lexicon: ${what}`);
		}
		// Stopped first, so writes are flushed to disk.
		await session.stopDaemon();
		const holding = holdingCanary(stateDir, canary);
		if (holding.length > 0) {
			throw new Error(`a link out of the workspace reached the store: ${holding.join(", ")}`);
		}
		console.log("isolation ok: no bunfig preload, .env, json.py or outside link reached lexicon");
	} finally {
		await session?.stopDaemon().catch(() => {});
		clearInterval(holdOpen);
		process.chdir(previousCwd);
		rmSync(scratch, { recursive: true, force: true });
	}
}

main().catch((error) => {
	console.error(`isolation smoke: ${error instanceof Error ? error.message : error}`);
	process.exit(1);
});
