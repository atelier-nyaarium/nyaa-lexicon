import { defined, type Import, type ImportedName } from "@nyaa-lexicon/protocol";
import { Declarations, type ParseContext } from "./declarations.js";
import type { ImportBinding } from "./model.js";
import type { Prefix } from "./prefixes.js";
import type { SpanRange } from "./references.js";
import { isNameToken, isValueToken, type RustToken } from "./tokens.js";

////////////////////////////////
//  Interfaces & Types

interface UseEntry {
	path: string[];
	sourceName: string | null;
	localName: string | null;
	sourceIndex?: number;
	localIndex?: number;
	glob: boolean;
}

////////////////////////////////
//  Classes

/** `use` and `extern crate` items: each leaf an import and a binding. */
export abstract class Imports extends Declarations {
	protected readonly importBindings: ImportBinding[] = [];
	protected readonly imports: Import[] = [];
	protected readonly useRanges: SpanRange[] = [];

	/** A written path's last segment, through the imports of its scope that rename its first. */
	protected importedName(names: readonly string[], containerId: string | undefined): string | undefined {
		let path = names;
		const followed = new Set<ImportBinding>();
		for (;;) {
			const binding = this.importBindings.find(
				(candidate) =>
					!candidate.glob &&
					candidate.localName === path[0] &&
					candidate.containerId === containerId &&
					!followed.has(candidate),
			);
			if (binding === undefined) return path.at(-1);
			followed.add(binding);
			path = [...binding.path, ...path.slice(1)];
		}
	}

	////////////////////////////////
	//  Imports

	protected parseUse(start: number, end: number, prefix: Prefix, context: ParseContext): number {
		const statement = this.statementEnd(start, end);
		const useToken = this.tokens[start] as RustToken;
		const statementToken = this.tokens[statement] as RustToken;
		this.useRanges.push({ startOffset: useToken.startOffset, endOffset: statementToken.endOffset });
		const absolute = isValueToken(this.tokens[start + 1], "::");
		for (const entry of this.useTree(start + 1, statement, [])) this.addImport(entry, prefix, context, absolute);
		return statement + 1;
	}

	/** `extern crate name;` binds the crate's name, or its alias. */
	protected parseExternCrate(start: number, end: number, prefix: Prefix, context: ParseContext): number {
		const statement = this.statementEnd(start, end);
		const nameIndex = start + 1;
		const name = this.tokens[nameIndex];
		const aliased = isValueToken(this.tokens[nameIndex + 1], "as") && isNameToken(this.tokens[nameIndex + 2]);
		const localIndex = aliased ? nameIndex + 2 : nameIndex;
		this.useRanges.push({
			startOffset: (this.tokens[start] as RustToken).startOffset,
			endOffset: (this.tokens[statement] as RustToken).endOffset,
		});
		if (isNameToken(name)) {
			const local = this.tokens[localIndex] as RustToken;
			this.addImport(
				{
					path: [name.value],
					sourceName: name.value,
					localName: local.value,
					sourceIndex: nameIndex,
					localIndex,
					glob: false,
				},
				prefix,
				context,
				true,
				false,
			);
		}
		return statement + 1;
	}

	/**
	 * One import per use-tree leaf, its specifier the leaf's whole path. An absolute one names a crate
	 * first, and a leading `::` spells that.
	 */
	private addImport(
		entry: UseEntry,
		prefix: Prefix,
		context: ParseContext,
		absolute = false,
		spelled = absolute,
	): void {
		const source = entry.sourceIndex === undefined ? undefined : this.tokens[entry.sourceIndex];
		const local = entry.localIndex === undefined ? undefined : this.tokens[entry.localIndex];
		const written = entry.glob ? [...entry.path, "*"].join("::") : entry.path.join("::");
		if (written === "") return;
		const specifier = spelled ? `::${written}` : written;
		const sourceRange = source === undefined ? undefined : { start: source.start, end: source.end };
		const localRange = local === undefined ? undefined : { start: local.start, end: local.end };
		const imported: ImportedName[] = [];
		if (sourceRange !== undefined) {
			const aliased = localRange !== undefined && entry.localIndex !== entry.sourceIndex;
			imported.push({
				name: entry.glob ? "*" : (entry.sourceName ?? "*"),
				range: sourceRange,
				...(aliased && entry.localName !== null ? { local: entry.localName, localRange } : {}),
			});
		}
		this.importBindings.push({
			specifier,
			path: entry.path,
			sourceName: entry.sourceName,
			localName: entry.localName,
			glob: entry.glob,
			...defined({
				sourceRange,
				sourceIndex: entry.sourceIndex,
				localRange,
				containerId: context.containerId,
			}),
			...(absolute ? { absolute } : {}),
			ambiguous: entry.glob,
		});
		this.imports.push({ specifier, imported, reExport: prefix.exported });
	}

	private useTree(start: number, end: number, prefix: string[]): UseEntry[] {
		const entries: UseEntry[] = [];
		let index = start;
		let path = [...prefix];
		let guard = -1;
		while (index < end) {
			if (index <= guard) throw new Error("use tree parser failed to advance");
			guard = index;
			const token = this.tokens[index] as RustToken;
			if (isValueToken(token, ",")) {
				path = [...prefix];
				index++;
				continue;
			}
			if (isValueToken(token, "{")) {
				const close = this.matchingIndex(index);
				if (close < 0 || close >= end) break;
				entries.push(...this.useTree(index + 1, close, path));
				index = close + 1;
				continue;
			}
			if (isValueToken(token, "*")) {
				entries.push({ path, sourceName: null, localName: null, sourceIndex: index, glob: true });
				index++;
				continue;
			}
			if (!isNameToken(token)) {
				index++;
				continue;
			}
			if (isValueToken(this.tokens[index + 1], "::")) {
				path = [...path, token.value];
				index += 2;
				continue;
			}
			const sourcePath = token.value === "self" && path.length > 0 ? path : [...path, token.value];
			const sourceName = sourcePath.at(-1) ?? token.value;
			const aliased = isValueToken(this.tokens[index + 1], "as") && isNameToken(this.tokens[index + 2]);
			const localIndex = aliased ? index + 2 : index;
			entries.push({
				path: sourcePath,
				sourceName,
				localName: aliased ? (this.tokens[localIndex] as RustToken).value : sourceName,
				sourceIndex: index,
				localIndex,
				glob: false,
			});
			index = localIndex + 1;
		}
		return entries;
	}
}
