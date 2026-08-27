import path from "node:path";
import { readXml, type XmlFacts } from "@nyaa-lexicon/formats/xml";
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

const EXTENSIONS = [
	".xml",
	".xsd",
	".xsl",
	".xslt",
	".xhtml",
	".svg",
	".plist",
	".xaml",
	".resx",
	".csproj",
	".fsproj",
	".vbproj",
	".props",
	".targets",
	".nuspec",
	".wsdl",
];
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

export class XmlProvider {
	private workspaceRoot = process.cwd();
	initialize(workspaceRoot: string) {
		this.workspaceRoot = path.resolve(workspaceRoot);
		return {
			providerId: "xml-provider",
			language: "xml",
			extensions: EXTENSIONS,
			protocolVersion: PROTOCOL_VERSION,
			tiers: TIERS,
			content: "data" as const,
		};
	}
	discoverProject(workspaceRoot = this.workspaceRoot): ProjectModel {
		this.workspaceRoot = path.resolve(workspaceRoot);
		return discoverByWalk(this.workspaceRoot, { extensions: EXTENSIONS });
	}
	parseFile(params: { module: string; contentHash: string; text: string; depth?: IndexDepth }) {
		const facts: XmlFacts = readXml({
			language: "xml",
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
			diagnostics: facts.diagnostics,
			...(shallow ? { depth: params.depth } : {}),
		};
	}
	resolveImport(_params: { fromModule: string; specifier: string }): ImportResolution {
		return notImplementedImport("XML has no import specifiers");
	}
	bind(_params: { module: string; name: string }): Binding {
		return notImplementedBinding("XML has no bound references");
	}
	typeOf(_params: { symbolId: string } | { module: string }): TypeInfo {
		return notImplementedType("XML has no types");
	}
	renameEdits(_params: RenameEditsRequest): RenameEditsResponse {
		return { status: "refused", reason: "NotImplemented", detail: "XML rename edits are not implemented" };
	}
	moveEdits(_params: MoveEditsRequest): MoveEditsResponse {
		return notImplementedMove("XML move edits are not implemented");
	}
}

export function serve(connection: ReturnType<typeof createMessageConnection>, provider = new XmlProvider()): void {
	serveProvider(connection, handlersFor(provider));
}
if (import.meta.main) runProviderOnStdio(handlersFor(new XmlProvider()));
