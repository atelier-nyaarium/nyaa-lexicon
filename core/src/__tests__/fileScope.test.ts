import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { describeScope, fileScopeFor, generatedFiles, gitFiles, globToRegExp, includedFiles } from "../fileScope";

////////////////////////////////
//  Helpers

const roots: string[] = [];

function write(root: string, module: string, text = "x\n") {
	const full = path.join(root, module);
	mkdirSync(path.dirname(full), { recursive: true });
	writeFileSync(full, text);
}

/** A real repository, because the whole point is that git answers rather than we do. */
function repo(files: Record<string, string>, ignore?: string): string {
	const root = mkdtempSync(path.join(tmpdir(), "lexicon-scope-"));
	roots.push(root);
	execFileSync("git", ["init", "-q"], { cwd: root });
	for (const [module, text] of Object.entries(files)) write(root, module, text);
	if (ignore !== undefined) write(root, ".gitignore", ignore);
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

describe("what git says belongs to the project", () => {
	it("lists untracked files that are not ignored", () => {
		const root = repo({ "src/a.ts": "" });
		expect(gitFiles(root)?.has("src/a.ts")).toBe(true);
	});

	/**
	 * The measurement that motivated all of this.
	 *
	 * One real repository had 350 files git knew about and 136,333 on disk, because a devcontainer
	 * mounts a home directory inside it. Without this the index describes somebody else's plugins
	 * while looking like it describes yours.
	 */
	it("excludes an ignored directory entirely", () => {
		const root = repo({ "src/a.ts": "", "volumes/home/plugin.py": "", ".env": "SECRET=1" }, "volumes/\n.env\n");
		const known = gitFiles(root);

		expect(known?.has("src/a.ts")).toBe(true);
		expect(known?.has("volumes/home/plugin.py")).toBe(false);
		expect(known?.has(".env")).toBe(false);
	});

	it("answers null outside a repository, which is not the same as an empty project", () => {
		const root = mkdtempSync(path.join(tmpdir(), "lexicon-nogit-"));
		roots.push(root);
		expect(gitFiles(root)).toBeNull();
	});
});

describe("the scoping rule", () => {
	it("reads generated declarations from git attributes", () => {
		const root = repo({
			".gitattributes": "generated/** linguist-generated\n",
			"generated/a.ts": "",
			"src/a.ts": "",
		});

		expect(generatedFiles(root, ["generated/a.ts", "src/a.ts"])).toEqual(new Set(["generated/a.ts"]));
	});

	it("lets an explicit include override an exclude", () => {
		const root = repo({ "generated/a.ts": "", "src/a.ts": "" });
		const scope = fileScopeFor(root, { include: ["generated/**"], exclude: ["generated/**"] });

		expect(scope.allows("generated/a.ts")).toBe(true);
		expect(scope.allows("src/a.ts")).toBe(true);
	});

	it("marks only configured bundle globs for surface indexing", () => {
		const root = repo({ "opaque/runtime.js": "", "src/a.js": "" });
		const scope = fileScopeFor(root, { bundles: ["opaque/**"] });

		expect(scope.surface("opaque/runtime.js")).toBe(true);
		expect(scope.surface("src/a.js")).toBe(false);
	});

	it("refuses an ignored file to auto-discovery", () => {
		const root = repo({ "src/a.ts": "", "dist/built.js": "" }, "dist/\n");
		const scope = fileScopeFor(root);

		expect(scope.mode).toBe("git");
		expect(scope.allows("src/a.ts")).toBe(true);
		expect(scope.allows("dist/built.js")).toBe(false);
	});

	// Ignore governs DISCOVERY, not reachability. Naming a path explicitly is the whole point of
	// naming it, so it wins over the ignore that would otherwise hide it.
	it("allows an ignored file that was named explicitly", () => {
		const root = repo({ "src/a.ts": "", "dist/built.js": "" }, "dist/\n");
		const scope = fileScopeFor(root, { include: ["dist/**"] });

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
	it("finds included files itself rather than waiting to be offered them", () => {
		const root = repo({ "src/a.ts": "", "dist/bundle.js": "", "dist/deep/more.js": "" }, "dist/\n");

		expect(includedFiles(root, ["dist/**"]).sort()).toEqual(["dist/bundle.js", "dist/deep/more.js"]);
	});

	it("walks only where a glob could match, so one include never walks the world", () => {
		const root = repo({ "dist/bundle.js": "", "elsewhere/huge.js": "" });
		expect(includedFiles(root, ["dist/**"])).toEqual(["dist/bundle.js"]);
	});

	it("finds nothing when nothing was included, rather than everything", () => {
		expect(includedFiles(repo({ "src/a.ts": "" }), [])).toEqual([]);
	});

	// Walk mode is weaker and says so, rather than presenting itself as the same guarantee.
	it("allows everything outside a repository, and reports that it is doing so", () => {
		const root = mkdtempSync(path.join(tmpdir(), "lexicon-nogit-"));
		roots.push(root);
		const scope = fileScopeFor(root);

		expect(scope.mode).toBe("walk");
		expect(scope.allows("anything/at/all.ts")).toBe(true);
		expect(describeScope(scope)).toContain("no git repository");
	});

	it("says how the file set was decided, so two very different numbers are never confused", () => {
		const root = repo({ "src/a.ts": "" });
		expect(describeScope(fileScopeFor(root))).toMatch(/files git tracks/);
	});
});
