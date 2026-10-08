// Lookup indexes over a file's declarations: each scope's names, the windows its locals are visible
// in, the scopes code outside sees by name, and the scopes whose names a scope sees as its own.

import { ANONYMOUS_NAMESPACE, type ScopeContribution, type WorkMeter } from "@nyaa-lexicon/protocol";
import { listAt, mapAt } from "./collections.js";
import type { CppDeclarationRecord } from "./model.js";

////////////////////////////////
//  Functions & Helpers

function windowStart(record: CppDeclarationRecord): number {
	return record.visibleFrom ?? record.nameTokenStart;
}

function windowEnd(record: CppDeclarationRecord): number {
	return record.visibleEnd ?? Number.POSITIVE_INFINITY;
}

/** A scope whose names the scope around it sees: an anonymous or inline namespace, or an unscoped enum. */
export function isTransparent(record: CppDeclarationRecord): boolean {
	const { kind, name, languageKind } = record.declaration;
	if (kind === "enum") return languageKind === "enum";
	return kind === "namespace" && (name === ANONYMOUS_NAMESPACE || languageKind === "inline");
}

/** The id of the scope a record's lookups start in: `""` for the file. */
export function scopeIdOf(record: CppDeclarationRecord | null): string {
	return record?.declaration.symbolId ?? "";
}

/**
 * The names of the scopes around a record as code outside them sees it: transparent scopes left
 * out, and a written qualifier no record holds, `Foo::` in `void Foo::run()`, kept.
 */
export function seenScope(record: CppDeclarationRecord): string[] {
	const parent = record.parent;
	const qualifier = record.names.slice(parent?.names.length ?? 0, -1);
	return [...(parent === null ? [] : scopeNames(parent)), ...qualifier];
}

/** The names code outside uses for the members of `scope`. */
function scopeNames(scope: CppDeclarationRecord): string[] {
	return isTransparent(scope) ? seenScope(scope) : [...seenScope(scope), scope.declaration.name];
}

/** The qualified name code outside uses for the members of `scope`, `""` for the file's. */
export function memberPath(scope: CppDeclarationRecord | null): string {
	return scope === null ? "" : scopeNames(scope).join("::");
}

/** A namespace's scope id, an inline one's own name kept; null within an unnamed one, its file's own. */
export function namespaceScopeId(namespace: CppDeclarationRecord): string | null {
	return namespace.names.includes(ANONYMOUS_NAMESPACE) ? null : namespace.names.join("::");
}

/**
 * Each named namespace the file opens, with the members it shows outside the file: its own
 * declarations, an inline namespace's and an unscoped enum's included, and none of internal linkage.
 */
export function scopeContributionsOf(records: readonly CppDeclarationRecord[]): ScopeContribution[] {
	const members = new Map<string, string[]>();
	for (const record of records) {
		const id =
			record.declaration.kind === "namespace" && record.aliasOf === undefined ? namespaceScopeId(record) : null;
		if (id !== null) listAt(members, id);
	}
	for (const record of records) {
		const { visibility, symbolId } = record.declaration;
		if (visibility === "local" || visibility === "fileLocal" || record.names.includes(ANONYMOUS_NAMESPACE))
			continue;
		let scope = record.parent;
		while (scope?.declaration.kind === "enum" && isTransparent(scope)) scope = scope.parent;
		while (scope?.declaration.kind === "namespace") {
			const id = namespaceScopeId(scope);
			if (id === null) break;
			listAt(members, id).push(symbolId);
			if (scope.declaration.languageKind !== "inline") break;
			scope = scope.parent;
		}
	}
	return [...members].map(([scopeId, list]) => ({ kind: "packageScope", scopeId, members: list }));
}

////////////////////////////////
//  Classes

/**
 * The records one scope declares under one name. A local is found only inside its window, and the
 * windows nest like the blocks they come from, so a lookup walks one chain of enclosing windows.
 */
export class NameBucket {
	private readonly plain: CppDeclarationRecord[] = [];

	private readonly windowed: CppDeclarationRecord[] = [];

	/** For each window, sorted by start, the nearest earlier one around it; -1 for none. */
	private enclosing = new Int32Array(0);

	add(record: CppDeclarationRecord): void {
		(record.visibleEnd === undefined ? this.plain : this.windowed).push(record);
	}

	/** Orders the windows once every record is in. */
	seal(): void {
		this.windowed.sort(
			(left, right) => windowStart(left) - windowStart(right) || windowEnd(right) - windowEnd(left),
		);
		this.enclosing = new Int32Array(this.windowed.length);
		const open: number[] = [];
		for (const [index, record] of this.windowed.entries()) {
			while (
				open.length > 0 &&
				windowEnd(this.windowed[open.at(-1) as number] as CppDeclarationRecord) <= windowStart(record)
			)
				open.pop();
			this.enclosing[index] = open.at(-1) ?? -1;
			open.push(index);
		}
	}

	/** The records visible at token `at`: each one without a window, and the windows covering `at`. */
	visibleAt(at: number, meter?: WorkMeter): CppDeclarationRecord[] {
		if (this.windowed.length === 0) return this.plain;
		let low = 0;
		let high = this.windowed.length - 1;
		let last = -1;
		while (low <= high) {
			if (meter !== undefined) meter.steps++;
			const middle = (low + high) >> 1;
			if (windowStart(this.windowed[middle] as CppDeclarationRecord) <= at) {
				last = middle;
				low = middle + 1;
			} else high = middle - 1;
		}
		const found = [...this.plain];
		for (let current = last; current >= 0; current = this.enclosing[current] as number) {
			if (meter !== undefined) meter.steps++;
			const record = this.windowed[current] as CppDeclarationRecord;
			if (at < windowEnd(record)) found.push(record);
		}
		return found;
	}
}

/** A file's lookup indexes. */
export interface ScopeIndex {
	/** Each scope's declarations by name, the scope by id, `""` for the file. */
	members: Map<string, Map<string, NameBucket>>;
	/** Non-local declarations by name, under the qualified name of their scope as code outside sees it. */
	membersByPath: Map<string, Map<string, CppDeclarationRecord[]>>;
	/** Each scope's transparent scopes, by the scope's id. */
	transparentOf: Map<string, CppDeclarationRecord[]>;
}

/** Indexes the records a file reports; merged ones share their ids, so their members land together. */
export function indexScopes(records: readonly CppDeclarationRecord[]): ScopeIndex {
	const members = new Map<string, Map<string, NameBucket>>();
	const membersByPath = new Map<string, Map<string, CppDeclarationRecord[]>>();
	const transparentOf = new Map<string, CppDeclarationRecord[]>();
	for (const record of records) {
		if (record.merged) continue;
		const scopeId = scopeIdOf(record.parent);
		if (isTransparent(record)) listAt(transparentOf, scopeId).push(record);
		const name = record.declaration.name;
		const byName = mapAt(members, scopeId);
		const bucket = byName.get(name) ?? new NameBucket();
		byName.set(name, bucket);
		bucket.add(record);
		if (record.declaration.visibility !== "local")
			listAt(mapAt(membersByPath, seenScope(record).join("::")), name).push(record);
	}
	for (const byName of members.values()) for (const bucket of byName.values()) bucket.seal();
	return { members, membersByPath, transparentOf };
}
