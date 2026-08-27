// What the editor adapter needs from an index, and where it can come from.
//
// Every method is a Promise, so a caller cannot tell which side of a socket answered.

import type {
	CallHierarchy,
	DaemonChannel,
	DescribeResult,
	LexiconService,
	RecalledAnswer,
	ReferencesResult,
	RenameEditPlan,
	RenamePlan,
	StoredDeclaration,
	TypeHierarchy,
	TypeInfo,
} from "@nyaa-lexicon/core";

////////////////////////////////
//  Interfaces & Types

/**
 * The read surface an editor needs. No writes at all, since LSP has the EDITOR apply a rename.
 *
 * `transactionOpen` is the exception: edits handed over mid-transaction land outside the journal
 * and its undo would silently revert them.
 */
export interface LexiconReads {
	declarationsIn(module: string): Promise<StoredDeclaration[]>;
	declarationOf(symbolId: string): Promise<StoredDeclaration | null>;
	describe(symbolId: string): Promise<DescribeResult | null>;
	findReferences(symbolId: string, limit?: number): Promise<ReferencesResult>;
	typeOf(symbolId: string): Promise<TypeInfo>;
	typeHierarchy(symbolId: string): Promise<TypeHierarchy>;
	callHierarchy(symbolId: string): Promise<CallHierarchy>;
	recallAnswers(symbolId: string): Promise<RecalledAnswer[]>;
	prepareRename(symbolId: string, newName: string): Promise<RenamePlan>;
	renameEdits(symbolId: string, newName: string): Promise<RenameEditPlan>;
	transactionOpen(): Promise<boolean>;
}

////////////////////////////////
//  Functions & Helpers

/**
 * Reads answered by the workspace daemon.
 *
 * The open connection is what tells the daemon this editor exists.
 */
export function daemonReads(channel: DaemonChannel): LexiconReads {
	return {
		declarationsIn: (module) => channel.ask("declarationsIn", { module }),
		declarationOf: (symbolId) => channel.ask("declarationOf", { symbolId }),
		describe: (symbolId) => channel.ask("describe", { symbolId }),
		findReferences: (symbolId, limit) => channel.ask("findReferences", { symbolId, limit }),
		typeOf: (symbolId) => channel.ask("typeOf", { symbolId }),
		typeHierarchy: (symbolId) => channel.ask("typeHierarchy", { symbolId }),
		callHierarchy: (symbolId) => channel.ask("callHierarchy", { symbolId }),
		// One method, both arities. No question means all.
		recallAnswers: async (symbolId) => {
			const answer = await channel.ask("recallAnswer", { symbolId });
			return Array.isArray(answer) ? answer : answer === null ? [] : [answer];
		},
		prepareRename: (symbolId, newName) => channel.ask("prepareRename", { symbolId, newName }),
		renameEdits: (symbolId, newName) => channel.ask("renameEdits", { symbolId, newName }),
		transactionOpen: async () => (await channel.ask("refactorStatus", {})).open,
	};
}

/**
 * Resolved once, on the first question.
 *
 * Deferred because `initialize` must be answered before a daemon could be spawned.
 */
export function deferredReads(resolve: () => Promise<LexiconReads>): LexiconReads {
	let ready: Promise<LexiconReads> | null = null;
	const reads = (): Promise<LexiconReads> => (ready ??= resolve());

	return {
		declarationsIn: async (module) => (await reads()).declarationsIn(module),
		declarationOf: async (symbolId) => (await reads()).declarationOf(symbolId),
		describe: async (symbolId) => (await reads()).describe(symbolId),
		findReferences: async (symbolId, limit) => (await reads()).findReferences(symbolId, limit),
		typeOf: async (symbolId) => (await reads()).typeOf(symbolId),
		typeHierarchy: async (symbolId) => (await reads()).typeHierarchy(symbolId),
		callHierarchy: async (symbolId) => (await reads()).callHierarchy(symbolId),
		recallAnswers: async (symbolId) => (await reads()).recallAnswers(symbolId),
		prepareRename: async (symbolId, newName) => (await reads()).prepareRename(symbolId, newName),
		renameEdits: async (symbolId, newName) => (await reads()).renameEdits(symbolId, newName),
		transactionOpen: async () => (await reads()).transactionOpen(),
	};
}

/** An index in this process, when no daemon can be started. The fallback, not the design. */
export function localReads(service: LexiconService): LexiconReads {
	return {
		declarationsIn: async (module) => service.declarationsIn(module),
		declarationOf: async (symbolId) => service.declarationOf(symbolId),
		describe: async (symbolId) => service.describe(symbolId),
		findReferences: async (symbolId, limit) => service.findReferences(symbolId, limit),
		typeOf: (symbolId) => service.typeOf(symbolId),
		typeHierarchy: async (symbolId) => service.typeHierarchy(symbolId),
		callHierarchy: async (symbolId) => service.callHierarchy(symbolId),
		recallAnswers: async (symbolId) => service.recallAnswers(symbolId),
		prepareRename: (symbolId, newName) => service.prepareRename(symbolId, newName),
		renameEdits: (symbolId, newName) => service.renameEdits(symbolId, newName),
		// No daemon, no journal to conflict with.
		transactionOpen: async () => false,
	};
}
