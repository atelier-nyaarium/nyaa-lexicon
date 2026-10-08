import path from "node:path";
import { type HtmlFacts, readHtml } from "@nyaa-lexicon/formats/html";
import {
	type ArrangeEditsRequest,
	type Binding,
	coordinatesOf,
	defined,
	discoverByWalk,
	handlersFor,
	type ImportEditsRequest,
	type ImportEditsResponse,
	type ImportResolution,
	type IndexDepth,
	type MoveEditsRequest,
	type MoveEditsResponse,
	notImplementedBinding,
	notImplementedImport,
	notImplementedImportEdits,
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

const EXTENSIONS = [".html", ".htm"];
export const TIERS = {
	projectModel: true,
	declarations: true,
	references: false,
	imports: false,
	binding: false,
	types: false,
	literals: true,
	comments: true,
	docs: true,
	metrics: false,
	syntaxDiagnostics: false,
} as const;

/** A data format: no keywords, builtins or literal words. */
export const WORDS = {
	keywords: [],
	builtins: [],
	literals: [],
};

export class HtmlProvider {
	private workspaceRoot = process.cwd();
	initialize(workspaceRoot: string) {
		this.workspaceRoot = path.resolve(workspaceRoot);
		return {
			providerId: "html-provider",
			language: "html",
			extensions: EXTENSIONS,
			protocolVersion: PROTOCOL_VERSION,
			tiers: TIERS,
			content: "document" as const,
			words: WORDS,
		};
	}
	discoverProject(workspaceRoot = this.workspaceRoot): ProjectModel {
		this.workspaceRoot = path.resolve(workspaceRoot);
		return discoverByWalk(this.workspaceRoot, { extensions: EXTENSIONS });
	}
	parseFile(params: { module: string; contentHash: string; text: string; depth?: IndexDepth }) {
		const facts: HtmlFacts = readHtml({
			language: "html",
			module: params.module,
			text: params.text,
			offset: 0,
			coordinates: coordinatesOf(params.text),
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
			...defined({ blankLines: shallow ? undefined : facts.blankLines }),
			docs: shallow ? [] : facts.docs,
			diagnostics: facts.diagnostics,
			...(shallow ? { depth: params.depth } : {}),
		};
	}
	resolveImport(_params: { fromModule: string; specifier: string }): ImportResolution {
		return notImplementedImport("HTML has no import specifiers");
	}
	bind(_params: { module: string; name: string }): Binding {
		return notImplementedBinding("HTML has no bound references");
	}
	typeOf(_params: { symbolId: string } | { module: string }): TypeInfo {
		return notImplementedType("HTML has no types");
	}
	renameEdits(_params: RenameEditsRequest): RenameEditsResponse {
		return { status: "refused", reason: "NotImplemented", detail: "HTML rename edits are not implemented" };
	}
	moveEdits(_params: MoveEditsRequest): MoveEditsResponse {
		return notImplementedMove("HTML move edits are not implemented");
	}

	importEdits(_params: ImportEditsRequest): ImportEditsResponse {
		return notImplementedImportEdits("HTML import planning is not implemented");
	}

	arrangeEdits(_params: ArrangeEditsRequest): MoveEditsResponse {
		return notImplementedMove("HTML arrange edits are not implemented");
	}
}

export function serve(connection: ReturnType<typeof createMessageConnection>, provider = new HtmlProvider()): void {
	serveProvider(connection, handlersFor(provider));
}
if (import.meta.main) runProviderOnStdio(handlersFor(new HtmlProvider()));
