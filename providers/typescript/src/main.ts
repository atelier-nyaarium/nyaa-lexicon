// The TypeScript provider and its wire handlers.

import {
	AdmissionLedger,
	handlersFor,
	type ImportResolution,
	type IndexDepth,
	type ModuleAdmission,
	type MoveEditsRequest,
	type MoveEditsResponse,
	PROTOCOL_VERSION,
	parseSymbolId,
	runProviderOnStdio,
	serveProvider,
} from "@nyaa-lexicon/protocol";
import ts from "typescript";
import type { createMessageConnection } from "vscode-jsonrpc/node";
import { TypeScriptAnalyzer } from "./analyzer.js";
import { isDeclarationModule, isLikelyBundle } from "./bundle.js";
import { extractComments } from "./comments.js";
import { extractFile, LANGUAGE } from "./extract.js";
import { EXTENSIONS, scriptKindOf } from "./file-types.js";
import { isValidTargetModule } from "./move.js";
import { type LoadedProject, loadProject, renderSpecifier, resolveSpecifier, toModule } from "./project.js";
import { extractSurfaceFile } from "./surface.js";

////////////////////////////////
//  Constants

/** Declares the semantic tiers backed by the TypeScript checker. */
export const TIERS = {
	projectModel: true,
	declarations: true,
	references: true,
	imports: true,
	binding: true,
	types: true,
	literals: true,
	comments: true,
	docs: false,
	metrics: true,
	syntaxDiagnostics: true,
} as const;

/** JS/TS reserved and contextual keywords. Builtins are the primitive and structural type names. */
export const WORDS = {
	keywords: [
		"abstract",
		"accessor",
		"as",
		"asserts",
		"async",
		"await",
		"break",
		"case",
		"catch",
		"class",
		"const",
		"constructor",
		"continue",
		"debugger",
		"declare",
		"default",
		"delete",
		"do",
		"else",
		"enum",
		"export",
		"extends",
		"finally",
		"for",
		"from",
		"function",
		"get",
		"if",
		"implements",
		"import",
		"in",
		"infer",
		"instanceof",
		"interface",
		"is",
		"keyof",
		"let",
		"module",
		"namespace",
		"new",
		"of",
		"out",
		"override",
		"package",
		"private",
		"protected",
		"public",
		"readonly",
		"return",
		"satisfies",
		"set",
		"static",
		"super",
		"switch",
		"this",
		"throw",
		"try",
		"type",
		"typeof",
		"unique",
		"using",
		"var",
		"while",
		"with",
		"yield",
	],
	builtins: [
		"Array",
		"Function",
		"Object",
		"Promise",
		"Record",
		"any",
		"bigint",
		"boolean",
		"never",
		"number",
		"object",
		"string",
		"symbol",
		"unknown",
		"void",
	],
	literals: ["NaN", "false", "null", "true", "undefined"],
};

/**
 * The reference roles actually extracted, since `references: true` cannot say which.
 *
 * `import` and `export` are absent on purpose: module imports and re-exports are already reported
 * as import facts, and emitting them again here would double-count the same edge.
 */
export const REFERENCE_ROLES = ["call", "read", "write", "typeUse", "instantiate", "extends", "implements"] as const;

////////////////////////////////
//  Class

/** Holds the loaded project between calls, so a tsconfig is parsed once rather than per file. */
export class TypeScriptProvider {
	private workspaceRoot = process.cwd();
	private project: LoadedProject | null = null;
	private analyzer: TypeScriptAnalyzer | null = null;
	private readonly runtimeSurfaces = new Set<string>();
	/** What the index took, so a use binds into what it holds and not into the Program's disk read. */
	private readonly admission = new AdmissionLedger<string>();

	initialize(workspaceRoot: string) {
		this.analyzer?.dispose();
		this.workspaceRoot = workspaceRoot;
		this.project = null;
		this.analyzer = null;
		this.runtimeSurfaces.clear();
		this.admission.reset();
		return {
			providerId: "typescript-provider",
			language: LANGUAGE,
			extensions: [...EXTENSIONS],
			protocolVersion: PROTOCOL_VERSION,
			tiers: TIERS,
			referenceRoles: [...REFERENCE_ROLES],
			words: WORDS,
		};
	}

	private loaded(): LoadedProject {
		this.project ??= loadProject(this.workspaceRoot);
		return this.project;
	}

	private analyzed(): TypeScriptAnalyzer {
		this.analyzer ??= new TypeScriptAnalyzer(this.workspaceRoot, this.loaded(), (module) =>
			this.holdsNothing(module),
		);
		return this.analyzer;
	}

	/** No text of ours and no disk read the index allows: it holds this module not at all. */
	private holdsNothing(module: string): boolean {
		return !this.admission.fillable(module) && this.analyzer?.overlayText(module) === undefined;
	}

	discoverProject() {
		const project = this.loaded();
		const files = project.files
			.map((file) => toModule(this.workspaceRoot, file))
			.filter((module): module is string => module !== null);

		return {
			files,
			externalRoots: [],
			configFiles: project.configFiles.map((file) => toModule(this.workspaceRoot, file) ?? file),
			diagnostics: project.diagnostics,
		};
	}

	/**
	 * Parse the text the core supplied, never what is on disk.
	 *
	 * An editor's buffer differs from disk constantly, and answering about the saved version while
	 * a caller asks about the open one is a whole class of wrong-but-plausible answers.
	 */
	parseFile(params: {
		module: string;
		contentHash: string;
		text: string;
		depth?: IndexDepth | undefined;
		probe?: boolean | undefined;
	}) {
		// Staged before the overlay moves, so a refusal knows what this parse displaced.
		if (params.probe !== true)
			this.admission.staged(params.module, params.contentHash, this.analyzer?.overlayText(params.module));

		if (this.isSurface(params)) {
			const extracted = extractSurfaceFile(params.module, params.text);
			if (!isDeclarationModule(params.module)) this.runtimeSurfaces.add(params.module);
			return {
				module: params.module,
				contentHash: params.contentHash,
				...extracted,
				// Echoed so a self-detected surface is never stored as full under an outline request.
				depth: "surface" as const,
			};
		}

		// Outline parsing skips binding and type analysis.
		if (params.depth === "outline") {
			const source = ts.createSourceFile(
				params.module,
				params.text,
				ts.ScriptTarget.ESNext,
				true,
				scriptKindOf(params.module),
			);
			const extracted = extractFile(params.module, source);
			// Outline parsing reports syntax diagnostics without binding analysis.
			const parseProblems = (source as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics ?? [];
			return {
				module: params.module,
				contentHash: params.contentHash,
				declarations: extracted.declarations,
				references: [],
				imports: extracted.imports,
				literals: [],
				comments: [],
				diagnostics: parseProblems.map((problem) => ({
					severity: "error" as const,
					message: ts.flattenDiagnosticMessageText(problem.messageText, " "),
				})),
				depth: "outline" as const,
			};
		}

		this.runtimeSurfaces.delete(params.module);
		const analyzer = this.analyzed();
		const source =
			analyzer.updateFile(params.module, params.text) ??
			ts.createSourceFile(params.module, params.text, ts.ScriptTarget.ESNext, true, scriptKindOf(params.module));
		const extracted = analyzer.extract(params.module, source, params.contentHash);
		const references = extracted.references.map((reference) => ({
			...reference,
			binding: analyzer.bindReference(params.module, reference.name, {
				start: reference.range.start,
				end: reference.range.start,
			}),
		}));

		return {
			module: params.module,
			contentHash: params.contentHash,
			declarations: extracted.declarations,
			references,
			imports: extracted.imports,
			literals: extracted.literals,
			comments: extractComments(source),
			diagnostics: analyzer.diagnostics(params.module),
		};
	}

	resolveImport(params: {
		fromModule: string;
		specifier: string;
		surfaceGlobs?: string[] | undefined;
	}): ImportResolution {
		const resolution = resolveSpecifier(
			this.workspaceRoot,
			params.fromModule,
			params.specifier,
			this.loaded().options,
			params.surfaceGlobs,
		);
		if (resolution.status === "resolved" && this.holdsNothing(resolution.module)) {
			return {
				status: "unresolved",
				reason: "NotIndexed",
				detail: `the index holds nothing for ${resolution.module}`,
			};
		}
		return resolution;
	}

	bind(params: {
		module: string;
		name: string;
		range: { start: { line: number; character: number }; end: { line: number; character: number } };
	}) {
		if (this.runtimeSurfaces.has(params.module)) {
			return {
				status: "unbound" as const,
				reason: "DynamicallyTyped" as const,
				detail: "bundle surfaces do not retain implementation bindings",
			};
		}
		return this.analyzed().bind(params.module, params.name, params.range);
	}

	typeOf(
		params:
			| { symbolId: string }
			| {
					module: string;
					range: { start: { line: number; character: number }; end: { line: number; character: number } };
			  },
	) {
		const module = "symbolId" in params ? parseSymbolId(params.symbolId)?.module : params.module;
		if (module !== undefined && this.runtimeSurfaces.has(module)) {
			return {
				status: "unknown" as const,
				reason: "DynamicallyTyped" as const,
				detail: "a JavaScript bundle does not retain source types",
			};
		}
		return this.analyzed().typeOf(params);
	}

	renameEdits(params: Parameters<TypeScriptAnalyzer["renameEdits"]>[0]) {
		return this.analyzed().renameEdits(params);
	}

	moveEdits(params: MoveEditsRequest): MoveEditsResponse {
		if (!isValidTargetModule(this.workspaceRoot, params.toModule)) {
			return {
				status: "refused",
				reason: "InvalidTarget",
				detail: `the target is not a TypeScript module: ${params.toModule}`,
			};
		}
		const options = this.loaded().options;
		return this.analyzed().moveEdits(params, (fromModule, targetModule, preferredSpecifier) =>
			renderSpecifier(this.workspaceRoot, fromModule, targetModule, options, preferredSpecifier),
		);
	}

	/** The index let this module go, or refused the parse it holds nothing from. */
	forgetModule(params: { module: string }): void {
		this.analyzer?.forgetModule(params.module);
		this.runtimeSurfaces.delete(params.module);
		this.admission.forgotten(params.module);
	}

	/** A refused parse is put back, so a use binds into what the index kept. */
	moduleAdmission(params: ModuleAdmission): void {
		const restore = this.admission.settle(params);
		if (restore === null) return;
		this.analyzer?.restoreFile(restore.module, restore.facts);
	}

	programStats() {
		return this.analyzed().programStats();
	}

	shutdown() {
		this.analyzer?.dispose();
		this.analyzer = null;
		this.runtimeSurfaces.clear();
		return {};
	}

	private isSurface(params: { module: string; text: string; depth?: IndexDepth | undefined }): boolean {
		return (
			params.depth === "surface" ||
			params.module.split("/").includes("node_modules") ||
			isLikelyBundle(params.module, params.text)
		);
	}
}

////////////////////////////////
//  Main

export function serve(connection: ReturnType<typeof createMessageConnection>, provider = new TypeScriptProvider()) {
	serveProvider(connection, handlersFor(provider));
}

if (import.meta.main) runProviderOnStdio(handlersFor(new TypeScriptProvider()));
