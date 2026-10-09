// The Program a judgment pinned, and the evidence it read from it.

import path from "node:path";
import {
	comparePositions,
	hashContent,
	type Import,
	type Landing,
	type Range,
	type ResolutionMode,
} from "@nyaa-lexicon/protocol";
import ts from "typescript";
import { moduleEdges } from "../edges.js";
import { extractFileWithNodes } from "../extract.js";
import { claimsExtension, scriptKindOf } from "../file-types.js";
import type { LoadedProject } from "../project.js";
import { modeName, optionsForFile, runtimeOf, toModule } from "../project.js";
import { rangeOf } from "../ranges.js";
import type { Runtime } from "./model.js";

////////////////////////////////
//  Interfaces & Types

/** Where one import occurrence lands, as the index resolved it; null when outside the workspace. */
export type Resolve = (fromModule: string, specifier: string, mode: ResolutionMode | undefined) => Landing | null;

export interface PinnedSetup {
	readonly root: string;
	readonly loaded: LoadedProject;
	readonly program: ts.Program;
	readonly resolve: Resolve;
	/** A module the store reads as a surface, which runs no code the walk can see. */
	readonly surface: (module: string) => boolean;
	readonly group: (module: string) => string;
}

type Edge = Import["edges"][number];

export interface Evidence {
	module: string;
	contentHash: string;
	landings: Array<{ range: Range; landing: Landing | null }>;
}

////////////////////////////////
//  Functions & Helpers

function contains(outer: Range, inner: Range): boolean {
	return comparePositions(outer.start, inner.start) <= 0 && comparePositions(inner.end, outer.end) <= 0;
}

/** A statement's emit decision from its edges: kept when one is, undecided when one is. */
function loads(edges: readonly Edge[]): boolean | undefined {
	if (edges.some((edge) => edge.elided === undefined)) return undefined;
	return edges.some((edge) => edge.elided === false);
}

////////////////////////////////
//  Class

export class PinnedProgram {
	readonly checker: ts.TypeChecker;
	readonly program: ts.Program;
	readonly root: string;
	private readonly touched = new Set<string>();
	private readonly edges = new Map<string, Import[]>();
	private readonly decisions = new Map<string, ReadonlyMap<ts.Statement, boolean | undefined>>();
	private readonly landings = new Map<string, Landing | null>();
	private readonly memos = new Map<string, unknown>();

	constructor(private readonly setup: PinnedSetup) {
		this.program = setup.program;
		this.root = setup.root;
		this.checker = setup.program.getTypeChecker();
	}

	fileOf(module: string): string {
		return path.resolve(this.root, module);
	}

	sourceOf(module: string): ts.SourceFile | undefined {
		return this.program.getSourceFile(this.fileOf(module));
	}

	/** The workspace module a file is, when the index can hold it and the walk can read it. */
	moduleOf(file: ts.SourceFile | string): string | null {
		const fileName = typeof file === "string" ? file : file.fileName;
		const module = toModule(this.root, path.resolve(fileName));
		if (module === null || module.split("/").includes("node_modules") || !claimsExtension(module)) return null;
		return this.setup.surface(module) ? null : module;
	}

	options(module: string): ts.CompilerOptions {
		return optionsForFile(this.fileOf(module), this.setup.loaded);
	}

	group(module: string): string {
		return this.setup.group(module);
	}

	runtime(module: string): Runtime | undefined {
		const fileName = this.fileOf(module);
		return runtimeOf(fileName, { ...this.setup.loaded, options: this.options(module) });
	}

	javascript(module: string): boolean {
		const kind = scriptKindOf(module);
		return kind === ts.ScriptKind.JS || kind === ts.ScriptKind.JSX;
	}

	/** One computation per key for the life of the pin. */
	memo<T>(key: string, compute: () => T): T {
		if (this.memos.has(key)) return this.memos.get(key) as T;
		const value = compute();
		this.memos.set(key, value);
		return value;
	}

	/** The id extraction gives a workspace declaration, from the text this program holds. */
	symbolIdOf(declaration: ts.Node): string | undefined {
		const source = declaration.getSourceFile();
		const module = this.moduleOf(source);
		if (module === null || source.isDeclarationFile) return undefined;
		const ids = this.memo(`declarationIds:${module}`, () => extractFileWithNodes(module, source).declarationNodes);
		return ids.get(declaration);
	}

	/** Records `module` as read by the judgment. */
	touch(module: string): void {
		this.touched.add(module);
	}

	touchedCount(): number {
		return this.touched.size;
	}

	/** The module's import and require edges, as indexing extracts them from this program. */
	importsOf(module: string): readonly Import[] {
		const held = this.edges.get(module);
		if (held !== undefined) return held;
		const source = this.sourceOf(module);
		const imports =
			source === undefined
				? []
				: moduleEdges(source, {
						idsOf: () => [],
						checker: this.checker,
						compilerOptions: this.options(module),
						javascript: this.javascript(module),
					}).imports;
		this.edges.set(module, imports);
		return imports;
	}

	landing(module: string, specifier: string, mode: ResolutionMode | undefined): Landing | null {
		const key = JSON.stringify([module, specifier, mode ?? null]);
		if (this.landings.has(key)) return this.landings.get(key) ?? null;
		const landing = this.setup.resolve(module, specifier, mode);
		this.landings.set(key, landing);
		return landing;
	}

	/** The module a specifier literal lands on, in the mode TypeScript resolves it with; null outside. */
	target(module: string, literal: ts.StringLiteralLike): string | null {
		const source = literal.getSourceFile();
		const mode = modeName(ts.getModeForUsageLocation(source, literal, this.options(module)));
		const landing = this.landing(module, literal.text, mode);
		if (landing?.kind !== "module") return null;
		return this.moduleOf(this.fileOf(landing.module)) === null ? null : landing.module;
	}

	/** Whether emit keeps an import or re-export statement; undefined when emit is undecided. */
	statementLoads(module: string, statement: ts.Statement): boolean | undefined {
		const source = statement.getSourceFile();
		const index = this.loadsOf(module, source);
		if (index.has(statement)) return index.get(statement);
		return loads(this.edgesOf(module).filter((edge) => contains(rangeOf(statement, source), edge.span)));
	}

	/** Each top-level statement's emit decision, matched to the module's edges in one pass by position. */
	private loadsOf(module: string, source: ts.SourceFile): ReadonlyMap<ts.Statement, boolean | undefined> {
		const held = this.decisions.get(module);
		if (held !== undefined) return held;
		const edges = [...this.edgesOf(module)].sort((a, b) => comparePositions(a.span.start, b.span.start));
		const index = new Map<ts.Statement, boolean | undefined>();
		let at = 0;
		for (const statement of source.statements) {
			const span = rangeOf(statement, source);
			while (at < edges.length && comparePositions((edges[at] as Edge).span.start, span.start) < 0) at++;
			const inside: Edge[] = [];
			while (at < edges.length && contains(span, (edges[at] as Edge).span)) inside.push(edges[at++] as Edge);
			index.set(statement, loads(inside));
		}
		this.decisions.set(module, index);
		return index;
	}

	private edgesOf(module: string): readonly Edge[] {
		return this.importsOf(module).flatMap((entry) => entry.edges);
	}

	/** Every module read, with the hash of the text this program holds and each occurrence's landing. */
	evidence(): Evidence[] {
		return [...this.touched].flatMap((module) => {
			const source = this.sourceOf(module);
			if (source === undefined) return [];
			const landings = this.importsOf(module).flatMap((entry) =>
				entry.edges.map((edge) => ({
					range: edge.span,
					landing: this.landing(module, entry.specifier, edge.resolutionMode),
				})),
			);
			return [{ module, contentHash: hashContent(source.text), landings }];
		});
	}

	/** Workspace source files this program holds, for the writes index. */
	workspaceSources(): ts.SourceFile[] {
		return this.program
			.getSourceFiles()
			.filter((source) => !source.isDeclarationFile && this.moduleOf(source) !== null);
	}
}
