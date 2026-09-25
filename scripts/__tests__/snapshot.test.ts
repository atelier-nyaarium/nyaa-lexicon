import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { git } from "../child";
import { withBuiltDist } from "../dist";
import { SNAPSHOT_PREFIX, SNAPSHOT_REF, type Snapshot, snapshot } from "../snapshot";

////////////////////////////////
//  Helpers

/** Isolate tests from user Git config. */
const GIT_ENV: Record<string, string> = {
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_AUTHOR_NAME: "Fixture",
	GIT_AUTHOR_EMAIL: "fixture@example.com",
	GIT_COMMITTER_NAME: "Fixture",
	GIT_COMMITTER_EMAIL: "fixture@example.com",
};

/** Write build output, then fail if `fail.txt` exists. */
const BUILD = `
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
mkdirSync("dist", { recursive: true });
writeFileSync("dist/bundle.js", "built\\n");
writeFileSync("dist/extra.js", "extra\\n");
if (existsSync("fail.txt")) process.exit(1);
`;

const saved: Record<string, string | undefined> = {};
const roots: string[] = [];

beforeAll(() => {
	for (const [name, value] of Object.entries(GIT_ENV)) {
		saved[name] = process.env[name];
		process.env[name] = value;
	}
});

afterAll(() => {
	for (const [name, value] of Object.entries(saved)) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function write(root: string, file: string, text: string): void {
	mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
	writeFileSync(path.join(root, file), text);
}

function read(root: string, file: string): string {
	return readFileSync(path.join(root, file), "utf8");
}

function checkout(): string {
	const root = mkdtempSync(path.join(tmpdir(), "lexicon-snapshot-test-"));
	roots.push(root);
	git(root, ["init", "--quiet", "-b", "main"]);
	write(root, "package.json", JSON.stringify({ scripts: { build: "bun ./make.ts" } }));
	write(root, "make.ts", BUILD);
	write(root, "dist/bundle.js", "released\n");
	write(root, "src.txt", "one\n");
	git(root, ["add", "--all"]);
	git(root, ["commit", "--quiet", "-m", "Build 1.0.0"]);
	return root;
}

////////////////////////////////
//  Tests

test("the snapshot command prints one JSON line for a commit of the working tree, leaving the checkout as it was", () => {
	const root = checkout();
	write(root, "staged.txt", "staged\n");
	git(root, ["add", "staged.txt"]);
	write(root, "src.txt", "two\n");
	write(root, "added.txt", "new\n");
	const statusBefore = git(root, ["status", "--porcelain"]);

	const cli = spawnSync("bun", [path.join(import.meta.dirname, "..", "snapshot.ts"), root], { encoding: "utf8" });
	const lines = cli.stdout.split("\n").filter((line) => line !== "");
	const made = JSON.parse(lines[0] ?? "{}") as Snapshot;
	const inCommit = (file: string) => git(root, ["show", `${made.sha}:${file}`]);

	expect({
		exit: cli.status,
		stdoutLines: lines.length,
		subject: made.subject.startsWith(SNAPSHOT_PREFIX),
		ref: made.ref === SNAPSHOT_REF && git(root, ["rev-parse", SNAPSHOT_REF]) === made.sha,
		parent: git(root, ["rev-parse", `${made.sha}^`]) === git(root, ["rev-parse", "HEAD"]),
		files: ["src.txt", "added.txt", "staged.txt", "dist/bundle.js"].map(inCommit),
		checkout: { status: git(root, ["status", "--porcelain"]) === statusBefore, dist: read(root, "dist/bundle.js") },
	}).toEqual({
		exit: 0,
		stdoutLines: 1,
		subject: true,
		ref: true,
		parent: true,
		files: ["two", "new", "staged", "built"],
		checkout: { status: true, dist: "released\n" },
	});
});

test("a checkout with no commit is refused before anything builds", () => {
	const root = mkdtempSync(path.join(tmpdir(), "lexicon-snapshot-test-"));
	roots.push(root);
	git(root, ["init", "--quiet", "-b", "main"]);
	let refused = false;
	try {
		snapshot(root);
	} catch {
		refused = true;
	}
	expect({ refused, dist: existsSync(path.join(root, "dist")) }).toEqual({ refused: true, dist: false });
});

test("withBuiltDist puts the committed dist/ back when the use or the build fails, and refuses a dist/ that differs", () => {
	const root = checkout();
	const outcome = (action: () => void) => {
		try {
			action();
			return "ran";
		} catch {
			return "threw";
		}
	};

	const useFailed = outcome(() =>
		withBuiltDist([root], () => {
			throw new Error("use failed");
		}),
	);
	const afterUse = git(root, ["status", "--porcelain"]);
	write(root, "fail.txt", "\n");
	const buildFailed = outcome(() => withBuiltDist([root], () => undefined));
	const afterBuild = git(root, ["status", "--porcelain", "--", "dist"]);
	const restored = read(root, "dist/bundle.js");
	write(root, "dist/bundle.js", "hand edit\n");
	const differs = outcome(() => withBuiltDist([root], () => undefined));

	expect({
		useFailed,
		afterUse,
		buildFailed,
		afterBuild,
		restored,
		differs,
		kept: read(root, "dist/bundle.js"),
	}).toEqual({
		useFailed: "threw",
		afterUse: "",
		buildFailed: "threw",
		afterBuild: "",
		restored: "released\n",
		differs: "threw",
		kept: "hand edit\n",
	});
});
