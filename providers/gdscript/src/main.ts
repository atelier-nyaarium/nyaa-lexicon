// The GDScript provider. It reports project structure, declarations, and reference candidates.

import {
	handlersFor,
	type ImportResolution,
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
import { extractFile, LANGUAGE } from "./extract.js";
import { makeMoveEdits } from "./move.js";
import { discoverProject } from "./project.js";
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

export const REFERENCE_ROLES = ["call", "read", "write", "import", "extends", "typeUse"] as const;

const EXTENSIONS = [".gd"];
const FILENAMES = ["project.godot"];

//////// Class

export class GDScriptProvider {
	private workspaceRoot = process.cwd();
	private bindingIndex = new GDScriptBindingIndex(this.workspaceRoot);
	private typeIndex = new GDScriptTypeIndex(this.workspaceRoot, this.bindingIndex);

	initialize(workspaceRoot: string) {
		this.workspaceRoot = workspaceRoot;
		this.bindingIndex = new GDScriptBindingIndex(workspaceRoot);
		this.typeIndex = new GDScriptTypeIndex(workspaceRoot, this.bindingIndex);
		return {
			providerId: "gdscript-provider",
			language: LANGUAGE,
			extensions: EXTENSIONS,
			filenames: FILENAMES,
			protocolVersion: PROTOCOL_VERSION,
			tiers: TIERS,
			referenceRoles: [...REFERENCE_ROLES],
		};
	}

	discoverProject(workspaceRoot = this.workspaceRoot) {
		this.workspaceRoot = workspaceRoot;
		this.bindingIndex = new GDScriptBindingIndex(workspaceRoot);
		this.typeIndex = new GDScriptTypeIndex(workspaceRoot, this.bindingIndex);
		return discoverProject(workspaceRoot);
	}

	parseFile(params: { module: string; contentHash: string; text: string }) {
		const extracted = extractFile(params.module, params.text);
		this.bindingIndex.registerFile(params.module, extracted.declarations, extracted.references, params.text);
		this.typeIndex.registerFile(params.module, params.text, extracted.declarations);
		const references = extracted.references.map((reference) => ({
			...reference,
			binding: this.bindingIndex.bindReference(params.module, reference),
		}));
		return {
			module: params.module,
			contentHash: params.contentHash,
			declarations: extracted.declarations,
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
}

//////// Main

export function serve(connection: ReturnType<typeof createMessageConnection>, provider = new GDScriptProvider()): void {
	serveProvider(connection, handlersFor(provider));
}

if (import.meta.main) runProviderOnStdio(handlersFor(new GDScriptProvider()));
