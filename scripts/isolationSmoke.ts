// Indexes a hostile workspace through the client's launch path, from inside it, and fails if the
// workspace ran anything inside lexicon: a bunfig preload, a .env, or a json.py standing in for
// Python's. Run by the release build after the bundle; meaningful only against a fresh dist/.
//
//   bun scripts/isolationSmoke.ts

import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

function hostileWorkspace(scratch: string): { workspace: string; markers: string; leaked: string } {
	const workspace = path.join(scratch, "workspace");
	const markers = path.join(scratch, "markers");
	const leaked = path.join(workspace, "leaked-state");
	mkdirSync(workspace);
	mkdirSync(markers);
	const files: Record<string, string> = {
		"bunfig.toml": 'preload = ["./evil.ts"]\n',
		"evil.ts": `require("node:fs").writeFileSync(${JSON.stringify(path.join(markers, "bunfig-preload"))}, "");\n`,
		".env": `XDG_STATE_HOME=${leaked}\n`,
		"json.py": `open(${JSON.stringify(path.join(markers, "json.py"))}, "w").close()\n`,
		"main.py": `import ${ABSENT_PACKAGE}\n`,
		"main.ts": "export const greet = (): string => 'hi';\n",
	};
	for (const [name, text] of Object.entries(files)) writeFileSync(path.join(workspace, name), text);
	return { workspace, markers, leaked };
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
	const { workspace, markers, leaked } = hostileWorkspace(scratch);
	// A .env only sets a variable the process lacks, so the canary needs it absent.
	delete process.env["XDG_STATE_HOME"];
	const previousCwd = process.cwd();
	// A spawned daemon starts where this process stands, as under an agent's MCP server.
	process.chdir(workspace);
	const holdOpen = setInterval(() => {}, 1_000);
	let session: Session | null = null;
	try {
		session = await connect({ workspaceRoot: workspace, lexiconRoot: ROOT, stateDir: path.join(scratch, "state") });
		await session.cacheStats({}).catch(() => {});
		await waitReady(session);
		// Runs the Python provider's `python3 -c` probes, which import json.
		await session.resolveImport({ fromModule: "main.py", specifier: ABSENT_PACKAGE });

		const ran = readdirSync(markers);
		const leakedEnv = readdirSync(workspace).includes(path.basename(leaked));
		if (ran.length > 0 || leakedEnv) {
			const what = [...ran, ...(leakedEnv ? [".env"] : [])].join(", ");
			throw new Error(`the workspace ran code inside lexicon: ${what}`);
		}
		console.log("isolation ok: no bunfig preload, .env or json.py reached lexicon");
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
