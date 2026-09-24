import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	describeScope,
	fileScopeFor,
	generatedVerdicts,
	gitFiles,
	gitIgnored,
	globToRegExp,
	includedFiles,
	isExternalModule,
	runGit,
	submoduleRoots,
} from "../fileScope";
import { fakeClock } from "./fakeClock";
import { gitAdd, gitClone, gitCommit, gitConfig, gitInit, gitSubmoduleAdd } from "./gitFixture";

////////////////////////////////
//  Helpers

const roots: string[] = [];

function write(root: string, module: string, text = "x\n") {
	const full = path.join(root, module);
	mkdirSync(path.dirname(full), { recursive: true });
	writeFileSync(full, text);
}

/** A real repository, because the whole point is that git answers rather than we do. */
async function repo(files: Record<string, string>, ignore?: string): Promise<string> {
	const root = mkdtempSync(path.join(tmpdir(), "lexicon-scope-"));
	roots.push(root);
	await gitInit(root);
	for (const [module, text] of Object.entries(files)) write(root, module, text);
	if (ignore !== undefined) write(root, ".gitignore", ignore);
	return root;
}

/** A second, separately committed repository, so it can be added as a real submodule of another. */
async function submoduleSource(): Promise<string> {
	const root = mkdtempSync(path.join(tmpdir(), "lexicon-submodule-src-"));
	roots.push(root);
	await gitInit(root);
	write(root, "inner.txt");
	await gitAdd(root, "inner.txt");
	await gitCommit(root, "seed");
	return root;
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

////////////////////////////////
//  Tests

describe("globs", () => {
	it("keeps * inside one segment and lets ** cross them", () => {
		expect(globToRegExp("src/*.ts").test("src/a.ts")).toBe(true);
		expect(globToRegExp("src/*.ts").test("src/deep/a.ts")).toBe(false);
		expect(globToRegExp("src/**/*.ts").test("src/deep/a.ts")).toBe(true);
	});

	it("matches the directory itself, so dist/** covers dist", () => {
		expect(globToRegExp("dist/**").test("dist/main.js")).toBe(true);
		expect(globToRegExp("dist/**").test("dist")).toBe(true);
	});

	it("treats a dot as a dot rather than as any character", () => {
		expect(globToRegExp("a.ts").test("axts")).toBe(false);
	});
});

describe("what git ignores", () => {
	it("names the ignored paths among those asked, and only those", async () => {
		const root = await repo({ "src/a.ts": "" }, "volumes/\n");
		write(root, "volumes/state.json", "{}");
		expect(await gitIgnored(root, ["volumes/state.json", "src/new.ts"])).toEqual(new Set(["volumes/state.json"]));
	});

	// git exits 1 for "none ignored", which is an answer and not a failure.
	it("answers an empty set when nothing asked is ignored", async () => {
		const root = await repo({ "src/a.ts": "" });
		expect(await gitIgnored(root, ["src/a.ts", "src/new.ts"])).toEqual(new Set());
	});

	it("cannot say outside a repository, rather than guessing", async () => {
		const root = mkdtempSync(path.join(tmpdir(), "lexicon-scope-"));
		roots.push(root);
		expect(await gitIgnored(root, ["a.ts"])).toBeNull();
	});
});

describe("what git says belongs to the project", () => {
	it("lists untracked files that are not ignored", async () => {
		const root = await repo({ "src/a.ts": "" });
		expect((await gitFiles(root))?.has("src/a.ts")).toBe(true);
	});

	/**
	 * The measurement that motivated all of this.
	 *
	 * One real repository had 350 files git knew about and 136,333 on disk, because a devcontainer
	 * mounts a home directory inside it. Without this the index describes somebody else's plugins
	 * while looking like it describes yours.
	 */
	it("excludes an ignored directory entirely", async () => {
		const root = await repo(
			{ "src/a.ts": "", "volumes/home/plugin.py": "", ".env": "SECRET=1" },
			"volumes/\n.env\n",
		);
		const known = await gitFiles(root);

		expect(known?.has("src/a.ts")).toBe(true);
		expect(known?.has("volumes/home/plugin.py")).toBe(false);
		expect(known?.has(".env")).toBe(false);
	});

	it("never runs the fsmonitor command a repository's own config names", async () => {
		const root = await repo({ "src/a.ts": "" });
		const marker = path.join(root, "..", `${path.basename(root)}-fsmonitor-ran`);
		roots.push(marker);
		write(root, "fsmonitor.sh", `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
		chmodSync(path.join(root, "fsmonitor.sh"), 0o755);
		await gitConfig(root, "core.fsmonitor", path.join(root, "fsmonitor.sh"));

		expect((await gitFiles(root))?.has("src/a.ts")).toBe(true);
		expect(existsSync(marker)).toBe(false);
	});

	it("answers null outside a repository, which is not the same as an empty project", async () => {
		const root = mkdtempSync(path.join(tmpdir(), "lexicon-nogit-"));
		roots.push(root);
		expect(await gitFiles(root)).toBeNull();
	});
});

describe("the scoping rule", () => {
	it("recognizes dependency and outside-workspace modules", async () => {
		const root = await repo({ "src/a.ts": "" });

		expect(isExternalModule(root, "src/a.ts")).toBe(false);
		expect(isExternalModule(root, "node_modules/pkg/index.d.ts")).toBe(true);
		expect(isExternalModule(root, "packages/node_modules_helper.ts")).toBe(false);
		expect(isExternalModule(root, "../outside.ts")).toBe(true);
	});

	it("reads generated declarations from git attributes", async () => {
		const root = await repo({
			".gitattributes": "generated/** linguist-generated\n",
			"generated/a.ts": "",
			"src/a.ts": "",
		});

		expect(await generatedVerdicts(root, ["generated/a.ts", "src/a.ts"])).toEqual(
			new Map([
				["generated/a.ts", { status: "yes" }],
				["src/a.ts", { status: "no" }],
			]),
		);
	});

	it("reads an attribute set to false as not generated, the way linguist does", async () => {
		const root = await repo({
			".gitattributes": "generated/** linguist-generated\ngenerated/keep.ts linguist-generated=false\n",
			"generated/a.ts": "",
			"generated/keep.ts": "",
		});

		expect(await generatedVerdicts(root, ["generated/a.ts", "generated/keep.ts"])).toEqual(
			new Map([
				["generated/a.ts", { status: "yes" }],
				["generated/keep.ts", { status: "no" }],
			]),
		);
	});

	it("answers unknown with the reason when there is no git to ask", async () => {
		const root = mkdtempSync(path.join(tmpdir(), "lexicon-scope-nogit-"));
		try {
			expect(await generatedVerdicts(root, ["src/a.ts"])).toEqual(
				new Map([["src/a.ts", { status: "unknown", reason: "noGit" }]]),
			);
			expect(await generatedVerdicts(root, [])).toEqual(new Map());
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("lets an explicit include override an exclude", async () => {
		const root = await repo({ "generated/a.ts": "", "src/a.ts": "" });
		const scope = await fileScopeFor(root, { include: ["generated/**"], exclude: ["generated/**"] });

		expect(scope.allows("generated/a.ts")).toBe(true);
		expect(scope.allows("src/a.ts")).toBe(true);
	});

	it("lets deny override an explicit include", async () => {
		const root = await repo({ "reference/a.ts": "", "src/a.ts": "" });
		const scope = await fileScopeFor(root, { include: ["reference/**"], deny: ["reference/**"] });

		expect(scope.allows("reference/a.ts")).toBe(false);
		expect(scope.denies("reference/a.ts")).toBe(true);
		expect(scope.denies("src/a.ts")).toBe(false);
	});

	it("marks only configured bundle globs for surface indexing", async () => {
		const root = await repo({ "opaque/runtime.js": "", "src/a.js": "" });
		const scope = await fileScopeFor(root, { bundles: ["opaque/**"] });

		expect(scope.surface("opaque/runtime.js")).toBe(true);
		expect(scope.surface("src/a.js")).toBe(false);
	});

	it("refuses an ignored file to auto-discovery", async () => {
		const root = await repo({ "src/a.ts": "", "dist/built.js": "" }, "dist/\n");
		const scope = await fileScopeFor(root);

		expect(scope.mode).toBe("git");
		expect(scope.allows("src/a.ts")).toBe(true);
		expect(scope.allows("dist/built.js")).toBe(false);
	});

	// Ignore governs DISCOVERY, not reachability. Naming a path explicitly is the whole point of
	// naming it, so it wins over the ignore that would otherwise hide it.
	it("allows an ignored file that was named explicitly", async () => {
		const root = await repo({ "src/a.ts": "", "dist/built.js": "" }, "dist/\n");
		const scope = await fileScopeFor(root, { include: ["dist/**"] });

		expect(scope.allows("dist/built.js")).toBe(true);
	});

	/**
	 * Permitting is not indexing.
	 *
	 * A provider's own discovery decides what exists, and a TypeScript one reads its tsconfig, which
	 * is exactly the list that omits the build output somebody is pointing at. Measured on a real
	 * bundle: allowing `dist/**` indexed nothing until includes ADDED candidates, after which one
	 * bundled file contributed 4,111 symbols.
	 */
	it("finds included files itself rather than waiting to be offered them", async () => {
		const root = await repo({ "src/a.ts": "", "dist/bundle.js": "", "dist/deep/more.js": "" }, "dist/\n");

		expect(includedFiles(root, ["dist/**"]).sort()).toEqual(["dist/bundle.js", "dist/deep/more.js"]);
	});

	it("walks only where a glob could match, so one include never walks the world", async () => {
		const root = await repo({ "dist/bundle.js": "", "elsewhere/huge.js": "" });
		expect(includedFiles(root, ["dist/**"])).toEqual(["dist/bundle.js"]);
	});

	it("finds nothing when nothing was included, rather than everything", async () => {
		expect(includedFiles(await repo({ "src/a.ts": "" }), [])).toEqual([]);
	});

	// Walk mode is weaker and says so, rather than presenting itself as the same guarantee.
	it("allows everything outside a repository, and reports that it is doing so", async () => {
		const root = mkdtempSync(path.join(tmpdir(), "lexicon-nogit-"));
		roots.push(root);
		const scope = await fileScopeFor(root);

		expect(scope.mode).toBe("walk");
		expect(scope.allows("anything/at/all.ts")).toBe(true);
		expect(describeScope(scope)).toContain("no git repository");
	});
});

describe("a command that never answers", () => {
	/**
	 * The reap and cap machinery itself lives in, and is proven by, boundedChild.test.ts. This is
	 * runGit's own mapping: a fake clock drives the same timeout road runGit hands it, and a
	 * non-exited BoundedResult, whichever kind, answers null.
	 */
	it("answers null when the clock's timeout fires before a wedged child exits", async () => {
		const clock = fakeClock();
		const root = mkdtempSync(path.join(tmpdir(), "lexicon-scope-hang-"));
		roots.push(root);
		let reaped = false;

		const call = runGit(clock, root, ["999"], {
			command: "sleep",
			onSpawn: (child) => {
				child.once("close", () => {
					reaped = true;
				});
			},
		});

		clock.advance(60_000);
		const result = await call;

		expect(result).toBeNull();
		expect(reaped).toBe(true);
	});

	it("answers within the timeout for a command that exits cleanly, not only for one that hangs", async () => {
		const clock = fakeClock();
		const root = mkdtempSync(path.join(tmpdir(), "lexicon-scope-quick-"));
		roots.push(root);

		const result = await runGit(clock, root, ["0"], { command: "sleep" });

		expect(result).toEqual({ code: 0, stdout: "" });
	});
});

describe("submodules", () => {
	/**
	 * `git check-ignore --stdin` and `check-attr --stdin` refuse a pathspec reaching into a
	 * submodule, and the refusal is of the WHOLE batch: git saw exactly this, `fatal: Pathspec
	 * '...' is in submodule '...'`, over a path this scope reader's own includes walked into.
	 */
	it("lists a submodule's own root, and nothing beneath it", async () => {
		const source = await submoduleSource();
		const root = await repo({ "src/a.ts": "" });
		await gitSubmoduleAdd(root, source, "sub");

		expect(await submoduleRoots(root)).toEqual(new Set(["sub"]));
	});

	it("answers the rest of a batch correctly when one path reaches into a submodule", async () => {
		const source = await submoduleSource();
		const root = await repo({ "src/a.ts": "" }, "build/\n");
		write(root, "build/output.js");
		await gitSubmoduleAdd(root, source, "sub");

		const ignored = await gitIgnored(root, ["sub/inner.txt", "src/a.ts", "build/output.js"]);

		expect(ignored).not.toBeNull();
		expect(ignored?.has("build/output.js")).toBe(true);
		expect(ignored?.has("src/a.ts")).toBe(false);
		expect(ignored?.has("sub/inner.txt")).toBe(false);
	});

	it("never sends git a path that reaches into a submodule, answering it not ignored", async () => {
		const source = await submoduleSource();
		const root = await repo({}, "*.txt\n");
		await gitSubmoduleAdd(root, source, "sub");

		// "*.txt" would match inner.txt's own name if it ever reached git; not ignored proves it
		// never did, since this scope reader answers a path under a submodule without asking.
		const ignored = await gitIgnored(root, ["sub/inner.txt"]);

		expect(ignored?.has("sub/inner.txt")).toBe(false);
	});

	it("answers generated verdicts too, a path inside a submodule always not generated", async () => {
		const source = await submoduleSource();
		const root = await repo({
			".gitattributes": "generated/** linguist-generated\n",
			"generated/a.ts": "",
			"src/a.ts": "",
		});
		await gitSubmoduleAdd(root, source, "sub");

		const verdicts = await generatedVerdicts(root, ["sub/inner.txt", "generated/a.ts", "src/a.ts"]);

		expect(verdicts.get("generated/a.ts")).toEqual({ status: "yes" });
		expect(verdicts.get("src/a.ts")).toEqual({ status: "no" });
		expect(verdicts.get("sub/inner.txt")).toEqual({ status: "no" });
	});

	it("treats a path two levels under a submodule the same as one, a nested submodule included", async () => {
		const innermost = await submoduleSource();
		const middle = await submoduleSource();
		await gitSubmoduleAdd(middle, innermost, "innersub");
		await gitAdd(middle, "-A");
		await gitCommit(middle, "add inner submodule");
		const root = await repo({ "src/a.ts": "" });
		await gitSubmoduleAdd(root, middle, "sub");

		// ls-files --stage never descends into a gitlink, so the outer repo's own index names only
		// "sub", whatever submodules "sub" itself nests further in.
		expect(await submoduleRoots(root)).toEqual(new Set(["sub"]));

		const ignored = await gitIgnored(root, ["sub/innersub/inner.txt", "src/a.ts"]);
		expect(ignored?.has("sub/innersub/inner.txt")).toBe(false);
		expect(ignored?.has("src/a.ts")).toBe(false);
	});

	it("does not mistake a path merely sharing a root's name for one inside it", async () => {
		const source = await submoduleSource();
		const root = await repo({ "subdir/x.ts": "" }, "subdir/\n");
		await gitSubmoduleAdd(root, source, "sub");

		// "subdir/x.ts" is genuinely ignored by its own pattern, never by sharing "sub" as a prefix.
		const ignored = await gitIgnored(root, ["subdir/x.ts", "sub/inner.txt"]);
		expect(ignored?.has("subdir/x.ts")).toBe(true);
		expect(ignored?.has("sub/inner.txt")).toBe(false);
	});

	it("answers a path under an uninitialized gitlink the same way, its directory empty on disk", async () => {
		const source = await submoduleSource();
		const origin = await repo({ "src/a.ts": "" });
		await gitSubmoduleAdd(origin, source, "sub");
		await gitAdd(origin, "-A");
		await gitCommit(origin, "add submodule");

		const clonedRoot = mkdtempSync(path.join(tmpdir(), "lexicon-clone-"));
		roots.push(clonedRoot);
		await gitClone(origin, clonedRoot);

		// The gitlink is in the clone's index, but nothing was checked out beneath it.
		expect(await submoduleRoots(clonedRoot)).toEqual(new Set(["sub"]));
		const ignored = await gitIgnored(clonedRoot, ["sub/inner.txt", "src/a.ts"]);
		expect(ignored).not.toBeNull();
		expect(ignored?.has("sub/inner.txt")).toBe(false);
		expect(ignored?.has("src/a.ts")).toBe(false);
	});

	it("recognizes a path under a submodule however its separators are spelled", async () => {
		const source = await submoduleSource();
		const root = await repo({}, "*.txt\n");
		await gitSubmoduleAdd(root, source, "sub");

		// Unnormalized, "sub\inner.txt" fails to match root "sub" and is sent to git as a literal
		// filename, which "*.txt" then matches; normalized, it is recognized as under "sub" and
		// never asked at all.
		const ignored = await gitIgnored(root, ["sub\\inner.txt"]);
		expect(ignored?.has("sub\\inner.txt")).toBe(false);
	});
});
