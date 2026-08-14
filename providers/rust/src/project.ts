import { type Dirent, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { type ImportResolution, normalizeModulePath, type ProjectModel } from "@nyaa-lexicon/protocol";
import { parseRustFile } from "./parser.js";
import { tokenize } from "./tokens.js";

export const RUST_EXTENSIONS = [".rs"] as const;

const EXCLUDED_DIRECTORIES = new Set([".git", ".hg", ".svn", ".idea", "node_modules", "target", "vendor"]);

const STANDARD_CRATES = new Set(["alloc", "core", "proc_macro", "std", "test"]);

function modulePath(root: string, absolute: string): string | null {
	const relative = path.relative(root, absolute).split(path.sep).join("/");
	if (relative === "" || relative.startsWith("../") || path.isAbsolute(relative)) return null;
	try {
		return normalizeModulePath(relative);
	} catch {
		return null;
	}
}

function walkRustFiles(root: string): string[] {
	const files: string[] = [];
	function visit(directory: string): void {
		let entries: Dirent[];
		try {
			entries = readdirSync(directory, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (entry.isDirectory() && EXCLUDED_DIRECTORIES.has(entry.name)) continue;
			const absolute = path.join(directory, entry.name);
			if (entry.isDirectory()) {
				visit(absolute);
				continue;
			}
			if (!entry.isFile() || !entry.name.endsWith(".rs")) continue;
			const module = modulePath(root, absolute);
			if (module !== null) files.push(module);
		}
	}
	visit(root);
	return files.sort();
}

function firstPathSegments(specifier: string): string[] {
	return tokenize(specifier)
		.tokens.filter((token) => token.kind === "identifier" && token.value !== "as")
		.map((token) => token.value);
}

function moduleNamespace(module: string, rootModule: string): string[] {
	const moduleParts = module.split("/");
	const file = moduleParts.at(-1);
	const directory = moduleParts.slice(0, -1);
	if (module === rootModule) return directory;
	if (file === "mod.rs") return directory;
	const stem = file?.replace(/\.rs$/u, "");
	return stem === undefined ? directory : [...directory, stem];
}

function fileCandidatesForNamespace(
	root: string,
	namespace: string[],
	rootNamespace: string[],
	isRoot: boolean,
): string[] {
	const relative = namespace.join("/");
	if (isRoot && namespace.join("/") === rootNamespace.join("/")) {
		return ["lib.rs", "main.rs", "mod.rs"].map((name) => [...namespace, name].join("/"));
	}
	return [`${relative}.rs`, `${relative}/mod.rs`];
}

function dependencyNames(root: string): Set<string> {
	const cargo = path.join(root, "Cargo.toml");
	if (!existsSync(cargo) || !statSync(cargo).isFile()) return new Set();
	const names = new Set<string>();
	let section = "";
	for (const line of readFileSync(cargo, "utf8").split(/\r?\n/u)) {
		const header = /^\s*\[\s*([^\]]+)\s*\]\s*$/u.exec(line);
		if (header !== null) {
			section = header[1] ?? "";
			continue;
		}
		if (!(section === "dependencies" || section === "dev-dependencies" || section === "build-dependencies"))
			continue;
		const name = /^\s*([A-Za-z_][A-Za-z0-9_-]*)\s*=/.exec(line)?.[1];
		if (name !== undefined) names.add(name);
	}
	return names;
}

export interface RustProjectState {
	root: string;
	files: string[];
	configFiles: string[];
	dependencies: Set<string>;
	rootModule: string | null;
	rootModules: string[];
}

export function discoverRustProject(workspaceRoot: string): { state: RustProjectState; model: ProjectModel } {
	const root = path.resolve(workspaceRoot);
	if (!existsSync(root)) {
		return {
			state: { root, files: [], configFiles: [], dependencies: new Set(), rootModule: null, rootModules: [] },
			model: {
				files: [],
				externalRoots: [],
				configFiles: [],
				diagnostics: [{ severity: "error", message: `workspace root does not exist: ${root}`, path: root }],
			},
		};
	}
	if (!statSync(root).isDirectory()) {
		return {
			state: { root, files: [], configFiles: [], dependencies: new Set(), rootModule: null, rootModules: [] },
			model: {
				files: [],
				externalRoots: [],
				configFiles: [],
				diagnostics: [{ severity: "error", message: `workspace root is not a directory: ${root}`, path: root }],
			},
		};
	}
	const files = walkRustFiles(root);
	const configFiles = ["Cargo.toml", "Cargo.lock"].filter((file) => existsSync(path.join(root, file)));
	const rootModules = files.filter(
		(file) => /(?:^|\/)src\/(?:lib|main)\.rs$/u.test(file) || /^(?:lib|main)\.rs$/u.test(file),
	);
	const sourceRoot = rootModules[0] ?? null;
	return {
		state: { root, files, configFiles, dependencies: dependencyNames(root), rootModule: sourceRoot, rootModules },
		model: { files, externalRoots: [], configFiles, diagnostics: [] },
	};
}

export class RustProjectResolver {
	private state: RustProjectState;

	constructor(workspaceRoot: string) {
		this.state = discoverRustProject(workspaceRoot).state;
	}

	reset(workspaceRoot: string): ProjectModel {
		const result = discoverRustProject(workspaceRoot);
		this.state = result.state;
		return result.model;
	}

	get root(): string {
		return this.state.root;
	}

	get files(): string[] {
		return this.state.files;
	}

	resolveModuleDeclaration(fromModule: string, name: string): string | null {
		const from = this.moduleNamespace(fromModule);
		return this.existingModule([...from, name], this.rootForModule(fromModule));
	}

	resolveImport(fromModule: string, specifier: string): ImportResolution {
		const segments = firstPathSegments(specifier);
		const first = segments[0];
		if (first === undefined)
			return { status: "unresolved", reason: "ParseError", detail: "the import path is empty" };
		if (STANDARD_CRATES.has(first) || this.state.dependencies.has(first))
			return { status: "external", packageName: first };
		const module = this.resolvePath(fromModule, segments);
		const hasWorkspacePrefix =
			first === "crate" ||
			first === "self" ||
			first === "super" ||
			this.resolveModuleDeclaration(fromModule, first) !== null;
		if (module !== null && hasWorkspacePrefix) {
			const baseModule =
				first === "crate"
					? this.rootForModule(fromModule)
					: first === "self"
						? fromModule
						: first === "super"
							? this.parentModule(fromModule)
							: null;
			const isBaseSymbol =
				baseModule !== null && baseModule !== undefined && module === baseModule && segments.length > 1;
			if (!isBaseSymbol || this.moduleHasDeclaration(module, segments.at(-1) ?? ""))
				return { status: "resolved", module };
		}
		return { status: "unresolved", reason: "NotIndexed", detail: `no Rust module or crate matched ${specifier}` };
	}

	resolvePath(fromModule: string, segments: string[]): string | null {
		if (segments.length === 0) return null;
		const rootModule = this.rootForModule(fromModule);
		const rootNamespace = rootModule === null ? ["src"] : moduleNamespace(rootModule, rootModule);
		const first = segments[0];
		if (first === "crate") return this.longestModule(rootNamespace, segments.slice(1), true, rootModule);
		if (first === "self")
			return this.longestModule(this.moduleNamespace(fromModule), segments.slice(1), false, fromModule);
		if (first === "super") {
			const parent = this.parentModule(fromModule);
			return parent === null
				? null
				: this.longestModule(this.moduleNamespace(parent), segments.slice(1), false, parent);
		}
		const local = this.longestModule(this.moduleNamespace(fromModule), segments, false, fromModule);
		return local ?? this.longestModule(rootNamespace, segments, true, rootModule);
	}

	private moduleNamespace(module: string): string[] {
		const root = this.rootForModule(module) ?? "";
		return moduleNamespace(module, root);
	}

	private rootForModule(module: string): string | null {
		const matches = this.state.rootModules.filter((root) => {
			const namespace = moduleNamespace(root, root).join("/");
			return module === root || module.startsWith(`${namespace}/`);
		});
		return matches.sort((left, right) => right.length - left.length)[0] ?? this.state.rootModule;
	}

	private existingModule(namespace: string[], rootModule = this.state.rootModule): string | null {
		const rootNamespace = rootModule === null ? ["src"] : moduleNamespace(rootModule, rootModule);
		const candidates = fileCandidatesForNamespace(
			this.state.root,
			namespace,
			rootNamespace,
			namespace.join("/") === rootNamespace.join("/"),
		);
		for (const candidate of candidates) if (this.state.files.includes(candidate)) return candidate;
		return null;
	}

	private longestModule(
		base: string[],
		segments: string[],
		root: boolean,
		baseModule?: string | null,
	): string | null {
		for (let count = segments.length; count >= 0; count--) {
			const namespace = [...base, ...segments.slice(0, count)];
			const module = this.existingModule(namespace, root ? baseModule : this.rootForModule(baseModule ?? ""));
			if (module !== null) return module;
			if (
				count === 0 &&
				baseModule !== undefined &&
				baseModule !== null &&
				root === false &&
				this.state.files.includes(baseModule)
			)
				return baseModule;
		}
		return null;
	}

	private parentModule(module: string): string | null {
		const namespace = this.moduleNamespace(module);
		if (namespace.length === 0) return null;
		const parentNamespace = namespace.slice(0, -1);
		return this.existingModule(parentNamespace, this.rootForModule(module));
	}

	private moduleHasDeclaration(module: string, name: string): boolean {
		const absolute = path.join(this.state.root, ...module.split("/"));
		if (!existsSync(absolute) || !statSync(absolute).isFile()) return false;
		try {
			return parseRustFile(module, readFileSync(absolute, "utf8")).declarations.some(
				(declaration) => declaration.name === name && declaration.containerId === undefined,
			);
		} catch {
			return false;
		}
	}
}
