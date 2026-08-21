import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { type JsonFacts, readJson } from "@nyaa-lexicon/formats/json";
import {
	type Binding,
	coordinatesOf,
	type Descriptor,
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
	type TextCoordinates,
	type TypeInfo,
} from "@nyaa-lexicon/protocol";
import type { createMessageConnection } from "vscode-jsonrpc/node";

const LANGUAGE = "json";

/** One root per file, except the line-delimited pair, which is one root per line. */
const OBJECT_EXTENSIONS = [".json", ".jsonc"];
const LINE_EXTENSIONS = [".jsonl", ".ndjson"];
const EXTENSIONS = [...OBJECT_EXTENSIONS, ...LINE_EXTENSIONS];

/** `.json` is strict. A comment there is an error, not a feature, and jsonc-parser must be told. */
const LENIENT_EXTENSIONS = [".jsonc"];

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
 * Keys and their values, and comments only where the dialect has them.
 *
 * `comments` is TRUE because JSONC has them, and a `.json` file simply reports none, which is the
 * tier working as intended rather than an over-claim. `docs` is false: nothing here is prose.
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

function empty(): JsonFacts {
	return { declarations: [], literals: [], comments: [], diagnostics: [] };
}

/**
 * Line-delimited records, each its own root under a `[n]` namespace.
 *
 * A record needs its own path or every file's keys would collide on one id. The ordinal moves if a
 * line is inserted above it, which is the weakness already accepted for a repeated heading and taken
 * here for the same reason: a record with no id is a record nothing can address.
 */
function readRecords(module: string, text: string, coordinates: TextCoordinates, lenient: boolean): JsonFacts {
	const facts = empty();
	let offset = 0;
	let record = 0;

	for (const line of text.split("\n")) {
		if (line.trim() !== "") {
			const parents: Descriptor[] = [{ kind: "namespace", name: `[${record}]` }];
			const read = readJson({ language: LANGUAGE, module, text: line, offset, coordinates, lenient, parents });
			facts.declarations.push(...read.declarations);
			facts.literals.push(...read.literals);
			facts.comments.push(...read.comments);
			facts.diagnostics.push(...read.diagnostics);
			record++;
		}
		offset += line.length + 1;
	}
	return facts;
}

export class JsonProvider {
	private workspaceRoot = process.cwd();

	initialize(workspaceRoot: string) {
		this.workspaceRoot = path.resolve(workspaceRoot);
		return {
			providerId: "json-provider",
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
		const lenient = LENIENT_EXTENSIONS.some((extension) => params.module.endsWith(extension));
		const lines = LINE_EXTENSIONS.some((extension) => params.module.endsWith(extension));
		const facts = lines
			? readRecords(params.module, params.text, coordinates, lenient)
			: readJson({
					language: LANGUAGE,
					module: params.module,
					text: params.text,
					offset: 0,
					coordinates,
					lenient,
				});

		const shallow = params.depth === "outline" || params.depth === "surface";
		return {
			module: params.module,
			contentHash: params.contentHash,
			declarations: facts.declarations,
			references: [],
			imports: [],
			literals: shallow ? [] : facts.literals,
			comments: shallow ? [] : facts.comments,
			diagnostics: facts.diagnostics,
			...(shallow ? { depth: params.depth as IndexDepth } : {}),
		};
	}

	resolveImport(_params: { fromModule: string; specifier: string }): ImportResolution {
		return notImplementedImport("a JSON file has no import specifiers");
	}

	bind(_params: { module: string; name: string }): Binding {
		return notImplementedBinding("a JSON key names nothing outside its own file");
	}

	typeOf(_params: { symbolId: string } | { module: string }): TypeInfo {
		return notImplementedType("a JSON key carries a value, not a type");
	}

	renameEdits(_params: RenameEditsRequest): RenameEditsResponse {
		return { status: "refused", reason: "NotImplemented", detail: "JSON rename edits are not implemented" };
	}

	moveEdits(_params: MoveEditsRequest): MoveEditsResponse {
		return notImplementedMove("JSON move edits are not implemented");
	}
}

export function handlersFor(provider: JsonProvider): ProviderHandlers {
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

export function serve(connection: ReturnType<typeof createMessageConnection>, provider = new JsonProvider()): void {
	serveProvider(connection, handlersFor(provider));
}

if (import.meta.main) runProviderOnStdio(handlersFor(new JsonProvider()));
