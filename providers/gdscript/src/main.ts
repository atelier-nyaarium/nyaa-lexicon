// The GDScript provider. It reports project structure, declarations, and reference candidates.

import {
	type Declaration,
	handlersFor,
	type ImportResolution,
	type IndexDepth,
	type MoveEditsRequest,
	type MoveEditsResponse,
	PROTOCOL_VERSION,
	type RenameEditsRequest,
	type RenameEditsResponse,
	runProviderOnStdio,
	serveProvider,
} from "@nyaa-lexicon/protocol";
import type { createMessageConnection } from "vscode-jsonrpc/node";
import { GDScriptBindingIndex } from "./binding.js";
import { LANGUAGE } from "./extract.js";
import { createGDScriptStore, type GDScriptProject, type GDScriptValue } from "./module.js";
import { makeMoveEdits } from "./move.js";
import { discoverGDScriptProject } from "./project.js";
import { renameGdscript } from "./rename.js";
import { GDScriptTypeIndex } from "./types.js";

//////// Constants

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

/** GDScript 2.0 (Godot 4) keywords. Builtins are core types and the global math constants. */
export const WORDS = {
	keywords: [
		"and",
		"as",
		"assert",
		"await",
		"break",
		"breakpoint",
		"class",
		"class_name",
		"const",
		"continue",
		"elif",
		"else",
		"enum",
		"extends",
		"for",
		"func",
		"if",
		"in",
		"is",
		"match",
		"not",
		"or",
		"pass",
		"preload",
		"return",
		"self",
		"signal",
		"static",
		"super",
		"var",
		"void",
		"while",
	],
	builtins: [
		"AABB",
		"Array",
		"Basis",
		"Callable",
		"Color",
		"Dictionary",
		"INF",
		"NAN",
		"Node",
		"Node2D",
		"Node3D",
		"NodePath",
		"Object",
		"PI",
		"PackedByteArray",
		"PackedColorArray",
		"PackedFloat32Array",
		"PackedFloat64Array",
		"PackedInt32Array",
		"PackedInt64Array",
		"PackedStringArray",
		"PackedVector2Array",
		"PackedVector3Array",
		"PackedVector4Array",
		"Plane",
		"Projection",
		"Quaternion",
		"RID",
		"Rect2",
		"Rect2i",
		"Resource",
		"Signal",
		"String",
		"StringName",
		"TAU",
		"Transform2D",
		"Transform3D",
		"Variant",
		"Vector2",
		"Vector2i",
		"Vector3",
		"Vector3i",
		"Vector4",
		"Vector4i",
		"bool",
		"float",
		"int",
	],
	literals: ["false", "null", "true"],
};

export const REFERENCE_ROLES = ["call", "read", "write", "import", "extends", "typeUse"] as const;

const EXTENSIONS = [".gd"];
const FILENAMES = ["project.godot"];

//////// Class

export class GDScriptProvider {
	readonly store = createGDScriptStore();
	private readonly bindingIndex = new GDScriptBindingIndex(this.store);
	private readonly typeIndex = new GDScriptTypeIndex(this.store, this.bindingIndex);

	initialize(_workspaceRoot: string) {
		return {
			providerId: "gdscript-provider",
			language: LANGUAGE,
			extensions: EXTENSIONS,
			filenames: FILENAMES,
			protocolVersion: PROTOCOL_VERSION,
			tiers: TIERS,
			referenceRoles: [...REFERENCE_ROLES],
			words: WORDS,
		};
	}

	discoverProject(workspaceRoot: string, _previous: GDScriptProject | undefined) {
		return discoverGDScriptProject(workspaceRoot);
	}

	parseFile(
		params: { module: string; contentHash: string; text: string; depth?: IndexDepth | undefined },
		value: GDScriptValue,
	) {
		const outline = params.depth === "outline";
		const references = value.references.map((reference) => ({
			...reference,
			binding: this.bindingIndex.bindReference(params.module, reference),
		}));
		return {
			module: params.module,
			contentHash: params.contentHash,
			// A script with no class_name is named after its file; that name is nowhere to select.
			declarations: value.declarations.map((declaration): Declaration => {
				if (declaration.languageKind !== "script") return declaration;
				const { selectionRange: _synthesized, ...named } = declaration;
				return named;
			}),
			references: outline ? [] : references,
			imports: value.imports,
			literals: value.literals,
			comments: value.comments,
			diagnostics: value.diagnostics,
			...(outline ? { depth: "outline" as const } : {}),
		};
	}

	resolveImport(params: { fromModule: string; specifier: string }): ImportResolution {
		return this.bindingIndex.resolveImport(params.fromModule, params.specifier);
	}

	bind(params: {
		module: string;
		name: string;
		range: { start: { line: number; character: number }; end: { line: number; character: number } };
	}) {
		return this.bindingIndex.bind(params.module, params.name, params.range);
	}

	typeOf(
		params:
			| { symbolId: string }
			| {
					module: string;
					range: { start: { line: number; character: number }; end: { line: number; character: number } };
			  },
	) {
		return this.typeIndex.typeOf(params);
	}

	renameEdits(params: RenameEditsRequest): RenameEditsResponse {
		return renameGdscript(params, this.store);
	}

	moveEdits(params: MoveEditsRequest): MoveEditsResponse {
		return makeMoveEdits(params, this.store);
	}
}

//////// Main

export function serve(connection: ReturnType<typeof createMessageConnection>, provider = new GDScriptProvider()): void {
	serveProvider(connection, handlersFor(provider));
}

if (import.meta.main) runProviderOnStdio(handlersFor(new GDScriptProvider()));
