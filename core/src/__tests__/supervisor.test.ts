import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProviderSupervisor } from "../supervisor";

////////////////////////////////
//  Helpers

const REFERENCE = path.join(
	import.meta.dirname,
	"..",
	"..",
	"..",
	"protocol",
	"src",
	"conformance",
	"referenceProvider.ts",
);

let supervisor: ProviderSupervisor;

function start() {
	supervisor = new ProviderSupervisor();
	// A real directory: the workspace root is the provider's cwd, and spawn refuses a missing one.
	return supervisor.start({ command: ["bun", "run", REFERENCE], timeoutMs: 15_000 }, tmpdir());
}

afterEach(() => {
	supervisor?.stopAll();
});

////////////////////////////////
//  Tests

describe("starting a provider", () => {
	it("records what the provider claims", async () => {
		const claims = await start();
		expect(claims).toMatchObject({ providerId: "reference-provider", language: "reference" });
		expect(supervisor.running()).toHaveLength(1);
	}, 30_000);

	it("records the tiers it declared, so a bulk pass can skip what it would refuse", async () => {
		await start();
		expect(supervisor.declares("reference-provider", "declarations")).toBe(true);
		expect(supervisor.declares("reference-provider", "types")).toBe(false);
		expect(supervisor.declares("nobody", "declarations")).toBe(false);
	}, 30_000);

	it("fails a provider that cannot spawn, rather than crashing the daemon", async () => {
		supervisor = new ProviderSupervisor();
		await expect(
			supervisor.start({ command: ["lexicon-no-such-binary"], timeoutMs: 5_000 }, tmpdir()),
		).rejects.toThrow();
	}, 30_000);
});

describe("asking through the supervisor", () => {
	it("routes a claimed module to its provider and validates the answer", async () => {
		await start();
		const facts = await supervisor.ask("a.ref", "parseFile", {
			module: "a.ref",
			contentHash: "h1",
			text: "export class Cart {}\n",
		});
		expect(facts.declarations.map((d) => d.name)).toEqual(["Cart"]);
	}, 30_000);

	it("refuses a module nobody claims rather than guessing a provider", async () => {
		await start();
		await expect(
			supervisor.ask("README.md", "parseFile", { module: "README.md", contentHash: "h", text: "" }),
		).rejects.toThrow(/no provider owns/);
	}, 30_000);

	it("refuses a named provider that is not running", async () => {
		await start();
		await expect(supervisor.askProvider("ghost", "shutdown", {})).rejects.toThrow(/not running/);
	}, 30_000);

	it("serializes concurrent asks and still returns each its own answer", async () => {
		await start();
		const texts = ["export class A {}\n", "export class B {}\n", "export class C {}\n"];
		const answers = await Promise.all(
			texts.map((text, i) =>
				supervisor.ask(`f${i}.ref`, "parseFile", { module: `f${i}.ref`, contentHash: `h${i}`, text }),
			),
		);
		expect(answers.map((a) => a.declarations[0]?.name)).toEqual(["A", "B", "C"]);
	}, 30_000);
});

describe("when a provider dies", () => {
	it("rejects further asks rather than hanging every caller until its own timeout", async () => {
		await start();
		supervisor.stop("reference-provider");

		await expect(
			supervisor.askProvider("reference-provider", "parseFile", { module: "a.ref", contentHash: "h", text: "" }),
		).rejects.toThrow(/not running/);
		expect(supervisor.running()).toEqual([]);
	}, 30_000);

	// A real SIGKILL, because a shutdown request leaves the reference provider running and an
	// earlier version of this test passed without any death ever happening.
	it("respawns after an unexpected death and answers from the new process", async () => {
		await start();
		const firstPid = supervisor.pidOf("reference-provider");
		expect(firstPid).not.toBeNull();
		process.kill(firstPid as number, "SIGKILL");

		const parse = () =>
			supervisor.ask("a.ref", "parseFile", {
				module: "a.ref",
				contentHash: "h2",
				text: "export class Cart {}\n",
			});
		const deadline = Date.now() + 20_000;
		let answered: Awaited<ReturnType<typeof parse>> | null = null;
		while (answered === null && Date.now() < deadline) {
			answered = await parse().catch(() => null);
			if (answered === null) await new Promise((resolve) => setTimeout(resolve, 250));
		}

		expect(answered?.declarations.map((declaration) => declaration.name)).toEqual(["Cart"]);
		// The pid moving is the proof a NEW process answered, not a survivor.
		expect(supervisor.pidOf("reference-provider")).not.toBe(firstPid);
		expect(supervisor.running()).toHaveLength(1);
	}, 30_000);
});
