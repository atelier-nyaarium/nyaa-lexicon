import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { BUN_FLOOR, bunExecutable, defaultProbe, refuseRuntime, runtimeVerdict } from "../runtime";

describe("runtimeVerdict", () => {
	it("accepts bun at the floor and above it", () => {
		expect(runtimeVerdict({ bun: BUN_FLOOR })).toEqual({ kind: "bun", version: BUN_FLOOR });
		expect(runtimeVerdict({ bun: "1.4.7" })).toEqual({ kind: "bun", version: "1.4.7" });
		expect(runtimeVerdict({ bun: "2.0.0" })).toEqual({ kind: "bun", version: "2.0.0" });
	});

	it("names the floor for a bun below it, a prerelease of the floor included", () => {
		expect(runtimeVerdict({ bun: "1.3.9" })).toEqual({ kind: "belowFloor", version: "1.3.9", floor: BUN_FLOOR });
		expect(runtimeVerdict({ bun: `${BUN_FLOOR}-canary.12` })).toEqual({
			kind: "belowFloor",
			version: `${BUN_FLOOR}-canary.12`,
			floor: BUN_FLOOR,
		});
		expect(runtimeVerdict({ bun: "1.4.1-canary.3" })).toEqual({ kind: "bun", version: "1.4.1-canary.3" });
		expect(runtimeVerdict({ bun: `${BUN_FLOOR}+7` })).toEqual({ kind: "bun", version: `${BUN_FLOOR}+7` });
	});

	it("names the runtime when it is not bun at all, or claims a version that is not one", () => {
		expect(runtimeVerdict({ node: "22.5.1" })).toEqual({ kind: "notBun", runtime: "node 22.5.1" });
		expect(runtimeVerdict({})).toEqual({ kind: "notBun", runtime: "node unknown" });
		expect(runtimeVerdict({ bun: "garbage" })).toEqual({ kind: "notBun", runtime: "bun garbage" });
	});

	it("judges the process it runs in", () => {
		expect(runtimeVerdict().kind).toBe("bun");
	});
});

describe("refuseRuntime", () => {
	it("is silent on an accepted bun", () => {
		expect(refuseRuntime("the lexicon daemon", { bun: BUN_FLOOR })).toBeNull();
		expect(refuseRuntime("the lexicon daemon")).toBeNull();
	});

	it("says what was launched, what it needs and what it got", () => {
		expect(refuseRuntime("the lexicon daemon", { bun: "1.3.9" })).toBe(
			`the lexicon daemon needs bun ${BUN_FLOOR} or newer; this is bun 1.3.9`,
		);
		expect(refuseRuntime("the lexicon daemon", { node: "20.1.0" })).toBe(
			`the lexicon daemon runs on bun ${BUN_FLOOR} or newer; this is node 20.1.0`,
		);
	});
});

describe("bunExecutable", () => {
	/** A probe answering per executable; null is "could not run it". */
	function probing(answers: Record<string, string | null>) {
		const asked: string[] = [];
		const probe = async (executable: string) => {
			asked.push(executable);
			return answers[executable] ?? null;
		};
		return { asked, probe };
	}

	it("takes the running bun first, without looking further", async () => {
		const { asked, probe } = probing({ "/opt/bun/bin/bun": BUN_FLOOR });
		expect(
			await bunExecutable({ platform: "linux", env: { PATH: "" }, execPath: "/opt/bun/bin/bun" }, probe),
		).toEqual({
			kind: "bun",
			executable: "/opt/bun/bin/bun",
			version: BUN_FLOOR,
		});
		expect(asked).toEqual(["/opt/bun/bin/bun"]);
	});

	it("falls back to bun on PATH, then to BUN_INSTALL, when the running process is not bun", async () => {
		const onPath = probing({ bun: "1.4.2" });
		expect(
			await bunExecutable({ platform: "linux", env: { PATH: "" }, execPath: "/usr/bin/node" }, onPath.probe),
		).toMatchObject({
			kind: "bun",
			executable: "bun",
			version: "1.4.2",
		});

		const installed = probing({ "/home/u/.bun/bin/bun": "1.4.3" });
		const host = {
			platform: "linux" as const,
			env: { PATH: "", BUN_INSTALL: "/home/u/.bun" },
			execPath: "/usr/bin/node",
		};
		expect(await bunExecutable(host, installed.probe)).toMatchObject({
			executable: "/home/u/.bun/bin/bun",
			version: "1.4.3",
		});
		expect(installed.asked).toEqual(["bun", "/home/u/.bun/bin/bun"]);
	});

	it("names a missing, a malformed and a below-floor bun", async () => {
		expect(
			await bunExecutable({ platform: "linux", env: { PATH: "" }, execPath: "/usr/bin/node" }, async () => null),
		).toEqual({
			kind: "missing",
			executable: "bun",
		});
		expect(
			await bunExecutable({ platform: "win32", env: { PATH: "" }, execPath: "C:\\node.exe" }, async () => null),
		).toEqual({
			kind: "missing",
			executable: "bun.exe",
		});
		expect(
			await bunExecutable({ platform: "linux", env: { PATH: "" }, execPath: "/x/bun" }, async () => "garbage"),
		).toEqual({
			kind: "malformed",
			executable: "/x/bun",
			version: "garbage",
		});
		expect(
			await bunExecutable({ platform: "linux", env: { PATH: "" }, execPath: "/x/bun" }, async () => "1.3.9"),
		).toEqual({
			kind: "belowFloor",
			executable: "/x/bun",
			version: "1.3.9",
			floor: BUN_FLOOR,
		});
	});

	it("resolves the first regular PATH bun before probing", async () => {
		const root = mkdtempSync(path.join(tmpdir(), "lexicon-runtime-"));
		try {
			const first = path.join(root, "first");
			const second = path.join(root, "second");
			mkdirSync(first);
			mkdirSync(second);
			writeFileSync(path.join(first, "bun"), "fake");
			writeFileSync(path.join(second, "bun"), "fake");
			const { asked, probe } = probing({ [path.join(first, "bun")]: "1.4.2" });
			expect(
				await bunExecutable(
					{ platform: "linux", env: { PATH: `${first}:${second}` }, execPath: "/usr/bin/node" },
					probe,
				),
			).toEqual({
				kind: "bun",
				executable: path.join(first, "bun"),
				version: "1.4.2",
			});
			expect(asked).toEqual([path.join(first, "bun")]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("defaultProbe", () => {
	it("kills a probe that traps its own termination signal, within the given timeout", async () => {
		const root = mkdtempSync(path.join(tmpdir(), "lexicon-probe-trap-"));
		try {
			const script = path.join(root, "trapping.sh");
			writeFileSync(script, "#!/bin/sh\ntrap '' TERM\nsleep 999\n", { mode: 0o755 });

			const result = await defaultProbe(script, 500);

			expect(result).toBeNull();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("answers the version for a well-behaved executable", async () => {
		expect(await defaultProbe(process.execPath, 10_000)).not.toBeNull();
	});
});
