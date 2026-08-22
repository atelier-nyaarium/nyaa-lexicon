// The daemon's method table.
//
// One place mapping a wire method to a service call, so the daemon stays transport-only and the
// service stays unaware that anything is remote.

import { z } from "zod";
import { QUESTION_CLASSES, type QuestionClass } from "./answers.js";
import { journaledStep, StepRefusal } from "./refactorStep.js";
import type { LexiconService } from "./service.js";
import type { RefactorIssue, TransactionManager } from "./transactions.js";
import { BUILD_VERSION } from "./version.js";
import type { WorkspaceGate } from "./workspaceGate.js";

////////////////////////////////
//  Interfaces & Types

/**
 * Absent for a caller with no workspace to protect, such as a test driving the service directly.
 *
 * Present, every mutation runs alone and every read runs without seeing a half-written step.
 */
export interface RefactorDeps {
	gate: WorkspaceGate;
	transactions: TransactionManager;
}

////////////////////////////////
//  Schemas

const FindByName = z.object({ name: z.string().min(1), module: z.string().min(1).optional() });
const BySymbol = z.object({ symbolId: z.string().min(1) });
const References = z.object({ symbolId: z.string().min(1), limit: z.number().int().positive().optional() });
const Resolve = z.object({ fromModule: z.string().min(1), specifier: z.string().min(1) });
const IndexFile = z.object({ module: z.string().min(1) });
const Rename = z.object({ symbolId: z.string().min(1), newName: z.string().min(1) });
const Literals = z.object({
	value: z.string().optional(),
	regex: z.string().min(1).optional(),
	kind: z.string().optional(),
	min: z.number().optional(),
	max: z.number().optional(),
	limit: z.number().int().positive().optional(),
});
const Comments = z.object({
	text: z.string().min(1).optional(),
	regex: z.string().min(1).optional(),
	form: z.enum(["leading", "trailing", "inline", "standalone"]).optional(),
	module: z.string().min(1).optional(),
	limit: z.number().int().positive().max(200).optional(),
});
const Docs = z.object({
	text: z.string().min(1).optional(),
	regex: z.string().min(1).optional(),
	fenced: z.boolean().optional(),
	module: z.string().min(1).optional(),
	limit: z.number().int().positive().max(200).optional(),
});
const Shared = z.object({
	minimumFiles: z.number().int().positive().optional(),
	limit: z.number().int().positive().optional(),
});
const Paged = z.object({ limit: z.number().int().positive().optional() });
const CoChange = z.object({ module: z.string().min(1), limit: z.number().int().positive().optional() });
const Search = z
	.object({
		text: z.string().min(1).optional(),
		regex: z.string().min(1).optional(),
		kind: z.string().min(1).optional(),
		module: z.string().min(1).optional(),
		limit: z.number().int().positive().optional(),
	})
	.refine((args) => (args.text === undefined) !== (args.regex === undefined), `Set exactly one of text or regex.`);
const ByModule = z.object({ module: z.string().min(1) });
const ResolveFacts = z.object({ factIds: z.array(z.string().min(1)).min(1) });
const Mentions = z.object({ name: z.string().min(1), limit: z.number().int().positive().optional() });
const Question = z.enum(QUESTION_CLASSES as unknown as [string, ...string[]]).transform((v) => v as QuestionClass);
const RecordAnswer = z.object({
	symbolId: z.string().min(1),
	question: Question,
	prose: z.string().min(1),
	citations: z.array(z.string().min(1)),
	model: z.string().min(1).optional(),
	resolvesDoubt: z.string().min(1).optional(),
	omitting: z.string().min(1).optional(),
});
const RecallAnswer = z.object({ symbolId: z.string().min(1), question: Question.optional() });
const InvalidateAnswer = z.object({
	symbolId: z.string().min(1),
	reason: z.string().min(1),
	question: Question.optional(),
	by: z.string().min(1).optional(),
});
const ReaffirmAnswer = z.object({
	symbolId: z.string().min(1),
	question: Question,
	citations: z.array(z.string().min(1)).optional(),
	model: z.string().min(1).optional(),
	resolvesDoubt: z.string().min(1).optional(),
});
const Gaps = z.object({
	root: z.string().min(1).optional(),
	question: Question.optional(),
	limit: z.number().int().positive().optional(),
	module: z.string().min(1).optional(),
});
const Status = z.object({
	concerning: z.string().min(1).optional(),
});
const FindImports = z.object({
	specifier: z.string().min(1).optional(),
	specifierRegex: z.string().min(1).optional(),
	module: z.string().min(1).optional(),
	moduleRegex: z.string().min(1).optional(),
	limit: z.number().int().positive().optional(),
});

const SymbolSourceArgs = z.object({
	symbolId: z.string().min(1).optional(),
	factId: z.string().min(1).optional(),
});

const Commit = z.object({ force: z.boolean().optional() });

const Move = z.object({ symbolId: z.string().min(1), toModule: z.string().min(1) });

const Replace = z.object({
	symbolId: z.string().min(1).optional(),
	factId: z.string().min(1).optional(),
	newText: z.string(),
});

const Insert = z
	.object({
		after: z.string().min(1).optional(),
		module: z.string().min(1).optional(),
		text: z.string().min(1),
	})
	.refine(
		(args) => (args.after === undefined) !== (args.module === undefined),
		`Set exactly one of after or module.`,
	);

/** What a replacement did, or why it did nothing. Issues ride along either way. */
export interface ReplaceOutcome {
	replaced: boolean;
	module?: string;
	issues: RefactorIssue[];
	reason?: string;
}

export interface MoveOutcome {
	moved: boolean;
	/** Canonical target spelling, on success. */
	toModule?: string;
	modules?: string[];
	migrated?: { answers: number; gaps: number };
	issues: RefactorIssue[];
	reason?: string;
}

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
): Promise<MoveOutcome> {
	let touched: string[] = [];
	let target = args.toModule;
	let migrated: { answers: number; gaps: number } | undefined;
	const idMap = new Map<string, string>();

	return journaledStep<MoveOutcome>(
		{ service, transactions, write },
		{
			kind: "move",
			refuse: (reason, issues) => ({ moved: false, issues, reason }),
			succeed: (issues) => ({
				moved: true,
				toModule: target,
				modules: touched,
				...(migrated === undefined ? {} : { migrated }),
				issues,
			}),
			plan: async () => {
				const plan = service.planMove(args.symbolId, args.toModule);
				if (!plan.ok) return { refused: plan.reason };
				target = plan.toModule;
				const edits = await service.moveEdits(plan);
				if (!edits.ok) return { refused: edits.reason, issues: edits.issues };
				touched = edits.files.map((file) => file.module);

				return {
					planned: {
						modules: touched,
						planRecord: { from: plan.fromModule, to: plan.toModule },
						stale: () => {
							if (service.currentHashOf(plan.fromModule) !== plan.baseHash) {
								return `${plan.fromModule} changed while the move was planned`;
							}
							// Import sites were chosen from stored ranges; the same rule applies.
							const stale = service.staleModules(plan.referencing);
							if (stale.length > 0) {
								return `${stale.join(", ")} changed since being indexed, so the move would rewrite stale positions`;
							}
							return null;
						},
						begin: () => {
							for (const id of plan.closure) {
								const rebased = service.rebaseIntoModule(id, plan.symbolId, plan.toModule);
								if (rebased !== null) idMap.set(id, rebased);
							}
						},
						apply: () => {
							for (const file of edits.files) service.writeModule(file.module, file.text);
						},
						// Target first, so every other module rebinds against a declaration that
						// already exists in its new home rather than one that has just vanished.
						reindex: [plan.toModule, ...touched.filter((m) => m !== plan.toModule)],
						issues: edits.issues,
						finish: (issues) => {
							migrated = service.migrateKnowledge(idMap);
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

/** What a rename did, with what it carried across and what it could not promise. */
export interface RenameStepOutcome {
	renamed: boolean;
	modules?: string[];
	migrated?: { answers: number; gaps: number };
	issues: RefactorIssue[];
	reason?: string;
}

/**
 * A rename as one transaction step, journaled like any other.
 *
 * The plan is computed outside the gate and the ids it will re-mint are worked out before anything
 * moves, because afterwards the old ids no longer resolve and there is nothing left to map from.
 */
function refactorRename(
	service: LexiconService,
	transactions: TransactionManager,
	write: <T>(work: () => Promise<T> | T) => Promise<T>,
	args: { symbolId: string; newName: string },
): Promise<RenameStepOutcome> {
	let modules: string[] = [];
	let migrated: { answers: number; gaps: number } | undefined;

	return journaledStep<RenameStepOutcome>(
		{ service, transactions, write },
		{
			kind: "rename",
			refuse: (reason, issues) => ({ renamed: false, issues, reason }),
			succeed: (issues) => ({
				renamed: true,
				modules,
				...(migrated === undefined ? {} : { migrated }),
				issues,
			}),
			plan: async () => {
				const plan = await service.prepareRename(args.symbolId, args.newName);
				if (plan.blockers.length > 0) {
					return {
						refused: plan.blockers[0]?.detail ?? "the rename is blocked",
						issues: plan.blockers.map((blocker) => ({ kind: blocker.kind, detail: blocker.detail })),
					};
				}

				const idMap = service.renameIdMap(args.symbolId, args.newName);
				const edited = plan.files.map((file) => file.module);
				// Worked out before the write, since afterwards these ids resolve to nothing and the
				// modules holding stale bindings would be unfindable.
				const alsoBound = service.modulesBoundTo(idMap.keys()).filter((module) => !edited.includes(module));

				return {
					planned: {
						modules: [...edited, ...alsoBound],
						planRecord: plan,
						stale: () => {
							// Every site was chosen from stored ranges; a changed module has moved
							// them, so rewriting would hit some occurrences and miss others.
							const stale = service.staleModules(edited);
							if (stale.length > 0) {
								return `${stale.join(", ")} changed since being indexed, so the rename would rewrite stale positions`;
							}
							return null;
						},
						// renameSymbol writes AND reindexes the edited files itself; only the
						// stale-binding modules remain for the executor.
						apply: async () => {
							const outcome = await service.renameSymbol(args.symbolId, args.newName);
							if (!outcome.renamed) {
								throw new StepRefusal(outcome.reason ?? "the rename could not be applied");
							}
							modules = [...outcome.modules, ...alsoBound];
						},
						reindex: alsoBound,
						issues: plan.warnings.map((warning) => ({ kind: warning.kind, detail: warning.detail })),
						finish: () => {
							migrated = service.migrateKnowledge(idMap);
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
 * hash is rechecked once held: anything that changed it in between invalidates the plan that was
 * just made, and applying anyway would overwrite whatever changed it.
 */
function refactorReplace(
	service: LexiconService,
	transactions: TransactionManager,
	write: <T>(work: () => Promise<T> | T) => Promise<T>,
	args: { symbolId?: string | undefined; factId?: string | undefined; newText: string },
): Promise<ReplaceOutcome> {
	let module = "";

	return journaledStep<ReplaceOutcome>(
		{ service, transactions, write },
		{
			kind: "replace",
			refuse: (reason, issues) => ({ replaced: false, issues, reason }),
			succeed: (issues) => ({ replaced: true, module, issues }),
			plan: async () => {
				const plan = await service.planReplacement(args, args.newText);
				if (!plan.ok) return { refused: plan.reason };
				module = plan.module;

				return {
					planned: {
						modules: [plan.module],
						planRecord: { range: plan.range },
						plannedText: [{ module: plan.module, text: plan.text }],
						// The plan was spliced from one exact version of the file; anything that
						// changed it since invalidates the splice.
						stale: () =>
							service.currentHashOf(plan.module) !== plan.baseHash
								? `${plan.module} changed while the replacement was planned`
								: null,
						apply: () => service.writeModule(plan.module, plan.text),
						reindex: [plan.module],
						issues: plan.issues,
					},
				};
			},
		},
	);
}

export interface InsertOutcome {
	inserted: boolean;
	alreadyInserted?: boolean;
	module?: string;
	/** From the post-reindex store, never candidate facts: provider id assignment can differ. */
	symbolIds?: string[];
	issues: RefactorIssue[];
	reason?: string;
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
						planRecord: { created: plan.created },
						plannedText: [{ module: plan.module, text: plan.candidate }],
						// A created module must STILL be absent: another writer landing one between
						// planning and the gate would be clobbered by a candidate built from empty.
						stale: () => {
							const fresh = plan.created
								? service.currentHashOf(plan.module) === null
								: service.currentHashOf(plan.module) === plan.baseHash;
							return fresh ? null : `${plan.module} changed while the insert was planned`;
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

////////////////////////////////
//  Functions & Helpers

/**
 * Dispatch one call.
 *
 * An unknown method throws rather than answering null, so a client built against a newer daemon
 * learns the method is missing instead of reading an empty answer as a real one.
 */
export function createDispatch(service: LexiconService, refactor?: RefactorDeps) {
	/** Mutations take the gate; a caller with no gate is a test driving the service directly. */
	const write = <T>(work: () => Promise<T> | T): Promise<T> =>
		refactor ? refactor.gate.exclusive(async () => work()) : Promise.resolve(work());
	const read = <T>(work: () => Promise<T> | T): Promise<T> =>
		refactor ? refactor.gate.shared(async () => work()) : Promise.resolve(work());

	function transactions(): TransactionManager {
		if (!refactor) throw new Error("this daemon was built without refactor support");
		return refactor.transactions;
	}

	/**
	 * Tier 1: a symbol answer full-parses its tree ahead of the background upgrade, then answers.
	 *
	 * The one spelling of the shortcut. A case that wires the tree by hand instead of through here
	 * is the drift the tier test fails on.
	 */
	const treeFirst = async <T>(symbolId: string, answer: () => Promise<T> | T): Promise<T> => {
		await service.ensureTreeFor(symbolId);
		return answer();
	};

	return async (method: string, params: unknown): Promise<unknown> => {
		switch (method) {
			case "findByName": {
				const args = FindByName.parse(params);
				return service.findByName(args.name, args.module);
			}
			case "describe": {
				const args = BySymbol.parse(params);
				return treeFirst(args.symbolId, () => service.describe(args.symbolId));
			}
			// The four below exist for the editor, which asks by position rather than by name and so
			// needs the declarations of a file and the raw hierarchy rows the MCP tools render instead.
			case "declarationOf":
				return service.declarationOf(BySymbol.parse(params).symbolId);
			case "declarationsIn":
				return service.declarationsIn(ByModule.parse(params).module);
			case "typeHierarchy": {
				const args = BySymbol.parse(params);
				return treeFirst(args.symbolId, () => service.typeHierarchy(args.symbolId));
			}
			case "callHierarchy": {
				const args = BySymbol.parse(params);
				return treeFirst(args.symbolId, () => service.callHierarchy(args.symbolId));
			}
			case "findReferences": {
				const args = References.parse(params);
				return treeFirst(args.symbolId, () => service.findReferences(args.symbolId, args.limit));
			}
			case "resolveImport": {
				const args = Resolve.parse(params);
				return service.resolveImport(args.fromModule, args.specifier);
			}
			case "indexStatus": {
				const args = Status.parse(params);
				return service.indexStatus(args.concerning);
			}
			case "findLiterals": {
				const args = Literals.parse(params);
				const { limit, ...query } = args;
				return service.findLiterals(query, limit);
			}
			case "findComments": {
				const args = Comments.parse(params);
				const { limit, ...query } = args;
				return service.findComments(query, limit);
			}
			case "findDocs": {
				const args = Docs.parse(params);
				const { limit, ...query } = args;
				return service.findDocs(query, limit);
			}
			case "sharedLiterals": {
				const args = Shared.parse(params);
				return service.sharedLiterals(args.minimumFiles, args.limit);
			}
			case "cycles":
				return service.cycles(Paged.parse(params).limit);
			case "mostReferenced":
			case "hubs":
				return service.mostReferenced(Paged.parse(params).limit);
			case "cacheStats":
				return service.cacheStats();
			case "searchSymbols": {
				const args = Search.parse(params);
				return service.searchSymbols(args.text, args);
			}
			case "outlineModule":
				return service.outline(ByModule.parse(params).module);
			case "fileNotes":
				return service.fileNotes(ByModule.parse(params).module);
			case "findImports":
				return service.findImports(FindImports.parse(params));
			case "overview":
				return service.overview();
			case "coChangedWith": {
				const args = CoChange.parse(params);
				return service.coChangedWith(args.module, args.limit);
			}
			case "fileHistory":
				return service.fileHistory(ByModule.parse(params).module);
			case "commitsMentioning": {
				const args = Mentions.parse(params);
				return service.commitsMentioning(args.name, args.limit);
			}
			case "factsFor": {
				// Tier 1 too: its answer carries the declaring module's references and literals,
				// which outline facts genuinely lack.
				const args = References.parse(params);
				return treeFirst(args.symbolId, () => service.factsFor(args.symbolId, args.limit));
			}
			case "resolveFacts":
				return service.resolveFacts(ResolveFacts.parse(params).factIds);
			case "recordAnswer": {
				const args = RecordAnswer.parse(params);
				return service.recordAnswer(args.symbolId, args.question, args.prose, args.citations, {
					...(args.model === undefined ? {} : { model: args.model }),
					...(args.resolvesDoubt === undefined ? {} : { resolvesDoubt: args.resolvesDoubt }),
					...(args.omitting === undefined ? {} : { omitting: args.omitting }),
				});
			}
			case "invalidateAnswer": {
				const args = InvalidateAnswer.parse(params);
				return service.invalidateAnswer(args.symbolId, args.reason, args.question, args.by);
			}
			case "reaffirmAnswer": {
				const args = ReaffirmAnswer.parse(params);
				return service.reaffirmAnswer(args.symbolId, args.question, {
					...(args.citations === undefined ? {} : { citations: args.citations }),
					...(args.model === undefined ? {} : { model: args.model }),
					...(args.resolvesDoubt === undefined ? {} : { resolvesDoubt: args.resolvesDoubt }),
				});
			}
			case "recallAnswer": {
				const args = RecallAnswer.parse(params);
				return args.question === undefined
					? service.recallAnswers(args.symbolId)
					: service.recallAnswer(args.symbolId, args.question);
			}
			case "knowledgeGaps": {
				const args = Gaps.parse(params);
				return service.knowledgeGaps(args.root, args.question, args.limit, args.module);
			}
			case "typeOf": {
				const args = BySymbol.parse(params);
				return treeFirst(args.symbolId, () => service.typeOf(args.symbolId));
			}
			// Rename planning requires complete reference facts.
			// Read-only, and kept because the editor asks it to decide whether to offer a rename.
			case "prepareRename": {
				const args = Rename.parse(params);
				await service.upgradeRemaining();
				return read(() => service.prepareRename(args.symbolId, args.newName));
			}
			// The edits a rename would make, for a caller that applies them itself. Nothing is written
			// here, so it takes the shared lock like any other read.
			case "renameEdits": {
				const args = Rename.parse(params);
				await service.upgradeRemaining();
				return read(() => service.renameEdits(args.symbolId, args.newName));
			}
			// Read-only, like prepareRename.
			case "planMove": {
				const args = Move.parse(params);
				await service.upgradeRemaining();
				return read(() => service.planMove(args.symbolId, args.toModule));
			}
			case "indexFile": {
				const args = IndexFile.parse(params);
				return write(() => service.indexFile(args.module));
			}
			case "symbolSource":
				return read(() => service.symbolSource(SymbolSourceArgs.parse(params)));
			case "refactorStart":
				return write(() => transactions().start());
			case "refactorStatus":
				return read(() => transactions().status());
			case "refactorTrack":
				return write(() => transactions().track(ByModule.parse(params).module));
			// Restoring puts back text the index does not describe, so the facts for those files are
			// of a version that no longer exists on disk.
			case "refactorUndo":
				return write(async () => {
					const outcome = transactions().undo();
					for (const module of outcome.modules ?? []) await service.indexFile(module);
					return outcome;
				});
			case "refactorRevert":
				return write(async () => {
					const outcome = transactions().revert();
					for (const module of outcome.modules) await service.indexFile(module);
					return outcome;
				});
			case "refactorCommit":
				return write(() => transactions().commit(Commit.parse(params)));
			case "refactorReplace": {
				const args = Replace.parse(params);
				return refactorReplace(service, transactions(), write, args);
			}
			case "refactorInsert": {
				const args = Insert.parse(params);
				return refactorInsert(service, transactions(), write, args);
			}
			case "refactorRename": {
				const args = Rename.parse(params);
				return refactorRename(service, transactions(), write, args);
			}
			case "refactorMove": {
				const args = Move.parse(params);
				return refactorMove(service, transactions(), write, args);
			}
			default:
				// Names the build, since the likeliest cause is a client and daemon on different ones.
				throw new Error(`unknown method: ${method} (this daemon runs ${BUILD_VERSION})`);
		}
	};
}
