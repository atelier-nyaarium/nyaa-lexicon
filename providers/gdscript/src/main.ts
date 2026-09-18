// The GDScript provider. It reports project structure, declarations, and reference candidates.

import {
	AdmissionLedger,
	type Declaration,
	handlersFor,
	type ImportResolution,
	type ModuleAdmission,
	type MoveEditsRequest,
	type MoveEditsResponse,
	PROTOCOL_VERSION,
	type RenameEditsRequest,
	type RenameEditsResponse,
	runProviderOnStdio,
	serveProvider,
} from "@nyaa-lexicon/protocol";
import type { createMessageConnection } from "vscode-jsonrpc/node";
import { GDScriptBindingIndex, type GDScriptBindingSnapshot } from "./binding.js";
import { extractFile, LANGUAGE } from "./extract.js";
import { makeMoveEdits } from "./move.js";
import { discoverProject } from "./project.js";
import { renameGdscript } from "./rename.js";
import { GDScriptTypeIndex, type TypeFacts } from "./types.js";

//////// Types

/** Both indexes' state for one module, so one verdict settles them together. */
interface ModuleFacts {
	binding: GDScriptBindingSnapshot | undefined;
	types: TypeFacts | undefined;
}

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
	private workspaceRoot = process.cwd();
	/** What the index took, so cross-file answers match what it holds. */
	private readonly admission = new AdmissionLedger<ModuleFacts>();
	private readonly fillable = (module: string): boolean => this.admission.fillable(module);
	private bindingIndex = new GDScriptBindingIndex(this.workspaceRoot, this.fillable);
	private typeIndex = new GDScriptTypeIndex(this.workspaceRoot, this.bindingIndex, this.fillable);

	initialize(workspaceRoot: string) {
		this.rebuild(workspaceRoot);
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

	discoverProject(workspaceRoot = this.workspaceRoot) {
		this.rebuild(workspaceRoot);
		return discoverProject(workspaceRoot);
	}

	parseFile(params: { module: string; contentHash: string; text: string }) {
		const extracted = extractFile(params.module, params.text);
		this.admission.staged(params.module, params.contentHash, this.heldFacts(params.module));
		this.bindingIndex.registerFile(params.module, extracted.declarations, extracted.references, params.text);
		this.typeIndex.registerFile(params.module, params.text, extracted.declarations);
		const references = extracted.references.map((reference) => ({
			...reference,
			binding: this.bindingIndex.bindReference(params.module, reference),
		}));
		return {
			module: params.module,
			contentHash: params.contentHash,
			// A script with no class_name is named after its file; that name is nowhere to select.
			declarations: extracted.declarations.map((declaration): Declaration => {
				if (declaration.languageKind !== "script") return declaration;
				const { selectionRange: _synthesized, ...named } = declaration;
				return named;
			}),
			references,
			imports: extracted.imports,
			literals: extracted.literals,
			comments: extracted.comments,
			diagnostics: extracted.diagnostics,
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
		return renameGdscript(params, (name) => this.bindingIndex.hasRegisteredClassName(name));
	}

	moveEdits(params: MoveEditsRequest): MoveEditsResponse {
		return makeMoveEdits(params, this.bindingIndex);
	}

	forgetModule(params: { module: string }): void {
		this.bindingIndex.forget(params.module);
		this.typeIndex.forget(params.module);
		this.admission.forgotten(params.module);
	}

	/** A refused parse is put back, so a `class_name` resolves to what the index holds. */
	moduleAdmission(params: ModuleAdmission): void {
		const restore = this.admission.settle(params);
		if (restore === null) return;
		this.bindingIndex.restore(restore.module, restore.facts?.binding);
		this.typeIndex.restore(restore.module, restore.facts?.types);
	}

	private rebuild(workspaceRoot: string): void {
		this.workspaceRoot = workspaceRoot;
		this.admission.reset();
		this.bindingIndex = new GDScriptBindingIndex(workspaceRoot, this.fillable);
		this.typeIndex = new GDScriptTypeIndex(workspaceRoot, this.bindingIndex, this.fillable);
	}

	private heldFacts(module: string): ModuleFacts | undefined {
		const binding = this.bindingIndex.snapshot(module);
		const types = this.typeIndex.snapshot(module);
		if (binding === undefined && types === undefined) return undefined;
		return { binding, types };
	}
}

//////// Main

export function serve(connection: ReturnType<typeof createMessageConnection>, provider = new GDScriptProvider()): void {
	serveProvider(connection, handlersFor(provider));
}

if (import.meta.main) runProviderOnStdio(handlersFor(new GDScriptProvider()));
