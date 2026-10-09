// An arrangement: declarations from one module, or the target's own, placed in the target as one
// plan. Worked out once against the original texts, so the preview is what gets written.

import {
	type ArrangeAnchor,
	type ArrangeEditsRequest,
	type ArrangeImportSite,
	type ArrangeMember,
	applyEdits,
	comparePositions,
	coordinatesOf,
	defined,
	hashContent,
	isWithin,
	type MoveDependency,
	type OffsetRange,
	type Position,
	type Promoted,
	type Range,
	type StoredComment,
	type StoredLiteral,
} from "@nyaa-lexicon/protocol";
import { type Landing, layoutModule } from "./arrangeLayout.js";
import { mergeRemovals } from "./arrangeText.js";
import { attachComments } from "./commentAttach.js";
import type { ImportResolver } from "./imports.js";
import { promoteDependency, promotedFrom, unacknowledgedPromotions } from "./movePromotion.js";
import type { ProviderProbe } from "./providerProbe.js";
import { ReadContext } from "./readContext.js";
import { type RefactorPlanner, workspaceModule } from "./refactorPlanner.js";
import {
	alreadyDeclaredIn,
	anchorNotPlaced,
	anchorNotTopLevel,
	arrangeCommentRefused,
	arrangeMisplaced,
	arrangeNeedsTopLevel,
	candidateDoesNotParse,
	moduleNotOnDisk,
	moduleStale,
	moveTogetherSplit,
	noInsertionPoint,
	occurrencesBlocked,
	placedTwice,
	providerRefused,
	type Refusal,
	subjectRefused,
} from "./refusals.js";
import type { SourceWorkspace } from "./sourceWorkspace.js";
import type { IndexStore, StoredReference } from "./store.js";
import type { RefactorIssue } from "./transactions.js";

////////////////////////////////
//  Interfaces & Types

export interface ArrangePlacement {
	symbolId?: string | undefined;
	factId?: string | undefined;
	/** An unplaced declaration or an earlier placement. */
	anchor?: ArrangeAnchor | undefined;
}

/** One placed declaration. */
export interface ArrangedMember {
	symbolId: string;
	name: string;
	/** Where it is declared now. */
	module: string;
	text: string;
	/** Its string literals, as offsets into `text`; a line break inside one is part of the value. */
	literals: OffsetRange[];
	range: Range;
	/** It and everything inside it. */
	closure: string[];
	/** Leaves the source for the target. */
	incoming: boolean;
	/** Its id in the target. */
	landsAs: string;
	/** Used outside the target and not exported now. */
	exports: boolean;
}

export interface ArrangedComment {
	factId: string;
	module: string;
	text: string;
	range: Range;
	incoming: boolean;
}

export type PlannedArrange =
	| {
			ok: true;
			toModule: string;
			/** The target when only its own declarations move. */
			fromModule: string;
			/** In placement order. */
			members: ArrangedMember[];
			comments: ArrangedComment[];
			/** In document order, each slot's items in landing order. */
			slots: Array<{ landing: Landing; members: string[] }>;
			/** What the incoming members use, for the target. */
			dependencies: MoveDependency[];
			promoted: Promoted[];
			/** Incoming members that what stays in the source still uses. */
			usedAtSource: string[];
			/** Other modules using incoming members, with the members each uses. */
			referencing: Map<string, string[]>;
			/** Each module's imports of incoming members, a barrel's re-export included. */
			importSites: Map<string, ArrangeImportSite[]>;
			/** Each read module's hash; null for a target not on disk. */
			bases: Map<string, string | null>;
	  }
	| { ok: false; reason: Refusal };

export type ArrangedFiles =
	| {
			ok: true;
			files: Array<{ module: string; base: string | null; text: string }>;
			issues: RefactorIssue[];
			/** Every file went through `fixText` cleanly. */
			formatted: boolean;
			/** Placed spans keyed by their original declaration or comment id. */
			placed: Array<{ symbolId: string; range: Range } | { factId: string; range: Range }>;
	  }
	| {
			ok: false;
			issues: RefactorIssue[];
			reason: Refusal;
			/** The provider does not arrange. */
			unsupported?: true;
	  };

/** `lexicon.json`'s `fixText` on one file; null when it is not set. */
export type FormatText = (module: string, text: string) => Promise<{ text: string } | { failed: string } | null>;

interface Slot {
	landing: Landing;
	/** On one line, after-anchored slots come before before-anchored ones; the end comes last. */
	rank: number;
	members: string[];
}

////////////////////////////////
//  Functions & Helpers

function rangeOf(reference: StoredReference): Range {
	return {
		start: { line: reference.startLine, character: reference.startCharacter },
		end: { line: reference.endLine, character: reference.endCharacter },
	};
}

function holds(range: Range, at: Position): boolean {
	return comparePositions(range.start, at) <= 0 && comparePositions(at, range.end) <= 0;
}

function wholeComment(text: string, comment: StoredComment): boolean {
	const coordinates = coordinatesOf(text);
	const first = coordinates.lineText(comment.range.start.line)?.slice(0, comment.range.start.character) ?? "";
	const last = coordinates.lineText(comment.range.end.line)?.slice(comment.range.end.character) ?? "";
	return first.trim() === "" && last.trim() === "";
}

function commentRemoval(text: string, range: Range): Range {
	const coordinates = coordinatesOf(text);
	const lineStart = (line: number) => coordinates.offsetAt({ line, character: 0 });
	let start = lineStart(range.start.line) ?? 0;
	let end = lineStart(range.end.line + 1) ?? text.length;
	const before = coordinates.lineText(range.start.line - 1);
	const after = coordinates.lineText(range.end.line + 1);
	if (after !== undefined && after.trim() === "") end = lineStart(range.end.line + 2) ?? text.length;
	else if (before !== undefined && before.trim() === "") start = lineStart(range.start.line - 1) ?? start;
	return { start: coordinates.positionAt(start) as Range["start"], end: coordinates.positionAt(end) as Range["end"] };
}

/** Each indexed string literal inside `range`, as offsets into the text `range` slices. */
function literalSpans(fileText: string, range: Range, literals: readonly StoredLiteral[]): OffsetRange[] {
	const coordinates = coordinatesOf(fileText);
	const within = coordinates.offsetsForRange(range);
	if (within === undefined) return [];
	return literals.flatMap((literal) => {
		const at = literal.kind === "string" ? coordinates.offsetsForRange(literal.range) : undefined;
		if (at === undefined || at.start < within.start || at.end > within.end) return [];
		return [{ start: at.start - within.start, end: at.end - within.start }];
	});
}
////////////////////////////////
//  Class

export class ArrangePlanner {
	constructor(
		private readonly store: IndexStore,
		private readonly imports: ImportResolver,
		private readonly source: SourceWorkspace,
		private readonly probe: ProviderProbe,
		private readonly planner: RefactorPlanner,
		private readonly formatText: FormatText,
	) {}

	/** What moves, where each lands, and what the incoming ones use. */
	async plan(
		rawTarget: string,
		placements: readonly ArrangePlacement[],
		context: ReadContext,
		promote = false,
	): Promise<PlannedArrange> {
		const target = workspaceModule(rawTarget);
		if ("refused" in target) return { ok: false, reason: target.refused };
		const toModule = target.module;
		const read = this.source.writable(toModule);
		if ("refused" in read) return { ok: false, reason: read.refused };
		const targetHash = read.text === null ? null : hashContent(read.text);
		const indexed = this.store.contentHashOf(toModule);
		if (indexed !== null && indexed !== targetHash) return { ok: false, reason: moduleStale(toModule) };
		const bases = new Map<string, string | null>([[toModule, targetHash]]);

		const members: ArrangedMember[] = [];
		const comments: ArrangedComment[] = [];
		let fromModule: string | undefined;
		for (const placement of placements) {
			if (placement.factId !== undefined) {
				const fact = this.store.factById(placement.factId);
				if (fact?.fact !== "comment") return { ok: false, reason: arrangeCommentRefused(placement.factId) };
				const sourceRead = this.source.writable(fact.module);
				if ("refused" in sourceRead || sourceRead.text === null) {
					return { ok: false, reason: arrangeCommentRefused(placement.factId) };
				}
				const level = context.moduleLevel(fact.module);
				if (
					fact.form !== "standalone" ||
					!(fact.anchorId === null || level.scopes.has(fact.anchorId)) ||
					!wholeComment(sourceRead.text, fact)
				)
					return { ok: false, reason: arrangeCommentRefused(placement.factId) };
				const incoming = fact.module !== toModule;
				if (incoming) {
					fromModule ??= fact.module;
					if (fact.module !== fromModule) {
						return { ok: false, reason: moveTogetherSplit(fact.raw, fact.module, fromModule) };
					}
				}
				bases.set(fact.module, hashContent(sourceRead.text));
				comments.push({
					factId: fact.factId,
					module: fact.module,
					text: fact.raw,
					range: fact.range,
					incoming,
				});
				continue;
			}
			const symbolId = placement.symbolId as string;
			const declaration = context.declaration(symbolId);
			if (declaration === null) return { ok: false, reason: subjectRefused(symbolId, this.store) };
			if (members.some((member) => member.symbolId === symbolId)) {
				return { ok: false, reason: placedTwice(declaration.name) };
			}
			if (context.isLocal(declaration) || context.ancestorsOf(declaration).length > 0) {
				return { ok: false, reason: arrangeNeedsTopLevel(declaration.name) };
			}
			const incoming = declaration.module !== toModule;
			if (incoming) {
				fromModule ??= declaration.module;
				if (declaration.module !== fromModule) {
					return { ok: false, reason: moveTogetherSplit(declaration.name, declaration.module, fromModule) };
				}
			}
			const source = this.source.symbolSourceRead({ symbolId });
			if (!source.found) return { ok: false, reason: source.reason };
			bases.set(declaration.module, source.contentHash);
			const rebased = incoming ? this.planner.rebaseIntoModule(symbolId, symbolId, toModule) : null;
			members.push({
				symbolId,
				name: declaration.name,
				module: declaration.module,
				text: source.text,
				literals: literalSpans(source.fileText, source.range, this.store.literalsIn(declaration.module)),
				range: source.range,
				closure: context.symbolIdsIn(declaration.module).filter((id) => isWithin(id, symbolId)),
				incoming,
				landsAs: rebased ?? symbolId,
				exports: false,
			});
		}

		const held = new Set(context.symbolIdsIn(toModule));
		const collides = members.find((member) => member.incoming && held.has(member.landsAs));
		if (collides !== undefined) return { ok: false, reason: alreadyDeclaredIn(collides.name, toModule) };

		const slots = this.slotsFor(placements, members, comments, toModule, context);
		if ("refused" in slots) return { ok: false, reason: slots.refused };

		const incoming = members.filter((member) => member.incoming);
		const inside = new Set(members.flatMap((member) => member.closure));
		const dependencies = new Map<string, MoveDependency>();
		for (const member of incoming) {
			const uses = this.planner.dependenciesOf(member.module, member.closure, member.symbolId, context);
			for (const dependency of uses) {
				const origin = dependency.origin;
				if (origin.kind === "workspaceModule" && origin.module === toModule) continue;
				// A member's use of another member travels with them.
				const settled: MoveDependency =
					origin.kind === "sourceModule" && inside.has(origin.symbolId)
						? { ...dependency, origin: { kind: "insideClosure", symbolId: origin.symbolId } }
						: promoteDependency(dependency, promote);
				const key = `${settled.name}\0${JSON.stringify(settled.origin)}`;
				if (!dependencies.has(key)) dependencies.set(key, settled);
			}
		}

		// Imports of each member that resolve to the source, a barrel's re-export included.
		const importSites = new Map<string, ArrangeImportSite[]>();
		for (const member of incoming) {
			const found = await this.imports.importSitesResolvingTo(
				member.symbolId,
				member.module,
				member.name,
				context,
			);
			for (const { module, site } of found) {
				importSites.set(module, [...(importSites.get(module) ?? []), { ...site, symbolId: member.symbolId }]);
			}
		}

		const usedAtSource: string[] = [];
		const referencing = new Map<string, string[]>();
		for (const member of incoming) {
			let used = false;
			for (const reference of context.referencesTo(member.symbolId)) {
				if (reference.module === member.module) {
					const at = { line: reference.startLine, character: reference.startCharacter };
					if (!incoming.some((each) => holds(each.range, at))) used = true;
					continue;
				}
				const users = referencing.get(reference.module) ?? [];
				if (!users.includes(member.symbolId)) referencing.set(reference.module, [...users, member.symbolId]);
			}
			for (const [module, sites] of importSites) {
				if (!sites.some((site) => site.symbolId === member.symbolId)) continue;
				const users = referencing.get(module) ?? [];
				if (!users.includes(member.symbolId)) referencing.set(module, [...users, member.symbolId]);
			}
			if (used) usedAtSource.push(member.symbolId);
			const outside =
				used ||
				[...referencing].some(([module, users]) => module !== toModule && users.includes(member.symbolId));
			member.exports = context.declaration(member.symbolId)?.exported === false && outside;
		}

		return {
			ok: true,
			toModule,
			fromModule: fromModule ?? toModule,
			members,
			comments,
			slots: slots.map((slot) => ({ landing: slot.landing, members: slot.members })),
			dependencies: [...dependencies.values()],
			promoted: promotedFrom([...dependencies.values()]),
			usedAtSource,
			referencing,
			importSites,
			bases,
		};
	}

	/** Each placement's slot, in document order. An anchor puts a declaration directly beside it. */
	private slotsFor(
		placements: readonly ArrangePlacement[],
		members: readonly ArrangedMember[],
		comments: readonly ArrangedComment[],
		toModule: string,
		context: ReadContext,
	): Slot[] | { refused: Refusal } {
		const siblings = context
			.moduleLevel(toModule)
			.declarations.filter((each) => !context.isLocal(each))
			.sort((left, right) => comparePositions(left.range.start, right.range.start));
		const placed = new Set([
			...members.map((member) => member.symbolId),
			...comments.map((comment) => comment.factId),
		]);
		const nameOf = (id: string) =>
			members.find((member) => member.symbolId === id)?.name ??
			comments.find((comment) => comment.factId === id)?.text ??
			id;
		const keyed = new Map<string, Slot>();
		const slotOf = new Map<string, Slot>();
		for (const placement of placements) {
			const id = placement.symbolId ?? (placement.factId as string);
			const anchor = placement.anchor;
			const anchorId = anchor?.symbolId ?? anchor?.factId;
			const chained = anchorId === undefined ? undefined : slotOf.get(anchorId);
			let slot: Slot;
			if (anchor === undefined) {
				slot = keyed.get("end") ?? { landing: "end", rank: 2, members: [] };
				keyed.set("end", slot);
				slot.members.push(id);
			} else if (chained !== undefined) {
				const at = chained.members.indexOf(anchorId as string);
				chained.members.splice(anchor.side === "before" ? at : at + 1, 0, id);
				slot = chained;
			} else {
				const label = context.declaration(anchorId as string)?.name ?? nameOf(anchorId as string);
				if (placed.has(anchorId as string)) return { refused: anchorNotPlaced(label, nameOf(id), toModule) };
				if (anchor.factId !== undefined) return { refused: anchorNotTopLevel(label, toModule) };
				const at = siblings.findIndex((sibling) => sibling.symbolId === anchorId);
				const sibling = siblings[at];
				if (sibling === undefined) return { refused: anchorNotTopLevel(label, toModule) };
				// A neighbor sharing the anchor's first or last line leaves no whole line between them.
				const before = anchor.side === "before";
				const neighbor = before ? siblings[at - 1] : siblings[at + 1];
				const shared = before
					? neighbor?.range.end.line === sibling.range.start.line
					: neighbor?.range.start.line === sibling.range.end.line;
				if (neighbor !== undefined && shared) return { refused: noInsertionPoint(neighbor.name) };
				const key = `${anchor.side}\0${anchorId}`;
				slot = keyed.get(key) ?? {
					landing: { line: before ? sibling.range.start.line : sibling.range.end.line + 1 },
					rank: before ? 1 : 0,
					members: [],
				};
				keyed.set(key, slot);
				if (before) slot.members.push(id);
				else slot.members.unshift(id);
			}
			slotOf.set(id, slot);
		}
		const line = (slot: Slot) => (slot.landing === "end" ? Number.POSITIVE_INFINITY : slot.landing.line);
		return [...keyed.values()].sort((left, right) => line(left) - line(right) || left.rank - right.rank);
	}

	/** Every file the arrangement writes, with the hash it was planned over, formatted when `fixText` is set. */
	async files(plan: Extract<PlannedArrange, { ok: true }>, context: ReadContext): Promise<ArrangedFiles> {
		const { toModule, fromModule } = plan;
		const others = [...plan.referencing.keys()].filter((module) => module !== toModule && module !== fromModule);
		const modules = [toModule, ...(fromModule === toModule ? [] : [fromModule]), ...others];

		const files: Array<{ module: string; base: string | null; text: string }> = [];
		const blocked: RefactorIssue[] = [];
		for (const module of modules) {
			const current = this.source.writable(module);
			if ("refused" in current) return { ok: false, issues: [], reason: current.refused };
			// Only the target may be absent, and is created.
			if (current.text === null && module !== toModule) {
				return { ok: false, issues: [], reason: moduleNotOnDisk(module) };
			}
			const text = current.text ?? "";
			const part = this.partOf(module, text, plan, context);
			const requestedPart = part;
			const answer = await this.probe.arrangeEdits(module, {
				module,
				text,
				exists: current.text !== null,
				fromModule,
				toModule,
				...requestedPart,
			});
			if (answer.status === "refused") {
				return {
					ok: false,
					issues: [],
					reason: providerRefused(module, answer.reason, answer.detail),
					...(answer.reason === "NotImplemented" ? { unsupported: true as const } : {}),
				};
			}
			if (requestedPart.exportInPlace?.length) {
				blocked.push(
					...unacknowledgedPromotions(
						requestedPart.exportInPlace,
						answer.exportedInPlace ?? [],
						plan.promoted,
						module,
					),
				);
			}
			for (const site of answer.blocked) {
				blocked.push({
					kind: site.reason,
					detail: `${module}: ${site.detail ?? "cannot be rewritten safely"}`,
					module,
				});
			}
			const applied = applyEdits(text, mergeRemovals(answer.edits));
			if ("problem" in applied) {
				return { ok: false, issues: [], reason: providerRefused(module, applied.problem) };
			}
			if (applied.text === text) continue;
			files.push({ module, base: current.text === null ? null : hashContent(current.text), text: applied.text });
		}
		if (blocked.length > 0) return { ok: false, issues: blocked, reason: occurrencesBlocked() };

		const issues = this.planner.importersUnfound([fromModule, ...others]);
		let formatted = true;
		// Each file formats on its own, so they run at once.
		const results = await Promise.all(files.map((file) => this.formatText(file.module, file.text)));
		for (const [index, file] of files.entries()) {
			const result = results[index] ?? null;
			if (result !== null && "text" in result) {
				file.text = result.text;
				continue;
			}
			formatted = false;
			if (result !== null) {
				issues.push({ kind: "FixFailed", detail: `the fixText command ${result.failed}`, module: file.module });
			}
		}

		const located = await this.located(plan, files);
		if ("refused" in located) return { ok: false, issues, reason: located.refused };
		return { ok: true, files, issues, formatted, placed: located.placed };
	}

	/** One module's part: its members, the imports naming them, and what it must reach. */
	private partOf(
		module: string,
		text: string,
		plan: Extract<PlannedArrange, { ok: true }>,
		context: ReadContext,
	): Pick<ArrangeEditsRequest, "members" | "importSites" | "dependencies" | "exportInPlace"> {
		const memberOf = (symbolId: string) =>
			plan.members.find((member) => member.symbolId === symbolId) as ArrangedMember;
		const users = plan.referencing.get(module) ?? [];
		const importSites = plan.importSites.get(module) ?? [];
		const sites = (symbolId: string) =>
			context
				.referencesTo(symbolId)
				.filter((reference) => reference.module === module && reference.qualified === true)
				.map(rangeOf);

		if (module === plan.toModule) {
			const own = plan.members.filter((member) => !member.incoming);
			const ownComments = plan.comments.filter((comment) => !comment.incoming);
			const byId = new Map<
				string,
				{ text: string; literals?: OffsetRange[]; comment?: ArrangedComment; member?: ArrangedMember }
			>();
			for (const member of plan.members)
				byId.set(member.symbolId, { text: member.text, literals: member.literals, member });
			for (const comment of plan.comments) byId.set(comment.factId, { text: comment.text, comment });
			const layout = layoutModule(
				text,
				new Map(own.map((member) => [member.symbolId, member.range] as const)),
				plan.slots.map((slot) => ({
					landing: slot.landing,
					members: slot.members.map((symbolId) => {
						const item = byId.get(symbolId) as { text: string; literals?: OffsetRange[] };
						return { symbolId, text: item.text, ...defined({ literals: item.literals }) };
					}),
				})),
			);
			const members = layout.order.map((symbolId): ArrangeMember => {
				const item = byId.get(symbolId) as {
					text: string;
					literals?: OffsetRange[];
					comment?: ArrangedComment;
					member?: ArrangedMember;
				};
				const member = item.member;
				const insertion = layout.insertions.get(symbolId) as { text: string; position: Position };
				const removal =
					item.comment !== undefined
						? ownComments.some((comment) => comment.factId === symbolId)
							? commentRemoval(text, item.comment.range)
							: undefined
						: layout.removals.get(symbolId);
				if (item.comment !== undefined)
					return {
						symbolId,
						name: item.comment.text,
						comment: true,
						...defined({ removal }),
						insertion,
						sites: [],
					};
				return {
					symbolId,
					name: (member as ArrangedMember).name,
					...defined({ removal }),
					insertion: { ...insertion, ...((member as ArrangedMember).exports ? { exported: true } : {}) },
					sites: (member as ArrangedMember).incoming ? sites(symbolId) : [],
				};
			});
			return { members, importSites, dependencies: plan.dependencies };
		}

		if (module === plan.fromModule) {
			const incoming = plan.members.filter((member) => member.incoming);
			const incomingComments = plan.comments.filter((comment) => comment.incoming);
			const layout = layoutModule(
				text,
				new Map(incoming.map((member) => [member.symbolId, member.range] as const)),
				[],
			);
			return {
				members: [
					...incoming.map(
						(member): ArrangeMember => ({
							symbolId: member.symbolId,
							name: member.name,
							...defined({ removal: layout.removals.get(member.symbolId) }),
							sites: [],
						}),
					),
					...incomingComments.map(
						(comment): ArrangeMember => ({
							symbolId: comment.factId,
							name: comment.text,
							comment: true,
							removal: commentRemoval(text, comment.range),
							sites: [],
						}),
					),
				],
				importSites,
				// What stays behind and still calls a member imports it from the target.
				dependencies: plan.usedAtSource.map(
					(symbolId): MoveDependency => ({
						name: memberOf(symbolId).name,
						origin: { kind: "workspaceModule", symbolId, module: plan.toModule },
					}),
				),
				...(plan.promoted.length > 0 ? { exportInPlace: plan.promoted.map((item) => item.symbolId) } : {}),
			};
		}

		return {
			members: users.map(
				(symbolId): ArrangeMember => ({ symbolId, name: memberOf(symbolId).name, sites: sites(symbolId) }),
			),
			importSites,
			dependencies: [],
		};
	}

	/**
	 * Top-level spans in the target's final text, a member under its pre-move id; refuses a member
	 * missing where it lands or left where it left.
	 */
	private async located(
		plan: Extract<PlannedArrange, { ok: true }>,
		files: ReadonlyArray<{ module: string; text: string }>,
	): Promise<
		{ placed: Array<{ symbolId: string; range: Range } | { factId: string; range: Range }> } | { refused: Refusal }
	> {
		const placed: Array<{ symbolId: string; range: Range } | { factId: string; range: Range }> = [];
		for (const module of plan.fromModule === plan.toModule ? [plan.toModule] : [plan.toModule, plan.fromModule]) {
			const file = files.find((each) => each.module === module);
			if (file === undefined) {
				// Unchanged: fine for a reorder that changes nothing, never with a member arriving.
				const stranded = plan.members.find((member) => member.incoming);
				if (stranded !== undefined) return { refused: arrangeMisplaced(stranded.name, module) };
				if (module === plan.toModule) {
					const context = new ReadContext(this.store);
					for (const symbolId of context.symbolIdsIn(module)) {
						const held = context.declaration(symbolId);
						if (held === null || context.isLocal(held) || context.ancestorsOf(held).length > 0) continue;
						placed.push({ symbolId, range: held.range });
					}
					for (const comment of plan.comments.filter((item) => item.module === module)) {
						placed.push({ factId: comment.factId, range: comment.range });
					}
				}
				continue;
			}
			const parsed = await this.probe.parseCandidate(module, file.text);
			if (!parsed.parsed) return { refused: candidateDoesNotParse("candidate", parsed.reason) };
			const declared = new Map(
				parsed.facts.declarations.map((declaration) => [declaration.symbolId, declaration.range] as const),
			);
			const landing = module === plan.toModule;
			for (const member of plan.members) {
				if (landing ? !declared.has(member.landsAs) : member.incoming && declared.has(member.symbolId)) {
					return { refused: arrangeMisplaced(member.name, module) };
				}
			}
			if (!landing) continue;
			// Grouped as the index groups them, so a multi-line comment is one run here too.
			const landed = attachComments(
				parsed.facts.declarations,
				parsed.facts.comments ?? [],
				file.text,
				parsed.facts.blankLines,
			);
			const used = new Set<number>();
			for (const comment of plan.comments) {
				const wanted = comment.text.replace(/\r\n/g, "\n");
				const at = landed.findIndex(
					(each, index) => !used.has(index) && each.raw.replace(/\r\n/g, "\n") === wanted,
				);
				const match = landed[at];
				if (match === undefined) return { refused: arrangeMisplaced(comment.text, module) };
				used.add(at);
				placed.push({ factId: comment.factId, range: match.range });
			}
			const asMember = new Map(plan.members.map((member) => [member.landsAs, member.symbolId] as const));
			for (const declaration of parsed.facts.declarations) {
				if (declaration.containerId !== undefined) continue;
				placed.push({
					symbolId: asMember.get(declaration.symbolId) ?? declaration.symbolId,
					range: declaration.range,
				});
			}
		}
		return { placed };
	}

	/** Members not declared in the target after the step, read from the reindexed facts. */
	notLanded(plan: Extract<PlannedArrange, { ok: true }>): RefactorIssue[] {
		const context = new ReadContext(this.store);
		return plan.members
			.filter((member) => context.declaration(member.landsAs)?.module !== plan.toModule)
			.map((member) => ({
				kind: "UnresolvedAfterMove",
				detail: `${member.name} is not declared in ${plan.toModule} after the arrangement`,
				module: plan.toModule,
			}));
	}
}
