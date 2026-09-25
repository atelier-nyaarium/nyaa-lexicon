import path from "node:path";
import { type Diagnostic, type ModuleStore, type ModuleValue, moduleStore } from "@nyaa-lexicon/protocol";
import ts from "typescript";
import type { TypeScriptAnalyzer } from "./analyzer.js";
import { isLikelyBundle } from "./bundle.js";
import { scriptKindOf } from "./file-types.js";
import type { LoadedProject } from "./project.js";

const JAVASCRIPT = new Set([ts.ScriptKind.JS, ts.ScriptKind.JSX]);

function asErrors(problems: readonly ts.Diagnostic[]): Diagnostic[] {
	return problems.map((problem) => ({
		severity: "error",
		message: ts.flattenDiagnosticMessageText(problem.messageText, " "),
	}));
}

/** Parser diagnostics for surface parses. */
export function parseErrors(source: ts.SourceFile): Diagnostic[] {
	return asErrors((source as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics ?? []);
}

/** Parser errors plus JavaScript grammar diagnostics. */
export function syntaxErrors(module: string, source: ts.SourceFile): Diagnostic[] {
	if (!JAVASCRIPT.has(scriptKindOf(module))) return parseErrors(source);
	const options: ts.CompilerOptions = { allowJs: true, noResolve: true, noLib: true, noEmit: true };
	const host = ts.createCompilerHost(options);
	host.getSourceFile = (name) => (name === source.fileName ? source : undefined);
	host.fileExists = (name) => name === source.fileName;
	const program = ts.createProgram({ rootNames: [source.fileName], options, host });
	return asErrors(program.getSyntacticDiagnostics(source));
}

export interface TypeScriptValue extends ModuleValue {
	readonly surface: boolean;
}

export interface TypeScriptProject {
	readonly root: string;
	readonly loaded: LoadedProject;
	readonly roots: Set<string>;
	analyzer: TypeScriptAnalyzer | undefined;
}

export type TypeScriptStore = ModuleStore<TypeScriptValue, TypeScriptProject, string>;

export function createTypeScriptProject(root: string, loaded: LoadedProject): TypeScriptProject {
	return {
		root: path.resolve(root),
		loaded,
		roots: new Set(loaded.files.map((file) => path.resolve(file))),
		analyzer: undefined,
	};
}

export function createTypeScriptStore(): TypeScriptStore {
	return moduleStore<TypeScriptValue, TypeScriptProject, string>({
		read: (module, text, depth) => {
			const surface =
				depth === "surface" || module.split("/").includes("node_modules") || isLikelyBundle(module, text);
			const kind = scriptKindOf(module);
			// JavaScript grammar checks need parent pointers.
			const source = ts.createSourceFile(module, text, ts.ScriptTarget.ESNext, JAVASCRIPT.has(kind), kind);
			return { surface, diagnostics: surface ? parseErrors(source) : syntaxErrors(module, source) };
		},
		same: (a, b) =>
			a.surface === b.surface &&
			a.diagnostics.length === b.diagnostics.length &&
			a.diagnostics.every((diagnostic, index) => {
				const other = b.diagnostics[index];
				return (
					other !== undefined &&
					diagnostic.severity === other.severity &&
					diagnostic.message === other.message &&
					diagnostic.path === other.path &&
					diagnostic.range?.start.line === other.range?.start.line &&
					diagnostic.range?.start.character === other.range?.start.character &&
					diagnostic.range?.end.line === other.range?.end.line &&
					diagnostic.range?.end.character === other.range?.end.character
				);
			}),
		// Fills never root, so a fill made during a probe cannot change the Program.
		indexParsesOnly: true,
		entries: (module, value, _held, project) => {
			const absolute = path.resolve(project.root, module.replace(/\\/g, "/"));
			return !value.surface && !project.roots.has(absolute) ? [["root", module]] : [];
		},
	});
}
