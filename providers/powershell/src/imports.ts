import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { type ImportResolution, workspaceFile, workspaceModule } from "@nyaa-lexicon/protocol";
import { keyOf } from "./context.js";

interface ImportStore {
	readonly root: string;
	modules(): readonly string[];
	memo<R>(key: string, compute: () => R): R;
}

function landed(module: string): ImportResolution {
	return { status: "resolved", landing: { kind: "module", module } };
}

/** A path a script names, `$PSScriptRoot` read as its own folder and `\` as `/`. */
function normalizedPath(specifier: string): { path: string; besideScript: boolean } {
	const forward = specifier.split("\\").join("/");
	const root = /^\$\{?psscriptroot\}?/i.exec(forward);
	if (root === null) return { path: forward, besideScript: false };
	return { path: `.${forward.slice(root[0].length)}`, besideScript: true };
}

function isPathLike(specifier: string): boolean {
	return specifier.includes("/") || specifier.includes("\\") || /\.(ps1|psm1|psd1|dll)$/i.test(specifier);
}

export class PowerShellImports {
	constructor(private readonly store: ImportStore) {}

	resolveImport(params: { fromModule: string; specifier: string }): ImportResolution {
		const specifier = params.specifier;
		if (/[$`]/.test(normalizedPath(specifier).path))
			return { status: "unresolved", reason: "RuntimeConstructed", detail: "the path expands at run time" };
		const root = this.store.root;
		if (!isPathLike(specifier)) {
			const named = this.modulesNamed(specifier);
			if (named.length === 1) return landed(named[0] as string);
			if (named.length > 1)
				return {
					status: "unresolved",
					reason: "Ambiguous",
					detail: `${named.length} workspace modules are named ${specifier}`,
				};
			return { status: "external", packageName: specifier };
		}
		const { path: relative } = normalizedPath(specifier);
		if (path.isAbsolute(relative) || /^[A-Za-z]:\//.test(relative)) {
			const module = workspaceModule(root, relative);
			if (module === null) return { status: "external", packageName: specifier };
			return this.hasFile(module)
				? landed(module)
				: { status: "unresolved", reason: "NotIndexed", detail: `no workspace file at ${specifier}` };
		}
		const fromAbsolute = workspaceFile(root, params.fromModule);
		const directories = fromAbsolute === null ? [root] : [path.dirname(fromAbsolute), root];
		for (const directory of directories) {
			const module = workspaceModule(root, path.resolve(directory, relative));
			if (module !== null && this.hasFile(module)) return landed(module);
			for (const inside of this.moduleFolderFiles(directory, relative)) {
				if (this.hasFile(inside)) return landed(inside);
			}
		}
		return { status: "unresolved", reason: "NotIndexed", detail: `no workspace file matches ${specifier}` };
	}

	private hasFile(module: string): boolean {
		const absolute = workspaceFile(this.store.root, module);
		return absolute !== null && existsSync(absolute) && statSync(absolute).isFile();
	}

	private moduleFolderFiles(directory: string, relative: string): string[] {
		const folder = path.resolve(directory, relative);
		const base = path.basename(folder);
		return [".psd1", ".psm1"].flatMap((extension) => {
			const module = workspaceModule(this.store.root, path.join(folder, `${base}${extension}`));
			return module === null ? [] : [module];
		});
	}

	private modulesNamed(name: string): string[] {
		const index = this.store.memo("modulesByName", () => {
			const byName = new Map<string, string[]>();
			for (const module of this.store.modules()) {
				const extension = path.extname(module).toLowerCase();
				if (extension !== ".psd1" && extension !== ".psm1") continue;
				const key = keyOf(path.basename(module, path.extname(module)));
				byName.set(key, [...(byName.get(key) ?? []), module]);
			}
			return byName;
		});
		const found = index.get(keyOf(name)) ?? [];
		const manifests = found.filter((module) => module.toLowerCase().endsWith(".psd1"));
		return manifests.length > 0 ? manifests : found;
	}
}
