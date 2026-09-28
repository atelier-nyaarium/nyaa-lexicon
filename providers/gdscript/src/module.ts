import {
	type Declaration,
	type Diagnostic,
	type Held,
	type Import,
	type IndexDepth,
	type Literal,
	type ModuleStore,
	type ModuleValue,
	moduleStore,
	type Reference,
} from "@nyaa-lexicon/protocol";
import { extractFile, extractOutline } from "./extract.js";
import type { CommentSpan, LoaderCall, TypeAnnotationFact } from "./extractCore.js";

export interface GDScriptScope {
	directory: string;
	/** Singletons: each global name and the script it binds to. */
	autoloads: Readonly<Record<string, string>>;
	/** Scripts the engine runs on its own: the main scene's root and every autoload. */
	entries: readonly string[];
}

export interface GDScriptProject {
	scopes: readonly GDScriptScope[];
}

export interface GDScriptValue extends ModuleValue {
	declarations: Declaration[];
	/** The script's `extends` target. */
	base?: string;
	references: Reference[];
	imports: Import[];
	literals: Literal[];
	comments: CommentSpan[];
	/** Absent at outline depth. */
	blankLines?: number[];
	diagnostics: Diagnostic[];
	annotations: TypeAnnotationFact[];
	loaders: LoaderCall[];
}

export type GDScriptStore = ModuleStore<GDScriptValue, GDScriptProject, Declaration>;

export function scopeForModule(module: string, project: GDScriptProject): string {
	let match = "";
	for (const scope of project.scopes) {
		if (scope.directory === "" || module.startsWith(`${scope.directory}/`)) {
			if (scope.directory.length > match.length) match = scope.directory;
		}
	}
	return match;
}

function readGDScript(module: string, text: string, depth: IndexDepth): GDScriptValue {
	if (depth === "outline") {
		return {
			...extractOutline(module, text),
			references: [],
			imports: [],
			literals: [],
			comments: [],
			diagnostics: [],
			annotations: [],
			loaders: [],
		};
	}
	return extractFile(module, text);
}

function* classNameEntries(
	module: string,
	value: GDScriptValue,
	_held: Held,
	project: GDScriptProject,
): Iterable<readonly [string, Declaration]> {
	const scope = scopeForModule(module, project);
	for (const declaration of value.declarations) {
		if (declaration.languageKind !== "class_name") continue;
		yield [`scoped:${scope}\0${declaration.name}`, declaration];
		yield [`name:${declaration.name}`, declaration];
		yield [`id:${declaration.symbolId}`, declaration];
	}
}

export function createGDScriptStore(): GDScriptStore {
	return moduleStore<GDScriptValue, GDScriptProject, Declaration>({ read: readGDScript, entries: classNameEntries });
}
