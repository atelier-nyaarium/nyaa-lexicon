import { describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { basename, join } from "node:path";
import { sourceFiles } from "@nyaa-lexicon/protocol";
import { parsedFiles, stringsIn } from "@nyaa-lexicon/protocol/ast";
import { markVerdict, ownMark } from "../identity";
import { processIdentity } from "../procfs";

////////////////////////////////
//  Helpers

const onLinux = process.platform === "linux" ? it : it.skip;
const onWindows = process.platform === "win32" ? it : it.skip;

/** A child's mark, read after the child has exited. */
async function deadMark(): Promise<{ pid: number; mark: string }> {
	const script = `import { ownMark } from ${JSON.stringify(join(import.meta.dirname, "..", "identity.ts"))}; console.log(JSON.stringify({ pid: process.pid, mark: ownMark() }));`;
	const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "inherit"] });
	let out = "";
	child.stdout.on("data", (chunk: Buffer) => {
		out += chunk.toString("utf8");
	});
	await new Promise<void>((resolve) => child.once("close", () => resolve()));
	return JSON.parse(out) as { pid: number; mark: string };
}

////////////////////////////////
//  Tests

describe("process identity marks", () => {
	onLinux("marks by birth ticks: this process wears its own, a stranger's ticks do not match", () => {
		const mark = ownMark();
		expect({
			mark,
			own: markVerdict(process.pid, mark),
			stranger: markVerdict(process.pid, "1"),
			unmarked: markVerdict(process.pid, undefined),
		}).toEqual({ mark: processIdentity(process.pid)?.startTicks, own: true, stranger: false, unmarked: null });
	});

	onWindows(
		"marks by a held pipe named for the pid; another pid's pipe and an exited holder do not match",
		async () => {
			const mark = ownMark() ?? "";
			const dead = await deadMark();
			expect({
				shape: mark.startsWith(`pipe:nyaa-lexicon-${process.pid}-`),
				own: markVerdict(process.pid, mark),
				again: ownMark() === mark,
				borrowed: markVerdict(process.pid + 1, mark),
				exited: markVerdict(dead.pid, dead.mark),
				unmarked: markVerdict(process.pid, undefined),
			}).toEqual({ shape: true, own: true, again: true, borrowed: false, exited: false, unmarked: null });
		},
	);
});

describe("only identity.ts names Windows pipes", () => {
	const CLIENT_SRC = join(import.meta.dirname, "..");
	const SWEPT = [CLIENT_SRC, join(CLIENT_SRC, "..", "..", "core", "src"), join(CLIENT_SRC, "..", "..", "adapters")];
	const SKIP = ["__tests__", "dist", "node_modules"];
	const namesPipes = (source: Parameters<typeof stringsIn>[0]) =>
		stringsIn(source).some(({ text }) => text.includes("\\\\.\\pipe\\"));

	it("sees the owner and no other module", () => {
		for (const dir of SWEPT) expect(sourceFiles(dir, SKIP).length, dir).toBeGreaterThan(0);
		const naming = SWEPT.flatMap((dir) => parsedFiles(dir, SKIP))
			.filter(({ source }) => namesPipes(source))
			.map(({ file }) => basename(file));
		expect(naming, "Ask identity.ts for a mark rather than naming a pipe.").toEqual(["identity.ts"]);
	});
});
