import path from "node:path";
import {
	type Binding,
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
import { EXTENSIONS, LANGUAGE, parseMarkdown } from "./parser.js";

/**
 * Sections, frontmatter keys and prose, which is all a document has.
 *
 * `references` awaits resolving markdown links. `literals` is frontmatter's values, read by the
 * shared YAML reader so a `.yml` file cannot disagree with a frontmatter block about what a scalar
 * means. `syntaxDiagnostics` covers frontmatter, the only syntax a document can get wrong.
 */
export const TIERS = {
	projectModel: true,
	declarations: true,
	references: false,
	imports: false,
	binding: false,
	types: false,
	literals: true,
	comments: false,
	docs: true,
	metrics: false,
	syntaxDiagnostics: true,
} as const;

export class MarkdownProvider {
	private workspaceRoot = process.cwd();

	initialize(workspaceRoot: string) {
		this.workspaceRoot = path.resolve(workspaceRoot);
		return {
			providerId: "markdown-provider",
			language: LANGUAGE,
			extensions: [...EXTENSIONS],
			protocolVersion: PROTOCOL_VERSION,
			tiers: TIERS,
			content: "document" as const,
		};
	}

	discoverProject(workspaceRoot = this.workspaceRoot): ProjectModel {
		this.workspaceRoot = path.resolve(workspaceRoot);
		return discoverByWalk(this.workspaceRoot, { extensions: EXTENSIONS });
	}

	parseFile(params: { module: string; contentHash: string; text: string; depth?: IndexDepth | undefined }) {
		const parsed = parseMarkdown(params.module, params.text);
		// Prose is the full-depth payload, so a shallower request gets the table of contents alone.
		const shallow = params.depth === "outline" || params.depth === "surface";
		return {
			module: params.module,
			contentHash: params.contentHash,
			declarations: parsed.declarations,
			references: [],
			imports: [],
			literals: shallow ? [] : parsed.literals,
			comments: [],
			docs: shallow ? [] : parsed.docs,
			diagnostics: parsed.diagnostics,
			...(shallow ? { depth: params.depth as IndexDepth } : {}),
		};
	}

	resolveImport(_params: { fromModule: string; specifier: string }): ImportResolution {
		return notImplementedImport("a document has no import specifiers");
	}

	bind(_params: { module: string; name: string }): Binding {
		return notImplementedBinding("a document has no bound references");
	}

	typeOf(_params: { symbolId: string } | { module: string }): TypeInfo {
		return notImplementedType("a document section has no type");
	}

	renameEdits(_params: RenameEditsRequest): RenameEditsResponse {
		return { status: "refused", reason: "NotImplemented", detail: "markdown rename edits are not implemented" };
	}

	moveEdits(_params: MoveEditsRequest): MoveEditsResponse {
		return notImplementedMove("markdown move edits are not implemented");
	}
}

export function serve(connection: ReturnType<typeof createMessageConnection>, provider = new MarkdownProvider()): void {
	serveProvider(connection, handlersFor(provider));
}

if (import.meta.main) runProviderOnStdio(handlersFor(new MarkdownProvider()));
