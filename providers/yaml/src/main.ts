import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { readYaml, readYamlComments } from "@nyaa-lexicon/formats";
import {
	type Binding,
	coordinatesOf,
	type ImportResolution,
	type IndexDepth,
	type MoveEditsRequest,
	type MoveEditsResponse,
	notImplementedBinding,
	notImplementedImport,
	notImplementedMove,
	notImplementedType,
	PROTOCOL_VERSION,
	type ProjectModel,
	type ProviderHandlers,
	type RenameEditsRequest,
	type RenameEditsResponse,
	runProviderOnStdio,
	serveProvider,
	type TypeInfo,
} from "@nyaa-lexicon/protocol";
import type { createMessageConnection } from "vscode-jsonrpc/node";

const LANGUAGE = "yaml";
const EXTENSIONS = [".yml", ".yaml"];

const EXCLUDED_DIRECTORIES = new Set([
	".git",
	".hg",
	".svn",
	".cache",
	".venv",
	"build",
	"dist",
	"node_modules",
	"out",
	"target",
	"vendor-cache",
]);

/**
 * A mapping of keys to values, and the comments beside them.
 *
 * `docs` is false and that is the honest answer rather than a gap: a comment in YAML is a comment,
 * which the comment tier already carries, and nothing here is prose under a heading. `references`
 * and `imports` are false because a key names nothing outside its own file.
 */
export const TIERS = {
	projectModel: true,
	declarations: true,
	references: false,
	imports: false,
	binding: false,
	types: false,
	literals: true,
	comments: true,
	docs: false,
	metrics: false,
	syntaxDiagnostics: true,
} as const;

function modulePath(root: string, absolute: string): string | null {
	const relative = path.relative(root, absolute).replace(/\\/gu, "/");
	if (relative === "" || relative.startsWith("../") || path.isAbsolute(relative)) return null;
	return relative;
}

function projectDiagnostic(root: string, message: string): ProjectModel {
	return { files: [], externalRoots: [], configFiles: [], diagnostics: [{ severity: "error", message, path: root }] };
}

function walkFiles(root: string): string[] {
	const files: string[] = [];
	function visit(directory: string): void {
		try {
			for (const entry of readdirSync(directory, { withFileTypes: true, encoding: "utf8" })) {
				if (entry.isDirectory() && EXCLUDED_DIRECTORIES.has(entry.name)) continue;
				const absolute = path.join(directory, entry.name);
				if (entry.isDirectory()) {
					visit(absolute);
					continue;
				}
				if (!entry.isFile() || !EXTENSIONS.some((extension) => entry.name.endsWith(extension))) continue;
				const module = modulePath(root, absolute);
				if (module !== null) files.push(module);
			}
		} catch {
			return;
		}
	}
	visit(root);
	return files.sort();
}

export class YamlProvider {
	private workspaceRoot = process.cwd();

	initialize(workspaceRoot: string) {
		this.workspaceRoot = path.resolve(workspaceRoot);
		return {
			providerId: "yaml-provider",
			language: LANGUAGE,
			extensions: [...EXTENSIONS],
			protocolVersion: PROTOCOL_VERSION,
			tiers: TIERS,
		};
	}

	discoverProject(workspaceRoot = this.workspaceRoot): ProjectModel {
		this.workspaceRoot = path.resolve(workspaceRoot);
		if (!existsSync(this.workspaceRoot))
			return projectDiagnostic(this.workspaceRoot, `workspace root does not exist: ${this.workspaceRoot}`);
		try {
			if (!statSync(this.workspaceRoot).isDirectory())
				return projectDiagnostic(
					this.workspaceRoot,
					`workspace root is not a directory: ${this.workspaceRoot}`,
				);
			return { files: walkFiles(this.workspaceRoot), externalRoots: [], configFiles: [], diagnostics: [] };
		} catch (error) {
			return projectDiagnostic(
				this.workspaceRoot,
				`unable to inspect workspace root: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	parseFile(params: { module: string; contentHash: string; text: string; depth?: IndexDepth | undefined }) {
		const coordinates = coordinatesOf(params.text);
		const facts = readYaml({
			language: LANGUAGE,
			module: params.module,
			text: params.text,
			offset: 0,
			coordinates,
		});
		const shallow = params.depth === "outline" || params.depth === "surface";
		return {
			module: params.module,
			contentHash: params.contentHash,
			declarations: facts.declarations,
			references: [],
			imports: [],
			literals: shallow ? [] : facts.literals,
			comments: shallow ? [] : readYamlComments(params.text, 0, coordinates),
			diagnostics: facts.diagnostics,
			...(shallow ? { depth: params.depth as IndexDepth } : {}),
		};
	}

	resolveImport(_params: { fromModule: string; specifier: string }): ImportResolution {
		return notImplementedImport("a YAML file has no import specifiers");
	}

	bind(_params: { module: string; name: string }): Binding {
		return notImplementedBinding("a YAML key names nothing outside its own file");
	}

	typeOf(_params: { symbolId: string } | { module: string }): TypeInfo {
		return notImplementedType("a YAML key carries a value, not a type");
	}

	renameEdits(_params: RenameEditsRequest): RenameEditsResponse {
		return { status: "refused", reason: "NotImplemented", detail: "YAML rename edits are not implemented" };
	}

	moveEdits(_params: MoveEditsRequest): MoveEditsResponse {
		return notImplementedMove("YAML move edits are not implemented");
	}
}

export function handlersFor(provider: YamlProvider): ProviderHandlers {
	return {
		initialize: (params) => provider.initialize(params.workspaceRoot),
		discoverProject: (params) => provider.discoverProject(params.workspaceRoot),
		parseFile: (params) => provider.parseFile(params),
		resolveImport: (params) => provider.resolveImport(params),
		bind: (params) => provider.bind(params),
		typeOf: (params) => provider.typeOf(params),
		renameEdits: (params) => provider.renameEdits(params),
		moveEdits: (params) => provider.moveEdits(params),
		shutdown: () => ({}),
	};
}

export { serveProvider };

export function serve(connection: ReturnType<typeof createMessageConnection>, provider = new YamlProvider()): void {
	serveProvider(connection, handlersFor(provider));
}

if (import.meta.main) runProviderOnStdio(handlersFor(new YamlProvider()));
