// The daemon's method table.
//
// One place mapping a wire method to a service call, so the daemon stays transport-only and the
// service stays unaware that anything is remote.

import {
	type CommittedFile,
	type CommittedStep,
	DAEMON_METHODS,
	type DaemonMethod,
	defined,
	type InsertOutcome,
	isDaemonMethod,
	type MoveOutcome,
	type RefactorIssue,
	type RenameStepOutcome,
	type ReplaceSpanOutcome,
	type RequestOf,
	type ResponseOf,
	type ReverseStep,
	reverseOf,
} from "@nyaa-lexicon/protocol";
import type { ReadContext } from "./readContext.js";
import type { MoveEditsOutcome } from "./refactorPlanner.js";
import { journaledStep, type RefusedWith, type StepPolicy, StepRefusal } from "./refactorStep.js";
import type { PlannedMove } from "./refusalSlots.js";
import { changedWhilePlanned, factsMovedWhilePlanned, type Refusal, staleSincePlanned } from "./refusals.js";
import type { LexiconService } from "./service.js";
import type { TransactionManager } from "./transactions.js";
import { BUILD_VERSION } from "./version.js";
import type { WorkspaceGate } from "./workspaceGate.js";

export type { InsertOutcome, MoveOutcome, RenameStepOutcome, ReplaceOutcome } from "@nyaa-lexicon/protocol";

////////////////////////////////
//  Interfaces & Types

/** Absent for a daemon built without refactor support; the gate is the service's either way. */
export interface RefactorDeps {
	transactions: TransactionManager;
}

/** The workspace gate as a handler sees it, in the two halves a handler may take. */
export interface Gate {
	read<T>(work: () => Promise<T> | T): Promise<T>;
	write<T>(work: () => Promise<T> | T): Promise<T>;
}

type Effect = "read" | "write" | "staged";

/** A rename or move's result, before its wire shape is chosen. */
export type StepResult =
	| {
			done: true;
			/** The root's id now. */
			root: string;
			forwarded: Array<{ from: string; to: string }>;
			modules: string[];
			/** A move's canonical target. */
			toModule?: string;
			files: CommittedFile[];
			reverse: ReverseStep;
			migrated?: { answers: number; gaps: number };
			issues: RefactorIssue[];
	  }
	| ({ done: false; reason: Refusal; issues: RefactorIssue[] } & RefusedWith);

type Run<M extends DaemonMethod> = (params: RequestOf<M>, gate: Gate) => Promise<ResponseOf<M>> | ResponseOf<M>;

declare const handlerBrand: unique symbol;

/** A handler names its effect, and only `read`, `write` and `staged` mint one: a bare function
 * cannot sit in the table, so no method runs without saying whether it writes. */
interface Handler<M extends DaemonMethod> {
	readonly effect: Effect;
	readonly run: Run<M>;
	readonly [handlerBrand]: true;
}

function mint<M extends DaemonMethod>(effect: Effect, run: Run<M>): Handler<M> {
	return { effect, run } as Handler<M>;
}

/** Runs under the shared gate: alongside other readers, never inside a write. */
const read = <M extends DaemonMethod>(run: Run<M>): Handler<M> => mint("read", run);

/** Runs alone under the exclusive gate. */
const write = <M extends DaemonMethod>(run: Run<M>): Handler<M> => mint("write", run);

/** Takes the gate itself, in parts, through the one it is handed: for work that plans outside and writes inside. */
const staged = <M extends DaemonMethod>(run: Run<M>): Handler<M> => mint("staged", run);

/** The service's gate in the two halves a handler takes, so no caller can supply a second one. */
export function gateOf(gate: WorkspaceGate): Gate {
	return {
		read: <T>(work: () => Promise<T> | T): Promise<T> => gate.shared(async () => work()),
		write: <T>(work: () => Promise<T> | T): Promise<T> => gate.exclusive(async () => work()),
	};
}

////////////////////////////////
//  Steps

/**
 * A move as one transaction step.
 *
 * Every module gets one provider request describing only its own part, and a blocked site anywhere
 * stops the whole thing: a move that relocates a declaration and leaves half its importers pointing
 * at the old module is worse than one that did not start.
 */
function refactorMove(
	service: LexiconService,
	transactions: TransactionManager,
	write: <T>(work: () => Promise<T> | T) => Promise<T>,
	args: { symbolId: string; toModule: string },
	hold: StepPolicy,
): Promise<StepResult> {
	let requested = args.symbolId;
	let touched: string[] = [];
	let source = "";
	let target = args.toModule;
	let migrated: { answers: number; gaps: number } | undefined;
	const idMap = new Map<string, string>();

	return journaledStep<StepResult>(
		{ service, transactions, write },
		{
			kind: "move",
			hold,
			refuse: (reason, issues, why) => ({ done: false, reason, issues, ...why }),
			succeed: (issues, _hold, files) => {
				const root = idMap.get(requested) ?? requested;
				return {
					done: true,
					root,
					forwarded: [...idMap].map(([from, to]) => ({ from, to })),
					modules: touched,
					toModule: target,
					files,
					reverse: reverseOf("move", requested, root) ?? { kind: "move", symbolId: root, toModule: source },
					...defined({ migrated }),
					issues,
				};
			},
			plan: async () => {
				// Held past the call, so the stale check below asks what it stamped.
				const context = service.newReadContext();
				const plan = service.planMove(args.symbolId, args.toModule, context);
				if (!plan.ok) return { refused: plan.reason };
				requested = plan.symbolId;
				source = plan.fromModule;
				target = plan.toModule;
				const edits = await service.moveEdits(plan, context);
				if (!edits.ok) return { refused: edits.reason, issues: edits.issues };
				touched = edits.files.map((file) => file.module);

				return {
					planned: {
						modules: touched,
						writes: touched,
						planRecord: { from: plan.fromModule, to: plan.toModule },
						plannedText: edits.files.map((file) => ({ module: file.module, text: file.text })),
						stale: () => moveStale(service, plan, edits, context),
						begin: () => {
							for (const id of plan.closure) {
								const rebased = service.rebaseIntoModule(id, plan.symbolId, plan.toModule);
								if (rebased !== null) idMap.set(id, rebased);
							}
						},
						rebind: () => ({
							entries: [...idMap].map(([from, to]) => ({ from, to })),
							evidence: "journalMove",
						}),
						apply: () => {
							for (const file of edits.files) service.writeModule(file.module, file.text);
						},
						// Target first, so every other module rebinds against a declaration that
						// already exists in its new home rather than one that has just vanished.
						reindex: [plan.toModule, ...touched.filter((m) => m !== plan.toModule)],
						issues: edits.issues,
						finish: (issues, rebound) => {
							if (rebound !== undefined) migrated = { answers: rebound.answers, gaps: rebound.gaps };
							// Asked of the reindexed facts, since a specifier can be well formed and
							// still point nowhere.
							issues.push(...service.checkMoveLanded(plan.name, touched));
						},
					},
				};
			},
		},
	);
}

/**
 * A rename as one transaction step, journaled like any other.
 *
 * The edits and the ids they re-mint are worked out outside the gate before anything moves,
 * because afterwards the old ids no longer resolve and there is nothing left to map from.
 */
function refactorRename(
	service: LexiconService,
	transactions: TransactionManager,
	write: <T>(work: () => Promise<T> | T) => Promise<T>,
	args: { symbolId: string; newName: string },
	hold: StepPolicy,
): Promise<StepResult> {
	let modules: string[] = [];
	let oldName = "";
	let migrated: { answers: number; gaps: number } | undefined;
	let idMap = new Map<string, string>();

	return journaledStep<StepResult>(
		{ service, transactions, write },
		{
			kind: "rename",
			hold,
			refuse: (reason, issues, why) => ({ done: false, reason, issues, ...why }),
			succeed: (issues, _hold, files) => {
				const root = idMap.get(args.symbolId) ?? args.symbolId;
				return {
					done: true,
					root,
					forwarded: [...idMap].map(([from, to]) => ({ from, to })),
					modules,
					files,
					// A local's id carries no name.
					reverse: reverseOf("rename", args.symbolId, root) ?? {
						kind: "rename",
						symbolId: root,
						newName: oldName,
					},
					...defined({ migrated }),
					issues,
				};
			},
			plan: async () => {
				// One context, so the plan and the two follow-up reads below stamp and share one set.
				const context = service.newReadContext();
				const edits = await service.renameEdits(args.symbolId, args.newName, context);
				if (!edits.ok) {
					return {
						refused: edits.reason,
						issues: edits.plan.blockers.map((blocker) => ({ kind: blocker.kind, detail: blocker.detail })),
					};
				}
				const plan = edits.plan;
				oldName = plan.oldName;
				const planned = service.renameTexts(edits.files);
				if ("reason" in planned) return { refused: planned.reason };

				idMap = service.renameIdMap(args.symbolId, args.newName, context);
				const edited = plan.files.map((file) => file.module);
				// Worked out before the write, since afterwards these ids resolve to nothing and the
				// modules holding stale bindings would be unfindable.
				const alsoBound = service
					.modulesBoundTo(idMap.keys(), context)
					.filter((module) => !edited.includes(module));

				return {
					planned: {
						modules: [...edited, ...alsoBound],
						writes: edits.files.map((file) => file.module),
						planRecord: plan,
						plannedText: planned.texts,
						stale: () => {
							// Every site was chosen from stored ranges; a changed module has moved
							// them, so rewriting would hit some occurrences and miss others.
							const stale = service.staleModules(edited);
							if (stale.length > 0) return staleSincePlanned(stale, "rename");
							// The edits address the text they were planned on.
							const changed = edits.files.find(
								(file) => service.currentHashOf(file.module) !== file.contentHash,
							);
							if (changed !== undefined) return changedWhilePlanned(changed.module, "rename");
							// Rows re-committed under an equal hash: a re-parse or an upgrade.
							const moved = service.factsMoved(context.seen());
							return moved.length > 0 ? factsMovedWhilePlanned(moved, "rename") : null;
						},
						rebind: () => ({
							entries: [...idMap].map(([from, to]) => ({ from, to })),
							evidence: "journalRename",
						}),
						// The written files are reindexed by the write; only the stale-binding modules
						// remain for the executor.
						apply: async () => {
							const written = await service.writeRenameEdits(edits.files);
							if ("reason" in written) throw new StepRefusal(written.reason);
							modules = [...written.modules, ...alsoBound];
						},
						reindex: alsoBound,
						issues: plan.warnings.map((warning) => ({ kind: warning.kind, detail: warning.detail })),
						finish: (_issues, rebound) => {
							if (rebound !== undefined) migrated = { answers: rebound.answers, gaps: rebound.gaps };
						},
					},
				};
			},
		},
	);
}

/**
 * Plan first, outside the gate, then write inside it.
 *
 * Planning parses a candidate and asks the index what would break, which is the slow half and
 * needs no exclusivity. The gate is held only across journal, write and reindex, and the file's
 * hash and the stamps of the rows the plan read are rechecked once held: anything that changed
 * either in between invalidates the plan that was just made, and applying anyway would overwrite
 * whatever changed it, or land over facts the plan never saw.
 */
function refactorReplace(
	service: LexiconService,
	transactions: TransactionManager,
	write: <T>(work: () => Promise<T> | T) => Promise<T>,
	args: { symbolId?: string | undefined; factId?: string | undefined; newText: string },
	span?: { expectedSpanHash: string; hold: StepPolicy },
): Promise<ReplaceSpanOutcome> {
	let module = "";
	let stale = false;

	return journaledStep<ReplaceSpanOutcome>(
		{ service, transactions, write },
		{
			kind: "replace",
			hold: span?.hold ?? "join",
			refuse: (reason, issues) => ({ replaced: false, issues, reason, ...(stale ? { stale } : {}) }),
			succeed: (issues, transaction) => ({
				replaced: true,
				module,
				issues,
				...(span === undefined ? {} : { transaction }),
			}),
			plan: async () => {
				const plan = await service.planReplacement(args, args.newText, span?.expectedSpanHash);
				if (!plan.ok) {
					stale = plan.stale === true;
					return { refused: plan.reason };
				}
				module = plan.module;

				return {
					planned: {
						modules: [plan.module],
						writes: [plan.module],
						planRecord: { range: plan.range },
						plannedText: [{ module: plan.module, text: plan.text }],
						// The plan was spliced from, and its span checked on, one exact version of the file.
						stale: () => {
							if (service.currentHashOf(plan.module) !== plan.baseHash) {
								return changedWhilePlanned(plan.module, "replacement");
							}
							// Rows re-committed under an equal hash: a re-parse or an upgrade.
							const moved = service.factsMoved(plan.facts);
							return moved.length > 0 ? factsMovedWhilePlanned(moved, "replacement") : null;
						},
						apply: () => service.writeModule(plan.module, plan.text),
						reindex: [plan.module],
						issues: plan.issues,
					},
				};
			},
		},
	);
}

/** Insert as one transaction step: the replace pipeline with a computed splice point. */
function refactorInsert(
	service: LexiconService,
	transactions: TransactionManager,
	write: <T>(work: () => Promise<T> | T) => Promise<T>,
	args: { after?: string | undefined; module?: string | undefined; text: string },
): Promise<InsertOutcome> {
	let module = "";
	let symbolIds: string[] = [];
	let held = new Set<string>();

	return journaledStep<InsertOutcome>(
		{ service, transactions, write },
		{
			kind: "insert",
			hold: "join",
			refuse: (reason, issues) => ({ inserted: false, issues, reason }),
			succeed: (issues) => ({ inserted: true, module, symbolIds, issues }),
			plan: async () => {
				const plan = await service.planInsert(args);
				if (plan.state === "refused") return { refused: plan.reason };
				if (plan.state === "present") {
					// The retry answer: success-shaped, so a timeout-and-retry cannot duplicate.
					return {
						done: {
							inserted: false,
							alreadyInserted: true,
							module: plan.module,
							symbolIds: [],
							issues: [],
						},
					};
				}
				module = plan.module;

				return {
					planned: {
						modules: [plan.module],
						writes: [plan.module],
						planRecord: { created: plan.created },
						plannedText: [{ module: plan.module, text: plan.candidate }],
						// A created module must STILL be absent: another writer landing one between
						// planning and the gate would be clobbered by a candidate built from empty.
						stale: () => {
							const fresh = plan.created
								? service.currentHashOf(plan.module) === null
								: service.currentHashOf(plan.module) === plan.baseHash;
							if (!fresh) return changedWhilePlanned(plan.module, "insert");
							// The sibling set and the collision check were read from these rows.
							const moved = service.factsMoved(plan.facts);
							return moved.length > 0 ? factsMovedWhilePlanned(moved, "insert") : null;
						},
						begin: () => {
							held = new Set(service.declarationsIn(plan.module).map((d) => d.symbolId));
						},
						apply: () => service.writeModule(plan.module, plan.candidate),
						reindex: [plan.module],
						issues: plan.issues,
						finish: () => {
							symbolIds = service
								.declarationsIn(plan.module)
								.map((declaration) => declaration.symbolId)
								.filter((symbolId) => !held.has(symbolId));
						},
					},
				};
			},
		},
	);
}

function renameStepOutcome(result: StepResult): RenameStepOutcome {
	if (!result.done) return { renamed: false, issues: result.issues, reason: result.reason };
	return { renamed: true, modules: result.modules, ...defined({ migrated: result.migrated }), issues: result.issues };
}

function moveOutcome(result: StepResult): MoveOutcome {
	if (!result.done) return { moved: false, issues: result.issues, reason: result.reason };
	return {
		moved: true,
		...defined({ toModule: result.toModule, migrated: result.migrated }),
		modules: result.modules,
		issues: result.issues,
	};
}

/** A committed step's answer, with the step that reverses it. */
function committedOutcome(kind: "rename" | "move"): (result: StepResult) => CommittedStep {
	return (result) => {
		if (!result.done) {
			return {
				committed: false,
				reason: result.reason,
				issues: result.issues,
				...defined({ openRefactor: result.openRefactor, unexpected: result.unexpected }),
			};
		}
		return {
			committed: true,
			kind,
			symbolId: result.root,
			files: result.files,
			forwarded: result.forwarded,
			reverse: result.reverse,
			...defined({ migrated: result.migrated }),
			issues: result.issues,
		};
	};
}

function moveStale(
	service: LexiconService,
	plan: Extract<PlannedMove, { ok: true }>,
	edits: Extract<MoveEditsOutcome, { ok: true }>,
	context: ReadContext,
): Refusal | null {
	if (service.currentHashOf(plan.fromModule) !== plan.baseHash) {
		return changedWhilePlanned(plan.fromModule, "move");
	}
	// Target changes would be overwritten.
	const moved = edits.bases.find((base) => service.currentHashOf(base.module) !== base.hash);
	if (moved !== undefined) return changedWhilePlanned(moved.module, "move");
	// Import edits use stored ranges.
	const stale = service.staleModules(plan.referencing);
	if (stale.length > 0) return staleSincePlanned(stale, "move");
	// Equal hashes can hide reparses or upgrades.
	const movedFacts = service.factsMoved(context.seen());
	return movedFacts.length > 0 ? factsMovedWhilePlanned(movedFacts, "move") : null;
}

async function previewMove(
	service: LexiconService,
	args: { symbolId: string; toModule: string },
): Promise<ResponseOf<"previewMove">> {
	const refused = (reason: Refusal): ResponseOf<"previewMove"> => ({
		ok: false,
		files: [],
		issues: [],
		blockers: [{ reason }],
		reason,
	});

	const context = service.newReadContext();
	const plan = service.planMove(args.symbolId, args.toModule, context);
	if (!plan.ok) return refused(plan.reason);
	// Check stale sites before provider requests.
	const stale = service.staleModules([plan.fromModule, ...plan.referencing]);
	if (stale.length > 0) return refused(staleSincePlanned(stale, "move"));

	const result = await service.moveEdits(plan, context);
	if (!result.ok) {
		const blockers =
			result.issues.length > 0
				? result.issues.map((issue) => ({ module: issue.module, reason: issue.detail }))
				: [{ reason: result.reason }];
		return {
			ok: false,
			files: [],
			issues: result.issues,
			blockers,
			reason: result.reason,
		};
	}
	const moved = moveStale(service, plan, result, context);
	if (moved !== null) return refused(moved);

	return {
		ok: true,
		files: result.files.map((file) => {
			const base = result.bases.find((candidate) => candidate.module === file.module);
			if (base === undefined) throw new Error(`move preview has no base for ${file.module}`);
			return {
				module: file.module,
				contentHash: base.hash,
				created: base.hash === null,
				text: file.text,
				edits: file.edits,
			};
		}),
		issues: result.issues,
		blockers: [],
	};
}

async function previewInsert(
	service: LexiconService,
	args: { after?: string | undefined; module?: string | undefined; text: string },
): Promise<ResponseOf<"previewInsert">> {
	const plan = await service.planInsert(args);
	if (plan.state === "refused") return { state: "refused", reason: plan.reason, issues: [] };
	if (plan.state === "present") return { state: "present", module: plan.module, issues: [] };
	return {
		state: "planned",
		module: plan.module,
		contentHash: plan.baseHash,
		created: plan.created,
		text: plan.candidate,
		edits: plan.edits,
		issues: plan.issues,
	};
}

////////////////////////////////
//  Functions & Helpers

/**
 * One handler per wire method, each taking params the table has already parsed.
 *
 * Building the map calls nothing on the service, so its key set can be checked against the table
 * over a stub.
 */
export function daemonHandlers(service: LexiconService, refactor?: RefactorDeps) {
	function transactions(): TransactionManager {
		if (!refactor) throw new Error("this daemon was built without refactor support");
		return refactor.transactions;
	}

	/**
	 * Tier 1: a symbol answer full-parses its tree ahead of the background upgrade, then answers.
	 *
	 * The one spelling of the shortcut. A handler that wires the tree by hand instead of through
	 * here is the drift the tier test fails on. The upgrade takes the gate per file itself, as the
	 * background pass does, so taking it here too would deadlock against its first file.
	 */
	const treeFirst = <M extends DaemonMethod>(
		symbolOf: (params: RequestOf<M>) => string,
		answer: (params: RequestOf<M>) => Promise<ResponseOf<M>> | ResponseOf<M>,
	): Handler<M> =>
		staged(async (params, gate) => {
			await service.ensureTreeFor(symbolOf(params));
			return gate.read(() => answer(params));
		});

	/** Complete reference facts first: the upgrade holds the gate per file as the background pass
	 * does, so nothing is taken around it here; only the answer takes the gate. */
	const upgradedRead = <M extends DaemonMethod>(
		answer: (params: RequestOf<M>) => Promise<ResponseOf<M>> | ResponseOf<M>,
	): Handler<M> =>
		staged(async (params, gate) => {
			await service.upgradeRemaining();
			return gate.read(() => answer(params));
		});

	return {
		findByName: read((params) => service.findByName(params.name, params.module)),
		describe: treeFirst(
			(params) => params.symbolId,
			(params) => service.describe(params.symbolId),
		),
		// The four below exist for the editor, which asks by position rather than by name and so
		// needs the declarations of a file and the raw hierarchy rows the MCP tools render instead.
		declarationOf: read((params) => service.declarationOf(params.symbolId)),
		declarationsIn: read((params) => service.declarationsIn(params.module)),
		typeHierarchy: treeFirst(
			(params) => params.symbolId,
			(params) => service.typeHierarchy(params.symbolId),
		),
		callHierarchy: treeFirst(
			(params) => params.symbolId,
			(params) => service.callHierarchy(params.symbolId),
		),
		findReferences: treeFirst(
			(params) => params.symbolId,
			(params) => service.findReferences(params.symbolId, params.limit, params.within),
		),
		usesFrom: treeFirst(
			(params) => params.symbolId,
			(params) => service.usesFrom(params.symbolId, params.limit),
		),
		resolveImport: read((params) => service.resolveImport(params.fromModule, params.specifier)),
		indexStatus: read((params) => service.indexStatus(params.concerning)),
		// Trigger lifecycle starts warming before this status answer.
		indexWorkspace: read(() => service.indexStatus()),
		findLiterals: read(({ limit, exclude, ...query }) => service.findLiterals(query, limit, exclude)),
		findComments: read(({ limit, exclude, ...query }) => service.findComments(query, limit, exclude)),
		findDocs: read(({ limit, exclude, ...query }) => service.findDocs(query, limit, exclude)),
		sharedLiterals: read((params) => service.sharedLiterals(params.minimumFiles, params.limit, params.exclude)),
		cycles: read((params) => service.cycles(params.limit)),
		mostReferenced: read((params) => service.mostReferenced(params.limit)),
		hubs: read((params) => service.mostReferenced(params.limit)),
		cacheStats: read(() => service.cacheStats()),
		searchSymbols: read((params) => service.searchSymbols(params.text, params)),
		outlineModule: read((params) => service.outline(params.module)),
		fileNotes: read((params) => service.fileNotes(params.module)),
		moduleStatus: read((params) => service.moduleStatus(params.module)),
		admittedModules: read((params) => service.admittedModules(params.modules)),
		moduleDeclarations: read((params) => service.moduleDeclarations(params.module)),
		moduleFacts: read((params) => service.moduleFacts(params.module)),
		// Candidate parses read under the gate: an index parse landing between a candidate and its
		// restore would bind against the unsaved text and store it.
		parseFacts: read((params) => service.parseFacts(params.module, params.text)),
		symbolAt: read((params) => service.symbolAt(params)),
		findImports: read((params) => service.findImports(params)),
		overview: read(() => service.overview()),
		coChangedWith: read((params) => service.coChangedWith(params.module, params.limit)),
		fileHistory: read((params) => service.fileHistory(params.module)),
		commitsMentioning: read((params) => service.commitsMentioning(params.name, params.limit)),
		// Tier 1 too: its answer carries the declaring module's references and literals, which
		// outline facts genuinely lack.
		factsFor: treeFirst(
			(params) => params.symbolId,
			(params) => service.factsFor(params.symbolId, params.limit),
		),
		resolveFacts: read((params) => service.resolveFacts(params.factIds)),
		recordAnswer: write((params) =>
			service.recordAnswer(params.symbolId, params.question, params.prose, params.citations, {
				...defined({ model: params.model, resolvesDoubt: params.resolvesDoubt, omitting: params.omitting }),
			}),
		),
		invalidateAnswer: write((params) =>
			service.invalidateAnswer(params.symbolId, params.reason, params.question, params.by),
		),
		reaffirmAnswer: write((params) =>
			service.reaffirmAnswer(params.symbolId, params.question, {
				...defined({ citations: params.citations, model: params.model, resolvesDoubt: params.resolvesDoubt }),
			}),
		),
		// The survey counts nothing. One question's recall is a read, and the demand it found is
		// counted afterwards as its own write, so the count never rides inside a shared hold.
		recallAnswer: staged(async (params, gate) => {
			const { symbolId, question } = params;
			if (question === undefined) return gate.read(() => service.recallAnswers(symbolId));
			const recalled = await gate.read(() => service.recallAnswer(symbolId, question));
			const demand = service.demandOf(symbolId, question, recalled);
			if (demand !== null) await gate.write(() => service.recordDemand(demand));
			return recalled;
		}),
		knowledgeGaps: read((params) =>
			service.knowledgeGaps(params.root, params.question, params.limit, params.module),
		),
		knowledgeScope: read((params) => service.knowledgeScope(params)),
		diagnoseSubject: read((params) => service.diagnoseSubject(params.symbolId)),
		typeOf: treeFirst(
			(params) => params.symbolId,
			(params) => service.typeOf(params.symbolId),
		),
		// Read-only, and kept because the editor asks it to decide whether to offer a rename.
		prepareRename: upgradedRead((params) =>
			service.prepareRename(params.symbolId, params.newName, service.newReadContext()),
		),
		// The edits a rename would make, for a caller that applies them itself.
		renameEdits: upgradedRead((params) => service.renameEdits(params.symbolId, params.newName)),
		planMove: upgradedRead((params) =>
			service.planMove(params.symbolId, params.toModule, service.newReadContext()),
		),
		// Upgrade outlines before preview reads.
		previewMove: upgradedRead((params) => previewMove(service, params)),
		previewInsert: upgradedRead((params) => previewInsert(service, params)),
		indexFile: write((params) => service.indexFile(params.module)),
		symbolSource: read((params) => service.symbolSource(params)),
		refactorStart: write(() => transactions().start()),
		refactorStatus: read(() => transactions().status()),
		refactorTrack: write((params) => transactions().track(params.module)),
		refactorNoteWrite: write((params) =>
			transactions().noteWrite(
				params.module,
				"absent" in params ? { absent: true } : { contentHash: params.contentHash },
			),
		),
		refactorBeforeImage: read((params) => transactions().beforeImage(params.module, params.id)),
		// Restoring puts back text the index does not describe, so the facts for those files are
		// of a version that no longer exists on disk.
		refactorUndo: write(async (params) => {
			const outcome = transactions().undo(params.expect);
			for (const module of outcome.modules ?? []) await service.indexFile(module);
			return outcome;
		}),
		refactorRevert: write(async (params) => {
			const outcome = transactions().revert(params.drifted, params.expect);
			for (const module of outcome.modules) await service.indexFile(module);
			return outcome;
		}),
		refactorCommit: write((params) => transactions().commit(params)),
		refactorReplace: staged((params, gate) => refactorReplace(service, transactions(), gate.write, params)),
		refactorReplaceSpan: staged((params, gate) =>
			refactorReplace(service, transactions(), gate.write, params, {
				expectedSpanHash: params.expectedSpanHash,
				hold: params.standalone === true ? "joinOrOwn" : "join",
			}),
		),
		refactorInsert: staged((params, gate) => refactorInsert(service, transactions(), gate.write, params)),
		refactorRename: staged((params, gate) =>
			refactorRename(service, transactions(), gate.write, params, "join").then(renameStepOutcome),
		),
		refactorMove: staged((params, gate) =>
			refactorMove(service, transactions(), gate.write, params, "join").then(moveOutcome),
		),
		refactorRenameCommitted: staged((params, gate) =>
			refactorRename(service, transactions(), gate.write, params, { own: params.bases }).then(
				committedOutcome("rename"),
			),
		),
		refactorMoveCommitted: staged((params, gate) =>
			refactorMove(service, transactions(), gate.write, params, { own: params.bases }).then(
				committedOutcome("move"),
			),
		),
	} satisfies { [M in DaemonMethod]: Handler<M> };
}

/** Includes this build to diagnose client and daemon table mismatches. */
export function unknownMethod(method: string): Error {
	return new Error(`unknown method: ${method} (this daemon runs ${BUILD_VERSION})`);
}

/**
 * Dispatch one call: parse the request through the table, run its handler, parse the answer.
 *
 * An unknown method throws rather than answering null, so a client built against a newer daemon
 * learns the method is missing instead of reading an empty answer as a real one.
 */
export function createDispatch(service: LexiconService, refactor?: RefactorDeps) {
	const handlers = daemonHandlers(service, refactor);
	const gate = gateOf(service.gate);
	return async (method: string, params: unknown): Promise<unknown> => {
		if (!isDaemonMethod(method)) throw unknownMethod(method);
		let args: unknown;
		try {
			args = DAEMON_METHODS[method].request.parse(params ?? {});
		} catch (error) {
			// Lexicon's own words, never a zod blob: the field, then what the schema said about it.
			const issues =
				(error as { issues?: Array<{ path: Array<string | number>; message: string }> }).issues ?? [];
			const worded = issues.map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`);
			throw new Error(`${method} refused: ${worded.length === 0 ? String(error) : worded.join("; ")}`);
		}
		// Looked up by a runtime key, the handler's parameter is the intersection of every request.
		const handler: { effect: Effect; run: (params: never, gate: Gate) => unknown } = handlers[method];
		const run = () => handler.run(args as never, gate);
		const answer =
			handler.effect === "read"
				? await gate.read(run)
				: handler.effect === "write"
					? await gate.write(run)
					: await run();
		return DAEMON_METHODS[method].response.parse(answer);
	};
}
