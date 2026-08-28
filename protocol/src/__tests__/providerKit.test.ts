import { afterEach, beforeEach, describe, expect, it, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PROVIDER_METHODS } from "../methods";
import {
	angleDelta,
	discoverByWalk,
	handlersFor,
	type ProviderMethods,
	qualifierDescriptors,
	walkWorkspace,
	workspaceFile,
	workspaceModule,
} from "../providerKit";

////////////////////////////////
//  Helpers

let root: string;

function put(relative: string, text = ""): void {
	const full = path.join(root, relative);
	mkdirSync(path.dirname(full), { recursive: true });
	writeFileSync(full, text);
}

beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), "lexicon-kit-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

////////////////////////////////
//  Tests

describe("naming a workspace file", () => {
	it("spells a file under the root as its module, and nothing outside or unrepresentable", () => {
		expect(workspaceModule(root, path.join(root, "src", "a.ts"))).toBe("src/a.ts");
		expect(workspaceModule(root, root)).toBeNull();
		expect(workspaceModule(root, path.join(root, "..", "escape.ts"))).toBeNull();
		expect(workspaceModule(root, path.join(root, "bad\u0000.ts"))).toBeNull();
	});

	it("resolves a module to its file inside the root, and refuses one that would leave it", () => {
		expect(workspaceFile(root, "src/a.ts")).toBe(path.join(root, "src", "a.ts"));
		expect(workspaceFile(root, "./src/a.ts")).toBe(path.join(root, "src", "a.ts"));
		expect(workspaceFile(root, "../escape.ts")).toBeNull();
		expect(workspaceFile(root, "/etc/passwd")).toBeNull();
	});
});

describe("shared parser primitives", () => {
	it("maps angle tokens to depth changes", () => {
		expect(["<", ">", ">>", ">>=", "text"].map(angleDelta)).toEqual([1, -1, -2, 0, 0]);
	});

	it("uses declared descriptors and namespace identity for qualifiers", () => {
		expect(qualifierDescriptors(["A", "N"], (name) => (name === "A" ? { kind: "type", name } : undefined))).toEqual(
			[
				{ kind: "type", name: "A" },
				{ kind: "namespace", name: "N" },
			],
		);
	});
});

describe("walking a workspace", () => {
	it("claims by extension and exact name, collects configuration apart, skips excluded directories", () => {
		put("src/a.kt");
		put("src/b.java");
		put("project.godot");
		put("build/c.kt");
		put("app.csproj");
		put("deep/nested/d.kt");

		expect(
			walkWorkspace(root, {
				extensions: [".kt"],
				filenames: ["project.godot"],
				configExtensions: [".csproj"],
				excludedDirectories: new Set(["build"]),
			}),
		).toEqual({ files: ["deep/nested/d.kt", "project.godot", "src/a.kt"], configFiles: ["app.csproj"] });
	});

	test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"skips a directory it cannot read rather than failing the walk",
		() => {
			// Root reads a mode-000 directory anyway.
			put("open/a.kt");
			put("closed/b.kt");
			chmodSync(path.join(root, "closed"), 0o000);
			try {
				expect(walkWorkspace(root, { extensions: [".kt"] }).files).toEqual(["open/a.kt"]);
			} finally {
				chmodSync(path.join(root, "closed"), 0o755);
			}
		},
	);

	it("answers a missing or non-directory root as a diagnostic, never a throw", () => {
		put("file.txt");
		expect(discoverByWalk(path.join(root, "nowhere"), { extensions: [".kt"] }).diagnostics).toHaveLength(1);
		expect(discoverByWalk(path.join(root, "file.txt"), { extensions: [".kt"] }).diagnostics).toHaveLength(1);
		put("src/a.kt");
		expect(discoverByWalk(root, { extensions: [".kt"] })).toMatchObject({ files: ["src/a.kt"], diagnostics: [] });
	});
});

describe("wiring a provider", () => {
	it("answers every method in the table, and lets a provider hear shutdown", () => {
		let stopped = 0;
		const provider = {
			initialize: () => ({ providerId: "p" }),
			discoverProject: () => ({ files: [] }),
			parseFile: () => ({ module: "a" }),
			resolveImport: () => ({ status: "unresolved" }),
			bind: () => ({ status: "unbound" }),
			typeOf: () => ({ status: "unknown" }),
			renameEdits: () => ({ status: "refused" }),
			moveEdits: () => ({ status: "refused" }),
			shutdown: () => {
				stopped++;
			},
		} as unknown as ProviderMethods;

		const handlers = handlersFor(provider);
		expect(Object.keys(handlers).sort()).toEqual([...PROVIDER_METHODS].sort());
		expect(handlers.shutdown({})).toEqual({});
		expect(stopped).toBe(1);
	});
});
