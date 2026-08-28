import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { connect, DaemonError, type PlatformEnv, type Session, writeInstallRecord } from "@nyaa-lexicon/client";
import { type RunningDaemon, startDaemon } from "../daemon";
import { createDispatch } from "../dispatch";
import { lexiconRoot } from "../providers";
import { LexiconService } from "../service";
import { sourceReader } from "../sourceRead";
import { IndexStore } from "../store";
import { ProviderSupervisor } from "../supervisor";
import { TransactionManager } from "../transactions";
import { WorkspaceGate } from "../workspaceGate";

////////////////////////////////
//  Harness

const ROOT = path.join(import.meta.dirname, "..", "..", "..");

/** Providers run from source under bun. */
const TYPESCRIPT = path.join(ROOT, "providers", "typescript", "src", "main.ts");
const CSHARP = path.join(ROOT, "providers", "csharp", "src", "main.ts");
const MARKDOWN = path.join(ROOT, "providers", "markdown", "src", "main.ts");

/** Past the indexer's cap, so the read answers `tooLarge`. */
const OVERSIZED = 4 * 1024 * 1024 + 1;

// The install IS this checkout, so the lock's bundle stamp and the install's come from one file.
const INSTALL = lexiconRoot();
const whenBuilt = ["daemon.js", "version.json"].every((file) => existsSync(path.join(INSTALL, "dist", file)))
	? describe
	: describe.skip;

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
	// A namespace whose own name holds the dots, and an explicit interface implementation whose id
	// names the interface as a scope nothing under the class declares.
	"Service.cs": [
		"namespace Acme.Services",
		"{",
		"\tpublic interface IRun",
		"\t{",
		"\t\tvoid Go();",
		"\t}",
		"",
		"\tpublic class Service : IRun",
		"\t{",
		"\t\tpublic int Compute(int qty)",
		"\t\t{",
		"\t\t\treturn qty;",
		"\t\t}",
		"",
		"\t\tvoid IRun.Go()",
		"\t\t{",
		"\t\t}",
		"\t}",
		"}",
		"",
	].join("\n"),
	// A dotted heading a proper prefix must not reach.
	"README.md": "# Node.js setup\n\nInstall it.\n",
	// Denied by the workspace's own scope, so it is owned and yet never indexed.
	"lexicon.json": '{ "deny": ["denied.ts"] }\n',
	"denied.ts": "export const denied = 1;\n",
	"notes.unknownext": "nobody claims this\n",
};

let state: string;
let workspace: string;
let host: PlatformEnv;
let previousStateHome: string | undefined;
let store: IndexStore;
let supervisor: ProviderSupervisor;
let daemon: RunningDaemon;
let session: Session;

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
		workspace = mkdtempSync(path.join(tmpdir(), "lexicon-chain-work-"));
		host = { platform: "linux", env: { XDG_STATE_HOME: state }, home: state };
		// connect() reads the live host, so the record and the lock land in this test's state root.
		previousStateHome = process.env["XDG_STATE_HOME"];
		process.env["XDG_STATE_HOME"] = state;
		for (const [name, text] of Object.entries(FILES)) writeFileSync(path.join(workspace, name), text);
		writeInstallRecord(INSTALL, host);

		store = IndexStore.open(path.join(state, "index.sqlite")).store;
		supervisor = new ProviderSupervisor();
		await Promise.all(
			[TYPESCRIPT, CSHARP, MARKDOWN].map((main) =>
				supervisor.start({ command: [process.execPath, "run", main], timeoutMs: 60_000 }, workspace),
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
		for (const dir of [state, workspace]) rmSync(dir, { recursive: true, force: true });
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
			range: { start: { line: 9 } },
		});
		expect((await exact("Service.cs", ["Acme::Services", "Service", "Compute"])).symbolId).toBe(dotted.symbolId);
	});

	it("says noMatch for a name the module does not declare, and what was there instead", async () => {
		expect(await session.resolveChain("app.ts", ["Ghost"])).toMatchObject({
			kind: "none",
			reason: "noMatch",
			matched: { containerPaths: [], consumed: 0, count: 0 },
			available: expect.arrayContaining(["Outer", "Service", "run"]),
		});
		expect(await session.resolveChain("app.ts", ["Service", "ghost"])).toMatchObject({
			kind: "none",
			reason: "noMatch",
			matched: { containerPaths: [["Service"]], consumed: 1, count: 0 },
			available: ["run", "first", "second"],
		});
	});

	it("carries the index's hash and the disk's on every answer, and tells them apart after an edit", async () => {
		const before = await session.resolveChain("app.ts", ["Service", "run"]);
		expect(before.kind).toBe("exact");
		if (before.kind !== "exact") return;
		expect(typeof before.contentHash).toBe("string");
		expect(before.diskHash).toBe(before.contentHash);

		writeFileSync(path.join(workspace, "app.ts"), `${FILES["app.ts"]}\nexport const extra = 1;\n`);
		const after = await session.resolveChain("app.ts", ["Service", "run"]);
		expect(after.contentHash).toBe(before.contentHash);
		expect(after.diskHash).not.toBe(before.contentHash);
	});

	it("says why a file owned by nobody, or by no one on disk, has nothing to walk", async () => {
		expect(await session.resolveChain("notes.unknownext", ["x"])).toMatchObject({
			kind: "none",
			reason: "unclaimed",
			detail: "unclaimed",
		});
		expect(await session.resolveChain("ghost.ts", ["x"])).toMatchObject({
			kind: "none",
			reason: "missing",
			contentHash: null,
			diskHash: null,
		});
		expect(await session.awaitIndexed("notes.unknownext")).toEqual({
			indexed: false,
			reason: "unclaimed",
			detail: "unclaimed",
		});
		expect(await session.awaitIndexed("ghost.ts")).toEqual({
			indexed: false,
			reason: "missing",
			detail: "file is gone",
		});
	});

	it("reads a file written after the scan once awaitIndexed brings it in", async () => {
		writeFileSync(path.join(workspace, "late.ts"), "export function late(): void {}\n");

		expect(await session.resolveChain("late.ts", ["late"])).toMatchObject({
			kind: "none",
			reason: "unread",
			contentHash: null,
			diskHash: expect.any(String),
		});
		expect(await session.awaitIndexed("late.ts")).toEqual({ indexed: true });
		expect(await exact("late.ts", ["late"])).toMatchObject({ kind: "function", range: { start: { line: 0 } } });
		// Current now, which is still an indexed answer.
		expect(await session.awaitIndexed("late.ts")).toEqual({ indexed: true });
	});

	it("answers a file that cannot be read as a content refusal, never as the daemon's trouble", async () => {
		writeFileSync(path.join(workspace, "blob.ts"), Buffer.from([0x00, 0x01, 0x02]));

		expect(await session.awaitIndexed("blob.ts")).toMatchObject({ indexed: false, reason: "binary" });
		expect(await session.resolveChain("blob.ts", ["x"])).toMatchObject({
			kind: "none",
			reason: "binary",
			detail: expect.stringContaining("NUL"),
			diskHash: null,
		});
	});

	it("refuses a module that leaves the workspace in the grammar's words, as a refusedModule cause", async () => {
		const refused = await session.ask("refactorTrack", { module: "../secret.md" }).then(
			() => null,
			(error: unknown) => error,
		);
		expect(refused).toBeInstanceOf(DaemonError);
		expect((refused as DaemonError).cause).toBe("refusedModule");
		expect((refused as DaemonError).message).toMatch(/refactorTrack refused: module: module path must not escape/);
		expect((refused as DaemonError).message).not.toMatch(/"code"/);
	});

	it("answers a file the provider cannot parse as parseFailed, with the provider's reason", async () => {
		writeFileSync(path.join(workspace, "broken.cs"), "class Broken { /* never closed\n");

		const brought = await session.awaitIndexed("broken.cs");
		expect(brought.indexed).toBe(false);
		if (brought.indexed) return;
		expect(brought.reason).toBe("parseFailed");
		expect(await session.resolveChain("broken.cs", ["x"])).toMatchObject({ kind: "none", reason: "parseFailed" });
	});

	it("keeps the rows of a file whose later parse failed, and says the disk moved on", async () => {
		writeFileSync(path.join(workspace, "keep.cs"), "class Keep { }\n");
		expect(await session.awaitIndexed("keep.cs")).toEqual({ indexed: true });
		const held = await session.resolveChain("keep.cs", ["Keep"]);
		expect(held.kind).toBe("exact");

		writeFileSync(path.join(workspace, "keep.cs"), "class Keep { /* never closed\n");
		expect(await session.awaitIndexed("keep.cs")).toMatchObject({ indexed: false, reason: "parseFailed" });
		const after = await session.resolveChain("keep.cs", ["Keep"]);
		expect(after.kind).toBe("exact");
		expect(after.contentHash).toBe(held.contentHash);
		expect(after.diskHash).not.toBe(held.contentHash);
	});

	it("answers a file past the size cap as tooLarge, from the read alone", async () => {
		writeFileSync(path.join(workspace, "huge.ts"), Buffer.alloc(OVERSIZED, 0x20));

		expect(await session.awaitIndexed("huge.ts")).toMatchObject({ indexed: false, reason: "tooLarge" });
		expect(await session.resolveChain("huge.ts", ["x"])).toMatchObject({
			kind: "none",
			reason: "tooLarge",
			diskHash: null,
		});
	});

	it("answers a module the workspace's scope denies as unclaimed, naming the scope", async () => {
		expect(await session.resolveChain("denied.ts", ["denied"])).toMatchObject({
			kind: "none",
			reason: "unclaimed",
			detail: "denied by scope",
		});
		expect(await session.awaitIndexed("denied.ts")).toMatchObject({ indexed: false, reason: "unclaimed" });
	});

	it("hands every ambiguous candidate a chain that resolves to it alone", async () => {
		const answer = await session.resolveChain("app.ts", ["run"]);
		expect(answer.kind).toBe("ambiguous");
		if (answer.kind !== "ambiguous") return;
		for (const candidate of answer.candidates) {
			expect((await exact("app.ts", candidate.segments)).symbolId, candidate.segments.join(" > ")).toBe(
				candidate.symbolId,
			);
		}
	});

	it("reads a run of segments as a dotted name in full, and walks a scope an id names without declaring it", async () => {
		const compute = await exact("Service.cs", ["Acme", "Services", "Service", "Compute"]);
		expect(compute.containerPath).toEqual(["Acme.Services", "Service"]);

		const explicit = await exact("Service.cs", ["Service", "IRun", "Go"]);
		expect(explicit.containerPath).toEqual(["Acme.Services", "Service", "IRun"]);
		expect((await exact("Service.cs", ["Service", "IRun::Go"])).symbolId).toBe(explicit.symbolId);
		expect((await exact("Service.cs", explicit.segments)).symbolId).toBe(explicit.symbolId);
	});

	it("never reaches a dotted heading by a proper prefix of its name", async () => {
		expect((await exact("README.md", ["Node.js setup"])).kind).toBe("heading");
		expect(await session.resolveChain("README.md", ["Node"])).toMatchObject({ kind: "none", reason: "noMatch" });
		expect(await session.resolveChain("README.md", ["Node.js"])).toMatchObject({ kind: "none", reason: "noMatch" });
	});
});
