import path from "node:path";
import { type JsonFacts, readJson } from "@nyaa-lexicon/formats/json";
import {
	type Binding,
	coordinatesOf,
	type Descriptor,
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
	type TextCoordinates,
	type TypeInfo,
} from "@nyaa-lexicon/protocol";
import type { createMessageConnection } from "vscode-jsonrpc/node";

const LANGUAGE = "json";

/** One root per file, except the line-delimited pair, which is one root per line. */
const OBJECT_EXTENSIONS = [".json", ".jsonc"];
const LINE_EXTENSIONS = [".jsonl", ".ndjson"];
const EXTENSIONS = [...OBJECT_EXTENSIONS, ...LINE_EXTENSIONS];

/** Every dialect is read leniently; the others get a note for what strict JSON lacks. */
const LENIENT_EXTENSIONS = [".jsonc"];

/** Keys, their values, and comments wherever they are written. `docs` is false: nothing here is prose. */
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
function readRecords(module: string, text: string, coordinates: TextCoordinates, strict: boolean): JsonFacts {
	const facts = empty();
	let offset = 0;
	let record = 0;

	for (const line of text.split("\n")) {
		if (line.trim() !== "") {
			const parents: Descriptor[] = [{ kind: "namespace", name: `[${record}]` }];
			const read = readJson({ language: LANGUAGE, module, text: line, offset, coordinates, strict, parents });
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
			content: "data" as const,
		};
	}

	discoverProject(workspaceRoot = this.workspaceRoot): ProjectModel {
		this.workspaceRoot = path.resolve(workspaceRoot);
		return discoverByWalk(this.workspaceRoot, { extensions: EXTENSIONS });
	}

	parseFile(params: { module: string; contentHash: string; text: string; depth?: IndexDepth | undefined }) {
		const coordinates = coordinatesOf(params.text);
		const strict = !LENIENT_EXTENSIONS.some((extension) => params.module.endsWith(extension));
		const lines = LINE_EXTENSIONS.some((extension) => params.module.endsWith(extension));
		const facts = lines
			? readRecords(params.module, params.text, coordinates, strict)
			: readJson({
					language: LANGUAGE,
					module: params.module,
					text: params.text,
					offset: 0,
					coordinates,
					strict,
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

export function serve(connection: ReturnType<typeof createMessageConnection>, provider = new JsonProvider()): void {
	serveProvider(connection, handlersFor(provider));
}

if (import.meta.main) runProviderOnStdio(handlersFor(new JsonProvider()));
