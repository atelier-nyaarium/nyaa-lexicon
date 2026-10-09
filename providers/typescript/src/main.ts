// The TypeScript provider and its wire handlers.

import { randomUUID } from "node:crypto";
import path from "node:path";
import {
	type ArrangeEditsRequest,
	discoverByWalk,
	type FileFacts,
	handlersFor,
	hashContent,
	type ImportEditsRequest,
	type ImportEditsResponse,
	type ImportResolution,
	type IndexDepth,
	type JudgeLoadCycleAnswer,
	type JudgeLoadCycleRequest,
	type MoveEditsRequest,
	type MoveEditsResponse,
	PROTOCOL_VERSION,
	type PrepareLoadCyclePreviewRequest,
	type PrepareLoadCyclePreviewResponse,
	type ProbeBatchRequest,
	type ProbeBatchResponse,
	type ProjectModel,
	parseSymbolId,
	type ResolutionMode,
	runProviderOnStdio,
	serveProvider,
} from "@nyaa-lexicon/protocol";
import ts from "typescript";
import type { createMessageConnection } from "vscode-jsonrpc/node";
import { type Overlay, TypeScriptAnalyzer } from "./analyzer.js";
import { isDeclarationModule } from "./bundle.js";
import { extractTrivia } from "./comments.js";
import { extractFile, LANGUAGE } from "./extract.js";
import { EXTENSIONS, scriptKindOf } from "./file-types.js";
import { releasePreview, retainPreview } from "./judge/preview.js";
import { type JudgeHost, judgeLoadCycle, releaseLoadCycle } from "./judge/session.js";
import {
	createTypeScriptProject,
	createTypeScriptStore,
	syntaxErrors,
	type TypeScriptProject,
	type TypeScriptValue,
} from "./module.js";
import { isValidTargetModule } from "./move.js";
import {
	type LoadedProject,
	landingOf,
	loadProject,
	type ModuleResolver,
	optionsForFile,
	overlaidSystem,
	projectFingerprint,
	readableSystem,
	renderSpecifier,
	resolveSpecifier,
	runtimeOf,
	type SpecifierRenderer,
	syntaxMode,
	toModule,
} from "./project.js";
import { extractSurfaceFile } from "./surface.js";

////////////////////////////////
//  Constants

/** What the provider is doing while the program builds, as core shows it. */
const PROGRAM_LABEL = "building the TypeScript program";

const PROVIDER_ID = "typescript-provider";

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
	exports: true,
	renameKeep: true,
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
//  Functions & Helpers

type ReadText = { module: string; contentHash: string; text: string };

/** A surface keeps its own depth. */
function surfaceFacts(params: ReadText): FileFacts {
	const extracted = extractSurfaceFile(params.module, params.text);
	return { module: params.module, contentHash: params.contentHash, ...extracted, depth: "surface" };
}

/** Everything the program says about one module, as `analyzer` reads it. */
function fullFacts(analyzer: TypeScriptAnalyzer, params: ReadText): FileFacts {
	const source =
		analyzer.sourceFile(params.module) ??
		ts.createSourceFile(params.module, params.text, ts.ScriptTarget.ESNext, true, scriptKindOf(params.module));
	const extracted = analyzer.extract(params.module, source);
	const runtime = analyzer.runtime(params.module);
	return {
		module: params.module,
		contentHash: params.contentHash,
		...(runtime === undefined ? {} : { runtime }),
		declarations: extracted.declarations,
		references: analyzer.bindReferences(params.module, extracted.references, extracted.imports),
		imports: extracted.imports,
		exports: extracted.exports,
		literals: extracted.literals,
		role: extracted.role,
		...extractTrivia(source),
		diagnostics: analyzer.diagnostics(params.module),
	};
}

////////////////////////////////
//  Class

export class TypeScriptProvider {
	readonly store = createTypeScriptStore();

	initialize(_workspaceRoot: string) {
		return {
			providerId: PROVIDER_ID,
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

	/**
	 * Builds a cold program between requests, bracketed for core: "initializing", a turn for that
	 * to go out before the build holds the thread, the build, then "ready". Answers the build to
	 * wait on, or nothing once the program is built. A replaced project or a shutdown skips it.
	 */
	warmProgram(): Promise<void> | undefined {
		const project = this.currentProject();
		if (project === undefined) return undefined;
		if (project.warming !== undefined) return project.warming;
		const analyzer = this.analyzed();
		if (!analyzer.cold()) return undefined;
		this.store.announcePhase("initializing", PROGRAM_LABEL);
		const warming = new Promise<void>((resolve) => setTimeout(resolve, 0))
			.then(() => {
				if (this.currentProject() !== project || project.analyzer !== analyzer) return;
				try {
					analyzer.warm();
				} catch {
					// The request that needs the program meets the same failure and reports it.
				}
			})
			.finally(() => {
				project.warming = undefined;
				this.store.announcePhase("ready");
			});
		project.warming = warming;
		return warming;
	}

	discoverProject(
		workspaceRoot: string,
		previous: TypeScriptProject | undefined,
		scope?: string[],
	): { model: ProjectModel; project: TypeScriptProject } {
		const root = path.resolve(workspaceRoot);
		const loaded = loadProject(root, readableSystem(this.store.policy));
		const discovered =
			loaded.configFiles.length === 0
				? discoverByWalk(root, { extensions: EXTENSIONS, scope })
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
		const { fingerprint, packageFiles, lockfiles } = projectFingerprint(root, projectLoaded);
		// The warm analyzer stays while reading is unchanged.
		const kept = previous?.root === root && previous.fingerprint === fingerprint ? previous : undefined;
		if (kept === undefined) previous?.analyzer?.dispose();
		const project = kept ?? createTypeScriptProject(root, projectLoaded, fingerprint);
		if (kept !== undefined) {
			kept.loaded.files = projectLoaded.files;
			kept.loaded.groups = projectLoaded.groups;
			kept.roots.clear();
			for (const file of projectLoaded.files) kept.roots.add(path.resolve(file));
		}
		const configFiles = [
			...discovered.configFiles,
			...packageFiles.map((file) => toModule(root, file) ?? file),
			// Probed even when absent: an install writes one, and restates the project.
			...lockfiles.map((file) => toModule(root, file) ?? file),
			"tsconfig.json",
		];

		return {
			model: {
				files: discovered.files,
				externalRoots: [],
				configFiles: [...new Set(configFiles)],
				diagnostics: discovered.diagnostics,
				fingerprint,
			},
			project,
		};
	}

	/** Parse supplied text, never disk. */
	parseFile(
		params: { module: string; contentHash: string; text: string; depth?: IndexDepth | undefined },
		value: TypeScriptValue,
	): FileFacts {
		if (value.surface) return surfaceFacts(params);

		// Outline parses skip binding and type analysis.
		if (params.depth === "outline") {
			const fileName = path.resolve(this.store.project.root, params.module);
			const runtime = runtimeOf(fileName, {
				...this.store.project.loaded,
				options: optionsForFile(fileName, this.store.project.loaded),
			});
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
				...(runtime === undefined ? {} : { runtime }),
				declarations: extracted.declarations,
				references: [],
				imports: extracted.imports,
				exports: extracted.exports,
				literals: [],
				role: extracted.role,
				comments: [],
				diagnostics: syntaxErrors(params.module, source),
				depth: "outline" as const,
			};
		}
		return fullFacts(this.analyzed(), params);
	}

	resolveImport(params: {
		fromModule: string;
		specifier: string;
		surfaceGlobs?: string[] | undefined;
		resolutionMode?: ResolutionMode | undefined;
	}): ImportResolution {
		const resolution = resolveSpecifier(
			this.store.root,
			params.fromModule,
			params.specifier,
			{
				...this.store.project.loaded,
				options: optionsForFile(path.resolve(this.store.root, params.fromModule), this.store.project.loaded),
			},
			params.surfaceGlobs,
			(module) => this.runtimeSurface(module),
			params.resolutionMode,
		);
		return this.unwithheld(resolution, (module) => this.store.withheld(module));
	}

	/**
	 * Facts for each answer module and a landing for each of their specifiers, all read with every
	 * proposed text in one program. The provider holds what it held before.
	 */
	probeBatch(params: ProbeBatchRequest): ProbeBatchResponse {
		const project = this.currentProject();
		if (project === undefined) return { status: "unsupported", detail: "no project has been discovered" };
		const analyzer = this.overlayAnalyzer(params.files);
		try {
			return this.probeBatchWith(project, analyzer, params);
		} finally {
			analyzer.dispose();
		}
	}

	prepareLoadCyclePreview(params: PrepareLoadCyclePreviewRequest): PrepareLoadCyclePreviewResponse {
		const project = this.currentProject();
		if (project === undefined) return { status: "unsupported", detail: "no project has been discovered" };
		if (params.files.some((file) => hashContent(file.text) !== file.contentHash))
			return { status: "unknown", reason: "evidence" };
		if (
			params.files.some(({ module, base }) => {
				const held = this.store.text(module);
				return held !== undefined && held.contentHash !== base;
			})
		)
			return { status: "unknown", reason: "evidence" };
		const files = params.files.map(({ module, contentHash, text }) => ({ module, contentHash, text }));
		const probe = { files, answer: params.answer };
		const analyzer = this.overlayAnalyzer(files);
		try {
			const answer = this.probeBatchWith(project, analyzer, probe);
			if (answer.status !== "ready") {
				analyzer.dispose();
				return { status: "unsupported", detail: answer.detail };
			}
			const modules = [
				...new Set([
					...params.answer,
					...project.loaded.files
						.map((file) => toModule(project.root, file))
						.filter((module): module is string => module !== null),
				]),
			];
			const programs = analyzer.freezePrograms(modules);
			const resolve = new Map(
				answer.landings.map((landing) => [
					JSON.stringify([landing.module, landing.specifier, landing.resolutionMode ?? null]),
					landing.resolution.status === "resolved" ? landing.resolution.landing : null,
				]),
			);
			const admission = new Map(modules.map((module) => [module, this.store.admission(module)]));
			const surfaces = new Map(
				modules.map((module) => [
					module,
					analyzer.held(module)?.surface ?? this.store.peek(module)?.surface === true,
				]),
			);
			const token = randomUUID();
			retainPreview(
				project,
				token,
				{
					analyzer,
					programs,
					fingerprint: project.fingerprint,
					settings: [{ project: PROVIDER_ID, fingerprint: project.fingerprint }],
					host: {
						providerId: PROVIDER_ID,
						resolve: (from, specifier, mode) =>
							resolve.get(JSON.stringify([from, specifier, mode ?? null])) ?? null,
						surface: (module) => surfaces.get(module) === true && !isDeclarationModule(module),
						admission: (module) => admission.get(module) ?? { state: "outside" },
					},
				},
				Date.now(),
			);
			return {
				status: "ready",
				preview: token,
				facts: answer.facts,
				landings: answer.landings,
				settings: [{ project: PROVIDER_ID, fingerprint: project.fingerprint }],
			};
		} catch {
			analyzer.dispose();
			return { status: "unknown", reason: "model" };
		}
	}

	releaseLoadCyclePreview(params: { preview: string }): void {
		releasePreview(this.currentProject(), params.preview);
	}

	private overlayAnalyzer(files: ProbeBatchRequest["files"]): TypeScriptAnalyzer {
		const heldFiles = [...files];
		const overlay: Overlay = {
			files: new Map(heldFiles.map((file) => [file.module, { contentHash: file.contentHash, text: file.text }])),
			tag: `probe:${hashContent(JSON.stringify(heldFiles.map(({ module, contentHash }) => [module, contentHash])))}:`,
			memos: new Map(),
		};
		return this.analyzed().overlaid(overlay);
	}

	private probeBatchWith(
		project: TypeScriptProject,
		analyzer: TypeScriptAnalyzer,
		params: ProbeBatchRequest,
	): ProbeBatchResponse {
		const files = new Map(params.files.map(({ module, contentHash, text }) => [module, { contentHash, text }]));
		try {
			const facts: FileFacts[] = [];
			for (const module of params.answer) {
				const held = files.get(module) ?? this.store.text(module);
				if (held === undefined)
					return { status: "unsupported", detail: `nothing is held or proposed for ${module}` };
				const read = { module, contentHash: held.contentHash, text: held.text };
				facts.push(analyzer.held(module)?.surface === true ? surfaceFacts(read) : fullFacts(analyzer, read));
			}
			const setup = {
				...project.loaded,
				system: overlaidSystem(project.root, files, project.loaded.system),
			};
			const surface = (module: string) =>
				!isDeclarationModule(module) &&
				(files.has(module) ? analyzer.held(module)?.surface === true : this.runtimeSurface(module));
			const landings = facts.flatMap((answered) => {
				const occurrences = new Map<string, { specifier: string; resolutionMode?: ResolutionMode }>();
				for (const statement of answered.imports) {
					for (const { resolutionMode } of statement.edges) {
						const occurrence = {
							specifier: statement.specifier,
							...(resolutionMode === undefined ? {} : { resolutionMode }),
						};
						occurrences.set(JSON.stringify([statement.specifier, resolutionMode ?? null]), occurrence);
					}
				}
				const options = optionsForFile(path.resolve(project.root, answered.module), project.loaded);
				return [...occurrences.values()].map((occurrence) => ({
					module: answered.module,
					...occurrence,
					resolution: this.unwithheld(
						resolveSpecifier(
							project.root,
							answered.module,
							occurrence.specifier,
							{ ...setup, options },
							[],
							surface,
							occurrence.resolutionMode,
						),
						(module) => !files.has(module) && this.store.withheld(module),
					),
				}));
			});
			return { status: "ready", facts, landings };
		} catch {
			return { status: "unsupported", detail: "the overlay could not be analyzed" };
		}
	}

	/** A module the index forgot resolves to nothing it can read. */
	private unwithheld(resolution: ImportResolution, withheld: (module: string) => boolean): ImportResolution {
		const module = landingOf(resolution);
		if (resolution.status !== "resolved" || module === undefined || !withheld(module)) return resolution;
		return { status: "unresolved", reason: "NotIndexed", detail: `the index holds nothing for ${module}` };
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
		return this.specifierWork(params.toModule, (render, resolve) =>
			this.analyzed().moveEdits(params, render, resolve),
		);
	}

	arrangeEdits(params: ArrangeEditsRequest): MoveEditsResponse {
		return this.specifierWork(params.toModule, (render, resolve) =>
			this.analyzed().arrangeEdits(params, render, resolve),
		);
	}

	importEdits(params: ImportEditsRequest): ImportEditsResponse {
		const { render, resolve } = this.specifiers();
		return this.analyzed().importEdits(params, render, resolve);
	}

	programStats() {
		return this.analyzed().programStats();
	}

	/** Never builds a Program: before the first one exists, the answer is not ready. */
	judgeLoadCycle(params: JudgeLoadCycleRequest): JudgeLoadCycleAnswer {
		return judgeLoadCycle(this.currentProject(), this.loadCycleHost(), params);
	}

	/** Landings as `resolveImport` answers them, which is what the index stored. */
	loadCycleHost(): JudgeHost {
		return {
			providerId: PROVIDER_ID,
			resolve: (fromModule, specifier, resolutionMode) => {
				const resolution = this.resolveImport({ fromModule, specifier, resolutionMode });
				return resolution.status === "resolved" ? resolution.landing : null;
			},
			surface: (module) => this.store.peek(module)?.surface === true && !isDeclarationModule(module),
			admission: (module) => this.store.admission(module),
		};
	}

	releaseLoadCycle(params: { partial: string }): void {
		releaseLoadCycle(this.currentProject(), params.partial);
	}

	shutdown() {
		const project = this.currentProject();
		if (project !== undefined) for (const token of project.previews.keys()) releasePreview(project, token);
		project?.analyzer?.dispose();
		if (project !== undefined) project.analyzer = undefined;
		return {};
	}

	/** Refuses a target that is no TypeScript module, else runs `work` with this project's specifier lookups. */
	private specifierWork(
		toModule: string,
		work: (render: SpecifierRenderer, resolve: ModuleResolver) => MoveEditsResponse,
	): MoveEditsResponse {
		if (!isValidTargetModule(this.store.root, toModule)) {
			return {
				status: "refused",
				reason: "InvalidTarget",
				detail: `the target is not a TypeScript module: ${toModule}`,
			};
		}
		const { render, resolve } = this.specifiers();
		return work(render, resolve);
	}

	/** This project's specifier lookups. */
	private specifiers(): { render: SpecifierRenderer; resolve: ModuleResolver } {
		const setup = this.store.project.loaded;
		const surface = (module: string) => this.runtimeSurface(module);
		return {
			render: (fromModule, targetModule, preferredSpecifier, style) =>
				renderSpecifier(
					this.store.root,
					fromModule,
					targetModule,
					{ ...setup, options: optionsForFile(path.resolve(this.store.root, fromModule), setup) },
					preferredSpecifier,
					surface,
					style,
				),
			resolve: (fromModule, specifier, syntax) => {
				const fileName = path.resolve(this.store.root, fromModule);
				const fileSetup = { ...setup, options: optionsForFile(fileName, setup) };
				const mode = syntaxMode(fileName, fileSetup, syntax);
				return landingOf(
					resolveSpecifier(this.store.root, fromModule, specifier, fileSetup, [], surface, mode),
				);
			},
		};
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

/**
 * The wire handlers, warming the program right after discovery and holding a request that reads
 * it until it is built. Changed in place, since the kit hears it was served through this table.
 */
export function warmingHandlers(provider: TypeScriptProvider): ReturnType<typeof handlersFor> {
	const handlers = handlersFor(provider);
	const discover = handlers.discoverProject;
	handlers.discoverProject = (params) => {
		const model = discover(params);
		void Promise.resolve(model).then(() => provider.warmProgram());
		return model;
	};
	const reads = handlers as unknown as Record<string, (params: { depth?: IndexDepth }) => unknown>;
	for (const method of [
		"parseFile",
		"probeFile",
		"bind",
		"typeOf",
		"renameEdits",
		"moveEdits",
		"arrangeEdits",
		"importEdits",
	]) {
		const handle = reads[method] as (params: { depth?: IndexDepth }) => unknown;
		reads[method] = (params) => {
			// An outline reads no program.
			const warming = params.depth === "outline" ? undefined : provider.warmProgram();
			return warming === undefined ? handle(params) : warming.then(() => handle(params));
		};
	}
	return handlers;
}

export function serve(connection: ReturnType<typeof createMessageConnection>, provider = new TypeScriptProvider()) {
	serveProvider(connection, warmingHandlers(provider));
}

if (import.meta.main) runProviderOnStdio(warmingHandlers(new TypeScriptProvider()));
