import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import {
	type Binding,
	comparePositions,
	discoverByWalk,
	handlersFor,
	type ImportResolution,
	type IndexDepth,
	type MoveEditsRequest,
	type MoveEditsResponse,
	notImplementedMove,
	PROTOCOL_VERSION,
	type ProjectModel,
	parseSymbolId,
	projectDiagnostic,
	type Range,
	type RenameEditsRequest,
	runProviderOnStdio,
	serveProvider,
	type TypeInfo,
	type UnknownReason,
	workspaceFile,
} from "@nyaa-lexicon/protocol";
import type { createMessageConnection } from "vscode-jsonrpc/node";
import { type CppFacts, type CppReferenceRecord, LANGUAGE, parseCppFile } from "./parser.js";

const EXTENSIONS = [".cpp", ".cc", ".cxx", ".hpp", ".hh", ".hxx"];
const EXCLUDED_DIRECTORIES = new Set([
	".git",
	".hg",
	".svn",
	"build",
	"cmake-build-debug",
	"cmake-build-release",
	"dist",
	"node_modules",
	"out",
	"target",
	"vendor",
	"bazel-bin",
	"bazel-out",
]);
export const REFERENCE_ROLES = ["call", "read", "write", "import", "extends", "instantiate", "typeUse"] as const;

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

// Inclusive at both ends.
function contains(range: Range, position: Range["start"]): boolean {
	return comparePositions(range.start, position) <= 0 && comparePositions(position, range.end) <= 0;
}

function namesOf(id: string): string[] {
	return parseSymbolId(id)?.descriptors.map((descriptor) => descriptor.name) ?? [];
}

function sameSuffix(left: string[], right: string[]): boolean {
	return (
		left.length >= right.length && right.every((name, index) => left[left.length - right.length + index] === name)
	);
}

function unknown(reason: UnknownReason, detail: string): TypeInfo {
	return { status: "unknown", reason, detail };
}

export class CppProvider {
	private workspaceRoot = process.cwd();
	private parsedFacts = new Map<string, CppFacts>();

	initialize(workspaceRoot: string) {
		this.workspaceRoot = path.resolve(workspaceRoot);
		this.parsedFacts.clear();
		return {
			providerId: "cpp-provider",
			language: LANGUAGE,
			extensions: EXTENSIONS,
			protocolVersion: PROTOCOL_VERSION,
			tiers: TIERS,
			referenceRoles: [...REFERENCE_ROLES],
		};
	}

	discoverProject(workspaceRoot = this.workspaceRoot): ProjectModel {
		this.workspaceRoot = path.resolve(workspaceRoot);
		try {
			if (!existsSync(this.workspaceRoot))
				return projectDiagnostic(this.workspaceRoot, `workspace root does not exist: ${this.workspaceRoot}`);
			if (!statSync(this.workspaceRoot).isDirectory())
				return projectDiagnostic(
					this.workspaceRoot,
					`workspace root is not a directory: ${this.workspaceRoot}`,
				);
			const walked = discoverByWalk(this.workspaceRoot, {
				extensions: EXTENSIONS,
				excludedDirectories: EXCLUDED_DIRECTORIES,
			});
			return { files: walked.files, externalRoots: [], configFiles: walked.configFiles, diagnostics: [] };
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			return projectDiagnostic(this.workspaceRoot, `unable to inspect workspace root: ${detail}`);
		}
	}

	parseFile(params: { module: string; contentHash: string; text: string; depth?: IndexDepth | undefined }) {
		const facts = parseCppFile(params.module, params.text);
		this.parsedFacts.set(params.module, facts);
		return {
			module: params.module,
			contentHash: params.contentHash,
			declarations: facts.declarations,
			references: facts.references.map((reference) => ({
				name: reference.name,
				range: reference.range,
				role: reference.role,
				binding: this.bindingForReference(params.module, facts, reference),
				...(reference.from === null ? {} : { fromId: reference.from.declaration.symbolId }),
			})),
			imports: facts.imports,
			literals: facts.literals,
			comments: facts.comments,
			diagnostics: facts.diagnostics,
		};
	}

	resolveImport(params: { fromModule: string; specifier: string }): ImportResolution {
		const specifier = params.specifier.replace(/^<|>$/g, "").replace(/^"|"$/g, "");
		const knownImport = (
			this.parsedFacts.get(params.fromModule) ?? this.factsForModule(params.fromModule)
		)?.importFacts.find((item) => item.imported.specifier === specifier);
		if (knownImport !== undefined) {
			if (!knownImport.quoted) return { status: "external", packageName: specifier };
			return this.resolveQuotedImport(params.fromModule, specifier);
		}
		const workspaceCandidate = this.workspaceCandidate(params.fromModule, specifier);
		if (workspaceCandidate !== null) return { status: "resolved", module: workspaceCandidate };
		if (this.looksLikeWorkspaceSpecifier(specifier)) {
			return { status: "unresolved", reason: "NotIndexed", detail: "no workspace header matched the include" };
		}
		return { status: "external", packageName: specifier };
	}

	bind(params: { module: string; name: string; range: Range }): Binding {
		const facts = this.factsForModule(params.module);
		if (facts === null) return { status: "unbound", reason: "NotIndexed", detail: "module is not indexed" };
		const reference = facts.references.find(
			(candidate) => candidate.name === params.name && contains(candidate.range, params.range.start),
		);
		if (reference !== undefined) return this.bindingForReference(params.module, facts, reference);
		// Every declaration this provider extracts has its name in the source.
		const declaration = facts.declarations.find(
			(candidate) =>
				candidate.name === params.name &&
				contains(candidate.selectionRange ?? candidate.range, params.range.start),
		);
		if (declaration !== undefined) return { status: "bound", symbolId: declaration.symbolId, provenance: "bound" };
		return { status: "unbound", reason: "NotIndexed", detail: "no declaration or reference matched the range" };
	}

	typeOf(params: { symbolId: string } | { module: string; range: Range }): TypeInfo {
		if ("symbolId" in params) {
			const parsed = parseSymbolId(params.symbolId);
			if (parsed === null || parsed.language !== LANGUAGE)
				return unknown("ParseError", "the symbol id is not a C++ workspace id");
			const facts = this.factsForModule(parsed.module);
			if (facts === null) return unknown("NotIndexed", "module is not indexed");
			return (
				facts.typeAnswers.get(params.symbolId) ??
				unknown("NotImplemented", "no declared or inferred type is available")
			);
		}
		const facts = this.factsForModule(params.module);
		if (facts === null) return unknown("NotIndexed", "module is not indexed");
		const selected = facts.declarations.filter((declaration) =>
			contains(declaration.selectionRange ?? declaration.range, params.range.start),
		);
		if (selected.length > 1) return unknown("Ambiguous", "the range matches several declaration names");
		const candidates = (
			selected.length === 0
				? facts.declarations.filter((declaration) => contains(declaration.range, params.range.start))
				: selected
		).sort((left, right) => {
			const leftLines = left.range.end.line - left.range.start.line;
			const rightLines = right.range.end.line - right.range.start.line;
			return leftLines - rightLines || left.range.end.character - left.range.start.character;
		});
		const declaration = candidates[0];
		if (declaration === undefined) return unknown("NotImplemented", "no declaration type matches the range");
		return (
			facts.typeAnswers.get(declaration.symbolId) ??
			unknown("NotImplemented", "no declared or inferred type is available")
		);
	}

	renameEdits(_params: RenameEditsRequest) {
		return {
			status: "refused" as const,
			reason: "NotImplemented" as const,
			detail: "C++ rename rendering is not implemented",
		};
	}

	moveEdits(_params: MoveEditsRequest): MoveEditsResponse {
		return notImplementedMove("C++ move rendering is not implemented");
	}

	private factsForModule(module: string): CppFacts | null {
		const cached = this.parsedFacts.get(module);
		if (cached !== undefined) return cached;
		const absolute = workspaceFile(this.workspaceRoot, module);
		if (absolute === null || !existsSync(absolute)) return null;
		try {
			if (!statSync(absolute).isFile()) return null;
			const facts = parseCppFile(module, readFileSync(absolute, "utf8"));
			this.parsedFacts.set(module, facts);
			return facts;
		} catch {
			return null;
		}
	}

	private workspaceCandidate(fromModule: string, specifier: string): string | null {
		const fromDirectory = path.posix.dirname(fromModule.replace(/\\/g, "/"));
		const raw = specifier.startsWith("/") ? specifier.slice(1) : path.posix.join(fromDirectory, specifier);
		const candidates = [raw, ...EXTENSIONS.map((extension) => `${raw}${extension}`)];
		for (const candidate of candidates) {
			const absolute = workspaceFile(this.workspaceRoot, candidate);
			if (absolute === null || !existsSync(absolute)) continue;
			try {
				if (statSync(absolute).isFile()) return path.posix.normalize(candidate);
			} catch {}
		}
		return null;
	}

	private looksLikeWorkspaceSpecifier(specifier: string): boolean {
		return (
			specifier.startsWith(".") ||
			specifier.includes("/") ||
			EXTENSIONS.some((extension) => specifier.endsWith(extension))
		);
	}

	private bindingForReference(module: string, facts: CppFacts, reference: CppReferenceRecord): Binding {
		if (reference.templateDependent)
			return { status: "unbound", reason: "NotImplemented", detail: "template-dependent lookup is not resolved" };
		const local = this.localCandidates(facts, reference);
		if (local.length > 0) return this.chooseCandidates(local);
		return this.importedBinding(module, facts, reference);
	}

	private localCandidates(facts: CppFacts, reference: CppReferenceRecord) {
		const candidates = facts.records.filter((record) => {
			if (record.declaration.name !== reference.name) return false;
			if (record.nameTokenStart === reference.tokenIndex) return false;
			if (reference.qualifiedPath.length > 1)
				return sameSuffix(namesOf(record.declaration.symbolId), reference.qualifiedPath);
			return true;
		});
		const scored = candidates.map((record) => ({ record, score: this.scopeScore(reference.from, record) }));
		const best = Math.min(...scored.map((item) => item.score), Number.MAX_SAFE_INTEGER);
		return scored.filter((item) => item.score === best).map((item) => item.record);
	}

	private scopeScore(from: CppReferenceRecord["from"], candidate: CppFacts["records"][number]): number {
		if (from === null) return candidate.parent === null ? 0 : 100 + namesOf(candidate.declaration.symbolId).length;
		let score = 0;
		let current: CppFacts["records"][number] | null = from;
		while (current !== null) {
			if (candidate.parent === current) return score;
			current = current.parent;
			score++;
		}
		const fromNames = namesOf(from.declaration.symbolId).slice(0, -1);
		const candidateNames = namesOf(candidate.declaration.symbolId).slice(0, -1);
		if (sameSuffix(candidateNames, fromNames) || sameSuffix(fromNames, candidateNames))
			return 20 + Math.abs(fromNames.length - candidateNames.length);
		return 100 + candidateNames.length;
	}

	private chooseCandidates(records: CppFacts["records"]): Binding {
		const ids = records.map((record) => record.declaration.symbolId);
		if (ids.length === 1) return { status: "bound", symbolId: ids[0] as string, provenance: "bound" };
		return { status: "ambiguous", candidates: ids, provenance: "bound" };
	}

	private importedBinding(module: string, facts: CppFacts, reference: CppReferenceRecord): Binding {
		const candidates: CppFacts["records"] = [];
		let external = false;
		let unresolved = false;
		for (const imported of facts.importFacts) {
			const resolution = imported.quoted
				? this.resolveQuotedImport(module, imported.imported.specifier)
				: { status: "external" as const, packageName: imported.imported.specifier };
			if (resolution.status === "external") {
				external = true;
				continue;
			}
			if (resolution.status !== "resolved") {
				unresolved = true;
				continue;
			}
			const target = this.factsForModule(resolution.module);
			if (target === null) {
				unresolved = true;
				continue;
			}
			for (const candidate of target.records) {
				if (candidate.declaration.name !== reference.name) continue;
				if (
					reference.qualifiedPath.length > 1 &&
					!sameSuffix(namesOf(candidate.declaration.symbolId), reference.qualifiedPath)
				)
					continue;
				candidates.push(candidate);
			}
		}
		if (candidates.length > 0) return this.chooseCandidates(candidates);
		if (external)
			return {
				status: "unbound",
				reason: "ExternalDependency",
				detail: "the name comes from an external header",
			};
		if (unresolved) return { status: "unbound", reason: "NotIndexed", detail: "the included header is unresolved" };
		return { status: "unbound", reason: "NotIndexed", detail: "no indexed declaration matches the name" };
	}

	private resolveQuotedImport(fromModule: string, specifier: string): ImportResolution {
		const module = this.workspaceCandidate(fromModule, specifier);
		return module === null
			? { status: "unresolved", reason: "NotIndexed", detail: "no workspace header matched the include" }
			: { status: "resolved", module };
	}
}

export function serve(connection: ReturnType<typeof createMessageConnection>, provider = new CppProvider()): void {
	serveProvider(connection, handlersFor(provider));
}

if (import.meta.main) runProviderOnStdio(handlersFor(new CppProvider()));
