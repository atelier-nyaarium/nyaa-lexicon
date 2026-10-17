import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DAEMON_METHODS, MAX_SOURCE_BYTES } from "@nyaa-lexicon/protocol";
import { Database } from "../database";
import { daemonHandlers, gateOf } from "../dispatch";
import { sourceReader } from "../sourceRead";
import { IndexStore } from "../store";
import { TransactionManager } from "../transactions";
import { gitAdd, gitCommit, gitConfig, gitInit } from "./gitFixture";
import {
	TestLexiconService as LexiconService,
	TestProviderSupervisor as ProviderSupervisor,
	testPolicy,
} from "./testPolicy";

////////////////////////////////
//  Helpers

function filesUnder(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const file = path.join(directory, entry.name);
		return entry.isDirectory() ? filesUnder(file) : entry.isFile() ? [file] : [];
	});
}

function containsBytes(directory: string, needles: readonly Buffer[]): boolean {
	return filesUnder(directory).some((file) => {
		const contents = readFileSync(file);
		return needles.some((needle) => contents.includes(needle));
	});
}

describe("moduleSecretModes answers", () => {
	let root: string;
	let workspace: string;
	let store: IndexStore;
	let supervisor: ProviderSupervisor;
	let service: LexiconService;
	let handlers: ReturnType<typeof daemonHandlers>;
	let reads: string[];

	beforeAll(async () => {
		root = mkdtempSync(path.join(tmpdir(), "lexicon-secret-modes-"));
		workspace = path.join(root, "workspace");
		mkdirSync(workspace);
		const files: Record<string, string> = {
			".env": "TRACKED_VALUE=hidden\n",
			"package.json": '{"name":"plain-package"}\n',
			"secret.yaml": "kind: Secret\ndata:\n  token: HIDDEN_TOKEN\n",
			"deployment.yaml": "kind: Deployment\ndata:\n  note: PUBLIC_NOTE\n",
			"credentials.json": '{"password":"HIDDEN_PASSWORD"}\n',
			"omit.json": '{"password":"OMITTED_PASSWORD"}\n',
			"denied/config.json": '{"password":"DENIED_PASSWORD"}\n',
			"plain.txt": "plain text\n",
			"lexicon.json": JSON.stringify({ secrets: { "**/omit.json": "omit" }, deny: ["denied/**"] }),
		};
		for (const [module, text] of Object.entries(files)) {
			const file = path.join(workspace, module);
			mkdirSync(path.dirname(file), { recursive: true });
			writeFileSync(file, text);
		}
		await gitInit(workspace);
		await gitConfig(workspace, "commit.gpgsign", "false");
		await gitAdd(workspace, "-A");
		await gitCommit(workspace, "Add secret mode fixtures");
		writeFileSync(path.join(workspace, ".env.local"), "UNTRACKED_VALUE=hidden\n");

		store = IndexStore.open(path.join(root, "index.sqlite")).store;
		supervisor = new ProviderSupervisor();
		reads = [];
		const policy = testPolicy(workspace);
		const read = sourceReader(workspace);
		service = new LexiconService(
			store,
			supervisor,
			(module) => {
				reads.push(module);
				return read(module);
			},
			workspace,
			undefined,
			policy,
		);
		const refactor = { transactions: new TransactionManager(store, workspace, policy) };
		handlers = daemonHandlers(service, refactor);
		await service.currentScope();
		reads = [];
	}, 120_000);

	afterAll(() => {
		supervisor?.stopAll();
		store?.close();
		if (root !== undefined) rmSync(root, { recursive: true, force: true });
	});

	it("returns text-aware modes without exposing file details", async () => {
		const params = DAEMON_METHODS.moduleSecretModes.request.parse({
			modules: [
				".env",
				".env.local",
				"package.json",
				"secret.yaml",
				"deployment.yaml",
				"credentials.json",
				"omit.json",
				"denied/config.json",
				"plain.txt",
				"missing.yaml",
				"not-here/credentials.json",
			],
		});
		const raw = await handlers.moduleSecretModes.run(params, gateOf(service.gate));
		const parsed = DAEMON_METHODS.moduleSecretModes.response.parse(raw);

		expect(raw).toEqual(parsed);
		expect(parsed).toEqual([
			{ module: ".env", mode: "plain" },
			{ module: ".env.local", mode: "redact" },
			{ module: "package.json", mode: "plain" },
			{ module: "secret.yaml", mode: "redact" },
			{ module: "deployment.yaml", mode: "plain" },
			{ module: "credentials.json", mode: "redact" },
			{ module: "omit.json", mode: "omit" },
			{ module: "denied/config.json", mode: "omit" },
			{ module: "plain.txt", mode: "plain" },
			{ module: "missing.yaml", mode: "plain" },
			{ module: "not-here/credentials.json", mode: "redact" },
		]);
		expect(reads.sort()).toEqual(["deployment.yaml", "missing.yaml", "package.json", "secret.yaml"]);
		expect(service.policy.current.answer("deployment.yaml").kind).toBe("matchers");
	});

	it("judges supplied text instead of the disk copy", async () => {
		const secretText = "kind: Secret\ndata:\n  token: EDITOR_ONLY_SECRET_VALUE\n";
		const deploymentText = "kind: Deployment\nmetadata:\n  name: editor-buffer\n";
		const disk = await handlers.moduleSecretModes.run(
			DAEMON_METHODS.moduleSecretModes.request.parse({ modules: ["deployment.yaml", "secret.yaml"] }),
			gateOf(service.gate),
		);
		expect(disk).toEqual([
			{ module: "deployment.yaml", mode: "plain" },
			{ module: "secret.yaml", mode: "redact" },
		]);

		reads = [];
		const params = DAEMON_METHODS.moduleSecretModes.request.parse({
			modules: [
				{ module: "deployment.yaml", text: secretText },
				{ module: "secret.yaml", text: deploymentText },
			],
		});
		const answer = DAEMON_METHODS.moduleSecretModes.response.parse(
			await handlers.moduleSecretModes.run(params, gateOf(service.gate)),
		);

		expect(answer).toEqual([
			{ module: "deployment.yaml", mode: "redact" },
			{ module: "secret.yaml", mode: "plain" },
		]);
		expect(reads).toEqual([]);
		expect(JSON.stringify(answer)).not.toContain("EDITOR_ONLY_SECRET_VALUE");
		const next = await handlers.moduleSecretModes.run(
			DAEMON_METHODS.moduleSecretModes.request.parse({
				modules: [{ module: "deployment.yaml", text: deploymentText }],
			}),
			gateOf(service.gate),
		);
		expect(next).toEqual([{ module: "deployment.yaml", mode: "plain" }]);
	});

	it("keeps whole-file dotenv rules independent of supplied text", async () => {
		const disk = await handlers.moduleSecretModes.run(
			DAEMON_METHODS.moduleSecretModes.request.parse({ modules: [".env.local"] }),
			gateOf(service.gate),
		);
		const answer = await handlers.moduleSecretModes.run(
			DAEMON_METHODS.moduleSecretModes.request.parse({
				modules: [{ module: ".env.local", text: "kind: Deployment\n" }],
			}),
			gateOf(service.gate),
		);

		expect(disk).toEqual([{ module: ".env.local", mode: "redact" }]);
		expect(answer).toEqual([{ module: ".env.local", mode: "redact" }]);
	});

	it("leaves no supplied text in store files, logs, answers, or diagnostics", async () => {
		const secretText = "kind: Secret\nstringData:\n  token: BUFFER_RESIDUE_SECRET_VALUE\n";
		const secretBytes = Buffer.from(secretText, "utf8");
		const marker = Buffer.from("BUFFER_RESIDUE_SECRET_VALUE", "utf8");
		const planted = path.join(root, "control.log");
		writeFileSync(planted, secretBytes);
		expect(containsBytes(root, [secretBytes, marker])).toBe(true);
		rmSync(planted);

		const logged: string[] = [];
		const originalLog = console.log;
		console.log = (...values: unknown[]) => logged.push(values.map(String).join(" "));
		let answer: unknown;
		try {
			answer = await handlers.moduleSecretModes.run(
				DAEMON_METHODS.moduleSecretModes.request.parse({
					modules: [{ module: "deployment.yaml", text: secretText }],
				}),
				gateOf(service.gate),
			);
		} finally {
			console.log = originalLog;
		}
		const checkpoint = Database.open(path.join(root, "index.sqlite"));
		checkpoint.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
		checkpoint.close();
		const diagnostics = JSON.stringify(service.indexStatus());

		expect(answer).toEqual([{ module: "deployment.yaml", mode: "redact" }]);
		expect(JSON.stringify(answer)).not.toContain("BUFFER_RESIDUE_SECRET_VALUE");
		expect(logged.join("\n")).not.toContain("BUFFER_RESIDUE_SECRET_VALUE");
		expect(diagnostics).not.toContain("BUFFER_RESIDUE_SECRET_VALUE");
		expect(containsBytes(root, [secretBytes, marker])).toBe(false);
	});

	it("fails closed when entry or request text exceeds its byte cap", async () => {
		const underEntryCap = `#${"x".repeat(MAX_SOURCE_BYTES - 2)}`;
		const entryControl = await handlers.moduleSecretModes.run(
			DAEMON_METHODS.moduleSecretModes.request.parse({
				modules: [{ module: "oversized.yaml", text: underEntryCap }],
			}),
			gateOf(service.gate),
		);
		const entryOverCap = `#${"x".repeat(MAX_SOURCE_BYTES)}`;
		const entryAnswer = await handlers.moduleSecretModes.run(
			DAEMON_METHODS.moduleSecretModes.request.parse({
				modules: [{ module: "oversized.yaml", text: entryOverCap }],
			}),
			gateOf(service.gate),
		);
		const requestText = `#${"x".repeat(2 * 1024 * 1024 - 1)}`;
		const requestControl = await handlers.moduleSecretModes.run(
			DAEMON_METHODS.moduleSecretModes.request.parse({
				modules: [{ module: "request/0.yaml", text: requestText }],
			}),
			gateOf(service.gate),
		);
		const requestOverCap = await handlers.moduleSecretModes.run(
			DAEMON_METHODS.moduleSecretModes.request.parse({
				modules: [0, 1, 2, 3, 4].map((index) => ({ module: `request/${index}.yaml`, text: requestText })),
			}),
			gateOf(service.gate),
		);

		expect(Buffer.byteLength(underEntryCap, "utf8")).toBeLessThanOrEqual(MAX_SOURCE_BYTES);
		expect(entryControl).toEqual([{ module: "oversized.yaml", mode: "plain" }]);
		expect(entryAnswer).toEqual([{ module: "oversized.yaml", mode: "redact" }]);
		expect(requestControl).toEqual([{ module: "request/0.yaml", mode: "plain" }]);
		expect(requestOverCap).toEqual(
			[0, 1, 2, 3, 4].map((index) => ({ module: `request/${index}.yaml`, mode: "redact" })),
		);
	});
});
