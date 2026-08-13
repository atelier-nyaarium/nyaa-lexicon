// The daemon's method table.
//
// One place mapping a wire method to a service call, so the daemon stays transport-only and the
// service stays unaware that anything is remote.

import { z } from "zod";
import { QUESTION_CLASSES, type QuestionClass } from "./answers.js";
import type { LexiconService } from "./service.js";
import type { RefactorIssue, TransactionManager } from "./transactions.js";
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
const IndexFile = z.object({ module: z.string().min(1), contentHash: z.string().min(1) });
const Rename = z.object({ symbolId: z.string().min(1), newName: z.string().min(1) });
const Literals = z.object({
	value: z.string().optional(),
	regex: z.string().min(1).optional(),
	kind: z.string().optional(),
	min: z.number().optional(),
	max: z.number().optional(),
	limit: z.number().int().positive().optional(),
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

const Replace = z.object({
	symbolId: z.string().min(1).optional(),
	factId: z.string().min(1).optional(),
	newText: z.string(),
});

/** What a replacement did, or why it did nothing. Issues ride along either way. */
export interface ReplaceOutcome {
	replaced: boolean;
	module?: string;
	issues: RefactorIssue[];
	reason?: string;
}

/**
 * Plan first, outside the gate, then write inside it.
 *
 * Planning parses a candidate and asks the index what would break, which is the slow half and
 * needs no exclusivity. The gate is held only across journal, write and reindex, and the file's
 * hash is rechecked once held: anything that changed it in between invalidates the plan that was
 * just made, and applying anyway would overwrite whatever changed it.
 */
async function refactorReplace(
	service: LexiconService,
	transactions: TransactionManager,
	write: <T>(work: () => Promise<T> | T) => Promise<T>,
	args: { symbolId?: string | undefined; factId?: string | undefined; newText: string },
): Promise<ReplaceOutcome> {
	if (!transactions.openTransaction()) {
		return { replaced: false, issues: [], reason: "no refactor transaction is open; call refactor_start" };
	}

	const plan = await service.planReplacement(args, args.newText);
	if (!plan.ok) return { replaced: false, issues: [], reason: plan.reason };

	return write(async () => {
		const current = service.symbolSource(args);
		if (!current.found) {
			return { replaced: false, issues: [], reason: `${plan.module} changed while the replacement was planned` };
		}

		const begun = transactions.beginStep("replace", [plan.module], { range: plan.range });
		if (!begun.ok) return { replaced: false, issues: [], reason: begun.reason };

		try {
			service.writeModule(plan.module, plan.text);
		} catch (error) {
			// Journaled but not written, so the step is removed rather than left for recovery to
			// puzzle over on a daemon that is still running.
			transactions.undo();
			return {
				replaced: false,
				issues: [],
				reason: `${plan.module} could not be written: ${error instanceof Error ? error.message : String(error)}`,
			};
		}

		transactions.completeStep(begun.stepNo, "written");
		await service.indexFile(plan.module, "");
		transactions.completeStep(begun.stepNo, "reindexed");
		transactions.recordIssues(begun.stepNo, plan.issues);
		transactions.completeStep(begun.stepNo, "finalized");

		return { replaced: true, module: plan.module, issues: plan.issues };
	});
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

	return async (method: string, params: unknown): Promise<unknown> => {
		switch (method) {
			case "findByName": {
				const args = FindByName.parse(params);
				return service.findByName(args.name, args.module);
			}
			case "describe":
				return service.describe(BySymbol.parse(params).symbolId);
			case "findReferences": {
				const args = References.parse(params);
				return service.findReferences(args.symbolId, args.limit);
			}
			case "resolveImport": {
				const args = Resolve.parse(params);
				return service.resolveImport(args.fromModule, args.specifier);
			}
			case "indexStatus":
				return service.indexStatus();
			case "findLiterals": {
				const args = Literals.parse(params);
				const { limit, ...query } = args;
				return service.findLiterals(query, limit);
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
				const args = References.parse(params);
				return service.factsFor(args.symbolId, args.limit);
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
				return service.knowledgeGaps(args.root, args.question, args.limit);
			}
			case "typeOf":
				return service.typeOf(BySymbol.parse(params).symbolId);
			case "prepareRename": {
				const args = Rename.parse(params);
				return service.prepareRename(args.symbolId, args.newName);
			}
			case "renameSymbol": {
				const args = Rename.parse(params);
				// Writes several files and reindexes them, so it belongs behind the same gate as a
				// refactor step. Its own reindexing runs already held, never re-acquiring.
				return write(() => service.renameSymbol(args.symbolId, args.newName));
			}
			case "indexFile": {
				const args = IndexFile.parse(params);
				return write(() => service.indexFile(args.module, args.contentHash));
			}
			case "symbolSource":
				return read(() => service.symbolSource(SymbolSourceArgs.parse(params)));
			case "refactorStart":
				return write(() => transactions().start());
			case "refactorStatus":
				return read(() => transactions().status());
			case "refactorTrack":
				return write(() => transactions().track(ByModule.parse(params).module));
			case "refactorUndo":
				return write(() => transactions().undo());
			case "refactorRevert":
				return write(() => transactions().revert());
			case "refactorCommit":
				return write(() => transactions().commit(Commit.parse(params)));
			case "refactorReplace": {
				const args = Replace.parse(params);
				return refactorReplace(service, transactions(), write, args);
			}
			default:
				throw new Error(`unknown method: ${method}`);
		}
	};
}
