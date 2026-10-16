import { ENTRY_HOW } from "./shared/entry.js";
import { renderGroupedModules } from "./shared/grouping.js";
import { code, summarize } from "./shared/markdown.js";
import { line, symbolBullet } from "./shared/symbol-line.js";
import type { DescribeResult, FileNotes, FileRole, ReferencesResult, SymbolSummary, TypeInfo } from "./shared/types.js";

function appendHierarchy(lines: string[], result: DescribeResult["hierarchy"]): void {
	lines.push(`
## Type hierarchy
`);
	const hasRelationships =
		result.supertypes.length > 0 ||
		result.subtypes.length > 0 ||
		result.ancestors.length > 0 ||
		result.unboundSupertypes.length > 0;
	if (!hasRelationships) {
		lines.push(`No supertypes or subtypes in the index.`);
		return;
	}

	const list = (label: string, entries: SymbolSummary[]) => {
		if (entries.length === 0) return;
		lines.push(`### ${label}
`);
		for (const entry of entries) lines.push(`- ${line(entry)}  ${code(entry.module)}`);
	};
	list(`Extends`, result.supertypes);
	list(`Extended by`, result.subtypes);

	const indirect = result.ancestors.filter(
		(ancestor) => !result.supertypes.some((direct) => direct.symbolId === ancestor.symbolId),
	);
	if (indirect.length > 0) {
		lines.push(`
### Further up

- ${indirect.map((ancestor) => code(ancestor.name)).join(" <- ")}`);
	}
	if (result.unboundSupertypes.length > 0) {
		lines.push(`### Outside the index
`);
		for (const name of result.unboundSupertypes) lines.push(`- ${code(name)}`);
	}
}

function appendDependencies(lines: string[], summary: DescribeResult["graph"]): void {
	const via = summary.viaMembers === undefined ? "" : ` across the symbol and its ${summary.viaMembers} members`;
	lines.push(`
## Dependencies

- Uses: ${summary.fanOut} distinct symbol${summary.fanOut === 1 ? "" : "s"}${via}`);
	lines.push(`
> Counts use resolved indexed bindings.`);
}

/** Where a hazard's read or call sits, as a 1-based line an agent can open. */
function siteOf(site: { module: string; range: { start: { line: number } }; name: string }): string {
	return `${code(`${site.module}:${site.range.start.line + 1}`)} ${code(site.name)}`;
}

function appendLoadCycle(lines: string[], loadCycle: NonNullable<DescribeResult["loadCycle"]>): void {
	lines.push(`
## Load cycle

Modules: ${loadCycle.modules.map(code).join(", ")}`);
	if (loadCycle.verdict === "pending") {
		lines.push(`
> The cycle's load-order judgment is still running. Describe this symbol again for its answer.`);
		return;
	}
	lines.push("");
	for (const hazard of loadCycle.hazards) {
		lines.push(
			`- Loading ${code(hazard.entry)} first (${hazard.order.map(code).join(" -> ")}), ${siteOf(hazard.reader)} reads ${code(hazard.target.name)} (${hazard.target.kind}) in ${code(hazard.target.module)} before it is initialized.`,
		);
		if (hazard.calls.length > 0) lines.push(`  - Through ${hazard.calls.map(siteOf).join(" -> ")}`);
	}
}

function roleText(role: FileRole): string {
	if (role.kind === "library") return "library (no recognized entry pattern)";
	if (role.kind === "unknown") return `unknown (${role.reason})`;
	return `entry point: ${ENTRY_HOW[role.how]}${role.how === "main" ? `, ${code(role.symbolId)}` : ""}`;
}

/** One symbol as its complete surface. */
export function renderDescribe(result: DescribeResult): string {
	// The line span makes "read the body" a range read of exactly those lines, never a file read.
	const location =
		result.symbol.lines === undefined
			? code(result.symbol.module)
			: code(`${result.symbol.module}:${result.symbol.lines.start + 1}-${result.symbol.lines.end + 1}`);
	// A signature block for a heading would be a code fence around a section title, which reads as
	// code that does not exist.
	const signature =
		result.symbol.kind === "heading"
			? []
			: ["```ts", result.symbol.signature ?? `${result.symbol.kind} ${result.symbol.name}`, "```", ""];
	const lines = [
		`# ${result.symbol.kind} ${result.symbol.name}${result.symbol.valueStatus === undefined ? "" : ` (${result.symbol.valueStatus})`}`,
		"",
		...signature,
		`**Module:** ${location}`,
		`**ID:** ${code(result.symbol.symbolId)}`,
	];
	if (result.moduleRole !== undefined) lines.push(`**File role:** ${roleText(result.moduleRole)}`);

	if (result.prose !== undefined && result.prose.length > 0) {
		lines.push(`
## Prose
`);
		for (const region of result.prose) {
			const where = region.fenced ? ` (in a code block)` : "";
			lines.push(`- Line ${region.line + 1}${where}: ${summarize(region.text)}`);
		}
		if (result.moreProse !== undefined) {
			lines.push(`
> ${result.moreProse} more not shown. Call \`search_docs\` with this module.`);
		}
	}

	if (result.symbol.docComment) {
		lines.push(`
## Documentation

${summarize(result.symbol.docComment)}`);
	}

	if (result.members.length > 0) {
		lines.push(`
## Members
`);
		for (const member of result.members) lines.push(symbolBullet(member));
	}

	// What someone wrote about it that is not its documentation, which is otherwise only reachable
	// by opening the file.
	if (result.comments !== undefined && result.comments.length > 0) {
		lines.push(`
## Comments
`);
		for (const comment of result.comments) {
			lines.push(`- Line ${comment.line + 1} (${comment.form}): ${summarize(comment.text)}`);
		}
		if (result.moreComments !== undefined) {
			lines.push(`
> ${result.moreComments} more not shown. Call \`find_comments\` with this module.`);
		}
	}

	// Nothing calls, extends or depends on a section, so zero here would read as a checked fact
	// rather than a question that does not apply.
	if (result.symbol.kind === "heading") {
		lines.push(`
## Usage

A section is document structure, so nothing calls, extends or uses it.`);
		return lines.join("\n");
	}

	lines.push(`
## Usage

Used in ${result.referenceCount} place${result.referenceCount === 1 ? "" : "s"}.`);
	if (result.referenceCount > 0) lines.push(`Call \`find_references\` for the list.`);
	appendHierarchy(lines, result.hierarchy);
	appendDependencies(lines, result.graph);
	if (result.loadCycle !== undefined) appendLoadCycle(lines, result.loadCycle);
	return lines.join("\n");
}

/** Uses of a symbol, grouped by file so the shape of the usage is visible at a glance. */
export function renderReferences(result: ReferencesResult): string {
	if (result.total === 0) return `# References\n\nNo references found.`;

	const byModule = new Map<string, string[]>();
	for (const reference of result.references) {
		const rows = byModule.get(reference.module) ?? [];
		rows.push(`- Line ${reference.startLine + 1}: ${reference.role}`);
		byModule.set(reference.module, rows);
	}

	const body = renderGroupedModules(`${result.total} reference${result.total === 1 ? "" : "s"}`, byModule);
	return result.truncated
		? `${body}\n\n> ${result.total - result.references.length} more reference${result.total - result.references.length === 1 ? "" : "s"} not shown. Raise \`limit\`.`
		: body;
}

/**
 * A type, with how it was arrived at.
 *
 * The three statuses are rendered as three different sentences rather than one with a footnote,
 * because "the checker says number" and "nobody has implemented this" are not the same answer and
 * a caller that cannot tell them apart will treat the second as the first.
 */
export function renderType(name: string, type: TypeInfo): string {
	const lines: string[] = [
		`# ${code(name)}

## Type
`,
	];
	if (type.status === "known") {
		const from = type.provenance === "declared" ? `declared in source` : `established by ${type.provenance}`;
		lines.push(`\`\`\`ts
${type.display}
\`\`\`

## Provenance

- Known: ${from}`);
		return lines.join("\n");
	}
	if (type.status === "inferred") {
		lines.push(`\`\`\`ts
${type.display}
\`\`\`

## Provenance

- Inferred from: ${type.basis}`);
		return lines.join("\n");
	}
	lines.push(`Unknown: ${type.reason}${type.detail ? `: ${type.detail}` : ""}`);
	return lines.join("\n");
}

/** A file's notes, or why unknown. */
function renderFileNotes(notes: FileNotes | undefined): string[] {
	if (notes === undefined || (notes.known && notes.notes.length === 0)) return [];
	if (!notes.known) {
		return notes.reason === "indexedBeforeNotes"
			? ["", `> Provider notes unknown: indexed before notes were kept. Known after its next read.`]
			: [];
	}
	const lines = [
		`
## Provider notes
`,
	];
	for (const note of notes.notes) {
		const where = note.range === undefined ? "" : `Line ${note.range.start.line + 1}: `;
		lines.push(`- ${where}${note.severity}: ${note.message}`);
	}
	return lines;
}

/** Everything one file declares, nested by container. The "open the file" answer. */
export function renderOutline(module: string, declarations: SymbolSummary[], notes?: FileNotes): string {
	if (declarations.length === 0) {
		return [`# ${code(module)}`, "", `No indexed declarations.`, ...renderFileNotes(notes)].join("\n");
	}

	const children = new Map<string, typeof declarations>();
	const roots: typeof declarations = [];
	for (const declaration of declarations) {
		const parent = declaration.containerId;
		if (parent === undefined || !declarations.some((d) => d.symbolId === parent)) {
			roots.push(declaration);
			continue;
		}
		const list = children.get(parent) ?? [];
		list.push(declaration);
		children.set(parent, list);
	}

	const lines = [
		`# ${code(module)}

## ${declarations.length} declarations
`,
	];
	const walk = (nodes: typeof declarations, depth: number) => {
		for (const node of nodes) {
			const refs = node.referenceCount === undefined ? "" : ` refs=${node.referenceCount}`;
			lines.push(`${"  ".repeat(depth)}- ${line(node)}${refs}`);
			walk(children.get(node.symbolId) ?? [], depth + 1);
		}
	};
	walk(roots, 0);
	lines.push(...renderFileNotes(notes));
	return lines.join("\n");
}

/**
 * Several same-named symbols, so a caller can pick before spending a describe on each.
 *
 * Ambiguity is shown rather than resolved: choosing one silently is how an agent ends up
 * confidently reading about the wrong symbol.
 */
export function renderCandidates(name: string, candidates: SymbolSummary[]): string {
	if (candidates.length === 0) return `# Symbol lookup\n\nNo symbol named ${code(name)} is indexed.`;
	if (candidates.length === 1) return "";

	// The id per row is the whole point: telling a caller to pass a symbolId while showing none left
	// eight identical minified methods with no way to be told apart short of guessing ids blind.
	const lines = [`# ${candidates.length} symbols named ${code(name)}`];
	for (const candidate of candidates) {
		lines.push(`
## ${code(candidate.module)}

- ${line(candidate)}
  ID: ${code(candidate.symbolId)}`);
	}
	lines.push(`
Pass one of the IDs above to pick one.`);
	return lines.join("\n");
}
