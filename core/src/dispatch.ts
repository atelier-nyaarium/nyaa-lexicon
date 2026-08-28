// The daemon's method table.
//
// One place mapping a wire method to a service call, so the daemon stays transport-only and the
// service stays unaware that anything is remote.

import {
	DAEMON_METHODS,
	type DaemonMethod,
	type InsertOutcome,
	isDaemonMethod,
	type MoveOutcome,
	type RenameStepOutcome,
	type ReplaceOutcome,
	type RequestOf,
	type ResponseOf,
} from "@nyaa-lexicon/protocol";
import { journaledStep, StepRefusal } from "./refactorStep.js";
import type { LexiconService } from "./service.js";
import type { TransactionManager } from "./transactions.js";
import { BUILD_VERSION } from "./version.js";
import type { WorkspaceGate } from "./workspaceGate.js";

export type { InsertOutcome, MoveOutcome, RenameStepOutcome, ReplaceOutcome } from "@nyaa-lexicon/protocol";

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
 * One handler per wire method, each taking params the table has already parsed.
 *
 * Building the map calls nothing on the service, so its key set can be checked against the table
 * over a stub.
 */
export function daemonHandlers(service: LexiconService, refactor?: RefactorDeps) {
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
	 * The one spelling of the shortcut. A handler that wires the tree by hand instead of through
	 * here is the drift the tier test fails on.
	 */
	const treeFirst = async <T>(symbolId: string, answer: () => Promise<T> | T): Promise<T> => {
		await service.ensureTreeFor(symbolId);
		return answer();
	};

	return {
		findByName: (params) => service.findByName(params.name, params.module),
		describe: (params) => treeFirst(params.symbolId, () => service.describe(params.symbolId)),
		// The four below exist for the editor, which asks by position rather than by name and so
		// needs the declarations of a file and the raw hierarchy rows the MCP tools render instead.
		declarationOf: (params) => service.declarationOf(params.symbolId),
		declarationsIn: (params) => service.declarationsIn(params.module),
		typeHierarchy: (params) => treeFirst(params.symbolId, () => service.typeHierarchy(params.symbolId)),
		callHierarchy: (params) => treeFirst(params.symbolId, () => service.callHierarchy(params.symbolId)),
		findReferences: (params) =>
			treeFirst(params.symbolId, () => service.findReferences(params.symbolId, params.limit, params.within)),
		resolveImport: (params) => service.resolveImport(params.fromModule, params.specifier),
		indexStatus: (params) => service.indexStatus(params.concerning),
		findLiterals: ({ limit, ...query }) => service.findLiterals(query, limit),
		findComments: ({ limit, ...query }) => service.findComments(query, limit),
		findDocs: ({ limit, ...query }) => service.findDocs(query, limit),
		sharedLiterals: (params) => service.sharedLiterals(params.minimumFiles, params.limit),
		cycles: (params) => service.cycles(params.limit),
		mostReferenced: (params) => service.mostReferenced(params.limit),
		hubs: (params) => service.mostReferenced(params.limit),
		cacheStats: () => service.cacheStats(),
		searchSymbols: (params) => service.searchSymbols(params.text, params),
		outlineModule: (params) => service.outline(params.module),
		fileNotes: (params) => service.fileNotes(params.module),
		moduleStatus: (params) => service.moduleStatus(params.module),
		findImports: (params) => service.findImports(params),
		overview: () => service.overview(),
		coChangedWith: (params) => service.coChangedWith(params.module, params.limit),
		fileHistory: (params) => service.fileHistory(params.module),
		commitsMentioning: (params) => service.commitsMentioning(params.name, params.limit),
		// Tier 1 too: its answer carries the declaring module's references and literals, which
		// outline facts genuinely lack.
		factsFor: (params) => treeFirst(params.symbolId, () => service.factsFor(params.symbolId, params.limit)),
		resolveFacts: (params) => service.resolveFacts(params.factIds),
		recordAnswer: (params) =>
			service.recordAnswer(params.symbolId, params.question, params.prose, params.citations, {
				...(params.model === undefined ? {} : { model: params.model }),
				...(params.resolvesDoubt === undefined ? {} : { resolvesDoubt: params.resolvesDoubt }),
				...(params.omitting === undefined ? {} : { omitting: params.omitting }),
			}),
		invalidateAnswer: (params) =>
			service.invalidateAnswer(params.symbolId, params.reason, params.question, params.by),
		reaffirmAnswer: (params) =>
			service.reaffirmAnswer(params.symbolId, params.question, {
				...(params.citations === undefined ? {} : { citations: params.citations }),
				...(params.model === undefined ? {} : { model: params.model }),
				...(params.resolvesDoubt === undefined ? {} : { resolvesDoubt: params.resolvesDoubt }),
			}),
		recallAnswer: (params) =>
			params.question === undefined
				? service.recallAnswers(params.symbolId)
				: service.recallAnswer(params.symbolId, params.question),
		knowledgeGaps: (params) => service.knowledgeGaps(params.root, params.question, params.limit, params.module),
		typeOf: (params) => treeFirst(params.symbolId, () => service.typeOf(params.symbolId)),
		// Rename planning requires complete reference facts.
		// Read-only, and kept because the editor asks it to decide whether to offer a rename.
		prepareRename: async (params) => {
			await service.upgradeRemaining();
			return read(() => service.prepareRename(params.symbolId, params.newName));
		},
		// The edits a rename would make, for a caller that applies them itself. Nothing is written
		// here, so it takes the shared lock like any other read.
		renameEdits: async (params) => {
			await service.upgradeRemaining();
			return read(() => service.renameEdits(params.symbolId, params.newName));
		},
		// Read-only, like prepareRename.
		planMove: async (params) => {
			await service.upgradeRemaining();
			return read(() => service.planMove(params.symbolId, params.toModule));
		},
		indexFile: (params) => write(() => service.indexFile(params.module)),
		symbolSource: (params) => read(() => service.symbolSource(params)),
		refactorStart: () => write(() => transactions().start()),
		refactorStatus: () => read(() => transactions().status()),
		refactorTrack: (params) => write(() => transactions().track(params.module)),
		// Restoring puts back text the index does not describe, so the facts for those files are
		// of a version that no longer exists on disk.
		refactorUndo: () =>
			write(async () => {
				const outcome = transactions().undo();
				for (const module of outcome.modules ?? []) await service.indexFile(module);
				return outcome;
			}),
		refactorRevert: () =>
			write(async () => {
				const outcome = transactions().revert();
				for (const module of outcome.modules) await service.indexFile(module);
				return outcome;
			}),
		refactorCommit: (params) => write(() => transactions().commit(params)),
		refactorReplace: (params) => refactorReplace(service, transactions(), write, params),
		refactorInsert: (params) => refactorInsert(service, transactions(), write, params),
		refactorRename: (params) => refactorRename(service, transactions(), write, params),
		refactorMove: (params) => refactorMove(service, transactions(), write, params),
	} satisfies {
		[M in DaemonMethod]: (params: RequestOf<M>) => Promise<ResponseOf<M>> | ResponseOf<M>;
	};
}

/**
 * Dispatch one call: parse the request through the table, run its handler, parse the answer.
 *
 * An unknown method throws rather than answering null, so a client built against a newer daemon
 * learns the method is missing instead of reading an empty answer as a real one.
 */
export function createDispatch(service: LexiconService, refactor?: RefactorDeps) {
	const handlers = daemonHandlers(service, refactor);
	return async (method: string, params: unknown): Promise<unknown> => {
		if (!isDaemonMethod(method)) {
			// Names the build, since the likeliest cause is a client and daemon on different ones.
			throw new Error(`unknown method: ${method} (this daemon runs ${BUILD_VERSION})`);
		}
		const args = DAEMON_METHODS[method].request.parse(params ?? {});
		// Looked up by a runtime key, the handler's parameter is the intersection of every request.
		const answer = await handlers[method](args as never);
		return DAEMON_METHODS[method].response.parse(answer);
	};
}
