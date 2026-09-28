// One id per declaration: overloads numbered, redeclarations merged, and what still shares a name
// numbered by occurrence.

import { listAt } from "./collections.js";
import type { DraftRecord } from "./model.js";
import { type Alternative, exclusive } from "./tokens.js";
import { namePath } from "./typeText.js";

////////////////////////////////
//  Constants

const CLASS_KINDS: ReadonlySet<string> = new Set(["class", "struct", "union", "enum", "scoped enum"]);

////////////////////////////////
//  Functions & Helpers

function keyOf(draft: DraftRecord): string {
	return namePath(draft)
		.map(
			(descriptor) =>
				`${descriptor.kind}:${descriptor.name}:${descriptor.disambiguator ?? ""}:${descriptor.occurrence ?? ""}`,
		)
		.join("/");
}

function depthOf(draft: DraftRecord): number {
	let depth = 0;
	for (let current = draft.parent; current !== null; current = current.parent) depth++;
	return depth;
}

/** A class, struct, union or enum with its body. */
function defines(draft: DraftRecord): boolean {
	return draft.hasBody || draft.memberInsertLine !== undefined;
}

/** `typedef struct A A;`: a name for the tag it repeats. */
function repeatsTag(draft: DraftRecord): boolean {
	if (draft.languageKind !== "typedef" || draft.type?.status !== "known") return false;
	const [key, tag, ...rest] = draft.type.display.split(" ");
	return rest.length === 0 && tag === draft.name && CLASS_KINDS.has(key ?? "");
}

/**
 * Overloads of one name in one scope, numbered where each is reported, so a merged definition
 * counts at its body, not its prototype.
 */
export function assignDisambiguators(drafts: readonly DraftRecord[]): void {
	const groups = new Map<string, DraftRecord[]>();
	for (const draft of drafts)
		if (draft.own.kind === "method" && draft.mergedInto === undefined) listAt(groups, keyOf(draft)).push(draft);
	for (const group of groups.values()) {
		if (group.length < 2) continue;
		group.sort((left, right) => left.startIndex - right.startIndex);
		for (const [index, draft] of group.entries()) if (index > 0) draft.own.disambiguator = String(index);
	}
}

/**
 * Redeclarations of one entity folded into one declaration: a namespace's later openings into its
 * first, a class's forward declarations and `typedef struct A A;` into its definition, and `extern`
 * declarations into the variable's definition. Only a namespace folds across branches of one `#if`
 * group. Each pair is `[merged, into]`.
 */
export function mergeRedeclarations(
	drafts: readonly DraftRecord[],
	alternativeOf: (draft: DraftRecord) => Alternative | undefined,
): Array<[DraftRecord, DraftRecord]> {
	const groups = new Map<string, DraftRecord[]>();
	const heads = new Map<DraftRecord, DraftRecord[]>();
	for (const draft of drafts)
		if (draft.kind === "typeParameter" && draft.parent !== null) listAt(heads, draft.parent).push(draft);
	for (const draft of drafts)
		if (
			draft.visibleEnd === undefined &&
			(draft.own.kind === "namespace" || draft.own.kind === "type" || draft.own.kind === "term")
		)
			listAt(groups, keyOf(draft)).push(draft);
	const merges: Array<[DraftRecord, DraftRecord]> = [];
	for (const group of groups.values()) {
		if (group.length < 2) continue;
		const into =
			group.find((draft) => draft.kind === "namespace") ??
			group.find((draft) => CLASS_KINDS.has(draft.languageKind ?? "") && defines(draft)) ??
			group.find((draft) => draft.own.kind === "term" && draft.declarationOnly !== true) ??
			(group[0] as DraftRecord);
		for (const draft of group) {
			if (draft === into) continue;
			const forward = CLASS_KINDS.has(draft.languageKind ?? "") && !defines(draft);
			const apart = exclusive(alternativeOf(draft), alternativeOf(into));
			const redeclares =
				(into.kind === "namespace" && draft.kind === "namespace") ||
				(!apart && CLASS_KINDS.has(into.languageKind ?? "") && (forward || repeatsTag(draft))) ||
				(!apart && into.own.kind === "term" && draft.declarationOnly === true);
			if (!redeclares) continue;
			draft.mergedInto = into;
			// A definition whose template head a macro hides takes the forward declaration's.
			const forwarded = heads.get(draft) ?? [];
			if (forwarded.length > 0 && !heads.has(into)) {
				for (const parameter of forwarded) parameter.parent = into;
				heads.set(into, forwarded);
			}
			into.declaredAt = Math.min(
				into.declaredAt ?? into.nameStartIndex,
				draft.declaredAt ?? draft.nameStartIndex,
			);
			merges.push([draft, into]);
		}
	}
	return merges;
}

/** Whether a draft is left out of the reported declarations: merged, or held by a merged forward declaration. */
export function isHidden(draft: DraftRecord): boolean {
	for (let current: DraftRecord | null = draft; current !== null; current = current.parent) {
		if (current.mergedInto !== undefined && (current === draft || current.kind !== "namespace")) return true;
	}
	return false;
}

/**
 * Declarations still sharing an id, as `#if` alternatives or unnamed structs side by side, numbered
 * by occurrence in source order; enclosing ones first, since their numbers are part of the key.
 */
export function assignOccurrences(drafts: readonly DraftRecord[]): void {
	const byDepth = new Map<number, DraftRecord[]>();
	for (const draft of drafts) if (!isHidden(draft)) listAt(byDepth, depthOf(draft)).push(draft);
	for (const depth of [...byDepth.keys()].sort((left, right) => left - right)) {
		const groups = new Map<string, DraftRecord[]>();
		for (const draft of byDepth.get(depth) ?? []) listAt(groups, keyOf(draft)).push(draft);
		for (const group of groups.values()) {
			if (group.length < 2) continue;
			group.sort((left, right) => left.nameStartIndex - right.nameStartIndex);
			for (const [index, draft] of group.entries()) if (index > 0) draft.own.occurrence = index + 1;
		}
	}
}
