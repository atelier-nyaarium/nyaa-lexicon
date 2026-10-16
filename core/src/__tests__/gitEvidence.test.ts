import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { collectGitEvidence, type GitEvidenceOptions, type GitRepository, sameStamp } from "../gitEvidence";
import { countingHost, tempDir, write } from "./gitEvidenceFixture";
import { gitAdd, gitCommit, gitConfig, gitInit, gitSubmoduleAdd, gitWorktreeAdd } from "./gitFixture";

////////////////////////////////
//  Helpers

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const SECRET_NAME = /(^|\/)(\.env(\..+)?|id_rsa)$/;

function optionsWith(overrides: Partial<GitEvidenceOptions>): GitEvidenceOptions {
	return { reaches: () => false, discovers: (module) => SECRET_NAME.test(module), ...overrides };
}

/** Creates repository with unstaged files. */
async function repo(files: Record<string, string> = {}, ignore?: string): Promise<string> {
	const root = tempDir("evidence", roots);
	await gitInit(root);
	for (const [module, text] of Object.entries(files)) write(root, module, text);
	if (ignore !== undefined) write(root, ".gitignore", ignore);
	return root;
}

/** Creates a committed submodule source. */
async function submoduleSource(): Promise<string> {
	const root = await repo({ "inner.txt": "" });
	await gitAdd(root, "inner.txt");
	await gitCommit(root, "seed");
	return root;
}

async function collect(root: string, overrides: Partial<GitEvidenceOptions> = {}) {
	const counting = countingHost(tempDir("home", roots));
	const repositories = await collectGitEvidence(counting.host, root, optionsWith(overrides));
	return { ...counting, repositories };
}

async function collectRoot(root: string, overrides: Partial<GitEvidenceOptions> = {}): Promise<GitRepository> {
	const [repository] = (await collect(root, overrides)).repositories;
	if (repository === undefined) throw new Error("expected a repository");
	return repository;
}

////////////////////////////////
//  Tests

describe("what a collection spends", () => {
	it("runs three git commands per repository whatever the file count, and never status", async () => {
		const small = await repo({ "src/a.ts": "" });
		const files = Object.fromEntries(Array.from({ length: 300 }, (_, at) => [`src/d${at % 10}/f${at}.ts`, ""]));
		const large = await repo({ ...files, "loose/u.txt": "", "cache/.env": "" }, "cache/\n");
		await gitAdd(large, "src");
		const nested = await repo({ "src/a.ts": "" });
		write(nested, "vendor/lib/inner.ts");
		await gitInit(path.join(nested, "vendor/lib"));

		const spawnsFor = async (root: string, overrides: Partial<GitEvidenceOptions> = {}) => {
			const { spawns } = await collect(root, overrides);
			return spawns;
		};

		expect(await spawnsFor(small)).toHaveLength(3);
		expect(await spawnsFor(large)).toHaveLength(3);
		expect(await spawnsFor(nested)).toHaveLength(3);
		const reached = await spawnsFor(nested, { reaches: () => true });
		expect(reached).toHaveLength(6);
		expect(reached.map((args) => args[0])).toEqual([
			"rev-parse",
			"ls-files",
			"ls-files",
			"rev-parse",
			"ls-files",
			"ls-files",
		]);
	});
});

describe("what the listings say", () => {
	it("sorts entries into tracked, links, gitlinks, untracked and nested", async () => {
		const source = await submoduleSource();
		const root = await repo({ "src/a.ts": "", "notes.txt": "", ".env": "KEY=1\n" }, ".env\n");
		symlinkSync("src/a.ts", path.join(root, "link.ts"));
		await gitAdd(root, "src/a.ts", "link.ts", ".gitignore");
		await gitSubmoduleAdd(root, source, "sub");
		write(root, "vendor/lib/inner.ts");
		await gitInit(path.join(root, "vendor/lib"));
		// Staged-looking lines do not track files.
		write(root, `100644 ${"a".repeat(40)} 0\t.env`);

		const repository = await collectRoot(root);

		expect(repository.state).toBe("ok");
		expect(repository.tracked).toEqual(new Set([".gitignore", ".gitmodules", "link.ts", "src/a.ts"]));
		expect(repository.links).toEqual(new Set(["link.ts"]));
		expect(repository.gitlinks).toEqual(new Set(["sub"]));
		expect(repository.untracked).toEqual(new Set(["notes.txt"]));
		expect(repository.nested).toEqual(new Set(["vendor/lib"]));
		expect(repository.discovered).toEqual(new Set([".env"]));
	});

	it("discovers secret files inside an ignored folder and among ignored files", async () => {
		const root = await repo(
			{
				"src/a.ts": "",
				"secrets/.env": "",
				"secrets/id_rsa": "",
				"secrets/deep/.env.production": "",
				"secrets/readme.md": "",
				".env.local": "",
			},
			"secrets/\n.env.local\n",
		);
		await gitAdd(root, "src", ".gitignore");

		const repository = await collectRoot(root);

		expect(repository.discovered).toEqual(
			new Set(["secrets/.env", "secrets/id_rsa", "secrets/deep/.env.production", ".env.local"]),
		);
	});

	it("collects a nested repository an include reaches, tracking and ignored files its own", async () => {
		const root = await repo({ "src/a.ts": "" });
		const inner = path.join(root, "vendor/lib");
		write(root, "vendor/lib/.env", "TRACKED=1\n");
		write(root, "vendor/lib/.env.local", "LOCAL=1\n");
		write(root, "vendor/lib/.gitignore", ".env.local\n");
		await gitInit(inner);
		await gitAdd(inner, ".env", ".gitignore");

		const reached = (await collect(root, { reaches: (prefix) => prefix === "vendor/lib" })).repositories;

		expect(reached.map((repository) => repository.prefix)).toEqual(["", "vendor/lib"]);
		expect(reached[1]?.tracked).toEqual(new Set(["vendor/lib/.env", "vendor/lib/.gitignore"]));
		expect(reached[1]?.discovered).toEqual(new Set(["vendor/lib/.env.local"]));
		expect(reached[0]?.nested).toEqual(new Set(["vendor/lib"]));
		expect(reached[0]?.tracked.has("vendor/lib/.env")).toBe(false);

		const unreached = (await collect(root)).repositories;
		expect(unreached.map((repository) => repository.prefix)).toEqual([""]);
		expect(unreached[0]?.nested).toEqual(new Set(["vendor/lib"]));
	});

	it("keeps ignored discovery inside repository boundaries", async () => {
		const source = await submoduleSource();
		write(source, ".gitignore", ".env.local\n");
		await gitAdd(source, ".gitignore");
		await gitCommit(source, "ignore local env");
		const root = await repo({}, "sub/\n");
		await gitSubmoduleAdd(root, source, "sub");
		write(root, "sub/.env.local", "API_KEY=private\n");
		const nested = path.join(root, "vendor/lib");
		write(root, "vendor/lib/.gitignore", ".env.local\n");
		write(root, "vendor/lib/.env.local", "API_KEY=private\n");
		await gitInit(nested);
		await gitAdd(nested, ".gitignore");

		const repositories = (await collect(root, { reaches: (prefix) => prefix === "vendor/lib" })).repositories;
		const parent = repositories.find((repository) => repository.prefix === "");
		const child = repositories.find((repository) => repository.prefix === "vendor/lib");

		expect(parent?.discovered.has("sub/.env.local")).toBe(false);
		expect(parent?.discovered.has("vendor/lib/.env.local")).toBe(false);
		expect(child?.discovered.has("vendor/lib/.env.local")).toBe(true);
	});

	it("does not walk an ignored parent listing into a nested repository", async () => {
		const root = await repo({}, "vendor/\n");
		const nested = path.join(root, "vendor/lib");
		write(root, "vendor/lib/.gitignore", ".env.local\n");
		write(root, "vendor/lib/.env.local", "API_KEY=private\n");
		await gitInit(nested);
		await gitAdd(nested, ".gitignore");

		const repositories = (await collect(root, { reaches: (prefix) => prefix === "vendor/lib" })).repositories;
		const parent = repositories.find((repository) => repository.prefix === "");
		const child = repositories.find((repository) => repository.prefix === "vendor/lib");

		expect(parent?.discovered.has("vendor/lib/.env.local")).toBe(false);
		expect(child?.discovered.has("vendor/lib/.env.local")).toBe(true);
	});
});

describe("walking collapsed folders", () => {
	it("reads nothing under an excluded directory, whether git collapsed it or a walk reached it", async () => {
		const root = await repo(
			{
				"src/a.ts": "",
				"node_modules/pkg/.env": "",
				"node_modules/pkg/lib/index.js": "",
				"dist/.env": "",
				".next/cache/data": "",
				"tools/.env": "",
				"tools/node_modules/dep/.env": "",
			},
			"node_modules/\ndist/\n.next/\ntools/\n",
		);
		await gitAdd(root, "src", ".gitignore");

		const { repositories, reads } = await collect(root);

		const read = reads.map((directory) => path.relative(root, directory));
		expect(read).toContain(".next/cache");
		expect(read.filter((directory) => /(^|\/)(node_modules|dist)(\/|$)/.test(directory))).toEqual([]);
		expect(repositories[0]?.discovered).toEqual(new Set(["tools/.env"]));
	});

	it("reads a folder once when git also names the folders inside it", async () => {
		const root = await repo({ "a/b/y.local": "", "kept/t.txt": "" }, "*.local\n");
		await gitAdd(root, "kept", ".gitignore");

		const { repositories, reads } = await collect(root, { discovers: (module) => module.endsWith(".local") });

		const read = reads.map((directory) => path.relative(root, directory));
		expect(read.filter((directory) => directory === "a")).toHaveLength(1);
		expect(read.filter((directory) => directory === "a/b")).toHaveLength(1);
		expect(repositories[0]?.discovered).toEqual(new Set(["a/b/y.local"]));
	});

	it("reports a folder whose walk passes the bound as undiscovered, and no file from it", async () => {
		const files = Object.fromEntries(Array.from({ length: 20 }, (_, at) => [`big/f${at}`, ""]));
		const root = await repo({ ...files, "big/.env": "", "small/.env": "" }, "big/\nsmall/\n");

		const bounded = await collectRoot(root, { walkBound: 10 });
		expect(bounded.undiscovered).toEqual(new Set(["big"]));
		expect(bounded.discovered).toEqual(new Set(["small/.env"]));

		const whole = await collectRoot(root);
		expect(whole.undiscovered.size).toBe(0);
		expect(whole.discovered).toEqual(new Set(["big/.env", "small/.env"]));
	});

	it("reports the symlinks a walk meets", async () => {
		const root = await repo({ "gen/a.txt": "" }, "gen/\n");
		symlinkSync("a.txt", path.join(root, "gen/alias"));

		const repository = await collectRoot(root);

		expect(repository.walkedLinks).toEqual(new Set(["gen/alias"]));
	});
});

describe("when git cannot answer", () => {
	it("answers absent with no git, and runs nothing", async () => {
		const root = tempDir("nogit", roots);
		write(root, "src/a.ts");

		const { repositories, spawns } = await collect(root);

		expect(repositories.map((repository) => [repository.prefix, repository.state])).toEqual([["", "absent"]]);
		expect(spawns).toEqual([]);
	});

	it("answers failed for a .git git cannot use", async () => {
		const root = tempDir("brokengit", roots);
		mkdirSync(path.join(root, ".git"));
		write(root, "src/a.ts");

		const repository = await collectRoot(root);

		expect(repository.state).toBe("failed");
		expect(repository.tracked.size).toBe(0);
	});

	it("answers failed for a corrupt index, still saying where the index is", async () => {
		const root = await repo({ "src/a.ts": "" });
		await gitAdd(root, "src/a.ts");
		writeFileSync(path.join(root, ".git", "index"), "not an index");

		const repository = await collectRoot(root);

		expect(repository.state).toBe("failed");
		expect(repository.tracked.size).toBe(0);
		expect(repository.indexPath).toBe(path.join(root, ".git", "index"));
	});

	it("answers failed when the .git here is unusable and a parent repository answers instead", async () => {
		const parent = await repo({ "src/a.ts": "" });
		const inner = path.join(parent, "inner");
		mkdirSync(path.join(inner, ".git"), { recursive: true });

		const repository = await collectRoot(inner);

		expect(repository.state).toBe("failed");
	});
});

describe("git directories outside the project", () => {
	it("resolves the index a submodule root's .git file names", async () => {
		const source = await submoduleSource();
		const parent = await repo({ "p.txt": "" });
		await gitSubmoduleAdd(parent, source, "sub");
		const root = path.join(parent, "sub");
		expect(statSync(path.join(root, ".git")).isFile()).toBe(true);

		const repository = await collectRoot(root);

		expect(repository.state).toBe("ok");
		expect(repository.gitDir).toBe(path.join(parent, ".git/modules/sub"));
		expect(repository.indexPath).toBe(path.join(parent, ".git/modules/sub/index"));
		expect(repository.tracked).toEqual(new Set(["inner.txt"]));
	});

	it("takes a linked worktree's index from its own directory and its exclude file from the shared one", async () => {
		const main = await repo({ "a.ts": "" });
		await gitAdd(main, "a.ts");
		await gitCommit(main, "seed");
		const tree = path.join(tempDir("worktree", roots), "tree");
		await gitWorktreeAdd(main, tree);

		const repository = await collectRoot(tree);

		expect(repository.state).toBe("ok");
		expect(repository.indexPath).toBe(path.join(main, ".git/worktrees/tree/index"));
		const exclude = repository.externals.find((external) => external.kind === "exclude");
		expect(exclude?.path).toBe(path.join(main, ".git/info/exclude"));
	});
});

describe("external paths", () => {
	it("stamps the index, exclude files and core.excludesFile, and leaves the index as stamped", async () => {
		const home = tempDir("home", roots);
		const root = await repo({ "a.ts": "" });
		await gitAdd(root, "a.ts");
		write(home, "ignore-global", "*.log\n");
		await gitConfig(root, "core.excludesFile", path.join(home, "ignore-global"));
		const counting = countingHost(home);

		const [repository] = await collectGitEvidence(counting.host, root, optionsWith({}));

		// Stamp before listings detects changes.
		const stampedAt = counting.events.indexOf(`stat ${path.join(root, ".git", "index")}`);
		expect(stampedAt).toBeGreaterThan(-1);
		expect(stampedAt).toBeLessThan(counting.events.indexOf("git ls-files"));
		const external = (kind: string) => repository?.externals.find((candidate) => candidate.kind === kind);
		const index = external("index");
		expect(index?.path).toBe(path.join(root, ".git", "index"));
		expect(index?.stamp).not.toBeNull();
		expect(external("exclude")?.path).toBe(path.join(root, ".git/info/exclude"));
		expect(external("excludesFile")?.path).toBe(path.join(home, "ignore-global"));
		expect(external("excludesFile")?.stamp).not.toBeNull();
		expect(sameStamp(counting.host.fs.stat(index?.path ?? ""), index?.stamp ?? null)).toBe(true);

		write(root, "b.ts");
		await gitAdd(root, "b.ts");
		expect(sameStamp(counting.host.fs.stat(index?.path ?? ""), index?.stamp ?? null)).toBe(false);
	});

	it("falls back to git's default global ignore file when nothing configures one", async () => {
		const home = tempDir("home", roots);
		const root = await repo({ "a.ts": "" });
		const counting = countingHost(home);

		const [repository] = await collectGitEvidence(counting.host, root, optionsWith({}));

		const excludesFile = repository?.externals.find((candidate) => candidate.kind === "excludesFile");
		expect(excludesFile?.path).toBe(path.join(home, ".config/git/ignore"));
		expect(excludesFile?.stamp).toBeNull();
	});
});
