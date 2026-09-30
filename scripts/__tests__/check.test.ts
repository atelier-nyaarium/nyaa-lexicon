import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { check } from "../check";
import { git } from "../child";

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

const BUILD = `
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
mkdirSync("dist", { recursive: true });
writeFileSync("dist/bundle.js", readFileSync("src.txt"));
`;

/** Passes only against a bundle of the current source. */
const TEST = `
import { existsSync, readFileSync } from "node:fs";
if (existsSync("fail.txt")) process.exit(1);
process.exit(readFileSync("dist/bundle.js", "utf8") === readFileSync("src.txt", "utf8") ? 0 : 1);
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

/** Source newer than the committed bundle. */
function checkout(): string {
	const root = mkdtempSync(path.join(tmpdir(), "lexicon-check-test-"));
	roots.push(root);
	git(root, ["init", "--quiet", "-b", "main"]);
	const scripts = { build: "bun ./make.ts", test: "bun ./tests.ts", lint: "bun -e 0", corpora: "bun -e 0" };
	write(root, "package.json", JSON.stringify({ scripts }));
	write(root, "make.ts", BUILD);
	write(root, "tests.ts", TEST);
	write(root, "src.txt", "one\n");
	write(root, "dist/bundle.js", "one\n");
	git(root, ["add", "--all"]);
	git(root, ["commit", "--quiet", "-m", "Build 1.0.0"]);
	write(root, "src.txt", "two\n");
	return root;
}

////////////////////////////////
//  Tests

test("check tests a bundle of the current source and puts the committed dist/ back, passing or failing; a dist/ that differs is refused and kept", () => {
	const outcome = (root: string) => {
		const passed = check(root, "ignore").find((result) => result.part === "test")?.ok;
		return { passed, bundle: readFileSync(path.join(root, "dist/bundle.js"), "utf8") };
	};
	const fresh = checkout();
	const failing = checkout();
	write(failing, "fail.txt", "\n");
	const edited = checkout();
	// A bundle that would pass, so only the refusal fails.
	write(edited, "dist/bundle.js", "two\n");

	expect({ fresh: outcome(fresh), failing: outcome(failing), edited: outcome(edited) }).toEqual({
		fresh: { passed: true, bundle: "one\n" },
		failing: { passed: false, bundle: "one\n" },
		edited: { passed: false, bundle: "two\n" },
	});
});
