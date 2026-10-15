import { ENTRY_HOW } from "./shared/entry.js";
import { countLabel, pagingNotes, renderGroupedModules } from "./shared/grouping.js";
import { code } from "./shared/markdown.js";
import { line, symbolBullet } from "./shared/symbol-line.js";
import type { ContentCounts, ContentTotals, Count, EntryHow, KnowledgeSweep, SymbolSummary } from "./shared/types.js";

/**
 * The shape of a whole repository.
 *
 * The scope line is the load-bearing one: an index built by walking a disk and one built from what
 * git tracks are different claims, and a reader who cannot tell them apart will read the first as
 * the second.
 */
export function renderOverview(result: {
	files: number;
	symbols: number;
	references: number;
	imports: number;
	literals: number;
	content?: ContentTotals;
	modules: number;
	scope: string;
	index: {
		state: string;
		done: number;
		total: number;
		failures?: number;
		stored?: number;
		fullFiles?: number;
		outlineFiles?: number;
	};
	scan?: {
		tracked: number;
		claimed: number;
		unclaimed: number;
		generated: number;
		denied: number;
		knowledgeSweep?: KnowledgeSweep;
	};
	parseFailures?: Array<{ module: string; reason: string }>;
	notes?: { noted: number; unknown: number };
	largest: Array<{ module: string; symbols: number }>;
	largestData?: Array<{ module: string; symbols: number; content: "data" | "document" }>;
	entryPoints?: Array<{ module: string; how: EntryHow; symbolId?: string | undefined }> | undefined;
	moreEntryPoints?: number | undefined;
}): string {
	const lines = [
		`# Workspace overview

## Workspace

${code(result.scope)}

## Index
`,
	];

	// Show progress for counted states.
	const counted = ["warming", "indexing", "upgrading"].includes(result.index.state);
	const stateNote =
		result.index.state === "unstarted"
			? `serving stored facts; nothing rescanned this run`
			: `${result.index.state}${counted ? ` (${result.index.done} of ${result.index.total})` : ""}`;
	lines.push(`- State: ${stateNote}`);

	const outline = result.index.outlineFiles ?? 0;
	if (outline > 0) {
		lines.push(`- Depth: ${result.index.fullFiles ?? 0} modules at final depth, ${outline} outline only`);
		lines.push(`  - reference and literal counts are lower bounds until the upgrade finishes`);
	}

	const failures = result.index.failures ?? 0;
	if (failures > 0) {
		lines.push(`- Files failed to parse: ${failures}; any facts indexed before the failure were kept`);
	}

	// Notes, never verdicts.
	const noted = result.notes?.noted ?? 0;
	const unknown = result.notes?.unknown ?? 0;
	if (noted > 0) lines.push(`- Files with provider notes: ${noted}; \`outline_module\` shows them`);
	if (unknown > 0) lines.push(`- Files read before notes were kept: ${unknown}; known after their next read`);

	// Scan parts sum to total.
	if (result.scan !== undefined) {
		const { tracked, claimed, unclaimed, generated, denied } = result.scan;
		lines.push(`- Last scan: ${tracked} files seen`);
		lines.push(`  - ${claimed} claimed by providers`);
		lines.push(`  - ${unclaimed} claimed by no provider`);
		if (generated > 0) lines.push(`  - ${generated} generated`);
		if (denied > 0) lines.push(`  - ${denied} outside scope`);
		const sweep = result.scan.knowledgeSweep;
		if (sweep !== undefined) {
			const early = sweep.stoppedEarly ? "; stopped at its cap, resuming next pass" : "";
			lines.push(
				`  - Last knowledge sweep: ${sweep.examined} subjects examined, ${sweep.rebound} rebound, ${sweep.orphaned} orphaned, ${sweep.deleted} deleted${early}`,
			);
		}
	}

	// Keep every path; group only repeated reasons.
	const named = result.parseFailures ?? [];
	if (named.length > 0) {
		const byReason = new Map<string, string[]>();
		for (const failure of named) {
			const modules = byReason.get(failure.reason) ?? [];
			modules.push(failure.module);
			byReason.set(failure.reason, modules);
		}
		const ranked = [...byReason.entries()].sort((a, b) => b[1].length - a[1].length);

		lines.push(`
## Failed to parse
`);
		for (const [reason, modules] of ranked) {
			lines.push(`- ${reason}${modules.length === 1 ? "" : ` (${modules.length} files)`}`);
			for (const module of modules) lines.push(`  - ${code(module)}`);
		}
	}

	lines.push(`
## Counts

| Files | Symbols | References | Imports | Literals | Modules |
| ---: | ---: | ---: | ---: | ---: | ---: |
| ${result.files} | ${result.symbols} | ${result.references} | ${result.imports} | ${result.literals} | ${result.modules} |`);

	// Named where the number is, because "symbols" reads as callable code and a fixture's keys are not.
	if (result.content !== undefined) {
		const { files, symbols } = result.content;
		if (files.data + files.document > 0) {
			lines.push(`
> Files: ${contentClasses(files, "")}. Symbols: ${contentClasses(symbols, "in ")}.
`);
		}
		if (files.text > 0)
			lines.push(`
> ${files.text} files read as plain text.`);
		if (files.unknown > 0) {
			lines.push(
				"",
				`> ${files.unknown} file${files.unknown === 1 ? " was" : "s were"} read before their content class was recorded; the next scan records it without re-reading them.`,
			);
		}
		if (symbols.data > symbols.code) {
			lines.push(`
> Data files carry more symbols than code. A \`deny\` list in \`lexicon.json\` at the workspace root keeps fixture directories out of the index.
`);
		}
	}

	// Self-contained: the depth line is absent once nothing is outline, so pointing at it would
	// reference a line that is not on the page.
	const external = (result.index.stored ?? result.files) - result.files;
	if (external > 0) {
		lines.push(`
> Counts cover workspace files. The index holds ${external} external surface module${external === 1 ? "" : "s"} besides, ${result.index.stored} in total.
`);
	}

	if (result.entryPoints !== undefined || result.moreEntryPoints !== undefined) {
		const entries = result.entryPoints ?? [];
		lines.push(`
## Entry points
`);
		if (entries.length === 0 && result.moreEntryPoints === undefined) lines.push("No recognized entry points.");
		for (const entry of entries) {
			const main = entry.symbolId === undefined ? "" : `, ${code(entry.symbolId)}`;
			lines.push(`- ${code(entry.module)}: ${ENTRY_HOW[entry.how]}${main}`);
		}
		if (result.moreEntryPoints !== undefined) {
			lines.push(`
> ${result.moreEntryPoints} more not shown.`);
		}
	}

	lines.push(`
## Largest modules
`);
	for (const module of result.largest) lines.push(`- ${code(module.module)}: ${module.symbols} symbols`);

	const data = result.largestData ?? [];
	if (data.length > 0) {
		lines.push(`
## Largest data and document files
`);
		for (const row of data) lines.push(`- ${code(row.module)}: ${row.symbols} symbols (${row.content})`);
	}
	return lines.join("\n");
}

/** "100 code, 40 data, 3 documents", leaving out a class with nothing in it. */
function contentClasses(counts: ContentCounts, prefix: string): string {
	const parts = [`${counts.code} ${prefix}code`];
	if (counts.data > 0) parts.push(`${counts.data} ${prefix}data`);
	if (counts.document > 0) parts.push(`${counts.document} ${prefix}document${counts.document === 1 ? "" : "s"}`);
	if (counts.text > 0) parts.push(`${counts.text} ${prefix}plain text`);
	return parts.join(", ");
}

/** Import sites, grouped by the file doing the importing. */
export function renderImports(result: {
	imports: Array<{
		module: string;
		specifier: string;
		name?: string | undefined;
	}>;
	count: Count;
}): string {
	if (result.count.count === 0) return `# Imports\n\nNo imports matched.${pagingNotes(result.count, 0, "import")}`;

	const byModule = new Map<string, Set<string>>();
	for (const statement of result.imports) {
		const specifiers = byModule.get(statement.module) ?? new Set();
		// The name is shown when there is one. Its absence means the statement binds the module
		// rather than an export, which is a real import and not a missing field.
		const named = statement.name === undefined ? "" : `  { ${statement.name} }`;
		specifiers.add(`${statement.specifier}${named}`);
		byModule.set(statement.module, specifiers);
	}

	const rows = new Map<string, string[]>();
	for (const [module, specifiers] of byModule) {
		rows.set(
			module,
			Array.from(specifiers, (specifier) => `- ${code(specifier)}`),
		);
	}
	const body = renderGroupedModules(
		`${byModule.size} file${byModule.size === 1 ? "" : "s"}, ${countLabel(result.count, "import entry", "import entries")}`,
		rows,
	);
	return body + pagingNotes(result.count, result.imports.length, "import entry", "import entries");
}

/** The most-referenced symbols, which is where reading pays off most. */
export function renderMostReferenced(
	rows: Array<{
		symbolId: string;
		count: number;
		declaration: SymbolSummary | null;
	}>,
): string {
	if (rows.length === 0) return `# Most referenced\n\nNothing is referenced yet.`;

	const lines = [
		`# Most referenced

| Symbol | References |
| --- | ---: |`,
	];
	for (const row of rows) {
		const where = row.declaration
			? `${line(row.declaration)} in ${code(row.declaration.module)}`
			: code(row.symbolId);
		lines.push(`| ${where} | ${row.count} |`);
	}
	lines.push(`
> Counts are bounded by what binding resolved.`);
	return lines.join("\n");
}

/** Symbols found by a name search, grouped by file. Where browsing starts. */
export function renderSymbolSearch(result: {
	text?: string | undefined;
	regex?: string | undefined;
	symbols: SymbolSummary[];
	count: Count;
}): string {
	const query = result.regex === undefined ? JSON.stringify(result.text) : `regex ${JSON.stringify(result.regex)}`;
	if (result.count.count === 0) return `# Symbol search\n\nNo symbol name matches ${query}.`;

	const byModule = new Map<string, string[]>();
	for (const symbol of result.symbols) {
		const rows = byModule.get(symbol.module) ?? [];
		// The id rides along because it is the address every other tool takes. Without it a search
		// hit has to be looked up again before it can be read, replaced or renamed.
		rows.push(symbolBullet(symbol), `  ID: ${code(symbol.symbolId)}`);
		byModule.set(symbol.module, rows);
	}

	const body = renderGroupedModules(`${countLabel(result.count, "symbol")} matching ${query}`, byModule);
	const raise = `Raise \`limit\` or narrow by kind or module.`;
	return body + pagingNotes(result.count, result.symbols.length, "symbol", "symbols", raise);
}
