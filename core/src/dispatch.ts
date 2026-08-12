// The daemon's method table.
//
// One place mapping a wire method to a service call, so the daemon stays transport-only and the
// service stays unaware that anything is remote.

import { z } from "zod";
import { QUESTION_CLASSES, type QuestionClass } from "./answers.js";
import type { LexiconService } from "./service.js";

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

////////////////////////////////
//  Functions & Helpers

/**
 * Dispatch one call.
 *
 * An unknown method throws rather than answering null, so a client built against a newer daemon
 * learns the method is missing instead of reading an empty answer as a real one.
 */
export function createDispatch(service: LexiconService) {
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
			case "graphOf":
				return service.graphOf(BySymbol.parse(params).symbolId);
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
			case "typeHierarchy":
				return service.typeHierarchy(BySymbol.parse(params).symbolId);
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
				return service.renameSymbol(args.symbolId, args.newName);
			}
			case "indexFile": {
				const args = IndexFile.parse(params);
				return service.indexFile(args.module, args.contentHash);
			}
			default:
				throw new Error(`unknown method: ${method}`);
		}
	};
}
