import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProviderMethod } from "@nyaa-lexicon/protocol";
import { systemClock } from "../clock.js";
import { ProviderSupervisor } from "../supervisor.js";
import { Timings } from "../timings.js";
import { testPolicy } from "./testPolicy.js";

////////////////////////////////
//  Tests

describe("provider policy barrier", () => {
	it("installs each current revision before the next ask", async () => {
		const root = mkdtempSync(path.join(os.tmpdir(), "lexicon-policy-barrier-"));
		const policy = testPolicy(root);
		await policy.refresh({ kind: "startup" });
		const calls: Array<{ method: string; params: unknown }> = [];
		const provider = {
			claims: { providerId: "policy-provider" },
			child: { exitCode: null, signalCode: null, killed: false },
			connection: {
				sendRequest(method: ProviderMethod, params: unknown) {
					calls.push({ method, params });
					if (method !== "installPolicy")
						return Promise.resolve({ files: [], externalRoots: [], configFiles: [], diagnostics: [] });
					const { policy: wire } = params as { policy: { secrets: Record<string, unknown> } };
					return Promise.resolve({
						changed: Object.hasOwn(wire.secrets, "**/*.yaml") ? ["src/secret.yaml"] : [],
					});
				},
			},
			queue: { run: <T>(work: () => Promise<T>) => work() },
			policyRevision: "older-revision",
			spec: { timeoutMs: 1_000 },
			tiers: {},
			words: {},
			status: {},
			workspaceRoot: root,
			incarnation: 1,
			deaths: 0,
			stopping: false,
		};
		const supervisor = new ProviderSupervisor(systemClock, new Timings(systemClock), () => policy.current);
		(supervisor as unknown as { providers: Map<string, typeof provider> }).providers.set(
			"policy-provider",
			provider,
		);
		const invalidated: string[][] = [];
		supervisor.policyInvalidatedFrom((_providerId, modules) => invalidated.push([...modules]));

		try {
			await supervisor.askProvider("policy-provider", "discoverProject", { workspaceRoot: root });
			expect(calls.map(({ method }) => method)).toEqual(["installPolicy", "discoverProject"]);
			expect(calls[0]?.params).toEqual({ policy: JSON.parse(JSON.stringify(policy.current.wire)) });
			expect(invalidated).toEqual([]);

			calls.length = 0;
			await supervisor.askProvider("policy-provider", "discoverProject", { workspaceRoot: root });
			expect(calls.map(({ method }) => method)).toEqual(["discoverProject"]);

			calls.length = 0;
			writeFileSync(
				path.join(root, "lexicon.json"),
				JSON.stringify({ secrets: { "**/*.yaml": { token: "omit" } } }),
			);
			const change = await policy.refresh({ kind: "startup" });
			supervisor.policyChanged(change);
			await supervisor.askProvider("policy-provider", "discoverProject", { workspaceRoot: root });

			expect(calls.map(({ method }) => method)).toEqual(["installPolicy", "discoverProject"]);
			expect(calls[0]?.params).toEqual({ policy: JSON.parse(JSON.stringify(policy.current.wire)) });
			expect(invalidated).toEqual([["src/secret.yaml"]]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
