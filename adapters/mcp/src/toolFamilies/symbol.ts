// The structural tools, all of them read-only.
//
// Descriptions are written for the bar an agent actually applies: it already has grep and read,
// both free, so a tool earns a call only by doing something they cannot. Each description says
// what that is.

import type { ImportResolution } from "@nyaa-lexicon/protocol";
import {
	BuildRefInputSchema,
	buildRef,
	formatRefTarget,
	parseRefTarget,
	type RefTarget,
	refSelection,
	selectionWithin,
} from "@nyaa-lexicon/protocol";
import { z } from "zod";
import { renderDescribe, renderNoteLine, renderReferences, renderSymbolSource, renderType } from "../render.js";
import type { SymbolArgs, ToolBackend, ToolResult } from "../result.js";
import { textResult as text } from "../result.js";
import { diagnosed, moduleOf, resolveOne, WITHIN_NOTE, withIndexState } from "./shared.js";

////////////////////////////////
//  Schemas

export const DescribeSymbolInput = {
	name: z.string().min(1).optional().describe(`Symbol name. Omit with \`symbolId\`.`),
	symbolId: z.string().min(1).optional().describe(`Exact \`symbolId\` from an earlier result.`),
	module: z.string().min(1).optional().describe(`Workspace-relative \`module\` path.`),
};

export const FindReferencesInput = {
	name: z.string().min(1).optional().describe(`Symbol name. Omit with \`symbolId\`.`),
	symbolId: z.string().min(1).optional().describe(`Exact \`symbolId\` from an earlier result.`),
	module: z.string().min(1).optional().describe(`Workspace-relative \`module\` path.`),
	limit: z.number().int().positive().max(500).optional().describe(`Maximum results. Default: \`50\`.`),
	within: z.string().min(1).optional().describe(WITHIN_NOTE),
	usedIn: z.string().min(1).optional().describe(`Workspace-relative file or folder the uses must be in.`),
};

export const ResolveImportInput = {
	fromModule: z.string().min(1).describe(`Workspace-relative importer path.`),
	specifier: z.string().min(1).describe(`Import specifier as written.`),
};

export const ResolveRefInput = {
	ref: z.string().min(1).describe(`A raw project-ref URI from a link destination. Do not pass a Markdown link.`),
};

export const BuildRefInput = BuildRefInputSchema.shape;

export const TypeOfInput = {
	name: z.string().min(1).optional().describe(`Symbol name. Omit with \`symbolId\`.`),
	symbolId: z.string().min(1).optional().describe(`Exact \`symbolId\` from an earlier result.`),
	module: z.string().min(1).optional().describe(`Workspace-relative \`module\` path.`),
};

export const SymbolSourceInput = {
	symbolId: z.string().min(1).optional().describe(`Exact \`symbolId\` from an earlier result.`),
	factId: z.string().min(1).optional().describe(`A literal's \`factId\` from \`find_literals\`.`),
};

////////////////////////////////
//  Constants

export const DESCRIBE_DESCRIPTION = `
# \`describe_symbol\`

Show a symbol's declaration, members, type hierarchy, dependencies, usage, comments and note summary.

Documentation is the comment above it. Comments are what else was written beside the code or inside
its body. \`read_note\` shows the whole note.

Use \`symbolId\` when known. Otherwise use \`name\`, adding \`module\` when needed.
`.trim();

export const REFERENCES_DESCRIPTION = `
# \`find_references\`

List every bound use, grouped by file. Follows aliases and re-exports.

Excludes import and export statements. Call \`prepare_rename\` before a rewrite.

Use \`within\` to restrict references to declarations inside a scope, and \`usedIn\` to a file or folder.
`.trim();

export const RESOLVE_IMPORT_DESCRIPTION = `
# \`resolve_import\`

Resolve an import specifier through path mappings, package exports, and re-exports.

Distinguishes workspace files, external dependencies, and unresolved specifiers. Unresolved is a result, not an error.
`.trim();

export const BUILD_REF_DESCRIPTION = `Build a project-ref URI from the workspace key shown by list_projects, module, symbol path, and optional selection.`;

export const RESOLVE_REF_DESCRIPTION = `
# \`resolve_ref\`

Resolve a project-ref URI to its file or declaration. Accepts line spans and exact line-column selections.
`.trim();

export const SYMBOL_SOURCE_DESCRIPTION = `
# \`symbol_source\`

Read one symbol's exact source text by id, without reading the file around it.

Answers with the text and the range it occupies, so a rewrite goes back where it came from. Refuses
a stale index rather than slicing a range that has moved.
`.trim();

export const TYPE_OF_DESCRIPTION = `
# \`type_of\`

Show a symbol's resolved type.

Distinguishes declared, inferred, and unknown results.
`.trim();

////////////////////////////////
//  Handlers

export async function describeSymbol(backend: ToolBackend, args: SymbolArgs): Promise<ToolResult> {
	const resolved = await resolveOne(backend, args);
	if ("problem" in resolved) return text(await withIndexState(backend, resolved.problem, args.module), true);

	const described = await backend.describe(resolved.symbolId);
	// A file replaced between resolution and the read: the absence claim carries the index state,
	// and the diagnosis, so the answer never says less than the writers do.
	if (!described)
		return text(
			await withIndexState(backend, await diagnosed(backend, resolved.symbolId), moduleOf(resolved.symbolId)),
			true,
		);

	const note = await backend.readNote(resolved.symbolId);
	return text(`${renderDescribe(described)}\n\n${renderNoteLine(note)}`);
}

export async function findReferences(
	backend: ToolBackend,
	args: SymbolArgs & { limit?: number | undefined; within?: string | undefined; usedIn?: string | undefined },
): Promise<ToolResult> {
	const resolved = await resolveOne(backend, args);
	if ("problem" in resolved) return text(await withIndexState(backend, resolved.problem, args.module), true);

	const found = await backend.findReferences(resolved.symbolId, args.limit, args.within, args.usedIn);
	return text(await withIndexState(backend, renderReferences(found), moduleOf(resolved.symbolId)));
}

export async function typeOfSymbol(backend: ToolBackend, args: SymbolArgs): Promise<ToolResult> {
	const resolved = await resolveOne(backend, args);
	if ("problem" in resolved) return text(await withIndexState(backend, resolved.problem, args.module), true);

	const type = await backend.typeOf(resolved.symbolId);
	// The name is only for the rendered line, so falling back to the id keeps the answer readable
	// when the caller passed an id and never told us a name.
	return text(renderType(args.name ?? resolved.symbolId, type));
}

export async function symbolSource(
	backend: ToolBackend,
	args: { symbolId?: string | undefined; factId?: string | undefined },
): Promise<ToolResult> {
	if ((args.symbolId === undefined) === (args.factId === undefined)) {
		return text(`Set exactly one of \`symbolId\` or \`factId\`.`, true);
	}
	const source = await backend.symbolSource(args);
	const concerning = args.symbolId === undefined ? undefined : moduleOf(args.symbolId);
	return text(await withIndexState(backend, renderSymbolSource(source), concerning), !source.found);
}

export async function resolveImport(
	backend: ToolBackend,
	args: { fromModule: string; specifier: string },
): Promise<ToolResult> {
	const resolution = await backend.resolveImport(args.fromModule, args.specifier);

	if (resolution.status === "resolved") {
		const { landing } = resolution;
		const target =
			landing.kind === "module"
				? `\`${landing.module}\``
				: `the ${landing.kind === "packageScope" ? "package" : "symbol"} scope \`${landing.scopeId}\``;
		return text(`# Import resolved\n\n\`${args.specifier}\` resolves to ${target}.`);
	}
	if (resolution.status === "external") {
		const version = resolution.version ? `@${resolution.version}` : "";
		return text(
			`# External import\n\n\`${args.specifier}\` is external.\n\n- Package: \`${resolution.packageName}${version}\``,
		);
	}
	// Not an error: a specifier nothing resolves is a finding, and the reason says whose limit it is.
	return text(
		`# Import unresolved\n\n\`${args.specifier}\` did not resolve.\n\n- Reason: ${resolution.reason}${detailOf(resolution)}`,
	);
}

export function buildRefTool(input: unknown): ToolResult & { structuredContent?: { ref: string } } {
	const built = buildRef(input);
	if (!built.ok) {
		return text(
			`
# Ref invalid

${built.problem}
			`.trim(),
			true,
		);
	}
	return { ...text(built.ref), structuredContent: { ref: built.ref } };
}

function selectionText(target: RefTarget): string {
	if (target.lines !== undefined) {
		const { start, end } = target.lines;
		return start === end ? `line ${start}` : `lines ${start}-${end}`;
	}
	if (target.range !== undefined) {
		const point = ({ line, character }: { line: number; character: number }) => `${line + 1}:${character + 1}`;
		const start = point(target.range.start);
		const end = point(target.range.end);
		return start === end ? `line ${start}` : `${start}-${end}`;
	}
	return `whole target`;
}

export async function resolveRef(backend: ToolBackend, args: { ref: string }): Promise<ToolResult> {
	const parsed = parseRefTarget(args.ref);
	if (!parsed.ok) {
		return text(
			`
# Ref invalid

${parsed.problem}
			`.trim(),
			true,
		);
	}
	const target = parsed.target;
	const { module, segments } = target;
	const canonical = formatRefTarget(target);
	if (target.project !== backend.projectId) {
		return text(`# Ref unresolved\n\n${canonical} names a different project.`, true);
	}

	if (segments.length === 0) {
		const status = await backend.moduleStatus(module);
		if (!status.exists)
			return text(
				`
# Ref unresolved

${canonical} names no file at ${module}.
				`.trim(),
				true,
			);
		const indexState = status.indexed
			? `indexed`
			: status.claimed
				? `not indexed yet`
				: `outside the indexed scope`;
		const selection =
			target.lines === undefined && target.range === undefined
				? ""
				: `
- Requested selection: ${selectionText(target)} (file bounds are not checked)`;
		return text(
			`
# Ref resolved

${canonical} resolves to file ${module}.

- Exists: yes
- Index: ${indexState}${selection}
			`.trim(),
		);
	}

	const answer = await backend.resolveChain(module, segments);
	if (answer.kind === "exact") {
		const { candidate } = answer;
		const targetStart = candidate.range.start.line + 1;
		const targetEnd = candidate.range.end.line + 1;
		const hasSelection = target.lines !== undefined || target.range !== undefined;
		let outside = hasSelection && !selectionWithin(target, candidate.range);
		let unchecked: string | undefined;
		if (!outside && target.range !== undefined) {
			try {
				const source = await backend.symbolSource({ symbolId: candidate.symbolId });
				if (!source.found) {
					unchecked = source.reason;
				} else if (!selectionWithin(target, source.range)) {
					outside = true;
				} else {
					const toLocal = (position: { line: number; character: number }) => ({
						line: position.line - source.range.start.line,
						character:
							position.character -
							(position.line === source.range.start.line ? source.range.start.character : 0),
					});
					const localTarget: RefTarget = {
						...target,
						range: {
							start: toLocal(target.range.start),
							end: toLocal(target.range.end),
						},
					};
					const checked = refSelection(localTarget, source.text);
					if (!checked.ok) outside = true;
				}
			} catch (error) {
				unchecked = error instanceof Error ? error.message : String(error);
			}
		}
		const name =
			candidate.selectionRange === undefined
				? ""
				: `
- Name: line ${candidate.selectionRange.start.line + 1}, column ${candidate.selectionRange.start.character + 1}`;
		const selection = hasSelection
			? `
- Requested selection: ${selectionText(target)}${outside ? `; outside declaration or source text` : unchecked ? `; exact bounds unchecked: ${unchecked}` : target.range !== undefined ? `; inside declaration and source text` : `; inside declaration`}`
			: "";
		return text(
			`
# ${outside ? `Ref target found; selection is outside it` : unchecked ? `Ref target found; exact bounds unchecked` : `Ref resolved`}

${canonical} resolves to ${candidate.kind} ${candidate.name} in ${module}.

- Symbol ID: ${candidate.symbolId}
- Declaration: lines ${targetStart}-${targetEnd} (zero-based range ${candidate.range.start.line}:${candidate.range.start.character}..${candidate.range.end.line}:${candidate.range.end.character})${name}${selection}
			`.trim(),
			outside || unchecked !== undefined,
		);
	}

	if (answer.kind === "ambiguous") {
		const candidates = answer.candidates
			.map((candidate) => {
				const first = candidate.range.start.line + 1;
				const last = candidate.range.end.line + 1;
				return `- ${candidate.kind} ${candidate.name} in ${module}, lines ${first}-${last}: ${candidate.symbolId}`;
			})
			.join("\n");
		return text(
			`
# Ref ambiguous

${canonical} matches multiple declarations:

${candidates}
			`.trim(),
			true,
		);
	}

	const available =
		answer.available.length === 0
			? ""
			: `
- Names here: ${answer.available.join(", ")}`;
	return text(
		`
# Ref unresolved

${canonical} did not resolve to a declaration in ${module}.

- Reason: ${answer.reason}${answer.detail === undefined ? "" : ` (${answer.detail})`}${available}
		`.trim(),
		true,
	);
}

function detailOf(resolution: ImportResolution): string {
	return resolution.status === "unresolved" && resolution.detail ? `: ${resolution.detail}` : "";
}
