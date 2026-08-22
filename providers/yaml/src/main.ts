import path from "node:path";
import { readYaml, readYamlComments } from "@nyaa-lexicon/formats/yaml";
import {
	type Binding,
	coordinatesOf,
	discoverByWalk,
	handlersFor,
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
	type RenameEditsRequest,
	type RenameEditsResponse,
	runProviderOnStdio,
	serveProvider,
	type TypeInfo,
} from "@nyaa-lexicon/protocol";
import type { createMessageConnection } from "vscode-jsonrpc/node";

const LANGUAGE = "yaml";
const EXTENSIONS = [".yml", ".yaml"];

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
			content: "data" as const,
		};
	}

	discoverProject(workspaceRoot = this.workspaceRoot): ProjectModel {
		this.workspaceRoot = path.resolve(workspaceRoot);
		return discoverByWalk(this.workspaceRoot, { extensions: EXTENSIONS });
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

export function serve(connection: ReturnType<typeof createMessageConnection>, provider = new YamlProvider()): void {
	serveProvider(connection, handlersFor(provider));
}

if (import.meta.main) runProviderOnStdio(handlersFor(new YamlProvider()));
