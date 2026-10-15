import { code } from "./markdown.js";
import type { Count } from "./types.js";

function renderGroupedModules(title: string, groups: Iterable<readonly [string, readonly string[]]>): string {
	const sections = [`# ${title}`];
	for (const [module, rows] of groups) sections.push(`## ${code(module)}\n\n${rows.join("\n")}`);
	return sections.join("\n\n");
}

/** Count for a heading. */
function countLabel(count: Count, noun: string, plural = `${noun}s`): string {
	return `${count.kind === "atLeast" ? "at least " : ""}${count.count} ${count.count === 1 ? noun : plural}`;
}

/** What was cut, from the count. */
function pagingNotes(
	count: Count,
	shown: number,
	noun: string,
	plural = `${noun}s`,
	raise = `Raise \`limit\`.`,
): string {
	const notes: string[] = [];
	if (count.kind === "exact") {
		const more = count.count - shown;
		if (more > 0) notes.push(`\n\n> ${more} more ${more === 1 ? noun : plural} not shown. ${raise}`);
	} else {
		if (count.reason !== "scanCapped")
			notes.push(`\n\n> More ${plural} exist than the ${shown} shown, uncounted. ${raise}`);
		if (count.reason !== "pageCapped") {
			notes.push(
				`\n\n> The scan stopped before the end of the index, so matches beyond it were never looked at.`,
			);
		}
	}
	return notes.join("");
}

export { countLabel, pagingNotes, renderGroupedModules };
