import path from "node:path";
import { readText } from "@nyaa-lexicon/formats/text";
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
	type ProviderMethods,
	type RenameEditsRequest,
	type RenameEditsResponse,
	runProviderOnStdio,
	type TextCoordinates,
	type TypeInfo,
} from "@nyaa-lexicon/protocol";

const LANGUAGE = "text";

export const TIERS = {
	projectModel: true,
	declarations: false,
	references: false,
	imports: false,
	binding: false,
	types: false,
	literals: false,
	comments: false,
	docs: true,
	metrics: false,
	syntaxDiagnostics: false,
} as const;

export class TextProvider implements ProviderMethods {
	private workspaceRoot = process.cwd();

	initialize(workspaceRoot: string) {
		this.workspaceRoot = path.resolve(workspaceRoot);
		return {
			providerId: "text-provider",
			language: LANGUAGE,
			extensions: [],
			fallback: true,
			protocolVersion: PROTOCOL_VERSION,
			tiers: TIERS,
			content: "text" as const,
		};
	}

	discoverProject(workspaceRoot = this.workspaceRoot): ProjectModel {
		this.workspaceRoot = path.resolve(workspaceRoot);
		return discoverByWalk(this.workspaceRoot, { extensions: [], everything: true });
	}

	parseFile(params: { module: string; contentHash: string; text: string; depth?: IndexDepth }) {
		const coordinates: TextCoordinates = coordinatesOf(params.text);
		const facts = readText({
			language: LANGUAGE,
			module: params.module,
			text: params.text,
			offset: 0,
			coordinates,
		});
		return {
			module: params.module,
			contentHash: params.contentHash,
			declarations: [],
			references: [],
			imports: [],
			literals: [],
			comments: [],
			docs: params.depth === "outline" || params.depth === "surface" ? [] : facts.docs,
			diagnostics: facts.diagnostics,
			...(params.depth === undefined ? {} : { depth: params.depth }),
		};
	}

	resolveImport(_params: { fromModule: string; specifier: string }): ImportResolution {
		return notImplementedImport("plain text has no import specifiers");
	}

	bind(_params: { module: string; name: string }): Binding {
		return notImplementedBinding("plain text has no symbols");
	}

	typeOf(_params: { symbolId: string } | { module: string }): TypeInfo {
		return notImplementedType("plain text has no symbols");
	}

	renameEdits(_params: RenameEditsRequest): RenameEditsResponse {
		return { status: "refused", reason: "NotImplemented", detail: "plain text has no symbols" };
	}

	moveEdits(_params: MoveEditsRequest): MoveEditsResponse {
		return notImplementedMove("plain text has no symbols");
	}
}

const provider = new TextProvider();
if (import.meta.main) runProviderOnStdio(handlersFor(provider));
