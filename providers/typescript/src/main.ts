// The TypeScript provider and its wire handlers.

import path from "node:path";
import {
	discoverByWalk,
	handlersFor,
	type ImportResolution,
	type IndexDepth,
	type MoveEditsRequest,
	type MoveEditsResponse,
	PROTOCOL_VERSION,
	type ProjectModel,
	parseSymbolId,
	runProviderOnStdio,
	serveProvider,
} from "@nyaa-lexicon/protocol";
import ts from "typescript";
import type { createMessageConnection } from "vscode-jsonrpc/node";
import { TypeScriptAnalyzer } from "./analyzer.js";
import { isDeclarationModule } from "./bundle.js";
import { extractComments } from "./comments.js";
import { extractFile, LANGUAGE } from "./extract.js";
import { EXTENSIONS, scriptKindOf } from "./file-types.js";
import {
	createTypeScriptProject,
	createTypeScriptStore,
	syntaxErrors,
	type TypeScriptProject,
	type TypeScriptValue,
} from "./module.js";
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
	fileRoles: true,
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

export class TypeScriptProvider {
	readonly store = createTypeScriptStore();

	initialize(_workspaceRoot: string) {
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

	private analyzed(): TypeScriptAnalyzer {
		const project = this.store.project;
		project.analyzer ??= new TypeScriptAnalyzer(this.store, project);
		return project.analyzer;
	}

	discoverProject(
		workspaceRoot: string,
		previous: TypeScriptProject | undefined,
	): { model: ProjectModel; project: TypeScriptProject } {
		const root = path.resolve(workspaceRoot);
		const sameRoot = previous?.root === root;
		if (!sameRoot) previous?.analyzer?.dispose();
		const loaded = sameRoot && previous !== undefined ? previous.loaded : loadProject(root);
		const discovered =
			loaded.configFiles.length === 0
				? discoverByWalk(root, { extensions: EXTENSIONS })
				: {
						files: loaded.files
							.map((file) => toModule(root, file))
							.filter((module): module is string => module !== null),
						configFiles: loaded.configFiles.map((file) => toModule(root, file) ?? file),
						diagnostics: loaded.diagnostics,
					};
		const projectLoaded: LoadedProject = {
			...loaded,
			files: discovered.files.map((module) => path.resolve(root, module)),
		};
		const project = sameRoot && previous !== undefined ? previous : createTypeScriptProject(root, projectLoaded);
		if (sameRoot) {
			project.loaded.files = projectLoaded.files;
			project.roots.clear();
			for (const file of projectLoaded.files) project.roots.add(path.resolve(file));
		}

		return {
			model: {
				files: discovered.files,
				externalRoots: [],
				configFiles: discovered.configFiles,
				diagnostics: discovered.diagnostics,
			},
			project,
		};
	}

	/** Parse supplied text, never disk. */
	parseFile(
		params: { module: string; contentHash: string; text: string; depth?: IndexDepth | undefined },
		value: TypeScriptValue,
	) {
		if (value.surface) {
			const extracted = extractSurfaceFile(params.module, params.text);
			return {
				module: params.module,
				contentHash: params.contentHash,
				...extracted,
				// Keep detected surfaces at surface depth.
				depth: "surface" as const,
			};
		}

		// Outline parses skip binding and type analysis.
		if (params.depth === "outline") {
			const source = ts.createSourceFile(
				params.module,
				params.text,
				ts.ScriptTarget.ESNext,
				true,
				scriptKindOf(params.module),
			);
			const extracted = extractFile(params.module, source);
			return {
				module: params.module,
				contentHash: params.contentHash,
				declarations: extracted.declarations,
				references: [],
				imports: extracted.imports,
				literals: [],
				role: extracted.role,
				comments: [],
				diagnostics: syntaxErrors(params.module, source),
				depth: "outline" as const,
			};
		}

		const analyzer = this.analyzed();
		const source =
			analyzer.sourceFile(params.module) ??
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
			role: extracted.role,
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
			this.store.root,
			params.fromModule,
			params.specifier,
			this.store.project.loaded.options,
			params.surfaceGlobs,
			(module) => this.runtimeSurface(module),
		);
		if (resolution.status === "resolved" && this.store.withheld(resolution.module)) {
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
		return this.withModuleText(params.module, () => {
			if (this.runtimeSurface(params.module)) {
				return {
					status: "unbound" as const,
					reason: "DynamicallyTyped" as const,
					detail: "bundle surfaces do not retain implementation bindings",
				};
			}
			return this.analyzed().bind(params.module, params.name, params.range);
		});
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
		if (module === undefined) return this.analyzed().typeOf(params);
		return this.withModuleText(module, () => {
			if (this.runtimeSurface(module)) {
				return {
					status: "unknown" as const,
					reason: "DynamicallyTyped" as const,
					detail: "a JavaScript bundle does not retain source types",
				};
			}
			return this.analyzed().typeOf(params);
		});
	}

	renameEdits(params: Parameters<TypeScriptAnalyzer["renameEdits"]>[0]) {
		return this.analyzed().renameEdits(params);
	}

	moveEdits(params: MoveEditsRequest): MoveEditsResponse {
		if (!isValidTargetModule(this.store.root, params.toModule)) {
			return {
				status: "refused",
				reason: "InvalidTarget",
				detail: `the target is not a TypeScript module: ${params.toModule}`,
			};
		}
		const options = this.store.project.loaded.options;
		return this.analyzed().moveEdits(params, (fromModule, targetModule, preferredSpecifier) =>
			renderSpecifier(this.store.root, fromModule, targetModule, options, preferredSpecifier, (module) =>
				this.runtimeSurface(module),
			),
		);
	}

	programStats() {
		return this.analyzed().programStats();
	}

	shutdown() {
		const project = this.currentProject();
		project?.analyzer?.dispose();
		if (project !== undefined) project.analyzer = undefined;
		return {};
	}

	private runtimeSurface(module: string): boolean {
		return this.store.load(module)?.surface === true && !isDeclarationModule(module);
	}

	private withModuleText<T>(module: string, run: () => T): T {
		const held = this.store.text(module);
		if (held === undefined) return run();
		const project = this.store.project;
		const absolute = path.resolve(project.root, module.replace(/\\/g, "/"));
		if (project.roots.has(absolute) || this.store.get("root").includes(module)) return run();
		return this.store.withText(module, held.text, run);
	}

	private currentProject(): TypeScriptProject | undefined {
		try {
			return this.store.project;
		} catch {
			return undefined;
		}
	}
}

////////////////////////////////
//  Main

export function serve(connection: ReturnType<typeof createMessageConnection>, provider = new TypeScriptProvider()) {
	serveProvider(connection, handlersFor(provider));
}

if (import.meta.main) runProviderOnStdio(handlersFor(new TypeScriptProvider()));
