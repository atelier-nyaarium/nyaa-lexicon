import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DAEMON_METHODS } from "@nyaa-lexicon/protocol";
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
});
