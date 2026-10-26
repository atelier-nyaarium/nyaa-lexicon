import {
	type Count,
	coordinatesOf,
	type GrepMatch,
	type GrepRequest,
	GrepRequestSchema,
	type GrepResult,
	type GrepSource,
	moduleOf,
	type Range,
	rangeInRange,
	type TextCoordinates,
	unionOf,
} from "@nyaa-lexicon/protocol";
import type { SourceInventory } from "./fileScope.js";
import type { NoteLedger } from "./notes.js";
import { wire } from "./paging.js";
import { ReadContext } from "./readContext.js";
import { compileSearchRegex, searchTerm } from "./search.js";
import type { AllowedView, MaskedView } from "./sourceRead.js";
import type { IndexStore } from "./store.js";

////////////////////////////////
//  Interfaces & Types

export interface GrepAccess {
	modules(scope?: string): Promise<SourceInventory>;
	view(module: string): AllowedView;
	notes: Pick<NoteLedger, "read">;
}

////////////////////////////////
//  Constants

const SOURCES: readonly GrepSource[] = ["source", "notes", "path"];
const DEFAULT_LIMIT = 50;
const FILES_SCANNED = 5000;
const NOTES_SCANNED = 2000;
const BYTES_SCANNED = 32 * 1024 * 1024;
const SNIPPET_CHARACTERS = 500;

////////////////////////////////
//  Functions & Helpers

function under(module: string, scope: string | undefined): boolean {
	return scope === undefined || scope === "." || module === scope || module.startsWith(`${scope}/`);
}

function snippet(text: string, range: Range, coordinates: TextCoordinates, masked?: MaskedView): string {
	const start = coordinates.lineStartAt(coordinates.offsetAt(range.start) ?? 0) ?? 0;
	const from = start + Math.max(0, range.start.character - 80);
	const last = coordinates.lineText(range.end.line) ?? "";
	const end = coordinates.offsetAt({ line: range.end.line, character: last.length }) ?? text.length;
	const to = Math.min(end, from + SNIPPET_CHARACTERS);
	const selection = coordinates.rangeAt(from, to);
	return (
		masked === undefined || selection === undefined ? text.slice(from, to) : (masked.display(selection) ?? "")
	).slice(0, SNIPPET_CHARACTERS);
}

function interleaved(groups: readonly GrepMatch[][], limit: number): GrepMatch[] {
	const matches: GrepMatch[] = [];
	for (let at = 0; matches.length < limit; at++) {
		let added = false;
		for (const group of groups) {
			const match = group[at];
			if (match === undefined) continue;
			matches.push(match);
			added = true;
			if (matches.length === limit) break;
		}
		if (!added) break;
	}
	return matches;
}

////////////////////////////////
//  Class

export class GrepReader {
	constructor(
		private readonly store: IndexStore,
		private readonly access: GrepAccess,
	) {}

	async search(request: GrepRequest): Promise<GrepResult> {
		const query = GrepRequestSchema.parse(request);
		const limit = query.limit ?? DEFAULT_LIMIT;
		const expression = query.regex ?? `/${searchTerm(query.text ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/`;
		const pattern = compileSearchRegex(expression);
		const sources = SOURCES.filter((source) => query.sources === undefined || query.sources.includes(source));
		const coverage = { sources, scannedFiles: 0, skippedFiles: 0, scannedNotes: 0 };
		const groups: Record<GrepSource, GrepMatch[]> = { source: [], notes: [], path: [] };
		const inventory = await this.access.modules(query.module);
		const modules = inventory.modules.filter((module) => under(module, query.module));
		const context = new ReadContext(this.store);
		let incomplete = inventory.incomplete;
		let bytes = 0;
		for (let at = 0; at < modules.length && (sources.includes("source") || sources.includes("path")); at++) {
			if (at === FILES_SCANNED || bytes >= BYTES_SCANNED) {
				incomplete = true;
				break;
			}
			const module = modules[at];
			if (module === undefined) continue;
			if (sources.includes("path") && groups.path.length <= limit && pattern.test(module))
				groups.path.push({ kind: "path", module });
			if (!sources.includes("source") || groups.source.length > limit) continue;
			const view = this.access.view(module);
			if (view.kind !== "plain" && view.kind !== "masked") {
				coverage.skippedFiles++;
				continue;
			}
			const size = Buffer.byteLength(view.text, "utf8");
			if (size + bytes > BYTES_SCANNED) {
				incomplete = true;
				break;
			}
			bytes += size;
			coverage.scannedFiles++;
			const coordinates = coordinatesOf(view.text);
			const fresh = this.store.contentHashOf(module) === view.hash;
			const declarations = (fresh ? context.heldIn(module) : [])
				.flatMap((declaration) => {
					const span = coordinates.offsetsForRange(declaration.range);
					return span === undefined ? [] : [{ declaration, size: span.end - span.start }];
				})
				.sort((left, right) => left.size - right.size);
			const hidden =
				view.kind === "masked"
					? unionOf(
							view.hiddenRanges().flatMap((range) => {
								const span = coordinates.offsetsForRange(range);
								return span === undefined ? [] : [span];
							}),
						)
					: [];
			let hiddenAt = 0;
			const spans = pattern.ranges(view.text, limit + 1, (span) => {
				while (hidden[hiddenAt] !== undefined) {
					const end = hidden[hiddenAt]?.end ?? 0;
					if (span.start === span.end ? end >= span.start : end > span.start) break;
					hiddenAt++;
				}
				let onward: number | undefined;
				let ahead = hiddenAt;
				while (hidden[ahead] !== undefined) {
					const item = hidden[ahead];
					if (
						item === undefined ||
						(span.start === span.end ? item.start > span.start : item.start >= span.end)
					)
						break;
					onward = item.end;
					ahead++;
				}
				if (onward !== undefined) hiddenAt = ahead - 1;
				return onward;
			});
			for (const span of spans) {
				const range = coordinates.rangeAt(span.start, span.end);
				if (range === undefined) continue;
				const [first, second] = declarations.filter(({ declaration }) =>
					rangeInRange(declaration.range, range),
				);
				const owner = first !== undefined && first.size !== second?.size ? first.declaration : undefined;
				groups.source.push({
					kind: "source",
					module,
					range,
					text: snippet(view.text, range, coordinates, view.kind === "masked" ? view : undefined),
					...(owner === undefined ? {} : { symbolId: owner.symbolId, name: owner.name }),
				});
				if (groups.source.length > limit) break;
			}
			incomplete ||= spans.length > limit && groups.source.length <= limit;
		}
		if (sources.includes("notes")) {
			const addresses = this.store.notes.addresses(NOTES_SCANNED + 1, modules);
			let noteBytes = 0;
			for (const symbolId of addresses.slice(0, NOTES_SCANNED)) {
				const module = moduleOf(symbolId);
				if (module === null) continue;
				const note = this.access.notes.read(symbolId);
				if (note === null) continue;
				coverage.scannedNotes++;
				noteBytes += Buffer.byteLength(note.text, "utf8");
				if (noteBytes > BYTES_SCANNED) {
					incomplete = true;
					break;
				}
				const coordinates = coordinatesOf(note.text);
				for (const span of pattern.ranges(note.text, limit + 1)) {
					const range = coordinates.rangeAt(span.start, span.end);
					if (range === undefined) continue;
					groups.notes.push({
						kind: "note",
						module,
						symbolId,
						range,
						text: snippet(note.text, range, coordinates),
						sourceChanged: note.sourceChanged,
					});
					if (groups.notes.length > limit) break;
				}
				if (groups.notes.length > limit) break;
			}
			incomplete ||= addresses.length > NOTES_SCANNED && groups.notes.length <= limit;
		}
		const pageStopped = sources.some((source) => groups[source].length > limit);
		const total = sources.reduce((sum, source) => sum + groups[source].length, 0);
		const count: Count =
			incomplete || pageStopped
				? {
						kind: "atLeast",
						count: total,
						reason: incomplete ? (total > limit ? "pageAndScanCapped" : "scanCapped") : "pageCapped",
					}
				: { kind: "exact", count: total };
		const matches = interleaved(
			sources.map((source) => groups[source]),
			limit,
		);
		return { matches, ...wire({ items: matches, count }), coverage };
	}
}
