import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { connect, DaemonError, type PlatformEnv, type Session, writeInstallRecord } from "@nyaa-lexicon/client";
import { PROTOCOL_VERSION } from "@nyaa-lexicon/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type RunningDaemon, startDaemon } from "../daemon";
import { createDispatch } from "../dispatch";
import { lexiconRoot } from "../providers";
import { LexiconService } from "../service";
import { sourceReader } from "../sourceRead";
import { IndexStore } from "../store";
import { ProviderSupervisor } from "../supervisor";
import { TransactionManager } from "../transactions";
import { BUILD_VERSION } from "../version";
import { WorkspaceGate } from "../workspaceGate";

////////////////////////////////
//  Harness

const ROOT = path.join(import.meta.dirname, "..", "..", "..");

/** Providers run from source under bun. */
const TYPESCRIPT = path.join(ROOT, "providers", "typescript", "src", "main.ts");
const CSHARP = path.join(ROOT, "providers", "csharp", "src", "main.ts");

/** The bundle this checkout's daemon stamps into its lock. Absent in a checkout never built. */
const OWN_BUNDLE = path.join(lexiconRoot(), "dist", "daemon.js");
const whenBuilt = existsSync(OWN_BUNDLE) ? describe : describe.skip;

const FILES: Record<string, string> = {
	// Project-model driven: without an include list the provider enumerates nothing.
	"tsconfig.json": `${JSON.stringify(
		{
			compilerOptions: { module: "esnext", target: "es2022", moduleResolution: "bundler", strict: true },
			include: ["*.ts"],
		},
		null,
		"\t",
	)}\n`,
	// A run of names, a method with two parameters, and a name declared twice.
	"app.ts": [
		"export namespace Outer {",
		"\texport namespace Inner {",
		"\t\texport function deep(): number {",
		"\t\t\treturn 1;",
		"\t\t}",
		"\t}",
		"}",
		"",
		"export class Service {",
		"\trun(first: number, second: string): string {",
		"\t\treturn second.repeat(first);",
		"\t}",
		"}",
		"",
		"export function run(): void {}",
		"",
	].join("\n"),
	// A namespace whose own name holds the dots.
	"Service.cs": [
		"namespace Acme.Services",
		"{",
		"\tpublic class Service",
		"\t{",
		"\t\tpublic int Compute(int qty)",
		"\t\t{",
		"\t\t\treturn qty;",
		"\t\t}",
		"\t}",
		"}",
		"",
	].join("\n"),
	"notes.unknownext": "nobody claims this\n",
};

let state: string;
let install: string;
let workspace: string;
let host: PlatformEnv;
let previousStateHome: string | undefined;
let store: IndexStore;
let supervisor: ProviderSupervisor;
let daemon: RunningDaemon;
let session: Session;

/** An install wearing this daemon's identity: its build, and a bundle with the same size and mtime. */
function installLikeOurs(root: string): void {
	const bundle = path.join(root, "dist", "daemon.js");
	mkdirSync(path.dirname(bundle), { recursive: true });
	copyFileSync(OWN_BUNDLE, bundle);
	const own = statSync(OWN_BUNDLE);
	utimesSync(bundle, own.atime, own.mtime);
	writeFileSync(
		path.join(root, "dist", "version.json"),
		JSON.stringify({ buildVersion: BUILD_VERSION, protocolVersion: PROTOCOL_VERSION }),
	);
}

async function exact(module: string, segments: string[]) {
	const answer = await session.resolveChain(module, segments);
	if (answer.kind !== "exact")
		throw new Error(`${module} ${segments.join(" > ")} answered ${JSON.stringify(answer)}`);
	return answer.candidate;
}

////////////////////////////////
//  Tests

whenBuilt("resolveChain and awaitIndexed over a real daemon", () => {
	beforeAll(async () => {
		state = mkdtempSync(path.join(tmpdir(), "lexicon-chain-state-"));
		install = mkdtempSync(path.join(tmpdir(), "lexicon-chain-install-"));
		workspace = mkdtempSync(path.join(tmpdir(), "lexicon-chain-work-"));
		host = { platform: "linux", env: { XDG_STATE_HOME: state }, home: state };
		// connect() reads the live host, so the record and the lock land in this test's state root.
		previousStateHome = process.env["XDG_STATE_HOME"];
		process.env["XDG_STATE_HOME"] = state;
		for (const [name, text] of Object.entries(FILES)) writeFileSync(path.join(workspace, name), text);
		installLikeOurs(install);
		writeInstallRecord(install, host);

		store = IndexStore.open(path.join(state, "index.sqlite")).store;
		supervisor = new ProviderSupervisor();
		await Promise.all(
			[TYPESCRIPT, CSHARP].map((main) =>
				supervisor.start({ command: ["bun", "run", main], timeoutMs: 60_000 }, workspace),
			),
		);
		const service = new LexiconService(store, supervisor, sourceReader(workspace), workspace);
		const refactor = { gate: new WorkspaceGate(), transactions: new TransactionManager(store, workspace) };
		await service.indexWorkspace();

		const outcome = await startDaemon({
			workspaceRoot: workspace,
			host,
			handle: createDispatch(service, refactor),
		});
		if (!outcome.claimed) throw new Error(outcome.reason);
		daemon = outcome.daemon;
		session = await connect({ workspaceRoot: workspace });
	}, 180_000);

	afterAll(async () => {
		session?.close();
		await daemon?.stop();
		supervisor?.stopAll();
		store?.close();
		if (previousStateHome === undefined) delete process.env["XDG_STATE_HOME"];
		else process.env["XDG_STATE_HOME"] = previousStateHome;
		for (const dir of [state, install, workspace]) rmSync(dir, { recursive: true, force: true });
	});

	it("names a method under its class, with the line it starts on", async () => {
		expect(await exact("app.ts", ["Service", "run"])).toMatchObject({
			kind: "method",
			name: "run",
			containerPath: ["Service"],
			range: { start: { line: 9 } },
		});
	});

	it("answers both declarations of a repeated name, and the second by ordinal", async () => {
		const answer = await session.resolveChain("app.ts", ["run"]);
		expect(answer.kind).toBe("ambiguous");
		if (answer.kind !== "ambiguous") return;
		expect(answer.candidates).toHaveLength(2);
		expect(answer.candidates.map((candidate) => candidate.range.start.line)).toEqual([9, 14]);

		expect(await exact("app.ts", ["run[2]"])).toMatchObject({ kind: "function", containerPath: [] });
	});

	it("spans both parameters for `arguments` and names one after it", async () => {
		const span = await exact("app.ts", ["Service", "run", "arguments"]);
		expect(span.range).toEqual({ start: { line: 9, character: 5 }, end: { line: 9, character: 34 } });
		expect(span.selectionRange).toBeUndefined();
		expect(span.containerPath).toEqual(["Service", "run"]);

		expect(await exact("app.ts", ["Service", "run", "arguments", "second"])).toMatchObject({
			name: "second",
			containerPath: ["Service", "run"],
			range: { start: { line: 9, character: 20 } },
		});
	});

	it("reaches the same declaration through a run of names or one qualified segment", async () => {
		const run = await exact("app.ts", ["Outer", "Inner", "deep"]);
		expect(run.containerPath).toEqual(["Outer", "Inner"]);
		expect((await exact("app.ts", ["Outer.Inner", "deep"])).symbolId).toBe(run.symbolId);
		expect((await exact("app.ts", ["Outer::Inner", "deep"])).symbolId).toBe(run.symbolId);
		expect((await exact("app.ts", ["Outer", "deep"])).symbolId).toBe(run.symbolId);
	});

	it("matches a C# namespace whose own name holds the dots, in either spelling", async () => {
		const dotted = await exact("Service.cs", ["Acme.Services", "Service", "Compute"]);
		expect(dotted).toMatchObject({
			kind: "method",
			containerPath: ["Acme.Services", "Service"],
			range: { start: { line: 4 } },
		});
		expect((await exact("Service.cs", ["Acme::Services", "Service", "Compute"])).symbolId).toBe(dotted.symbolId);
	});

	it("says noMatch for a name the module does not declare", async () => {
		expect(await session.resolveChain("app.ts", ["Ghost"])).toEqual({ kind: "none", reason: "noMatch" });
	});

	it("says why a file owned by nobody, or by no one on disk, has nothing to walk", async () => {
		expect(await session.resolveChain("notes.unknownext", ["x"])).toEqual({ kind: "none", reason: "unclaimed" });
		expect(await session.resolveChain("ghost.ts", ["x"])).toEqual({ kind: "none", reason: "missing" });
		expect(await session.awaitIndexed("notes.unknownext")).toEqual({ indexed: false, reason: "unclaimed" });
		expect(await session.awaitIndexed("ghost.ts")).toEqual({ indexed: false, reason: "missing" });
	});

	it("reads a file written after the scan once awaitIndexed brings it in", async () => {
		writeFileSync(path.join(workspace, "late.ts"), "export function late(): void {}\n");

		expect(await session.resolveChain("late.ts", ["late"])).toEqual({ kind: "none", reason: "unread" });
		expect(await session.awaitIndexed("late.ts")).toEqual({ indexed: true });
		expect(await exact("late.ts", ["late"])).toMatchObject({ kind: "function", range: { start: { line: 0 } } });
		// Current now, which is still an indexed answer.
		expect(await session.awaitIndexed("late.ts")).toEqual({ indexed: true });
	});

	it("throws the indexer's reason when a file cannot be read", async () => {
		writeFileSync(path.join(workspace, "blob.ts"), Buffer.from([0x00, 0x01, 0x02]));

		const failed = session.awaitIndexed("blob.ts");
		await expect(failed).rejects.toThrow(DaemonError);
		await expect(failed).rejects.toThrow(/NUL/);
	});
});
